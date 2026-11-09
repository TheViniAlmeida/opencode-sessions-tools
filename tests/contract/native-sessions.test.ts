import { expect, test } from "bun:test";
import { OpenCode } from "@opencode/client";
import { createHarness } from "../../scripts/harness";
import { createDeterministicProvider } from "../../scripts/probes/fixtures/deterministic-provider";
import { createNativeSessions } from "../../src/adapters/opencode/sessions";
import type { SessionRef } from "../../src/contracts";
import type { CreationPlan } from "../../src/sessions/create";

test("native adapters use isolated 2.2.5 routes, preserve IDs and observe controls", async () => {
  const provider = createDeterministicProvider();
  const host = await createHarness({
    deliveryProvider: { baseURL: provider.baseURL },
  }).catch(async () => {
    await provider.close();
    throw new Error("Isolated host startup failed");
  });
  const calls: string[] = [];
  const transport: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const method = request.method;
      if (
        url.origin !== "http://fixture.invalid" ||
        !["GET", "POST", "PATCH"].includes(method) ||
        !/^\/api\/(session(?:\/[^/]+(?:\/(?:fork|agent|model|interrupt|compact))?)?|experimental\/session\/import|agent|model)$/.test(
          url.pathname,
        )
      )
        throw new Error("Fixture route denied");
      calls.push(`${method} ${url.pathname}`);
      const response = await host.request(`${url.pathname}${url.search}`, {
        method,
        ...(method === "GET"
          ? {}
          : {
              body: await request.text(),
              headers: { "content-type": "application/json" },
            }),
      });
      calls.push(`HTTP ${response.status}`);
      return response;
    },
    { preconnect: fetch.preconnect },
  );
  const client = OpenCode.make({
    baseUrl: "http://fixture.invalid",
    fetch: transport,
  });
  try {
    const location = { directory: `${host.root}/project` };
    const empty = await client.session.create({
      location,
      title: "synthetic native adapter source",
    });
    const id = `ses_${crypto.randomUUID().replaceAll("-", "")}`;
    const seed = await client.experimental.session.import({
      info: { ...empty, id },
      messages: [
        {
          id: `msg_${id.slice(4)}`,
          type: "synthetic",
          time: { created: 1 },
          text: "Synthetic fixture history",
        },
      ],
    });
    const scope = { instanceID: "fixture", projectID: seed.projectID };
    const source: SessionRef = { version: 1, ...scope, sessionID: seed.id };
    const adapter = createNativeSessions({
      session: client.session,
      fork: client.session,
      absence: { request: (method, path) => host.request(path, { method }) },
      catalog: {
        resolve: (requested) =>
          requested.instanceID === scope.instanceID &&
          requested.projectID === scope.projectID
            ? { ...scope, location }
            : null,
      },
      selections: {
        validate: async (_scope, command) =>
          (command.action === "agent" && command.agent === "build") ||
          (command.action === "model" &&
            command.providerID === "delivery-fixture" &&
            command.modelID === "deterministic"),
      },
    });
    const plan = (kind: CreationPlan["kind"]): CreationPlan => ({
      operationID: `native-${kind}-${crypto.randomUUID()}`,
      source,
      destination: scope,
      kind,
      planned:
        kind === "fork"
          ? null
          : {
              version: 1,
              ...scope,
              sessionID: `ses_${crypto.randomUUID().replaceAll("-", "")}`,
            },
      parent: kind === "child" ? source : null,
      capabilities: [],
      authorizationRevision: 0,
    });
    for (const kind of ["root", "child", "fork"] as const) {
      const intent = plan(kind);
      const receipt = await adapter.creation.execute(intent).catch(() => {
        throw new Error(JSON.stringify({ kind, calls }));
      });
      expect(receipt.state).toBe("created");
      if (receipt.state !== "created") throw new Error("Missing receipt");
      const metadata = await adapter.discovery.get(receipt.session);
      expect(metadata?.ref).toEqual(receipt.session);
      if (kind !== "fork") {
        if (!intent.planned) throw new Error("Planned ID missing");
        expect(receipt.session).toEqual(intent.planned);
        expect(
          await adapter.creation.inspect({
            ...intent,
            observed: receipt.session,
          }),
        ).toEqual(receipt.session);
      } else {
        expect(receipt.session.sessionID).not.toBe(source.sessionID);
        expect(
          await adapter.creation.inspect({ ...intent, observed: null }),
        ).toBeNull();
      }
      expect(metadata?.parent).toEqual(kind === "child" ? source : null);
    }
    expect(
      (await adapter.discovery.candidates(scope)).length,
    ).toBeGreaterThanOrEqual(4);
    expect(
      await adapter.control.execute(
        source,
        { action: "rename", title: "observed native rename" },
        "rename-op",
      ),
    ).toEqual({ action: "rename", title: "observed native rename" });
    expect(
      await adapter.control.execute(
        source,
        { action: "archive" },
        "archive-op",
      ),
    ).toEqual({ action: "archive", archived: true });
    expect(
      await adapter.control.execute(
        source,
        { action: "restore" },
        "restore-op",
      ),
    ).toEqual({ action: "restore", archived: false });
    expect(
      await adapter.control.execute(
        source,
        { action: "interrupt" },
        "interrupt-op",
      ),
    ).toEqual({ action: "interrupt", requested: true, interrupted: false });
    expect(
      await adapter.control.execute(
        source,
        { action: "agent", agent: "build" },
        "agent-op",
      ),
    ).toEqual({
      action: "agent",
      agent: "build",
      appliesTo: "future_executions",
    });
    expect(
      await adapter.control.execute(
        source,
        {
          action: "model",
          providerID: "delivery-fixture",
          modelID: "deterministic",
        },
        "model-op",
      ),
    ).toEqual({
      action: "model",
      providerID: "delivery-fixture",
      modelID: "deterministic",
      appliesTo: "future_executions",
    });
    expect(
      await adapter.control.execute(
        source,
        { action: "compact" },
        `msg_${crypto.randomUUID().replaceAll("-", "")}`,
      ),
    ).toEqual({ action: "compact", status: "admitted" });
    await client.session.update({
      sessionID: source.sessionID,
      metadata: { syntheticSourceOnly: true },
    });
    const reset = await adapter.control.execute(
      source,
      { action: "reset", transfer: ["agent", "model"] },
      "reset-op",
    );
    expect(reset.action).toBe("reset");
    if (reset.action !== "reset") throw new Error("Reset result absent");
    expect(reset.successor.sessionID).not.toBe(source.sessionID);
    const resetInfo = await client.session.get({
      sessionID: reset.successor.sessionID,
    });
    expect(resetInfo.agent).toBe("build");
    expect(resetInfo.model?.providerID).toBe("delivery-fixture");
    expect(resetInfo.model?.id).toBe("deterministic");
    expect(resetInfo.parentID).toBeUndefined();
    expect(resetInfo.fork).toBeUndefined();
    expect(resetInfo.metadata?.syntheticSourceOnly).toBeUndefined();
    const resetMessages = await host.request(
      `/api/session/${reset.successor.sessionID}/message`,
    );
    expect(resetMessages.status).toBe(200);
    expect((await resetMessages.json()).data).toEqual([]);
    expect(await adapter.discovery.get(source)).not.toBeNull();
    expect(
      await adapter.reconciliation.get({
        ...source,
        sessionID: "ses_missing_native_fixture",
      }),
    ).toBeNull();
    await expect(
      adapter.discovery.get({ ...source, projectID: "untrusted" }),
    ).rejects.toThrow("unavailable");
    await expect(
      adapter.control.validate(source, { action: "style", style: "fake" }),
    ).rejects.toThrow("unavailable");
    await expect(
      adapter.control.validate(source, {
        action: "model",
        providerID: "fake",
        modelID: "fake",
      }),
    ).rejects.toThrow("unavailable");
    const opts = {
      session: client.session,
      catalog: { resolve: () => ({ ...scope, location }) },
      selections: { validate: async () => false },
    };
    const noFork = createNativeSessions(opts);
    const beforeDenied = calls.length;
    expect(await noFork.creation.execute(plan("fork"))).toEqual({
      state: "pre_effect_unavailable",
    });
    expect(calls.length).toBe(beforeDenied);
    const lostPlan = plan("root");
    const lost = createNativeSessions({
      ...opts,
      session: {
        ...client.session,
        create: async (input) => {
          await client.session.create(input);
          throw new Error("synthetic transport response lost");
        },
      },
    });
    await expect(lost.creation.execute(lostPlan)).rejects.toThrow(
      "unavailable",
    );
    expect(
      await lost.creation.inspect({ ...lostPlan, observed: null }),
    ).toEqual(lostPlan.planned);
    const forged = { ...lostPlan, operationID: "different-operation" };
    expect(
      await lost.creation.inspect({ ...forged, observed: lostPlan.planned }),
    ).toBeNull();
    await expect(adapter.discovery.links(source)).rejects.toThrow(
      "unavailable",
    );
    const forkPlan = plan("fork");
    let forkWrites = 0;
    const lostFork = createNativeSessions({
      ...opts,
      fork: {
        fork: async (input) => {
          await client.session.fork(input);
          forkWrites++;
          throw new Error("synthetic lost fork response");
        },
      },
    });
    await expect(lostFork.creation.execute(forkPlan)).rejects.toThrow(
      "unavailable",
    );
    expect(
      await lostFork.creation.inspect({ ...forkPlan, observed: null }),
    ).toBeNull();
    expect(forkWrites).toBe(1);
    const initialCount = (await adapter.discovery.candidates(scope)).length;
    await Promise.all(
      Array.from({ length: 101 }, (_, index) =>
        client.session.create({
          location,
          title: `Synthetic pagination ${index}`,
        }),
      ),
    );
    expect((await adapter.discovery.candidates(scope)).length).toBe(
      initialCount + 101,
    );
    expect(calls.some((call) => call.includes("DELETE"))).toBe(false);
    expect(calls.some((call) => call.includes("/message"))).toBe(false);
  } finally {
    await host.stop();
    await provider.close();
  }
}, 120_000);

test("SDK GET only maps native session-not-found to absence; failures are sanitized", async () => {
  const ref: SessionRef = {
    version: 1,
    instanceID: "fixture",
    projectID: "project",
    sessionID: "ses_missing",
  };
  for (const status of [401, 403, 500]) {
    const transport: typeof fetch = Object.assign(
      async () =>
        Response.json(
          {
            _tag: "SessionNotFoundError",
            sessionID: ref.sessionID,
            message: "synthetic-sensitive-error",
          },
          { status },
        ),
      { preconnect: fetch.preconnect },
    );
    const client = OpenCode.make({
      baseUrl: "http://fixture.invalid",
      fetch: transport,
    });
    const adapter = createNativeSessions({
      session: client.session,
      absence: { request: async () => new Response(null, { status }) },
      catalog: {
        resolve: () => ({ ...ref, location: { directory: "/synthetic" } }),
      },
      selections: { validate: async () => false },
    });
    await expect(adapter.reconciliation.get(ref)).rejects.toThrow(
      "unavailable",
    );
  }
});
