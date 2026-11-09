import { expect, test } from "bun:test";
import { OpenCode, type SessionMessageAssistant } from "@opencode/client";
import { createHarness } from "../../scripts/harness";
import { createDeterministicProvider } from "../../scripts/probes/fixtures/deterministic-provider";
import {
  createNativeMessaging,
  type NativeOutcomeBinding,
} from "../../src/adapters/opencode/messaging";
import type { NativePrompt } from "../../src/messaging/dispatcher";

test("native prompt receipts survive response loss without a second admission", async () => {
  const provider = createDeterministicProvider();
  const host = await createHarness({
    deliveryProvider: { baseURL: provider.baseURL },
  }).catch(async () => {
    await provider.close();
    throw new Error("Isolated host startup failed");
  });
  let posts = 0;
  let lose = false;
  const transport: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (
        url.origin !== "http://fixture.invalid" ||
        !["GET", "POST"].includes(request.method) ||
        !/^\/api\/(session(?:\/[^/]+(?:\/(?:prompt|inbox|message(?:\/[^/]+)?))?)?)$/.test(
          url.pathname,
        )
      )
        throw new Error("Fixture route denied");
      if (url.pathname.endsWith("/prompt")) posts++;
      const response = await host.request(`${url.pathname}${url.search}`, {
        method: request.method,
        ...(request.method === "GET"
          ? {}
          : {
              body: await request.text(),
              headers: { "content-type": "application/json" },
            }),
      });
      if (lose && url.pathname.endsWith("/prompt")) {
        lose = false;
        await response.body?.cancel();
        throw new Error("Synthetic lost response");
      }
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
    const session = await client.session.create({ location });
    const scope = { instanceID: "fixture", projectID: session.projectID };
    const prompt: NativePrompt = {
      operationID: "native-op",
      taskID: "native-task",
      messageID: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
      payloadHash: "synthetic-payload-hash",
      target: { version: 1, ...scope, sessionID: session.id },
      content: "Synthetic receipt probe",
      correlationID: "native-chain",
      hops: 1,
      policy: "queue",
    };
    let binding: NativeOutcomeBinding | null = null;
    const adapter = createNativeMessaging({
      session: client.session,
      catalog: {
        resolve: (value) =>
          value.instanceID === scope.instanceID &&
          value.projectID === scope.projectID
            ? { ...scope, location }
            : null,
      },
      bindings: { lookup: async () => binding },
    });
    expect(await adapter.prompts.inspect(prompt)).toEqual({
      state: "unknown_outcome",
    });
    lose = true;
    expect(await adapter.prompts.send(prompt)).toEqual({
      state: "unknown_outcome",
    });
    expect(await adapter.prompts.inspect(prompt)).toEqual({
      state: "accepted",
      messageID: prompt.messageID,
      payloadHash: prompt.payloadHash,
    });
    expect(posts).toBe(1);
    expect(
      await adapter.prompts.inspect({ ...prompt, payloadHash: "wrong" }),
    ).toEqual({ state: "unknown_outcome" });
    expect(
      await adapter.prompts.send({
        ...prompt,
        target: { ...prompt.target, projectID: "foreign" },
      }),
    ).toEqual({ state: "unknown_outcome" });
    expect(posts).toBe(1);
    expect(await adapter.outcomes.inspect(prompt.operationID)).toBeNull();
    // The isolated fixture owns this session and its sole execution. Production
    // cannot infer this binding from adjacent transcript messages.
    async function terminal(sessionID: string) {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const response = await host.request(
          `/api/session/${sessionID}/message`,
        );
        const body = (await response.json()) as {
          data: SessionMessageAssistant[];
        };
        const assistant = body.data.find(
          (item) =>
            item.type === "assistant" && item.time.completed !== undefined,
        );
        if (assistant) return assistant;
        await Bun.sleep(20);
      }
      throw new Error("No terminal native assistant in isolated fixture");
    }
    const assistant = await terminal(session.id);
    binding = {
      prompt,
      admissionID: "admission-native",
      taskGeneration: 1,
      assistantMessageID: assistant.id,
    };
    expect((await adapter.outcomes.inspect(prompt.operationID))?.state).toBe(
      "completed",
    );
    expect(await adapter.outcomes.inspect("wrong-operation")).toBeNull();
    binding = { ...binding, taskGeneration: 0 };
    expect(await adapter.outcomes.inspect(prompt.operationID)).toBeNull();
    binding = {
      ...binding,
      taskGeneration: 1,
      prompt: { ...prompt, content: "Unrelated input" },
    };
    expect(await adapter.outcomes.inspect(prompt.operationID)).toBeNull();
    binding = { ...binding, assistantMessageID: prompt.messageID };
    expect(await adapter.outcomes.inspect(prompt.operationID)).toBeNull();

    const busySession = await client.session.create({ location });
    const busy = {
      ...prompt,
      target: { ...prompt.target, sessionID: busySession.id },
      messageID: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
    };
    const barrier = provider.holdNext();
    try {
      expect((await adapter.prompts.send(busy)).state).toBe("accepted");
      await barrier.entered;
      const steer = {
        ...busy,
        operationID: "steer-operation",
        messageID: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
        policy: "steer" as const,
      };
      const queued = {
        ...busy,
        operationID: "queue-operation",
        messageID: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
      };
      expect((await adapter.prompts.send(queued)).state).toBe("accepted");
      expect((await adapter.prompts.send(steer)).state).toBe("accepted");
      expect((await adapter.prompts.inspect(queued)).state).toBe("accepted");
      expect((await adapter.prompts.inspect(steer)).state).toBe("accepted");
    } finally {
      barrier.release();
    }
    await terminal(busySession.id);
  } finally {
    try {
      await host.stop();
    } finally {
      await provider.close();
    }
  }
}, 30_000);

