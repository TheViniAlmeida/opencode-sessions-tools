import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthorizationSnapshot,
  Authorizer,
} from "../../src/authorization/authorize";
import {
  GRANTS_MIGRATION,
  type GrantPolicyPort,
  Grants,
} from "../../src/authorization/grants";
import type { Principal, SessionRef } from "../../src/contracts";
import {
  openPersistence,
  type Persistence,
} from "../../src/persistence/database";
import {
  Operations,
  operationMigrationAt,
  pendingGrantOperations,
} from "../../src/persistence/operations";

const cleanup: { root: string; storage: Persistence }[] = [];
afterEach(() => {
  for (const { root, storage } of cleanup.splice(0)) {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "grants-operations-"));
  const repositoryPath = join(root, "repo");
  mkdirSync(repositoryPath);
  const path = join(root, "synthetic.sqlite");
  writeFileSync(path, "", { mode: 0o600 });
  const stat = statSync(path);
  const storage = openPersistence({
    repositoryPath,
    claims: [
      {
        instanceID: "i",
        scopeID: "scope",
        installationID: "test",
        canonicalPath: realpathSync(path),
        databaseIdentity: `${stat.dev}:${stat.ino}`,
      },
    ],
    migrations: [{ version: 2, ...GRANTS_MIGRATION }, operationMigrationAt(3)],
  });
  cleanup.push({ root, storage });
  const source: SessionRef = {
    version: 1,
    instanceID: "i",
    projectID: "source-project",
    sessionID: "source",
  };
  const target: SessionRef = {
    ...source,
    projectID: "target-project",
    sessionID: "target",
  };
  const operator: Principal = {
    kind: "operator",
    instanceID: "i",
    operatorID: "operator",
    revision: 1,
  };
  const session: Principal = { kind: "session", session: source };
  let current: Principal = operator;
  const identity = { current: async () => current };
  const snapshot: AuthorizationSnapshot = {
    revision: 1,
    profile: "manage",
    profileCapabilities: ["manage", "message"],
    policyCapabilities: ["manage", "message"],
    hostCapabilities: ["manage", "message"],
    deniedCapabilities: [],
    grants: [],
    operator: {
      operatorID: "operator",
      instanceID: "i",
      revision: 1,
      capabilities: ["manage", "message"],
      projects: [source.projectID, target.projectID],
      expiresAt: null,
    },
    delegationCapabilities: null,
    approval: null,
  };
  storage.transaction((sql) => {
    sql.exec("CREATE TABLE synthetic_policy(body TEXT NOT NULL)");
    sql
      .query("INSERT INTO synthetic_policy VALUES (?)")
      .run(JSON.stringify(snapshot));
  });
  const policy: GrantPolicyPort = {
    load(sql) {
      const row = sql
        .query<{ body: string }, []>("SELECT body FROM synthetic_policy")
        .get();
      if (!row) throw new Error("missing synthetic policy");
      return JSON.parse(row.body) as AuthorizationSnapshot;
    },
    save(sql, value) {
      sql
        .query("UPDATE synthetic_policy SET body=?")
        .run(JSON.stringify(value));
    },
  };
  const grants = new Grants(
    storage,
    identity,
    policy,
    pendingGrantOperations(() => 1000),
    () => 1000,
  );
  const grant = await grants.link({
    source,
    target,
    capabilities: ["message"],
    expiresAt: null,
    policyRevision: 1,
    grantRevision: 0,
  });
  const authorization = new Authorizer(
    identity,
    {
      read: async (p, t) =>
        storage.transaction((sql) => ({
          ...policy.load(sql, p, t),
          grants: grants.snapshot(sql).grants,
        })),
      admission: (p, t, check) =>
        storage.transaction((sql) => {
          const value = {
            ...policy.load(sql, p, t),
            grants: grants.snapshot(sql).grants,
          };
          const result = check(value);
          policy.save(sql, value);
          return result;
        }),
    },
    () => 1000,
  );
  // Isolated fixture only; NOT production reconciliation wiring.
  const operations = new Operations(storage, authorization, () => 1000, {
    assertAvailable() {},
  });
  current = session;
  const request = (idempotencyKey: string) => ({
    principal: session,
    target,
    capability: "message" as const,
    expectedRevision: 1,
    idempotencyKey,
    payload: { content: "SYNTHETIC-PRIVATE" },
  });
  const unlink = async () => {
    current = operator;
    return grants.unlink(grant.grantID, 1, 1);
  };
  return {
    storage,
    operations,
    request,
    unlink,
    grant,
    grants,
    session,
    resumeSession: () => {
      current = session;
    },
  };
}

test("unlink rejects matching pending outbox intent, preserves admitted and unknown outcome", async () => {
  const f = await fixture();
  const pending = await f.operations.enqueue(f.request("pending"));
  const pendingLease = f.operations.claim(
    pending.operationID,
    "pending-worker",
    100,
  );
  const admitted = await f.operations.enqueue(f.request("admitted"));
  const unknown = await f.operations.enqueue(f.request("unknown"));
  let sends = 0;
  await f.operations.dispatch(
    f.session,
    f.operations.claim(admitted.operationID, "admitted-worker", 100),
    1,
    async () => {
      sends++;
      return { state: "admitted", receiptID: "receipt", channel: "host" };
    },
  );
  await f.operations.dispatch(
    f.session,
    f.operations.claim(unknown.operationID, "unknown-worker", 100),
    1,
    async () => {
      sends++;
      return { state: "unknown_outcome" };
    },
  );
  const result = await f.unlink();
  expect(result.rejected).toEqual([pending.operationID]);
  expect([...result.already_admitted].sort()).toEqual(
    [admitted.operationID, unknown.operationID].sort(),
  );
  f.resumeSession();
  await expect(
    f.operations.dispatch(f.session, pendingLease, 1, async () => {
      sends++;
      return { state: "rejected" };
    }),
  ).rejects.toThrow("not_found");
  expect(sends).toBe(2);
  expect((await f.operations.enqueue(f.request("pending"))).state).toBe(
    "rejected",
  );
  expect((await f.operations.enqueue(f.request("admitted"))).state).toBe(
    "admitted",
  );
  expect((await f.operations.enqueue(f.request("unknown"))).state).toBe(
    "unknown_outcome",
  );
});

