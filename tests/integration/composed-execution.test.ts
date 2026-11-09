import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { AuthorizationSnapshot } from "../../src/authorization/authorize";
import {
  type ComposedExecutionOptions,
  createComposedExecution,
} from "../../src/composition/execution";
import { createCompositionRuntime } from "../../src/composition/runtime";
import { createComposedServices } from "../../src/composition/services";
import {
  canonical,
  capabilities,
  DomainError,
  type Principal,
  type SessionRef,
} from "../../src/contracts";
import type { NativePrompt } from "../../src/messaging/dispatcher";
import type { TaskQuestion } from "../../src/orchestration/requests";
import {
  runnerAdmissionEvidence,
  type TaskOutcome,
} from "../../src/orchestration/runner";
import { taskActiveWork } from "../../src/orchestration/tasks";

type Execution = ReturnType<typeof createComposedExecution>;

/** All external evidence here is TEST ONLY. This is a real local SQLite graph,
 * not a native host/provider test. Bootstrap SQL only seeds persisted authority. */
function fixture() {
  const root = mkdtempSync(
    "/tmp/opencode/opencode-sessions-tools/composed-execution-",
  );
  const runtime = createCompositionRuntime({
    databasePath: `${root}/state.sqlite`,
    repositoryPath: process.cwd(),
    instanceID: "fixture",
    scopeID: "scope",
    installationID: "installation",
  });
  const target: SessionRef = {
    version: 1,
    instanceID: "fixture",
    projectID: "project",
    sessionID: "executor",
  };
  const owner = {
    kind: "operator" as const,
    instanceID: "fixture",
    operatorID: "test-only",
    revision: 1,
  };
  let execution: Execution | null = null;
  let now = 1000;
  let outcome: TaskOutcome | null = null;
  let cancellationCalls = 0;
  let schedulerClockFails = false;
  const sends: NativePrompt[] = [];
  const timers = new Set<() => void>();
  const wakes = new Map<string, Set<() => void>>();
  const unavailable = (): never => {
    throw new DomainError("unavailable");
  };
  const services = createComposedServices({
    runtime,
    clock: () => now,
    sessions: {
      resolve: async ({ sessionID }) =>
        sessionID === target.sessionID ? target : null,
    },
    operators: { current: async () => owner },
    discovery: {
      candidates: async () => [target],
      get: async () => null,
      links: async () => [],
    },
    activeWork: {
      snapshot(sql, groupID) {
        if (!execution) return unavailable();
        return taskActiveWork(
          runtime.persistence,
          execution.scheduler.jobs,
        ).snapshot(sql, groupID);
      },
    },
    memoryGroups: {
      check(sql, scope, principal) {
        if (
          !scope.groupID ||
          canonical(principal) !== canonical(owner) ||
          canonical(scope.session) !== canonical(target)
        )
          throw new DomainError("forbidden");
        services.policy.load(sql, principal, target);
      },
    },
    importHost: {
      preflight: unavailable,
      importNewSession: async () => unavailable(),
    },
    importDestination: { check: unavailable },
    exportHost: { transcript: async () => unavailable() },
    remainingCleanup: {
      cleanup() {
        return unavailable();
      },
    },
  });
  const seed = (principal: Principal) =>
    runtime.persistence.transaction((sql) => {
      const snapshot: AuthorizationSnapshot = {
        revision: 1,
        profile: "manage",
        profileCapabilities: capabilities,
        policyCapabilities: capabilities,
        hostCapabilities: capabilities,
        deniedCapabilities: [],
        grants: [],
        delegationCapabilities: capabilities,
        approval: null,
        operator:
          principal.kind === "operator"
            ? {
                operatorID: owner.operatorID,
                instanceID: owner.instanceID,
                revision: 1,
                capabilities,
                projects: [target.projectID],
                expiresAt: null,
              }
            : null,
      };
      sql
        .query("INSERT INTO composition_policies VALUES (?,?,?,?,?,?)")
        .run(
          target.instanceID,
          target.projectID,
          target.sessionID,
          canonical(principal),
          1,
          JSON.stringify(snapshot),
        );
    });
  seed(owner);
  seed({ kind: "session", session: target });
  const assertAuthority = (sql: Database, principal: Principal) => {
    if (canonical(principal) !== canonical(owner))
      throw new DomainError("forbidden");
    const snapshot = services.policy.load(sql, principal, target);
    if (
      snapshot.revision !== 1 ||
      !snapshot.policyCapabilities.includes("manage") ||
      snapshot.deniedCapabilities.includes("manage")
    )
      throw new DomainError("forbidden");
  };
  const options: ComposedExecutionOptions = {
    runtime,
    services,
    clock: () => now,
    chain: { current: async () => null },
    promptHost: {
      async send(prompt) {
        sends.push(prompt);
        return { state: "accepted", messageID: prompt.messageID };
      },
      async inspect(prompt) {
        if (
          !sends.some(
            (sent) =>
              sent.operationID === prompt.operationID &&
              sent.payloadHash === prompt.payloadHash,
          )
        )
          return { state: "unknown_outcome" };
        return {
          state: "accepted",
          messageID: prompt.messageID,
          payloadHash: prompt.payloadHash,
        };
      },
    },
    outcomes: {
      inspect: async (operationID) =>
        outcome?.operationID === operationID ? outcome : null,
    },
    promptPolicy: {
      snapshot(task) {
        return runtime.persistence.transaction((sql) => {
          const snapshot = services.policy.load(sql, owner, task.executor);
          return { expiresAt: 100000, expectedRevision: snapshot.revision };
        });
      },
    },
    cancellation: {
      async deliver({ operationID }) {
        cancellationCalls++;
        return { operationID, state: "accepted" };
      },
      inspect: async (operationID) => ({ operationID, state: "accepted" }),
    },
    questionOperator: { current: () => owner },
    questionPolicy: {
      snapshot(sql, binding) {
        assertAuthority(sql, binding.owner);
        return {
          respondent: owner,
          target,
          policyRevision: 1,
          expiresAt: 100000,
        };
      },
    },
    usageAccess: {
      check(sql, principal, ref) {
        if (canonical(ref) !== canonical(target))
          throw new DomainError("forbidden");
        assertAuthority(sql, principal);
      },
    },
    usageSource: {
      estimateReservation(sql, evidence) {
        assertAuthority(sql, evidence.principal);
        return 2;
      },
      snapshot(sql, evidence) {
        assertAuthority(sql, owner);
        if (
          !outcome ||
          evidence.operationID !== outcome.operationID ||
          canonical(evidence.outcome) !== canonical(outcome)
        )
          throw new DomainError("unavailable");
        return {
          session: target,
          usage: { cost: { value: 2, quality: "synthetic_import" } },
        };
      },
    },
    replyWakes: {
      subscribe(id, wake) {
        const set = wakes.get(id) ?? new Set();
        set.add(wake);
        wakes.set(id, set);
        return () => {
          set.delete(wake);
        };
      },
      publish(id) {
        for (const wake of wakes.get(id) ?? []) wake();
      },
    },
    replyTimers: {
      schedule(_milliseconds, wake) {
        timers.add(wake);
        return () => {
          timers.delete(wake);
        };
      },
    },
    scheduler: {
      clock: {
        utc: () => {
          if (schedulerClockFails) unavailable();
          return now;
        },
        monotonic: () => now,
        setTimer(_delay, callback) {
          timers.add(callback);
          return () => {
            timers.delete(callback);
          };
        },
      },
      coordinator: {
        now(sql) {
          runtime.persistence.transaction((current) => {
            if (current !== sql || !sql.inTransaction) unavailable();
          });
          return now;
        },
      },
      limits: {
        assert(sql, job) {
          assertAuthority(sql, job.owner);
        },
      },
      outcomes: { inspect: async () => null },
    },
  };
  const build = () => {
    execution = createComposedExecution(options);
    return execution;
  };
  const run = <T>(call: () => Promise<T>) =>
    services.identity.runWithAuthenticatedOperator(call);
  const add = async () => {
    const graph = execution ?? unavailable();
    const group = await services.groups.create(
      target,
      { kind: "group", name: "synthetic" },
      1,
    );
    await services.groups.addMember(group.groupID, target, 1);
    const created = await graph.tasks.create(
      group.groupID,
      {
        objective: "synthetic execution",
        expectedResult: "correlated result",
        executor: target,
        dependencies: [],
      },
      0,
    );
    const taskID = created.tasks[0]?.taskID ?? unavailable();
    return { groupID: group.groupID, taskID, revision: created.revision };
  };
  const receipt = (
    groupID: string,
    taskID: string,
    state: TaskOutcome["state"],
  ) =>
    runtime.persistence.transaction((sql) => {
      const admission = runnerAdmissionEvidence.lookup(
        sql,
        groupID,
        taskID,
        owner,
        "journal",
      );
      if (!admission?.operationID) return unavailable();
      outcome = {
        admissionID: admission.admissionID,
        operationID: admission.operationID,
        correlationID: admission.correlationID,
        taskGeneration: admission.taskGeneration,
        state,
        evidence: "TEST ONLY trusted deterministic terminal evidence",
      };
      return outcome;
    });
  return {
    runtime,
    services,
    options,
    target,
    owner,
    sends,
    timers,
    build,
    run,
    add,
    receipt,
    cancellations: () => cancellationCalls,
    advance: (value: number) => {
      now = value;
    },
    failSchedulerClock: (value: boolean) => {
      schedulerClockFails = value;
    },
    close() {
      execution?.dispose();
      runtime.dispose();
      rmSync(root, { recursive: true });
    },
  };
}

