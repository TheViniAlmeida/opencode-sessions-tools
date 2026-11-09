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

// These are synthetic trusted policy/host/operator ports, never production auth.
async function fixture(human = false) {
  const root = mkdtempSync(
    "/tmp/opencode/opencode-sessions-tools/t25-questions-",
  );
  const sql = new Database(`${root}/synthetic.sqlite`);
  sql.exec("PRAGMA foreign_keys=ON");
  for (const migration of [
    GROUPS_MIGRATION,
    TASKS_MIGRATION,
    RUNNER_MIGRATION,
    REQUESTS_MIGRATION,
  ])
    migration.apply(sql, "synthetic");
  const storage = new Persistence(sql, () => {});
  const target: SessionRef = {
    version: 1,
    instanceID: "fixture",
    projectID: "project",
    sessionID: "executor",
  };
  const owner: Principal = {
    kind: "operator",
    operatorID: "synthetic",
    instanceID: "fixture",
    revision: 1,
  };
  const respondent: Principal = human
    ? owner
    : { kind: "session", session: { ...target, sessionID: "respondent" } };
  let actor: Principal | null = owner;
  let humanActor: Principal | null = null;
  let now = 1000;
  let policyRevision = 1;
  const identity = { current: async () => actor };
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
        operatorID: "synthetic",
        instanceID: "fixture",
        revision: 1,
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
      name: "synthetic",
      kind: "group",
      scope: target,
      owner,
    }),
  );
  const tasks = new Tasks(storage, identity, policy, () => now, {
    admissions: runnerAdmissionEvidence,
    outcomes: runnerOutcomeEvidence,
  });
  const requests = new Requests(
    storage,
    identity,
    { current: () => humanActor },
    {
      snapshot: () => ({ respondent, target, expiresAt: 2000, policyRevision }),
    },
    () => now,
  );
  const operations = new Map<string, Operation>();
  const outcomes = new Map<string, TaskOutcome>();
  const runner = new Runner(
    tasks,
    {
      request: async (input) => {
        const prompt = input as PromptInput;
        let op = operations.get(prompt.idempotencyKey);
        if (!op) {
          op = {
            operationID: crypto.randomUUID(),
            state: "pending",
            payloadHash: "synthetic",
            receiptID: null,
            channel: null,
          };
          operations.set(prompt.idempotencyKey, op);
        }
        return op;
      },
      deliver: async (operationID) => ({
        operationID,
        state: "admitted",
        payloadHash: "synthetic",
        receiptID: "receipt",
        channel: "host",
      }),
      reconcile: async (operationID) => ({
        operationID,
        state: "admitted",
        payloadHash: "synthetic",
        receiptID: "receipt",
        channel: "host",
      }),
    },
    { inspect: async (id) => outcomes.get(id) ?? null },
    { snapshot: () => ({ expiresAt: 1900, expectedRevision: 1 }) },
    // Isolated approval fixture only; NOT production budget wiring.
    {
      reserve() {},
      record() {},
    },
    requests,
    {
      deliver: async (input) => ({
        operationID: input.operationID,
        state: "accepted",
      }),
      inspect: async (operationID) => ({ operationID, state: "accepted" }),
    },
    () => now,
  );
  let graph = await tasks.create(
    "group",
    {
      objective: "synthetic objective",
      executor: target,
      expectedResult: "synthetic result",
      dependencies: [],
    },
    0,
  );
  const taskID = graph.tasks[0]?.taskID;
  if (!taskID) throw new Error("missing synthetic task");
  graph = await tasks.create(
    "group",
    {
      objective: "unrelated",
      executor: target,
      expectedResult: "untouched",
      dependencies: [],
    },
    graph.revision,
  );
  const execution = await runner.execute("group", taskID, graph.revision);
  await runner.work("group", taskID, execution.graph.revision);
  const admitted = storage.transaction((db) =>
    runnerAdmissionEvidence.lookup(db, "group", taskID, owner, "journal"),
  );
  if (!admitted?.operationID) throw new Error("missing synthetic admission");
  const receipt: TaskOutcome = {
    admissionID: admitted.admissionID,
    operationID: admitted.operationID,
    correlationID: admitted.correlationID,
    taskGeneration: admitted.taskGeneration,
    state: human ? "awaiting_approval" : "awaiting_input",
    evidence: "synthetic authenticated host receipt",
  };
  outcomes.set(receipt.operationID, receipt);
  await runner.collect("group", taskID, execution.graph.revision);
  const question = JSON.parse(
    (sql.query("SELECT body FROM task_questions").get() as { body: string })
      .body,
  ) as TaskQuestion;
  const response = {
    revision: 1,
    admissionID: question.admissionID,
    operationID: question.operationID,
    correlationID: question.correlationID,
    taskGeneration: question.taskGeneration,
    target,
    decision: human ? ("once" as const) : ("answer" as const),
    ...(human ? {} : { content: "synthetic response content" }),
  };
  const running = (change: Partial<TaskOutcome> = {}) =>
    storage.transaction((db) =>
      db
        .query("INSERT INTO runner_outcomes(admission_id,body) VALUES(?,?)")
        .run(
          receipt.admissionID,
          canonical({
            ...receipt,
            state: "running",
            evidence: "synthetic resume receipt",
            ...change,
          }),
        ),
    );
  return {
    sql,
    storage,
    tasks,
    requests,
    question,
    response,
    running,
    owner,
    respondent,
    taskID,
    target,
    revision: async () => (await tasks.get("group")).revision,
    setActor: (p: Principal | null) => {
      actor = p;
    },
    setHuman: (p: Principal | null) => {
      humanActor = p;
    },
    expire: () => {
      now = 2000;
    },
    revoke: () => {
      policyRevision++;
    },
    connect() {
      const db = new Database(`${root}/synthetic.sqlite`);
      db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
      const persistence = new Persistence(db, () => {});
      return {
        sql: db,
        tasks: new Tasks(persistence, identity, policy, () => now, {
          admissions: runnerAdmissionEvidence,
          outcomes: runnerOutcomeEvidence,
        }),
        requests: new Requests(
          persistence,
          identity,
          { current: () => humanActor },
          {
            snapshot: () => ({
              respondent,
              target,
              expiresAt: 2000,
              policyRevision,
            }),
          },
          () => now,
        ),
      };
    },
    close() {
      sql.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("real Runner records wait and resolution resumes only the admitted task with a new matching receipt", async () => {
  const f = await fixture();
  try {
    f.setActor(f.respondent);
    await f.requests.respond(f.question.requestID, f.response);
    f.setActor(f.owner);
    const revision = await f.revision();
    await expect(
      f.requests.resume(f.tasks, f.question.requestID, revision),
    ).rejects.toThrow("conflict");
    expect(
      (await f.tasks.get("group")).tasks.find((t) => t.taskID === f.taskID)
        ?.state,
    ).toBe("awaiting_input");
    f.running({ correlationID: "wrong" });
    await expect(
      f.requests.resume(f.tasks, f.question.requestID, revision),
    ).rejects.toThrow("conflict");
    f.running();
    const result = await f.requests.resume(
      f.tasks,
      f.question.requestID,
      revision,
    );
    expect(result.graph.tasks.find((t) => t.taskID === f.taskID)?.state).toBe(
      "running",
    );
    expect(result.graph.tasks.find((t) => t.taskID !== f.taskID)?.state).toBe(
      "pending",
    );
    await expect(
      f.requests.resume(f.tasks, f.question.requestID, result.graph.revision),
    ).rejects.toThrow("conflict");
    expect(
      f.sql.query("SELECT * FROM question_audit WHERE kind='consumed'").all(),
    ).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("pre-response running receipts cannot masquerade as resume evidence", async () => {
  const f = await fixture();
  try {
    f.running();
    f.setActor(f.respondent);
    await f.requests.respond(f.question.requestID, f.response);
    f.setActor(f.owner);
    await expect(
      f.requests.resume(f.tasks, f.question.requestID, await f.revision()),
    ).rejects.toThrow("conflict");
    f.running();
    expect(
      (
        await f.requests.resume(
          f.tasks,
          f.question.requestID,
          await f.revision(),
        )
      ).value.taskID,
    ).toBe(f.taskID);
  } finally {
    f.close();
  }
});

test("trusted human once resolution resumes once without granting permanent authority", async () => {
  const f = await fixture(true);
  try {
    f.setHuman(f.owner);
    const approved = await f.requests.respondAsOperator(
      f.question.requestID,
      f.response,
    );
    expect(approved.state).toBe("approved_once");
    f.running();
    const resumed = await f.requests.resume(
      f.tasks,
      f.question.requestID,
      await f.revision(),
    );
    expect(resumed.graph.tasks.find((t) => t.taskID === f.taskID)?.state).toBe(
      "running",
    );
    expect(
      await f.requests.respondAsOperator(f.question.requestID, f.response),
    ).toEqual(approved);
    await expect(
      f.requests.resume(f.tasks, f.question.requestID, resumed.graph.revision),
    ).rejects.toThrow("conflict");
    expect(
      f.sql
        .query("SELECT * FROM question_audit WHERE kind='approved_once'")
        .all(),
    ).toHaveLength(1);
    expect(
      f.sql.query("SELECT * FROM question_audit WHERE kind='consumed'").all(),
    ).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("denial, revoked policy and expiration never resume or change grants/config", async () => {
  for (const scenario of ["deny", "expire", "revoke"] as const) {
    const f = await fixture(true);
    try {
      f.setHuman(f.owner);
      if (scenario === "expire") {
        f.expire();
        expect(f.requests.expire()).toBe(1);
        expect(f.requests.expire()).toBe(0);
      } else
        await f.requests.respondAsOperator(f.question.requestID, {
          ...f.response,
          decision: scenario === "deny" ? "deny" : "once",
        });
      if (scenario === "revoke") f.revoke();
      f.running();
      await expect(
        f.requests.resume(f.tasks, f.question.requestID, await f.revision()),
      ).rejects.toThrow(scenario === "revoke" ? "forbidden" : "conflict");
      expect(
        (await f.tasks.get("group")).tasks.find((t) => t.taskID === f.taskID)
          ?.state,
      ).toBe("awaiting_approval");
      expect(
        f.sql
          .query("SELECT name FROM sqlite_master WHERE name LIKE 'grants%'")
          .all(),
      ).toHaveLength(0);
    } finally {
      f.close();
    }
  }
});

test("targeted local cleanup and task cascade leave unrelated questions/tasks intact", async () => {
  const f = await fixture();
  try {
    expect(
      f.storage.transaction((db) =>
        f.requests.cleanup(db, { ...f.target, sessionID: "unrelated" }),
      ),
    ).toBe(0);
    expect(
      f.storage.transaction((db) => f.requests.cleanup(db, f.target)),
    ).toBe(1);
    expect(f.sql.query("SELECT kind FROM question_audit").all()).toEqual([
      { kind: "pending" },
    ]);
    expect(
      f.storage.transaction((db) => f.requests.cleanup(db, f.target)),
    ).toBe(0);
    expect(f.sql.query("SELECT * FROM task_records").all()).toHaveLength(2);
    // Runner can recreate the one question for the still-admitted wait after a
    // targeted deletion; task deletion then cascades plugin-local records only.
    f.storage.transaction((db) =>
      f.requests.record(db, {
        taskID: f.taskID,
        operationID: f.question.operationID,
        state: "awaiting_input",
      }),
    );
    f.sql.query("DELETE FROM task_records WHERE task_id=?").run(f.taskID);
    expect(f.sql.query("SELECT * FROM task_questions").all()).toHaveLength(0);
    expect(f.sql.query("SELECT * FROM task_records").all()).toHaveLength(1);
    expect(f.sql.query("SELECT kind FROM question_audit").all()).toEqual([
      { kind: "pending" },
      { kind: "pending" },
    ]);
  } finally {
    f.close();
  }
});

test("cleanup preserves payload-free answer/approval/consumption trail and unrelated question", async () => {
  for (const human of [false, true]) {
    const f = await fixture(human);
    try {
      if (human) {
        f.setHuman(f.owner);
        await f.requests.respondAsOperator(f.question.requestID, f.response);
      } else {
        f.setActor(f.respondent);
        await f.requests.respond(f.question.requestID, f.response);
        f.setActor(f.owner);
      }
      f.running();
      await f.requests.resume(
        f.tasks,
        f.question.requestID,
        await f.revision(),
      );
      const otherTask = (await f.tasks.get("group")).tasks.find(
        (t) => t.taskID !== f.taskID,
      );
      if (!otherTask) throw new Error("missing unrelated task");
      // Synthetic unrelated local metadata, not an admitted/authenticated request.
      const otherTarget = { ...f.target, sessionID: "unrelated" };
      const otherBody = canonical({
        ...f.question,
        taskID: otherTask.taskID,
        requestID: "unrelated",
        operationID: "unrelated-operation",
        target: otherTarget,
        respondent: { kind: "session", session: otherTarget },
      });
      f.sql
        .query(
          "INSERT INTO task_questions(request_id,task_id,operation_id,generation,body,response) VALUES(?,?,?,?,?,?)",
        )
        .run(
          "unrelated",
          otherTask.taskID,
          "unrelated-operation",
          1,
          otherBody,
          "synthetic unrelated payload",
        );
      const before = f.sql
        .query("SELECT * FROM question_audit ORDER BY sequence")
        .all();
      expect(before.map((event) => (event as { kind: string }).kind)).toEqual([
        "pending",
        human ? "approved_once" : "answered",
        "consumed",
      ]);
      expect(
        f.storage.transaction((db) => f.requests.cleanup(db, f.target)),
      ).toBe(1);
      expect(
        f.storage.transaction((db) => f.requests.cleanup(db, f.target)),
      ).toBe(0);
      expect(
        f.sql.query("SELECT * FROM question_audit ORDER BY sequence").all(),
      ).toEqual(before);
      expect(JSON.stringify(before)).not.toContain(
        "synthetic response content",
      );
      expect(
        f.sql
          .query("SELECT request_id,body,response FROM task_questions")
          .all(),
      ).toEqual([
        {
          request_id: "unrelated",
          body: otherBody,
          response: "synthetic unrelated payload",
        },
      ]);
      expect(f.sql.query("SELECT * FROM task_records").all()).toHaveLength(2);
      f.sql.query("DELETE FROM task_records WHERE task_id=?").run(f.taskID);
      expect(
        f.sql.query("SELECT * FROM question_audit ORDER BY sequence").all(),
      ).toEqual(before);
      expect(
        f.sql.query("SELECT request_id FROM task_questions").all(),
      ).toEqual([{ request_id: "unrelated" }]);
    } finally {
      f.close();
    }
  }
});

test("exported adapter refuses forged admission evidence and missing question without fallback", async () => {
  const f = await fixture();
  try {
    f.setActor(f.respondent);
    await f.requests.respond(f.question.requestID, f.response);
    f.setActor(f.owner);
    f.running();
    const evidence = f.storage.transaction((db) =>
      runnerAdmissionEvidence.lookup(
        db,
        "group",
        f.taskID,
        f.owner,
        "accounting",
      ),
    );
    if (!evidence) throw new Error("missing synthetic evidence");
    const adapter = questionsRunnerPort(f.requests);
    if (!adapter.resumeTask) throw new Error("missing composition hook");
    const revision = await f.revision();
    for (const change of [
      { admissionID: "forged" },
      { correlationID: "forged" },
      { operationID: "forged" },
      { taskGeneration: evidence.taskGeneration + 1 },
      { groupID: "forged" },
      { taskID: "forged" },
      { owner: { ...f.owner, operatorID: "forged" } as Principal },
      { kind: "cancellation" as const },
    ]) {
      await expect(
        adapter.resumeTask(f.tasks, { ...evidence, ...change }, revision),
      ).rejects.toThrow();
      expect(
        (await f.tasks.get("group")).tasks.find((t) => t.taskID === f.taskID)
          ?.state,
      ).toBe("awaiting_input");
    }
    expect(
      f.sql.query("SELECT * FROM question_audit WHERE kind='consumed'").all(),
    ).toHaveLength(0);
    f.sql
      .query("DELETE FROM task_questions WHERE request_id=?")
      .run(f.question.requestID);
    await expect(
      adapter.resumeTask(f.tasks, evidence, revision),
    ).rejects.toThrow("conflict");
    expect((await f.tasks.get("group")).revision).toBe(revision);
    expect(f.sql.query("SELECT kind FROM question_audit").all()).toEqual([
      { kind: "pending" },
      { kind: "answered" },
    ]);
  } finally {
    f.close();
  }
});

test("two canonical connections race admission resume: exactly one consumption and transition", async () => {
  const f = await fixture(true);
  const second = f.connect();
  try {
    f.setHuman(f.owner);
    await f.requests.respondAsOperator(f.question.requestID, f.response);
    f.running();
    const evidence = f.storage.transaction((db) =>
      runnerAdmissionEvidence.lookup(
        db,
        "group",
        f.taskID,
        f.owner,
        "accounting",
      ),
    );
    if (!evidence) throw new Error("missing synthetic evidence");
    const revision = await f.revision();
    const outcomes = await Promise.allSettled([
      f.requests.resumeForAdmission(f.tasks, evidence, revision),
      second.requests.resumeForAdmission(second.tasks, evidence, revision),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    expect((await second.tasks.get("group")).revision).toBe(revision + 1);
    expect(
      f.sql.query("SELECT * FROM question_audit WHERE kind='consumed'").all(),
    ).toHaveLength(1);
    expect(
      second.sql.query("SELECT consumed FROM task_questions").all(),
    ).toEqual([{ consumed: 1 }]);
  } finally {
    second.sql.close();
    f.close();
  }
});

test("response replay after policy change is forbidden with no new audit", async () => {
  for (const human of [false, true]) {
    const f = await fixture(human);
    try {
      f.setHuman(f.owner);
      f.setActor(f.respondent);
      const respond = () =>
        human
          ? f.requests.respondAsOperator(f.question.requestID, f.response)
          : f.requests.respond(f.question.requestID, f.response);
      await respond();
      const before = f.sql
        .query("SELECT * FROM question_audit ORDER BY sequence")
        .all();
      f.revoke();
      await expect(respond()).rejects.toThrow("forbidden");
      expect(
        f.sql.query("SELECT * FROM question_audit ORDER BY sequence").all(),
      ).toEqual(before);
    } finally {
      f.close();
    }
  }
});
