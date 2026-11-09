import { expect, test } from "bun:test";
import { createOperatorGateway } from "../../src/transport/operator-gateway";
import { localEffect } from "../fixtures/operator-core-worker";
import { gatewayFixture } from "../fixtures/operator-gateway";

test("configuration and maintenance index gate fail before listener; no implicit schema", () => {
  const t = gatewayFixture(false);
  try {
    expect(() => t.start()).toThrow("unavailable");
    expect(
      t.f.db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name LIKE 'operator_gateway_%'",
        )
        .get()?.n,
    ).toBe(0);
    for (const patch of [
      { hostname: "0.0.0.0" },
      { fixtureEphemeral: false },
      { port: -1 },
      { allowedPorts: [0] },
      { port: 65535, fixtureEphemeral: false, allowedPorts: [] },
    ])
      expect(() =>
        createOperatorGateway({ ...t.options, ...patch } as typeof t.options),
      ).toThrow();
  } finally {
    t.f.close();
  }
});

test("startup intentionally rejects a partial quota index with the expected name", () => {
  const t = gatewayFixture(false);
  try {
    t.f.db.exec(
      "CREATE INDEX operator_gateway_quota ON operator_challenges(expires_at,credential_id) WHERE consumed=0; CREATE INDEX operator_gateway_expiry ON operator_challenges(expires_at)",
    );
    expect(() => t.start()).toThrow("unavailable");
    expect(
      t.f.db
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE name='operator_gateway_quota'",
        )
        .get()?.sql,
    ).toContain("WHERE consumed=0");
  } finally {
    t.f.close();
  }
});

test("16 finite partial requests bound readers; abort and stop clear timers and readers", async () => {
  const t = gatewayFixture(),
    g = t.start();
  const controllers: AbortController[] = [];
  try {
    const requests = Array.from({ length: 16 }, (_, i) => {
      const abort = new AbortController();
      controllers.push(abort);
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([123]));
        },
      });
      return g.handle(
        new Request(`${g.url}/operator/challenge`, {
          method: "POST",
          body: stream,
          signal: abort.signal,
          headers: t.headers(undefined, {
            host: new URL(g.url).host,
            "x-operator-credential": `public-${i}`,
          }),
        }),
      );
    });
    expect(g.stats().readers).toBe(8);
    expect(t.timers.size).toBe(16);
    for (const c of controllers) c.abort();
    expect((await Promise.all(requests)).every((r) => r.status === 403)).toBe(
      true,
    );
    expect(g.stats().readers).toBe(0);
    expect(t.timers.size).toBe(0);
    await g.stop();
    expect((await g.handle(new Request(g.url))).status).toBe(403);
  } finally {
    await g.stop();
    t.f.close();
  }
});

test("stream limit and deterministic idle deadline release every reservation", async () => {
  const t = gatewayFixture(),
    g = t.start();
  try {
    const headers = t.headers(undefined, { host: new URL(g.url).host });
    const huge = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(65537));
        c.close();
      },
    });
    expect(
      (
        await g.handle(
          new Request(`${g.url}/synthetic`, {
            method: "POST",
            headers,
            body: huge,
          }),
        )
      ).status,
    ).toBe(403);
    expect(g.stats().retainedPeak).toBe(0);
    const pending = g.handle(
      new Request(`${g.url}/synthetic`, {
        method: "POST",
        headers,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array([123]));
          },
        }),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    t.advance(2000);
    expect((await pending).status).toBe(403);
    expect(t.timers.size).toBe(0);
    expect(g.stats().readers).toBe(0);
  } finally {
    await g.stop();
    t.f.close();
  }
});

test("credential burst four and global burst ten refill deterministically", async () => {
  const t = gatewayFixture(),
    g = t.start();
  try {
    const request = (id = "credential") =>
      g.handle(
        new Request(`${g.url}/operator/challenge`, {
          method: "POST",
          headers: t.headers(undefined, {
            host: new URL(g.url).host,
            "x-operator-credential": id,
          }),
          body: "{}",
        }),
      );
    for (let i = 0; i < 4; i++) expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(403);
    for (let i = 0; i < 5; i++) await request(`unknown-${i}`);
    const before = g.stats().buckets;
    await request("not-allocated");
    expect(g.stats().buckets).toBe(before);
    t.advance(61000);
    expect((await request()).status).toBe(200);
    expect(
      t.f.db
        .query<{ n: number }, []>("SELECT COUNT(*) n FROM operator_challenges")
        .get()?.n,
    ).toBe(1);
  } finally {
    await g.stop();
    t.f.close();
  }
});

