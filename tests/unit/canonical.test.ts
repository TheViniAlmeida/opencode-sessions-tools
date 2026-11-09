import { expect, test } from "bun:test";
import { canonical, DomainError } from "../../src/contracts";
import { canonicalPayloadHash } from "../../src/persistence/operations";

test("canonical preserves sorted object keys, array order and existing hash bytes", () => {
  expect(canonical({ z: [3, { b: true, a: null }], a: "x" })).toBe(
    '{"a":"x","z":[3,{"a":null,"b":true}]}',
  );
  expect(canonical([2, 1])).toBe("[2,1]");
  expect(canonical(-0)).toBe("0");
  expect(canonicalPayloadHash({ b: 2, a: 1 })).toBe(
    "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
  );
  const shared = { b: 1 };
  expect(canonical([shared, shared])).toBe('[{"b":1},{"b":1}]');
});

test("canonical retains strict rejection of non-JSON and cyclic inputs", () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  const accessor = Object.defineProperty({}, "x", {
    enumerable: true,
    get() {
      throw new Error("must not execute getter");
    },
  });
  const symbolKey = { [Symbol("x")]: 1 };
  const extraArray = Object.assign([1], { extra: true });
  for (const value of [
    undefined,
    { x: undefined },
    [undefined],
    Number.NaN,
    Infinity,
    -Infinity,
    1n,
    () => {},
    Symbol("x"),
    circular,
    new Date(0),
    Object.create(null),
    accessor,
    symbolKey,
    extraArray,
    new Array(1),
  ]) {
    expect(() => canonical(value)).toThrow(DomainError);
    try {
      canonical(value);
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_input" });
    }
  }
});
