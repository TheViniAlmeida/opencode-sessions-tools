import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  canonical,
  type Principal,
  type SessionRef,
} from "../../src/contracts";
import { REQUESTS_MIGRATION, Requests } from "../../src/orchestration/requests";
import { RUNNER_MIGRATION } from "../../src/orchestration/runner";
import { Persistence } from "../../src/persistence/database";

// Synthetic trusted adapters, not production authentication.
function fixture(human = false) {
  const sql = new Database(":memory:");
  sql.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE task_records(task_id TEXT PRIMARY KEY,group_id TEXT,body TEXT,generation INTEGER)",
  );
  RUNNER_MIGRATION.apply(sql, "synthetic");
  REQUESTS_MIGRATION.apply(sql, "synthetic");
  const target: SessionRef = {
    version: 1,
    instanceID: "fixture",
    projectID: "p",
    sessionID: "executor",
  };
  const owner: Principal = {
    kind: "session",
    session: { ...target, sessionID: "owner" },
  };
  const operator: Principal = {
    kind: "operator",
    operatorID: "human",
    instanceID: "fixture",
    revision: 1,
  };
  const respondent: Principal = human
    ? operator
    : { kind: "session", session: { ...target, sessionID: "respondent" } };
  const state = human ? "awaiting_approval" : "awaiting_input";
  sql
    .query("INSERT INTO task_records VALUES(?,?,?,?)")
    .run(
      "task",
      "group",
      canonical({ taskID: "task", groupID: "group", executor: target, state }),
      1,
    );
  sql
    .query(
      "INSERT INTO runner_intents(admission_id,task_id,group_id,owner_json,correlation_id,task_generation,kind,prompt_json,operation_id) VALUES(?,?,?,?,?,?, 'execution','{}',?)",
    )
    .run(
      "admission",
      "task",
      "group",
      canonical(owner),
      "correlation",
      1,
      "operation",
    );
  sql.query("INSERT INTO runner_outcomes(admission_id,body) VALUES(?,?)").run(
    "admission",
    canonical({
      admissionID: "admission",
      operationID: "operation",
      correlationID: "correlation",
      taskGeneration: 1,
      state,
      evidence: "synthetic host receipt",
    }),
  );
  let actor: Principal | null = respondent;
  let humanActor: Principal | null = null;
  let now = 1000;
  let revision = 4;
  const storage = new Persistence(sql, () => {});
  const requests = new Requests(
    storage,
    { current: async () => actor },
    { current: () => humanActor },
    {
      snapshot: () => ({
        respondent,
        target,
        expiresAt: 2000,
        policyRevision: revision,
      }),
    },
    () => now,
  );
  const record = () =>
    storage.transaction((db) =>
      requests.record(db, { taskID: "task", operationID: "operation", state }),
    );
  const response = {
    revision: 4,
    admissionID: "admission",
    operationID: "operation",
    correlationID: "correlation",
    taskGeneration: 1,
    target,
    decision: human ? ("once" as const) : ("answer" as const),
    content: human ? undefined : "synthetic answer",
  };
  return {
    sql,
    storage,
    requests,
    record,
    response,
    respondent,
    operator,
    target,
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
      revision++;
    },
  };
}

test("only expected fresh session can answer; payload principal is rejected", async () => {
  const f = fixture();
  try {
    const q = f.record();
    f.setActor({ kind: "session", session: f.target });
    await expect(f.requests.respond(q.requestID, f.response)).rejects.toThrow(
      "forbidden",
    );
    f.setActor(f.respondent);
    await expect(
      f.requests.respond(q.requestID, {
        ...f.response,
        actor: f.respondent,
      } as typeof f.response),
    ).rejects.toThrow("invalid_input");
    expect((await f.requests.respond(q.requestID, f.response)).state).toBe(
      "answered",
    );
  } finally {
    f.sql.close();
  }
});

test("same response is idempotent, different response conflicts; no content in audit", async () => {
  const f = fixture();
  try {
    const q = f.record();
    expect(f.record().requestID).toBe(q.requestID);
    const answer = await f.requests.respond(q.requestID, f.response);
    expect(await f.requests.respond(q.requestID, f.response)).toEqual(answer);
    await expect(
      f.requests.respond(q.requestID, { ...f.response, content: "different" }),
    ).rejects.toThrow("conflict");
    expect(
      JSON.stringify(f.sql.query("SELECT * FROM question_audit").all()),
    ).not.toContain("synthetic answer");
    expect(
      f.sql.query("SELECT * FROM question_audit WHERE kind='answered'").all(),
    ).toHaveLength(1);
  } finally {
    f.sql.close();
  }
});

