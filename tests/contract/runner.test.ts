import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { canonical, type Principal } from "../../src/contracts";
import {
  parseTaskOutcome,
  RUNNER_MIGRATION,
  runnerAdmissionEvidence,
  runnerOutcomeEvidence,
} from "../../src/orchestration/runner";

test("runner evidence adapters are synchronous canonical-SQLite lookups, bootstrap operation may be null", () => {
  const sql = new Database(":memory:");
  try {
    sql.exec(
      "CREATE TABLE task_records(task_id TEXT PRIMARY KEY); INSERT INTO task_records VALUES('task')",
    );
    RUNNER_MIGRATION.apply(sql, "synthetic");
    const owner: Principal = {
      kind: "operator",
      operatorID: "synthetic",
      instanceID: "fixture",
      revision: 1,
    };
    sql
      .query(
        "INSERT INTO runner_intents(admission_id,task_id,group_id,owner_json,correlation_id,task_generation,kind,prompt_json) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        "admission",
        "task",
        "group",
        canonical(owner),
        "correlation",
        1,
        "execution",
        "{}",
      );
    const admission = runnerAdmissionEvidence.lookup(
      sql,
      "group",
      "task",
      owner,
      "journal",
    );
    if (!admission) throw new Error("missing admission");
    expect(admission.operationID).toBeNull();
    expect(Object.isFrozen(admission)).toBe(true);
    expect(runnerOutcomeEvidence.lookup(sql, admission)).toBeNull();
    sql.query("UPDATE runner_intents SET operation_id='operation'").run();
    const outcome = parseTaskOutcome({
      admissionID: "admission",
      operationID: "operation",
      correlationID: "correlation",
      taskGeneration: 1,
      state: "completed",
      evidence: "explicit trusted reply",
    });
    sql
      .query("INSERT INTO runner_outcomes(admission_id,body) VALUES(?,?)")
      .run("admission", canonical(outcome));
    expect(runnerOutcomeEvidence.lookup(sql, admission)).toEqual(outcome);
    expect(() =>
      runnerAdmissionEvidence.lookup(
        sql,
        "group",
        "task",
        {
          ...owner,
          operatorID: "other",
        },
        "journal",
      ),
    ).toThrow();
  } finally {
    sql.close();
  }
});

test("typed host evidence still requires runtime operation/admission/generation correlation fields", () => {
  const outcome = {
    admissionID: "admission",
    operationID: "operation",
    correlationID: "correlation",
    taskGeneration: 1,
    state: "completed",
    evidence: "explicit result",
  };
  for (const patch of [
    { taskGeneration: 0 },
    { taskGeneration: 1.5 },
    { correlationID: "" },
    { admissionID: "" },
    { state: "idle" },
    { state: "accepted" },
  ])
    expect(() => parseTaskOutcome({ ...outcome, ...patch })).toThrow();
});
