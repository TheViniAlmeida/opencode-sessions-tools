import { expect, test } from "bun:test";
import { validateTaskGraph } from "../../src/orchestration/tasks";

test("TSK-02 rejects cycles and missing dependencies with conflict", () => {
  for (const graph of [
    [{ taskID: "a", dependencies: ["a"] }],
    [
      { taskID: "a", dependencies: ["b"] },
      { taskID: "b", dependencies: ["a"] },
    ],
    [{ taskID: "a", dependencies: ["absent"] }],
  ])
    expect(() => validateTaskGraph(graph)).toThrow(
      expect.objectContaining({ code: "conflict" }),
    );
});

test("fork/join DAG is accepted", () => {
  expect(() =>
    validateTaskGraph([
      { taskID: "a", dependencies: [] },
      { taskID: "b", dependencies: ["a"] },
      { taskID: "c", dependencies: ["a"] },
      { taskID: "d", dependencies: ["b", "c"] },
    ]),
  ).not.toThrow();
});
