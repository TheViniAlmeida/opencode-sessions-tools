import { describe, expect, test } from "bun:test";
import {
  createDeterministicProvider,
  deliveryProviderConfig,
} from "../../scripts/probes/fixtures/deterministic-provider";

const body = (stream = true) =>
  JSON.stringify({
    model: "deterministic",
    messages: [{ role: "user", content: "synthetic" }],
    stream,
  });
const send = (baseURL: string, stream = true) =>
  fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body(stream),
    signal: AbortSignal.timeout(4500),
  });

describe("deterministic provider protocol fixture (not host proof)", () => {
  test("loopback only and exact provider config without credentials", () => {
    for (const url of [
      "https://127.0.0.1:1/v1",
      "http://localhost:1/v1",
      "http://example.com:1/v1",
      "http://127.0.0.1:1/v1?x=1",
    ])
      expect(() => deliveryProviderConfig(url)).toThrow();
    const config = deliveryProviderConfig("http://127.0.0.1:1234/v1");
    expect(config.model).toBe("delivery-fixture/deterministic");
    expect(config.providers["delivery-fixture"].package).toBe(
      "@opencode/ai/providers/openai-compatible",
    );
    expect(JSON.stringify(config)).not.toContain("apiKey");
  });
  test("real HTTP SSE framing, controlled barrier and JSON completion", async () => {
    const fixture = createDeterministicProvider();
    try {
      const barrier = fixture.holdNext();
      let settled = false;
      const response = send(fixture.baseURL).then((value) => {
        settled = true;
        return value;
      });
      await Promise.race([
        barrier.entered,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Barrier not entered")), 4500),
        ),
      ]);
      expect(settled).toBe(false);
      expect(fixture.requests).toEqual([
        { sequence: 1, stream: true, model: "deterministic" },
      ]);
      barrier.release();
      const result = await response;
      expect(result.headers.get("content-type")).toBe("text/event-stream");
      const frames = (await result.text())
        .trim()
        .split("\n\n")
        .map((frame) => frame.slice(6));
      expect(frames.pop()).toBe("[DONE]");
      const events = frames.map((frame) => JSON.parse(frame));
      expect(events[0].choices[0].delta.role).toBe("assistant");
      expect(events[1].choices[0].delta.content).toBe("fixture-response-1");
      expect(events[2].choices[0].finish_reason).toBe("stop");
      expect(events[3].usage.total_tokens).toBe(2);
      const json = await (await send(fixture.baseURL, false)).json();
      expect(json.object).toBe("chat.completion");
      expect(json.choices[0].message.content).toBe("fixture-response-2");
    } finally {
      await fixture.close();
    }
  });
  test("strict routing, malformed input and bounded barrier deadline", async () => {
    const fixture = createDeterministicProvider({ deadlineMs: 25 });
    try {
      expect((await fetch(`${fixture.baseURL}/responses`)).status).toBe(404);
      expect((await fetch(`${fixture.baseURL}/chat/completions`)).status).toBe(
        405,
      );
      expect(
        (
          await fetch(`${fixture.baseURL}/chat/completions`, {
            method: "POST",
            body: "{",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await fetch(`${fixture.baseURL}/chat/completions`, {
            method: "POST",
            body: "{}",
          })
        ).status,
      ).toBe(400);
      fixture.holdNext();
      const response = await send(fixture.baseURL);
      expect(response.status).toBe(503);
      expect((await response.json()).error.message).toBe("Fixture timeout");
    } finally {
      await fixture.close();
    }
  });
  test("cleanup terminates held request and closes listener", async () => {
    const fixture = createDeterministicProvider();
    const barrier = fixture.holdNext();
    const pending = send(fixture.baseURL).catch(() => null);
    try {
      await barrier.entered;
    } finally {
      await fixture.close();
    }
    await pending;
    expect(() => fixture.holdNext()).toThrow();
    await expect(send(fixture.baseURL)).rejects.toThrow();
  }, 5000);
});
