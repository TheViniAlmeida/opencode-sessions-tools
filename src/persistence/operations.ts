import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Authorizer } from "../authorization/authorize";
import type { PendingGrantOperationsPort } from "../authorization/grants";
import {
  type AdmissionEvidence,
  type Capability,
  canonical,
  type DeliveryState,
  DomainError,
  type Principal,
  parseCapability,
  parseSessionRef,
  type SessionRef,
  transitionDelivery,
} from "../contracts";
import type { Migration, Persistence } from "./database";

/** Compose with T10 and other descriptors; no global migration number is owned here. */
export const operationsMigration = {
  name: "operations-outbox-v1",
  sql: `CREATE TABLE operations (
    operation_id TEXT PRIMARY KEY, caller_scope TEXT NOT NULL, owner_json TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
    target_json TEXT NOT NULL, capability TEXT NOT NULL, payload_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','dispatching','admitted','rejected','expired','unknown_outcome')),
    receipt_id TEXT, channel TEXT,
    UNIQUE(caller_scope,idempotency_key)
  );
  CREATE TABLE operation_outbox (
    operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id),
    owner TEXT, generation INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE operation_audit (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL REFERENCES operations(operation_id),
    state TEXT NOT NULL, created_at INTEGER NOT NULL
  );`,
} as const;

export function operationMigrationAt(version: number): Migration {
  if (!Number.isSafeInteger(version) || version < 2)
    throw new DomainError("invalid_input");
  return { version, apply: (db) => db.exec(operationsMigration.sql) };
}

export function canonicalPayloadHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export interface Operation {
  readonly operationID: string;
  readonly state: DeliveryState;
  readonly payloadHash: string;
  readonly receiptID: string | null;
  readonly channel: "host" | "inbox" | "context_attachment" | null;
}
interface Row {
  operation_id: string;
  caller_scope: string;
  owner_json: string;
  payload_hash: string;
  target_json: string;
  capability: Capability;
  payload_json: string;
  state: DeliveryState;
  receipt_id: string | null;
  channel: "host" | "inbox" | "context_attachment" | null;
}
export interface OperationLease {
  readonly operationID: string;
  readonly owner: string;
  readonly generation: number;
  readonly expiresAt: number;
}
export interface OperationRequest {
  readonly principal: Principal;
  readonly target: SessionRef;
  readonly capability: Capability;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly payload: unknown;
}
export interface OperationDispatch {
  readonly operationID: string;
  readonly target: SessionRef;
  readonly payload: unknown;
  readonly payloadHash: string;
}
export interface ReconciliationEvidence {
  readonly operationID: string;
  readonly payloadHash: string;
  readonly evidence: AdmissionEvidence;
}
/** Trusted host adapter only; never construct evidence from a tool payload. */
export interface OperationReconciliationPort {
  inspect(operationID: string): Promise<ReconciliationEvidence>;
}
function scope(principal: Principal): string {
  return principal.kind === "session"
    ? canonical(["session", parseSessionRef(principal.session)])
    : canonical(["operator", principal.instanceID, principal.operatorID]);
}
function nonempty(value: string): void {
  if (typeof value !== "string" || !value.trim())
    throw new DomainError("invalid_input");
}
function view(row: Row): Operation {
  return {
    operationID: row.operation_id,
    state: row.state,
    payloadHash: row.payload_hash,
    receiptID: row.receipt_id,
    channel: row.channel,
  };
}

/** T12 invokes synchronously in the grant revocation transaction on this DB.
 * Dispatching is already a LOCAL admission; never retract possible host effects.
 */
export function pendingGrantOperations(
  now: () => number,
): PendingGrantOperationsPort {
  return {
    revoke(sql, grant) {
      if (!sql.inTransaction) throw new DomainError("unavailable");
      const at = now();
      if (!Number.isSafeInteger(at) || at < 0)
        throw new DomainError("unavailable");
      const rows = sql
        .query<Row, [string, string]>(
          "SELECT * FROM operations WHERE caller_scope=? AND target_json=? ORDER BY operation_id",
        )
        .all(
          scope({ kind: "session", session: grant.source }),
          canonical(parseSessionRef(grant.target)),
        );
      const rejected: string[] = [];
      const already_admitted: string[] = [];
      for (const row of rows) {
        if (!grant.capabilities.includes(row.capability)) continue;
        if (row.state === "pending") {
          transitionDelivery("pending", "rejected");
          const changed = sql
            .query(
              "UPDATE operations SET state='rejected' WHERE operation_id=? AND state='pending'",
            )
            .run(row.operation_id);
          if (changed.changes !== 1) throw new DomainError("conflict");
          sql
            .query(
              "INSERT INTO operation_audit(operation_id,state,created_at) VALUES (?,'rejected',?)",
            )
            .run(row.operation_id, at);
          rejected.push(row.operation_id);
        } else if (
          ["dispatching", "admitted", "unknown_outcome"].includes(row.state)
        ) {
          already_admitted.push(row.operation_id);
        }
      }
      return { rejected, already_admitted };
    },
  };
}

