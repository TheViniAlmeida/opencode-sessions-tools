import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Authorizer } from "../../src/authorization/authorize";
import { GRANTS_MIGRATION } from "../../src/authorization/grants";
import { canonical, DomainError, type SessionRef } from "../../src/contracts";
import { openPersistence, Persistence } from "../../src/persistence/database";
import {
  Operations,
  operationMigrationAt,
  operationsMigration,
} from "../../src/persistence/operations";
import { DiscoveryService } from "../../src/sessions/discovery";
import {
  ReconciliationService,
  type RemovedSessionCleanupPort,
  reconciliationMigration,
  reconciliationMigrationAt,
  removedTargetPort,
} from "../../src/sessions/reconcile";

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});
function fileFixture() {
  const base = "/tmp/opencode/opencode-sessions-tools";
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "reconcile-"));
  const repositoryPath = join(root, "repo");
  mkdirSync(repositoryPath);
  const path = join(root, "synthetic.sqlite");
  writeFileSync(path, "", { mode: 0o600 });
  const stat = statSync(path);
  const options = {
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
    migrations: [
      { version: 2, ...GRANTS_MIGRATION },
      operationMigrationAt(3),
      reconciliationMigrationAt(4),
    ],
  };
  let storage = openPersistence(options);
  disposals.push(() => {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    get storage() {
      return storage;
    },
    reopen() {
      storage.close();
      storage = openPersistence(options);
      return storage;
    },
    options,
  };
}

test("real enqueue to missing rejects pending and redacts content while preserving native receipt and hash", async () => {
  const f = fileFixture();
  const target: SessionRef = {
    version: 1,
    instanceID: "i",
    projectID: "p",
    sessionID: "target",
  };
  const principal = { kind: "session" as const, session: target };
  const identity = { current: async () => principal };
  const capabilities = ["message", "discover"] as const;
  const snapshot = {
    revision: 1,
    profile: "collaborate" as const,
    profileCapabilities: capabilities,
    policyCapabilities: capabilities,
    hostCapabilities: capabilities,
    deniedCapabilities: [],
    grants: [],
    operator: null,
    delegationCapabilities: null,
    approval: null,
  };
  const authorization = new Authorizer(
    identity,
    {
      read: async () => snapshot,
      admission: (_p, _t, check) =>
        f.storage.transaction(() => check(snapshot)),
    },
    () => 1000,
  );
  const operations = new Operations(
    f.storage,
    authorization,
    () => 1000,
    removedTargetPort,
  );
  const request = {
    principal,
    target,
    capability: "message" as const,
    expectedRevision: 1,
    idempotencyKey: "pending",
    payload: { content: "private" },
  };
  const pending = await operations.enqueue(request);
  const pendingLease = operations.claim(pending.operationID, "worker", 100);
  const admitted = await operations.enqueue({
    ...request,
    idempotencyKey: "admitted",
  });
  const admittedLease = operations.claim(admitted.operationID, "worker", 100);
  await operations.dispatch(principal, admittedLease, 1, async () => ({
    state: "admitted",
    receiptID: "native-receipt",
    channel: "host",
  }));
  const read = () =>
    f.storage.transaction((db) =>
      db
        .query<
          {
            operation_id: string;
            state: string;
            payload_hash: string;
            payload_json: string;
            receipt_id: string | null;
            channel: string | null;
          },
          []
        >(
          "SELECT operation_id,state,payload_hash,payload_json,receipt_id,channel FROM operations ORDER BY operation_id",
        )
        .all(),
    );
  const before = read();
  const reconciliation = new ReconciliationService(
    f.storage,
    identity,
    authorization,
    { get: async () => null },
    { cleanup() {} },
    () => 1000,
  );
  await reconciliation.missing(target);
  expect(read()).toEqual(
    before.map((row) => ({
      ...row,
      state: row.operation_id === pending.operationID ? "rejected" : "admitted",
      payload_json: "null",
    })),
  );
  await expect(
    operations.enqueue({ ...request, idempotencyKey: "after-removal" }),
  ).rejects.toMatchObject({ code: "not_found" });
  let sends = 0;
  await expect(
    operations.dispatch(principal, pendingLease, 1, async () => {
      sends++;
      return { state: "admitted", receiptID: "unexpected", channel: "host" };
    }),
  ).rejects.toMatchObject({ code: "not_found" });
  expect(sends).toBe(0);
  const audits = f.storage.transaction((db) =>
    db.query("SELECT * FROM session_removal_audit").all(),
  );
  await reconciliation.missing(target);
  expect(
    f.storage.transaction((db) =>
      db.query("SELECT * FROM session_removal_audit").all(),
    ),
  ).toEqual(audits);
});

