import { expect, test } from "bun:test";
import {
  createOperatorChannelFixture,
  testOnlyCredential,
} from "../../scripts/probes/fixtures/operator-channel";
import {
  probeOperatorChannel,
  probePluginOperatorChannel,
} from "../../scripts/probes/operator-channel";

test("synthetic operator transport binds headers and request before private callback; not product auth", async () => {
  const report = await probeOperatorChannel();
  expect(report.productSecurityProven).toBe(false);
  expect(report.hostPluginIntegrationProven).toBe(false);
  for (const item of report.results) {
    expect(item.status).toBe(item.expected);
    expect(item.allowOrigin).toBeNull();
  }
  expect(report.coreCalls).toBe(1);
  expect(
    report.results.find((item) => item.name === "bound-request")?.result,
  ).toEqual({
    requestID: "fixture",
    transportOnly: true,
    administrativeEffect: false,
  });
});

test("plugin setup owns private gateway callback and closes its listener across restart/stop", async () => {
  const report = await probePluginOperatorChannel();
  expect(report.productSecurityProven).toBe(false);
  expect(report.hostPluginIntegrationProven).toBe(true);
  expect(report.toolExecutionProvenByThisProbe).toBe(false);
  expect(report.beforeCount).toBe(0);
  expect(report.descriptorMode).toBe(0o600);
  expect(report.afterForgeryCount).toBe(0);
  for (const negative of report.rpcNegatives) expect(negative.status).toBe(400);
  expect(report.missingHeader).toBe(401);
  expect(report.afterMissingCount).toBe(0);
  expect(report.validHeader).toBe(200);
  expect(report.afterValidCount).toBe(1);
  expect(report.oldClosedAfterRestart).toBe(true);
  expect(report.newCount).toBe(0);
  expect(report.newValidHeader).toBe(200);
  expect(report.isolatedUnload).toBe(true);
  expect(report.infoAfterUnload).toBe(200);
  expect(report.sameProcess).toBe(true);
  expect(report.rpcAfterUnloadStatus).toBe(400);
  expect(report.oldClosedAfterStop).toBe(true);
  expect(report.newClosedAfterStop).toBe(true);
}, 120_000);

test("chunked body is capped before JSON parsing or callback", async () => {
  const fixture = createOperatorChannelFixture();
  try {
    const response = await fetch(`${fixture.url}/operator/probe`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
      headers: {
        "Content-Type": "application/json",
        "X-Operator-Test": testOnlyCredential,
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(700).fill(32));
          controller.enqueue(new Uint8Array(700).fill(32));
          controller.close();
        },
      }),
    });
    expect(response.status).toBe(413);
    await response.body?.cancel();
    expect(fixture.calls()).toBe(0);
  } finally {
    fixture.stop();
  }
});
