import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { canonical, DomainError, type SessionRef } from "../../src/contracts";
import { Persistence } from "../../src/persistence/database";
import { operationsMigration } from "../../src/persistence/operations";
import {
  ReconciliationService,
  type RemovedSessionCleanupPort,
  reconciliationMigration,
  removedTargetPort,
} from "../../src/sessions/reconcile";

const ref: SessionRef = {
  version: 1,
  instanceID: "i",
  projectID: "p",
  sessionID: "root",
};
function fixture() {
  const db = new Database(":memory:");
  db.exec(operationsMigration.sql);
  db.exec(reconciliationMigration.sql);
  const persistence = new Persistence(db, () => {});
  let result: object | null = null;
  let failure: unknown;
  let calls = 0;
  const host = {
    get: async () => {
      calls++;
      if (failure) throw failure;
      return result;
    },
  };
  const identity = {
    current: async () => ({ kind: "session" as const, session: ref }),
  };
  const authorization = { authorize: async () => {} };
  const cleanup = { cleanup: () => {} };
  const service = (adapter: RemovedSessionCleanupPort = cleanup, now = 10) =>
    new ReconciliationService(
      persistence,
      identity,
      authorization,
      host,
      adapter,
      () => now,
    );
  return {
    db,
    service,
    host,
    removed: () =>
      db.query("SELECT * FROM session_tombstones").all().length > 0,
    setFailure: (value: unknown) => {
      failure = value;
    },
    setResult: (value: object) => {
      result = value;
    },
    calls: () => calls,
  };
}
test("confirmed missing is durable and idempotent; synthetic host fixture has only get", async () => {
  const f = fixture();
  await f.service().missing(ref);
  await f.service().missing(ref);
  expect(f.removed()).toBe(true);
  expect(f.db.query("SELECT * FROM session_removal_audit").all()).toHaveLength(
    1,
  );
  expect(Object.keys(f.host)).toEqual(["get"]);
  f.db.close();
});

test("invalid time, absent and async cleanup fail closed without audit or redaction", async () => {
  const f = fixture();
  const encoded = canonical(ref);
  f.db
    .query(
      "INSERT INTO operations(operation_id,caller_scope,owner_json,idempotency_key,payload_hash,target_json,capability,payload_json,state) VALUES ('pending','caller','{}','key','hash',?,'message','\"secret\"','pending')",
    )
    .run(encoded);
  const cases: [RemovedSessionCleanupPort, number][] = [
    [undefined as unknown as RemovedSessionCleanupPort, 10],
    [{ cleanup: () => Promise.resolve() }, 10],
    [{ cleanup() {} }, Number.NaN],
    [{ cleanup() {} }, -1],
    [
      {
        cleanup() {
          throw new DomainError("forbidden");
        },
      },
      10,
    ],
  ];
  for (const [adapter, time] of cases) {
    // Bypass the fixture's default to exercise an actually absent runtime adapter.
    const service =
      adapter === undefined
        ? new ReconciliationService(
            new Persistence(f.db, () => {}),
            { current: async () => ({ kind: "session", session: ref }) },
            { authorize: async () => {} },
            f.host,
            adapter,
            () => time,
          )
        : f.service(adapter, time);
    await expect(service.missing(ref)).rejects.toBeInstanceOf(DomainError);
    expect(f.db.query("SELECT * FROM session_tombstones").all()).toHaveLength(
      0,
    );
    expect(
      f.db.query("SELECT * FROM session_removal_audit").all(),
    ).toHaveLength(0);
    expect(f.db.query("SELECT * FROM operation_audit").all()).toHaveLength(0);
    expect(
      f.db.query("SELECT state,payload_json FROM operations").get(),
    ).toEqual({ state: "pending", payload_json: '"secret"' });
  }
  f.db.close();
});
test("403 and transient failures never become tombstones", async () => {
  const f = fixture();
  for (const error of [new DomainError("forbidden"), new Error("offline")]) {
    f.setFailure(error);
    await expect(f.service().missing(ref)).rejects.toBeInstanceOf(DomainError);
    expect(f.removed()).toBe(false);
  }
  f.db.close();
});
test("existing host object is not removed", async () => {
  const f = fixture();
  f.setResult({});
  await f.service().missing(ref);
  expect(f.removed()).toBe(false);
  f.db.close();
});

test("canonical identity rejects project mismatch without widening scope", async () => {
  const f = fixture();
  await f.service().missing(ref);
  expect(() =>
    f.db.transaction(() =>
      removedTargetPort.assertAvailable(f.db, { ...ref, projectID: "other" }),
    )(),
  ).toThrow(DomainError);
  expect(() =>
    f.db.transaction(() =>
      removedTargetPort.assertAvailable(f.db, { ...ref, instanceID: "other" }),
    )(),
  ).not.toThrow();
  f.db.close();
});