test("LOCALREAL task admission -> real Dispatcher host acceptance -> persisted correlated terminal -> budget release", async () => {
  const f = fixture();
  try {
    const graph = f.build();
    await f.run(async () => {
      expect(f.timers.size).toBe(0);
      const task = await f.add();
      await graph.usage.changeBudget(task.groupID, 10, 0, "fixture-budget");
      const events = await f.services.events.read({ target: f.target });
      expect(
        events.items.filter((event) => event.kind === "budget.changed"),
      ).toHaveLength(1);
      expect(
        events.items.find((event) => event.kind === "budget.changed")?.actor,
      ).toEqual(f.owner);
      f.runtime.persistence.transaction((sql) =>
        graph.usage.recordSnapshotInTx(sql, f.target, {
          cost: { value: 0, quality: "synthetic_import" },
        }),
      );
      const admitted = await graph.runner.execute(
        task.groupID,
        task.taskID,
        task.revision,
      );
      expect(f.sends).toHaveLength(0);
      await graph.runner.work(
        task.groupID,
        task.taskID,
        admitted.graph.revision,
      );
      expect(f.sends).toHaveLength(1);
      expect(
        await graph.runner.collect(
          task.groupID,
          task.taskID,
          admitted.graph.revision,
        ),
      ).toBeNull();
      const evidence = f.receipt(task.groupID, task.taskID, "completed");
      const collected = await graph.runner.collect(
        task.groupID,
        task.taskID,
        admitted.graph.revision,
      );
      expect(collected?.graph.tasks[0]?.state).toBe("completed");
      expect(f.sends[0]?.operationID).toBe(evidence.operationID);
      f.runtime.persistence.transaction((sql) => {
        expect(sql.query("SELECT * FROM runner_outcomes").all()).toHaveLength(
          1,
        );
        expect(
          sql.query("SELECT * FROM usage_reservations").all(),
        ).toHaveLength(0);
      });
    });
  } finally {
    f.close();
  }
});

