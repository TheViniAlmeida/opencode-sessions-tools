import { stat } from "node:fs/promises";
import { createHarness } from "../harness";
import {
  createOperatorChannelFixture,
  testOnlyCredential,
} from "./fixtures/operator-channel";

export async function probePluginOperatorChannel() {
  const harness = await createHarness({ identityPlugin: true });
  const location = `?location[directory]=${encodeURIComponent(`${harness.root}/project`)}`;
  const rpc = async (method: string, input: unknown) => {
    const response = await harness.request(
      `/api/rpc/identity-candidate/${method}${location}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input }),
      },
    );
    return { status: response.status, result: await response.json() };
  };
  const initialize = async () => {
    const response = await harness.request(`/api/agent${location}`);
    if (!response.ok)
      throw new Error(`Location initialization: ${response.status}`);
    await response.body?.cancel();
    const diagnostic = await rpc("gateway", {});
    const output = diagnostic.result.output;
    const descriptor = await Bun.file(
      `${harness.root}/home/identity-channel.json`,
    ).json();
    if (
      diagnostic.status !== 200 ||
      !Number.isInteger(descriptor.port) ||
      descriptor.port < 1 ||
      descriptor.port > 65535 ||
      Object.keys(output).sort().join(",") !== "callbackCount,transportOnly"
    )
      throw new Error("Gateway diagnostic unavailable");
    return {
      url: `http://127.0.0.1:${descriptor.port}/operator/probe`,
      pid: descriptor.pid as number,
      descriptorMode:
        (await stat(`${harness.root}/home/identity-channel.json`)).mode & 0o777,
      count: output.callbackCount,
    };
  };
  const invoke = async (url: string, authenticated: boolean) => {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
      headers: {
        "Content-Type": "application/json",
        ...(authenticated ? { "X-Operator-Test": testOnlyCredential } : {}),
      },
      body: JSON.stringify({ action: "probe", requestID: "host-fixture" }),
    });
    await response.body?.cancel();
    return response.status;
  };
  const closed = async (url: string) => {
    try {
      await invoke(url, true);
      return false;
    } catch (error) {
      // Timeout is not proof of a closed socket: require connection refusal.
      return (error as { code?: string }).code === "ECONNREFUSED";
    }
  };
  try {
    const first = await initialize();
    const rpcNegatives = [];
    for (const method of [
      "admin",
      "probe",
      "execute",
      "tool",
      "port",
      "descriptor",
      "listener",
    ])
      rpcNegatives.push(
        await rpc(method, { principal: "operator", action: "probe" }),
      );
    rpcNegatives.push(
      await rpc("gateway", { principal: "operator", action: "probe" }),
    );
    await rpc("current", { sessionID: "synthetic", principal: "operator" });
    const afterForgeryCount = (await rpc("gateway", {})).result.output
      .callbackCount;
    const missingHeader = await invoke(first.url, false);
    const afterMissingCount = (await rpc("gateway", {})).result.output
      .callbackCount;
    const validHeader = await invoke(first.url, true);
    const afterValidCount = (await rpc("gateway", {})).result.output
      .callbackCount;
    await harness.restart();
    const oldClosedAfterRestart = await closed(first.url);
    const second = await initialize();
    const newValidHeader = await invoke(second.url, true);
    const processBefore = await Bun.file(`/proc/${second.pid}/stat`).text();
    const configPath = `${harness.root}/config/opencode/opencode.json`;
    const config = await Bun.file(configPath).json();
    config.plugins.push("-identity-private-fixture");
    await Bun.write(configPath, JSON.stringify(config));
    const deadline = Date.now() + 8_000;
    let isolatedUnload = false;
    do {
      const descriptor = await Bun.file(
        `${harness.root}/home/identity-channel.json`,
      ).json();
      if (descriptor.state === "unloaded" && (await closed(second.url))) {
        isolatedUnload = true;
        break;
      }
      await Bun.sleep(50);
    } while (Date.now() < deadline);
    const info = await harness.request("/api/info");
    const infoAfterUnload = info.status;
    await info.body?.cancel();
    const processAfter = await Bun.file(`/proc/${second.pid}/stat`).text();
    const startBefore = processBefore.split(") ")[1]?.split(" ")[19];
    const startAfter = processAfter.split(") ")[1]?.split(" ")[19];
    const sameProcess = Boolean(
      startBefore && startAfter && startBefore === startAfter,
    );
    const rpcAfterUnload = await rpc("gateway", {});
    await harness.stop();
    return {
      productSecurityProven: false,
      hostPluginIntegrationProven: true,
      beforeCount: first.count,
      descriptorMode: first.descriptorMode,
      rpcNegatives,
      afterForgeryCount,
      missingHeader,
      afterMissingCount,
      validHeader,
      afterValidCount,
      oldClosedAfterRestart,
      newCount: second.count,
      newValidHeader,
      isolatedUnload,
      infoAfterUnload,
      sameProcess,
      rpcAfterUnloadStatus: rpcAfterUnload.status,
      oldClosedAfterStop: await closed(first.url),
      newClosedAfterStop: await closed(second.url),
      toolExecutionProvenByThisProbe: false,
    };
  } finally {
    await harness.stop();
  }
}

