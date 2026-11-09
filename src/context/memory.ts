import type { Database } from "bun:sqlite";
import {
  Authorizer,
  type TrustedPrincipalPort,
} from "../authorization/authorize";
import type { GrantPolicyPort } from "../authorization/grants";
import {
  DomainError,
  type Principal,
  parseSessionRef,
  type SessionRef,
} from "../contracts";
import type { Migration, Persistence } from "../persistence/database";

/** Integrator supplies the global version; never automatically applied. */
export const MEMORY_MIGRATION: Omit<Migration, "version"> = {
  apply(sql) {
    sql.exec(`CREATE TABLE context_memory (
      scope TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL,
      body TEXT, expires_at INTEGER, tombstoned_at TEXT,
      PRIMARY KEY(scope,key));`);
  },
};
export interface MemoryScope {
  session: SessionRef;
  groupID?: string;
}
export interface MemoryWrite {
  key: string;
  value: string;
  expectedRevision: number;
  expiresAt: string | null;
}
export interface MemoryRecord {
  version: 1;
  scope: MemoryScope;
  key: string;
  value: string;
  revision: number;
  owner: Principal;
  author: Principal;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}
/** Trusted local membership check, canonical group scope and membership on this DB.
 * Membership restricts access; it never substitutes for a context capability. */