test("LOCALREAL unknown accumulated budget blocks before runner intent or Dispatcher send", async () => {
  const f = fixture();
  try {
    const graph = f.build();
    await f.run(async () => {
      const task = await f.add();
      await graph.usage.changeBudget(task.groupID, 10, 0, "unknown-budget");
      await expect(
        graph.runner.execute(task.groupID, task.taskID, task.revision),
      ).rejects.toThrow();
      expect((await graph.tasks.get(task.groupID)).revision).toBe(
        task.revision,
      );
      expect(f.sends).toHaveLength(0);
      f.runtime.persistence.transaction((sql) => {
        expect(sql.query("SELECT * FROM runner_intents").all()).toHaveLength(0);
        expect(sql.query("SELECT * FROM operations").all()).toHaveLength(0);
      });
    });
  } finally {
    f.close();
  }
});

test("LOCALREAL awaiting_input -> Requests.respondAsOperator -> canonical Runner resume consumes once", async () => {
  const f = fixture();
  try {
    const graph = f.build();
    await f.run(async () => {
      const task = await f.add();
      const admitted = await graph.runner.execute(
        task.groupID,
        task.taskID,
        task.revision,
      );
      await graph.runner.work(
        task.groupID,
        task.taskID,
        admitted.graph.revision,
      );
      f.receipt(task.groupID, task.taskID, "awaiting_input");
      const waiting = await graph.runner.collect(
        task.groupID,
        task.taskID,
        admitted.graph.revision,
      );
      expect(waiting?.graph.tasks[0]?.state).toBe("awaiting_input");
      const question = f.runtime.persistence.transaction((sql) => {
        const row = sql
          .query<{ body: string }, []>("SELECT body FROM task_questions")
          .get();
        if (!row) throw new Error("missing question");
        return JSON.parse(row.body) as TaskQuestion;
      });
      await graph.requests.respondAsOperator(question.requestID, {
        revision: question.policyRevision,
        admissionID: question.admissionID,
        operationID: question.operationID,
        correlationID: question.correlationID,
        taskGeneration: question.taskGeneration,
        target: question.target,
        decision: "answer",
        content: "TEST ONLY answer",
      });
      f.receipt(task.groupID, task.taskID, "running");
      const resumed = await graph.runner.collect(
        task.groupID,
        task.taskID,
        waiting?.graph.revision ?? -1,
      );
      expect(resumed?.graph.tasks[0]?.state).toBe("running");
      await expect(
        graph.runner.collect(
          task.groupID,
          task.taskID,
          resumed?.graph.revision ?? -1,
        ),
      ).rejects.toThrow();
      await expect(
        graph.requests.resume(
          graph.tasks,
          question.requestID,
          resumed?.graph.revision ?? -1,
        ),
      ).rejects.toThrow();
      f.runtime.persistence.transaction((sql) =>
        expect(
          sql
            .query<{ consumed: number }, []>(
              "SELECT consumed FROM task_questions",
            )
            .get()?.consumed,
        ).toBe(1),
      );
      f.runtime.persistence.transaction((sql) => {
        const audit = sql
          .query<{ kind: string }, []>("SELECT kind FROM question_audit")
          .all();
        expect(audit.filter((event) => event.kind === "consumed")).toHaveLength(
          1,
        );
      });
    });
  } finally {
    f.close();
  }
});

