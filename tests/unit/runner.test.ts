import { expect, test } from "bun:test";
import {
  decideTaskAdmission,
  parseTaskOutcome,
} from "../../src/orchestration/runner";
import type { TaskRecord } from "../../src/orchestration/tasks";

function task(
  taskID: string,
  state: TaskRecord["state"] = "pending",
  dependencies: string[] = [],
): TaskRecord {
  return {
    version: 1,
    taskID,
    groupID: "group",
    state,
    dependencies,
    objective: "Synthetic objective",
    expectedResult: "Explicit reply",
    author: {
      kind: "operator",
      operatorID: "synthetic",
      instanceID: "fixture",
      revision: 1,
    },
    executor: {
      version: 1,
      instanceID: "fixture",
      projectID: "project",
      sessionID: taskID,
    },
  };
}

test("TSK-03/07 join waits for every dependency", () => {
  const tasks = [
    task("a", "completed"),
    task("b", "running"),
    task("join", "pending", ["a", "b"]),
  ];
  expect(decideTaskAdmission(tasks, "join")).toEqual({
    ready: false,
    reason: "dependencies",
  });
  tasks[1] = task("b", "completed");
  expect(decideTaskAdmission(tasks, "join")).toEqual({ ready: true });
});

test("TSK-04 cancellation still consumes a concurrency slot", () => {
  const tasks = [
    task("a", "running"),
    task("b", "running"),
    task("c", "running"),
    task("d", "cancel_requested"),
    task("e"),
  ];
  expect(decideTaskAdmission(tasks, "e")).toEqual({
    ready: false,
    reason: "concurrency_limit",
  });
  tasks[3] = task("d", "cancelled");
  expect(decideTaskAdmission(tasks, "e")).toEqual({ ready: true });
});

test("TSK-04 depth comes from longest trusted dependency path, root depth one", () => {
  const tasks = [
    task("a", "completed"),
    task("b", "completed", ["a"]),
    task("c", "completed", ["b"]),
    task("d", "pending", ["c"]),
    task("e", "pending", ["d"]),
  ];
  expect(decideTaskAdmission(tasks, "d")).toEqual({ ready: true });
  tasks[3] = task("d", "completed", ["c"]);
  expect(decideTaskAdmission(tasks, "e")).toEqual({
    ready: false,
    reason: "depth_limit",
  });
});

test("terminal, running and cancellation-requested tasks cannot be admitted again", () => {
  for (const state of [
    "completed",
    "failed",
    "cancelled",
    "running",
    "cancel_requested",
    "blocked",
  ] as const)
    expect(decideTaskAdmission([task("a", state)], "a")).toEqual({
      ready: false,
      reason: "state",
    });
});

test("malformed trusted graph fails closed", () => {
  for (const tasks of [
    [task("a", "pending", ["missing"])],
    [task("a", "pending", ["a"])],
    [task("a"), task("a")],
  ])
    expect(() => decideTaskAdmission(tasks, "a")).toThrow();
});

test("TSK-05 idle, acceptance, uncorrelated and empty outcomes never complete work", () => {
  for (const value of [
    { state: "idle" },
    { state: "accepted" },
    { state: "completed", evidence: "ok" },
    { state: "completed", operationID: "op", evidence: " " },
  ])
    expect(() => parseTaskOutcome(value)).toThrow();
  expect(
    parseTaskOutcome({
      state: "completed",
      operationID: "op",
      evidence: "explicit reply",
      admissionID: "admission",
      correlationID: "correlation",
      taskGeneration: 1,
    }),
  ).toEqual({
    state: "completed",
    operationID: "op",
    evidence: "explicit reply",
    admissionID: "admission",
    correlationID: "correlation",
    taskGeneration: 1,
  });
});
