import { expect, test } from "bun:test";
import { probeIdentity } from "../../scripts/probes/identity";

test("private RPC exposes no operator principal and fixture ignores forged identity claims", async () => {
  const report = await probeIdentity();
  expect(report.version).toBe("opencode v2.2.5");
  expect(report.candidateOnly).toBe(true);
  expect(report.policy.status).toBe(200);
  expect(report.policy.result.data.effect).toBe("deny");
  expect(report.origins).toEqual([
    { origin: "absent", status: 200, allowOrigin: null },
    {
      origin: "http://localhost:4096",
      status: 200,
      allowOrigin: "http://localhost:4096",
    },
    { origin: "https://untrusted.invalid", status: 200, allowOrigin: null },
  ]);
  expect(report.registeredRPC.status).toBe(200);
  expect(report.registeredRPC.result.output).toEqual({
    operator: false,
    contextKeys: ["error", "signal"],
  });
  expect(report.registeredRPC.provesPrincipal).toBe(false);
  expect(report.pluginActivation.status).toBe(200);
  expect(report.pluginActivation.registeredCount).not.toBeNull();
  expect(report.pluginActivation.fixturePresent).toBe(true);
  expect(report.pluginActivation.fixtureState).toBe("active");
  expect(report.pluginActivation.nonBuiltinCount).toBe(1);
  expect(report.pluginActivation.blocker).toBeNull();
  expect(report.rpcClaims.map((r) => r.claim)).toEqual([
    "absent",
    "agent",
    "operator",
  ]);
  for (const claim of report.rpcClaims) {
    expect(claim.status).toBe(200);
    expect(claim.result.output).toEqual({
      operator: false,
      contextKeys: ["error", "signal"],
    });
  }
  expect(report.rpcAuthentication).toEqual([
    { kind: "absent", status: 401 },
    { kind: "Bearer", status: 401 },
  ]);
  expect(report.external.enabled).toBe(false);
  expect(report.integration.toolIdentity).toBe("NOT_VALIDATED");
  expect(report.integration.rpcIdentity).toContain("OBSERVED");
  expect(report.authentication).toEqual([
    { kind: "absent", status: 401 },
    { kind: "Bearer", status: 401 },
    { kind: "Basic", status: 401 },
  ]);
}, 120_000);
