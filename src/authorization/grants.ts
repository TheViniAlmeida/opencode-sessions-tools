import type { Database } from "bun:sqlite";
import {
  type Capability,
  DomainError,
  type Grant,
  type OperatorPrincipal,
  type Principal,
  parseCapability,
  parseSessionRef,
  type SessionRef,
} from "../contracts";
import type { Migration, Persistence } from "../persistence/database";
import {
  type AuthorizationSnapshot,
  Authorizer,
  type TrustedPrincipalPort,
} from "./authorize";

/** Compose with T10 using the next global version. Never applied by this module. */
export const GRANTS_MIGRATION: Omit<Migration, "version"> = {
  apply(sql) {
    sql.exec(`
      CREATE TABLE grants_revision (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL);
      INSERT INTO grants_revision VALUES (1,0);
      CREATE TABLE grants_records (grant_id TEXT PRIMARY KEY, body TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE grants_requests (request_id TEXT PRIMARY KEY, dedup TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL);
      CREATE UNIQUE INDEX grants_pending ON grants_requests(dedup) WHERE state='pending';
      CREATE TABLE grants_audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, subject_id TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, actor TEXT NOT NULL);
    `);
  },
};

/** Trusted, synchronous LOCAL adapter. load/save must use precisely this Database,
 * canonical policy/operator records, and persist one-shot approval consumption.
 * No network, host effects, credentials, or caller-supplied policy belong here.
 */
