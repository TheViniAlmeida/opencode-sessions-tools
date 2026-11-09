import { expect, test } from "bun:test";
import { nextScheduleDue, validateSchedule } from "../../src/schedules/service";

test("SCH-01/02: canonical contracts and anchored five minute interval", () => {
  const schedule = validateSchedule({
    version: 1,
    kind: "interval",
    timezone: "UTC",
    anchorUTC: "2026-01-01T00:00:00.000Z",
    periodMs: 300_000,
  });
  expect(
    nextScheduleDue(schedule, 0, Date.parse("2026-01-01T00:00:00.000Z")),
  ).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
  expect(
    nextScheduleDue(schedule, 3, Date.parse("2026-01-01T00:00:00.000Z")),
  ).toBe(Date.parse("2026-01-01T00:15:00.000Z"));
  expect(() =>
    validateSchedule({ ...schedule, dueUTC: "2026-01-01T00:00:00.000Z" }),
  ).toThrow("invalid_input");
  expect(() =>
    validateSchedule({ ...schedule, conditions: { shell: "false" } }),
  ).toThrow("unsupported");
  expect(() =>
    validateSchedule({ ...schedule, timezone: "Not/AZone" }),
  ).toThrow("invalid_input");
  expect(() => validateSchedule({ ...schedule, timezone: "+01:00" })).toThrow(
    "invalid_input",
  );
  expect(() => validateSchedule({ ...schedule, if: "code mode" })).toThrow(
    "unsupported",
  );
});

test("SCH-09: New York gap is skipped and fold uses the first instant only", () => {
  const gap = validateSchedule({
    version: 1,
    kind: "cron",
    timezone: "America/New_York",
    expression: "30 2 * * *",
    referenceUTC: "2026-03-08T00:00:00.000Z",
  });
  expect(nextScheduleDue(gap, 0, 0)).toBe(
    Date.parse("2026-03-09T06:30:00.000Z"),
  );
  const fold = validateSchedule({
    version: 1,
    kind: "cron",
    timezone: "America/New_York",
    expression: "30 1 * * *",
    referenceUTC: "2026-11-01T00:00:00.000Z",
  });
  expect(nextScheduleDue(fold, 0, 0)).toBe(
    Date.parse("2026-11-01T05:30:00.000Z"),
  );
  expect(
    nextScheduleDue(fold, 1, 0, Date.parse("2026-11-01T05:30:00.000Z")),
  ).toBe(Date.parse("2026-11-02T06:30:00.000Z"));
});

test("one-shots have one index; impossible calendar and malformed grammar fail bounded", () => {
  const timer = validateSchedule({
    version: 1,
    kind: "timer",
    timezone: "UTC",
    delayMs: 1000,
  });
  expect(nextScheduleDue(timer, 0, 500)).toBe(1500);
  expect(nextScheduleDue(timer, 1, 500)).toBeNull();
  for (const expression of ["not cron", "0 0 31 2 *", "60 * * * *"])
    expect(() =>
      validateSchedule({
        version: 1,
        kind: "cron",
        timezone: "UTC",
        expression,
        referenceUTC: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow("invalid_input");
});

test("calendar boundaries include leap day, lists/ranges/names and fold restart", () => {
  const leap = validateSchedule({
    version: 1,
    kind: "cron",
    timezone: "UTC",
    expression: "0 0 29 FEB *",
    referenceUTC: "2026-01-01T00:00:00.000Z",
  });
  expect(nextScheduleDue(leap, 0, 0)).toBe(
    Date.parse("2028-02-29T00:00:00.000Z"),
  );
  const named = validateSchedule({
    version: 1,
    kind: "cron",
    timezone: "UTC",
    expression: "0,30 9-17/2 * * MON-FRI",
    referenceUTC: "2026-11-06T17:30:00.000Z",
  });
  expect(nextScheduleDue(named, 0, 0)).toBe(
    Date.parse("2026-11-09T09:00:00.000Z"),
  );
  const fold = validateSchedule({
    version: 1,
    kind: "cron",
    timezone: "America/New_York",
    expression: "30 1 * * *",
    referenceUTC: "2026-11-01T06:15:00.000Z",
  });
  expect(nextScheduleDue(fold, 0, 0)).toBe(
    Date.parse("2026-11-02T06:30:00.000Z"),
  );
});

test("safe integer and Date bounds reject unrepresentable anchored instants", () => {
  const timer = validateSchedule({
    version: 1,
    kind: "timer",
    timezone: "UTC",
    delayMs: Number.MAX_SAFE_INTEGER,
  });
  expect(() => nextScheduleDue(timer, 0, 1000)).toThrow("invalid_input");
});
