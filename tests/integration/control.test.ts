import type { Database } from "bun:sqlite";
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
  capabilities,
  DomainError,
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
} from "../../src/persistence/operations";
import {
  type ControlCommand,
  type ControlObservation,
  controlMigration,
  SessionControls,
} from "../../src/sessions/control";

const roots: string[] = [];
const stores: Persistence[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "control-"));
  roots.push(root);
  const path = join(root, "synthetic.sqlite");
  const repositoryPath = join(root, "repo");
  mkdirSync(repositoryPath);
  writeFileSync(path, "", { mode: 0o600 });
  const stat = statSync(path);
  const persistence = openPersistence({
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
      operationMigrationAt(2),
      { version: 3, apply: (sql) => sql.exec(controlMigration.sql) },
    ],
  });
  stores.push(persistence);
  const sqlHandle = persistence.transaction((sql) => sql);
  persistence.transaction((sql) => {
    sql.exec(
      "CREATE TABLE fixture_jobs(enabled INTEGER NOT NULL); INSERT INTO fixture_jobs VALUES (1); CREATE TABLE fixture_gate(archived INTEGER NOT NULL); INSERT INTO fixture_gate VALUES (0)",
    );
  });
  const target: SessionRef = {
    version: 1,
    instanceID: "i",
    projectID: "p",
    sessionID: "target",
  };
  let actor: Principal = {
    kind: "operator",
    instanceID: "i",
    operatorID: "operator",
    revision: 1,
  };
  const identity = { current: async () => actor };
  const snapshot: AuthorizationSnapshot = {
    revision: 1,
    profile: "manage",
    profileCapabilities: capabilities,
    policyCapabilities: capabilities,
    hostCapabilities: capabilities,
    deniedCapabilities: [],
    grants: [],
    operator: {
      instanceID: "i",
      operatorID: "operator",
      revision: 1,
      capabilities,
      projects: ["p"],
      expiresAt: null,
    },
    delegationCapabilities: null,
    approval: null,
  };
  const auth = new Authorizer(
    identity,
    {
      read: async () => snapshot,
      admission: (_actor, _ref, check) =>
        persistence.transaction(() => check(snapshot)),
    },
    () => 1000,
  );
  // Isolated fixture without reconciliation, NOT production wiring. When T18
  // adds mandatory RemovedTargetPort, pass { assertAvailable: () => {} } here.
  const operations = new Operations(persistence, auth, () => 1000, {
    assertAvailable() {},
  }); // Isolated fixture, NOT production wiring.
  let calls = 0;
  let archived = false;
  let restored = false;
  let profileSaveFailure = false;
  let validate = async (_cmd: ControlCommand) => {};
  let execute = async (cmd: ControlCommand): Promise<ControlObservation> => {
    switch (cmd.action) {
      case "rename":
        return { action: "rename", title: "observed title" };
      case "model":
      case "agent":
      case "style":
        return { ...cmd, appliesTo: "future_executions" };
      case "archive":
        return { action: "archive", archived: true };
      case "restore":
        return { action: "restore", archived: false };
      case "interrupt":
        return { action: "interrupt", requested: true, interrupted: false };
      case "compact":
        return { action: "compact", status: "admitted" };
      case "profile":
        throw new Error("profile must never reach host");
      case "reset":
        return {
          action: "reset",
          successor: { ...target, sessionID: "successor" },
        };
    }
  };
  const service = new SessionControls(
    persistence,
    identity,
    auth,
    operations,
    {
      validate: async (_ref, cmd) => validate(cmd),
      execute: async (_ref, cmd) => {
        calls++;
        expect(sqlHandle.inTransaction).toBe(false);
        return execute(cmd);
      },
    },
    {
      archive: (sql) => {
        expect(sql.inTransaction).toBe(true);
        sql.exec(
          "UPDATE fixture_jobs SET enabled=0; UPDATE fixture_gate SET archived=1",
        );
        archived = true;
      },
      restore: (sql) => {
        expect(sql.inTransaction).toBe(true);
        sql.exec("UPDATE fixture_gate SET archived=0");
        restored = true;
      },
    },
    {
      ceiling: (sql) => {
        expect(sql.inTransaction).toBe(true);
        return {
          capabilities: ["read", "manage", "message"],
          limits: { concurrency: 2 },
        };
      },
      save: (sql, _target, selection) => {
        expect(sql.inTransaction).toBe(true);
        sql.exec(
          "CREATE TABLE IF NOT EXISTS fixture_profile(selection_json TEXT NOT NULL)",
        );
        sql
          .query("INSERT INTO fixture_profile VALUES (?)")
          .run(JSON.stringify(selection));
        if (profileSaveFailure) throw new Error("SENSITIVE_PROFILE_FAILURE");
      },
    },
  );
  const apply = (
    command: ControlCommand,
    idempotencyKey = "key",
    expectedRevision = 1,
  ) => service.apply({ target, command, idempotencyKey, expectedRevision });
  return {
    apply,
    snapshot,
    target,
    persistence,
    service,
    failProfileSave: (fail: boolean) => {
      profileSaveFailure = fail;
    },
    calls: () => calls,
    archived: () => archived,
    restored: () => restored,
    execute: (fn: typeof execute) => {
      execute = fn;
    },
    validate: (fn: typeof validate) => {
      validate = fn;
    },
    session: () => {
      actor = { kind: "session", session: target };
    },
  };
}

