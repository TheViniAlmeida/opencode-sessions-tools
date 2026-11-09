import { expect, test } from "bun:test";
import {
  dispatcherMigrationAt,
  parsePrompt,
} from "../../src/messaging/dispatcher";

const input = {
  target: { version: 1, instanceID: "i", projectID: "p", sessionID: "s" },
  content: "hello",
  expiresAt: 2000,
  expectedRevision: 1,
  idempotencyKey: "k",
};
test("queue is default and steer is explicit; tool cannot forge origin or chain", () => {
  expect(parsePrompt(input).policy).toBe("queue");
  expect(parsePrompt({ ...input, policy: "steer" }).policy).toBe("steer");
  for (const extra of [
    { hops: 0 },
    { correlationID: "forged" },
    { source: "forged" },
    { policy: "interrupt" },
  ])
    expect(() => parsePrompt({ ...input, ...extra })).toThrow("invalid_input");
});
test("strict data properties and UTF8 limit; migration has no fixed version", () => {
  expect(() =>
    parsePrompt({
      ...input,
      get policy() {
        throw new Error("getter");
      },
    }),
  ).toThrow("invalid_input");
  expect(() =>
    parsePrompt({ ...input, content: `${"é".repeat(32768)}a` }),
  ).toThrow("invalid_input");
  expect(
    parsePrompt({ ...input, content: "é".repeat(32768) }).content.length,
  ).toBe(32768);
  expect(dispatcherMigrationAt(20).version).toBe(20);
  expect(() => dispatcherMigrationAt(1)).toThrow("invalid_input");
});