test("LOCALREAL cancellation acceptance stays requested until correlated cancellation outcome", async () => {
  const f = fixture();
  try {
    const graph = f.build();
    await f.run(async () => {
      const task = await f.add();
      const admitted = await graph.runner.execute(
        task.groupID,
        task.taskID,
        task.revision,
      );
      await graph.runner.work(
        task.groupID,
        task.taskID,
        admitted.graph.revision,
      );
      const cancelled = await graph.runner.cancel(
        task.groupID,
        task.taskID,
        admitted.graph.revision,
      );
      await graph.runner.work(
        task.groupID,
        task.taskID,
        cancelled.graph.revision,
      );
      expect(f.cancellations()).toBe(1);
      expect((await graph.tasks.get(task.groupID)).tasks[0]?.state).toBe(
        "cancel_requested",
      );
      f.receipt(task.groupID, task.taskID, "cancelled");
      const terminal = await graph.runner.collect(
        task.groupID,
        task.taskID,
        cancelled.graph.revision,
      );
      expect(terminal?.graph.tasks[0]?.state).toBe("cancelled");
    });
  } finally {
    f.close();
  }
});

test("LOCALREAL active task and Scheduler.jobs prevent group deletion through late-bound trusted port", async () => {
  const f = fixture();
  try {
    const graph = f.build();
    await f.run(async () => {
      const task = await f.add();
      const admitted = await graph.runner.execute(
        task.groupID,
        task.taskID,
        task.revision,
      );
      await expect(
        f.services.groups.deleteGroup(task.groupID, 1),
      ).rejects.toThrow("conflict");
      await graph.runner.work(
        task.groupID,
        task.taskID,
        admitted.graph.revision,
      );
      f.receipt(task.groupID, task.taskID, "completed");
      await graph.runner.collect(
        task.groupID,
        task.taskID,
        admitted.graph.revision,
      );
      const job = await graph.scheduler.create(
        {
          target: f.target,
          content: "synthetic schedule",
          schedule: {
            version: 1,
            kind: "interval",
            timezone: "UTC",
            anchorUTC: "1970-01-01T00:00:01.000Z",
            periodMs: 300000,
          },
          expiresAt: 1000000,
          maxRuns: 1,
          groupID: task.groupID,
        },
        1,
      );
      await expect(
        f.services.groups.deleteGroup(task.groupID, 1),
      ).rejects.toThrow("conflict");
      await graph.scheduler.tick();
      expect(f.sends).toHaveLength(2);
      expect(f.sends[1]?.operationID).not.toBe(f.sends[0]?.operationID);
      expect(job.groupID).toBe(task.groupID);
      await graph.scheduler.tick();
      expect(f.sends).toHaveLength(2);
      f.runtime.persistence.transaction((sql) => {
        const rows = sql
          .query<{ operation_id: string; state: string }, []>(
            "SELECT operation_id,state FROM schedule_occurrences JOIN schedule_outbox USING(occurrence_id)",
          )
          .all();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.operation_id).toBe(f.sends[1]?.operationID);
        expect(rows[0]?.state).toBe("admitted");
      });
    });
  } finally {
    f.close();
  }
});