test("removed-target guard blocks new enqueue and dispatch, not existing replay", async () => {
  const db = new Database(":memory:");
  db.exec(operationsMigration.sql);
  db.exec(reconciliationMigration.sql);
  const persistence = new Persistence(db, () => {});
  const target: SessionRef = {
    version: 1,
    instanceID: "i",
    projectID: "p",
    sessionID: "target",
  };
  const principal = { kind: "session" as const, session: target };
  const snapshot = {
    revision: 1,
    profile: "collaborate" as const,
    profileCapabilities: ["message" as const],
    policyCapabilities: ["message" as const],
    hostCapabilities: ["message" as const],
    deniedCapabilities: [],
    grants: [],
    operator: null,
    delegationCapabilities: null,
    approval: null,
  };
  const auth = new Authorizer(
    { current: async () => principal },
    {
      read: async () => snapshot,
      admission: (_p, _t, check) =>
        persistence.transaction(() => check(snapshot)),
    },
    () => 1000,
  );
  const operations = new Operations(persistence, auth, () => 1000, {
    assertAvailable(sql, ref) {
      expect(sql).toBe(db);
      expect(sql.inTransaction).toBe(true);
      removedTargetPort.assertAvailable(sql, ref);
    },
  });
  const request = {
    principal,
    target,
    capability: "message" as const,
    expectedRevision: 1,
    idempotencyKey: "before",
    payload: "secret",
  };
  const before = await operations.enqueue(request);
  const lease = operations.claim(before.operationID, "worker", 100);
  db.query("INSERT INTO session_tombstones VALUES (?,?,?,?)").run(
    "i",
    "target",
    "p",
    1000,
  );
  await expect(
    operations.enqueue({ ...request, idempotencyKey: "after" }),
  ).rejects.toMatchObject({ code: "not_found" });
  expect(await operations.enqueue(request)).toEqual(before);
  let sends = 0;
  await expect(
    operations.dispatch(principal, lease, 1, async () => {
      sends++;
      return { state: "admitted", receiptID: "receipt", channel: "host" };
    }),
  ).rejects.toMatchObject({ code: "not_found" });
  expect(sends).toBe(0);
  expect(db.query("SELECT state FROM operations").all()).toEqual([
    { state: "pending" },
  ]);
  expect(db.query("SELECT * FROM operation_audit").all()).toHaveLength(1);
  // Legacy callers missing the required runtime adapter fail closed, never noop.
  const absent = new Operations(
    persistence,
    auth,
    () => 1000,
    undefined as never,
  );
  await expect(
    absent.enqueue({ ...request, idempotencyKey: "absent-port" }),
  ).rejects.toMatchObject({ code: "unavailable" });
  const asynchronous = new Operations(persistence, auth, () => 1000, {
    assertAvailable: () => Promise.resolve(),
  });
  await expect(
    asynchronous.enqueue({ ...request, idempotencyKey: "async-port" }),
  ).rejects.toMatchObject({ code: "unavailable" });
  for (const blocked of [absent, asynchronous]) {
    await expect(
      blocked.dispatch(principal, lease, 1, async () => {
        sends++;
        return { state: "admitted", receiptID: "receipt", channel: "host" };
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
  }
  db.exec("DROP TABLE session_tombstones"); // Synthetic fixture only: missing migration must fail closed.
  await expect(
    operations.enqueue({ ...request, idempotencyKey: "absent-table" }),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(db.query("SELECT * FROM operations").all()).toHaveLength(1);
  expect(db.query("SELECT * FROM operation_audit").all()).toHaveLength(1);
  expect(sends).toBe(0);
  db.close();
});

test("atomic root-only cleanup blocks pending, preserves admitted states, rolls back and survives reopen", async () => {
  const file = fileFixture();
  let storage = file.storage;
  let db = storage.transaction((sql) => sql);
  expect(storage.version).toBe(4);
  db.exec(
    "CREATE TABLE plugin_content(session_id TEXT PRIMARY KEY, payload TEXT)",
  );
  const ref: SessionRef = {
    version: 1,
    instanceID: "i",
    projectID: "p",
    sessionID: "root",
  };
  const states = ["pending", "dispatching", "admitted", "unknown_outcome"];
  for (const [index, state] of states.entries()) {
    db.query(
      "INSERT INTO operations(operation_id,caller_scope,owner_json,idempotency_key,payload_hash,target_json,capability,payload_json,state) VALUES (?,'caller','{}',?,'hash',?,'discover','\"private\"',?)",
    ).run(String(index), String(index), canonical(ref), state);
    db.query("INSERT INTO operation_outbox(operation_id) VALUES (?)").run(
      String(index),
    );
    db.query(
      "INSERT INTO operation_audit(operation_id,state,created_at) VALUES (?,?,0)",
    ).run(String(index), state);
  }
  db.query(
    "INSERT INTO operations(operation_id,caller_scope,owner_json,idempotency_key,payload_hash,target_json,capability,payload_json,state) VALUES ('child','caller','{}','child','hash',?,'discover','\"child-private\"','pending')",
  ).run(canonical({ ...ref, sessionID: "child" }));
  db.exec(
    "UPDATE operations SET receipt_id='native-receipt',channel='native-channel' WHERE operation_id='2'",
  );
  // Unrelated corrupted target cannot cause cleanup of the valid target to fail.
  db.exec(
    "INSERT INTO operations(operation_id,caller_scope,owner_json,idempotency_key,payload_hash,target_json,capability,payload_json,state) VALUES ('corrupt','caller','{}','corrupt','hash','not-json','discover','null','pending')",
  );
  db.exec(
    "INSERT INTO plugin_content VALUES ('root','private'),('child','child-private')",
  );
  const make = (cleanup: RemovedSessionCleanupPort) =>
    new ReconciliationService(
      storage,
      { current: async () => ({ kind: "session", session: ref }) },
      {
        authorize: async () => {
          throwIfDenied();
        },
      },
      { get: async () => null },
      cleanup,
      () => 42,
    );
  let denied = false;
  function throwIfDenied() {
    if (denied) throw new DomainError("forbidden");
  }
  const failing = make({
    cleanup: () => {
      throw new Error("adapter unavailable");
    },
  });
  await expect(failing.missing(ref)).rejects.toBeInstanceOf(DomainError);
  expect(db.query("SELECT * FROM session_tombstones").all()).toHaveLength(0);
  expect(
    db
      .query<{ state: string }, []>(
        "SELECT state FROM operations WHERE operation_id='0'",
      )
      .get()?.state,
  ).toBe("pending");
  const cleanup: RemovedSessionCleanupPort = {
    cleanup(sql, target) {
      expect(sql.inTransaction).toBe(true);
      sql
        .query("DELETE FROM plugin_content WHERE session_id=?")
        .run(target.sessionID);
    },
  };
  denied = true;
  await expect(make(cleanup).missing(ref)).rejects.toBeInstanceOf(DomainError);
  expect(db.query("SELECT * FROM session_tombstones").all()).toHaveLength(0);
  denied = false;
  await make(cleanup).missing(ref);
  expect(
    db
      .query(
        "SELECT state FROM operations WHERE operation_id IN ('0','1','2','3') ORDER BY operation_id",
      )
      .all(),
  ).toEqual(
    ["rejected", "dispatching", "admitted", "unknown_outcome"].map((state) => ({
      state,
    })),
  );
  expect(
    db
      .query(
        "SELECT payload_json FROM operations WHERE operation_id IN ('0','1','2','3')",
      )
      .all(),
  ).toEqual(states.map(() => ({ payload_json: "null" })));
  expect(db.query("SELECT * FROM plugin_content").all()).toEqual([
    { session_id: "child", payload: "child-private" },
  ]);
  expect(
    db
      .query(
        "SELECT payload_hash,receipt_id,channel,state FROM operations WHERE operation_id='2'",
      )
      .get(),
  ).toEqual({
    payload_hash: "hash",
    receipt_id: "native-receipt",
    channel: "native-channel",
    state: "admitted",
  });
  expect(
    db
      .query(
        "SELECT state,payload_json FROM operations WHERE operation_id='child'",
      )
      .get(),
  ).toEqual({ state: "pending", payload_json: '"child-private"' });
  storage = file.reopen();
  db = storage.transaction((sql) => sql);
  await make({
    cleanup: () => {
      throw new Error("must not repeat");
    },
  }).missing(ref);
  expect(db.query("SELECT * FROM session_tombstones").all()).toHaveLength(1);
  expect(db.query("SELECT * FROM session_removal_audit").all()).toEqual([
    { instance_id: "i", session_id: "root", project_id: "p", removed_at: 42 },
  ]);
  expect(db.query("SELECT * FROM operation_audit").all()).toHaveLength(5);
});

test("migration descriptors compose and reject bad versions without auto-migration", () => {
  for (const version of [0, 1, -1, Number.NaN, 2.5])
    expect(() => reconciliationMigrationAt(version)).toThrow(DomainError);
  const f = fileFixture();
  f.storage.close();
  expect(() =>
    openPersistence({
      ...f.options,
      migrations: [
        { version: 2, ...GRANTS_MIGRATION },
        operationMigrationAt(3),
        reconciliationMigrationAt(5),
      ],
    }),
  ).toThrow(DomainError);
  expect(() =>
    openPersistence({
      ...f.options,
      migrations: f.options.migrations.slice(0, 2),
    }),
  ).toThrow(DomainError);
});

test("DiscoveryService composes with real reconciliation for GET 404 without host DELETE", async () => {
  const f = fileFixture();
  const ref: SessionRef = {
    version: 1,
    instanceID: "i",
    projectID: "p",
    sessionID: "root",
  };
  const identity = {
    current: async () => ({ kind: "session" as const, session: ref }),
  };
  const authorization = { authorize: async () => {} };
  let gets = 0;
  const host = {
    get: async () => {
      gets++;
      return null;
    },
    candidates: async () => [ref],
    links: async () => [],
  };
  const reconciliation = new ReconciliationService(
    f.storage,
    identity,
    authorization,
    host,
    { cleanup() {} },
    () => 42,
  );
  const discovery = new DiscoveryService(
    identity,
    authorization,
    host,
    reconciliation,
  );
  await expect(discovery.get(ref)).rejects.toMatchObject({ code: "not_found" });
  expect(gets).toBe(2);
  expect(Object.keys(host)).not.toContain("delete");
  expect(
    f.storage.transaction((db) =>
      db.query("SELECT * FROM session_tombstones").all(),
    ),
  ).toEqual([
    { instance_id: "i", session_id: "root", project_id: "p", removed_at: 42 },
  ]);
});
