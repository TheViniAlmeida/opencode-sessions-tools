import { beforeAll, expect, test } from "bun:test";
import { probeToolIdentity } from "../../scripts/probes/identity";

let report: Awaited<ReturnType<typeof probeToolIdentity>>;
beforeAll(async () => {
  report = await probeToolIdentity();
}, 120_000);

test("host tool-call executes with host session identity, never provider claims", () => {
  expect(report.sessions).toHaveLength(2);
  expect(
    new Set([
      ...report.sessions.map((session) => session.id),
      report.forgedSession?.id,
      report.strictSession?.id,
    ]).size,
  ).toBe(4);
  for (const session of report.sessions) {
    expect(session.observations.length).toBeGreaterThan(0);
    for (const observation of session.observations) {
      expect(observation.sessionID).toBe(session.id);
      expect(observation.agent).toBe("build");
      expect(session.callIDs).toContain(observation.callID);
    }
  }
  expect(report.forgedIdentityObserved).toBe(false);
  expect(report.hostAndProviderRestarted).toBe(true);
  expect(
    report.providerRequests.some((request) =>
      request.toolNames.includes("identity_diagnostic"),
    ),
  ).toBe(true);
  expect(report.providerRequests.some((request) => request.resultSeen)).toBe(
    true,
  );
}, 120_000);

test("claims demonstrably reach permissive handler but never become host identity", () => {
  const session = report.forgedSession;
  expect(session).toBeDefined();
  if (!session) throw new Error("Forged session absent");
  expect(session.forgedOutcome).toBe("received-claims-ignored");
  expect(session.observations.length).toBeGreaterThan(0);
  for (const observation of session.observations) {
    expect(observation.receivedKeys).toEqual([
      "action",
      "caller_sessionID",
      "principal",
    ]);
    expect(observation.sessionID).toBe(session.id);
    expect(observation.sessionID).not.toBe("synthetic-forged");
    expect(observation.agent).toBe("build");
    expect(session.callIDs).toContain(observation.callID);
  }
});

test("strict schema rejection or normalization preserves host identity (versioned observation)", () => {
  const session = report.strictSession;
  if (!session) throw new Error("Strict session absent");
  expect(["rejected", "normalized-identity-preserved"]).toContain(
    session.forgedOutcome,
  );
  if (session.forgedOutcome === "rejected")
    expect(session.observations).toHaveLength(0);
  else {
    expect(session.observations.length).toBeGreaterThan(0);
    for (const observation of session.observations) {
      expect(observation.sessionID).toBe(session.id);
      expect(observation.sessionID).not.toBe("synthetic-forged");
      expect(observation.agent).toBe("build");
      expect(session.callIDs).toContain(observation.callID);
    }
  }
});
