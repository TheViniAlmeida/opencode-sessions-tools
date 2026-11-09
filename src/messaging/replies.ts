import type { Database } from "bun:sqlite";
import type {
  Authorizer,
  TrustedPrincipalPort,
} from "../authorization/authorize";
import {
  canonical,
  DomainError,
  type Principal,
  parseMessageContent,
  parseSessionRef,
  type SessionRef,
} from "../contracts";
import type { Migration, Persistence } from "../persistence/database";
import {
  canonicalPayloadHash,
  type RemovedTargetPort,
} from "../persistence/operations";
import type { RemovedSessionCleanupPort } from "../sessions/reconcile";

export const repliesMigration = {
  name: "request-replies-v1",
  sql: `CREATE TABLE request_replies (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    reply_id TEXT NOT NULL UNIQUE, request_id TEXT NOT NULL REFERENCES prompt_dispatches(operation_id),
    author_json TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
    body_json TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(request_id,author_json,idempotency_key)
  );
  CREATE INDEX request_replies_request ON request_replies(request_id,sequence);
  CREATE TABLE reply_cursors (
    token TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES prompt_dispatches(operation_id),
    owner_json TEXT NOT NULL, sequence INTEGER NOT NULL
  );`,
} as const;
export function repliesMigrationAt(version: number): Migration {
  if (!Number.isSafeInteger(version) || version < 2)
    throw new DomainError("invalid_input");
  return { version, apply: (db) => db.exec(repliesMigration.sql) };
}

export type ReplyBody =
  | { type: "notification"; content: string }
  | {
      type: "task_outcome";
      content: string;
      outcome: "completed" | "failed" | "cancelled";
    }
  | { type: "final"; content: string };
export interface ReplyInput {
  requestID: string;
  idempotencyKey: string;
  expectedRevision: number;
  body: ReplyBody;
}
function text(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= 200;
}
function integer(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}
function object(v: unknown, keys: string[]): Record<string, unknown> {
  if (
    !v ||
    typeof v !== "object" ||
    Object.getPrototypeOf(v) !== Object.prototype ||
    Reflect.ownKeys(v).some(
      (k) => typeof k !== "string" || !keys.includes(k),
    ) ||
    Object.values(Object.getOwnPropertyDescriptors(v)).some(
      (d) => !("value" in d),
    )
  )
    throw new DomainError("invalid_input");
  return v as Record<string, unknown>;
}
export function parseReply(input: unknown): ReplyInput {
  const v = object(input, [
    "requestID",
    "idempotencyKey",
    "expectedRevision",
    "body",
  ]);
  if (
    !text(v.requestID) ||
    !text(v.idempotencyKey) ||
    !integer(v.expectedRevision)
  )
    throw new DomainError("invalid_input");
  const b = object(v.body, ["type", "content", "outcome"]);
  const content = parseMessageContent(b.content);
  let body: ReplyBody;
  if (
    b.type === "task_outcome" &&
    ["completed", "failed", "cancelled"].includes(b.outcome as string)
  )
    body = {
      type: b.type,
      content,
      outcome: b.outcome as "completed" | "failed" | "cancelled",
    };
  else if (
    (b.type === "notification" || b.type === "final") &&
    !Object.hasOwn(b, "outcome")
  )
    body = { type: b.type, content };
  else throw new DomainError("invalid_input");
  return {
    requestID: v.requestID,
    idempotencyKey: v.idempotencyKey,
    expectedRevision: v.expectedRevision,
    body,
  };
}
export interface ReplyReceipt {
  replyID: string;
  requestID: string;
  requestMessageID: string;
  taskID: string;
  correlationID: string;
  author: Principal;
  body: ReplyBody;
}
export interface ReplyPage {
  state: "pending" | "completed";
  items: readonly ReplyReceipt[];
  cursor: string;
}
/** Trusted wakeups only, never authority or data. Composition must fan out committed
 * reply writes AND ACL/removal changes across instances. Spurious wakes are safe.
 * No foreign DB callback, journal append or model execution is accepted here. */
export interface ReplyWakePort {
  subscribe(requestID: string, wake: () => void): () => void;
  publish(requestID: string): void;
}
export interface ReplyTimerPort {
  schedule(milliseconds: number, wake: () => void): () => void;
}
const timer: ReplyTimerPort = {
  schedule(ms, wake) {
    const handle = setTimeout(wake, ms);
    return () => clearTimeout(handle);
  },
};
interface RequestRow {
  owner_json: string;
  target_json: string;
  payload_json: string;
  payload_hash: string;
  state: string;
  channel: string;
  receipt_id: string;
  message_id: string;
  task_id: string;
  dispatch_hash: string;
}
interface RequestContext {
  owner: Principal;
  target: SessionRef;
  correlationID: string;
  row: RequestRow;
}
interface ReplyRow {
  sequence: number;
  reply_id: string;
  author_json: string;
  body_json: string;
  payload_hash: string;
}