export interface GrantPolicyPort {
  load(
    sql: Database,
    principal: Principal,
    target: SessionRef,
  ): AuthorizationSnapshot;
  save(sql: Database, snapshot: AuthorizationSnapshot): void;
}
export interface PendingGrantOperationsPort {
  /** Reject only not-yet-admitted operations; retain admitted records. Same tx. */
  revoke(
    sql: Database,
    grant: Grant,
  ): {
    rejected: readonly string[];
    already_admitted: readonly string[];
  };
}
export interface AccessRequest {
  readonly requestID: string;
  readonly source: SessionRef;
  readonly target: SessionRef;
  readonly capabilities: readonly Capability[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly state: "pending" | "approved" | "denied" | "expired";
  readonly grantID: string | null;
}
export interface LinkInput {
  source: SessionRef;
  target: SessionRef;
  capabilities: readonly Capability[];
  expiresAt: string | null;
  policyRevision: number;
  grantRevision: number;
}
function fail(
  code:
    | "invalid_input"
    | "forbidden"
    | "not_found"
    | "conflict"
    | "unavailable",
): never {
  throw new DomainError(code);
}
function same(a: SessionRef, b: SessionRef): boolean {
  return (
    a.instanceID === b.instanceID &&
    a.projectID === b.projectID &&
    a.sessionID === b.sessionID
  );
}
export function normalizeGrantCapabilities(input: unknown): Capability[] {
  if (!Array.isArray(input) || input.length === 0) fail("invalid_input");
  return [...new Set(input.map(parseCapability))].sort();
}
function revision(sql: Database): number {
  const row = sql
    .query<{ revision: number }, []>(
      "SELECT revision FROM grants_revision WHERE singleton=1",
    )
    .get();
  if (!row) fail("unavailable");
  return row.revision;
}
function grants(sql: Database, now: number): Grant[] {
  return sql
    .query<{ body: string }, []>(
      "SELECT body FROM grants_records WHERE revoked=0",
    )
    .all()
    .map((row) => JSON.parse(row.body) as Grant)
    .filter(
      (g) =>
        Date.parse(g.createdAt) <= now &&
        (g.expiresAt === null || Date.parse(g.expiresAt) > now),
    );
}

export class Grants {
  private readonly authorizer: Authorizer;
  private readonly currentOperatorSnapshot: GrantPolicyPort["load"];
  constructor(
    private readonly storage: Persistence,
    private readonly identity: TrustedPrincipalPort,
    policy: GrantPolicyPort,
    private readonly pending: PendingGrantOperationsPort,
    private readonly clock: () => number,
  ) {
    this.currentOperatorSnapshot = (sql, p, target) =>
      policy.load(sql, p, target);
    this.authorizer = new Authorizer(
      identity,
      {
        read: async (principal, target) =>
          storage.transaction((sql) => {
            const snapshot = policy.load(sql, principal, target);
            snapshot.grants = grants(sql, this.now());
            return snapshot;
          }),
        admission: (principal, target, check) =>
          storage.transaction((sql) => {
            const snapshot = policy.load(sql, principal, target);
            snapshot.grants = grants(sql, this.now());
            const result = check(snapshot);
            policy.save(sql, snapshot);
            return result;
          }),
      },
      clock,
    );
  }
  private now(): number {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) fail("unavailable");
    return value;
  }
  private async principal(): Promise<Principal> {
    const p = await this.identity.current();
    if (!p) fail("forbidden");
    if (p.kind === "session") parseSessionRef(p.session);
    else if (p.kind !== "operator") fail("forbidden");
    return p;
  }
  private bump(sql: Database, expected: number): number {
    if (!Number.isSafeInteger(expected) || expected < 0) fail("invalid_input");
    if (revision(sql) !== expected) fail("conflict");
    if (expected === Number.MAX_SAFE_INTEGER) fail("unavailable");
    sql
      .query("UPDATE grants_revision SET revision=revision+1 WHERE singleton=1")
      .run();
    return expected + 1;
  }
  private audit(sql: Database, kind: string, id: string, p: Principal): void {
    sql
      .query(
        "INSERT INTO grants_audit(kind,subject_id,revision,created_at,actor) VALUES (?,?,?,?,?)",
      )
      .run(
        kind,
        id,
        revision(sql),
        new Date(this.now()).toISOString(),
        JSON.stringify(p),
      );
  }
  private expire(sql: Database): void {
    const rows = sql
      .query<{ request_id: string; body: string }, []>(
        "SELECT request_id,body FROM grants_requests WHERE state='pending'",
      )
      .all();
    for (const row of rows) {
      const r = JSON.parse(row.body) as AccessRequest;
      if (Date.parse(r.expiresAt) <= this.now()) {
        const expired = { ...r, state: "expired" };
        sql
          .query(
            "UPDATE grants_requests SET state='expired',body=? WHERE request_id=?",
          )
          .run(JSON.stringify(expired), row.request_id);
        // Expiry is attributed to the originating session, not a fabricated operator.
        this.audit(sql, "request.expired", r.requestID, {
          kind: "session",
          session: r.source,
        });
      }
    }
  }
  private scope(
    p: OperatorPrincipal,
    source: SessionRef,
    target: SessionRef,
    snapshot: AuthorizationSnapshot,
  ): void {
    parseSessionRef(source);
    parseSessionRef(target);
    if (
      source.instanceID !== p.instanceID ||
      target.instanceID !== p.instanceID ||
      !snapshot.operator?.projects.includes(target.projectID) ||
      !snapshot.operator?.projects.includes(source.projectID)
    )
      fail("forbidden");
  }
  private async operatorMutation<T>(
    target: SessionRef,
    policyRevision: number,
    effect: (
      sql: Database,
      p: OperatorPrincipal,
      snapshot: AuthorizationSnapshot,
    ) => T,
  ): Promise<T> {
    const p = await this.principal();
    if (p.kind !== "operator") fail("forbidden");
    return this.authorizer.admit(p, target, "manage", policyRevision, () =>
      this.storage.transaction((sql) => {
        // Re-read with the same write lock, not an async authorize→write window.
        return effect(sql, p, this.currentOperatorSnapshot(sql, p, target));
      }),
    );
  }

