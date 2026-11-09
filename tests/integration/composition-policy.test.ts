import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthorizationSnapshot,
  Authorizer,
} from "../../src/authorization/authorize";
import { GRANTS_MIGRATION, Grants } from "../../src/authorization/grants";
import { InvocationIdentity } from "../../src/composition/identity";
import {
  CanonicalPolicy,
  POLICY_MIGRATION,
} from "../../src/composition/policy";
import {
  canonical,
  type Principal,
  type SessionRef,
} from "../../src/contracts";
import {
  openPersistence,
  type Persistence,
} from "../../src/persistence/database";
import {
  Operations,
  operationMigrationAt,
  pendingGrantOperations,
} from "../../src/persistence/operations";

// Disposable fixtures only. Local versions 2/3/4 do NOT assert the global v21 lineage.
const opened: Persistence[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
const target: SessionRef = {
  version: 1,
  instanceID: "fixture",
  projectID: "p",
  sessionID: "target",
};
const session: Principal = {
  kind: "session",
  session: { ...target, sessionID: "source" },
};
const operator: Principal = {
  kind: "operator",
  instanceID: "fixture",
  operatorID: "fixture-operator",
  revision: 1,
};
function snapshot(): AuthorizationSnapshot {
  return {
    revision: 1,
    profile: "manage",
    profileCapabilities: [
      "discover",
      "message",
      "read",
      "manage",
      "schedule.manage",
    ],
    policyCapabilities: [
      "discover",
      "message",
      "read",
      "manage",
      "schedule.manage",
    ],
    hostCapabilities: [
      "discover",
      "message",
      "read",
      "manage",
      "schedule.manage",
    ],
    deniedCapabilities: [],
    grants: [],
    operator: {
      operatorID: "fixture-operator",
      instanceID: "fixture",
      revision: 1,
      capabilities: ["manage", "message"],
      projects: ["p"],
      expiresAt: null,
    },
    delegationCapabilities: ["message"],
    approval: null,
  };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "composition-policy-"));
  const repositoryPath = join(root, "repo");
  mkdirSync(repositoryPath);
  const path = join(root, "fixture.sqlite");
  writeFileSync(path, "", { mode: 0o600 });
  const stat = statSync(path);
  const options = {
    repositoryPath,
    claims: [
      {
        instanceID: "fixture",
        scopeID: "fixture-scope",
        installationID: "fixture-installation",
        canonicalPath: realpathSync(path),
        databaseIdentity: `${stat.dev}:${stat.ino}`,
      },
    ],
    migrations: [
      { version: 2, ...GRANTS_MIGRATION },
      operationMigrationAt(3),
      { version: 4, ...POLICY_MIGRATION },
    ],
  };
  const storage = openPersistence(options);
  opened.push(storage);
  let current: Principal | null = session;
  const identity = { current: async () => current };
  const policy = new CanonicalPolicy(storage, "fixture", identity, () => 1000);
  const auth = new Authorizer(identity, policy, () => 1000);
  const seed = (p: Principal, s = snapshot(), t = target) =>
    storage.transaction((sql) => {
      sql
        .query(
          "INSERT OR REPLACE INTO composition_policies VALUES (?,?,?,?,?,?)",
        )
        .run(
          t.instanceID,
          t.projectID,
          t.sessionID,
          canonical(p),
          s.revision,
          JSON.stringify(s),
        );
    });
  return {
    options,
    storage,
    policy,
    auth,
    identity,
    seed,
    current: (p: Principal | null) => {
      current = p;
    },
  };
}
test("fixture only: absent policy grants only minimal same-project discovery/message", async () => {
  const f = fixture();
  await f.auth.authorize(session, target, "message");
  await expect(f.auth.authorize(session, target, "read")).rejects.toThrow(
    "forbidden",
  );
  await expect(
    f.auth.authorize(session, { ...target, projectID: "foreign" }, "message"),
  ).rejects.toThrow("not_found");
  await expect(
    f.auth.authorize({ ...session }, target, "message"),
  ).rejects.toThrow("forbidden");
  f.current(operator);
  await expect(f.auth.authorize(operator, target, "manage")).rejects.toThrow(
    "forbidden",
  );
});
test("fixture only: grant/profile/host/deny and stale revision remain T11 authority", async () => {
  const f = fixture();
  f.seed(session);
  await expect(f.auth.authorize(session, target, "read")).rejects.toThrow(
    "forbidden",
  );
  for (const override of [
    { profile: "observe" as const },
    { hostCapabilities: [] },
    { deniedCapabilities: ["message" as const] },
  ]) {
    f.seed(session, { ...snapshot(), ...override });
    await expect(f.auth.authorize(session, target, "message")).rejects.toThrow(
      "forbidden",
    );
  }
  f.seed(session);
  await expect(
    f.auth.admit(session, target, "message", 0, () => {}),
  ).rejects.toThrow("conflict");
});
test("fixture only: once reservation rolls back with local admission, persists restart and consumes once", async () => {
  const f = fixture();
  const s = snapshot();
  s.profile = "supervised";
  s.approval = {
    principal: session,
    target,
    capability: "message",
    revision: 1,
    expiresAt: "2030-01-01T00:00:00.000Z",
    mode: "once",
  };
  f.seed(session, s);
  await expect(
    f.auth.authorizeIntent(
      session,
      target,
      "message",
      1,
      "operation-one",
      () => {
        throw new Error("rollback");
      },
    ),
  ).rejects.toThrow("unavailable");
  expect(
    (await f.policy.read(session, target)).approval?.operationID,
  ).toBeUndefined();
  await f.auth.authorizeIntent(
    session,
    target,
    "message",
    1,
    "operation-one",
    () => 1,
  );
  const second = openPersistence(f.options);
  opened.push(second);
  const otherPolicy = new CanonicalPolicy(
    second,
    "fixture",
    f.identity,
    () => 1000,
  );
  expect((await otherPolicy.read(session, target)).approval?.operationID).toBe(
    "operation-one",
  );
  const other = new Authorizer(f.identity, otherPolicy, () => 1000);
  await expect(
    other.admitOperation(session, target, "message", 1, "wrong", () => 1),
  ).rejects.toThrow("forbidden");
  await other.admitOperation(
    session,
    target,
    "message",
    1,
    "operation-one",
    () => 1,
  );
  await expect(
    f.auth.admitOperation(
      session,
      target,
      "message",
      1,
      "operation-one",
      () => 1,
    ),
  ).rejects.toThrow("forbidden");
  expect((await f.policy.read(session, target)).approval).toBeNull();
});
test("fixture only: complete scheduled and delegated approval metadata survives persistence", async () => {
  const f = fixture();
  const approval = {
    principal: session,
    target,
    capability: "message" as const,
    revision: 1,
    expiresAt: "2030-01-01T00:00:00.000Z",
    mode: "once" as const,
    operationID: "operation-one",
  };
  for (const extra of [
    {
      scheduled: {
        modality: "scheduled-message" as const,
        occurrence: { jobID: "j", scheduleRevision: 2, occurrenceID: "o" },
      },
    },
    {
      delegation: {
        requested: ["message" as const],
        requiredCapabilities: ["read" as const],
      },
    },
  ]) {
    f.seed(session, { ...snapshot(), approval: { ...approval, ...extra } });
    f.policy.admission(session, target, (s) => {
      expect(s.approval).toEqual({ ...approval, ...extra });
    });
    expect((await f.policy.read(session, target)).approval).toEqual({
      ...approval,
      ...extra,
    });
  }
  f.seed(session, {
    ...snapshot(),
    approval: {
      ...approval,
      scheduled: {
        modality: "scheduled-message",
        occurrence: { jobID: "j", scheduleRevision: -1, occurrenceID: "o" },
      },
    },
  });
  await expect(f.policy.read(session, target)).rejects.toThrow("unavailable");
});
test("fixture only: operator-only CAS writes and self-policy replacement are atomic", async () => {
  const f = fixture();
  f.seed(operator);
  f.seed(session);
  await expect(
    f.policy.write(session, target, session, 1, {
      ...snapshot(),
      revision: 2,
    }),
  ).rejects.toThrow("forbidden");
  f.current(operator);
  await f.policy.write(operator, target, session, 1, {
    ...snapshot(),
    revision: 2,
    deniedCapabilities: ["message"],
  });
  expect((await f.policy.read(session, target)).revision).toBe(2);
  await expect(
    f.policy.write(operator, target, session, 1, {
      ...snapshot(),
      revision: 2,
    }),
  ).rejects.toThrow("conflict");
  await f.policy.write(operator, target, operator, 1, {
    ...snapshot(),
    revision: 2,
  });
  expect((await f.policy.read(operator, target)).revision).toBe(2);
});
test("fixture only: canonical guard rejects foreign connection and replaced DB identity", async () => {
  const f = fixture();
  const other = fixture();
  expect(() =>
    other.storage.transaction((sql) => f.policy.load(sql, session, target)),
  ).toThrow("unavailable");
  f.storage.transaction((sql) => {
    sql.query("UPDATE ownership SET instance_id='foreign'").run();
  });
  await expect(f.policy.read(session, target)).rejects.toThrow("unavailable");
});
test("fixture only: real Grants adapter persists once consumption on canonical database", async () => {
  const f = fixture();
  f.current(operator);
  f.seed(operator, {
    ...snapshot(),
    profile: "supervised",
    approval: {
      principal: operator,
      target,
      capability: "manage",
      revision: 1,
      expiresAt: "2030-01-01T00:00:00.000Z",
      mode: "once",
    },
  });
  const grants = new Grants(
    f.storage,
    f.identity,
    f.policy,
    pendingGrantOperations(() => 1000),
    () => 1000,
  );
  await grants.link({
    source: session.kind === "session" ? session.session : target,
    target,
    capabilities: ["read"],
    expiresAt: null,
    policyRevision: 1,
    grantRevision: 0,
  });
  expect((await f.policy.read(operator, target)).approval).toBeNull();
  f.current(session);
  f.seed(session, {
    ...snapshot(),
    delegationCapabilities: ["message", "read"],
  });
  await f.auth.authorize(session, target, "read");
});
test("fixture only: host identity composes with T11 without authenticating equivalent payload principal", async () => {
  const f = fixture();
  const identity = new InvocationIdentity(
    "fixture",
    { resolve: async (c) => ({ ...target, sessionID: c.sessionID }) },
    { current: async () => null },
  );
  const auth = new Authorizer(identity, f.policy, () => 1000);
  await identity.runWithHostContext(
    { sessionID: "source" },
    async (principal) => {
      await auth.authorize(principal, target, "message");
      await expect(auth.authorize(session, target, "message")).rejects.toThrow(
        "forbidden",
      );
    },
  );
});

