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

/** Integrator assigns the global migration version; never applied automatically. */
export const GROUPS_MIGRATION: Omit<Migration, "version"> = {
  apply(sql) {
    sql.exec(`CREATE TABLE groups_records (group_id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE groups_members (group_id TEXT NOT NULL REFERENCES groups_records(group_id) ON DELETE CASCADE, session_ref TEXT NOT NULL, PRIMARY KEY(group_id,session_ref));`);
  },
};

export interface GroupInput {
  name: string;
  kind: "group" | "system";
}
export interface GroupRecord extends GroupInput {
  version: 1;
  groupID: string;
  scope: SessionRef;
  owner: Principal;
}
export interface GroupView extends GroupRecord {
  members: SessionRef[];
}
/** Trusted LOCAL adapter. Must query canonical task/job tables on this exact
 * database inside the deletion transaction, never a cached/remote snapshot.
 * Missing/unavailable tables must throw, not report no work. Future T23/T29 join.
 */
export interface GroupActiveWorkPort {
  snapshot(
    sql: Database,
    groupID: string,
  ): { activeTasks: boolean; activeJobs: boolean };
}
function fail(
  code:
    | "invalid_input"
    | "not_found"
    | "forbidden"
    | "conflict"
    | "unavailable",
): never {
  throw new DomainError(code);
}
function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) fail("invalid_input");
}
export function parseGroupInput(value: unknown): GroupInput {
  if (!value || typeof value !== "object") fail("invalid_input");
  const v = value as GroupInput;
  id(v.name);
  if (v.kind !== "group" && v.kind !== "system") fail("invalid_input");
  return { name: v.name, kind: v.kind };
}
function same(a: SessionRef, b: SessionRef): boolean {
  return (
    a.instanceID === b.instanceID &&
    a.projectID === b.projectID &&
    a.sessionID === b.sessionID
  );
}
function memberKey(member: SessionRef): string {
  return JSON.stringify({
    version: 1,
    instanceID: member.instanceID,
    projectID: member.projectID,
    sessionID: member.sessionID,
  });
}

