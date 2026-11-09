import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  capabilities,
  type Principal,
  type SessionRef,
} from "../../src/contracts";
import { GROUPS_MIGRATION } from "../../src/groups/service";
import { USAGE_MIGRATION, UsageService } from "../../src/observability/usage";
import {
  RUNNER_MIGRATION,
  Runner,
  runnerAdmissionEvidence,
  runnerOutcomeEvidence,
  type TaskOutcome,
} from "../../src/orchestration/runner";
import { TASKS_MIGRATION, Tasks } from "../../src/orchestration/tasks";
import { Persistence } from "../../src/persistence/database";
import type { Operation } from "../../src/persistence/operations";

test("real Tasks + Runner + Usage rollback snapshot failure, preserve received receipt, retry same evidence", async () => {
  const sql = new Database(":memory:");
  const storage = new Persistence(sql, () => {});
  const scope: SessionRef = {
    version: 1,
    instanceID: "fixture",
    projectID: "project",
    sessionID: "owner",
  };
  const principal: Principal = {
    kind: "operator",
    instanceID: "fixture",
    operatorID: "synthetic",
    revision: 1,
  };
  const identity = { current: async () => principal };
  let snapshotFails = true;
  let receipt: TaskOutcome | null = null;
  let sends = 0;
  let estimate: number | null = 2;
  let failAfterReserve = false;
  let supervised = false;
  try {
    GROUPS_MIGRATION.apply(sql, "fixture");
    TASKS_MIGRATION.apply(sql, "fixture");
    RUNNER_MIGRATION.apply(sql, "fixture");
    USAGE_MIGRATION.apply(sql, "fixture");
    sql.exec("CREATE TABLE fixture_once(body TEXT NOT NULL)");
    sql.query("INSERT INTO fixture_once VALUES (?)").run(
      JSON.stringify({
        principal,
        target: scope,
        capability: "task.dispatch",
        revision: 1,
        mode: "once",
        expiresAt: new Date(100000).toISOString(),
      }),
    );
    sql.query("INSERT INTO groups_records VALUES (?,?)").run(
      "group",
      JSON.stringify({
        version: 1,
        groupID: "group",
        scope,
        owner: principal,
        kind: "group",
        name: "synthetic",
      }),
    );
    sql
      .query("INSERT INTO groups_members VALUES (?,?)")
      .run("group", JSON.stringify(scope));
    const tasks = new Tasks(
      storage,
      identity,
      {
        load: () => ({
          revision: 1,
          profile: supervised ? "supervised" : "manage",
          profileCapabilities: capabilities,
          policyCapabilities: capabilities,
          hostCapabilities: capabilities,
          deniedCapabilities: [],
          grants: [],
          operator: {
            operatorID: "synthetic",
            instanceID: "fixture",
            revision: 1,
            capabilities,
            projects: ["project"],
            expiresAt: null,
          },
          delegationCapabilities: null,
          approval: supervised
            ? JSON.parse(
                sql
                  .query<{ body: string }, []>("SELECT body FROM fixture_once")
                  .get()?.body ?? "null",
              )
            : null,
        }),
        save(_sql, value) {
          if (supervised && value.approval === null)
            sql.exec("DELETE FROM fixture_once");
        },
      },
      () => 1000,
      { admissions: runnerAdmissionEvidence, outcomes: runnerOutcomeEvidence },
    );
    const usage = new UsageService(
      storage,
      identity,
      { check() {} },
      { appendInTx() {} },
    );
    const adapter = usage.runnerAdapter({
      estimateReservation(db) {
        expect(db).toBe(sql);
        expect(db.inTransaction).toBe(true);
        expect(db.query("SELECT * FROM runner_intents").all()).toHaveLength(0);
        return estimate;
      },
      snapshot(db) {
        expect(db).toBe(sql);
        // Explicit synthetic local metrics, not evidence of a real host/provider.
        if (snapshotFails)
          return {
            session: scope,
            usage: { cost: { value: NaN, quality: "reported" } },
          };
        return {
          session: scope,
          usage: { cost: { value: 2, quality: "synthetic_import" } },
        };
      },
    });
    const operation: Operation = {
      operationID: "synthetic-operation",
      state: "pending",
      payloadHash: "synthetic",
      receiptID: null,
      channel: null,
    };
    const runner = new Runner(
      tasks,
      {
        request: async () => operation,
        deliver: async () => {
          sends++;
          return {
            ...operation,
            state: "admitted",
            receiptID: "synthetic",
            channel: "host",
          };
        },
        reconcile: async () => operation,
      },
      { inspect: async () => receipt },
      { snapshot: () => ({ expiresAt: 100000, expectedRevision: 1 }) },
      {
        record: adapter.record,
        reserve(db, evidence) {
          adapter.reserve(db, evidence);
          expect(
            db.query("SELECT * FROM usage_reservations").all(),
          ).toHaveLength(1);
          expect(db.query("SELECT * FROM runner_intents").all()).toHaveLength(
            0,
          );
          if (failAfterReserve)
            throw new Error("synthetic post-reserve failure");
        },
      },
      { record() {} },
      {
        deliver: async ({ operationID }) => ({
          operationID,
          state: "accepted",
        }),
        inspect: async (operationID) => ({ operationID, state: "accepted" }),
      },
      () => 1000,
    );
    const before = await tasks.get("group");
    const created = await tasks.create(
      "group",
      {
        objective: "synthetic",
        expectedResult: "explicit reply",
        executor: scope,
        dependencies: [],
      },
      before.revision,
    );
    const taskID = created.tasks[0]?.taskID;
    if (!taskID) throw new Error("missing fixture task");
    supervised = true;
    const initialGeneration = sql
      .query<{ generation: number }, [string]>(
        "SELECT generation FROM task_records WHERE task_id=?",
      )
      .get(taskID)?.generation;
    await usage.changeBudget("group", 3, 0, "initial-budget");
    // Unknown accumulated cost under a ceiling must roll back the entire transition.
    await expect(
      runner.execute("group", taskID, created.revision),
    ).rejects.toThrow();
    expect(await tasks.get("group")).toEqual(created);
    expect(sql.query("SELECT * FROM runner_intents").all()).toHaveLength(0);
    expect(sql.query("SELECT * FROM usage_reservations").all()).toHaveLength(0);
    expect(sends).toBe(0);
    expect(sql.query("SELECT * FROM fixture_once").all()).toHaveLength(1);
    expect(
      sql
        .query<{ generation: number }, [string]>(
          "SELECT generation FROM task_records WHERE task_id=?",
        )
        .get(taskID)?.generation,
    ).toBe(initialGeneration);
    storage.transaction((db) =>
      usage.recordSnapshotInTx(db, scope, {
        cost: { value: 2, quality: "synthetic_import" },
      }),
    );
    // Known spend plus trusted estimate exceeds ceiling, also before any intent/host.
    await expect(
      runner.execute("group", taskID, created.revision),
    ).rejects.toThrow();
    expect(await tasks.get("group")).toEqual(created);
    expect(sql.query("SELECT * FROM runner_intents").all()).toHaveLength(0);
    expect(sql.query("SELECT * FROM usage_reservations").all()).toHaveLength(0);
    expect(sends).toBe(0);
    expect(sql.query("SELECT * FROM fixture_once").all()).toHaveLength(1);
    expect(
      sql
        .query<{ generation: number }, [string]>(
          "SELECT generation FROM task_records WHERE task_id=?",
        )
        .get(taskID)?.generation,
    ).toBe(initialGeneration);
    storage.transaction((db) =>
      usage.recordSnapshotInTx(db, scope, {
        cost: { value: 0, quality: "synthetic_import" },
      }),
    );
    estimate = null;
    await expect(
      runner.execute("group", taskID, created.revision),
    ).rejects.toThrow();
    expect(await tasks.get("group")).toEqual(created);
    expect(sql.query("SELECT * FROM runner_intents").all()).toHaveLength(0);
    expect(sql.query("SELECT * FROM fixture_once").all()).toHaveLength(1);
    expect(
      sql
        .query<{ generation: number }, [string]>(
          "SELECT generation FROM task_records WHERE task_id=?",
        )
        .get(taskID)?.generation,
    ).toBe(initialGeneration);
    estimate = 2;
    failAfterReserve = true;
    await expect(
      runner.execute("group", taskID, created.revision),
    ).rejects.toThrow();
    expect(await tasks.get("group")).toEqual(created);
    expect(sql.query("SELECT * FROM runner_intents").all()).toHaveLength(0);
    expect(sql.query("SELECT * FROM usage_reservations").all()).toHaveLength(0);
    expect(sql.query("SELECT * FROM fixture_once").all()).toHaveLength(1);
    expect(
      sql
        .query<{ generation: number }, [string]>(
          "SELECT generation FROM task_records WHERE task_id=?",
        )
        .get(taskID)?.generation,
    ).toBe(initialGeneration);
    expect(sends).toBe(0);
    failAfterReserve = false;
    await runner.execute("group", taskID, created.revision);
    expect(sql.query("SELECT * FROM fixture_once").all()).toHaveLength(0);
    supervised = false;
    expect(sql.query("SELECT * FROM usage_reservations").all()).toHaveLength(1);
    const revision = (await tasks.get("group")).revision;
    await runner.work("group", taskID, revision);
    const intent = sql
      .query<
        {
          admission_id: string;
          operation_id: string;
          correlation_id: string;
          task_generation: number;
        },
        []
      >("SELECT * FROM runner_intents")
      .get();
    if (!intent) throw new Error("missing fixture intent");
    receipt = {
      admissionID: intent.admission_id,
      operationID: intent.operation_id,
      correlationID: intent.correlation_id,
      taskGeneration: intent.task_generation,
      state: "completed",
      evidence: "synthetic trusted outcome",
    };
    await expect(runner.collect("group", taskID, revision)).rejects.toThrow();
    expect((await tasks.get("group")).tasks[0]?.state).toBe("running");
    expect(sql.query("SELECT * FROM runner_outcomes").all()).toHaveLength(1);
    expect(sql.query("SELECT * FROM usage_receipts").all()).toHaveLength(0);
    expect((await usage.read(["group"])).cost.value).toBe(0);
    expect(sql.query("SELECT * FROM usage_reservations").all()).toHaveLength(1);
    // Host no longer supplies outcome; retry must use the already received receipt.
    receipt = null;
    snapshotFails = false;
    await runner.collect("group", taskID, revision);
    expect((await tasks.get("group")).tasks[0]?.state).toBe("completed");
    expect(sql.query("SELECT * FROM runner_outcomes").all()).toHaveLength(1);
    expect(sql.query("SELECT * FROM usage_receipts").all()).toHaveLength(1);
    expect((await usage.read(["group"])).cost).toEqual({
      value: 2,
      quality: "synthetic_import",
    });
    expect(sends).toBe(1);
    expect(sql.query("SELECT * FROM usage_reservations").all()).toHaveLength(0);
  } finally {
    sql.close();
  }
});