test("rename returns observed title and replay preserves operation ID without resend", async () => {
  const f = fixture();
  const cmd = { action: "rename", title: "requested" } as const;
  const first = await f.apply(cmd);
  expect(first.observation).toEqual({
    action: "rename",
    title: "observed title",
  });
  expect(await f.apply(cmd)).toEqual(first);
  expect(f.calls()).toBe(1);
  await expect(
    f.apply({ action: "rename", title: "different" }),
  ).rejects.toThrow("conflict");
});
test("configuration applies only to future runs and invalid catalog selection has no effect", async () => {
  const f = fixture();
  for (const cmd of [
    { action: "model", providerID: "fixture", modelID: "model" },
    { action: "agent", agent: "fixture" },
    { action: "style", style: "concise" },
  ] as const) {
    const result = await f.apply(cmd, cmd.action);
    expect(result.observation).toEqual({
      ...cmd,
      appliesTo: "future_executions",
    });
  }
  f.validate(async () => {
    throw new Error("invalid model");
  });
  await expect(
    f.apply({ action: "model", providerID: "bad", modelID: "bad" }, "bad"),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(f.calls()).toBe(3);
});
test("self configuration and observe profile fail closed", async () => {
  const f = fixture();
  f.session();
  await expect(
    f.apply({ action: "agent", agent: "elevated" }),
  ).rejects.toThrow();
  f.snapshot.profile = "observe";
  await expect(
    f.apply({ action: "rename", title: "denied" }),
  ).rejects.toThrow();
  expect(f.calls()).toBe(0);
});
test("revision/policy change between validation and admission prevents host effect", async () => {
  const f = fixture();
  f.validate(async () => {
    f.snapshot.revision = 2;
  });
  await expect(f.apply({ action: "interrupt" })).rejects.toThrow("conflict");
  expect(f.calls()).toBe(0);
});
test("archive and restore invoke same-DB local scheduling gate", async () => {
  const f = fixture();
  await f.apply({ action: "archive" });
  expect(f.archived()).toBe(true);
  await f.apply({ action: "restore" }, "restore");
  expect(f.restored()).toBe(true);
  expect(
    f.persistence.transaction((sql) =>
      sql.query("SELECT enabled FROM fixture_jobs").get(),
    ),
  ).toEqual({ enabled: 0 });
  expect(
    f.persistence.transaction((sql) =>
      sql.query("SELECT archived FROM fixture_gate").get(),
    ),
  ).toEqual({ archived: 0 });
});
test("interrupt request is not interruption and compact admission is not completion", async () => {
  const f = fixture();
  expect((await f.apply({ action: "interrupt" })).observation).toEqual({
    action: "interrupt",
    requested: true,
    interrupted: false,
  });
  expect((await f.apply({ action: "compact" }, "compact")).observation).toEqual(
    { action: "compact", status: "admitted" },
  );
});
test("reset requires distinct successor and transfers only explicit configuration", async () => {
  const f = fixture();
  f.validate(async (cmd) => {
    expect(cmd).toEqual({ action: "reset", transfer: ["model"] });
  });
  expect(
    (await f.apply({ action: "reset", transfer: ["model"] })).observation,
  ).toEqual({
    action: "reset",
    successor: { ...f.target, sessionID: "successor" },
  });
  f.validate(async () => {});
  f.execute(async () => ({ action: "reset", successor: f.target }));
  expect(
    (await f.apply({ action: "reset", transfer: [] }, "same-id")).operation
      .state,
  ).toBe("unknown_outcome");
});
test("lost result and malformed native observation stay uncertain with no blind retry", async () => {
  const f = fixture();
  f.execute(async () => {
    throw new Error("lost response");
  });
  const cmd = { action: "compact" } as const;
  const result = await f.apply(cmd);
  expect(result.operation.state).toBe("unknown_outcome");
  expect(await f.apply(cmd)).toEqual(result);
  expect(f.calls()).toBe(1);
});
test("operator profile persists effective ceiling and limits without host effect or grants", async () => {
  const f = fixture();
  const result = await f.apply({ action: "profile", profile: "observe" });
  expect(result.observation).toEqual({
    action: "profile",
    profile: "observe",
    capabilities: ["read"],
    limits: { concurrency: 2 },
  });
  expect(
    f.persistence.transaction((sql) =>
      sql.query("SELECT * FROM fixture_profile").all(),
    ),
  ).toHaveLength(1);
  expect(f.snapshot.grants).toEqual([]);
  expect(f.calls()).toBe(0);
  f.session();
  await expect(
    f.apply({ action: "profile", profile: "manage" }, "session-profile"),
  ).rejects.toThrow("forbidden");
});

test("supervised pending approval does not reach host and policy denial wins", async () => {
  const f = fixture();
  f.snapshot.profile = "supervised";
  await expect(f.apply({ action: "interrupt" })).rejects.toThrow("forbidden");
  expect(f.calls()).toBe(0);
  f.snapshot.profile = "manage";
  f.validate(async () => {
    f.snapshot.deniedCapabilities = ["manage"];
  });
  await expect(f.apply({ action: "archive" }, "revoked")).rejects.toThrow(
    "forbidden",
  );
  expect(f.calls()).toBe(0);
});

test("native wrong action is not accepted as a completed control", async () => {
  const f = fixture();
  f.execute(async () => ({ action: "restore", archived: false }));
  const result = await f.apply({ action: "archive" });
  expect(result.operation.state).toBe("unknown_outcome");
  expect(result.observation).toBeNull();
  expect(f.archived()).toBe(false);
});

test("invalid commands, empty configuration and forbidden reset transfers are rejected", async () => {
  const f = fixture();
  for (const cmd of [
    { action: "delete" },
    { action: "model", providerID: "", modelID: "model" },
    { action: "reset", transfer: ["grants"] },
    { action: "reset", transfer: ["model", "model"] },
  ]) {
    await expect(f.apply(JSON.parse(JSON.stringify(cmd)))).rejects.toThrow(
      "invalid_input",
    );
  }
  expect(f.calls()).toBe(0);
});

test("concurrent same-key callers produce at most one host effect", async () => {
  const f = fixture();
  const results = await Promise.allSettled([
    f.apply({ action: "rename", title: "requested" }),
    f.apply({ action: "rename", title: "requested" }),
  ]);
  expect(results.some((result) => result.status === "fulfilled")).toBe(true);
  expect(f.calls()).toBe(1);
});

test("raw validation errors are sanitized while DomainError codes are preserved", async () => {
  const f = fixture();
  f.validate(async () => {
    throw new Error("SENSITIVE_VALIDATION_STRING");
  });
  const error = await f
    .apply({ action: "compact" })
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(DomainError);
  expect(error).toMatchObject({ code: "unavailable" });
  expect(String(error)).not.toContain("SENSITIVE_VALIDATION_STRING");
  const domain = new DomainError("invalid_input");
  f.validate(async () => {
    throw domain;
  });
  await expect(f.apply({ action: "compact" })).rejects.toBe(domain);
  expect(f.calls()).toBe(0);
});

test("null and undefined requests are invalid input", async () => {
  const f = fixture();
  for (const input of [null, undefined]) {
    // Exercise the runtime boundary despite the typed caller contract.
    // @ts-expect-error deliberately malformed request
    await expect(f.service.apply(input)).rejects.toMatchObject({
      code: "invalid_input",
    });
  }
  expect(f.calls()).toBe(0);
});

test("local profile save rollback yields rejected receipt, replay and new-key retry", async () => {
  const f = fixture();
  f.persistence.transaction((sql) =>
    sql.exec("CREATE TABLE fixture_profile(selection_json TEXT NOT NULL)"),
  );
  f.failProfileSave(true);
  const cmd = { action: "profile", profile: "observe" } as const;
  const result = await f.apply(cmd);
  expect(result.operation.state).toBe("rejected");
  expect(result.observation).toBeNull();
  expect(
    f.persistence.transaction((sql) =>
      sql.query("SELECT * FROM fixture_profile").all(),
    ),
  ).toEqual([]);
  expect(
    f.persistence.transaction((sql) =>
      sql.query("SELECT * FROM session_control_results").all(),
    ),
  ).toEqual([]);
  f.failProfileSave(false);
  expect(await f.apply(cmd)).toEqual(result);
  expect((await f.apply(cmd, "new-profile-attempt")).operation.state).toBe(
    "admitted",
  );
  expect(
    f.persistence.transaction((sql) =>
      sql.query("SELECT * FROM fixture_profile").all(),
    ),
  ).toHaveLength(1);
  expect(f.calls()).toBe(0);
});

test("uncertain profile commit stays unknown and replay never retries save", async () => {
  const f = fixture();
  f.persistence.transaction((sql) =>
    sql.exec("CREATE TABLE fixture_profile(selection_json TEXT NOT NULL)"),
  );
  const transaction = f.persistence.transaction.bind(f.persistence);
  let armed = true;
  // Simulate an adapter losing commit acknowledgement after the write committed.
  f.persistence.transaction = <T>(write: (sql: Database) => T): T => {
    const value = transaction(write);
    if (
      armed &&
      transaction((sql) => sql.query("SELECT * FROM fixture_profile").all())
        .length > 0
    ) {
      armed = false;
      throw new DomainError("unavailable");
    }
    return value;
  };
  const cmd = { action: "profile", profile: "observe" } as const;
  const result = await f.apply(cmd);
  expect(result.operation.state).toBe("unknown_outcome");
  expect(await f.apply(cmd)).toEqual(result);
  expect(
    transaction((sql) => sql.query("SELECT * FROM fixture_profile").all()),
  ).toHaveLength(1);
  expect(f.calls()).toBe(0);
});