test("unlink failure rolls back grant revision, revocation, pending transition and audit together", async () => {
  const f = await fixture();
  const pending = await f.operations.enqueue(f.request("pending"));
  const before = f.storage.transaction((sql) =>
    sql.query("SELECT * FROM operation_audit").all(),
  );
  f.storage.transaction((sql) =>
    sql.exec(
      "CREATE TRIGGER fail_revoke_audit BEFORE INSERT ON grants_audit WHEN NEW.kind='grant.revoked' BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    ),
  );
  await expect(f.unlink()).rejects.toThrow("unavailable");
  f.storage.transaction((sql) => {
    expect(f.grants.snapshot(sql).revision).toBe(1);
    expect(f.grants.snapshot(sql).grants.map((grant) => grant.grantID)).toEqual(
      [f.grant.grantID],
    );
    expect(
      sql
        .query<{ state: string }, [string]>(
          "SELECT state FROM operations WHERE operation_id=?",
        )
        .get(pending.operationID)?.state,
    ).toBe("pending");
    expect(sql.query("SELECT * FROM operation_audit").all()).toEqual(before);
  });
});

test("real same-DB once reservation and consumption roll back with stale lease or failed policy save", async () => {
  const f = await fixture();
  const request = f.request("once");
  f.storage.transaction((sql) => {
    const row = sql
      .query<{ body: string }, []>("SELECT body FROM synthetic_policy")
      .get();
    const snapshot = JSON.parse(row?.body ?? "null") as AuthorizationSnapshot;
    snapshot.profile = "supervised";
    snapshot.approval = {
      principal: f.session,
      target: request.target,
      capability: "message",
      revision: 1,
      mode: "once",
      expiresAt: new Date(100_000).toISOString(),
    };
    sql
      .query("UPDATE synthetic_policy SET body=?")
      .run(JSON.stringify(snapshot));
  });
  const approval = () =>
    f.storage.transaction((sql) => {
      const row = sql
        .query<{ body: string }, []>("SELECT body FROM synthetic_policy")
        .get();
      return (JSON.parse(row?.body ?? "null") as AuthorizationSnapshot)
        .approval;
    });
  f.storage.transaction((sql) =>
    sql.exec(
      "CREATE TRIGGER fail_intent_save BEFORE UPDATE ON synthetic_policy WHEN json_extract(NEW.body,'$.approval.operationID') IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    ),
  );
  await expect(f.operations.enqueue(request)).rejects.toThrow("unavailable");
  expect(approval()?.operationID).toBeUndefined();
  expect(approval()?.mode).toBe("once");
  f.storage.transaction((sql) => {
    expect(sql.query("SELECT * FROM operations").all()).toHaveLength(0);
    expect(sql.query("SELECT * FROM operation_outbox").all()).toHaveLength(0);
    expect(sql.query("SELECT * FROM operation_audit").all()).toHaveLength(0);
    sql.exec("DROP TRIGGER fail_intent_save");
  });
  const op = await f.operations.enqueue(request);
  expect(approval()?.operationID).toBe(op.operationID);
  expect(approval()?.mode).toBe("once");
  await expect(
    f.operations.enqueue(f.request("different-operation")),
  ).rejects.toThrow("forbidden");
  const stale = f.operations.claim(op.operationID, "old", 100);
  f.storage.transaction((sql) =>
    sql
      .query("UPDATE operation_outbox SET expires_at=0 WHERE operation_id=?")
      .run(op.operationID),
  );
  const lease = f.operations.claim(op.operationID, "current", 100);
  let sends = 0;
  const send = async () => {
    sends++;
    return {
      state: "admitted" as const,
      channel: "host" as const,
      receiptID: "synthetic-receipt",
    };
  };
  await expect(
    f.operations.dispatch(f.session, stale, 1, send),
  ).rejects.toThrow("conflict");
  expect(approval()?.operationID).toBe(op.operationID);
  f.storage.transaction((sql) =>
    sql.exec(
      "CREATE TRIGGER fail_once_save BEFORE UPDATE ON synthetic_policy WHEN json_extract(NEW.body,'$.approval') IS NULL BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    ),
  );
  await expect(
    f.operations.dispatch(f.session, lease, 1, send),
  ).rejects.toThrow("unavailable");
  expect(approval()?.operationID).toBe(op.operationID);
  f.storage.transaction((sql) => {
    expect(
      sql
        .query<{ state: string }, [string]>(
          "SELECT state FROM operations WHERE operation_id=?",
        )
        .get(op.operationID)?.state,
    ).toBe("pending");
    expect(
      sql
        .query("SELECT * FROM operation_audit WHERE state='dispatching'")
        .all(),
    ).toHaveLength(0);
    sql.exec("DROP TRIGGER fail_once_save");
  });
  expect(sends).toBe(0);
  const result = await f.operations.dispatch(f.session, lease, 1, send);
  expect(approval()).toBeNull();
  expect(await f.operations.enqueue(request)).toEqual(result);
  expect(sends).toBe(1);
});