export class Replies {
  constructor(
    private readonly persistence: Persistence,
    private readonly identity: TrustedPrincipalPort,
    private readonly authorization: Pick<
      Authorizer,
      "authorize" | "authorizeReplay" | "admit"
    >,
    private readonly removed: RemovedTargetPort,
    private readonly wakes: ReplyWakePort,
    private readonly now: () => number = Date.now,
    private readonly timers: ReplyTimerPort = timer,
  ) {}
  private async actor(): Promise<Principal> {
    const p = await this.identity.current();
    if (!p) throw new DomainError("forbidden");
    return p;
  }
  private request(db: Database, id: string): RequestContext {
    const row = db
      .query<
        RequestRow,
        [string]
      >(`SELECT o.*,d.message_id,d.task_id,d.payload_hash AS dispatch_hash
      FROM operations o JOIN prompt_dispatches d ON d.operation_id=o.operation_id
      WHERE o.operation_id=? AND o.capability='message'`)
      .get(id);
    if (!row) throw new DomainError("not_found");
    const payload = JSON.parse(row.payload_json);
    const owner = JSON.parse(row.owner_json) as Principal;
    const target = parseSessionRef(JSON.parse(row.target_json));
    if (
      payload.version !== 1 ||
      payload.type !== "request" ||
      !text(payload.correlationID) ||
      canonical(payload.source) !== canonical(owner) ||
      canonicalPayloadHash({ target, capability: "message", payload }) !==
        row.payload_hash ||
      row.dispatch_hash !== row.payload_hash
    )
      throw new DomainError("not_found");
    // Only host-accepted T20 requests can receive replies, never arbitrary IDs,
    // notification IDs, pending intents or unknown acceptance.
    if (
      row.state !== "admitted" ||
      row.channel !== "host" ||
      row.receipt_id !== row.message_id
    )
      throw new DomainError("not_found");
    this.removed.assertAvailable(db, target);
    if (owner.kind === "session")
      this.removed.assertAvailable(db, parseSessionRef(owner.session));
    return { owner, target, correlationID: payload.correlationID, row };
  }
  async reply(input: unknown): Promise<ReplyReceipt> {
    const r = parseReply(input);
    const actor = await this.actor();
    const context = this.persistence.transaction((db) =>
      this.request(db, r.requestID),
    );
    if (
      actor.kind !== "session" ||
      canonical(actor.session) !== canonical(context.target)
    )
      throw new DomainError("not_found");
    // The original sender is the destination. Operator-origin requests have no
    // session delivery address yet: fail closed until a trusted host adapter exists.
    if (context.owner.kind !== "session") throw new DomainError("unavailable");
    const receipt = await this.authorization.admit(
      actor,
      context.owner.session,
      "message",
      r.expectedRevision,
      () =>
        this.persistence.transaction((db) => {
          const current = this.request(db, r.requestID);
          const author = canonical(actor);
          const hash = canonicalPayloadHash(r.body);
          const existing = db
            .query<ReplyRow, [string, string, string]>(
              "SELECT * FROM request_replies WHERE request_id=? AND author_json=? AND idempotency_key=?",
            )
            .get(r.requestID, author, r.idempotencyKey);
          if (existing) {
            if (existing.payload_hash !== hash)
              throw new DomainError("conflict");
            return this.receipt(r.requestID, current, existing);
          }
          if (
            db
              .query(
                "SELECT 1 FROM request_replies WHERE request_id=? AND json_extract(body_json,'$.type')='final'",
              )
              .get(r.requestID)
          )
            throw new DomainError("conflict");
          const at = this.now();
          if (!integer(at)) throw new DomainError("unavailable");
          const replyID = crypto.randomUUID();
          db.query(
            "INSERT INTO request_replies(reply_id,request_id,author_json,idempotency_key,payload_hash,body_json,created_at) VALUES (?,?,?,?,?,?,?)",
          ).run(
            replyID,
            r.requestID,
            author,
            r.idempotencyKey,
            hash,
            canonical(r.body),
            at,
          );
          return {
            replyID,
            requestID: r.requestID,
            requestMessageID: current.row.message_id,
            taskID: current.row.task_id,
            correlationID: current.correlationID,
            author: actor,
            body: r.body,
          };
        }),
    );
    // Wakeups are hints; durable replay remains available if delivery fails.
    try {
      this.wakes.publish(r.requestID);
    } catch {
      /* Durable receipt is authoritative. */
    }
    return receipt;
  }
  private receipt(id: string, c: RequestContext, row: ReplyRow): ReplyReceipt {
    return {
      replyID: row.reply_id,
      requestID: id,
      requestMessageID: c.row.message_id,
      taskID: c.row.task_id,
      correlationID: c.correlationID,
      author: JSON.parse(row.author_json),
      body: JSON.parse(row.body_json),
    };
  }
  private async page(
    actor: Principal,
    id: string,
    cursor?: string,
  ): Promise<ReplyPage> {
    const c = this.persistence.transaction((db) => this.request(db, id));
    await this.authorization.authorizeReplay(actor, c.owner);
    // Fresh ACL on every replay and wake, including timeout/cancellation returns.
    await this.authorization.authorize(actor, c.target, "message");
    return this.persistence.transaction((db) => {
      const current = this.request(db, id);
      const owner = canonical(actor);
      let sequence = 0;
      if (cursor !== undefined) {
        const row = db
          .query<{ sequence: number }, [string, string, string]>(
            "SELECT sequence FROM reply_cursors WHERE token=? AND request_id=? AND owner_json=?",
          )
          .get(cursor, id, owner);
        if (!row) throw new DomainError("not_found");
        sequence = row.sequence;
      }
      const rows = db
        .query<ReplyRow, [string, number]>(
          "SELECT * FROM request_replies WHERE request_id=? AND sequence>? ORDER BY sequence LIMIT 100",
        )
        .all(id, sequence);
      const token = crypto.randomUUID();
      db.query("INSERT INTO reply_cursors VALUES (?,?,?,?)").run(
        token,
        id,
        owner,
        rows.at(-1)?.sequence ?? sequence,
      );
      const completed = db
        .query(
          "SELECT 1 FROM request_replies WHERE request_id=? AND json_extract(body_json,'$.type')='final' AND sequence<=?",
        )
        .get(id, rows.at(-1)?.sequence ?? sequence);
      return {
        state: completed ? "completed" : "pending",
        items: rows.map((row) => this.receipt(id, current, row)),
        cursor: token,
      };
    });
  }
  async getResult(requestID: string, cursor?: string): Promise<ReplyPage> {
    if (!text(requestID) || (cursor !== undefined && !text(cursor)))
      throw new DomainError("invalid_input");
    return this.page(await this.actor(), requestID, cursor);
  }
  async wait(
    requestID: string,
    options: { cursor?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ReplyPage> {
    if (
      !text(requestID) ||
      (options.cursor !== undefined && !text(options.cursor)) ||
      (options.timeoutMs !== undefined &&
        (!integer(options.timeoutMs) || options.timeoutMs > 30_000))
    )
      throw new DomainError("invalid_input");
    const actor = await this.actor();
    let cursor = options.cursor;
    let notified = false;
    let stopped = options.signal?.aborted ?? false;
    let resume: (() => void) | undefined;
    const wake = () => {
      notified = true;
      resume?.();
    };
    const stop = () => {
      stopped = true;
      wake();
    };
    let unsubscribe = () => {};
    let cancelTimer = () => {};
    try {
      const first = await this.page(actor, requestID, cursor);
      if (
        first.items.length ||
        first.state === "completed" ||
        stopped ||
        options.timeoutMs === 0
      )
        return first;
      cursor = first.cursor;
      unsubscribe = this.wakes.subscribe(requestID, wake);
      options.signal?.addEventListener("abort", stop, { once: true });
      if (options.signal?.aborted) stop();
      cancelTimer = this.timers.schedule(options.timeoutMs ?? 30_000, stop);
      // Check-subscribe-check closes both the DB/read and subscription races.
      for (;;) {
        notified = false;
        const page = await this.page(actor, requestID, cursor);
        if (page.items.length || page.state === "completed" || stopped)
          return page;
        cursor = page.cursor;
        if (!notified)
          await new Promise<void>((resolve) => {
            resume = resolve;
            if (notified) resolve();
          });
        resume = undefined;
      }
    } finally {
      unsubscribe();
      cancelTimer();
      options.signal?.removeEventListener("abort", stop);
    }
  }
}

/** Compose with T18 inside its canonical DB transaction, never applied on import. */
export const repliesRemovedCleanup: RemovedSessionCleanupPort = {
  cleanup(db, ref) {
    if (!db.inTransaction) throw new DomainError("unavailable");
    const target = canonical(parseSessionRef(ref));
    const owner = canonical({ kind: "session", session: ref });
    for (const table of ["request_replies", "reply_cursors"])
      db.query(
        `DELETE FROM ${table} WHERE request_id IN (SELECT operation_id FROM operations WHERE target_json=? OR owner_json=?)`,
      ).run(target, owner);
  },
};
