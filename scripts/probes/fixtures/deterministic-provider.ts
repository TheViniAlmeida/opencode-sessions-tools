/** Local protocol fixture, not a language model or host-delivery proof.
 * @opencode/ai/dist/protocols/openai-compatible-chat.js reuses openai-chat:
 * POST /chat/completions, stream:true, SSE JSON deltas and [DONE].
 */
export const fixtureModel = "deterministic";

export function deliveryProviderConfig(baseURL: string) {
  const url = new URL(baseURL);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/v1" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Fixture requires http://127.0.0.1:<port>/v1");
  return {
    model: `delivery-fixture/${fixtureModel}`,
    providers: {
      "delivery-fixture": {
        name: "Local deterministic delivery fixture",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL, encoding: "none", timeout: 4500 },
        models: {
          [fixtureModel]: {
            capabilities: { tools: false, input: ["text"], output: ["text"] },
            limit: { context: 32768, output: 1024 },
          },
        },
      },
    },
  };
}

export function createDeterministicProvider(
  options: { deadlineMs?: number } = {},
) {
  const deadlineMs = options.deadlineMs ?? 4000;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 4500)
    throw new Error("Fixture deadline must be 1..4500ms");
  let closed = false;
  let fail = false;
  let sequence = 0;
  let armed:
    | { received: () => void; wait: Promise<void>; release: () => void }
    | undefined;
  const active = new Set<() => void>();
  // Store only synthetic sequencing metadata, never headers or prompt contents.
  const requests: { sequence: number; stream: boolean; model: string }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (closed) return new Response(null, { status: 503 });
      const url = new URL(request.url);
      if (url.pathname !== "/v1/chat/completions")
        return Response.json(
          { error: { message: "Unknown fixture endpoint" } },
          { status: 404 },
        );
      if (request.method !== "POST")
        return new Response(null, { status: 405, headers: { Allow: "POST" } });
      let body: Record<string, unknown>;
      try {
        body = await request.json();
      } catch {
        return Response.json(
          { error: { message: "Invalid JSON" } },
          { status: 400 },
        );
      }
      if (
        !body ||
        body.model !== fixtureModel ||
        !Array.isArray(body.messages) ||
        !body.messages.length ||
        !body.messages.every(
          (message: unknown) =>
            typeof message === "object" &&
            message !== null &&
            "role" in message,
        ) ||
        (body.stream !== undefined && typeof body.stream !== "boolean")
      )
        return Response.json(
          { error: { message: "Invalid fixture chat request" } },
          { status: 400 },
        );
      const number = ++sequence;
      requests.push({
        sequence: number,
        stream: body.stream === true,
        model: fixtureModel,
      });
      if (fail) {
        fail = false;
        return Response.json(
          {
            error: {
              message: "Injected deterministic failure",
              type: "invalid_request_error",
              code: "fixture_failure",
            },
          },
          { status: 400 },
        );
      }
      const barrier = armed;
      armed = undefined;
      barrier?.received();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      let outcome = "released";
      const interrupted = new Promise<void>((resolve) => {
        abort = () => {
          outcome = "closed";
          resolve();
        };
        active.add(abort);
        timer = setTimeout(() => {
          outcome = "timeout";
          resolve();
        }, deadlineMs);
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted) abort();
      });
      try {
        await Promise.race([barrier?.wait ?? Promise.resolve(), interrupted]);
      } finally {
        clearTimeout(timer);
        if (abort) {
          active.delete(abort);
          request.signal.removeEventListener("abort", abort);
        }
      }
      if (outcome !== "released")
        return Response.json(
          { error: { message: `Fixture ${outcome}`, type: "fixture_error" } },
          { status: 503 },
        );
      const id = `chatcmpl-fixture-${number}`;
      const text = `fixture-response-${number}`;
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      if (body.stream !== true)
        return Response.json({
          id,
          object: "chat.completion",
          created: 0,
          model: fixtureModel,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: text },
              finish_reason: "stop",
            },
          ],
          usage,
        });
      const encoder = new TextEncoder();
      const chunk = (delta: object, finish_reason: string | null = null) => ({
        id,
        object: "chat.completion.chunk",
        created: 0,
        model: fixtureModel,
        choices: [{ index: 0, delta, finish_reason }],
      });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of [
            chunk({ role: "assistant", content: "" }),
            chunk({ content: text }),
            chunk({}, "stop"),
            {
              id,
              object: "chat.completion.chunk",
              created: 0,
              model: fixtureModel,
              choices: [],
              usage,
            },
          ])
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
            );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    },
  });
  const baseURL = `http://127.0.0.1:${server.port}/v1`;
  return {
    baseURL,
    config: deliveryProviderConfig(baseURL),
    requests,
    failNext() {
      fail = true;
    },
    holdNext() {
      if (closed || armed)
        throw new Error("Fixture closed or barrier already armed");
      let received!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        received = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      armed = { received, wait, release };
      return { entered, release };
    },
    async close() {
      closed = true;
      armed?.release();
      armed = undefined;
      for (const abort of active) abort();
      await server.stop(true);
    },
  };
}
