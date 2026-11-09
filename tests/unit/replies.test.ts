import { expect, test } from "bun:test";
import { parseReply, repliesMigrationAt } from "../../src/messaging/replies";

const input = {
  requestID: "op",
  idempotencyKey: "k",
  expectedRevision: 1,
  body: { type: "final", content: "done" },
};
test("strict reply input cannot forge author, correlation or completion from idle", () => {
  expect(parseReply(input).body.type).toBe("final");
  for (const extra of [
    { author: "fake" },
    { source: "fake" },
    { target: "fake" },
    { correlationID: "fake" },
  ])
    expect(() => parseReply({ ...input, ...extra })).toThrow("invalid_input");
  for (const type of ["idle", "completed", "reply", "task_outcome"])
    expect(() =>
      parseReply({ ...input, body: { type, content: "x" } }),
    ).toThrow("invalid_input");
  expect(
    parseReply({
      ...input,
      body: { type: "task_outcome", outcome: "failed", content: "x" },
    }).body.type,
  ).toBe("task_outcome");
  expect(() =>
    parseReply({
      ...input,
      body: { type: "final", content: "x", outcome: "completed" },
    }),
  ).toThrow("invalid_input");
});
test("reject getters, oversized UTF8 and invalid descriptor versions", () => {
  expect(() =>
    parseReply({
      ...input,
      get body() {
        throw new Error("getter");
      },
    }),
  ).toThrow("invalid_input");
  expect(() =>
    parseReply({
      ...input,
      body: { type: "final", content: "é".repeat(32769) },
    }),
  ).toThrow("invalid_input");
  expect(repliesMigrationAt(21).version).toBe(21);
  expect(() => repliesMigrationAt(1)).toThrow("invalid_input");
});