test("fixture only: Operations shares durable reservation/admission transaction with policy", async () => {
  const f = fixture();
  const s = snapshot();
  s.profile = "supervised";
  s.approval = {
    principal: session,
    target,
    capability: "message",
    revision: 1,
    expiresAt: "2030-01-01T00:00:00.000Z",
    mode: "once",
  };
  f.seed(session, s);
  const operations = new Operations(f.storage, f.auth, () => 1000, {
    assertAvailable() {},
  });
  const request = {
    principal: session,
    target,
    capability: "message" as const,
    expectedRevision: 1,
    idempotencyKey: "fixture-operation",
    payload: { content: "PUBLIC-FIXTURE" },
  };
  const queued = await operations.enqueue(request);
  expect((await f.policy.read(session, target)).approval?.operationID).toBe(
    queued.operationID,
  );
  f.storage.transaction((sql) =>
    sql.exec(
      "CREATE TRIGGER fixture_fail_policy BEFORE UPDATE ON composition_policies BEGIN SELECT RAISE(ABORT,'fixture'); END",
    ),
  );
  let hostCalls = 0;
  const lease = operations.claim(queued.operationID, "fixture-worker", 100);
  await expect(
    operations.dispatch(session, lease, 1, async () => {
      hostCalls++;
      return {
        state: "admitted",
        receiptID: "fixture-receipt",
        channel: "host",
      };
    }),
  ).rejects.toThrow("unavailable");
  expect(hostCalls).toBe(0);
  expect((await f.policy.read(session, target)).approval?.operationID).toBe(
    queued.operationID,
  );
  expect(
    f.storage.transaction(
      (sql) =>
        sql
          .query<{ state: string }, [string]>(
            "SELECT state FROM operations WHERE operation_id=?",
          )
          .get(queued.operationID)?.state,
    ),
  ).toBe("pending");
  f.storage.transaction((sql) => sql.exec("DROP TRIGGER fixture_fail_policy"));
  await operations.dispatch(session, lease, 1, async () => {
    hostCalls++;
    return { state: "admitted", receiptID: "fixture-receipt", channel: "host" };
  });
  expect(hostCalls).toBe(1);
  expect((await f.policy.read(session, target)).approval).toBeNull();
  expect((await operations.enqueue(request)).operationID).toBe(
    queued.operationID,
  );
  expect(hostCalls).toBe(1);
});

