import { expect, test } from "bun:test";
import { aggregateUsage, parseUsage } from "../../src/observability/usage";

test("API-06 reported and estimated mix, homogeneous quality survives", () => {
  const reported = parseUsage({ cost: { value: 1, quality: "reported" } });
  const estimated = parseUsage({ cost: { value: 2, quality: "estimated" } });
  expect(aggregateUsage([reported, estimated]).cost).toEqual({
    value: 3,
    quality: "mixed",
  });
  expect(aggregateUsage([reported, reported]).cost).toEqual({
    value: 2,
    quality: "reported",
  });
  expect(aggregateUsage([estimated, estimated]).cost).toEqual({
    value: 4,
    quality: "estimated",
  });
  expect(aggregateUsage([reported, parseUsage({})]).cost).toEqual({
    value: null,
    quality: "unavailable",
  });
});

test("API-06 active and elapsed are independent; missing duration stays unknown", () => {
  const snapshot = parseUsage({
    activeMs: { value: 1000, quality: "reported" },
    elapsedMs: { value: 5000, quality: "estimated" },
  });
  expect(aggregateUsage([snapshot]).activeMs).toEqual({
    value: 1000,
    quality: "reported",
  });
  expect(aggregateUsage([snapshot]).elapsedMs).toEqual({
    value: 5000,
    quality: "estimated",
  });
  const missing = parseUsage({ elapsedMs: { value: 0, quality: "reported" } });
  expect(missing.activeMs).toEqual({ value: null, quality: "unavailable" });
  expect(missing.elapsedMs).toEqual({ value: 0, quality: "reported" });
});

test("unknown differs from known zero; imported cost is not provider billing", () => {
  const zero = parseUsage({ cost: { value: 0, quality: "synthetic_import" } });
  expect(aggregateUsage([zero]).cost.value).toBe(0);
  expect(aggregateUsage([zero]).cost.quality).toBe("synthetic_import");
  expect(aggregateUsage([zero, parseUsage({})]).cost.value).toBeNull();
  expect(zero.activeMs.value).toBeNull();
  expect(zero.elapsedMs.value).toBeNull();
});

test("strict finite metrics and aggregation overflow", () => {
  for (const value of [-1, NaN, Infinity, "0", undefined])
    expect(() =>
      parseUsage({ cost: { value, quality: "reported" } }),
    ).toThrow();
  const huge = parseUsage({
    cost: { value: Number.MAX_VALUE, quality: "reported" },
  });
  expect(() => aggregateUsage([huge, huge])).toThrow();
});

test("cache tokens stay explicit and are not added to input tokens", () => {
  const usage = parseUsage({
    inputTokens: { value: 10, quality: "reported" },
    cacheReadTokens: { value: 5, quality: "reported" },
  });
  expect(aggregateUsage([usage]).inputTokens.value).toBe(10);
  expect(aggregateUsage([usage]).cacheReadTokens.value).toBe(5);
});
