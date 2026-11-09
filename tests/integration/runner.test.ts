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
import type { PromptInput } from "../../src/messaging/dispatcher";
import {
  RUNNER_MIGRATION,
  Runner,
  type RunnerUsagePort,
  runnerAdmissionEvidence,
  runnerOutcomeEvidence,
  type TaskOutcome,
} from "../../src/orchestration/runner";
import { TASKS_MIGRATION, Tasks } from "../../src/orchestration/tasks";
import { Persistence } from "../../src/persistence/database";
import type { Operation } from "../../src/persistence/operations";

function fixture() {
  const root = mkdtempSync("/tmp/opencode/opencode-sessions-tools/t24-runner-");
  const first = new Database(`${root}/synthetic.sqlite`);
  first.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  GROUPS_MIGRATION.apply(first, "synthetic");
  TASKS_MIGRATION.apply(first, "synthetic");
  RUNNER_MIGRATION.apply(first, "synthetic");
  const second = new Database(`${root}/synthetic.sqlite`);
  second.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
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
  first.query("INSERT INTO groups_records VALUES(?,?)").run(
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
  let current: Principal | null = operator;
  let supervised = false;
  first.exec(
    "CREATE TABLE synthetic_approval(body TEXT NOT NULL); INSERT INTO synthetic_approval VALUES('null')",
  );
  const identity = { current: async () => current };
  const policy = {
    load: (sql: Database): AuthorizationSnapshot => ({
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
      approval: JSON.parse(
        sql
          .query<{ body: string }, []>("SELECT body FROM synthetic_approval")
          .get()?.body ?? "null",
      ),
    }),
    save(sql: Database, snapshot: AuthorizationSnapshot) {
      sql
        .query("UPDATE synthetic_approval SET body=?")
        .run(JSON.stringify(snapshot.approval));
    },
  };
  const ports = {
    admissions: runnerAdmissionEvidence,
    outcomes: runnerOutcomeEvidence,
  };
  const a = new Tasks(
    new Persistence(first, () => {}),
    identity,
    policy,
    () => 1000,
    ports,
  );
  const b = new Tasks(
    new Persistence(second, () => {}),
    identity,
    policy,
    () => 1000,
    ports,
  );
  const operations = new Map<string, Operation>();
  let sends = 0;
  let cancellations = 0;
  let crashCancellation = false;
  let crashAfterRequest = false;
  let inspectCount = 0;
  const dispatcher = {
    async request(input: unknown): Promise<Operation> {
      const prompt = input as PromptInput;
      let operation = operations.get(prompt.idempotencyKey);
      if (!operation) {
        operation = {
          operationID: crypto.randomUUID(),
          state: "pending",
          payloadHash: "synthetic",
          receiptID: null,
          channel: null,
        };
        operations.set(prompt.idempotencyKey, operation);
      }
      if (crashAfterRequest) {
        crashAfterRequest = false;
        throw new Error("synthetic crash after durable enqueue");
      }
      return operation;
    },
    async deliver(id: string): Promise<Operation> {
      expect(
        first
          .query("SELECT operation_id FROM runner_intents WHERE operation_id=?")
          .get(id),
      ).not.toBeNull();
      sends++;
      for (const [key, op] of operations)
        if (op.operationID === id) {
          const updated: Operation = {
            ...op,
            state: "admitted",
            channel: "host",
            receiptID: id,
          };
          operations.set(key, updated);
          return updated;
        }
      throw new Error("missing operation");
    },
    async reconcile(id: string): Promise<Operation> {
      inspectCount++;
      const op = [...operations.values()].find((op) => op.operationID === id);
      if (!op) throw new Error("missing operation");
      return op;
    },
  };
  let outcome: TaskOutcome | null = null;
  let rejectUsage = false;
  let rejectBudget = false;
  first.exec(
    "CREATE TABLE synthetic_budget_reservations(admission_id TEXT PRIMARY KEY,task_id TEXT,principal_json TEXT)",
  );
  let resumeResponseAvailable = false;
  first.exec(
    "CREATE TABLE synthetic_port_receipts(category TEXT,task_id TEXT,operation_id TEXT,state TEXT)",
  );
  const usage: string[] = [];
  const questions: string[] = [];
  // Explicit synthetic reservation port; never production budget wiring/pricing.
  const usagePort: RunnerUsagePort = {
    reserve(sql, evidence) {
      expect(sql === first || sql === second).toBe(true);
      expect(sql.inTransaction).toBe(true);
      expect(
        sql
          .query("SELECT 1 FROM runner_intents WHERE task_id=?")
          .get(evidence.taskID),
      ).toBeNull();
      expect(evidence.groupID).toBe("group");
      sql
        .query("INSERT INTO synthetic_budget_reservations VALUES(?,?,?)")
        .run(
          evidence.admissionID,
          evidence.taskID,
          canonical(evidence.principal),
        );
      if (rejectBudget) throw new Error("synthetic budget rejection");
    },
    record(sql, evidence) {
      expect(sql === first || sql === second).toBe(true);
      sql
        .query("INSERT INTO synthetic_port_receipts VALUES('usage',?,?,?)")
        .run(evidence.taskID, evidence.operationID, evidence.outcome.state);
      if (rejectUsage) throw new Error("synthetic usage failure");
      usage.push(evidence.outcome.state);
    },
  };
  const build = (tasks: Tasks) =>
    new Runner(
      tasks,
      dispatcher,
      {
        inspect: async (operationID) =>
          outcome?.operationID === operationID ? outcome : null,
      },
      { snapshot: () => ({ expiresAt: 100_000, expectedRevision: 1 }) },
      usagePort,
      {
        record: (sql, evidence) => {
          expect(sql === first || sql === second).toBe(true);
          sql
            .query(
              "INSERT INTO synthetic_port_receipts VALUES('question',?,?,?)",
            )
            .run(evidence.taskID, evidence.operationID, evidence.state);
          questions.push(evidence.state);
        },
        resumeTask: async (taskPort, evidence, revision) =>
          taskPort.runnerAccount(
            evidence.groupID,
            evidence.taskID,
            revision,
            (sql) => {
              if (!resumeResponseAvailable || !sql.inTransaction)
                throw new Error("missing synthetic response");
              resumeResponseAvailable = false;
            },
          ),
      },
      {
        deliver: async ({ operationID }) => {
          cancellations++;
          if (crashCancellation) {
            crashCancellation = false;
            throw new Error("synthetic interrupted cancellation");
          }
          return { operationID, state: "accepted" };
        },
        inspect: async (operationID) => ({
          operationID,
          state: "unknown_outcome",
        }),
      },
      () => 1000,
    );
  return {
    a,
    b,
    first,
    build,
    operations,
    usage,
    questions,
    rejectBudget() {
      rejectBudget = true;
    },
    removeReserve() {
      Reflect.deleteProperty(usagePort, "reserve");
    },
    allowResume() {
      resumeResponseAvailable = true;
    },
    rejectUsage(value: boolean) {
      rejectUsage = value;
    },
    dropOutcome() {
      outcome = null;
    },
    sends: () => sends,
    cancellations: () => cancellations,
    crashCancellation: () => {
      crashCancellation = true;
    },
    inspections: () => inspectCount,
    crash: () => {
      crashAfterRequest = true;
    },
    deny: () => {
      current = null;
    },
    supervise() {
      supervised = true;
      first.query("UPDATE synthetic_approval SET body=?").run(
        canonical({
          principal: operator,
          target: scope,
          capability: "task.dispatch",
          revision: 1,
          mode: "once",
          expiresAt: new Date(100000).toISOString(),
        }),
      );
    },
    async receive(
      taskID: string,
      revision: number,
      kind: "execution" | "cancellation",
      state: TaskOutcome["state"],
    ) {
      return a.runnerJournal("group", taskID, revision, (sql) => {
        const row = sql
          .query<
            {
              admission_id: string;
              operation_id: string;
              correlation_id: string;
              task_generation: number;
            },
            [string, string]
          >(
            "SELECT * FROM runner_intents WHERE task_id=? AND kind=? ORDER BY task_generation DESC LIMIT 1",
          )
          .get(taskID, kind);
        if (!row) throw new Error("missing admission");
        const received = {
          admissionID: row.admission_id,
          operationID: row.operation_id,
          correlationID: row.correlation_id,
          taskGeneration: row.task_generation,
          state,
          evidence: "synthetic trusted persisted receipt",
        };
        sql
          .query("INSERT INTO runner_outcomes(admission_id,body) VALUES(?,?)")
          .run(row.admission_id, canonical(received));
        return received;
      });
    },
    setOutcome(
      state: TaskOutcome["state"],
      taskID: string | null = null,
      patch: Partial<TaskOutcome> = {},
    ) {
      const row = first
        .query<
          {
            admission_id: string;
            operation_id: string;
            correlation_id: string;
            task_generation: number;
          },
          [string | null, string | null]
        >(
          "SELECT * FROM runner_intents WHERE (? IS NULL OR task_id=?) ORDER BY task_generation DESC,kind ASC LIMIT 1",
        )
        .get(taskID, taskID);
      if (!row) throw new Error("no admission");
      outcome = {
        state,
        admissionID: row.admission_id,
        operationID: row.operation_id,
        correlationID: row.correlation_id,
        taskGeneration: row.task_generation,
        evidence: "synthetic explicit host reply",
        ...patch,
      };
    },
    async add(dependencies: string[] = [], ownExecutor = false) {
      const before = await a.get("group");
      const executor = {
        ...scope,
        sessionID: ownExecutor ? scope.sessionID : crypto.randomUUID(),
      };
      const graph = await a.create(
        "group",
        {
          objective: "synthetic objective",
          expectedResult: "explicit reply",
          executor,
          dependencies,
        },
        before.revision,
      );
      const task = graph.tasks.find(
        (task) => task.executor.sessionID === executor.sessionID,
      );
      if (!task) throw new Error("missing created task");
      return { graph, task };
    },
    close() {
      second.close();
      first.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("T24 two real SQLite connections admit one intent with graph CAS", async () => {
  const f = fixture();
  try {
    const created = await f.add();
    const id = created.task.taskID;
    const results = await Promise.allSettled([
      f.build(f.a).execute("group", id, created.graph.revision),
      f.build(f.b).execute("group", id, created.graph.revision),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      f.first
        .query<{ n: number }, []>("SELECT count(*) n FROM runner_intents")
        .get()?.n,
    ).toBe(1);
    const revision = (await f.a.get("group")).revision;
    await Promise.all([
      f.build(f.a).work("group", id, revision),
      f.build(f.b).work("group", id, revision),
    ]);
    expect(f.sends()).toBe(1);
  } finally {
    f.close();
  }
});

test("T24 restart after request before correlation replays stable key, persists before host send", async () => {
  const f = fixture();
  try {
    const created = await f.add();
    const id = created.task.taskID;
    const admitted = await f
      .build(f.a)
      .execute("group", id, created.graph.revision);
    f.crash();
    await expect(
      f.build(f.a).work("group", id, admitted.graph.revision),
    ).rejects.toThrow("synthetic crash");
    expect(f.sends()).toBe(0);
    await f.build(f.b).work("group", id, admitted.graph.revision);
    await f.build(f.a).work("group", id, admitted.graph.revision);
    expect(f.operations.size).toBe(1);
    expect(f.sends()).toBe(1);
  } finally {
    f.close();
  }
});

test("T24 explicit result accounts without reopening terminals; join waits", async () => {
  const f = fixture();
  try {
    const created = await f.add();
    const id = created.task.taskID;
    const join = await f.add([id]);
    await expect(
      f.build(f.a).execute("group", join.task.taskID, join.graph.revision),
    ).rejects.toThrow();
    const run = await f.build(f.a).execute("group", id, join.graph.revision);
    await f.build(f.a).work("group", id, run.graph.revision);
    expect(
      await f.build(f.a).collect("group", id, run.graph.revision),
    ).toBeNull();
    f.setOutcome("completed");
    await f.build(f.a).collect("group", id, run.graph.revision);
    const graph = await f.a.get("group");
    expect(graph.tasks.find((task) => task.taskID === id)?.state).toBe(
      "completed",
    );
    await expect(
      f.build(f.a).execute("group", id, graph.revision),
    ).rejects.toThrow();
    await f.build(f.b).execute("group", join.task.taskID, graph.revision);
    expect(f.usage).toEqual(["completed"]);
  } finally {
    f.close();
  }
});

test("T24 cancellation receipt is not terminal confirmation", async () => {
  const f = fixture();
  try {
    const created = await f.add();
    const id = created.task.taskID;
    const runner = f.build(f.a);
    const run = await runner.execute("group", id, created.graph.revision);
    await runner.work("group", id, run.graph.revision);
    const cancel = await runner.cancel("group", id, run.graph.revision);
    await runner.work("group", id, cancel.graph.revision);
    expect(f.cancellations()).toBe(1);
    expect(
      (await f.a.get("group")).tasks.find((task) => task.taskID === id)?.state,
    ).toBe("cancel_requested");
    f.setOutcome("cancelled");
    await runner.collect("group", id, cancel.graph.revision);
    expect(
      (await f.a.get("group")).tasks.find((task) => task.taskID === id)?.state,
    ).toBe("cancelled");
  } finally {
    f.close();
  }
});

test("T24 worker obtains fresh principal rather than trusting public arguments", async () => {
  const f = fixture();
  try {
    const created = await f.add();
    const run = await f
      .build(f.a)
      .execute("group", created.task.taskID, created.graph.revision);
    f.deny();
    await expect(
      f.build(f.b).work("group", created.task.taskID, run.graph.revision),
    ).rejects.toThrow();
    expect(f.sends()).toBe(0);
  } finally {
    f.close();
  }
});

test("T24 unknown dispatch recovery reconciles and never blindly sends", async () => {
  const f = fixture();
  try {
    const created = await f.add();
    const id = created.task.taskID;
    const run = await f.build(f.a).execute("group", id, created.graph.revision);
    await f.build(f.a).work("group", id, run.graph.revision);
    for (const [key, operation] of f.operations)
      f.operations.set(key, { ...operation, state: "unknown_outcome" });
    await f.build(f.b).work("group", id, run.graph.revision);
    expect(f.sends()).toBe(1);
    expect(f.inspections()).toBe(1);
  } finally {
    f.close();
  }
});

test("T24 durable question and usage ports receive only correlated accounted outcomes", async () => {
  const f = fixture();
  try {
    const created = await f.add();
    const id = created.task.taskID;
    const runner = f.build(f.a);
    const run = await runner.execute("group", id, created.graph.revision);
    await runner.work("group", id, run.graph.revision);
    f.setOutcome("awaiting_input");
    const waiting = await runner.collect("group", id, run.graph.revision);
    expect(waiting?.graph.tasks.find((task) => task.taskID === id)?.state).toBe(
      "awaiting_input",
    );
    expect(f.questions).toEqual(["awaiting_input"]);
    expect(f.usage).toEqual([]);
    f.setOutcome("running");
    f.allowResume();
    if (!waiting) throw new Error("missing waiting result");
    const resumed = await runner.collect("group", id, waiting.graph.revision);
    if (!resumed) throw new Error("missing resumed result");
    f.setOutcome("completed");
    await runner.collect("group", id, resumed.graph.revision);
    expect(f.usage).toEqual(["completed"]);
  } finally {
    f.close();
  }
});

test("T24 supervised explicit result does not consume a second execution approval", async () => {
  const f = fixture();
  try {
    const created = await f.add([], true);
    const id = created.task.taskID;
    f.supervise();
    const runner = f.build(f.a);
    const run = await runner.execute("group", id, created.graph.revision);
    expect(
      f.first
        .query<{ body: string }, []>("SELECT body FROM synthetic_approval")
        .get()?.body,
    ).toBe("null");
    await runner.work("group", id, run.graph.revision);
    f.setOutcome("completed");
    const completed = await runner.collect("group", id, run.graph.revision);
    expect(
      completed?.graph.tasks.find((task) => task.taskID === id)?.state,
    ).toBe("completed");
    expect(
      f.first
        .query<{ body: string }, []>("SELECT body FROM synthetic_approval")
        .get()?.body,
    ).toBe("null");
  } finally {
    f.close();
  }
});

test("T24 real admission refuses fifth active task and leaves no extra intent", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 4; i++) {
      const created = await f.add();
      await f
        .build(i % 2 ? f.a : f.b)
        .execute("group", created.task.taskID, created.graph.revision);
    }
    const fifth = await f.add();
    await expect(
      f.build(f.a).execute("group", fifth.task.taskID, fifth.graph.revision),
    ).rejects.toThrow();
    expect(
      f.first
        .query<{ n: number }, []>("SELECT count(*) n FROM runner_intents")
        .get()?.n,
    ).toBe(4);
    expect(
      (await f.a.get("group")).tasks.find(
        (task) => task.taskID === fifth.task.taskID,
      )?.state,
    ).toBe("pending");
  } finally {
    f.close();
  }
});

test("T24 trusted graph depth four is enforced at real atomic admission", async () => {
  const f = fixture();
  try {
    let dependencies: string[] = [];
    const runner = f.build(f.a);
    for (let depth = 1; depth <= 4; depth++) {
      const created = await f.add(dependencies);
      const id = created.task.taskID;
      const run = await runner.execute("group", id, created.graph.revision);
      await runner.work("group", id, run.graph.revision);
      f.setOutcome("completed", id);
      await runner.collect("group", id, run.graph.revision);
      dependencies = [id];
    }
    const fifth = await f.add(dependencies);
    await expect(
      runner.execute("group", fifth.task.taskID, fifth.graph.revision),
    ).rejects.toThrow();
    expect(
      f.first
        .query<{ n: number }, []>("SELECT count(*) n FROM runner_intents")
        .get()?.n,
    ).toBe(4);
  } finally {
    f.close();
  }
});

test("T24 interrupted cancellation is reconciled, never blindly delivered twice", async () => {
  const f = fixture();
  try {
    const created = await f.add();
    const id = created.task.taskID;
    const runner = f.build(f.a);
    const run = await runner.execute("group", id, created.graph.revision);
    await runner.work("group", id, run.graph.revision);
    const cancel = await runner.cancel("group", id, run.graph.revision);
    f.crashCancellation();
    await expect(
      runner.work("group", id, cancel.graph.revision),
    ).rejects.toThrow("interrupted cancellation");
    await f.build(f.b).work("group", id, cancel.graph.revision);
    expect(f.cancellations()).toBe(1);
    expect(
      (await f.a.get("group")).tasks.find((task) => task.taskID === id)?.state,
    ).toBe("cancel_requested");
  } finally {
    f.close();
  }
});

test("T24 uncorrelated host result cannot write outcome or change task state", async () => {
  const f = fixture();
  try {
    const created = await f.add();
    const id = created.task.taskID;
    const runner = f.build(f.a);
    const run = await runner.execute("group", id, created.graph.revision);
    await runner.work("group", id, run.graph.revision);
    f.setOutcome("completed", id, { correlationID: "wrong" });
    await expect(
      runner.collect("group", id, run.graph.revision),
    ).rejects.toThrow();
    expect(
      f.first
        .query<{ n: number }, []>("SELECT count(*) n FROM runner_outcomes")
        .get()?.n,
    ).toBe(0);
    expect(
      (await f.a.get("group")).tasks.find((task) => task.taskID === id)?.state,
    ).toBe("running");
  } finally {
    f.close();
  }
});

test("T24 late execution completion after cancellation request uses the original execution admission", async () => {
  const f = fixture();
  try {
    const created = await f.add();
    const id = created.task.taskID;
    const runner = f.build(f.a);
    const run = await runner.execute("group", id, created.graph.revision);
    await runner.work("group", id, run.graph.revision);
    f.setOutcome("completed", id);
    const cancel = await runner.cancel("group", id, run.graph.revision);
    const completed = await runner.collect("group", id, cancel.graph.revision);
    expect(
      completed?.graph.tasks.find((task) => task.taskID === id)?.state,
    ).toBe("completed");
  } finally {
    f.close();
  }
});

test("T24 late execution failure after cancellation request uses the execution receipt", async () => {
  const f = fixture();
  try {
    const created = await f.add();
    const id = created.task.taskID;
    const runner = f.build(f.a);
    const run = await runner.execute("group", id, created.graph.revision);
    await runner.work("group", id, run.graph.revision);
    f.setOutcome("failed", id);
    const cancel = await runner.cancel("group", id, run.graph.revision);
    const completed = await runner.collect("group", id, cancel.graph.revision);
    expect(
      completed?.graph.tasks.find((task) => task.taskID === id)?.state,
    ).toBe("failed");
    expect(f.usage).toEqual(["failed"]);
  } finally {
    f.close();
  }
});

for (const first of ["execution", "cancellation"] as const) {
  test(`T24 dual terminal receipts use immutable received sequence: ${first} first`, async () => {
    const f = fixture();
    try {
      const created = await f.add();
      const id = created.task.taskID;
      const runner = f.build(f.a);
      const run = await runner.execute("group", id, created.graph.revision);
      await runner.work("group", id, run.graph.revision);
      const cancel = await runner.cancel("group", id, run.graph.revision);
      const second = first === "execution" ? "cancellation" : "execution";
      const state = (kind: "execution" | "cancellation") =>
        kind === "execution" ? "completed" : "cancelled";
      const earliest = await f.receive(
        id,
        cancel.graph.revision,
        first,
        state(first),
      );
      await f.receive(id, cancel.graph.revision, second, state(second));
      const winner = runnerAdmissionEvidence.lookup(
        f.first,
        "group",
        id,
        {
          kind: "operator",
          operatorID: "synthetic",
          instanceID: "fixture",
          revision: 1,
        },
        "accounting",
      );
      expect(winner?.admissionID).toBe(earliest.admissionID);
      expect(winner?.operationID).toBe(earliest.operationID);
      const result = await runner.collect("group", id, cancel.graph.revision);
      expect(
        result?.graph.tasks.find((task) => task.taskID === id)?.state,
      ).toBe(state(first));
      expect(f.usage).toEqual([state(first)]);
      if (!result) throw new Error("missing result");
      await expect(
        runner.collect("group", id, result.graph.revision),
      ).rejects.toThrow();
      expect(
        (await f.a.get("group")).tasks.find((task) => task.taskID === id)
          ?.state,
      ).toBe(state(first));
    } finally {
      f.close();
    }
  });
}

test("T24 usage failure rolls back terminal accounting, durable receipt recovers without another host outcome", async () => {
  const f = fixture();
  try {
    const created = await f.add();
    const id = created.task.taskID;
    const runner = f.build(f.a);
    const run = await runner.execute("group", id, created.graph.revision);
    await runner.work("group", id, run.graph.revision);
    f.setOutcome("completed", id);
    f.rejectUsage(true);
    await expect(
      runner.collect("group", id, run.graph.revision),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(
      (await f.a.get("group")).tasks.find((task) => task.taskID === id)?.state,
    ).toBe("running");
    expect(
      f.first
        .query<{ n: number }, []>(
          "SELECT count(*) n FROM synthetic_port_receipts",
        )
        .get()?.n,
    ).toBe(0);
    f.rejectUsage(false);
    f.dropOutcome();
    const result = await f.build(f.b).collect("group", id, run.graph.revision);
    expect(result?.graph.tasks.find((task) => task.taskID === id)?.state).toBe(
      "completed",
    );
    expect(
      f.first
        .query<{ n: number }, []>(
          "SELECT count(*) n FROM synthetic_port_receipts",
        )
        .get()?.n,
    ).toBe(1);
    expect(f.sends()).toBe(1);
  } finally {
    f.close();
  }
});

test("T24 missing reserve fails closed before execution admission", async () => {
  const f = fixture();
  try {
    const created = await f.add([], true);
    f.supervise();
    f.removeReserve();
    await expect(
      f
        .build(f.a)
        .execute("group", created.task.taskID, created.graph.revision),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await f.a.get("group")).toEqual(created.graph);
    expect(
      f.first
        .query<{ generation: number }, [string]>(
          "SELECT generation FROM task_records WHERE task_id=?",
        )
        .get(created.task.taskID)?.generation,
    ).toBe(0);
    expect(
      f.first
        .query<{ body: string }, []>("SELECT body FROM synthetic_approval")
        .get()?.body,
    ).not.toBe("null");
    expect(
      f.first
        .query<{ n: number }, []>("SELECT count(*) n FROM runner_intents")
        .get()?.n,
    ).toBe(0);
    expect(f.sends()).toBe(0);
  } finally {
    f.close();
  }
});

test("T24 budget rejection rolls back reservation, transition, generation and once approval", async () => {
  const f = fixture();
  try {
    const created = await f.add([], true);
    f.supervise();
    f.rejectBudget();
    const approval = f.first
      .query<{ body: string }, []>("SELECT body FROM synthetic_approval")
      .get()?.body;
    await expect(
      f
        .build(f.a)
        .execute("group", created.task.taskID, created.graph.revision),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(await f.a.get("group")).toEqual(created.graph);
    expect(
      f.first
        .query<{ generation: number }, [string]>(
          "SELECT generation FROM task_records WHERE task_id=?",
        )
        .get(created.task.taskID)?.generation,
    ).toBe(0);
    expect(
      f.first
        .query<{ body: string }, []>("SELECT body FROM synthetic_approval")
        .get()?.body,
    ).toBe(approval);
    expect(
      f.first
        .query<{ n: number }, []>(
          "SELECT count(*) n FROM synthetic_budget_reservations",
        )
        .get()?.n,
    ).toBe(0);
    expect(
      f.first
        .query<{ n: number }, []>("SELECT count(*) n FROM runner_intents")
        .get()?.n,
    ).toBe(0);
    expect(f.operations.size).toBe(0);
    expect(f.sends()).toBe(0);
  } finally {
    f.close();
  }
});

test("T24 successful reservation persists before intent with the same trusted admission binding", async () => {
  const f = fixture();
  try {
    const created = await f.add();
    await f
      .build(f.a)
      .execute("group", created.task.taskID, created.graph.revision);
    const row = f.first
      .query<
        { admission_id: string; owner_json: string; principal_json: string },
        []
      >(
        "SELECT i.admission_id,i.owner_json,r.principal_json FROM runner_intents i JOIN synthetic_budget_reservations r ON r.admission_id=i.admission_id AND r.task_id=i.task_id",
      )
      .get();
    expect(row).not.toBeNull();
    expect(row?.principal_json).toBe(row?.owner_json);
    expect(f.operations.size).toBe(0);
    expect(f.sends()).toBe(0);
  } finally {
    f.close();
  }
});
