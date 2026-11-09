import { describe, expect, test } from "bun:test";
import {
  deliveryOutcome,
  runDeliveryProbe,
  runDeliveryRuntimeProbe,
} from "../../scripts/probes/delivery";

describe("T4 delivery admission evidence", () => {
  test("host busy, steer priority, queue ordering, explicit resume and runtime failure", async () => {
    const result = await runDeliveryRuntimeProbe();
    expect(result.hostBusy).toBe(true);
    expect(result.heldMessages.map((m: { id: string }) => m.id)).toEqual([
      result.initialID,
    ]);
    expect(result.heldInbox.map((m: { id: string }) => m.id)).toEqual([
      ...result.admitted.map((m) => m.id),
      result.notificationID,
    ]);
    expect(result.admitted.map((m) => m.delivery)).toEqual([
      "queue",
      "queue",
      "steer",
    ]);
    expect(
      result.admitted.every((m) => typeof m.correlation === "string"),
    ).toBe(true);
    expect(result.completed).toBe(true);
    expect(result.orderedIDs).toEqual([
      result.initialID,
      result.admitted[2]?.id,
      result.admitted[0]?.id,
      result.admitted[1]?.id,
      result.notificationID,
    ]);
    expect(result.remaining).toEqual([]);
    const assistants = result.messages.filter(
      (m: { type: string }) => m.type === "assistant",
    );
    expect(assistants.length).toBe(5);
    expect(
      assistants.every(
        (m: { time: { completed?: number }; finish: string }) =>
          m.time.completed !== undefined && m.finish === "stop",
      ),
    ).toBe(true);
    expect(result.noWake).toBe(true);
    expect(result.resumed).toBe(true);
    expect(result.resumedNotificationInHistory).toBe(true);
    expect(result.failedObserved).toBe(true);
    expect(
      result.failedMessages.some(
        (m: { type: string; finish?: string; error?: { type: string } }) =>
          m.type === "assistant" &&
          m.finish === "error" &&
          m.error?.type === "provider.invalid-request",
      ),
    ).toBe(true);
    expect(result.productFIFOProven).toBe(false);
  }, 30000);
  test("admission and idle never imply completion; missing evidence stays unknown", () => {
    expect(deliveryOutcome({})).toBe("unknown");
    expect(deliveryOutcome({ receipt: true })).toBe("admitted");
    expect(deliveryOutcome({ receipt: true, completed: true })).toBe(
      "completed",
    );
    expect(deliveryOutcome({ receipt: true, failed: true })).toBe("failed");
  });
  test("isolated admission, lost response reconciliation and restart", async () => {
    const result = await runDeliveryProbe();
    expect(result.state).toBe("partial");
    expect(result.cases.map((item) => item.delivery)).toEqual([
      "queue",
      "queue",
      "steer",
    ]);
    for (const item of result.cases) {
      expect(item.status).toBe(200);
      expect(item.outcome).toBe("admitted");
      expect(item.correlationPreserved).toBe(true);
    }
    expect(result.notification.status).toBe(200);
    expect(result.notification.present).toBe(true);
    expect(result.notification.executionStarted).toBe(false);
    expect(result.notification.historyCount).toBe(0);
    expect(result.notification.busy).toBe(false);
    expect(result.fifo.admissionOrderPreserved).toBe(true);
    expect(result.fifo.consumptionProven).toBe(false);
    expect(result.timeout).toEqual({
      injected: true,
      beforeReconciliation: "unknown",
      afterReconciliation: "admitted",
      writes: 1,
      matchingItems: 1,
      correlationPreserved: true,
      restartMatches: 1,
    });
    expect(result.limits.busyProven).toBe(false);
    expect(result.limits.providerExecutionAttempted).toBe(false);
  }, 120_000);
});
