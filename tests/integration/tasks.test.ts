import { Database } from "bun:sqlite";
import { afterAll, afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { AuthorizationSnapshot } from "../../src/authorization/authorize";
import type { GrantPolicyPort } from "../../src/authorization/grants";
import {
  capabilities,
  DomainError,
  type Grant,
  type Principal,
  type SessionRef,
} from "../../src/contracts";
import { GROUPS_MIGRATION, Groups } from "../../src/groups/service";
import {
  type RunnerAdmissionEvidence,
  type RunnerTaskContext,
  TASKS_MIGRATION,
  type TaskOutcomeEvidence,
  Tasks,
  taskActiveWork,
} from "../../src/orchestration/tasks";
import { openPersistence, Persistence } from "../../src/persistence/database";

type OwnedHandle = { close(): void };
const ownedRoots = new Map<string, Set<OwnedHandle>>();
const testRoots = new Set<string>();
let createdRoots = 0;
let removedRoots = 0;
let createdHandles = 0;
let closedHandles = 0;

function ownRoot(): string {
  const root = mkdtempSync("/tmp/opencode/opencode-sessions-tools/t23-tasks-");
  ownedRoots.set(root, new Set());
  testRoots.add(root);
  createdRoots++;
  return root;
}
function ownHandle<T extends OwnedHandle>(root: string, handle: T): T {
  const handles = ownedRoots.get(root);
  if (!handles) throw new Error("fixture root is no longer owned");
  if (handles.has(handle)) return handle;
  const close = handle.close.bind(handle);
  handles.add(handle);
  createdHandles++;
  handle.close = () => {
    if (!handles.has(handle)) return;
    close();
    handles.delete(handle);
    closedHandles++;
  };
  return handle;
}
function cleanupRoot(root: string): void {
  const handles = ownedRoots.get(root);
  if (!handles) return;
  const errors: unknown[] = [];
  for (const handle of [...handles].reverse()) {
    try {
      handle.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (handles.size === 0) {
    try {
      rmSync(root, { recursive: true, force: true });
      ownedRoots.delete(root);
      removedRoots++;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "owned Tasks fixture cleanup failed");
}
afterEach(() => {
  const errors: unknown[] = [];
  try {
    // Only roots created by THIS file are eligible. Never scan/remove old dirs.
    for (const root of [...ownedRoots.keys()]) {
      try {
        cleanupRoot(root);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const root of testRoots) expect(existsSync(root)).toBe(false);
    expect(ownedRoots.size).toBe(0);
  } finally {
    testRoots.clear();
  }
  if (errors.length)
    throw new AggregateError(errors, "Tasks afterEach cleanup failed");
});
afterAll(() => {
  expect(ownedRoots.size).toBe(0);
  expect(removedRoots).toBe(createdRoots);
  expect(closedHandles).toBe(createdHandles);
  console.info(
    `T23 owned fixtures: created=${createdRoots} removed=${removedRoots} remaining=${ownedRoots.size}; handles=${createdHandles} closed=${closedHandles}`,
  );
});

function fixture(canonical = false) {
  const root = ownRoot();
  const file = `${root}/synthetic.sqlite`;
  let canonicalStorage: Persistence | undefined;
  let canonicalOptions: Parameters<typeof openPersistence>[0] | undefined;
  if (canonical) {
    writeFileSync(file, "");
    const stat = statSync(file);
    canonicalOptions = {
      repositoryPath: process.cwd(),
      claims: [
        {
          instanceID: "fixture",
          scopeID: "project",
          installationID: "synthetic-t23",
          canonicalPath: file,
          databaseIdentity: `${stat.dev}:${stat.ino}`,
        },
      ],
      migrations: [
        { ...GROUPS_MIGRATION, version: 2 },
        { ...TASKS_MIGRATION, version: 3 },
      ],
    };
    canonicalStorage = ownHandle(root, openPersistence(canonicalOptions));
  }
  const sql = ownHandle(
    root,
    canonicalStorage?.transaction((db) => db) ?? new Database(file),
  );
  if (!canonicalStorage) {
    sql.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    GROUPS_MIGRATION.apply(sql, "unused");
    TASKS_MIGRATION.apply(sql, "unused");
  }
  const storage =
    canonicalStorage ?? ownHandle(root, new Persistence(sql, () => {}));
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
  let denied = false;
  let loads = 0;
  let changeAt = Number.POSITIVE_INFINITY;
  const grants: Grant[] = [];
  sql.query("INSERT INTO groups_records VALUES (?,?)").run(
    "group",
    JSON.stringify({
      version: 1,
      groupID: "group",
      name: "synthetic",
      kind: "group",
      scope,
      owner: operator,
    }),
  );
  const policy = {
    load: (): AuthorizationSnapshot => ({
      revision: ++loads >= changeAt ? 2 : 1,
      profile: "manage",
      profileCapabilities: capabilities,
      policyCapabilities: capabilities,
      hostCapabilities: capabilities,
      deniedCapabilities: denied ? ["task.dispatch", "read"] : [],
      grants,
      operator: {
        operatorID: "synthetic",
        instanceID: "fixture",
        revision: 1,
        capabilities,
        projects: ["project", "other"],
        expiresAt: null,
      },
      delegationCapabilities: null,
      approval: null,
    }),
    save() {},
  };
  const identity = { current: async () => principal };
  const make = (db: Database) =>
    new Tasks(
      db === sql
        ? storage
        : ownHandle(root, new Persistence(ownHandle(root, db), () => {})),
      identity,
      policy,
      () => 1000,
    );
  return {
    sql,
    root,
    file,
    scope,
    service: make(sql),
    make,
    storage,
    cleanup() {
      cleanupRoot(root);
    },
    openDatabase(path: string) {
      if (!ownedRoots.has(root)) throw new Error("fixture already cleaned");
      if (path !== file && path !== ":memory:")
        throw new Error("unowned fixture database");
      return ownHandle(root, new Database(path));
    },
    reopen() {
      if (!canonicalOptions) throw new Error("canonical fixture required");
      if (!ownedRoots.has(root)) throw new Error("fixture already cleaned");
      const reopened = ownHandle(root, openPersistence(canonicalOptions));
      reopened.transaction((db) => ownHandle(root, db));
      return reopened;
    },
    identity,
    policy,
    changePolicyDuringAdmission() {
      changeAt = loads + 3;
    },
    grant(target: SessionRef) {
      if (operator.kind !== "operator") throw new Error("invalid fixture");
      grants.push({
        version: 1,
        grantID: crypto.randomUUID(),
        source: scope,
        target,
        capabilities: ["read", "task.dispatch"],
        revision: 1,
        issuer: operator,
        createdAt: new Date(0).toISOString(),
        expiresAt: null,
      });
    },
    deny() {
      denied = true;
    },
    session() {
      principal = { kind: "session", session: scope };
    },
    actor(operatorID: string) {
      principal = {
        kind: "operator",
        operatorID,
        instanceID: "fixture",
        revision: 1,
      };
    },
  };
}
test("owned fixture cleanup closes secondary handles and unregisters idempotently", () => {
  const f = fixture(true);
  const reopened = f.reopen();
  const memory = f.openDatabase(":memory:");
  expect(ownedRoots.has(f.root)).toBe(true);
  f.cleanup();
  expect(existsSync(f.root)).toBe(false);
  expect(ownedRoots.has(f.root)).toBe(false);
  expect(() => memory.query("SELECT 1").get()).toThrow();
  expect(() => reopened.version).toThrow(
    expect.objectContaining({ code: "unavailable" }),
  );
  expect(() => {
    memory.close();
    reopened.close();
    f.sql.close();
    f.storage.close();
    f.cleanup();
  }).not.toThrow();
});

test("afterEach owns unclosed fixture handles even when fixture use exits early", () => {
  const first = fixture();
  const second = fixture(true);
  first.openDatabase(first.file);
  second.reopen();
  expect(() => {
    throw new Error("synthetic early fixture exit");
  }).toThrow("synthetic early fixture exit");
  expect(ownedRoots.size).toBe(2);
  // Deliberately leave both fixtures open: afterEach must close every handle,
  // remove these exact registered roots and assert their absence.
});

const metadata = (
  executor: SessionRef,
  dependencies: readonly string[] = [],
) => ({
  objective: "synthetic objective",
  expectedResult: "synthetic result",
  executor,
  dependencies,
});
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing synthetic task");
  return value;
}

function accountingFixture(
  f: ReturnType<typeof fixture>,
  policy: GrantPolicyPort = f.policy,
) {
  f.storage.transaction((sql) =>
    sql.exec(
      "CREATE TABLE synthetic_admissions(admission_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE synthetic_outcomes(admission_id TEXT PRIMARY KEY, body TEXT NOT NULL)",
    ),
  );
  const ports = {
    admissions: {
      lookup(
        sql: Database,
        _groupID: string,
        taskID: string,
        _principal: Principal,
        purpose: "journal" | "accounting",
      ): RunnerAdmissionEvidence | null {
        expect(sql).toBe(f.sql);
        const row = sql
          .query<{ body: string }, [string]>(
            purpose === "accounting"
              ? "SELECT a.body FROM synthetic_admissions a JOIN synthetic_outcomes o ON o.admission_id=a.admission_id WHERE a.task_id=? ORDER BY o.rowid ASC, a.admission_id ASC LIMIT 1"
              : "SELECT body FROM synthetic_admissions WHERE task_id=? ORDER BY rowid DESC LIMIT 1",
          )
          .get(taskID);
        return row ? JSON.parse(row.body) : null;
      },
    },
    outcomes: {
      lookup(
        sql: Database,
        admission: RunnerAdmissionEvidence,
      ): TaskOutcomeEvidence | null {
        expect(sql).toBe(f.sql);
        const row = sql
          .query<{ body: string }, [string]>(
            "SELECT body FROM synthetic_outcomes WHERE admission_id=?",
          )
          .get(admission.admissionID);
        return row ? JSON.parse(row.body) : null;
      },
    },
  };
  return {
    ports,
    service: new Tasks(f.storage, f.identity, policy, () => 1000, ports),
    admit(kind: "execution" | "cancellation") {
      return (sql: Database, context: RunnerTaskContext) => {
        const proof: RunnerAdmissionEvidence = {
          admissionID: crypto.randomUUID(),
          groupID: context.task.groupID,
          taskID: context.task.taskID,
          owner: structuredClone(context.principal),
          operationID: crypto.randomUUID(),
          correlationID: context.transitionKey,
          taskGeneration: context.taskGeneration,
          kind,
        };
        sql
          .query("INSERT INTO synthetic_admissions VALUES (?,?,?)")
          .run(proof.admissionID, proof.taskID, JSON.stringify(proof));
        return proof;
      };
    },
    outcome(
      admission: RunnerAdmissionEvidence,
      state: TaskOutcomeEvidence["state"],
      patch: Partial<TaskOutcomeEvidence> = {},
    ) {
      f.storage.transaction((sql) =>
        sql
          .query(
            "INSERT INTO synthetic_outcomes VALUES (?,?) ON CONFLICT(admission_id) DO UPDATE SET body=excluded.body",
          )
          .run(
            admission.admissionID,
            JSON.stringify({
              admissionID: admission.admissionID,
              operationID: admission.operationID,
              correlationID: admission.correlationID,
              taskGeneration: admission.taskGeneration,
              state,
              ...patch,
            }),
          ),
      );
    },
  };
}

test("runner accounting without injected trusted ports fails closed, ignoring bare outcome flags", async () => {
  const f = fixture(true);
  try {
    const graph = await f.service.create("group", metadata(f.scope), 0);
    const taskID = required(graph.tasks[0]).taskID;
    await expect(
      f.service.runnerAccount("group", taskID, graph.revision, () => null),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      f.service.runnerTransition(
        "group",
        taskID,
        {
          kind: "outcome",
          outcome: "completed",
          evidence: "final_result",
        } as never,
        graph.revision,
        () => null,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await f.service.get("group")).toEqual(graph);
  } finally {
    f.cleanup();
  }
});

test("accounting selects earliest persisted receipt while journal stays on cancellation intent; first terminal wins", async () => {
  for (const winner of ["completed", "failed", "cancelled"] as const) {
    const f = fixture(true);
    try {
      const a = accountingFixture(f);
      let graph = await f.service.create("group", metadata(f.scope), 0);
      const taskID = required(graph.tasks[0]).taskID;
      const execution = await a.service.runnerTransition(
        "group",
        taskID,
        { kind: "execute" },
        graph.revision,
        a.admit("execution"),
      );
      graph = execution.graph;
      const cancellation = await a.service.runnerTransition(
        "group",
        taskID,
        { kind: "cancel" },
        graph.revision,
        a.admit("cancellation"),
      );
      graph = cancellation.graph;
      expect(graph.tasks[0]?.state).toBe("cancel_requested");
      if (winner === "cancelled") a.outcome(cancellation.value, "cancelled");
      else a.outcome(execution.value, winner);
      // Journal remains stable even after another admission's receipt arrives.
      const journal = await a.service.runnerJournal(
        "group",
        taskID,
        graph.revision,
        (_sql, ctx) => ctx.taskGeneration,
      );
      expect(journal).toBe(1);
      expect(
        f.storage.transaction((sql) =>
          a.ports.admissions.lookup(
            sql,
            "group",
            taskID,
            execution.value.owner,
            "journal",
          ),
        )?.admissionID,
      ).toBe(cancellation.value.admissionID);
      if (winner === "cancelled") a.outcome(execution.value, "completed");
      else a.outcome(cancellation.value, "cancelled");
      graph = (
        await a.service.runnerAccount(
          "group",
          taskID,
          graph.revision,
          () => null,
        )
      ).graph;
      expect(graph.tasks.find((t) => t.taskID === taskID)?.state).toBe(winner);
      // Consume/remove the first fixture receipt to expose the later receipt.
      const winningID =
        winner === "cancelled"
          ? cancellation.value.admissionID
          : execution.value.admissionID;
      f.storage.transaction((sql) =>
        sql
          .query("DELETE FROM synthetic_outcomes WHERE admission_id=?")
          .run(winningID),
      );
      await expect(
        a.service.runnerAccount("group", taskID, graph.revision, () => null),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(await f.service.get("group")).toEqual(graph);
    } finally {
      f.cleanup();
    }
  }
});

test("accounting never falls back from forged earliest receipt or switches admissions during authorization", async () => {
  const f = fixture(true);
  try {
    const a = accountingFixture(f);
    let graph = await f.service.create("group", metadata(f.scope), 0);
    const taskID = required(graph.tasks[0]).taskID;
    const execution = await a.service.runnerTransition(
      "group",
      taskID,
      { kind: "execute" },
      graph.revision,
      a.admit("execution"),
    );
    const cancellation = await a.service.runnerTransition(
      "group",
      taskID,
      { kind: "cancel" },
      execution.graph.revision,
      a.admit("cancellation"),
    );
    graph = cancellation.graph;
    a.outcome(execution.value, "completed");
    a.outcome(cancellation.value, "cancelled");
    const store = (value: RunnerAdmissionEvidence) =>
      f.storage.transaction((sql) =>
        sql
          .query("UPDATE synthetic_admissions SET body=? WHERE admission_id=?")
          .run(JSON.stringify(value), execution.value.admissionID),
      );
    store({
      ...execution.value,
      owner: {
        kind: "operator",
        instanceID: "fixture",
        operatorID: "another-owner",
        revision: 1,
      },
    });
    await expect(
      a.service.runnerAccount("group", taskID, graph.revision, () => null),
    ).rejects.toMatchObject({ code: "not_found" });
    store({ ...execution.value, taskGeneration: 2 });
    await expect(
      a.service.runnerAccount("group", taskID, graph.revision, () => null),
    ).rejects.toMatchObject({ code: "conflict" });
    store(execution.value);
    let reads = 0;
    let callbacks = 0;
    const switching = new Tasks(f.storage, f.identity, f.policy, () => 1000, {
      admissions: {
        lookup(sql, groupID, id, principal, purpose) {
          if (purpose === "accounting" && ++reads > 1)
            return cancellation.value;
          return a.ports.admissions.lookup(
            sql,
            groupID,
            id,
            principal,
            purpose,
          );
        },
      },
      outcomes: a.ports.outcomes,
    });
    await expect(
      switching.runnerAccount(
        "group",
        taskID,
        graph.revision,
        () => ++callbacks,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(callbacks).toBe(0);
    expect(await f.service.get("group")).toEqual(graph);
    graph = (
      await a.service.runnerAccount("group", taskID, graph.revision, () => null)
    ).graph;
    expect(graph.tasks.find((t) => t.taskID === taskID)?.state).toBe(
      "completed",
    );
  } finally {
    f.cleanup();
  }
});

test("journal refuses a sibling task generation mutation and rolls it back", async () => {
  const f = fixture(true);
  try {
    const a = accountingFixture(f);
    let graph = await f.service.create("group", metadata(f.scope), 0);
    const taskID = required(graph.tasks[0]).taskID;
    graph = await f.service.create("group", metadata(f.scope), graph.revision);
    const siblingID = required(
      graph.tasks.find((t) => t.taskID !== taskID),
    ).taskID;
    graph = (
      await a.service.runnerTransition(
        "group",
        taskID,
        { kind: "execute" },
        graph.revision,
        a.admit("execution"),
      )
    ).graph;
    await expect(
      a.service.runnerJournal("group", taskID, graph.revision, (sql) => {
        sql
          .query(
            "UPDATE task_records SET generation=generation+1 WHERE task_id=?",
          )
          .run(siblingID);
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await f.service.get("group")).toEqual(graph);
    expect(
      f.sql
        .query("SELECT generation FROM task_records WHERE task_id=?")
        .get(siblingID),
    ).toEqual({ generation: 0 });
  } finally {
    f.cleanup();
  }
});

test("runner journal bootstraps null operation without outcome, preserves task revision/generation, and rolls back callbacks", async () => {
  const f = fixture(true);
  try {
    const a = accountingFixture(f);
    let graph = await f.service.create("group", metadata(f.scope), 0);
    const taskID = required(graph.tasks[0]).taskID;
    const execution = await a.service.runnerTransition(
      "group",
      taskID,
      { kind: "execute" },
      graph.revision,
      (sql, ctx) => {
        const proof = a.admit("execution")(sql, ctx);
        const pending = { ...proof, operationID: null };
        sql
          .query("UPDATE synthetic_admissions SET body=? WHERE admission_id=?")
          .run(JSON.stringify(pending), proof.admissionID);
        return pending;
      },
    );
    graph = execution.graph;
    a.outcome(execution.value, "completed");
    await expect(
      a.service.runnerAccount("group", taskID, graph.revision, () => null),
    ).rejects.toMatchObject({ code: "invalid_input" });
    f.storage.transaction((sql) =>
      sql.query("DELETE FROM synthetic_outcomes").run(),
    );
    const value = await a.service.runnerJournal(
      "group",
      taskID,
      graph.revision,
      (sql, ctx) => {
        expect(sql).toBe(f.sql);
        expect(ctx.taskGeneration).toBe(1);
        sql
          .query("UPDATE synthetic_admissions SET body=? WHERE admission_id=?")
          .run(
            JSON.stringify({
              ...execution.value,
              operationID: "persisted-operation",
            }),
            execution.value.admissionID,
          );
        return "lease-claimed";
      },
    );
    expect(value).toBe("lease-claimed");
    expect(await a.service.get("group")).toEqual(graph);
    await expect(
      a.service.runnerJournal("group", taskID, graph.revision, (sql) => {
        sql
          .query("INSERT INTO synthetic_outcomes VALUES (?,?)")
          .run(execution.value.admissionID, "{}");
        throw new DomainError("conflict");
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(f.sql.query("SELECT * FROM synthetic_outcomes").all()).toEqual([]);
    expect(await a.service.get("group")).toEqual(graph);
  } finally {
    f.cleanup();
  }
});

test("accounting binds immutable receipt and task generation across unrelated graph revisions, wait and resume", async () => {
  const f = fixture(true);
  try {
    const a = accountingFixture(f);
    let graph = await f.service.create("group", metadata(f.scope), 0);
    const taskID = required(graph.tasks[0]).taskID;
    expect(
      f.sql
        .query("SELECT generation FROM task_records WHERE task_id=?")
        .get(taskID),
    ).toEqual({ generation: 0 });
    const execution = await a.service.runnerTransition(
      "group",
      taskID,
      { kind: "execute" },
      graph.revision,
      a.admit("execution"),
    );
    graph = execution.graph;
    expect(execution.value.taskGeneration).toBe(1);
    graph = await f.service.create("group", metadata(f.scope), graph.revision);
    for (const state of [
      "awaiting_input",
      "running",
      "awaiting_approval",
      "running",
    ] as const) {
      a.outcome(execution.value, state);
      const result = await a.service.runnerAccount(
        "group",
        taskID,
        graph.revision,
        (_sql, ctx) => ctx.taskGeneration,
      );
      graph = result.graph;
      expect(result.value).toBe(1);
      expect(graph.tasks.find((t) => t.taskID === taskID)?.state).toBe(state);
    }
    for (const patch of [
      { operationID: "forged" },
      { admissionID: "forged" },
      { correlationID: "forged" },
      { taskGeneration: 2 },
      { state: "cancelled" as const },
    ]) {
      a.outcome(execution.value, "completed", patch);
      await expect(
        a.service.runnerAccount("group", taskID, graph.revision, () => {
          throw new Error("must not run");
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(await f.service.get("group")).toEqual(graph);
    }
    a.outcome(execution.value, "completed");
    await expect(
      a.service.runnerAccount("group", taskID, graph.revision, (sql) => {
        sql.query("DELETE FROM synthetic_outcomes").run();
        throw new DomainError("conflict");
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await f.service.get("group")).toEqual(graph);
    graph = (
      await a.service.runnerAccount(
        "group",
        taskID,
        graph.revision,
        (_sql, ctx) => ctx.taskGeneration,
      )
    ).graph;
    expect(graph.tasks.find((t) => t.taskID === taskID)?.state).toBe(
      "completed",
    );
    await expect(
      a.service.runnerAccount("group", taskID, graph.revision, () => null),
    ).rejects.toMatchObject({ code: "conflict" });
  } finally {
    f.cleanup();
  }
});

test("journal and accounting reject absent admission, foreign principal, stale generation and revoked scope without mutation", async () => {
  const f = fixture(true);
  try {
    const a = accountingFixture(f);
    let graph = await f.service.create("group", metadata(f.scope), 0);
    const taskID = required(graph.tasks[0]).taskID;
    let calls = 0;
    await expect(
      a.service.runnerJournal("group", taskID, graph.revision, () => ++calls),
    ).rejects.toMatchObject({ code: "not_found" });
    const execution = await a.service.runnerTransition(
      "group",
      taskID,
      { kind: "execute" },
      graph.revision,
      a.admit("execution"),
    );
    graph = execution.graph;
    a.outcome(execution.value, "completed");
    f.actor("third-principal");
    await expect(
      a.service.runnerJournal("group", taskID, graph.revision, () => ++calls),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      a.service.runnerAccount("group", taskID, graph.revision, () => ++calls),
    ).rejects.toMatchObject({ code: "not_found" });
    f.actor("synthetic");
    await expect(
      a.service.runnerJournal(
        "group",
        taskID,
        graph.revision - 1,
        () => ++calls,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    f.storage.transaction((sql) =>
      sql
        .query("UPDATE synthetic_admissions SET body=? WHERE admission_id=?")
        .run(
          JSON.stringify({ ...execution.value, taskGeneration: 2 }),
          execution.value.admissionID,
        ),
    );
    await expect(
      a.service.runnerJournal("group", taskID, graph.revision, () => ++calls),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      a.service.runnerAccount("group", taskID, graph.revision, () => ++calls),
    ).rejects.toMatchObject({ code: "conflict" });
    f.storage.transaction((sql) =>
      sql
        .query("UPDATE synthetic_admissions SET body=? WHERE admission_id=?")
        .run(JSON.stringify(execution.value), execution.value.admissionID),
    );
    await expect(
      a.service.runnerJournal("group", taskID, graph.revision, (sql) =>
        sql
          .query(
            "UPDATE task_records SET generation=generation+1 WHERE task_id=?",
          )
          .run(taskID),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await f.service.get("group")).toEqual(graph);
    f.deny();
    await expect(
      a.service.runnerJournal("group", taskID, graph.revision, () => ++calls),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      a.service.runnerAccount("group", taskID, graph.revision, () => ++calls),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(calls).toBe(0);
    expect(
      f.sql
        .query("SELECT generation FROM task_records WHERE task_id=?")
        .get(taskID),
    ).toEqual({ generation: 1 });
  } finally {
    f.cleanup();
  }
});

function composedGroups(f: ReturnType<typeof fixture>): Groups {
  return new Groups(
    f.storage,
    f.identity,
    f.policy,
    taskActiveWork(f.storage, {
      // Synthetic jobs storage is explicitly absent in this test composition.
      active(sql) {
        expect(sql).toBe(f.sql);
        return false;
      },
    }),
    () => 1000,
  );
}
function pluginCounts(f: ReturnType<typeof fixture>): number[] {
  return f.storage.transaction((sql) =>
    ["groups_records", "groups_members", "task_graphs", "task_records"].map(
      (table) =>
        Number(
          sql
            .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`)
            .get()?.n,
        ),
    ),
  );
}

test("canonical Groups+Tasks terminal deletion cascades only plugin records with FK enforcement", async () => {
  const f = fixture(true);
  try {
    expect(f.sql.query("PRAGMA foreign_keys").get()).toEqual({
      foreign_keys: 1,
    });
    expect(f.storage.version).toBe(3);
    expect(
      f.sql.query("PRAGMA foreign_key_list(task_graphs)").all(),
    ).toMatchObject([
      {
        table: "groups_records",
        from: "group_id",
        to: "group_id",
        on_delete: "CASCADE",
      },
    ]);
    expect(
      f.sql.query("PRAGMA foreign_key_list(task_records)").all(),
    ).toMatchObject([
      {
        table: "task_graphs",
        from: "group_id",
        to: "group_id",
        on_delete: "CASCADE",
      },
    ]);
    expect(f.sql.query("SELECT * FROM ownership").get()).toMatchObject({
      instance_id: "fixture",
      scope_id: "project",
      installation_id: "synthetic-t23",
    });
    f.storage.transaction((sql) =>
      sql.exec(
        "CREATE TABLE synthetic_host_sessions(id TEXT PRIMARY KEY); INSERT INTO synthetic_host_sessions VALUES ('untouched')",
      ),
    );
    const groups = composedGroups(f);
    await groups.addMember("group", f.scope, 1);
    let graph = await f.service.get("group");
    for (const terminal of ["completed", "failed", "cancelled"] as const) {
      const previous = new Set(graph.tasks.map((t) => t.taskID));
      graph = await f.service.create(
        "group",
        metadata(f.scope),
        graph.revision,
      );
      const taskID = required(
        graph.tasks.find((t) => !previous.has(t.taskID)),
      ).taskID;
      if (terminal !== "cancelled")
        graph = await f.service.transition(
          "group",
          taskID,
          "running",
          graph.revision,
        );
      graph = await f.service.transition(
        "group",
        taskID,
        terminal,
        graph.revision,
      );
    }
    expect(pluginCounts(f)).toEqual([1, 1, 1, 3]);
    await groups.deleteGroup("group", 1);
    expect(pluginCounts(f)).toEqual([0, 0, 0, 0]);
    expect(f.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(f.sql.query("SELECT * FROM synthetic_host_sessions").all()).toEqual([
      { id: "untouched" },
    ]);
    expect(f.sql.query("SELECT COUNT(*) AS n FROM ownership").get()).toEqual({
      n: 1,
    });
  } finally {
    f.storage.close();
  }
});

test("canonical Groups deletion refuses pending work with conflict and preserves all rows", async () => {
  const f = fixture(true);
  try {
    const groups = composedGroups(f);
    await groups.addMember("group", f.scope, 1);
    let graph = await f.service.create("group", metadata(f.scope), 0);
    const taskID = required(graph.tasks[0]).taskID;
    for (const state of [
      "pending",
      "running",
      "awaiting_input",
      "running",
      "awaiting_approval",
      "running",
      "cancel_requested",
    ] as const) {
      if (state !== "pending")
        graph = await f.service.transition(
          "group",
          taskID,
          state,
          graph.revision,
        );
      await expect(groups.deleteGroup("group", 1)).rejects.toMatchObject({
        code: "conflict",
      });
      expect(pluginCounts(f)).toEqual([1, 1, 1, 1]);
      expect(await f.service.get("group")).toEqual(graph);
      expect(f.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
    }
    graph = await f.service.transition(
      "group",
      taskID,
      "cancelled",
      graph.revision,
    );
    graph = await f.service.create(
      "group",
      metadata(f.scope, [taskID]),
      graph.revision,
    );
    expect(graph.tasks.find((task) => task.taskID !== taskID)?.state).toBe(
      "blocked",
    );
    await expect(groups.deleteGroup("group", 1)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(pluginCounts(f)).toEqual([1, 1, 1, 2]);
    expect(await f.service.get("group")).toEqual(graph);
    expect(f.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    f.storage.close();
  }
});

test("canonical cascade rollback restores graph and tasks without orphans", async () => {
  const f = fixture(true);
  try {
    const groups = composedGroups(f);
    await groups.addMember("group", f.scope, 1);
    let graph = await f.service.create("group", metadata(f.scope), 0);
    graph = await f.service.transition(
      "group",
      required(graph.tasks[0]).taskID,
      "cancelled",
      graph.revision,
    );
    expect(() =>
      f.storage.transaction((sql) => {
        sql.query("DELETE FROM groups_records WHERE group_id=?").run("group");
        expect(pluginCounts(f)).toEqual([0, 0, 0, 0]);
        throw new DomainError("conflict");
      }),
    ).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(pluginCounts(f)).toEqual([1, 1, 1, 1]);
    expect(await f.service.get("group")).toEqual(graph);
    expect(f.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
    await groups.deleteGroup("group", 1);
    expect(pluginCounts(f)).toEqual([0, 0, 0, 0]);
  } finally {
    f.storage.close();
  }
});

test("TSK-01/02/06 durable fork/join, atomic cycles, failure, explicit replan and terminal guards", async () => {
  const f = fixture();
  try {
    let g = await f.service.create("group", metadata(f.scope), 0);
    const a = required(g.tasks[0]).taskID;
    g = await f.service.create("group", metadata(f.scope, [a]), g.revision);
    const b = required(g.tasks.find((t) => t.taskID !== a)).taskID;
    g = await f.service.create("group", metadata(f.scope, [a]), g.revision);
    const c = required(
      g.tasks.find((t) => t.taskID !== a && t.taskID !== b),
    ).taskID;
    g = await f.service.create("group", metadata(f.scope, [b, c]), g.revision);
    const join = required(
      g.tasks.find((t) => t.dependencies.length === 2),
    ).taskID;
    await expect(
      f.service.replan(
        "group",
        [{ taskID: a, dependencies: [join], replanned: true }],
        g.revision,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await f.service.get("group")).toEqual(g);
    await expect(
      f.service.transition("group", join, "running", g.revision),
    ).rejects.toMatchObject({ code: "conflict" });
    g = await f.service.transition("group", a, "running", g.revision);
    g = await f.service.transition("group", a, "failed", g.revision);
    expect(g.tasks.filter((t) => t.state === "blocked").length).toBe(3);
    const revision = g.revision;
    await expect(
      f.service.transition("group", a, "pending", revision),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      f.service.replan(
        "group",
        [{ taskID: b, dependencies: [], replanned: false }],
        revision,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await f.service.get("group")).toEqual(g);
    g = await f.service.replan(
      "group",
      [{ taskID: b, dependencies: [], replanned: true }],
      revision,
    );
    expect(g.tasks.find((t) => t.taskID === b)?.state).toBe("pending");
    expect(g.tasks.find((t) => t.taskID === join)?.state).toBe("blocked");
    const reopened = f.openDatabase(f.file);
    try {
      expect(await f.make(reopened).get("group")).toEqual(g);
    } finally {
      reopened.close();
    }
    const work = taskActiveWork(new Persistence(f.sql, () => {}), {
      active(db) {
        expect(db).toBe(f.sql);
        return false;
      },
    });
    expect(f.sql.transaction(() => work.snapshot(f.sql, "group"))()).toEqual({
      activeTasks: true,
      activeJobs: false,
    });
  } finally {
    f.sql.close();
  }
});

test("two file connections racing the same revision commit exactly one writer", async () => {
  const f = fixture();
  const second = f.openDatabase(f.file);
  try {
    const results = await Promise.allSettled([
      f.service.create("group", metadata(f.scope), 0),
      f.make(second).create("group", metadata(f.scope), 0),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "conflict" },
    });
    expect((await f.service.get("group")).tasks.length).toBe(1);
  } finally {
    second.close();
    f.sql.close();
  }
});

test("fresh policy and membership never grant task access; missing dependency rolls back", async () => {
  const f = fixture();
  try {
    await expect(
      f.service.create("group", metadata(f.scope, ["missing"]), 0),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await f.service.get("group")).revision).toBe(0);
    await f.service.create(
      "group",
      metadata({ ...f.scope, projectID: "other" }),
      0,
    );
    f.deny();
    await expect(f.service.get("group")).rejects.toMatchObject({
      code: "forbidden",
    });
    f.session();
    await expect(f.service.get("group")).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(() =>
      taskActiveWork(
        new Persistence(f.sql, () => {}),
        undefined as never,
      ).snapshot(f.sql, "group"),
    ).toThrow(expect.objectContaining({ code: "unavailable" }));
  } finally {
    f.sql.close();
  }
});

test("REL-05 all terminal states remain final; cancellation blocks descendants", async () => {
  for (const final of ["completed", "failed", "cancelled"] as const) {
    const f = fixture();
    try {
      let graph = await f.service.create("group", metadata(f.scope), 0);
      const taskID = required(graph.tasks[0]).taskID;
      if (final !== "cancelled")
        graph = await f.service.transition(
          "group",
          taskID,
          "running",
          graph.revision,
        );
      graph = await f.service.transition(
        "group",
        taskID,
        final,
        graph.revision,
      );
      for (const next of ["pending", "running", "blocked"] as const)
        await expect(
          f.service.transition("group", taskID, next, graph.revision),
        ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        f.service.replan(
          "group",
          [{ taskID, dependencies: [], replanned: true }],
          graph.revision,
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(await f.service.get("group")).toEqual(graph);
      if (final === "cancelled") {
        graph = await f.service.create(
          "group",
          metadata(f.scope, [taskID]),
          graph.revision,
        );
        expect(graph.tasks.find((t) => t.taskID !== taskID)?.state).toBe(
          "blocked",
        );
      }
    } finally {
      f.sql.close();
    }
  }
});

test("active work covers exact nonterminal states and rejects foreign DB and missing jobs adapter", async () => {
  const f = fixture();
  const foreign = f.openDatabase(":memory:");
  try {
    const graph = await f.service.create("group", metadata(f.scope), 0);
    const task = required(graph.tasks[0]);
    const work = taskActiveWork(new Persistence(f.sql, () => {}), {
      active: () => false,
    });
    for (const state of [
      "pending",
      "blocked",
      "running",
      "awaiting_input",
      "awaiting_approval",
      "cancel_requested",
      "completed",
      "failed",
      "cancelled",
    ] as const) {
      f.sql
        .query("UPDATE task_records SET body=? WHERE task_id=?")
        .run(JSON.stringify({ ...task, state }), task.taskID);
      expect(
        f.sql.transaction(() => work.snapshot(f.sql, "group"))().activeTasks,
      ).toBe(!["completed", "failed", "cancelled"].includes(state));
    }
    expect(() =>
      foreign.transaction(() => work.snapshot(foreign, "group"))(),
    ).toThrow(expect.objectContaining({ code: "unavailable" }));
    const missing = taskActiveWork(
      new Persistence(f.sql, () => {}),
      undefined as never,
    );
    expect(() =>
      f.sql.transaction(() => missing.snapshot(f.sql, "group"))(),
    ).toThrow(expect.objectContaining({ code: "unavailable" }));
  } finally {
    foreign.close();
    f.sql.close();
  }
});

test("invalid runtime inputs and cross-instance executors preserve empty graph", async () => {
  const f = fixture();
  try {
    for (const data of [
      null,
      {},
      { ...metadata(f.scope), dependencies: ["x", "x"] },
      { ...metadata(f.scope), objective: " " },
    ])
      await expect(
        f.service.create("group", data as never, 0),
      ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      f.service.create(
        "group",
        metadata({ ...f.scope, instanceID: "foreign" }),
        0,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await f.service.get("group")).revision).toBe(0);
  } finally {
    f.sql.close();
  }
});

test("cross-project dependency source and destination each require explicit grants, not membership", async () => {
  const f = fixture();
  try {
    const target = { ...f.scope, projectID: "other", sessionID: "executor" };
    let graph = await f.service.create("group", metadata(target), 0);
    const first = required(graph.tasks[0]).taskID;
    f.sql
      .query("INSERT INTO groups_members VALUES (?,?)")
      .run("group", JSON.stringify(target));
    f.session();
    await expect(f.service.get("group")).rejects.toMatchObject({
      code: "forbidden",
    });
    f.grant(f.scope);
    await expect(f.service.get("group")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      f.service.create("group", metadata(f.scope, [first]), graph.revision),
    ).rejects.toMatchObject({ code: "not_found" });
    f.grant(target);
    graph = await f.service.create(
      "group",
      metadata(f.scope, [first]),
      graph.revision,
    );
    expect(graph.tasks.length).toBe(2);
    expect(graph.tasks.find((t) => t.taskID !== first)?.author).toEqual({
      kind: "session",
      session: f.scope,
    });
  } finally {
    f.sql.close();
  }
});

test("failed local persistence rolls back DAG revision and task insertion", async () => {
  const f = fixture();
  try {
    f.sql.exec(
      "CREATE TRIGGER synthetic_fail BEFORE INSERT ON task_records BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
    );
    await expect(
      f.service.create("group", metadata(f.scope), 0),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await f.service.get("group")).toEqual({
      groupID: "group",
      revision: 0,
      tasks: [],
    });
  } finally {
    f.sql.close();
  }
});

test("policy changed after secondary-target authorization aborts local admission atomically", async () => {
  const f = fixture();
  try {
    const target = { ...f.scope, projectID: "other", sessionID: "executor" };
    const graph = await f.service.create("group", metadata(target), 0);
    f.changePolicyDuringAdmission();
    await expect(
      f.service.create("group", metadata(f.scope), graph.revision),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await f.service.get("group")).toEqual(graph);
  } finally {
    f.sql.close();
  }
});

test("runner internal port commits transition and synchronous intent together, or rolls both back", async () => {
  const f = fixture(true);
  try {
    f.storage.transaction((sql) =>
      sql.exec("CREATE TABLE synthetic_runner_intents(key TEXT PRIMARY KEY)"),
    );
    const graph = await f.service.create("group", metadata(f.scope), 0);
    const taskID = required(graph.tasks[0]).taskID;
    await expect(
      f.service.runnerTransition(
        "group",
        taskID,
        { kind: "execute" },
        graph.revision,
        (sql, context) => {
          expect(sql).toBe(f.sql);
          sql
            .query("INSERT INTO synthetic_runner_intents VALUES (?)")
            .run(context.transitionKey);
          throw new DomainError("conflict");
        },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await f.service.get("group")).toEqual(graph);
    expect(f.sql.query("SELECT * FROM synthetic_runner_intents").all()).toEqual(
      [],
    );
    const result = await f.service.runnerTransition(
      "group",
      taskID,
      { kind: "execute" },
      graph.revision,
      (sql, context) => {
        expect(context.task.state).toBe("running");
        expect(context.graph.revision).toBe(graph.revision + 1);
        sql
          .query("INSERT INTO synthetic_runner_intents VALUES (?)")
          .run(context.transitionKey);
        return context.transitionKey;
      },
    );
    expect(result.graph.tasks[0]?.state).toBe("running");
    expect(
      f.sql.query("SELECT key FROM synthetic_runner_intents").all(),
    ).toEqual([{ key: result.value }]);
  } finally {
    f.cleanup();
  }
});

test("runner refuses incomplete dependencies, depth five, and async callbacks without committing", async () => {
  const f = fixture(true);
  try {
    const accounting = accountingFixture(f);
    let graph = await f.service.get("group");
    let previous: string | undefined;
    let calls = 0;
    for (let level = 1; level <= 5; level++) {
      const existing = new Set(graph.tasks.map((t) => t.taskID));
      graph = await f.service.create(
        "group",
        metadata(f.scope, previous ? [previous] : []),
        graph.revision,
      );
      const id = required(
        graph.tasks.find((t) => !existing.has(t.taskID)),
      ).taskID;
      if (level < 5) {
        const execution = await accounting.service.runnerTransition(
          "group",
          id,
          { kind: "execute" },
          graph.revision,
          (sql, context) => {
            calls++;
            return accounting.admit("execution")(sql, context);
          },
        );
        graph = execution.graph;
        accounting.outcome(execution.value, "completed");
        graph = (
          await accounting.service.runnerAccount(
            "group",
            id,
            graph.revision,
            () => ++calls,
          )
        ).graph;
      } else {
        await expect(
          f.service.runnerTransition(
            "group",
            id,
            { kind: "execute" },
            graph.revision,
            () => ++calls,
          ),
        ).rejects.toMatchObject({ code: "conflict" });
        expect(await f.service.get("group")).toEqual(graph);
      }
      previous = id;
    }
    expect(calls).toBe(8);
    const before = new Set(graph.tasks.map((t) => t.taskID));
    graph = await f.service.create("group", metadata(f.scope), graph.revision);
    const independent = required(
      graph.tasks.find((t) => !before.has(t.taskID)),
    ).taskID;
    await expect(
      f.service.runnerTransition(
        "group",
        independent,
        { kind: "execute" },
        graph.revision,
        () => Promise.resolve("not synchronous"),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await f.service.get("group")).toEqual(graph);
    const childBefore = new Set(graph.tasks.map((t) => t.taskID));
    graph = await f.service.create(
      "group",
      metadata(f.scope, [independent]),
      graph.revision,
    );
    const child = required(
      graph.tasks.find((t) => !childBefore.has(t.taskID)),
    ).taskID;
    await expect(
      f.service.runnerTransition(
        "group",
        child,
        { kind: "execute" },
        graph.revision,
        () => ++calls,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(calls).toBe(8);
  } finally {
    f.cleanup();
  }
});

test("runner cancellation authorizes only group scope and requires confirmed cancellation before blocking dependents", async () => {
  const f = fixture(true);
  try {
    const accounting = accountingFixture(f);
    const other = { ...f.scope, sessionID: "other", projectID: "other" };
    let graph = await f.service.create("group", metadata(other), 0);
    const taskID = required(graph.tasks[0]).taskID;
    graph = (
      await accounting.service.runnerTransition(
        "group",
        taskID,
        { kind: "execute" },
        graph.revision,
        () => null,
      )
    ).graph;
    graph = await f.service.create(
      "group",
      metadata(other, [taskID]),
      graph.revision,
    );
    const child = required(graph.tasks.find((t) => t.taskID !== taskID)).taskID;
    f.session();
    f.grant(f.scope);
    const cancellation = await accounting.service.runnerTransition(
      "group",
      taskID,
      { kind: "cancel" },
      graph.revision,
      accounting.admit("cancellation"),
    );
    graph = cancellation.graph;
    expect(graph.tasks.find((t) => t.taskID === taskID)?.state).toBe(
      "cancel_requested",
    );
    expect(graph.tasks.find((t) => t.taskID === child)?.state).toBe("pending");
    await expect(
      f.service.runnerTransition(
        "group",
        taskID,
        { kind: "outcome", outcome: "cancelled", evidence: "idle" } as never,
        graph.revision,
        () => null,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    accounting.outcome(cancellation.value, "cancelled");
    graph = (
      await accounting.service.runnerAccount(
        "group",
        taskID,
        graph.revision,
        () => null,
      )
    ).graph;
    expect(graph.tasks.find((t) => t.taskID === child)?.state).toBe("blocked");
    await expect(
      f.service.runnerTransition(
        "group",
        taskID,
        { kind: "execute" },
        graph.revision,
        () => null,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    f.grant(other);
    await expect(
      f.service.runnerTransition(
        "group",
        taskID,
        { kind: "execute" },
        graph.revision,
        () => null,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  } finally {
    f.cleanup();
  }
});

test("runner admission CAS across two canonical file writers cannot exceed four active tasks", async () => {
  const f = fixture(true);
  const second = f.reopen();
  try {
    const writer = new Tasks(second, f.identity, f.policy, () => 1000);
    let graph = await f.service.get("group");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      graph = await f.service.create(
        "group",
        metadata(f.scope),
        graph.revision,
      );
      ids.push(
        required(graph.tasks.find((t) => !ids.includes(t.taskID))).taskID,
      );
    }
    for (const id of ids.slice(0, 3))
      graph = (
        await f.service.runnerTransition(
          "group",
          id,
          { kind: "execute" },
          graph.revision,
          () => null,
        )
      ).graph;
    const results = await Promise.allSettled([
      f.service.runnerTransition(
        "group",
        required(ids[3]),
        { kind: "execute" },
        graph.revision,
        () => null,
      ),
      writer.runnerTransition(
        "group",
        required(ids[4]),
        { kind: "execute" },
        graph.revision,
        () => null,
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "conflict" },
    });
    graph = await f.service.get("group");
    expect(graph.tasks.filter((t) => t.state === "running").length).toBe(4);
    const pending = required(graph.tasks.find((t) => t.state === "pending"));
    await expect(
      writer.runnerTransition(
        "group",
        pending.taskID,
        { kind: "execute" },
        graph.revision,
        () => null,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await f.service.get("group")).toEqual(graph);
  } finally {
    second.close();
    f.cleanup();
  }
});

test("runner once approval is consumed only with committed transition and local intent, never reads or rollback", async () => {
  const f = fixture(true);
  try {
    let graph = await f.service.create("group", metadata(f.scope), 0);
    const taskID = required(graph.tasks[0]).taskID;
    const p = await f.identity.current();
    if (!p) throw new Error("missing fixture principal");
    const approval = {
      principal: p,
      target: f.scope,
      capability: "task.dispatch",
      revision: 1,
      mode: "once",
      expiresAt: new Date(100000).toISOString(),
    };
    f.storage.transaction((sql) => {
      sql.exec("CREATE TABLE synthetic_approval(body TEXT NOT NULL)");
      sql
        .query("INSERT INTO synthetic_approval VALUES (?)")
        .run(JSON.stringify(approval));
    });
    const readApproval = () =>
      f.storage.transaction((sql) =>
        JSON.parse(
          required(
            sql
              .query<{ body: string }, []>(
                "SELECT body FROM synthetic_approval",
              )
              .get() ?? undefined,
          ).body,
        ),
      );
    const accounting = accountingFixture(f, {
      load(sql) {
        return {
          ...f.policy.load(),
          profile: "supervised",
          approval: JSON.parse(
            required(
              sql
                .query<{ body: string }, []>(
                  "SELECT body FROM synthetic_approval",
                )
                .get() ?? undefined,
            ).body,
          ),
        };
      },
      save(sql, snapshot) {
        sql
          .query("UPDATE synthetic_approval SET body=?")
          .run(JSON.stringify(snapshot.approval));
      },
    });
    const supervised = accounting.service;
    expect(await supervised.get("group")).toEqual(graph);
    expect(readApproval()).toEqual(approval);
    await expect(
      supervised.runnerTransition(
        "group",
        taskID,
        { kind: "execute" },
        graph.revision,
        () => {
          throw new DomainError("conflict");
        },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(readApproval()).toEqual(approval);
    expect(await supervised.get("group")).toEqual(graph);
    const execution = await supervised.runnerTransition(
      "group",
      taskID,
      { kind: "execute" },
      graph.revision,
      accounting.admit("execution"),
    );
    graph = execution.graph;
    expect(execution.value.taskGeneration).toBe(1);
    expect(readApproval()).toBeNull();
    expect(
      await supervised.runnerJournal(
        "group",
        taskID,
        graph.revision,
        (_sql, context) => context.taskGeneration,
      ),
    ).toBe(1);
    expect(readApproval()).toBeNull();
    accounting.outcome(execution.value, "completed");
    graph = (
      await supervised.runnerAccount(
        "group",
        taskID,
        graph.revision,
        (_sql, context) => {
          expect(context.taskGeneration).toBe(1);
          return null;
        },
      )
    ).graph;
    expect(graph.tasks.find((t) => t.taskID === taskID)?.state).toBe(
      "completed",
    );
    expect(readApproval()).toBeNull();
    expect(await supervised.get("group")).toEqual(graph);
  } finally {
    f.cleanup();
  }
});

test("supervised cancellation is a new once action but its confirmed accounting never consumes a second approval", async () => {
  const f = fixture(true);
  try {
    const p = await f.identity.current();
    if (!p) throw new Error("missing fixture identity");
    f.storage.transaction((sql) =>
      sql.exec(
        "CREATE TABLE synthetic_cancel_approval(body TEXT NOT NULL); INSERT INTO synthetic_cancel_approval VALUES ('null')",
      ),
    );
    const approve = () =>
      f.storage.transaction((sql) => {
        const body = JSON.stringify({
          principal: p,
          target: f.scope,
          capability: "task.dispatch",
          revision: 1,
          mode: "once",
          expiresAt: new Date(100000).toISOString(),
        });
        sql.query("UPDATE synthetic_cancel_approval SET body=?").run(body);
      });
    const policy: GrantPolicyPort = {
      load(sql) {
        return {
          ...f.policy.load(),
          profile: "supervised",
          approval: JSON.parse(
            required(
              sql
                .query<{ body: string }, []>(
                  "SELECT body FROM synthetic_cancel_approval",
                )
                .get() ?? undefined,
            ).body,
          ),
        };
      },
      save(sql, snapshot) {
        sql
          .query("UPDATE synthetic_cancel_approval SET body=?")
          .run(JSON.stringify(snapshot.approval));
      },
    };
    const a = accountingFixture(f, policy);
    let graph = await f.service.create("group", metadata(f.scope), 0);
    const taskID = required(graph.tasks[0]).taskID;
    approve();
    graph = (
      await a.service.runnerTransition(
        "group",
        taskID,
        { kind: "execute" },
        graph.revision,
        a.admit("execution"),
      )
    ).graph;
    await expect(
      a.service.runnerTransition(
        "group",
        taskID,
        { kind: "cancel" },
        graph.revision,
        a.admit("cancellation"),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    approve();
    const cancellation = await a.service.runnerTransition(
      "group",
      taskID,
      { kind: "cancel" },
      graph.revision,
      a.admit("cancellation"),
    );
    graph = cancellation.graph;
    expect(cancellation.value.taskGeneration).toBe(1);
    a.outcome(cancellation.value, "cancelled");
    expect(
      f.sql.query("SELECT body FROM synthetic_cancel_approval").get(),
    ).toEqual({ body: "null" });
    graph = (
      await a.service.runnerAccount(
        "group",
        taskID,
        graph.revision,
        (_sql, ctx) => {
          expect(ctx.taskGeneration).toBe(1);
          return null;
        },
      )
    ).graph;
    expect(graph.tasks.find((t) => t.taskID === taskID)?.state).toBe(
      "cancelled",
    );
    expect(
      f.sql.query("SELECT body FROM synthetic_cancel_approval").get(),
    ).toEqual({ body: "null" });
  } finally {
    f.cleanup();
  }
});
