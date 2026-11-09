import { expect, test } from "bun:test";
import { normalizeGrantCapabilities } from "../../src/authorization/grants";

test("grant capabilities are explicit, validated and canonical", () => {
  expect(normalizeGrantCapabilities(["read", "message", "read"])).toEqual([
    "message",
    "read",
  ]);
  for (const input of [[], ["unknown"], null, "read"]) {
    expect(() => normalizeGrantCapabilities(input)).toThrow("invalid_input");
  }
});
