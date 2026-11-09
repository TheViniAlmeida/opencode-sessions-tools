import { describe, expect, test } from "bun:test";
import {
  capabilities,
  deliveryStates,
  errorCodes,
  occurrenceID,
  parseCapability,
  parseDeliveryState,
  parseError,
  parseMessageContent,
  parseMutation,
  parseSchedule,
  parseSessionRef,
  parseTaskState,
  requireCapability,
  resolveOwnership,
  taskStates,
  transitionDelivery,
  transitionTask,
} from "../../src/contracts/index.ts";

describe("T9 versioned domain boundary", () => {
  test("runtime enums reject unknown values, error details cannot leak payload", () => {
    for (const value of capabilities)
      expect(parseCapability(value)).toBe(value);
    for (const value of deliveryStates)
      expect(parseDeliveryState(value)).toBe(value);
    for (const value of taskStates) expect(parseTaskState(value)).toBe(value);
    for (const value of [null, "delete", "policy", {}, 1])
      expect(() => parseCapability(value)).toThrow("invalid_input");
    expect(() => parseDeliveryState("already_admitted")).toThrow(
      "invalid_input",
    );
    expect(() => parseTaskState("idle")).toThrow("invalid_input");
    for (const code of errorCodes)
      expect(
        parseError({ version: 1, code, message: code, retryable: false }),
      ).toEqual({ version: 1, code, message: code, retryable: false });
    for (const value of [
      { version: 1, code: "oops", retryable: false },
      { version: 1, code: "conflict", message: "conflict", retryable: "true" },
      { version: 1, code: "conflict", message: "raw secret", retryable: false },
      {
        version: 1,
        code: "conflict",
        message: "conflict",
        retryable: false,
        details: { token: "raw" },
      },
    ])
      expect(() => parseError(value)).toThrow("invalid_input");
  });
  test("schedule discriminant, timezone and executable conditions (SCH-01/10)", () => {
    const interval = {
      version: 1,
      kind: "interval",
      timezone: "America/Belem",
      anchorUTC: "2026-11-07T00:00:00.000Z",
      periodMs: 300000,
    } as const;
    expect(parseSchedule(interval)).toEqual(interval);
    expect(
      parseSchedule({
        version: 1,
        kind: "timer",
        timezone: "UTC",
        delayMs: 1000,
      }),
    ).toEqual({ version: 1, kind: "timer", timezone: "UTC", delayMs: 1000 });
    expect(
      parseSchedule({
        version: 1,
        kind: "date",
        timezone: "UTC",
        dueUTC: "2026-11-07T00:00:00.000Z",
      }).kind,
    ).toBe("date");
    expect(
      parseSchedule({
        version: 1,
        kind: "cron",
        timezone: "America/New_York",
        expression: "30 1 * * *",
        referenceUTC: "2026-11-07T00:00:00.000Z",
      }).kind,
    ).toBe("cron");
    for (const value of [
      { ...interval, timezone: "no/zone" },
      { ...interval, periodMs: 0 },
      { ...interval, anchorUTC: "2026-02-30T00:00:00.000Z" },
      { ...interval, kind: "shell" },
      { ...interval, cron: "* * * * *" },
      { ...interval, kind: "cron", expression: "invalid" },
    ])
      expect(() => parseSchedule(value)).toThrow("invalid_input");
    for (const conditions of ["echo x", { code: "1+1" }, null])
      expect(() => parseSchedule({ ...interval, conditions })).toThrow(
        "unsupported",
      );
  });
  test("message content limit is UTF-8 bytes (MSG-09)", () => {
    expect(parseMessageContent("é".repeat(32768))).toHaveLength(32768);
    expect(() => parseMessageContent(`${"é".repeat(32768)}a`)).toThrow(
      "invalid_input",
    );
    expect(() => parseMessageContent({ text: "hi" })).toThrow("invalid_input");
  });
  test("closed product capabilities and exact errors (API-08/10)", () => {
    expect(capabilities).toHaveLength(9);
    expect(capabilities).not.toContain("delete");
    expect(errorCodes).toEqual([
      "invalid_input",
      "not_found",
      "forbidden",
      "conflict",
      "unsupported",
      "expired",
      "rate_limited",
      "unavailable",
      "unknown_outcome",
    ]);
    expect(() => requireCapability({ supported: false })).toThrow(
      "unsupported",
    );
    expect(() => requireCapability({ supported: true })).not.toThrow();
  });
  test("unknown input, version, extra keys and identity claims rejected", () => {
    const ref = {
      version: 1,
      instanceID: "host",
      sessionID: "session",
      projectID: "project",
    } as const;
    expect(parseSessionRef(ref)).toEqual(ref);
    for (const value of [
      null,
      [],
      "session",
      {},
      { ...ref, version: 2 },
      { ...ref, sessionID: "" },
      { ...ref, principal: "operator" },
    ]) {
      expect(() => parseSessionRef(value)).toThrow("invalid_input");
    }
    expect(
      parseMutation({ version: 1, idempotencyKey: "key", payload: null }),
    ).toEqual({ version: 1, idempotencyKey: "key", payload: null });
    for (const value of [
      { version: 1, payload: {} },
      { version: 1, idempotencyKey: "key", payload: {}, principal: "operator" },
    ]) {
      expect(() => parseMutation(value)).toThrow("invalid_input");
    }
  });
  test("every delivery pair follows spec and reconciliation is explicit (REL-05)", () => {
    const edges = new Set([
      "pending:dispatching",
      "pending:rejected",
      "pending:expired",
      "dispatching:admitted",
      "dispatching:rejected",
      "dispatching:unknown_outcome",
      "unknown_outcome:admitted",
      "unknown_outcome:rejected",
    ]);
    for (const from of deliveryStates)
      for (const to of deliveryStates) {
        if (edges.has(`${from}:${to}`))
          expect(transitionDelivery(from, to, { reconciled: true })).toBe(to);
        else
          expect(() =>
            transitionDelivery(from, to, { reconciled: true }),
          ).toThrow("conflict");
      }
    expect(() => transitionDelivery("unknown_outcome", "admitted")).toThrow(
      "conflict",
    );
    expect(() => transitionDelivery("delivered" as never, "admitted")).toThrow(
      "conflict",
    );
  });
  test("every task pair follows spec, blocked requires replanning (REL-05)", () => {
    const edges = new Set([
      "pending:running",
      "pending:blocked",
      "pending:cancelled",
      "blocked:pending",
      "blocked:cancelled",
      "running:completed",
      "running:failed",
      "running:awaiting_input",
      "running:awaiting_approval",
      "running:cancel_requested",
      "awaiting_input:running",
      "awaiting_input:cancel_requested",
      "awaiting_approval:running",
      "awaiting_approval:cancel_requested",
      "cancel_requested:cancelled",
      "cancel_requested:completed",
      "cancel_requested:failed",
    ]);
    for (const from of taskStates)
      for (const to of taskStates) {
        if (edges.has(`${from}:${to}`))
          expect(transitionTask(from, to, { replanned: true })).toBe(to);
        else
          expect(() => transitionTask(from, to, { replanned: true })).toThrow(
            "conflict",
          );
      }
    expect(() => transitionTask("blocked", "pending")).toThrow("conflict");
    expect(() => transitionTask("idle" as never, "completed")).toThrow(
      "conflict",
    );
  });
  test("canonical occurrence tuple is stable and delimiter-safe (SCH-06)", () => {
    expect(occurrenceID("a:1", 2, 3)).toBe(occurrenceID("a:1", 2, 3));
    expect(occurrenceID("a:1", 2, 3)).not.toBe(occurrenceID("a", 1, 23));
    expect(occurrenceID("a", 1, 0)).not.toBe(occurrenceID("a", 2, 0));
    expect(occurrenceID("a", 1, 0)).not.toBe(occurrenceID("a", 1, 1));
    for (const n of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(() => occurrenceID("a", 1, n)).toThrow("invalid_input");
    expect(() => occurrenceID("", 1, 0)).toThrow("invalid_input");
  });
  test("ownership requires canonical evidence, not lexical path equality (SCH-06)", () => {
    const claim = {
      instanceID: "host",
      scopeID: "scope",
      installationID: "install",
      canonicalPath: "/data/plugin.sqlite",
      databaseIdentity: "device:inode",
    };
    expect(resolveOwnership([claim, { ...claim }])).toEqual(claim);
    for (const claims of [
      [],
      [{ ...claim, canonicalPath: "../db" }],
      [{ ...claim, databaseIdentity: "" }],
      [claim, { ...claim, installationID: "other" }],
      [claim, { ...claim, databaseIdentity: "other" }],
      [claim, { ...claim, canonicalPath: "/symlink/db" }],
      [claim, { ...claim, scopeID: "other" }],
    ]) {
      expect(() => resolveOwnership(claims)).toThrow("unavailable");
    }
  });
});