/** Trusted synchronous guard using the supplied transaction's DB. Production
 * MUST inject the real removedTargetPort from sessions/reconcile, NEVER a noop.
 * Noop implementations are isolated fixtures only, not production wiring.
 */
export interface RemovedTargetPort {
  assertAvailable(db: Database, ref: SessionRef): void;
}

/** Authorization's admission adapter MUST use this same Persistence/SQLite
 * transaction. The adapter is T12's trusted composition boundary, not client input.
 * No host call is made in a transaction; dispatch follows committed admission.
 */
export class Operations {
  constructor(
    private readonly persistence: Persistence,
    private readonly authorization: Pick<
      Authorizer,
      "authorize" | "authorizeReplay" | "authorizeIntent" | "admitOperation"
    >,
    private readonly now: () => number,
    private readonly removedTargets: RemovedTargetPort,
  ) {}

  private assertTargetAvailable(db: Database, ref: SessionRef): void {
    if (
      !this.removedTargets ||
      typeof this.removedTargets.assertAvailable !== "function"
    )
      throw new DomainError("unavailable");
    const result: unknown = this.removedTargets.assertAvailable(db, ref);
    if (result && typeof (result as { then?: unknown }).then === "function")
      throw new DomainError("unavailable");
  }

  private time(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new DomainError("unavailable");
    return now;
  }

  async enqueue(request: OperationRequest): Promise<Operation> {
    const target = parseSessionRef(request.target);
    parseCapability(request.capability);
    nonempty(request.idempotencyKey);
    const callerScope = scope(request.principal);
    const payloadJSON = canonical(request.payload);
    const hash = canonicalPayloadHash({
      target,
      capability: request.capability,
      payload: request.payload,
    });
    const lookup = () =>
      this.persistence.transaction((db) =>
        db
          .query<Row, [string, string]>(
            "SELECT * FROM operations WHERE caller_scope=? AND idempotency_key=?",
          )
          .get(callerScope, request.idempotencyKey),
      );
    const replay = async (existing: Row): Promise<Operation> => {
      await this.authorization.authorizeReplay(
        request.principal,
        JSON.parse(existing.owner_json) as Principal,
      );
      if (existing.payload_hash !== hash) throw new DomainError("conflict");
      return view(existing);
    };
    const existing = lookup();
    if (existing) return replay(existing);
    const id = crypto.randomUUID();
    try {
      return await this.authorization.authorizeIntent(
        request.principal,
        target,
        request.capability,
        request.expectedRevision,
        id,
        () =>
          this.persistence.transaction((db) => {
            const concurrent = db
              .query<Row, [string, string]>(
                "SELECT * FROM operations WHERE caller_scope=? AND idempotency_key=?",
              )
              .get(callerScope, request.idempotencyKey);
            // Roll back intent/once reservation before taking the replay path.
            if (concurrent) throw new DomainError("conflict");
            this.assertTargetAvailable(db, target);
            db.query(
              "INSERT INTO operations (operation_id,caller_scope,owner_json,idempotency_key,payload_hash,target_json,capability,payload_json,state) VALUES (?,?,?,?,?,?,?,?,'pending')",
            ).run(
              id,
              callerScope,
              canonical(request.principal),
              request.idempotencyKey,
              hash,
              canonical(target),
              request.capability,
              payloadJSON,
            );
            db.query(
              "INSERT INTO operation_outbox(operation_id) VALUES (?)",
            ).run(id);
            db.query(
              "INSERT INTO operation_audit(operation_id,state,created_at) VALUES (?,'pending',?)",
            ).run(id, this.time());
            return {
              operationID: id,
              state: "pending" as const,
              payloadHash: hash,
              receiptID: null,
              channel: null,
            };
          }),
      );
    } catch (error) {
      const concurrent = lookup();
      if (concurrent) return replay(concurrent);
      throw error;
    }
  }

  claim(operationID: string, owner: string, ttlMs: number): OperationLease {
    nonempty(owner);
    const now = this.time();
    if (
      !Number.isSafeInteger(ttlMs) ||
      ttlMs <= 0 ||
      !Number.isSafeInteger(now + ttlMs)
    )
      throw new DomainError("invalid_input");
    return this.persistence.transaction((db) => {
      const row = db.query<
        { generation: number },
        [string, number, string, number, string]
      >(
        `UPDATE operation_outbox SET owner=?,generation=generation+1,expires_at=?
         WHERE operation_id=? AND expires_at<=? AND EXISTS
         (SELECT 1 FROM operations WHERE operation_id=? AND state='pending') RETURNING generation`,
      );
      const result = row.get(owner, now + ttlMs, operationID, now, operationID);
      if (!result) throw new DomainError("conflict");
      return {
        operationID,
        owner,
        generation: result.generation,
        expiresAt: now + ttlMs,
      };
    });
  }

