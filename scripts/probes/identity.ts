import { createHarness } from "../harness";
import { createToolProvider } from "./fixtures/tool-provider";

export async function probeToolIdentity() {
  const provider = createToolProvider();
  const host = await createHarness({
    identityPlugin: true,
    deliveryProvider: { baseURL: provider.baseURL },
  }).catch((error) => {
    provider.close();
    throw error;
  });
  try {
    const post = async (path: string, body: unknown) => {
      const response = await host.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok)
        throw new Error(`Tool probe request: ${response.status}`);
      return (await response.json()).data;
    };
    const observations = (
      value: unknown,
    ): {
      sessionID: string;
      agent: string;
      callID: string;
      receivedKeys: string[];
    }[] => {
      if (typeof value === "string") {
        try {
          return observations(JSON.parse(value));
        } catch {
          return [];
        }
      }
      if (!value || typeof value !== "object") return [];
      if (
        "fixture" in value &&
        value.fixture === "identity-tool" &&
        "sessionID" in value &&
        typeof value.sessionID === "string" &&
        "agent" in value &&
        typeof value.agent === "string" &&
        "callID" in value &&
        typeof value.callID === "string" &&
        "receivedKeys" in value &&
        Array.isArray(value.receivedKeys) &&
        value.receivedKeys.every((key: unknown) => typeof key === "string")
      )
        return [
          {
            sessionID: value.sessionID,
            agent: value.agent,
            callID: value.callID,
            receivedKeys: value.receivedKeys,
          },
        ];
      return Object.values(value).flatMap(observations);
    };
    const sessions = [];
    const forgedSessions = [];
    const callIDs = (value: unknown): string[] => {
      if (!value || typeof value !== "object") return [];
      if (
        "type" in value &&
        value.type === "tool" &&
        "id" in value &&
        typeof value.id === "string"
      )
        return [value.id];
      return Object.values(value).flatMap(callIDs);
    };
    for (let index = 0; index < 4; index++) {
      if (index === 1) {
        await host.restart();
        provider.restart();
      }
      if (index >= 2) provider.forgeNext(index === 3);
      const created = await post("/api/session", {
        title: "tool-identity-synthetic",
        location: { directory: `${host.root}/project` },
      });
      await post(`/api/session/${created.id}/prompt`, {
        text: "synthetic identity diagnostic only",
        delivery: "queue",
      });
      let history: unknown = [];
      const deadline = Date.now() + 5_000;
      do {
        history = (
          await (
            await host.request(`/api/session/${created.id}/message`)
          ).json()
        ).data;
        if (
          observations(history).length ||
          (index >= 2 &&
            /Identity diagnostic input denied|additional properties|additionalProperties|Invalid.*input|validation/i.test(
              JSON.stringify(history),
            ))
        )
          break;
        await Bun.sleep(30);
      } while (Date.now() < deadline);
      if (index >= 2) {
        const observed = observations(history);
        const rejected =
          observed.length === 0 &&
          /Identity diagnostic input denied|additional properties|additionalProperties|Invalid.*input|validation/i.test(
            JSON.stringify(history),
          );
        forgedSessions.push({
          id: created.id as string,
          observations: observed,
          callIDs: callIDs(history),
          schema: index === 3 ? "strict" : "permissive",
          forgedOutcome: observed.length
            ? observed.some((item) =>
                item.receivedKeys.includes("caller_sessionID"),
              )
              ? "received-claims-ignored"
              : "normalized-identity-preserved"
            : rejected
              ? "rejected"
              : "unobserved",
        });
      } else
        sessions.push({
          id: created.id as string,
          observations: observations(history),
          callIDs: callIDs(history),
        });
    }
    return {
      sessions,
      forgedSession: forgedSessions[0],
      strictSession: forgedSessions[1],
      hostAndProviderRestarted: true,
      providerRequests: provider.requests,
      forgedIdentityObserved: forgedSessions.some((session) =>
        session.observations.some(
          (item) => item.sessionID === "synthetic-forged",
        ),
      ),
      toolExecuted: sessions.every(
        (session) => session.observations.length > 0,
      ),
    };
  } finally {
    await host.stop();
    provider.close();
  }
}

