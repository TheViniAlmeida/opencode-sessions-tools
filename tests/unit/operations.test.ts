import { expect, test } from "bun:test";
import { canonicalPayloadHash } from "../../src/persistence/operations";

test("canonical payload ignores object order but preserves array order", () => {
  expect(canonicalPayloadHash({ b: 2, a: [1, 2] })).toBe(
    canonicalPayloadHash({ a: [1, 2], b: 2 }),
  );
  expect(canonicalPayloadHash([1, 2])).not.toBe(canonicalPayloadHash([2, 1]));
});

test("non JSON values fail closed without input in error", () => {
  for (const value of [undefined, NaN, { secret: undefined }, new Date()])
    expect(() => canonicalPayloadHash(value)).toThrow("invalid_input");
  const cycle: unknown[] = [];
  cycle.push(cycle);
  expect(() => canonicalPayloadHash(cycle)).toThrow("invalid_input");
});
