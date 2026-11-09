import type { Database } from "bun:sqlite";
import {
  type AuthorizationSnapshot,
  type AuthorizationSnapshotPort,
  Authorizer,
  type Profile,
  type TrustedPrincipalPort,
} from "../authorization/authorize";
import type { GrantPolicyPort } from "../authorization/grants";
import {
  canonical,
  DomainError,
  type Principal,
  parseCapability,
  parseSessionRef,
  type SessionRef,
} from "../contracts";
import type { Migration, Persistence } from "../persistence/database";

/** Integrator assigns global v21; local fixtures may assign another contiguous version. */
export const POLICY_MIGRATION: Omit<Migration, "version"> = {
  apply(sql) {
    sql.exec(`
      CREATE TABLE composition_policies (
        instance_id TEXT NOT NULL, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
        principal TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), body TEXT NOT NULL,
        PRIMARY KEY(instance_id,project_id,session_id,principal)
      );
      CREATE TABLE composition_routes (
        instance_id TEXT NOT NULL, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
        location_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0),
        PRIMARY KEY(instance_id,project_id,session_id)
      );
    `);
  },
};

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function instant(value: unknown): boolean {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw new DomainError("unavailable");
  return value as Record<string, unknown>;
}
function caps(value: unknown): void {
  if (!Array.isArray(value)) throw new DomainError("unavailable");
  for (const c of value) parseCapability(c);
}
function principalKey(value: Principal): string {
  object(
    value,
    value?.kind === "session"
      ? ["kind", "session"]
      : ["kind", "operatorID", "instanceID", "revision"],
  );
  if (value?.kind === "session")
    return canonical({
      kind: "session",
      session: parseSessionRef(value.session),
    });
  if (
    value?.kind !== "operator" ||
    !text(value.operatorID) ||
    !text(value.instanceID) ||
    !validRevision(value.revision)
  )
    throw new DomainError("unavailable");
  return canonical({
    kind: "operator",
    operatorID: value.operatorID,
    instanceID: value.instanceID,
    revision: value.revision,
  });
}
/** Storage validation only. Capability ceilings and authorization remain exclusively T11. */
function validated(value: unknown): AuthorizationSnapshot {
  try {
    const s = object(value, [
      "revision",
      "profile",
      "profileCapabilities",
      "policyCapabilities",
      "hostCapabilities",
      "deniedCapabilities",
      "grants",
      "operator",
      "delegationCapabilities",
      "approval",
    ]);
    const profiles: readonly Profile[] = [
      "observe",
      "collaborate",
      "manage",
      "supervised",
      "bounded-auto",
    ];
    if (
      !validRevision(s.revision) ||
      !profiles.includes(s.profile as Profile) ||
      !Array.isArray(s.grants) ||
      s.grants.length !== 0
    )
      throw new Error();
    for (const field of [
      s.profileCapabilities,
      s.policyCapabilities,
      s.hostCapabilities,
      s.deniedCapabilities,
    ])
      caps(field);
    if (s.delegationCapabilities !== null) caps(s.delegationCapabilities);
    if (s.operator !== null) {
      const o = object(s.operator, [
        "operatorID",
        "instanceID",
        "revision",
        "capabilities",
        "projects",
        "expiresAt",
      ]);
      if (
        !text(o.operatorID) ||
        !text(o.instanceID) ||
        !validRevision(o.revision) ||
        !Array.isArray(o.projects) ||
        !o.projects.every(text) ||
        !(o.expiresAt === null || instant(o.expiresAt))
      )
        throw new Error();
      caps(o.capabilities);
    }
    if (s.approval !== null) {
      const a = object(s.approval, [
        "operationID",
        "delegation",
        "scheduled",
        "principal",
        "target",
        "capability",
        "revision",
        "expiresAt",
        "mode",
      ]);
      principalKey(a.principal as Principal);
      parseSessionRef(a.target);
      parseCapability(a.capability);
      if (
        !validRevision(a.revision) ||
        !instant(a.expiresAt) ||
        !["once", "always"].includes(a.mode as string) ||
        !(a.operationID === undefined || text(a.operationID))
      )
        throw new Error();
      if (a.delegation !== undefined) {
        const d = object(a.delegation, ["requested", "requiredCapabilities"]);
        caps(d.requested);
        caps(d.requiredCapabilities);
        if (
          !text(a.operationID) ||
          !(d.requiredCapabilities as string[]).every((c) => c === "read") ||
          a.scheduled !== undefined
        )
          throw new Error();
      }
      if (a.scheduled !== undefined) {
        const scheduled = object(a.scheduled, ["modality", "occurrence"]);
        if (scheduled.modality !== "scheduled-message" || !text(a.operationID))
          throw new Error();
        if (scheduled.occurrence !== undefined) {
          const occurrence = object(scheduled.occurrence, [
            "jobID",
            "scheduleRevision",
            "occurrenceID",
          ]);
          if (
            !text(occurrence.jobID) ||
            !validRevision(occurrence.scheduleRevision) ||
            !text(occurrence.occurrenceID)
          )
            throw new Error();
        }
      }
    }
    return value as AuthorizationSnapshot;
  } catch {
    throw new DomainError("unavailable");
  }
}

