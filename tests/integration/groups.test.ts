import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { AuthorizationSnapshot } from "../../src/authorization/authorize";
import {
  capabilities,
  type Principal,
  type SessionRef,
} from "../../src/contracts";
import { GROUPS_MIGRATION, Groups } from "../../src/groups/service";
import { Persistence } from "../../src/persistence/database";

function fixture() {
  const root = mkdtempSync("/tmp/opencode/opencode-sessions-tools/t15-groups-");
  const sql = new Database(`${root}/synthetic.sqlite`);
  GROUPS_MIGRATION.apply(sql, "synthetic-unused");
  sql.exec(
    "CREATE TABLE fixture_work(group_id TEXT, kind TEXT); CREATE TABLE fixture_grants(body TEXT); INSERT INTO fixture_grants VALUES ('unchanged'); CREATE TABLE fixture_host(id TEXT); INSERT INTO fixture_host VALUES ('member')",
  );
  const db = new Persistence(sql, () => {});
  const scope: SessionRef = {
    version: 1,
    instanceID: "fixture",
    projectID: "project",
    sessionID: "owner",
  };
  const operator: Principal = {
    kind: "operator",
    operatorID: "synthetic",
    instanceID: "fixture",
    revision: 1,
  };
  let principal: Principal | null = operator;
  let profile: AuthorizationSnapshot["profile"] = "manage";
  let unavailable = false;
  const snapshot = (): AuthorizationSnapshot => ({
    revision: 1,
    profile,
    profileCapabilities: capabilities,
    policyCapabilities: capabilities,
    hostCapabilities: capabilities,
    deniedCapabilities: [],
    grants: [],
    operator: {
      ...operator,
      capabilities,
      projects: ["project"],
      expiresAt: null,
    },
    delegationCapabilities: null,
    approval: null,
  });
  const service = new Groups(
    db,
    { current: async () => principal },
    { load: () => snapshot(), save: () => {} },
    {
      snapshot(tx, groupID) {
        if (unavailable) throw new Error("synthetic work storage unavailable");
        expect(tx).toBe(sql);
        expect(tx.inTransaction).toBe(true);
        const rows = tx
          .query<{ kind: string }, [string]>(
            "SELECT kind FROM fixture_work WHERE group_id=?",
          )
          .all(groupID);
        return {
          activeTasks: rows.some((r) => r.kind === "task"),
          activeJobs: rows.some((r) => r.kind === "job"),
        };
      },
    },
    () => 1000,
  );
  return {
    sql,
    service,
    scope,
    setPrincipal(p: Principal | null) {
      principal = p;
    },
    setProfile(p: AuthorizationSnapshot["profile"]) {
      profile = p;
    },
    failWork() {
      unavailable = true;
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("SES-05 overlap, idempotent memberships, metadata and persistence without grants or host deletion", async () => {
  const f = fixture();
  try {
    const a = await f.service.create(f.scope, { name: "a", kind: "group" }, 1);
    const b = await f.service.create(f.scope, { name: "b", kind: "system" }, 1);
    const member = { ...f.scope, sessionID: "member" };
    for (const g of [a, b, a]) await f.service.addMember(g.groupID, member, 1);
    await f.service.addMember(
      a.groupID,
      {
        sessionID: member.sessionID,
        projectID: member.projectID,
        instanceID: member.instanceID,
        version: 1,
      },
      1,
    );
    expect((await f.service.get(a.groupID)).members).toEqual([member]);
    expect((await f.service.list(f.scope)).length).toBe(2);
    await f.service.update(a.groupID, { name: "updated", kind: "system" }, 1);
    expect((await f.service.get(a.groupID)).name).toBe("updated");
    await f.service.removeMember(a.groupID, member, 1);
    await f.service.removeMember(a.groupID, member, 1);
    expect((await f.service.get(b.groupID)).members).toEqual([member]);
    await f.service.deleteGroup(a.groupID, 1);
    expect(f.sql.query("SELECT * FROM fixture_grants").all()).toEqual([
      { body: "unchanged" },
    ]);
    expect(f.sql.query("SELECT * FROM fixture_host").all()).toEqual([
      { id: "member" },
    ]);
  } finally {
    f.close();
  }
});

test("SES-05 active task/job deletion conflicts in the same local transaction", async () => {
  const f = fixture();
  try {
    const g = await f.service.create(
      f.scope,
      { name: "active", kind: "group" },
      1,
    );
    for (const kind of ["task", "job"]) {
      f.sql.query("INSERT INTO fixture_work VALUES (?,?)").run(g.groupID, kind);
      await expect(f.service.deleteGroup(g.groupID, 1)).rejects.toMatchObject({
        code: "conflict",
      });
      expect((await f.service.get(g.groupID)).name).toBe("active");
      f.sql.exec("DELETE FROM fixture_work");
    }
    f.failWork();
    await expect(f.service.deleteGroup(g.groupID, 1)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect((await f.service.get(g.groupID)).name).toBe("active");
  } finally {
    f.close();
  }
});

test("SES-05 trusted scope/profile, session ownership and member filtering fail closed", async () => {
  const f = fixture();
  try {
    const g = await f.service.create(
      f.scope,
      { name: "private", kind: "group" },
      1,
    );
    const hidden = { ...f.scope, projectID: "hidden", sessionID: "secret" };
    f.sql
      .query("INSERT INTO groups_members VALUES (?,?)")
      .run(g.groupID, JSON.stringify(hidden));
    expect((await f.service.get(g.groupID)).members).toEqual([]);
    f.setProfile("observe");
    await expect(
      f.service.update(g.groupID, { name: "no", kind: "group" }, 1),
    ).rejects.toMatchObject({ code: "forbidden" });
    f.setProfile("manage");
    f.setPrincipal({ kind: "session", session: f.scope });
    await expect(f.service.get(g.groupID)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      f.service.create(f.scope, { name: "no", kind: "group" }, 1),
    ).rejects.toMatchObject({ code: "forbidden" });
    f.setPrincipal(null);
    await expect(f.service.get(g.groupID)).rejects.toMatchObject({
      code: "forbidden",
    });
  } finally {
    f.close();
  }
});
