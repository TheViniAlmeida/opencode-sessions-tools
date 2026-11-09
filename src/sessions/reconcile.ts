import type { Database } from "bun:sqlite";
import type { TrustedPrincipalPort } from "../authorization/authorize";
import {
  type AuthorizationPort,
  canonical,
  DomainError,
  parseSessionRef,
  type SessionRef,
} from "../contracts";
import type { Migration, Persistence } from "../persistence/database";
import type { RemovedTargetPort } from "../persistence/operations";
import type { MissingSessionPort } from "./discovery";

export const reconciliationMigration = {
  name: "session-removal-v1",
  sql: `CREATE TABLE session_tombstones (
    instance_id TEXT NOT NULL, session_id TEXT NOT NULL, project_id TEXT NOT NULL,
    removed_at INTEGER NOT NULL, PRIMARY KEY(instance_id,session_id)
  );
  CREATE TABLE session_removal_audit (
    instance_id TEXT NOT NULL, session_id TEXT NOT NULL, project_id TEXT NOT NULL,
    removed_at INTEGER NOT NULL, PRIMARY KEY(instance_id,session_id)
  );`,
} as const;

export function reconciliationMigrationAt(version: number): Migration {
  if (!Number.isSafeInteger(version) || version < 2)
    throw new DomainError("invalid_input");
  return { version, apply: (db) => db.exec(reconciliationMigration.sql) };
}

/** Trusted adapter: only native GET 404 maps to null. 403/offline must throw.
 * No delete endpoint, descendant enumeration or host mutation is available. */
export interface ReconciliationHostPort {
  get(ref: SessionRef): Promise<object | null>;
}
/** Required trusted composition boundary. Synchronously clean/redact only plugin
 * content for exactly this reference (including future inbox/task/job tables).
 * Use the supplied DB transaction, never another connection or external I/O.
 * Preserve grants for other references and minimal audits. Throw if unavailable. */
export interface RemovedSessionCleanupPort {
  cleanup(db: Database, ref: SessionRef): void;
}

function removedIn(db: Database, ref: SessionRef): boolean {
  const row = db
    .query<{ project_id: string }, [string, string]>(
      "SELECT project_id FROM session_tombstones WHERE instance_id=? AND session_id=?",
    )
    .get(ref.instanceID, ref.sessionID);
  if (row && row.project_id !== ref.projectID)
    throw new DomainError("unavailable");
  return row !== null;
}

/** Internal persistence adapter, not a tool or unauthenticated discovery API. */
export const removedTargetPort: RemovedTargetPort = {
  assertAvailable(db, input) {
    const ref = parseSessionRef(input);
    try {
      if (!db.inTransaction) throw new DomainError("unavailable");
      if (removedIn(db, ref)) throw new DomainError("not_found");
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("unavailable");
    }
  },
};

export class ReconciliationService implements MissingSessionPort {
  constructor(
    private readonly persistence: Persistence,
    private readonly identity: TrustedPrincipalPort,
    private readonly authorization: Pick<AuthorizationPort, "authorize">,
    private readonly host: ReconciliationHostPort,
    private readonly cleanup: RemovedSessionCleanupPort,
    private readonly now: () => number = Date.now,
  ) {}

  async missing(input: SessionRef): Promise<void> {
    const ref = parseSessionRef(input);
    const actor = await this.identity.current();
    if (!actor) throw new DomainError("forbidden");
    await this.authorization.authorize(actor, ref, "discover");
    if (this.persistence.transaction((db) => removedIn(db, ref))) return;
    try {
      if ((await this.host.get(ref)) !== null) return;
    } catch (error) {
      if (error instanceof DomainError)
        throw new DomainError(error.code, error.retryable);
      throw new DomainError("unavailable", true);
    }
    const at = this.now();
    if (
      !Number.isSafeInteger(at) ||
      at < 0 ||
      !this.cleanup ||
      typeof this.cleanup.cleanup !== "function"
    )
      throw new DomainError("unavailable");
    this.persistence.transaction((db) => {
      if (removedIn(db, ref)) return;
      db.query("INSERT INTO session_tombstones VALUES (?,?,?,?)").run(
        ref.instanceID,
        ref.sessionID,
        ref.projectID,
        at,
      );
      // Restrict in SQL to T13's canonical identity; unrelated corrupt rows are inert.
      const rows = db
        .query<
          { operation_id: string; target_json: string; state: string },
          [string]
        >(
          "SELECT operation_id,target_json,state FROM operations WHERE target_json=?",
        )
        .all(canonical(ref));
      for (const row of rows) {
        if (row.state === "pending") {
          db.query(
            "UPDATE operations SET state='rejected' WHERE operation_id=? AND state='pending'",
          ).run(row.operation_id);
          db.query(
            "INSERT INTO operation_audit(operation_id,state,created_at) VALUES (?,'rejected',?)",
          ).run(row.operation_id, at);
        }
        // Dispatching/admitted/unknown effects cannot be retracted. Keep IDs,
        // hashes, receipts and valid state audit; remove plugin-held content only.
        db.query(
          "UPDATE operations SET payload_json='null' WHERE operation_id=?",
        ).run(row.operation_id);
      }
      const result: unknown = this.cleanup.cleanup(db, ref);
      if (result && typeof (result as { then?: unknown }).then === "function")
        throw new DomainError("unavailable");
      db.query("INSERT INTO session_removal_audit VALUES (?,?,?,?)").run(
        ref.instanceID,
        ref.sessionID,
        ref.projectID,
        at,
      );
    });
  }
}
