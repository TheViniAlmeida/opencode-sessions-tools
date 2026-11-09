import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { AuthorizationSnapshot } from "../../src/authorization/authorize";
import {
  canonical,
  capabilities,
  type Principal,
  type SessionRef,
} from "../../src/contracts";
import { GROUPS_MIGRATION } from "../../src/groups/service";
import {
  questionsRunnerPort,
  REQUESTS_MIGRATION,
  Requests,
  type TaskQuestion,
} from "../../src/orchestration/requests";
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

async function fixture(state: "awaiting_input" | "awaiting_approval") {
  const root = mkdtempSync(
    "/tmp/opencode/opencode-sessions-tools/t24-requests-join-",
  );
  const sql = new Database(`${root}/synthetic.sqlite`);
  try {
    sql.exec("PRAGMA foreign_keys=ON");
    for (const migration of [
      GROUPS_MIGRATION,
      TASKS_MIGRATION,
      RUNNER_MIGRATION,
      REQUESTS_MIGRATION,
    ])
      migration.apply(sql, "synthetic");
    const storage = new Persistence(sql, () => {});
    const owner: Principal = {
      kind: "operator",
      operatorID: "synthetic",
      instanceID: "fixture",
      revision: 1,
    };
    const target: SessionRef = {
      version: 1,
      instanceID: "fixture",
      projectID: "project",
      sessionID: "executor",
    };
    const identity = { current: async () => owner };
    const policy = {
      load: (): AuthorizationSnapshot => ({
        revision: 1,
        profile: "manage",
        profileCapabilities: capabilities,
        policyCapabilities: capabilities,
        hostCapabilities: capabilities,
        deniedCapabilities: [],
        grants: [],
        operator: {
          ...owner,
          capabilities,
          projects: ["project"],
          expiresAt: null,
        },
        delegationCapabilities: null,
        approval: null,
      }),
      save() {},
    };
    sql.query("INSERT INTO groups_records VALUES(?,?)").run(
      "group",
      canonical({
        version: 1,
        groupID: "group",
        kind: "group",
        name: "synthetic",
        scope: target,
        owner,
      }),
    );
    const tasks = new Tasks(storage, identity, policy, () => 1000, {
      admissions: runnerAdmissionEvidence,
      outcomes: runnerOutcomeEvidence,
    });
    const requests = new Requests(
      storage,
      identity,
      { current: () => owner },
      {
        snapshot: () => ({
          respondent: owner,
          target,
          policyRevision: 1,
          expiresAt: 10000,
        }),
      },
      () => 1000,
    );
    let outcome: TaskOutcome | null = null;
    let operation: Operation = {
      operationID: "synthetic-operation",
      state: "pending",
      payloadHash: "synthetic",
      receiptID: null,
      channel: null,
    };
    const dispatcher = {
      request: async () => operation,
      deliver: async () => {
        operation = { ...operation, state: "admitted" };
        return operation;
      },
      reconcile: async () => operation,
    };
    const composed = questionsRunnerPort(requests);
    const build = (withHook: boolean) =>
      new Runner(
        tasks,
        dispatcher,
        { inspect: async () => outcome },
        { snapshot: () => ({ expiresAt: 100000, expectedRevision: 1 }) },
        {
          reserve() {
            /* Explicit synthetic fixture: no production budget wiring. */
          },
          record() {},
        },
        withHook ? composed : requests,
        {
          deliver: async ({ operationID }) => ({
            operationID,
            state: "accepted",
          }),
          inspect: async (operationID) => ({
            operationID,
            state: "unknown_outcome",
          }),
        },
        () => 1000,
      );
    const graph = await tasks.create(
      "group",
      {
        objective: "synthetic",
        expectedResult: "explicit",
        executor: target,
        dependencies: [],
      },
      0,
    );
    const taskID = graph.tasks[0]?.taskID;
    if (!taskID) throw new Error("missing task");
    const runner = build(true);
    const admitted = await runner.execute("group", taskID, graph.revision);
    await runner.work("group", taskID, admitted.graph.revision);
    const evidence = runnerAdmissionEvidence.lookup(
      sql,
      "group",
      taskID,
      owner,
      "journal",
    );
    if (!evidence?.operationID) throw new Error("missing operation");
    const receipt = (next: TaskOutcome["state"]): TaskOutcome => ({
      admissionID: evidence.admissionID,
      operationID: evidence.operationID ?? "",
      correlationID: evidence.correlationID,
      taskGeneration: evidence.taskGeneration,
      state: next,
      evidence: "synthetic trusted host receipt",
    });
    outcome = receipt(state);
    const waiting = await runner.collect(
      "group",
      taskID,
      admitted.graph.revision,
    );
    if (!waiting) throw new Error("missing wait");
    const row = sql
      .query<{ body: string }, []>("SELECT body FROM task_questions")
      .get();
    if (!row) throw new Error("missing question");
    const question: TaskQuestion = JSON.parse(row.body);
    return {
      sql,
      tasks,
      requests,
      runner,
      build,
      taskID,
      question,
      revision: waiting.graph.revision,
      running() {
        outcome = receipt("running");
      },
      respond: () =>
        requests.respondAsOperator(question.requestID, {
          revision: question.policyRevision,
          admissionID: question.admissionID,
          operationID: question.operationID,
          correlationID: question.correlationID,
          taskGeneration: question.taskGeneration,
          target: question.target,
          ...(state === "awaiting_input"
            ? {
                decision: "answer" as const,
                content: "SYNTHETIC_RESPONSE_NOT_FOR_AUDIT",
              }
            : { decision: "once" as const }),
        }),
      close() {
        sql.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    sql.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

for (const state of ["awaiting_input", "awaiting_approval"] as const) {
  test(`Runner + Requests + Tasks: ${state} cannot resume without response, consumed once on real route`, async () => {
    const f = await fixture(state);
    try {
      f.running();
      await expect(
        f.runner.collect("group", f.taskID, f.revision),
      ).rejects.toThrow();
      expect((await f.tasks.get("group")).tasks[0]?.state).toBe(state);
      expect(
        f.sql
          .query<{ consumed: number }, []>(
            "SELECT consumed FROM task_questions",
          )
          .get()?.consumed,
      ).toBe(0);
      await f.respond();
      // A pre-response running receipt cannot satisfy the response sequence gate.
      await expect(
        f.runner.collect("group", f.taskID, f.revision),
      ).rejects.toThrow();
      expect((await f.tasks.get("group")).tasks[0]?.state).toBe(state);
    } finally {
      f.close();
    }
  });

  test(`Runner + Requests + Tasks: ${state} post-response running receipt resumes exactly once`, async () => {
    const f = await fixture(state);
    try {
      await f.respond();
      f.running();
      // Default Requests port has no resumeTask: generic collect must fail closed.
      await expect(
        f.build(false).collect("group", f.taskID, f.revision),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect((await f.tasks.get("group")).tasks[0]?.state).toBe(state);
      expect(
        f.sql
          .query<{ consumed: number }, []>(
            "SELECT consumed FROM task_questions",
          )
          .get()?.consumed,
      ).toBe(0);
      const resumed = await f.runner.collect("group", f.taskID, f.revision);
      expect(resumed?.graph.tasks[0]?.state).toBe("running");
      expect(
        f.sql
          .query<{ consumed: number }, []>(
            "SELECT consumed FROM task_questions",
          )
          .get()?.consumed,
      ).toBe(1);
      if (!resumed) throw new Error("missing resume");
      await expect(
        f.runner.collect("group", f.taskID, resumed.graph.revision),
      ).rejects.toThrow();
      await expect(
        f.requests.resume(
          f.tasks,
          f.question.requestID,
          resumed.graph.revision,
        ),
      ).rejects.toThrow();
      expect((await f.tasks.get("group")).revision).toBe(
        resumed.graph.revision,
      );
      const audit = f.sql
        .query<{ kind: string; actor: string | null }, []>(
          "SELECT kind,actor FROM question_audit ORDER BY sequence",
        )
        .all();
      expect(audit.filter((event) => event.kind === "consumed")).toHaveLength(
        1,
      );
      expect(JSON.stringify(audit)).not.toContain(
        "SYNTHETIC_RESPONSE_NOT_FOR_AUDIT",
      );
    } finally {
      f.close();
    }
  });
}