test("LOCALREAL manual supervisor shares one in-flight tick, reports isolated failure, dispose is idempotent", async () => {
  const f = fixture();
  try {
    const graph = f.build();
    expect(f.timers.size).toBe(0);
    f.failSchedulerClock(true);
    const first = graph.tick();
    expect(graph.tick()).toBe(first);
    const failures = await first;
    expect(failures.map((item) => item.phase)).toEqual(["scheduler.tick"]);
    expect(failures[0]?.error).toBeInstanceOf(DomainError);
    f.failSchedulerClock(false);
    expect(await graph.tick()).toEqual([]);
    graph.scheduler.start();
    expect(f.timers.size).toBe(1);
    graph.dispose();
    graph.dispose();
    expect(f.timers.size).toBe(0);
    await expect(graph.tick()).rejects.toThrow("unavailable");
  } finally {
    f.close();
  }
});

test("LOCALREAL every missing required native/authority method fails before execution construction", () => {
  const f = fixture();
  try {
    for (const key of Object.keys(f.options)) {
      expect(() =>
        createComposedExecution({ ...f.options, [key]: undefined }),
      ).toThrow("unavailable");
    }
    const cases: ComposedExecutionOptions[] = [
      {
        ...f.options,
        promptHost: { ...f.options.promptHost, send: undefined as never },
      },
      { ...f.options, usageAccess: { check: undefined as never } },
      {
        ...f.options,
        usageSource: { ...f.options.usageSource, snapshot: undefined as never },
      },
      { ...f.options, questionPolicy: { snapshot: undefined as never } },
      {
        ...f.options,
        cancellation: {
          ...f.options.cancellation,
          inspect: undefined as never,
        },
      },
      { ...f.options, replyTimers: { schedule: undefined as never } },
      {
        ...f.options,
        scheduler: {
          ...f.options.scheduler,
          clock: { ...f.options.scheduler.clock, setTimer: undefined as never },
        },
      },
    ];
    for (const options of cases)
      expect(() => createComposedExecution(options)).toThrow("unavailable");
    expect(f.timers.size).toBe(0);
    expect(f.sends).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("LOCALREAL session Dispatcher request -> synthetic host -> real Replies final, distinct from Runner terminal evidence", async () => {
  const f = fixture();
  try {
    const graph = f.build();
    await f.services.identity.runWithHostContext(
      { sessionID: f.target.sessionID },
      async () => {
        const operation = await graph.dispatcher.request({
          target: f.target,
          content: "TEST ONLY reply request",
          expiresAt: 100000,
          expectedRevision: 1,
          idempotencyKey: "reply-request",
        });
        await graph.dispatcher.deliver(operation.operationID, 1);
        await graph.replies.reply({
          requestID: operation.operationID,
          idempotencyKey: "reply-final",
          expectedRevision: 1,
          body: { type: "final", content: "TEST ONLY final reply" },
        });
        const page = await graph.replies.getResult(operation.operationID);
        expect(page).toBeDefined();
        expect(JSON.stringify(page)).toContain("TEST ONLY final reply");
        expect(f.sends).toHaveLength(1);
      },
    );
  } finally {
    f.close();
  }
});

test("LOCALREAL rejects forged graph and other runtime, canonical Events rejects foreign DB", async () => {
  const f = fixture();
  const other = fixture();
  try {
    expect(() =>
      createComposedExecution({ ...f.options, services: { ...f.services } }),
    ).toThrow("unavailable");
    expect(() =>
      createComposedExecution({ ...f.options, runtime: other.runtime }),
    ).toThrow("unavailable");
    f.build();
    other.runtime.persistence.transaction((sql) =>
      expect(() =>
        f.services.events.appendInTransaction(
          sql,
          {
            kind: "budget.changed",
            operationID: "foreign",
            target: f.target,
            payload: { revision: 1 },
          },
          f.owner,
        ),
      ).toThrow("unavailable"),
    );
  } finally {
    f.close();
    other.close();
  }
});

test("execution rejects missing trusted dependencies before constructing domains", () => {
  expect(() => createComposedExecution(undefined as never)).toThrow(
    "unavailable",
  );
});