/** Candidate evidence only: no production authentication adapter. */
export async function probeIdentity() {
  const harness = await createHarness({ identityPlugin: true });
  try {
    const authentication = [];
    for (const authorization of [
      undefined,
      "Bearer identity-invalid",
      "Basic aW52YWxpZDppbnZhbGlk",
    ]) {
      const response = await fetch(new URL("/api/info", harness.url), {
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
        headers: authorization ? { Authorization: authorization } : {},
      });
      authentication.push({
        kind: authorization?.split(" ")[0] ?? "absent",
        status: response.status,
      });
      await response.body?.cancel();
    }
    const origins = [];
    for (const origin of [
      undefined,
      "http://localhost:4096",
      "https://untrusted.invalid",
    ]) {
      const response = await harness.request("/api/info", {
        headers: origin ? { Origin: origin } : {},
      });
      origins.push({
        origin: origin ?? "absent",
        status: response.status,
        allowOrigin: response.headers.get("access-control-allow-origin"),
      });
      await response.body?.cancel();
    }
    const created = await harness.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "identity-private-fixture",
        permissions: [
          { action: "identity-probe", resource: "*", effect: "deny" },
        ],
      }),
    });
    if (!created.ok)
      throw new Error(`Synthetic session creation: ${created.status}`);
    const session = await created.json();
    const sessionID = session.id ?? session.data?.id;
    if (typeof sessionID !== "string")
      throw new Error("Session ID not observed");
    const policy = await harness.request(
      `/api/session/${sessionID}/permission`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "identity-probe",
          resources: ["fixture"],
          save: [],
          metadata: {},
          source: {
            type: "tool",
            messageID: "identity-fixture",
            id: "identity-fixture",
          },
        }),
      },
    );
    const policyStatus = policy.status;
    const policyResult = await policy.json();
    const rpcPath = `/api/rpc/identity-candidate/current?location[directory]=${encodeURIComponent(`${harness.root}/project`)}`;
    // Force location registry initialization without a provider/model request.
    const agents = await harness.request(
      `/api/agent?location[directory]=${encodeURIComponent(`${harness.root}/project`)}`,
    );
    if (!agents.ok)
      throw new Error(`Location initialization: ${agents.status}`);
    await agents.body?.cancel();
    const rpc = await harness.request(rpcPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: { sessionID, principal: "operator" } }),
    });
    const rpcStatus = rpc.status;
    const rpcResult = await rpc.json();
    const rpcClaims = [];
    for (const input of [
      {},
      { sessionID, principal: "agent" },
      { sessionID: "synthetic-forged-session", principal: "operator" },
    ]) {
      const response = await harness.request(rpcPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input }),
      });
      rpcClaims.push({
        claim: "principal" in input ? input.principal : "absent",
        status: response.status,
        result: await response.json(),
      });
    }
    const rpcAuthentication = [];
    for (const authorization of [undefined, "Bearer identity-invalid"]) {
      const response = await fetch(new URL(rpcPath, harness.url), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
        headers: {
          "Content-Type": "application/json",
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: JSON.stringify({ input: { sessionID, principal: "operator" } }),
      });
      rpcAuthentication.push({
        kind: authorization ? "Bearer" : "absent",
        status: response.status,
      });
      await response.body?.cancel();
    }
    const plugins = await harness.request(
      `/api/plugin?location[directory]=${encodeURIComponent(`${harness.root}/project`)}`,
    );
    const pluginResult = await plugins.json();
    return {
      candidateOnly: true,
      version: harness.version,
      authentication,
      rpcAuthentication,
      rpcClaims,
      origins,
      policy: { status: policyStatus, result: policyResult },
      registeredRPC: {
        status: rpcStatus,
        result: rpcResult,
        provesPrincipal: false,
      },
      pluginActivation: {
        status: plugins.status,
        fixtureState: Array.isArray(pluginResult.data)
          ? (pluginResult.data.find(
              (plugin: { id?: string }) =>
                plugin.id === "identity-private-fixture",
            )?.state?.status ?? null)
          : null,
        registeredCount: Array.isArray(pluginResult.data)
          ? pluginResult.data.length
          : null,
        fixturePresent:
          Array.isArray(pluginResult.data) &&
          pluginResult.data.some(
            (plugin: { id?: string }) =>
              plugin.id === "identity-private-fixture",
          ),
        nonBuiltinCount: Array.isArray(pluginResult.data)
          ? pluginResult.data.filter(
              (plugin: { source?: { type?: string } }) =>
                plugin.source?.type !== "builtin",
            ).length
          : null,
        blocker: null,
      },
      external: { enabled: false, reason: "No verified operator principal" },
      integration: {
        toolIdentity: "NOT_VALIDATED",
        rpcIdentity:
          "OBSERVED: error/signal only; operator principal unavailable in this handler",
        humanCommandIdentity: "NOT_VALIDATED",
        invalidOrAbsentBearer:
          "SERVER_PROVEN: raw fixed-URL requests; not product authorization",
        alwaysAndSelfConfiguration: "NOT_VALIDATED: no agent execution",
      },
    };
  } finally {
    await harness.stop();
  }
}

if (import.meta.main)
  console.log(JSON.stringify(await probeIdentity(), null, 2));