  async link(input: LinkInput, requestID?: string): Promise<Grant> {
    input = {
      ...input,
      source: parseSessionRef(input.source),
      target: parseSessionRef(input.target),
    };
    const caps = normalizeGrantCapabilities(input.capabilities);
    return this.operatorMutation(
      input.target,
      input.policyRevision,
      (sql, p, snapshot) => {
        this.scope(p, input.source, input.target, snapshot);
        const now = this.now();
        if (
          input.expiresAt !== null &&
          (!Number.isFinite(Date.parse(input.expiresAt)) ||
            new Date(input.expiresAt).toISOString() !== input.expiresAt ||
            Date.parse(input.expiresAt) <= now)
        )
          fail("invalid_input");
        this.expire(sql);
        let request: AccessRequest | undefined;
        if (requestID !== undefined) {
          request = this.getRequest(sql, requestID);
          if (
            request.state !== "pending" ||
            !same(request.source, input.source) ||
            !same(request.target, input.target) ||
            JSON.stringify(request.capabilities) !== JSON.stringify(caps)
          )
            fail("conflict");
        }
        const next = this.bump(sql, input.grantRevision);
        const grant: Grant = {
          version: 1,
          grantID: crypto.randomUUID(),
          source: parseSessionRef(input.source),
          target: parseSessionRef(input.target),
          capabilities: caps,
          revision: next,
          issuer: p,
          createdAt: new Date(now).toISOString(),
          expiresAt: input.expiresAt,
        };
        sql
          .query("INSERT INTO grants_records(grant_id,body) VALUES (?,?)")
          .run(grant.grantID, JSON.stringify(grant));
        this.audit(sql, "grant.created", grant.grantID, p);
        if (request) {
          const resolved = {
            ...request,
            state: "approved",
            grantID: grant.grantID,
          };
          sql
            .query(
              "UPDATE grants_requests SET state='approved',body=? WHERE request_id=?",
            )
            .run(JSON.stringify(resolved), request.requestID);
          this.audit(sql, "request.approved", request.requestID, p);
        }
        return grant;
      },
    );
  }
  async unlink(grantID: string, policyRevision: number, grantRevision: number) {
    if ((await this.principal()).kind !== "operator") fail("forbidden");
    const stored = this.storage.transaction((sql) =>
      this.getGrant(sql, grantID),
    );
    return this.operatorMutation(
      stored.target,
      policyRevision,
      (sql, p, snapshot) => {
        const grant = this.getGrant(sql, grantID);
        this.scope(p, grant.source, grant.target, snapshot);
        const next = this.bump(sql, grantRevision);
        sql
          .query("UPDATE grants_records SET revoked=1 WHERE grant_id=?")
          .run(grantID);
        const result = this.pending.revoke(sql, grant);
        if (
          result &&
          typeof (result as unknown as { then?: unknown }).then === "function"
        )
          fail("invalid_input");
        this.audit(sql, "grant.revoked", grantID, p);
        return { revision: next, ...result };
      },
    );
  }
  private getGrant(sql: Database, id: string): Grant {
    const row = sql
      .query<{ body: string }, [string]>(
        "SELECT body FROM grants_records WHERE grant_id=? AND revoked=0",
      )
      .get(id);
    if (!row) fail("not_found");
    return JSON.parse(row.body) as Grant;
  }
  private getRequest(sql: Database, id: string): AccessRequest {
    const row = sql
      .query<{ body: string }, [string]>(
        "SELECT body FROM grants_requests WHERE request_id=?",
      )
      .get(id);
    if (!row) fail("not_found");
    return JSON.parse(row.body) as AccessRequest;
  }
  async request(
    target: SessionRef,
    requested: readonly Capability[],
  ): Promise<AccessRequest> {
    target = parseSessionRef(target);
    const caps = normalizeGrantCapabilities(requested);
    const p = await this.principal();
    if (p.kind !== "session") fail("forbidden");
    return this.storage.transaction((sql) => {
      this.expire(sql);
      const dedup = JSON.stringify([
        p.session.instanceID,
        p.session.projectID,
        p.session.sessionID,
        target.instanceID,
        target.projectID,
        target.sessionID,
        caps,
      ]);
      const existing = sql
        .query<{ body: string }, [string]>(
          "SELECT body FROM grants_requests WHERE dedup=? AND state='pending'",
        )
        .get(dedup);
      if (existing) return JSON.parse(existing.body) as AccessRequest;
      const now = this.now();
      const request: AccessRequest = {
        requestID: crypto.randomUUID(),
        source: p.session,
        target,
        capabilities: caps,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 86_400_000).toISOString(),
        state: "pending",
        grantID: null,
      };
      sql
        .query("INSERT INTO grants_requests VALUES (?,?,?,?)")
        .run(request.requestID, dedup, JSON.stringify(request), request.state);
      this.audit(sql, "request.created", request.requestID, p);
      return request;
    });
  }
  async list(
    target: SessionRef,
    policyRevision: number,
  ): Promise<{ revision: number; grants: Grant[] }> {
    target = parseSessionRef(target);
    const p = await this.principal();
    if (p.kind === "operator") {
      return this.operatorMutation(
        target,
        policyRevision,
        (sql, operator, snapshot) => ({
          revision: revision(sql),
          grants: grants(sql, this.now()).filter(
            (g) =>
              same(g.target, target) &&
              g.source.instanceID === operator.instanceID &&
              snapshot.operator?.projects.includes(g.source.projectID),
          ),
        }),
      );
    }
    // The originating session can inspect its own grants, never inbound or unrelated grants.
    if (!same(p.session, target)) fail("not_found");
    return this.storage.transaction((sql) => ({
      revision: revision(sql),
      grants: grants(sql, this.now()).filter((g) => same(g.source, p.session)),
    }));
  }
  async requests(): Promise<AccessRequest[]> {
    const p = await this.principal();
    if (p.kind === "operator") fail("forbidden");
    return this.storage.transaction((sql) => {
      this.expire(sql);
      return sql
        .query<{ body: string }, []>(
          "SELECT body FROM grants_requests ORDER BY request_id",
        )
        .all()
        .map((row) => JSON.parse(row.body) as AccessRequest)
        .filter((r) => same(r.source, p.session));
    });
  }
  async operatorRequests(
    target: SessionRef,
    policyRevision: number,
  ): Promise<AccessRequest[]> {
    target = parseSessionRef(target);
    return this.operatorMutation(target, policyRevision, (sql, p, snapshot) => {
      this.expire(sql);
      return sql
        .query<{ body: string }, []>(
          "SELECT body FROM grants_requests ORDER BY request_id",
        )
        .all()
        .map((row) => JSON.parse(row.body) as AccessRequest)
        .filter(
          (r) =>
            same(r.target, target) &&
            r.source.instanceID === p.instanceID &&
            snapshot.operator?.projects.includes(r.source.projectID),
        );
    });
  }
  async deny(
    requestID: string,
    policyRevision: number,
  ): Promise<AccessRequest> {
    if ((await this.principal()).kind !== "operator") fail("forbidden");
    const stored = this.storage.transaction((sql) =>
      this.getRequest(sql, requestID),
    );
    return this.operatorMutation(
      stored.target,
      policyRevision,
      (sql, p, snapshot) => {
        this.expire(sql);
        const r = this.getRequest(sql, requestID);
        this.scope(p, r.source, r.target, snapshot);
        if (r.state !== "pending") fail("conflict");
        const result: AccessRequest = { ...r, state: "denied" };
        sql
          .query(
            "UPDATE grants_requests SET state='denied',body=? WHERE request_id=?",
          )
          .run(JSON.stringify(result), requestID);
        this.audit(sql, "request.denied", requestID, p);
        return result;
      },
    );
  }
  /** Consumers load these inside their own same-DB authorization/admission tx. */
  snapshot(sql: Database): { revision: number; grants: Grant[] } {
    if (!sql.inTransaction) fail("invalid_input");
    return this.storage.transaction((owned) => {
      if (owned !== sql) fail("invalid_input");
      return { revision: revision(sql), grants: grants(sql, this.now()) };
    });
  }
}