export class Groups {
  private readonly auth: Authorizer;
  constructor(
    private readonly storage: Persistence,
    private readonly identity: TrustedPrincipalPort,
    policy: GrantPolicyPort,
    private readonly work: GroupActiveWorkPort,
    clock: () => number,
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
  private async principal(): Promise<Principal> {
    const p = await this.identity.current();
    if (!p) fail("forbidden");
    return p;
  }
  private row(sql: Database, groupID: string): GroupRecord {
    id(groupID);
    const row = sql
      .query<{ body: string }, [string]>(
        "SELECT body FROM groups_records WHERE group_id=?",
      )
      .get(groupID);
    if (!row) fail("not_found");
    return JSON.parse(row.body) as GroupRecord;
  }
  private owned(p: Principal, g: GroupRecord): void {
    if (
      p.kind === "session" &&
      (g.owner.kind !== "session" || !same(p.session, g.owner.session))
    )
      fail("not_found");
  }
  async create(
    scope: SessionRef,
    input: GroupInput,
    policyRevision: number,
  ): Promise<GroupRecord> {
    scope = parseSessionRef(scope);
    const metadata = parseGroupInput(input);
    const p = await this.principal();
    return this.auth.admit(p, scope, "manage", policyRevision, () =>
      this.storage.transaction((sql) => {
        const group: GroupRecord = {
          ...metadata,
          version: 1,
          groupID: crypto.randomUUID(),
          scope: { ...scope },
          owner: structuredClone(p),
        };
        sql
          .query("INSERT INTO groups_records VALUES (?,?)")
          .run(group.groupID, JSON.stringify(group));
        return group;
      }),
    );
  }
  private async mutate<T>(
    groupID: string,
    policyRevision: number,
    effect: (sql: Database, g: GroupRecord) => T,
  ): Promise<T> {
    id(groupID);
    const p = await this.principal();
    const g = this.storage.transaction((sql) => this.row(sql, groupID));
    // Authenticate provenance before deciding author ownership.
    await this.auth.authorizeReplay(p, p);
    this.owned(p, g);
    return this.auth.admit(p, g.scope, "manage", policyRevision, () =>
      this.storage.transaction((sql) => {
        const current = this.row(sql, groupID);
        this.owned(p, current);
        return effect(sql, current);
      }),
    );
  }
  async update(
    groupID: string,
    input: GroupInput,
    policyRevision: number,
  ): Promise<GroupRecord> {
    const metadata = parseGroupInput(input);
    return this.mutate(groupID, policyRevision, (sql, g) => {
      const next = { ...g, ...metadata };
      sql
        .query("UPDATE groups_records SET body=? WHERE group_id=?")
        .run(JSON.stringify(next), groupID);
      return next;
    });
  }
  async addMember(
    groupID: string,
    member: SessionRef,
    policyRevision: number,
  ): Promise<void> {
    member = parseSessionRef(member);
    const p = await this.principal();
    await this.auth.authorize(p, member, "discover");
    return this.mutate(groupID, policyRevision, (sql) => {
      sql
        .query("INSERT OR IGNORE INTO groups_members VALUES (?,?)")
        .run(groupID, memberKey(member));
    });
  }
  async removeMember(
    groupID: string,
    member: SessionRef,
    policyRevision: number,
  ): Promise<void> {
    member = parseSessionRef(member);
    return this.mutate(groupID, policyRevision, (sql) => {
      sql
        .query("DELETE FROM groups_members WHERE group_id=? AND session_ref=?")
        .run(groupID, memberKey(member));
    });
  }
  async deleteGroup(groupID: string, policyRevision: number): Promise<void> {
    return this.mutate(groupID, policyRevision, (sql) => {
      const snapshot = this.work.snapshot(sql, groupID);
      if (
        !snapshot ||
        typeof snapshot.activeTasks !== "boolean" ||
        typeof snapshot.activeJobs !== "boolean"
      )
        fail("unavailable");
      if (snapshot.activeTasks || snapshot.activeJobs) fail("conflict");
      sql.query("DELETE FROM groups_members WHERE group_id=?").run(groupID);
      sql.query("DELETE FROM groups_records WHERE group_id=?").run(groupID);
    });
  }
  async get(groupID: string): Promise<GroupView> {
    id(groupID);
    const p = await this.principal();
    const g = this.storage.transaction((sql) => this.row(sql, groupID));
    await this.auth.authorizeReplay(p, p);
    this.owned(p, g);
    await this.auth.authorize(p, g.scope, "discover");
    const members = this.storage.transaction((sql) =>
      sql
        .query<{ session_ref: string }, [string]>(
          "SELECT session_ref FROM groups_members WHERE group_id=? ORDER BY session_ref",
        )
        .all(groupID)
        .map((row) => JSON.parse(row.session_ref) as SessionRef),
    );
    const visible: SessionRef[] = [];
    for (const member of members) {
      try {
        await this.auth.authorize(p, member, "discover");
        visible.push(member);
      } catch (error) {
        if (
          !(error instanceof DomainError) ||
          !["forbidden", "not_found"].includes(error.code)
        )
          throw error;
      }
    }
    return { ...g, members: visible };
  }
  async list(scope: SessionRef): Promise<GroupView[]> {
    scope = parseSessionRef(scope);
    const p = await this.principal();
    await this.auth.authorize(p, scope, "discover");
    const rows = this.storage.transaction((sql) =>
      sql
        .query<{ body: string }, []>(
          "SELECT body FROM groups_records ORDER BY group_id",
        )
        .all()
        .map((row) => JSON.parse(row.body) as GroupRecord),
    );
    const result: GroupView[] = [];
    for (const g of rows) {
      if (!same(g.scope, scope)) continue;
      try {
        this.owned(p, g);
        result.push(await this.get(g.groupID));
      } catch (error) {
        if (
          !(error instanceof DomainError) ||
          !["not_found", "forbidden"].includes(error.code)
        )
          throw error;
      }
    }
    return result;
  }
}