export interface MemoryGroupPort {
  check(sql: Database, scope: MemoryScope, principal: Principal): void;
}
export interface MemorySchedulerPort {
  every(milliseconds: number, tick: () => void): () => void;
}
interface Row {
  revision: number;
  body: string | null;
  expires_at: number | null;
}
function invalid(): never {
  throw new DomainError("invalid_input");
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
export function parseMemoryWrite(value: unknown): MemoryWrite {
  if (!value || typeof value !== "object") invalid();
  const v = value as MemoryWrite;
  if (
    !text(v.key) ||
    typeof v.value !== "string" ||
    !Number.isSafeInteger(v.expectedRevision) ||
    v.expectedRevision < 0 ||
    !(
      v.expiresAt === null ||
      (typeof v.expiresAt === "string" &&
        Number.isFinite(Date.parse(v.expiresAt)) &&
        new Date(v.expiresAt).toISOString() === v.expiresAt)
    )
  )
    invalid();
  return {
    key: v.key,
    value: v.value,
    expectedRevision: v.expectedRevision,
    expiresAt: v.expiresAt,
  };
}
function scopeKey(scope: MemoryScope): string {
  const s = parseSessionRef(scope?.session);
  if (scope.groupID !== undefined && !text(scope.groupID)) invalid();
  return JSON.stringify([
    s.instanceID,
    s.projectID,
    s.sessionID,
    scope.groupID ?? null,
  ]);
}

/** Local shared board only. No external memory, model credentials or vector store.
 * Caller must enforce its data-retention policy before supplying content.
 * start() is an explicit integration boundary; constructing this class starts no timer. */
export class SharedMemory {
  private readonly auth: Authorizer;
  private cancel: (() => void) | undefined;
  private disposed = false;
  private maintenanceError: unknown;
  constructor(
    private readonly storage: Persistence,
    private readonly identity: TrustedPrincipalPort,
    policy: GrantPolicyPort,
    private readonly clock: () => number,
    private readonly groups?: MemoryGroupPort,
  ) {
    this.auth = new Authorizer(
      identity,
      {
        read: async (p, t) =>
          storage.transaction((sql) => policy.load(sql, p, t)),
        admission: (p, t, check) =>
          storage.transaction((sql) => {
            const snapshot = policy.load(sql, p, t);
            const result = check(snapshot);
            policy.save(sql, snapshot);
            return result;
          }),
      },
      clock,
    );
  }
  private now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new DomainError("unavailable");
    return now;
  }
  private async principal(): Promise<Principal> {
    if (this.disposed) throw new DomainError("unavailable");
    const p = await this.identity.current();
    if (!p) throw new DomainError("forbidden");
    return p;
  }
  private membership(sql: Database, scope: MemoryScope, p: Principal): void {
    if (scope.groupID === undefined) return;
    if (!this.groups) throw new DomainError("unavailable");
    this.groups.check(sql, scope, p);
  }
  private row(sql: Database, scope: string, key: string): Row | null {
    return sql
      .query<Row, [string, string]>(
        "SELECT revision,body,expires_at FROM context_memory WHERE scope=? AND key=?",
      )
      .get(scope, key);
  }
  async read(scope: MemoryScope, key: string): Promise<MemoryRecord | null> {
    scope = structuredClone(scope);
    const sk = scopeKey(scope);
    if (!text(key)) invalid();
    const p = await this.principal();
    // Authenticate provenance and current context.read; reads never consume once.
    await this.auth.authorizeReplay(p, p);
    await this.auth.authorize(p, scope.session, "context.read");
    return this.storage.transaction((sql) => {
      this.membership(sql, scope, p);
      const row = this.row(sql, sk, key);
      if (
        !row?.body ||
        (row.expires_at !== null && row.expires_at <= this.now())
      )
        return null;
      return JSON.parse(row.body) as MemoryRecord;
    });
  }
  async write(
    scope: MemoryScope,
    value: MemoryWrite,
    policyRevision: number,
  ): Promise<MemoryRecord> {
    scope = structuredClone(scope);
    const sk = scopeKey(scope);
    const input = parseMemoryWrite(value);
    const p = await this.principal();
    return this.auth.admit(
      p,
      scope.session,
      "context.write",
      policyRevision,
      () =>
        this.storage.transaction((sql) => {
          this.membership(sql, scope, p);
          const now = this.now();
          this.pruneRows(sql, now);
          const row = this.row(sql, sk, input.key);
          if ((row?.revision ?? 0) !== input.expectedRevision)
            throw new DomainError("conflict");
          if (input.expiresAt !== null && Date.parse(input.expiresAt) <= now)
            invalid();
          const previous = row?.body
            ? (JSON.parse(row.body) as MemoryRecord)
            : null;
          const timestamp = new Date(now).toISOString();
          const record: MemoryRecord = {
            version: 1,
            scope,
            key: input.key,
            value: input.value,
            revision: (row?.revision ?? 0) + 1,
            owner: previous?.owner ?? structuredClone(p),
            author: structuredClone(p),
            createdAt: previous?.createdAt ?? timestamp,
            updatedAt: timestamp,
            expiresAt: input.expiresAt,
          };
          sql
            .query(`INSERT INTO context_memory VALUES (?,?,?,?,?,NULL)
        ON CONFLICT(scope,key) DO UPDATE SET revision=excluded.revision,body=excluded.body,expires_at=excluded.expires_at,tombstoned_at=NULL`)
            .run(
              sk,
              input.key,
              record.revision,
              JSON.stringify(record),
              input.expiresAt === null ? null : Date.parse(input.expiresAt),
            );
          return record;
        }),
    );
  }
  private pruneRows(sql: Database, now: number): number {
    return sql
      .query(
        "UPDATE context_memory SET body=NULL,expires_at=NULL,tombstoned_at=?,revision=revision+1 WHERE body IS NOT NULL AND expires_at<=?",
      )
      .run(new Date(now).toISOString(), now).changes;
  }
  /** Maintenance port for the active service; no user-visible expired content. */
  prune(): number {
    if (this.disposed) throw new DomainError("unavailable");
    return this.storage.transaction((sql) => this.pruneRows(sql, this.now()));
  }
  start(scheduler: MemorySchedulerPort): void {
    if (this.disposed) throw new DomainError("unavailable");
    if (this.cancel) return;
    this.cancel = scheduler.every(60000, () => {
      if (this.disposed) return;
      try {
        this.prune();
        this.maintenanceError = undefined;
      } catch {
        this.maintenanceError = new DomainError("unavailable");
      }
    });
  }
  get maintenanceHealthy(): boolean {
    return (
      this.cancel !== undefined &&
      this.maintenanceError === undefined &&
      !this.disposed
    );
  }
  dispose(): void {
    this.disposed = true;
    this.cancel?.();
    this.cancel = undefined;
  }
}
