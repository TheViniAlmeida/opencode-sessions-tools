import { expect, test } from "bun:test";
import { parseNotification } from "../../src/messaging/inbox";

const target = { version: 1, instanceID: "i", projectID: "p", sessionID: "s" };
const input = (content: string) => ({
  target,
  content,
  correlationID: "c",
  expiresAt: 1000,
  idempotencyKey: "k",
  expectedRevision: 1,
});

test("UTF-8 accepts exactly 65536 bytes, refuses 65537", () => {
  expect(parseNotification(input("é".repeat(32768))).content.length).toBe(
    32768,
  );
  expect(() => parseNotification(input(`${"é".repeat(32768)}a`))).toThrow(
    "invalid_input",
  );
});

test("notification input cannot supply origin, principal, type or force", () => {
  for (const key of ["source", "principal", "type", "force", "operationID"]) {
    expect(() =>
      parseNotification({ ...input("secret"), [key]: "spoof" }),
    ).toThrow("invalid_input");
  }
});

test("expiry and revision must be finite safe integers", () => {
  for (const n of [-1, NaN, Infinity, 0.5]) {
    expect(() => parseNotification({ ...input(""), expiresAt: n })).toThrow(
      "invalid_input",
    );
    expect(() =>
      parseNotification({ ...input(""), expectedRevision: n }),
    ).toThrow("invalid_input");
  }
});
