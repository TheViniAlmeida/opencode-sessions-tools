import { describe, expect, test } from "bun:test";
import { metric, parseSSE, runUsageProbe } from "../../scripts/probes/usage";

describe("T8 usage evidence", () => {
  test("missing/invalid metrics remain null; explicit zero survives", () => {
    for (const value of [undefined, null, NaN, Infinity, -1, "0"])
      expect(metric(value)).toEqual({ value: null, quality: "unavailable" });
    expect(metric(0).value).toBe(0);
    expect(metric(0.125).quality).toBe("synthetic_import");
  });
  test("SSE handles encoded JSON, CRLF and sync frames", () => {
    expect(parseSSE('id: 7\r\ndata: "{\\"seq\\":7}"\r\n\r\n')[0]).toEqual({
      id: "7",
      data: { seq: 7 },
    });
    expect(parseSSE(": heartbeat\n\n")).toEqual([]);
  });
  test("isolated HTTP imports preserve known and unknown message usage", async () => {
    const result = await runUsageProbe();
    expect(result.state).toBe("observed");
    expect(result.providerCalls).toBe(0);
    expect(result.cases[0]?.messageCost.value).toBe(0.125);
    expect(result.cases[0]?.messageInput.value).toBe(101);
    expect(result.cases[1]?.messageCost.value).toBeNull();
    expect(result.cases[1]?.messageInput.value).toBeNull();
    expect(result.cases[1]?.sessionCost.value).toBe(0);
    expect(result.stats.before.status).toBe(200);
    expect(result.stats.after.status).toBe(200);
    expect(result.stats.after.data.cost - result.stats.before.data.cost).toBe(
      0.125,
    );
    expect(result.stats.after.data.tokens.input).toBe(101);
    expect(result.stats.after.data.activity).toEqual([
      { date: "2026-11-07", steps: 2 },
    ]);
    expect(result.contract.statsParameters).not.toContain("cursor");
    expect(result.contract.logParameters).toContain("after");
    expect(result.contract.messageUsageRequired).toBe(false);
    expect(result.stream.handshakeObserved).toBe(true);
    expect(result.limits.realBillingProven).toBe(false);
  }, 120_000);
});