test("exact 64 KiB accepted, header budget and unknown fields rejected", async () => {
  const t = gatewayFixture(),
    g = t.start();
  try {
    const send = (body: string, extra: Record<string, string> = {}) =>
      g.handle(
        new Request(`${g.url}/operator/challenge`, {
          method: "POST",
          headers: t.headers(undefined, {
            host: new URL(g.url).host,
            ...extra,
          }),
          body,
        }),
      );
    expect((await send(`{}${" ".repeat(65534)}`)).status).toBe(200);
    expect(g.stats().retainedPeak).toBe(65536);
    expect((await send("{}", { "x-padding": "x".repeat(8192) })).status).toBe(
      403,
    );
    expect((await send('{"role":"operator"}')).status).toBe(403);
    expect((await send("{}", { "x-forwarded-host": "127.0.0.1" })).status).toBe(
      403,
    );
    expect(t.f.count()).toBe(0);
  } finally {
    await g.stop();
    t.f.close();
  }
});

test("16 concurrent identical challenge submissions commit once; stop cancels partial body", async () => {
  const t = gatewayFixture(),
    g = t.start();
  try {
    t.f.confirm();
    const c = t.f.core.issue(t.f.attempt());
    const headers = t.headers(undefined, {
      host: new URL(g.url).host,
      "x-operator-challenge": JSON.stringify(c),
    });
    const replies = await Promise.all(
      Array.from({ length: 16 }, () =>
        g.handle(
          new Request(`${g.url}/synthetic`, {
            method: "POST",
            headers,
            body: t.f.raw(),
          }),
        ),
      ),
    );
    expect(replies.filter((r) => r.status === 200).length).toBe(1);
    expect(t.f.count()).toBe(1);
    t.advance(12000);
    const pending = g.handle(
      new Request(`${g.url}/synthetic`, {
        method: "POST",
        headers,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array([123]));
          },
        }),
      }),
    );
    await g.stop();
    expect((await pending).status).toBe(403);
    expect(t.timers.size).toBe(0);
    expect(g.stats().readers).toBe(0);
  } finally {
    await g.stop();
    t.f.close();
  }
});

test("cleanup deletes at most 32 expired tombstones and preserves live challenges and ledger", async () => {
  const t = gatewayFixture(),
    g = t.start();
  try {
    t.f.confirm();
    const admitted = t.f.core.admit(
      t.f.attempt(),
      t.f.core.issue(t.f.attempt()),
      t.f.raw(),
      localEffect,
    );
    expect(admitted.expired).toBe(false);
    expect(t.f.count()).toBe(1);
    // Canonical SQLite row bytes, not a count-only proxy for ledger retention.
    const ledgerBytes = () =>
      t.f.db
        .query(
          "SELECT hex(CAST(namespace AS BLOB)) namespace, hex(CAST(intent_hash AS BLOB)) intent_hash, hex(CAST(operation_id AS BLOB)) operation_id, hex(CAST(result_json AS BLOB)) result_json, created_at, expired FROM operator_ledger ORDER BY namespace",
        )
        .all();
    const effectBytes = () =>
      t.f.db
        .query(
          "SELECT hex(CAST(id AS BLOB)) id FROM synthetic_effects ORDER BY id",
        )
        .all();
    const beforeLedger = ledgerBytes(),
      beforeEffects = effectBytes();
    const insert = t.f.db.query(
      "INSERT INTO operator_challenges VALUES (?,?,?,?,?,1)",
    );
    for (let i = 0; i < 70; i++)
      insert.run(`expired-${i}`, "synthetic", "credential", 1, 69999);
    const live = t.f.core.issue(t.f.attempt());
    const response = await g.handle(
      new Request(`${g.url}/operator/challenge`, {
        method: "POST",
        headers: t.headers(undefined, { host: new URL(g.url).host }),
        body: "{}",
      }),
    );
    expect(response.status).toBe(200);
    expect(
      t.f.db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) n FROM operator_challenges WHERE consumed=1",
        )
        .get()?.n,
    ).toBe(39);
    expect(
      t.f.db
        .query("SELECT 1 FROM operator_challenges WHERE challenge_id=?")
        .get(live.challengeID),
    ).not.toBeNull();
    const plan = t.f.db
      .query<{ detail: string }, []>(
        "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM operator_challenges WHERE consumed=0 AND expires_at>100000",
      )
      .all();
    expect(
      plan.some((row) => row.detail.includes("operator_gateway_quota")),
    ).toBe(true);
    expect(ledgerBytes()).toEqual(beforeLedger);
    expect(effectBytes()).toEqual(beforeEffects);
  } finally {
    await g.stop();
    t.f.close();
  }
});

