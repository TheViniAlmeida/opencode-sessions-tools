import { expect, test } from "bun:test";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type AuthorizationSnapshot,
  Authorizer,
} from "../../src/authorization/authorize";
import {
  GRANTS_MIGRATION,
  type GrantPolicyPort,
  Grants,
} from "../../src/authorization/grants";
import {
  capabilities,
  type Principal,
  type SessionRef,
} from "../../src/contracts";
import { openPersistence } from "../../src/persistence/database";

function fixture() {
  const root = mkdtempSync("/tmp/opencode/opencode-sessions-tools/t12-grants-");
  const path = `${root}/synthetic.sqlite`;
  writeFileSync(path, "", { mode: 0o600 });
  const stat = statSync(path);
  const options = {
    repositoryPath: process.cwd(),
    claims: [
      {
        instanceID: "fixture",
        scopeID: "project",
        installationID: "synthetic",
        canonicalPath: realpathSync(path),
        databaseIdentity: `${stat.dev}:${stat.ino}`,
      },
    ],
    migrations: [
      { version: 2, ...GRANTS_MIGRATION },
      {
        version: 3,
        apply(sql: import("bun:sqlite").Database) {
          sql.exec(
            "CREATE TABLE fixture_policy(body TEXT NOT NULL); CREATE TABLE fixture_pending(id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, state TEXT NOT NULL)",
          );
        },
      },
    ],
  };
  const db = openPersistence(options);
  const target: SessionRef = {
    version: 1,
    instanceID: "fixture",
    projectID: "project",
    sessionID: "target",
  };
  const source = { ...target, sessionID: "source" };
  const operator: Principal = {
    kind: "operator",
    operatorID: "synthetic",
    instanceID: "fixture",
    revision: 1,
  };
  const origin: Principal = { kind: "session", session: source };
  let principal: Principal | null = operator;
  let now = 1000;
  const identity = { current: async () => principal };
  const snapshot: AuthorizationSnapshot = {
    revision: 1,
    profile: "manage",
    profileCapabilities: [...capabilities],
    policyCapabilities: [...capabilities],
    hostCapabilities: [...capabilities],
    deniedCapabilities: [],
    grants: [],
    operator: {
      ...operator,
      capabilities: [...capabilities],
      projects: ["project"],
      expiresAt: null,
    },
    delegationCapabilities: [...capabilities],
    approval: null,
  };
  db.transaction((sql) =>
    sql
      .query("INSERT INTO fixture_policy VALUES (?)")
      .run(JSON.stringify(snapshot)),
  );
  const policy: GrantPolicyPort = {
    load: (sql) =>
      JSON.parse(
        sql.query<{ body: string }, []>("SELECT body FROM fixture_policy").get()
          ?.body ?? "null",
      ) as AuthorizationSnapshot,
    save: (sql, s) => {
      sql
        .query("UPDATE fixture_policy SET body=?")
        .run(JSON.stringify({ ...s, grants: [] }));
    },
  };
  let failRevoke = false;
  const service = new Grants(
    db,
    identity,
    policy,
    {
      revoke(sql, g) {
        const rows = sql
          .query<{ id: string; state: string }, [string]>(
            "SELECT id,state FROM fixture_pending WHERE grant_id=?",
          )
          .all(g.grantID);
        const rejected = rows
          .filter((r) => r.state === "pending")
          .map((r) => r.id);
        const already_admitted = rows
          .filter((r) => r.state === "admitted")
          .map((r) => r.id);
        sql
          .query(
            "UPDATE fixture_pending SET state='rejected' WHERE grant_id=? AND state='pending'",
          )
          .run(g.grantID);
        if (failRevoke) throw new Error("synthetic rollback");
        return { rejected, already_admitted };
      },
    },
    () => now,
  );
  const input = (grantRevision = 0) => ({
    source,
    target,
    capabilities: ["read"] as const,
    expiresAt: null,
    policyRevision: 1,
    grantRevision,
  });
  const authorizer = new Authorizer(
    identity,
    {
      read: async (p, t) =>
        db.transaction((sql) => ({
          ...policy.load(sql, p, t),
          grants: service.snapshot(sql).grants,
        })),
      admission: (p, t, check) =>
        db.transaction((sql) => {
          const s = {
            ...policy.load(sql, p, t),
            grants: service.snapshot(sql).grants,
          };
          const result = check(s);
          policy.save(sql, s);
          return result;
        }),
    },
    () => now,
  );
  return {
    root,
    db,
    options,
    service,
    source,
    target,
    operator,
    origin,
    policy,
    authorizer,
    input,
    setPrincipal: (p: Principal | null) => {
      principal = p;
    },
    setTime: (t: number) => {
      now = t;
    },
    failRevoke: () => {
      failRevoke = true;
    },
    cleanup() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("independent processes linearize local revoke/admission on one owned synthetic database", async () => {
  const f = fixture();
  try {
    const grant = await f.service.link(f.input());
    f.db.transaction((sql) =>
      sql
        .query("INSERT INTO fixture_pending VALUES ('race',?,'pending')")
        .run(grant.grantID),
    );
    const worker = fileURLToPath(
      new URL("./fixtures/grants-worker.ts", import.meta.url),
    );
    const processes = (["admit", "revoke"] as const).map((mode) => {
      const child = Bun.spawn([process.execPath, worker], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      child.stdin.write(
        JSON.stringify({ options: f.options, grantID: grant.grantID, mode }),
      );
      child.stdin.end();
      return child;
    });
    const results = await Promise.all(
      processes.map(async (child) => {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(stderr).toBe("");
        expect(code).toBe(0);
        return JSON.parse(stdout);
      }),
    );
    const state = f.db.transaction(
      (sql) =>
        sql
          .query<{ state: string }, []>(
            "SELECT state FROM fixture_pending WHERE id='race'",
          )
          .get()?.state,
    );
    expect(["admitted", "rejected"]).toContain(state ?? "missing");
    expect(results[0].state).toBe(state);
    expect(results[1]).toEqual(
      state === "admitted"
        ? { revision: 2, rejected: [], already_admitted: ["race"] }
        : { revision: 2, rejected: ["race"], already_admitted: [] },
    );
    expect(f.db.transaction((sql) => f.service.snapshot(sql).grants)).toEqual(
      [],
    );
  } finally {
    f.cleanup();
  }
});

test("ACL01/02: trusted operator only, directional grants, expiry, policy and revision revalidation", async () => {
  const f = fixture();
  try {
    f.setPrincipal(f.origin);
    await expect(f.service.link(f.input())).rejects.toThrow("forbidden");
    f.setPrincipal(null);
    await expect(f.service.link(f.input())).rejects.toThrow("forbidden");
    f.setPrincipal(f.operator);
    await expect(
      f.service.link({ ...f.input(), policyRevision: 0 }),
    ).rejects.toThrow("conflict");
    await expect(
      f.service.link({
        ...f.input(),
        source: { ...f.source, projectID: "other" },
      }),
    ).rejects.toThrow("forbidden");
    const grant = await f.service.link({
      ...f.input(),
      expiresAt: new Date(2000).toISOString(),
    });
    expect(grant.revision).toBe(1);
    expect((await f.service.list(f.target, 1)).grants).toEqual([grant]);
    await expect(f.service.link(f.input())).rejects.toThrow("conflict");
    f.setPrincipal(f.origin);
    expect((await f.service.list(f.source, 1)).grants).toEqual([grant]);
    await expect(f.service.list(f.target, 1)).rejects.toThrow("not_found");
    await f.authorizer.authorize(f.origin, f.target, "read");
    const reverse: Principal = { kind: "session", session: f.target };
    f.setPrincipal(reverse);
    await expect(
      f.authorizer.authorize(reverse, f.source, "read"),
    ).rejects.toThrow("forbidden");
    f.setPrincipal(f.origin);
    f.setTime(2000);
    await expect(
      f.authorizer.authorize(f.origin, f.target, "read"),
    ).rejects.toThrow("forbidden");
    expect(
      f.db.transaction((sql) => sql.query("SELECT * FROM grants_audit").all())
        .length,
    ).toBe(1);
  } finally {
    f.cleanup();
  }
});

test("ACL08/09: pending dedup, origin/operator visibility, explicit link, deny and 24h expiry", async () => {
  const f = fixture();
  try {
    f.setPrincipal(f.origin);
    const r = await f.service.request(f.target, ["read"]);
    const duplicates = await Promise.all(
      Array.from({ length: 8 }, () => f.service.request(f.target, ["read"])),
    );
    expect(new Set(duplicates.map((r) => r.requestID)).size).toBe(1);
    expect(await f.service.request(f.target, ["read", "read"])).toEqual(r);
    await expect(
      f.authorizer.authorize(f.origin, f.target, "read"),
    ).rejects.toThrow("forbidden");
    expect(await f.service.requests()).toEqual([r]);
    f.setPrincipal({ kind: "session", session: f.target });
    expect(await f.service.requests()).toEqual([]);
    await expect(f.service.deny(r.requestID, 1)).rejects.toThrow("forbidden");
    f.setPrincipal(f.operator);
    expect(await f.service.operatorRequests(f.target, 1)).toEqual([r]);
    await expect(
      f.service.link({ ...f.input(), capabilities: ["message"] }, r.requestID),
    ).rejects.toThrow("conflict");
    const grant = await f.service.link(f.input(), r.requestID);
    expect((await f.service.operatorRequests(f.target, 1))[0]?.grantID).toBe(
      grant.grantID,
    );
    f.setPrincipal(f.origin);
    const denied = await f.service.request(f.target, ["context.read"]);
    f.setPrincipal(f.operator);
    expect((await f.service.deny(denied.requestID, 1)).state).toBe("denied");
    f.setPrincipal(f.origin);
    const expired = await f.service.request(f.target, ["manage"]);
    f.setTime(86_401_000);
    expect(
      (await f.service.requests()).find(
        (r) => r.requestID === expired.requestID,
      )?.state,
    ).toBe("expired");
    const renewed = await f.service.request(f.target, ["manage"]);
    expect(renewed.requestID).not.toBe(expired.requestID);
    f.setPrincipal(f.operator);
    await expect(
      f.service.link(
        { ...f.input(1), capabilities: ["manage"] },
        expired.requestID,
      ),
    ).rejects.toThrow("conflict");
    expect(f.db.transaction((sql) => f.service.snapshot(sql).revision)).toBe(1);
  } finally {
    f.cleanup();
  }
});

test("current policy is rechecked inside grant write; denial leaves no grant or audit", async () => {
  const f = fixture();
  try {
    f.db.transaction((sql) => {
      const s = f.policy.load(sql, f.operator, f.target);
      s.deniedCapabilities = ["manage"];
      f.policy.save(sql, s);
    });
    await expect(f.service.link(f.input())).rejects.toThrow("forbidden");
    expect(f.db.transaction((sql) => f.service.snapshot(sql))).toEqual({
      revision: 0,
      grants: [],
    });
    expect(
      f.db.transaction((sql) => sql.query("SELECT * FROM grants_audit").all()),
    ).toEqual([]);
  } finally {
    f.cleanup();
  }
});

test("ACL04/05: revoke rejects pending, reports admitted, preserves history, and rolls back as a unit", async () => {
  const f = fixture();
  try {
    const grant = await f.service.link(f.input());
    f.db.transaction((sql) => {
      sql
        .query("INSERT INTO fixture_pending VALUES (?,?,?)")
        .run("pending", grant.grantID, "pending");
      sql
        .query("INSERT INTO fixture_pending VALUES (?,?,?)")
        .run("admitted", grant.grantID, "admitted");
    });
    const result = await f.service.unlink(grant.grantID, 1, 1);
    expect(result).toEqual({
      revision: 2,
      rejected: ["pending"],
      already_admitted: ["admitted"],
    });
    expect(
      f.db.transaction((sql) =>
        sql
          .query("SELECT state FROM fixture_pending WHERE id='admitted'")
          .get(),
      ),
    ).toEqual({ state: "admitted" });
    f.setPrincipal(f.origin);
    await expect(
      f.authorizer.admit(f.origin, f.target, "read", 1, () => {
        throw new Error("must not admit");
      }),
    ).rejects.toThrow("forbidden");
    f.setPrincipal(f.operator);
    const next = await f.service.link(f.input(2));
    f.failRevoke();
    await expect(f.service.unlink(next.grantID, 1, 3)).rejects.toThrow(
      "unavailable",
    );
    expect(f.db.transaction((sql) => f.service.snapshot(sql).revision)).toBe(3);
    expect(
      f.db
        .transaction((sql) => f.service.snapshot(sql).grants)
        .map((g) => g.grantID),
    ).toEqual([next.grantID]);
    const reopened = openPersistence(f.options);
    expect(
      reopened.transaction((sql) =>
        sql
          .query("SELECT * FROM grants_audit WHERE kind='grant.revoked'")
          .all(),
      ).length,
    ).toBe(1);
    reopened.close();
  } finally {
    f.cleanup();
  }
});
