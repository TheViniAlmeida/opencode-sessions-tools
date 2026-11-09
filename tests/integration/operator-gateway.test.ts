import { expect, spyOn, test } from "bun:test";
import { request } from "node:http";
import { createConnection } from "node:net";
import { PUBLIC_BEARER } from "../fixtures/operator-core-worker";
import { gatewayFixture } from "../fixtures/operator-gateway";

test("real HTTP/core admission, replay and fresh challenge recover one SQL effect", async () => {
  const t = gatewayFixture(),
    g = t.start();
  try {
    t.f.confirm();
    const issue = async () => {
      const response = await fetch(`${g.url}/operator/challenge`, {
        method: "POST",
        headers: t.headers(),
        body: "{}",
      });
      expect(response.status).toBe(200);
      return (await response.json()).value;
    };
    const challenge = await issue();
    const admit = (c: unknown) =>
      fetch(`${g.url}/synthetic`, {
        method: "POST",
        headers: t.headers(undefined, {
          "x-operator-challenge": JSON.stringify(c),
        }),
        body: t.f.raw(),
      });
    const first = await admit(challenge);
    expect(first.status).toBe(200);
    const result = await first.json();
    expect((await admit(challenge)).status).toBe(403);
    t.advance(12000);
    const fresh = await issue();
    expect(await (await admit(fresh)).json()).toEqual(result);
    expect(t.f.count()).toBe(1);
    expect(JSON.stringify(result).includes(PUBLIC_BEARER)).toBe(false);
    expect(JSON.stringify(result).includes("authorization")).toBe(false);
  } finally {
    await g.stop();
    t.f.close();
  }
});

for (const kind of [
  "invalid",
  "revoked",
  "scope",
  "origin",
  "host",
  "type",
  "role",
  "path",
  "method",
])
  test(`HTTP rejects ${kind} without local admission or credential reflection`, async () => {
    const t = gatewayFixture(),
      g = t.start();
    try {
      if (kind === "revoked")
        t.f.db.exec("UPDATE operator_credentials SET revoked=1");
      if (kind === "scope")
        t.f.db.exec("UPDATE operator_credentials SET projects='[]'");
      const h: Record<string, string> = {};
      if (kind === "invalid")
        h.authorization = "Bearer PUBLIC_TEST_ONLY_invalid";
      if (kind === "origin") h.origin = "null";
      if (kind === "host") h.host = "localhost";
      if (kind === "type") h["content-type"] = "text/plain";
      const response = await fetch(
        `${g.url}/${kind === "path" ? "rpc" : "operator/challenge"}`,
        {
          method: kind === "method" ? "OPTIONS" : "POST",
          headers: t.headers(undefined, h),
          body: kind === "role" ? '{"role":"operator"}' : "{}",
        },
      );
      expect(response.status).toBe(403);
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
      const output = await response.text();
      expect(output).toBe('{"ok":false,"error":{"code":"forbidden"}}');
      expect(output.includes(PUBLIC_BEARER)).toBe(false);
      expect(t.f.count()).toBe(0);
    } finally {
      await g.stop();
      t.f.close();
    }
  });

// Pre-handler native 413 is intentionally not the application's generic 403.
// Both must be bounded and must never reflect credentials or invoke the core.
for (const framing of ["content-length", "chunked"] as const)
  test(`HTTP real oversized ${framing} is bounded before core; listener survives`, async () => {
    const t = gatewayFixture(),
      g = t.start();
    const issue = spyOn(t.f.core, "issue"),
      admit = spyOn(t.f.core, "admit");
    try {
      const output = await new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          const client = request(
            `${g.url}/operator/challenge`,
            {
              method: "POST",
              headers: {
                ...t.headers(),
                ...(framing === "content-length"
                  ? { "content-length": "65537" }
                  : { "transfer-encoding": "chunked" }),
              },
            },
            (response) => {
              let body = "";
              response.on("data", (chunk) => {
                body += chunk.toString("utf8");
                if (Buffer.byteLength(body) > 4096)
                  client.destroy(Error("oversized denial"));
              });
              response.on("error", reject);
              response.on("end", () =>
                resolve({ status: response.statusCode ?? 0, body }),
              );
            },
          );
          client.on("error", reject);
          client.setTimeout(3000, () =>
            client.destroy(Error("fixture request timeout")),
          );
          client.write(Buffer.alloc(32768, 120));
          client.end(Buffer.alloc(32769, 120));
        },
      );
      if (framing === "content-length") {
        // Proves Bun's configured cap, rather than merely our application check.
        expect(output.status).toBe(413);
        expect(g.stats().buckets).toBe(0);
      } else expect(output.status).toBe(413);
      expect(Buffer.byteLength(output.body)).toBeLessThanOrEqual(4096);
      expect(output.body).not.toContain(PUBLIC_BEARER);
      expect(output.body).not.toContain("authorization");
      expect(output.body).not.toContain("PUBLIC_TEST_ONLY");
      expect(issue).toHaveBeenCalledTimes(0);
      expect(admit).toHaveBeenCalledTimes(0);
      expect(t.f.count()).toBe(0);
      expect(g.stats().readers).toBe(0);
      expect(t.timers.size).toBe(0);
      const alive = await fetch(`${g.url}/operator/challenge`, {
        method: "POST",
        headers: t.headers(),
        body: "{}",
      });
      expect(alive.status).toBe(200);
      expect(issue).toHaveBeenCalledTimes(1);
      expect(admit).toHaveBeenCalledTimes(0);
    } finally {
      issue.mockRestore();
      admit.mockRestore();
      await g.stop();
      t.f.close();
    }
  });