test("native terminal provider error is distinct from prompt admission", async () => {
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json(
        {
          error: {
            message: "Synthetic permanent provider failure",
            type: "invalid_request_error",
          },
        },
        { status: 400 },
      ),
  });
  const host = await createHarness({
    deliveryProvider: { baseURL: `http://127.0.0.1:${provider.port}/v1` },
  }).catch(async () => {
    await provider.stop(true);
    throw new Error("Isolated host startup failed");
  });
  const transport: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (
        url.origin !== "http://fixture.invalid" ||
        !["GET", "POST"].includes(request.method) ||
        !/^\/api\/session(?:\/[^/]+(?:\/(?:prompt|inbox|message(?:\/[^/]+)?))?)?$/.test(
          url.pathname,
        )
      )
        throw new Error("Fixture route denied");
      return host.request(`${url.pathname}${url.search}`, {
        method: request.method,
        ...(request.method === "GET"
          ? {}
          : {
              body: await request.text(),
              headers: { "content-type": "application/json" },
            }),
      });
    },
    { preconnect: fetch.preconnect },
  );
  const client = OpenCode.make({
    baseUrl: "http://fixture.invalid",
    fetch: transport,
  });
  try {
    const location = { directory: `${host.root}/project` };
    const session = await client.session.create({ location });
    const scope = { instanceID: "fixture", projectID: session.projectID };
    const prompt: NativePrompt = {
      operationID: "failed-operation",
      taskID: "failed-task",
      messageID: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
      payloadHash: "failure-hash",
      target: { version: 1, ...scope, sessionID: session.id },
      content: "Synthetic failure probe",
      correlationID: "failed-chain",
      hops: 1,
      policy: "queue",
    };
    let binding: NativeOutcomeBinding | null = null;
    const adapter = createNativeMessaging({
      session: client.session,
      catalog: { resolve: () => ({ ...scope, location }) },
      bindings: { lookup: async () => binding },
    });
    expect((await adapter.prompts.send(prompt)).state).toBe("accepted");
    expect(await adapter.outcomes.inspect(prompt.operationID)).toBeNull();
    const deadline = Date.now() + 15000;
    let assistant: SessionMessageAssistant | undefined;
    while (Date.now() < deadline && !assistant) {
      const response = await host.request(`/api/session/${session.id}/message`);
      const body = (await response.json()) as {
        data: SessionMessageAssistant[];
      };
      assistant = body.data.find(
        (message) =>
          message.type === "assistant" &&
          message.time.completed !== undefined &&
          Boolean(message.error),
      );
      if (!assistant) await Bun.sleep(25);
    }
    expect(assistant).toBeDefined();
    if (!assistant) throw new Error("Native terminal error not observed");
    binding = {
      prompt,
      admissionID: "failed-admission",
      taskGeneration: 2,
      assistantMessageID: assistant.id,
    };
    const outcome = await adapter.outcomes.inspect(prompt.operationID);
    expect(outcome?.state).toBe("failed");
    expect(outcome?.evidence.length).toBeGreaterThan(0);
    expect(outcome?.taskGeneration).toBe(2);
  } finally {
    try {
      await host.stop();
    } finally {
      await provider.stop(true);
    }
  }
}, 30_000);
