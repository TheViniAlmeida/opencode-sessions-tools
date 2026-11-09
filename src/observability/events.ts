import type { Database } from "bun:sqlite";
import type {
  Authorizer,
  TrustedPrincipalPort,
} from "../authorization/authorize";
import {
  type Capability,
  canonical,
  capabilities,
  DomainError,
  type Principal,
  parseSessionRef,
  type SessionRef,
} from "../contracts";
import type { Migration, Persistence } from "../persistence/database";

export const eventKinds = [
  "grant.created",
  "grant.revoked",
  "message.admitted",
  "message.rejected",
  "task.state_changed",
  "request.resolved",
  "session.changed",
  "job.state_changed",
  "job.fired",
  "context.changed",
  "budget.changed",
  "operation.unknown",
] as const;
export type EventKind = (typeof eventKinds)[number];
export const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Composed by the application alongside T10/T13; importing never migrates a DB. */
export const eventsMigration = {
  name: "event-journal-v1",
  sql: `CREATE TABLE event_heads (target TEXT PRIMARY KEY, sequence INTEGER NOT NULL, removed_through INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE event_journal (
      journal_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      target TEXT NOT NULL, sequence INTEGER NOT NULL, created_at INTEGER NOT NULL,
      event_json TEXT NOT NULL, UNIQUE(target,sequence)
    );
    CREATE INDEX event_retention ON event_journal(created_at);
    CREATE TABLE event_cursors (
      token TEXT PRIMARY KEY, principal TEXT NOT NULL, target TEXT NOT NULL,
      sequence INTEGER NOT NULL, created_at INTEGER NOT NULL
    );`,
} as const;
export function eventsMigrationAt(version: number): Migration {
  if (!Number.isSafeInteger(version) || version < 2)
    throw new DomainError("invalid_input");
  return { version, apply: (db) => db.exec(eventsMigration.sql) };
}

type Empty = Record<string, never>;
export type EventPayloads = {
  "grant.created": { capabilities: readonly Capability[]; revision: number };
  "grant.revoked": { capabilities: readonly Capability[]; revision: number };
  "message.admitted": { channel: "host" | "inbox" };
  "message.rejected": Empty;
  "task.state_changed": {
    state:
      | "pending"
      | "running"
      | "blocked"
      | "cancelled"
      | "completed"
      | "failed"
      | "awaiting_input"
      | "awaiting_approval"
      | "cancel_requested";
  };
  "request.resolved": { state: "approved" | "denied" | "expired" };
  "session.changed": Empty;
  "job.state_changed": { state: "active" | "paused" | "cancelled" };
  "job.fired": Empty;
  "context.changed": { revision: number };
  "budget.changed": { revision: number };
  "operation.unknown": Empty;
};
export type EventInput = {
  [K in EventKind]: {
    kind: K;
    target: SessionRef;
    operationID: string;
    payload: EventPayloads[K];
  };
}[EventKind];
export type JournalEvent = EventInput & {
  /** Persisted target-local sequence, never a global hidden-event counter. */
  sequence: number;
  actor: Principal;
  timestamp: string;
};
export interface EventPage {
  items: readonly JournalEvent[];
  cursor: string;
}
export type EventStream = "session" | "requests";
function streamKey(target: SessionRef, stream: EventStream): string {
  return canonical([target, stream]);
}
export class EventCursorExpired extends DomainError {
  readonly resynchronize = "snapshot";
  constructor() {
    super("expired", false);
  }
}