test("HTTP challenge binds exact bytes and rejects payload authority before any effect", async () => {
  const t = gatewayFixture(),
    g = t.start();
  try {
    t.f.confirm();
    const issued = await fetch(`${g.url}/operator/challenge`, {
      method: "POST",
      headers: t.headers(),
      body: "{}",
    });
    const challenge = (await issued.json()).value;
    const headers = t.headers(undefined, {
      "x-operator-challenge": JSON.stringify(challenge),
    });
    const changed = await fetch(`${g.url}/synthetic`, {
      method: "POST",
      headers,
      body: `${t.f.raw()} `,
    });
    expect(changed.status).toBe(403);
    const original = await fetch(`${g.url}/synthetic`, {
      method: "POST",
      headers,
      body: t.f.raw(),
    });
    expect(original.status).toBe(200);
    expect(t.f.count()).toBe(1);
    t.advance(12000);
    const forged = JSON.stringify({
      ...JSON.parse(t.f.raw()),
      role: "operator",
    });
    const second = await fetch(`${g.url}/operator/challenge`, {
      method: "POST",
      headers: t.headers(forged),
      body: "{}",
    });
    const c = (await second.json()).value;
    const denied = await fetch(`${g.url}/synthetic`, {
      method: "POST",
      headers: t.headers(forged, { "x-operator-challenge": JSON.stringify(c) }),
      body: forged,
    });
    expect(denied.status).toBe(403);
    expect(t.f.count()).toBe(1);
  } finally {
    await g.stop();
    t.f.close();
  }
});

test("real HTTP accepts exactly 65536 bytes of valid padded challenge JSON", async () => {
  const t = gatewayFixture(),
    g = t.start();
  try {
    const body = `{}${" ".repeat(65534)}`;
    expect(Buffer.byteLength(body)).toBe(65536);
    const response = await fetch(`${g.url}/operator/challenge`, {
      method: "POST",
      headers: t.headers(),
      body,
    });
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    expect(g.stats().retainedPeak).toBe(65536);
    expect(t.f.count()).toBe(0);
  } finally {
    await g.stop();
    t.f.close();
  }
});

test("stop closes an actual HTTP keep-alive TCP socket within the bounded fixture deadline", async () => {
  const t = gatewayFixture(),
    g = t.start();
  const socket = createConnection({
    host: "127.0.0.1",
    port: Number(new URL(g.url).port),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const closed = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(Error("fixture stop deadline")), 3000);
      socket.once("error", reject);
      socket.once("close", () => resolve());
    });
    // Attach the rejection consumer before waiting for connection/stop.
    const completion = Promise.all([
      closed,
      new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.once("connect", () => {
          socket.write(
            `GET /operator/challenge HTTP/1.1\r\nHost: ${new URL(g.url).host}\r\nConnection: keep-alive\r\n\r\n`,
          );
        });
        socket.once("data", () => {
          expect(socket.readyState).toBe("open");
          g.stop().then(() => resolve(), reject);
        });
      }),
    ]);
    await completion;
    expect(socket.destroyed).toBe(true);
    expect(g.stats().readers).toBe(0);
    expect(t.timers.size).toBe(0);
  } finally {
    clearTimeout(timer);
    socket.destroy();
    await g.stop();
    t.f.close();
  }
});