  async dispatch(
    principal: Principal,
    lease: OperationLease,
    expectedRevision: number,
    send: (intent: OperationDispatch) => Promise<AdmissionEvidence>,
  ): Promise<Operation> {
    const row = this.persistence.transaction((db) =>
      db
        .query<Row, [string]>("SELECT * FROM operations WHERE operation_id=?")
        .get(lease.operationID),
    );
    if (!row || row.caller_scope !== scope(principal))
      throw new DomainError("not_found");
    const target = parseSessionRef(JSON.parse(row.target_json));
    const intent = await this.authorization.admitOperation(
      principal,
      target,
      row.capability,
      expectedRevision,
      row.operation_id,
      () =>
        this.persistence.transaction((db) => {
          this.assertTargetAvailable(db, target);
          const changed = db
            .query(`UPDATE operations SET state='dispatching' WHERE operation_id=? AND state='pending'
          AND EXISTS (SELECT 1 FROM operation_outbox WHERE operation_id=? AND owner=? AND generation=? AND expires_at>?)`)
            .run(
              lease.operationID,
              lease.operationID,
              lease.owner,
              lease.generation,
              this.time(),
            );
          if (changed.changes !== 1) throw new DomainError("conflict");
          db.query(
            "INSERT INTO operation_audit(operation_id,state,created_at) VALUES (?,'dispatching',?)",
          ).run(lease.operationID, this.time());
          return {
            operationID: row.operation_id,
            target,
            payload: JSON.parse(row.payload_json) as unknown,
            payloadHash: row.payload_hash,
          };
        }),
    );
    return this.persistence.commitThen(
      () => intent,
      async (committed) => {
        let evidence: AdmissionEvidence;
        try {
          evidence = await send(committed);
        } catch {
          evidence = { state: "unknown_outcome" };
        }
        try {
          return this.finish(lease.operationID, "dispatching", evidence, lease);
        } catch (error) {
          if (error instanceof DomainError && error.code === "unavailable")
            throw new DomainError("unknown_outcome", false, lease.operationID);
          throw error;
        }
      },
    );
  }

  private finish(
    id: string,
    from: DeliveryState,
    evidence: AdmissionEvidence,
    lease?: OperationLease,
  ): Operation {
    if (
      !evidence ||
      !["admitted", "rejected", "unknown_outcome"].includes(evidence.state)
    )
      evidence = { state: "unknown_outcome" };
    if (
      evidence.state === "admitted" &&
      (typeof evidence.receiptID !== "string" ||
        !evidence.receiptID.trim() ||
        !["host", "inbox", "context_attachment"].includes(evidence.channel))
    )
      evidence = { state: "unknown_outcome" };
    transitionDelivery(from, evidence.state, {
      reconciled: from === "unknown_outcome",
    });
    return this.persistence.transaction((db) => {
      if (
        lease &&
        !db
          .query(
            "SELECT 1 FROM operation_outbox WHERE operation_id=? AND owner=? AND generation=? AND expires_at>?",
          )
          .get(id, lease.owner, lease.generation, this.time())
      )
        throw new DomainError("conflict");
      const result = db
        .query<Row, [string, string | null, string | null, string, string]>(
          "UPDATE operations SET state=?,receipt_id=?,channel=? WHERE operation_id=? AND state=? RETURNING *",
        )
        .get(
          evidence.state,
          evidence.state === "admitted" ? evidence.receiptID : null,
          evidence.state === "admitted" ? evidence.channel : null,
          id,
          from,
        );
      if (!result) throw new DomainError("conflict");
      db.query(
        "INSERT INTO operation_audit(operation_id,state,created_at) VALUES (?,?,?)",
      ).run(id, evidence.state, this.time());
      return view(result);
    });
  }

  /** Expired dispatches are uncertain, never put back into the send queue. */
  recover(): number {
    return this.persistence.transaction((db) => {
      const rows = db
        .query<{ operation_id: string }, [number]>(
          `UPDATE operations SET state='unknown_outcome' WHERE state='dispatching' AND EXISTS
        (SELECT 1 FROM operation_outbox WHERE operation_outbox.operation_id=operations.operation_id AND expires_at<=?) RETURNING operation_id`,
        )
        .all(this.time());
      for (const row of rows)
        db.query(
          "INSERT INTO operation_audit(operation_id,state,created_at) VALUES (?,'unknown_outcome',?)",
        ).run(row.operation_id, this.time());
      return rows.length;
    });
  }

  async reconcile(
    principal: Principal,
    operationID: string,
    port: OperationReconciliationPort,
  ): Promise<Operation> {
    const row = this.persistence.transaction((db) =>
      db
        .query<Row, [string]>("SELECT * FROM operations WHERE operation_id=?")
        .get(operationID),
    );
    if (!row || row.caller_scope !== scope(principal))
      throw new DomainError("not_found");
    await this.authorization.authorize(
      principal,
      parseSessionRef(JSON.parse(row.target_json)),
      row.capability,
    );
    if (row.state !== "unknown_outcome") throw new DomainError("conflict");
    let proof: ReconciliationEvidence;
    try {
      proof = await port.inspect(operationID);
    } catch {
      throw new DomainError("unknown_outcome", false, operationID);
    }
    if (
      proof.operationID !== operationID ||
      row.payload_hash !== proof.payloadHash
    )
      throw new DomainError("conflict");
    if (proof.evidence.state === "unknown_outcome") return view(row);
    return this.finish(row.operation_id, "unknown_outcome", proof.evidence);
  }
}