function invalid(): never {
  throw new DomainError("invalid_input");
}
function revision(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function principalKey(principal: Principal): string {
  if (
    !principal ||
    Object.keys(principal).some(
      (key) =>
        !(
          principal.kind === "session"
            ? ["kind", "session"]
            : ["kind", "operatorID", "instanceID", "revision"]
        ).includes(key),
    )
  )
    throw new DomainError("forbidden");
  if (principal?.kind === "session")
    return canonical(["session", parseSessionRef(principal.session)]);
  if (
    principal?.kind !== "operator" ||
    typeof principal.operatorID !== "string" ||
    !principal.operatorID.trim() ||
    typeof principal.instanceID !== "string" ||
    !principal.instanceID.trim() ||
    !revision(principal.revision)
  )
    throw new DomainError("forbidden");
  return canonical([
    "operator",
    principal.instanceID,
    principal.operatorID,
    principal.revision,
  ]);
}
function parseInput(input: EventInput): EventInput {
  if (
    !input ||
    Object.keys(input).some(
      (key) => !["kind", "target", "operationID", "payload"].includes(key),
    ) ||
    !eventKinds.includes(input.kind) ||
    typeof input.operationID !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,200}$/.test(input.operationID)
  )
    invalid();
  const target = parseSessionRef(input.target);
  const payload = input.payload as Record<string, unknown>;
  if (!payload || Object.getPrototypeOf(payload) !== Object.prototype)
    invalid();
  let keys: string[] = [];
  switch (input.kind) {
    case "grant.created":
    case "grant.revoked":
      keys = ["capabilities", "revision"];
      if (
        !Array.isArray(payload.capabilities) ||
        !payload.capabilities.every((c) => capabilities.includes(c)) ||
        !revision(payload.revision)
      )
        invalid();
      break;
    case "context.changed":
    case "budget.changed":
      keys = ["revision"];
      if (!revision(payload.revision)) invalid();
      break;
    case "message.admitted":
      keys = ["channel"];
      if (payload.channel !== "host" && payload.channel !== "inbox") invalid();
      break;
    case "task.state_changed":
      keys = ["state"];
      if (
        typeof payload.state !== "string" ||
        ![
          "pending",
          "running",
          "blocked",
          "cancelled",
          "completed",
          "failed",
          "awaiting_input",
          "awaiting_approval",
          "cancel_requested",
        ].includes(payload.state)
      )
        invalid();
      break;
    case "request.resolved":
      keys = ["state"];
      if (
        typeof payload.state !== "string" ||
        !["approved", "denied", "expired"].includes(payload.state)
      )
        invalid();
      break;
    case "job.state_changed":
      keys = ["state"];
      if (
        typeof payload.state !== "string" ||
        !["active", "paused", "cancelled"].includes(payload.state)
      )
        invalid();
      break;
  }
  if (
    Object.keys(payload).length !== keys.length ||
    Object.keys(payload).some((key) => !keys.includes(key))
  )
    invalid();
  return JSON.parse(canonical({ ...input, target })) as EventInput;
}

/** Trusted domain emitter, not a native/global host event stream. No log.synced replay. */
export interface DomainEventSource {
  subscribe(emit: (input: EventInput, actor: Principal) => void): () => void;
}

export class Events {
  private release: (() => void) | undefined;
  private generation = 0;
  private disposed = false;
  constructor(
    private readonly persistence: Persistence,
    private readonly identity: TrustedPrincipalPort,
    private readonly authorization: Pick<Authorizer, "authorize">,
    private readonly now: () => number,
  ) {}

  private time(): number {
    const at = this.now();
    if (!Number.isSafeInteger(at) || at < 0)
      throw new DomainError("unavailable");
    return at;
  }
  /** Internal callback port. Actor comes from the trusted domain boundary, never RPC input.
   * Use appendInTransaction with the domain mutation to avoid a commit/event crash gap. */
  append(input: EventInput, actor: Principal): JournalEvent {
    return this.persistence.transaction((db) =>
      this.appendInTransaction(db, input, actor),
    );
  }
  appendInTransaction(
    db: Database,
    input: EventInput,
    actor: Principal,
  ): JournalEvent {
    if (this.disposed || !db.inTransaction)
      throw new DomainError("unavailable");
    const clean = parseInput(input);
    principalKey(actor);
    // Access request resolutions have a separate private sequence: a read grant
    // on the origin must not reveal even their count (ACL-08).
    // The emitter MUST set target to the request's trusted stored origin.
    const target = streamKey(
      clean.target,
      clean.kind === "request.resolved" ? "requests" : "session",
    );
    const at = this.time();
    db.query(
      "INSERT INTO event_heads(target,sequence) VALUES (?,0) ON CONFLICT(target) DO NOTHING",
    ).run(target);
    const head = db
      .query<{ sequence: number }, [string]>(
        "UPDATE event_heads SET sequence=sequence+1 WHERE target=? RETURNING sequence",
      )
      .get(target);
    if (!head || !Number.isSafeInteger(head.sequence))
      throw new DomainError("unavailable");
    const event = {
      ...clean,
      actor: JSON.parse(canonical(actor)) as Principal,
      sequence: head.sequence,
      timestamp: new Date(at).toISOString(),
    } as JournalEvent;
    db.query(
      "INSERT INTO event_journal(target,sequence,created_at,event_json) VALUES (?,?,?,?)",
    ).run(target, head.sequence, at, canonical(event));
    return event;
  }

