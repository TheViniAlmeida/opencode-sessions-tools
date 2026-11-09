import { createHash } from "node:crypto";
import {
  type Attempt,
  type Challenge,
  type OperatorCore,
  parseOperatorJSON,
} from "../authorization/operator-core";
import type { Persistence } from "../persistence/database";

type LocalAdmission = Parameters<OperatorCore["admit"]>[3];
export interface GatewayClock {
  now(): number;
  after(ms: number, callback: () => void): () => void;
}
export interface OperatorGatewayOptions {
  hostname: "127.0.0.1";
  port: number;
  allowedPorts: readonly number[];
  fixtureEphemeral?: boolean;
  core: OperatorCore;
  persistence: Persistence;
  /** Trusted SQL-only handlers; not supplied through requests or RPC. */
  operations: readonly {
    operation: string;
    route: string;
    local: LocalAdmission;
  }[];
  clock?: GatewayClock;
}
const defaultClock: GatewayClock = {
  now: Date.now,
  after(ms, callback) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};
const failure = () =>
  Response.json(
    { ok: false, error: { code: "forbidden" } },
    {
      status: 403,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
const success = (value: unknown) =>
  Response.json(
    { ok: true, value },
    {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    throw Error();
  return value as Record<string, unknown>;
}
function text(v: unknown, max = 256): string {
  if (typeof v !== "string" || !v.length || v.length > max) throw Error();
  return v;
}

/** Explicit setup only. The caller must await stop on unload and setup failure. */
export function createOperatorGateway(options: OperatorGatewayOptions) {
  if (
    options?.hostname !== "127.0.0.1" ||
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65535 ||
    !Array.isArray(options.allowedPorts) ||
    options.allowedPorts.some(
      (p) => !Number.isInteger(p) || p < 1 || p > 65535,
    ) ||
    (options.port === 0
      ? options.fixtureEphemeral !== true || options.allowedPorts.length !== 0
      : options.fixtureEphemeral === true ||
        !options.allowedPorts.includes(options.port))
  )
    throw Error("invalid gateway configuration");
  const registry = new Map(
    options.operations.map((entry) => {
      if (
        !/^[a-zA-Z0-9._-]{1,128}$/.test(entry.operation) ||
        !/^\/[a-zA-Z0-9/_-]+$/.test(entry.route) ||
        entry.route === "/operator/challenge" ||
        typeof entry.local !== "function" ||
        entry.local.constructor.name === "AsyncFunction"
      )
        throw Error("invalid gateway configuration");
      return [entry.operation, { ...entry }] as const;
    }),
  );
  if (!registry.size || registry.size !== options.operations.length)
    throw Error("invalid gateway configuration");
  // Persistence owns migrations. Refuse to open a listener without maintenance indexes.
  options.persistence.transaction((sql) => {
    for (const [name, columns] of [
      ["operator_gateway_quota", "consumed,expires_at,credential_id"],
      ["operator_gateway_expiry", "expires_at"],
    ] as const) {
      const index = sql
        .query<{ sql: string }, [string]>(
          "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='operator_challenges' AND name=?",
        )
        .get(name);
      if (
        index?.sql !== `CREATE INDEX ${name} ON operator_challenges(${columns})`
      )
        throw Error("gateway maintenance schema required");
    }
  });
  const clock = options.clock ?? defaultClock;
  let stopped = false,
    readers = 0,
    admissions = 0,
    retainedPeak = 0;
  const global = { tokens: 10, at: clock.now() };
  const buckets = new Map<string, { tokens: number; at: number }>();
  const pending = new Set<() => void>();
  let timerCount = 0;
  function after(ms: number, callback: () => void) {
    let active = true;
    timerCount++;
    const clear = clock.after(ms, () => {
      if (!active) return;
      active = false;
      timerCount--;
      callback();
    });
    return () => {
      if (!active) return;
      active = false;
      timerCount--;
      clear();
    };
  }
  let authority = "";
  function take(
    bucket: { tokens: number; at: number },
    cap: number,
    perMinute: number,
  ) {
    const now = clock.now();
    if (!Number.isSafeInteger(now) || now < bucket.at) throw Error();
    bucket.tokens = Math.min(
      cap,
      bucket.tokens + ((now - bucket.at) * perMinute) / 60000,
    );
    bucket.at = now;
    if (bucket.tokens < 1) throw Error();
    bucket.tokens--;
  }
  async function body(
    request: Request,
  ): Promise<{ raw: string; hash: string }> {
    if (!request.body) throw Error();
    const reader = request.body.getReader();
    let reject!: () => void;
    const failed = new Promise<never>((_, no) => {
      reject = () => no(Error());
    });
    const cancel = () => {
      reject();
      void reader.cancel().catch(() => {});
    };
    pending.add(cancel);
    request.signal.addEventListener("abort", cancel, { once: true });
    const deadline = after(5000, cancel);
    let idle = after(2000, cancel);
    const all = new Uint8Array(65536);
    let bytes = 0;
    const hash = createHash("sha256");
    try {
      if (request.signal.aborted) throw Error();
      while (true) {
        const next = await Promise.race([reader.read(), failed]);
        if (stopped || request.signal.aborted) throw Error();
        if (next.done) break;
        if (next.value.length > 65536 - bytes) throw Error();
        all.set(next.value, bytes);
        bytes += next.value.length;
        retainedPeak = Math.max(retainedPeak, bytes);
        hash.update(next.value);
        idle();
        idle = after(2000, cancel);
      }
      return {
        raw: new TextDecoder("utf-8", { fatal: true }).decode(
          all.subarray(0, bytes),
        ),
        hash: hash.digest("hex"),
      };
    } finally {
      deadline();
      idle();
      pending.delete(cancel);
      request.signal.removeEventListener("abort", cancel);
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  async function handle(request: Request): Promise<Response> {
    let reading = false;
    try {
      if (stopped) throw Error();
      take(global, 10, 60);
      let headerBytes = 0;
      for (const [key, value] of request.headers)
        headerBytes += Buffer.byteLength(key) + Buffer.byteLength(value) + 4;
      if (
        headerBytes > 8192 ||
        request.headers.get("host") !== authority ||
        request.headers.has("origin") ||
        request.headers.has("forwarded") ||
        [...request.headers.keys()].some((k) => k.startsWith("x-forwarded-")) ||
        request.method !== "POST" ||
        request.headers.get("content-type") !== "application/json" ||
        request.headers.has("content-encoding")
      )
        throw Error();
      const url = new URL(request.url);
      if (
        url.search ||
        url.hash ||
        url.host !== authority ||
        (url.pathname !== "/operator/challenge" &&
          ![...registry.values()].some((e) => e.route === url.pathname))
      )
        throw Error();
      const credentialID = text(request.headers.get("x-operator-credential"));
      const auth = request.headers.get("authorization");
      if (!auth || !/^Bearer [\x21-\x7e]{1,256}$/.test(auth)) throw Error();
      let bucket = buckets.get(credentialID);
      if (!bucket) {
        for (const [id, old] of buckets)
          if (clock.now() - old.at >= 12000) buckets.delete(id);
        if (buckets.size >= 128) throw Error();
        bucket = { tokens: 4, at: clock.now() };
        buckets.set(credentialID, bucket);
      }
      take(bucket, 4, 20);
      if (readers >= 8) throw Error();
      readers++;
      reading = true;
      const declared = request.headers.get("content-length");
      if (
        declared !== null &&
        (!/^\d+$/.test(declared) || Number(declared) > 65536)
      )
        throw Error();
      const content = await body(request);
      if (stopped || request.signal.aborted) throw Error();
      const bindings = object(
        parseOperatorJSON(
          text(request.headers.get("x-operator-attempt"), 2048),
        ),
        [
          "projectID",
          "method",
          "route",
          "operation",
          "audience",
          "timestamp",
          "requestBodyHash",
        ],
      );
      const audience = object(bindings.audience, ["instanceID", "epoch"]);
      const attempt: Attempt = {
        credentialID,
        bearer: auth.slice(7),
        projectID: text(bindings.projectID),
        method: text(bindings.method),
        route: text(bindings.route),
        operation: text(bindings.operation),
        audience: {
          instanceID: text(audience.instanceID),
          epoch: text(audience.epoch),
        },
        timestamp: bindings.timestamp as number,
        requestBodyHash: text(bindings.requestBodyHash),
      };
      const entry = registry.get(attempt.operation);
      if (!entry || attempt.method !== "POST" || attempt.route !== entry.route)
        throw Error();
      options.persistence.transaction((sql) => {
        sql
          .query(
            "DELETE FROM operator_challenges WHERE challenge_id IN (SELECT challenge_id FROM operator_challenges INDEXED BY operator_gateway_expiry WHERE expires_at<=? ORDER BY expires_at LIMIT 32)",
          )
          .run(clock.now() - 30000);
      });
      if (url.pathname === "/operator/challenge") {
        object(parseOperatorJSON(content.raw), []);
        return success(options.core.issue(attempt));
      }
      if (
        url.pathname !== entry.route ||
        content.hash !== attempt.requestBodyHash ||
        admissions >= 4
      )
        throw Error();
      const value = object(
        parseOperatorJSON(
          text(request.headers.get("x-operator-challenge"), 2048),
        ),
        ["challengeID", "nonce", "issuedAt", "expiresAt"],
      );
      const challenge: Challenge = {
        challengeID: text(value.challengeID),
        nonce: text(value.nonce),
        issuedAt: value.issuedAt as number,
        expiresAt: value.expiresAt as number,
      };
      // Defense in depth only: this synchronous SQL section has no await, so
      // independent requests cannot overlap here in this single-threaded adapter.
      admissions++;
      try {
        return success(
          options.core.admit(attempt, challenge, content.raw, entry.local),
        );
      } finally {
        admissions--;
      }
    } catch {
      if (request.body && !request.body.locked)
        void request.body.cancel().catch(() => {});
      return failure();
    } finally {
      if (reading) readers--;
    }
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    development: false,
    idleTimeout: 2,
    // Defense in depth: native rejection may return Bun's own non-domain 413
    // before fetch/error. Never relax this cap to normalize response formatting.
    maxRequestBodySize: 65536,
    fetch: handle,
    error: failure,
  });
  authority = `127.0.0.1:${server.port}`;
  return {
    url: `http://${authority}`,
    handle,
    stats: () => ({
      readers,
      admissions,
      buckets: buckets.size,
      timers: timerCount,
      retainedPeak,
    }),
    async stop() {
      stopped = true;
      for (const cancel of pending) cancel();
      buckets.clear();
      await server.stop(true);
    },
  };
}