test("human approval never originates from a session or generic operator principal", async () => {
  const f = fixture(true);
  try {
    const q = f.record();
    f.setActor({ kind: "session", session: f.target });
    await expect(f.requests.respond(q.requestID, f.response)).rejects.toThrow(
      "forbidden",
    );
    f.setActor(f.operator);
    await expect(f.requests.respond(q.requestID, f.response)).rejects.toThrow(
      "forbidden",
    );
    await expect(
      f.requests.respondAsOperator(q.requestID, f.response),
    ).rejects.toThrow("forbidden");
    f.setHuman(f.operator);
    expect(
      (await f.requests.respondAsOperator(q.requestID, f.response)).state,
    ).toBe("approved_once");
    expect(
      f.sql
        .query("SELECT name FROM sqlite_master WHERE name LIKE 'grants%'")
        .all(),
    ).toHaveLength(0);
  } finally {
    f.sql.close();
  }
});

test("binding, policy revision, expiration and always fail closed", async () => {
  const f = fixture(true);
  try {
    const q = f.record();
    f.setHuman(f.operator);
    for (const change of [
      { operationID: "wrong" },
      { correlationID: "wrong" },
      { taskGeneration: 2 },
      { target: { ...f.target, sessionID: "wrong" } },
      { revision: 3 },
    ]) {
      await expect(
        f.requests.respondAsOperator(q.requestID, { ...f.response, ...change }),
      ).rejects.toThrow("conflict");
    }
    await expect(
      f.requests.respondAsOperator(q.requestID, {
        ...f.response,
        decision: "always",
      } as unknown as typeof f.response),
    ).rejects.toThrow("invalid_input");
    f.expire();
    expect(
      (await f.requests.respondAsOperator(q.requestID, f.response)).state,
    ).toBe("expired");
    expect(
      JSON.parse(
        (f.sql.query("SELECT body FROM task_records").get() as { body: string })
          .body,
      ).state,
    ).toBe("awaiting_approval");
  } finally {
    f.sql.close();
  }
  const revoked = fixture();
  try {
    const q = revoked.record();
    revoked.revoke();
    await expect(
      revoked.requests.respond(q.requestID, revoked.response),
    ).rejects.toThrow("forbidden");
  } finally {
    revoked.sql.close();
  }
});

test("question recording requires canonical transaction and admitted wait receipt", () => {
  const f = fixture();
  const other = new Database(":memory:");
  try {
    expect(() =>
      f.requests.record(f.sql, {
        taskID: "task",
        operationID: "operation",
        state: "awaiting_input",
      }),
    ).toThrow("unavailable");
    expect(() =>
      other.transaction(() =>
        f.requests.record(other, {
          taskID: "task",
          operationID: "operation",
          state: "awaiting_input",
        }),
      )(),
    ).toThrow("unavailable");
    f.sql.query("DELETE FROM runner_outcomes").run();
    expect(f.record).toThrow("conflict");
  } finally {
    other.close();
    f.sql.close();
  }
});

test("respondent operator revision and instance are exact; denial is final", async () => {
  const f = fixture(true);
  try {
    const q = f.record();
    if (f.operator.kind !== "operator") throw new Error("synthetic operator");
    for (const p of [
      { ...f.operator, operatorID: "other" },
      { ...f.operator, revision: 2 },
      { ...f.operator, instanceID: "other" },
    ]) {
      f.setHuman(p);
      await expect(
        f.requests.respondAsOperator(q.requestID, f.response),
      ).rejects.toThrow("forbidden");
    }
    f.setHuman(f.operator);
    const denial = { ...f.response, decision: "deny" as const };
    expect(
      (await f.requests.respondAsOperator(q.requestID, denial)).state,
    ).toBe("denied");
    expect(
      (await f.requests.respondAsOperator(q.requestID, denial)).state,
    ).toBe("denied");
    await expect(
      f.requests.respondAsOperator(q.requestID, f.response),
    ).rejects.toThrow("conflict");
  } finally {
    f.sql.close();
  }
});

test("operation generation and task target cannot drift after the question", async () => {
  for (const change of ["generation", "target"] as const) {
    const f = fixture();
    try {
      const q = f.record();
      if (change === "generation")
        f.sql.query("UPDATE task_records SET generation=2").run();
      else {
        const row = f.sql
          .query<{ body: string }, []>("SELECT body FROM task_records")
          .get();
        if (!row) throw new Error("missing synthetic task");
        f.sql.query("UPDATE task_records SET body=?").run(
          canonical({
            ...JSON.parse(row.body),
            executor: { ...f.target, sessionID: "other" },
          }),
        );
      }
      await expect(f.requests.respond(q.requestID, f.response)).rejects.toThrow(
        "conflict",
      );
    } finally {
      f.sql.close();
    }
  }
});
