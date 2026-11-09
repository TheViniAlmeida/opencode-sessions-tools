import { expect, test } from "bun:test";
import { DomainError } from "../../src/contracts";
import { parseGroupInput } from "../../src/groups/service";

test("SES-05 group input rejects malformed runtime values", () => {
  for (const value of [
    null,
    undefined,
    {},
    { name: " " },
    { name: "ok", kind: "admin" },
  ]) {
    expect(() => parseGroupInput(value)).toThrow(DomainError);
  }
});

test("SES-05 group and system share explicit validated metadata", () => {
  expect(parseGroupInput({ name: "synthetic", kind: "system" })).toEqual({
    name: "synthetic",
    kind: "system",
  });
});