export async function probeOperatorChannel() {
  const fixture = createOperatorChannelFixture();
  try {
    const cases = [
      { name: "missing", status: 401 },
      { name: "invalid", key: "invalid", status: 401 },
      {
        name: "payload-claim",
        body: {
          action: "probe",
          requestID: "fixture",
          principal: "operator",
          credential: testOnlyCredential,
        },
        status: 401,
      },
      { name: "preflight", method: "OPTIONS", origin: true, status: 401 },
      {
        name: "authenticated-preflight",
        method: "OPTIONS",
        key: testOnlyCredential,
        status: 405,
      },
      {
        name: "browser-origin",
        key: testOnlyCredential,
        origin: true,
        status: 403,
      },
      {
        name: "wrong-path",
        key: testOnlyCredential,
        path: "/api/rpc/admin/current",
        status: 404,
      },
      {
        name: "query-key",
        path: `/operator/probe?key=${testOnlyCredential}`,
        status: 401,
      },
      {
        name: "forged-session",
        key: testOnlyCredential,
        body: { action: "probe", requestID: "fixture", sessionID: "forged" },
        status: 400,
      },
      { name: "bound-request", key: testOnlyCredential, status: 200 },
      {
        name: "wrong-host",
        key: testOnlyCredential,
        host: "untrusted.invalid",
        status: 403,
      },
      {
        name: "oversize",
        key: testOnlyCredential,
        body: { action: "probe", requestID: "x".repeat(2048) },
        status: 413,
      },
    ];
    const results = [];
    for (const item of cases) {
      const response = await fetch(
        new URL(item.path ?? "/operator/probe", fixture.url),
        {
          method: item.method ?? "POST",
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
          headers: {
            "Content-Type": "application/json",
            ...(item.host ? { Host: item.host } : {}),
            ...(item.key ? { "X-Operator-Test": item.key } : {}),
            ...(item.origin ? { Origin: "https://untrusted.invalid" } : {}),
          },
          body: JSON.stringify(
            item.body ?? { action: "probe", requestID: "fixture" },
          ),
        },
      );
      results.push({
        name: item.name,
        expected: item.status,
        status: response.status,
        allowOrigin: response.headers.get("Access-Control-Allow-Origin"),
        result: await response.json(),
      });
    }
    return {
      transportOnly: true,
      productSecurityProven: false,
      hostPluginIntegrationProven: false,
      results,
      coreCalls: fixture.calls(),
    };
  } finally {
    fixture.stop();
  }
}

if (import.meta.main)
  console.log(
    JSON.stringify(
      {
        synthetic: await probeOperatorChannel(),
        plugin: await probePluginOperatorChannel(),
      },
      null,
      2,
    ),
  );