test("declared length 70000 is denied before retaining body bytes", async () => {
  const t = gatewayFixture(),
    g = t.start();
  try {
    const response = await g.handle(
      new Request(`${g.url}/operator/challenge`, {
        method: "POST",
        headers: t.headers(undefined, {
          host: new URL(g.url).host,
          "content-length": "70000",
        }),
        body: "{}",
      }),
    );
    expect(response.status).toBe(403);
    expect(g.stats().retainedPeak).toBe(0);
    expect(g.stats().readers).toBe(0);
    expect(t.timers.size).toBe(0);
  } finally {
    await g.stop();
    t.f.close();
  }
});

test("synchronous SQL admission has peak one; defensive four is not a concurrent throughput proof", async () => {
  const t = gatewayFixture();
  let peak = 0,
    calls = 0;
  const entry = t.options.operations[0];
  if (!entry) throw Error("fixture registry missing");
  entry.local = (...args: Parameters<typeof localEffect>) => {
    calls++;
    peak = Math.max(peak, g.stats().admissions);
    return localEffect(...args);
  };
  const g = t.start();
  try {
    t.f.confirm();
    const c = t.f.core.issue(t.f.attempt());
    await Promise.all(
      Array.from({ length: 16 }, () =>
        g.handle(
          new Request(`${g.url}/synthetic`, {
            method: "POST",
            headers: t.headers(undefined, {
              host: new URL(g.url).host,
              "x-operator-challenge": JSON.stringify(c),
            }),
            body: t.f.raw(),
          }),
        ),
      ),
    );
    expect(calls).toBe(1);
    expect(peak).toBe(1);
    expect(g.stats().admissions).toBe(0);
    expect(t.f.count()).toBe(1);
  } finally {
    await g.stop();
    t.f.close();
  }
});

test("total read deadline wins over continuously refreshed idle deadline", async () => {
  const t = gatewayFixture(),
    g = t.start();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  try {
    const pending = g.handle(
      new Request(`${g.url}/operator/challenge`, {
        method: "POST",
        headers: t.headers(undefined, { host: new URL(g.url).host }),
        body: new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
            c.enqueue(new Uint8Array([32]));
          },
        }),
      }),
    );
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 6; j++) await Promise.resolve();
      t.advance(1000);
      controller.enqueue(new Uint8Array([32]));
    }
    for (let j = 0; j < 6; j++) await Promise.resolve();
    t.advance(1000);
    expect((await pending).status).toBe(403);
    expect(t.timers.size).toBe(0);
    expect(g.stats().readers).toBe(0);
  } finally {
    await g.stop();
    t.f.close();
  }
});

test("random public credential IDs remain bounded under a finite sustained rate", async () => {
  const t = gatewayFixture(),
    g = t.start();
  try {
    for (let i = 0; i < 140; i++) {
      await g.handle(
        new Request(`${g.url}/operator/challenge`, {
          method: "POST",
          body: "{}",
          headers: t.headers(undefined, {
            host: new URL(g.url).host,
            "x-operator-credential": `unknown-${i}`,
          }),
        }),
      );
      expect(g.stats().buckets).toBeLessThanOrEqual(128);
      t.advance(1000);
    }
    expect(t.timers.size).toBe(0);
    expect(t.f.count()).toBe(0);
  } finally {
    await g.stop();
    t.f.close();
  }
});