interface Loaded {
  sql: Database;
  target: SessionRef;
  key: string;
  body: string | null;
}
export class CanonicalPolicy
  implements AuthorizationSnapshotPort, GrantPolicyPort
{
  private readonly loaded = new WeakMap<AuthorizationSnapshot, Loaded>();
  private readonly admitting: AuthorizationSnapshot[] = [];
  private readonly ownership: string;
  private readonly authorizer: Authorizer;
  constructor(
    private readonly storage: Persistence,
    private readonly instanceID: string,
    identity: TrustedPrincipalPort,
    clock: () => number,
  ) {
    this.ownership = storage.transaction((sql) => {
      const row = sql
        .query<
          { instance_id: string; scope_id: string; installation_id: string },
          []
        >(
          "SELECT instance_id,scope_id,installation_id FROM ownership WHERE singleton=1",
        )
        .get();
      if (!row || row.instance_id !== instanceID)
        throw new DomainError("unavailable");
      return canonical(row);
    });
    this.authorizer = new Authorizer(identity, this, clock);
  }
  private guard(sql: Database): void {
    if (!sql.inTransaction) throw new DomainError("unavailable");
    this.storage.transaction((current) => {
      if (current !== sql || !sql.inTransaction)
        throw new DomainError("unavailable");
      const row = sql
        .query<
          { instance_id: string; scope_id: string; installation_id: string },
          []
        >(
          "SELECT instance_id,scope_id,installation_id FROM ownership WHERE singleton=1",
        )
        .get();
      if (!row || canonical(row) !== this.ownership)
        throw new DomainError("unavailable");
    });
  }
  load(
    sql: Database,
    principal: Principal,
    target: SessionRef,
  ): AuthorizationSnapshot {
    this.guard(sql);
    const ref = parseSessionRef(target);
    const key = principalKey(principal);
    if (
      ref.instanceID !== this.instanceID ||
      (principal.kind === "operator"
        ? principal.instanceID
        : principal.session.instanceID) !== this.instanceID
    )
      throw new DomainError("not_found");
    const row = sql
      .query<
        { body: string; revision: number },
        [string, string, string, string]
      >(
        "SELECT body,revision FROM composition_policies WHERE instance_id=? AND project_id=? AND session_id=? AND principal=?",
      )
      .get(ref.instanceID, ref.projectID, ref.sessionID, key);
    let snapshot: AuthorizationSnapshot;
    if (row) {
      try {
        snapshot = validated(JSON.parse(row.body));
      } catch {
        throw new DomainError("unavailable");
      }
      if (snapshot.revision !== row.revision)
        throw new DomainError("unavailable");
    } else {
      // Only T11's minimal same-project discovery/message may pass without a policy.
      snapshot = {
        revision: 0,
        profile: "collaborate",
        profileCapabilities: ["discover", "message"],
        policyCapabilities: ["discover", "message"],
        hostCapabilities: ["discover", "message"],
        deniedCapabilities: [],
        grants: [],
        operator: null,
        delegationCapabilities: null,
        approval: null,
      };
    }
    this.loaded.set(snapshot, {
      sql,
      target: ref,
      key,
      body: row?.body ?? null,
    });
    snapshot.grants = sql
      .query<{ body: string }, []>(
        "SELECT body FROM grants_records WHERE revoked=0",
      )
      .all()
      .map((row) => {
        try {
          return JSON.parse(row.body);
        } catch {
          throw new DomainError("unavailable");
        }
      });
    return snapshot;
  }
  save(sql: Database, snapshot: AuthorizationSnapshot): void {
    this.guard(sql);
    const loaded = this.loaded.get(snapshot);
    if (!loaded || loaded.sql !== sql) throw new DomainError("unavailable");
    const body = JSON.stringify(validated({ ...snapshot, grants: [] }));
    const { target, key } = loaded;
    if (loaded.body === null) {
      // Default reads never create authority; only an admitted policy mutation inserts.
      if (snapshot.approval !== null) throw new DomainError("unavailable");
      return;
    }
    const result = sql
      .query(
        "UPDATE composition_policies SET body=? WHERE instance_id=? AND project_id=? AND session_id=? AND principal=? AND body=? AND revision=?",
      )
      .run(
        body,
        target.instanceID,
        target.projectID,
        target.sessionID,
        key,
        loaded.body,
        snapshot.revision,
      );
    if (result.changes !== 1) throw new DomainError("conflict");
    loaded.body = body;
  }
  async read(
    principal: Principal,
    target: SessionRef,
  ): Promise<AuthorizationSnapshot> {
    return this.storage.transaction((sql) => this.load(sql, principal, target));
  }
  admission<T>(
    principal: Principal,
    target: SessionRef,
    check: (snapshot: AuthorizationSnapshot) => T,
  ): T {
    return this.storage.transaction((sql) => {
      const snapshot = this.load(sql, principal, target);
      this.admitting.push(snapshot);
      try {
        const result = check(snapshot);
        if (result && typeof (result as { then?: unknown }).then === "function")
          throw new DomainError("invalid_input");
        this.save(sql, snapshot);
        return result;
      } finally {
        this.admitting.pop();
      }
    });
  }
  /** Private composition API; not an enrollment or public transport. Bootstrap is separate. */
  async write(
    actor: Principal,
    target: SessionRef,
    subject: Principal,
    expectedRevision: number,
    next: AuthorizationSnapshot,
    authorityRevision: number = expectedRevision,
  ): Promise<void> {
    if (actor.kind !== "operator") throw new DomainError("forbidden");
    const replacement = validated(structuredClone(next));
    if (
      !validRevision(expectedRevision) ||
      !validRevision(authorityRevision) ||
      replacement.revision !== expectedRevision + 1
    )
      throw new DomainError("invalid_input");
    await this.authorizer.admit(
      actor,
      target,
      "manage",
      authorityRevision,
      () => {
        this.storage.transaction((sql) => {
          this.guard(sql);
          const current = this.load(sql, subject, target);
          if (current.revision !== expectedRevision)
            throw new DomainError("conflict");
          const key = principalKey(subject);
          const body = JSON.stringify(replacement);
          const result = sql
            .query(
              "INSERT INTO composition_policies(instance_id,project_id,session_id,principal,revision,body) VALUES (?,?,?,?,?,?) ON CONFLICT(instance_id,project_id,session_id,principal) DO UPDATE SET revision=excluded.revision,body=excluded.body WHERE composition_policies.revision=?",
            )
            .run(
              target.instanceID,
              target.projectID,
              target.sessionID,
              key,
              replacement.revision,
              body,
              expectedRevision,
            );
          if (result.changes !== 1) throw new DomainError("conflict");
          // A self-policy replacement is itself the admitted write. Do not overwrite
          // its new revision/approval with the old admission snapshot on return.
          for (const snapshot of this.admitting) {
            const loaded = this.loaded.get(snapshot);
            if (
              loaded?.sql === sql &&
              loaded.key === key &&
              canonical(loaded.target) === canonical(target)
            ) {
              Object.assign(snapshot, structuredClone(replacement));
              loaded.body = body;
            }
          }
        });
      },
    );
  }
}
