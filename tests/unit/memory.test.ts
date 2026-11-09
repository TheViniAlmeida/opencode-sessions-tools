import { expect, test } from "bun:test";
import { parseMemoryWrite } from "../../src/context/memory";

test("memory input validates CAS and canonical UTC expiry", () => {
  for (const input of [
    null,
    {},
    { key: "k", value: "v", expectedRevision: -1 },
    { key: "k", value: "v", expectedRevision: 0, expiresAt: "2026-11-08" },
  ]) {
    expect(() => parseMemoryWrite(input)).toThrow();
  }
  expect(
    parseMemoryWrite({
      key: "synthetic",
      value: "value",
      expectedRevision: 0,
      expiresAt: null,
    }).expectedRevision,
  ).toBe(0);
});