test("fixture only: separate authority and subject revisions permit initial policy creation without bootstrap fallback", async () => {
  const f = fixture();
  f.seed(operator);
  f.current(operator);
  await f.policy.write(operator, target, session, 0, snapshot(), 1);
  await f.policy.write(
    operator,
    target,
    session,
    1,
    { ...snapshot(), revision: 2 },
    1,
  );
  await f.policy.write(
    operator,
    target,
    session,
    2,
    { ...snapshot(), revision: 3 },
    1,
  );
  expect((await f.policy.read(session, target)).revision).toBe(3);
});

test("fixture only: unknown approval metadata is rejected, never stripped on load/save", async () => {
  const f = fixture();
  f.seed(session, {
    ...snapshot(),
    approval: {
      principal: session,
      target,
      capability: "message",
      revision: 1,
      expiresAt: "2030-01-01T00:00:00.000Z",
      mode: "once",
      operationID: "fixture-op",
      scheduled: {
        modality: "scheduled-message",
        occurrence: {
          jobID: "job",
          scheduleRevision: 1,
          occurrenceID: "occurrence",
        },
      },
    },
  });
  const original = await f.policy.read(session, target);
  expect(() =>
    f.policy.admission(session, target, (s) => {
      Object.assign(s.approval?.scheduled ?? {}, {
        unrecognizedAuthority: true,
      });
    }),
  ).toThrow("unavailable");
  expect((await f.policy.read(session, target)).approval).toEqual(
    original.approval,
  );
  f.storage.transaction((sql) =>
    sql
      .query(
        "UPDATE composition_policies SET body=json_set(body,'$.approval.scheduled.extra',true)",
      )
      .run(),
  );
  await expect(f.policy.read(session, target)).rejects.toThrow("unavailable");
});

test("fixture only: canonical scope drift is rejected even when instance remains the same", async () => {
  const f = fixture();
  f.storage.transaction((sql) =>
    sql.query("UPDATE ownership SET scope_id='foreign-scope'").run(),
  );
  await expect(f.policy.read(session, target)).rejects.toThrow("unavailable");
});