  /** No principal/actor accepted from request payload; target is an explicitly authorized scope.
   * No global head, hidden count, scan position or hasMore metadata is exposed. */
  async read(request: {
    target: SessionRef;
    stream?: EventStream;
    cursor?: string;
    limit?: number;
  }): Promise<EventPage> {
    if (this.disposed) throw new DomainError("unavailable");
    const target = parseSessionRef(request.target);
    const stream = request.stream ?? "session";
    if (stream !== "session" && stream !== "requests") invalid();
    const limit = request.limit ?? 100;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (request.cursor !== undefined && !/^[a-f0-9]{64}$/.test(request.cursor))
    )
      invalid();
    const principal = await this.identity.current();
    if (!principal) throw new DomainError("forbidden");
    const owner = principalKey(principal);
    await this.authorization.authorize(principal, target, "read");
    if (
      stream === "requests" &&
      principal.kind === "session" &&
      canonical(principal.session) !== canonical(target)
    )
      throw new DomainError("not_found");
    const at = this.time();
    const key = streamKey(target, stream);
    const rows = this.persistence.transaction((db) => {
      let after = 0;
      if (request.cursor !== undefined) {
        const cursor = db
          .query<
            { sequence: number; created_at: number },
            [string, string, string]
          >(
            "SELECT sequence,created_at FROM event_cursors WHERE token=? AND principal=? AND target=?",
          )
          .get(request.cursor, owner, key);
        if (!cursor) throw new DomainError("not_found");
        if (cursor.created_at <= at - EVENT_RETENTION_MS)
          throw new EventCursorExpired();
        after = cursor.sequence;
        const head = db
          .query<{ removed_through: number }, [string]>(
            "SELECT removed_through FROM event_heads WHERE target=?",
          )
          .get(key);
        if (head && after < head.removed_through)
          throw new EventCursorExpired();
        if (
          db
            .query(
              "SELECT 1 FROM event_journal WHERE target=? AND sequence>? AND created_at<=? LIMIT 1",
            )
            .get(key, after, at - EVENT_RETENTION_MS)
        )
          throw new EventCursorExpired();
      }
      return {
        after,
        items: db
          .query<{ event_json: string }, [string, number, number, number]>(
            "SELECT event_json FROM event_journal WHERE target=? AND sequence>? AND created_at>? ORDER BY sequence LIMIT ?",
          )
          .all(key, after, at - EVENT_RETENTION_MS, limit),
      };
    });
    const items = rows.items.map(
      (row) => JSON.parse(row.event_json) as JournalEvent,
    );
    // Catch grant/operator revocation while the asynchronous read was in flight.
    await this.authorization.authorize(principal, target, "read");
    if ((await this.identity.current()) !== principal)
      throw new DomainError("forbidden");
    const token =
      crypto.randomUUID().replaceAll("-", "") +
      crypto.randomUUID().replaceAll("-", "");
    this.persistence.transaction((db) => {
      db.query("INSERT INTO event_cursors VALUES (?,?,?,?,?)").run(
        token,
        owner,
        key,
        items.at(-1)?.sequence ?? rows.after,
        at,
      );
    });
    return { items, cursor: token };
  }

  /** Explicit maintenance, no unmanaged timer. Keep compact watermarks for gap detection. */
  prune(): void {
    const cutoff = this.time() - EVENT_RETENTION_MS;
    this.persistence.transaction((db) => {
      db.query(`UPDATE event_heads SET removed_through=MAX(removed_through,COALESCE(
        (SELECT MAX(sequence) FROM event_journal WHERE target=event_heads.target AND created_at<=?),0))`).run(
        cutoff,
      );
      db.query("DELETE FROM event_journal WHERE created_at<=?").run(cutoff);
      // Retain opaque cursor tombstones: an expired issued token must not become not_found.
    });
  }

  /** One owned subscription per instance. Rebinding invalidates late callbacks too. */
  subscribe(source: DomainEventSource): () => void {
    if (this.disposed) throw new DomainError("unavailable");
    const generation = ++this.generation;
    this.release?.();
    this.release = undefined;
    const release = source.subscribe((input, actor) => {
      if (!this.disposed && generation === this.generation)
        this.append(input, actor);
    });
    this.release = release;
    return () => {
      if (generation !== this.generation) return;
      ++this.generation;
      this.release = undefined;
      release();
    };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    ++this.generation;
    const release = this.release;
    this.release = undefined;
    release?.();
  }
}
