/** Transport mock, not production authentication. Never provision a credential here. */
export const testOnlyCredential = "TEST_ONLY_NOT_A_CREDENTIAL";

export function createOperatorChannelFixture() {
  let calls = 0;
  // Lexically private core callback; no RPC registration or exported admin function.
  const core = (requestID: string) => {
    calls++;
    return { requestID, transportOnly: true, administrativeEffect: false };
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const json = (body: unknown, status: number) =>
        Response.json(body, {
          status,
          headers: { "Cache-Control": "no-store" },
        });
      // Deliberately mock: equality to a public literal is NOT secure auth.
      if (request.headers.get("X-Operator-Test") !== testOnlyCredential)
        return json({ error: "unauthorized" }, 401);
      if (request.headers.has("Origin"))
        return json({ error: "origin_denied" }, 403);
      if (request.headers.get("Host") !== `127.0.0.1:${server.port}`)
        return json({ error: "host_denied" }, 403);
      const url = new URL(request.url);
      if (url.pathname !== "/operator/probe" || url.search)
        return json({ error: "not_found" }, 404);
      if (request.method !== "POST")
        return json({ error: "method_not_allowed" }, 405);
      if (request.headers.get("Content-Type") !== "application/json")
        return json({ error: "unsupported_media_type" }, 415);
      let text = "";
      let bytes = 0;
      const reader = request.body?.getReader();
      const decoder = new TextDecoder();
      if (reader) {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 1024) {
              await reader.cancel();
              return json({ error: "payload_too_large" }, 413);
            }
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          reader.releaseLock();
        }
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        return json({ error: "invalid_request" }, 400);
      const value = body as Record<string, unknown>;
      if (
        Object.keys(value).sort().join(",") !== "action,requestID" ||
        value.action !== "probe" ||
        typeof value.requestID !== "string" ||
        !/^[a-z0-9-]{1,64}$/.test(value.requestID)
      )
        return json({ error: "invalid_request" }, 400);
      return json(core(value.requestID), 200);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls: () => calls,
    stop: () => server.stop(true),
  };
}
