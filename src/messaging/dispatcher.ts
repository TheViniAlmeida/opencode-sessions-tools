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
  type Operation,
  type OperationDispatch,
  Operations,
  type RemovedTargetPort,
} from "../persistence/operations";

export const dispatcherMigration = {
  name: "prompt-dispatcher-v1",
  sql: `CREATE TABLE prompt_dispatches (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id),
    target_json TEXT NOT NULL, policy TEXT NOT NULL CHECK(policy IN ('queue','steer')),
    task_id TEXT NOT NULL UNIQUE, message_id TEXT NOT NULL UNIQUE,
    payload_hash TEXT NOT NULL
  );
  CREATE INDEX prompt_dispatches_target ON prompt_dispatches(target_json,sequence);
  CREATE INDEX prompt_pending_message_expiry ON operations(json_extract(payload_json,'$.expiresAt'))
    WHERE state='pending' AND capability='message' AND json_valid(payload_json);
  CREATE TABLE prompt_chain_rejections (
    reason TEXT NOT NULL, correlation_id TEXT NOT NULL, hops INTEGER NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY(correlation_id,hops)
  ) WITHOUT ROWID;`,
} as const;
/** Shared by the worker and its EXPLAIN regression test. The partial expression
 * index searches expired pending messages, excluding terminal history. */
export const dispatcherExpirySQL = `UPDATE operations SET state='expired' WHERE state='pending' AND capability='message'
  AND json_valid(payload_json) AND json_extract(payload_json,'$.version')=1
  AND json_extract(payload_json,'$.type') IN ('notification','request')
  AND json_type(payload_json,'$.expiresAt')='integer'
  AND json_extract(payload_json,'$.expiresAt')<=?`;
export function dispatcherMigrationAt(version: number): Migration {
  if (!Number.isSafeInteger(version) || version < 2)
    throw new DomainError("invalid_input");
  return { version, apply: (db) => db.exec(dispatcherMigration.sql) };
}

export interface PromptInput {
  readonly target: SessionRef;
  readonly content: string;
  readonly expiresAt: number;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  /** queue is FIFO among plugin queue admissions only. Explicit steer bypasses
   * that lane; the host may prioritize steer ahead of its native queued work.
   * Neither policy promises runtime execution/completion order. */
  readonly policy?: "queue" | "steer";
}
/** Supplied by execution context, never a model/tool argument or correlation lookup. */
export interface TrustedChainPort {
  current(): Promise<{
    readonly correlationID: string;
    readonly hops: number;
  } | null>;
}
export interface NativePrompt {
  readonly operationID: string;
  readonly taskID: string;
  readonly messageID: string;
  readonly payloadHash: string;
  readonly target: SessionRef;
  readonly content: string;
  readonly correlationID: string;
  readonly hops: number;
  readonly policy: "queue" | "steer";
}
/** Native acceptance only, not completion. Adapter must prove identity/hash on
 * inspection; absence alone is NOT proof of rejection. No host fencing claimed. */
export interface PromptHostPort {
  send(
    prompt: NativePrompt,
  ): Promise<
    | { state: "accepted"; messageID: string }
    | { state: "rejected" }
    | { state: "unknown_outcome" }
  >;
  inspect(
    prompt: NativePrompt,
  ): Promise<
    | { state: "accepted"; messageID: string; payloadHash: string }
    | { state: "rejected"; payloadHash: string }
    | { state: "unknown_outcome" }
  >;
}
interface Payload {
  version: 1;
  type: "request";
  source: Principal;
  content: string;
  expiresAt: number;
  correlationID: string;
  hops: number;
  policy: "queue" | "steer";
}
function integer(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}
function text(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}
export function parsePrompt(input: unknown): PromptInput {
  if (
    !input ||
    typeof input !== "object" ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    throw new DomainError("invalid_input");
  const v = input as Record<string, unknown>;
  if (
    Reflect.ownKeys(v).some(
      (k) =>
        typeof k !== "string" ||
        ![
          "target",
          "content",
          "expiresAt",
          "expectedRevision",
          "idempotencyKey",
          "policy",
        ].includes(k),
    ) ||
    Object.values(Object.getOwnPropertyDescriptors(v)).some(
      (d) => !("value" in d),
    ) ||
    !integer(v.expiresAt) ||
    !integer(v.expectedRevision) ||
    !text(v.idempotencyKey) ||
    (v.policy !== undefined && v.policy !== "queue" && v.policy !== "steer")
  )
    throw new DomainError("invalid_input");
  return {
    target: parseSessionRef(v.target),
    content: parseMessageContent(v.content),
    expiresAt: v.expiresAt,
    expectedRevision: v.expectedRevision,
    idempotencyKey: v.idempotencyKey,
    policy: v.policy ?? "queue",
  };
}
type Auth = Pick<
  Authorizer,
  "authorize" | "authorizeReplay" | "authorizeIntent" | "admitOperation"
>;
interface Journal {
  task_id: string;
  message_id: string;
  payload_hash: string;
}

export class Dispatcher {
  private readonly operations: Operations;
  constructor(
    private readonly persistence: Persistence,
    private readonly identity: TrustedPrincipalPort,
    private readonly authorization: Auth,
    private readonly chain: TrustedChainPort,
    private readonly host: PromptHostPort,
    private readonly now: () => number,
    removedTargets: RemovedTargetPort,
  ) {
    this.operations = new Operations(
      persistence,
      {
        authorize: (...args) => authorization.authorize(...args),
        authorizeReplay: (...args) => authorization.authorizeReplay(...args),
        authorizeIntent: (p, t, c, r, id, local) =>
          authorization.authorizeIntent(p, t, c, r, id, () => {
            const result = local();
            persistence.transaction((db) => {
              const row = db
                .query<
                  { payload_json: string; payload_hash: string },
                  [string]
                >(
                  "SELECT payload_json,payload_hash FROM operations WHERE operation_id=?",
                )
                .get(id);
              if (!row) throw new DomainError("unavailable");
              const value = this.payload(JSON.parse(row.payload_json), p);
              db.query(
                "INSERT INTO prompt_dispatches(operation_id,target_json,policy,task_id,message_id,payload_hash) VALUES (?,?,?,?,?,?)",
              ).run(
                id,
                canonical(t),
                value.policy,
                `task_${id}`,
                `msg_${canonicalPayloadHash(id)}`,
                row.payload_hash,
              );
            });
            return result;
          }),
        admitOperation: (p, t, c, r, id, local) =>
          authorization.admitOperation(p, t, c, r, id, () => {
            const intent = local();
            const value = this.payload(
              (intent as OperationDispatch).payload,
              p,
            );
            persistence.transaction((db) => {
              const journal = db
                .query<Journal, [string]>(
                  "SELECT * FROM prompt_dispatches WHERE operation_id=?",
                )
                .get(id);
              if (
                !journal ||
                journal.payload_hash !==
                  (intent as OperationDispatch).payloadHash
              )
                throw new DomainError("conflict");
              if (
                value.policy === "queue" &&
                db
                  .query(`SELECT 1 FROM prompt_dispatches older JOIN operations o ON o.operation_id=older.operation_id
            WHERE older.target_json=? AND older.policy='queue'
            AND older.sequence < (SELECT sequence FROM prompt_dispatches WHERE operation_id=?)
            AND o.state IN ('pending','dispatching','unknown_outcome')`)
                  .get(canonical(t), id)
              )
                throw new DomainError("conflict");
            });
            return intent;
          }),
      },
      now,
      removedTargets,
    );
  }
  private time(): number {
    const at = this.now();
    if (!integer(at)) throw new DomainError("unavailable");
    return at;
  }
  private async actor(): Promise<Principal> {
    const p = await this.identity.current();
    if (!p) throw new DomainError("forbidden");
    return p;
  }
  private payload(
    input: unknown,
    principal?: Principal,
    expiry = true,
  ): Payload {
    const p = input as Payload;
    if (
      p?.version !== 1 ||
      p.type !== "request" ||
      !integer(p.expiresAt) ||
      !integer(p.hops) ||
      p.hops < 1 ||
      p.hops > 8 ||
      !text(p.correlationID) ||
      !["queue", "steer"].includes(p.policy)
    )
      throw new DomainError("invalid_input");
    parseMessageContent(p.content);
    if (
      principal &&
      canonicalPayloadHash(p.source) !== canonicalPayloadHash(principal)
    )
      throw new DomainError("forbidden");
    if (expiry && p.expiresAt <= this.time()) throw new DomainError("expired");
    return p;
  }
  async request(input: unknown): Promise<Operation> {
    const r = parsePrompt(input);
    const principal = await this.actor();
    const context = await this.chain.current();
    if (context && (!text(context.correlationID) || !integer(context.hops)))
      throw new DomainError("unavailable");
    if (context && context.hops >= 8) {
      await this.authorization.authorize(principal, r.target, "message");
      this.persistence.transaction((db) =>
        db
          .query(
            "INSERT INTO prompt_chain_rejections(reason,correlation_id,hops,created_at) VALUES ('hop_limit',?,?,?) ON CONFLICT(correlation_id,hops) DO NOTHING",
          )
          .run(context.correlationID, context.hops, this.time()),
      );
      throw new DomainError("rate_limited");
    }
    return this.operations.enqueue({
      principal,
      target: r.target,
      capability: "message",
      expectedRevision: r.expectedRevision,
      idempotencyKey: r.idempotencyKey,
      payload: {
        version: 1,
        type: "request",
        source: principal,
        content: r.content,
        expiresAt: r.expiresAt,
        policy: r.policy ?? "queue",
        correlationID:
          context?.correlationID ??
          canonicalPayloadHash([principal, r.idempotencyKey]),
        hops: (context?.hops ?? 0) + 1,
      } satisfies Payload,
    });
  }
  private native(intent: OperationDispatch): NativePrompt {
    const value = this.payload(intent.payload, undefined, false);
    const journal = this.persistence.transaction((db) =>
      db
        .query<Journal, [string]>(
          "SELECT * FROM prompt_dispatches WHERE operation_id=?",
        )
        .get(intent.operationID),
    );
    if (!journal || journal.payload_hash !== intent.payloadHash)
      throw new DomainError("conflict");
    return {
      operationID: intent.operationID,
      taskID: journal.task_id,
      messageID: journal.message_id,
      payloadHash: intent.payloadHash,
      target: intent.target,
      content: value.content,
      correlationID: value.correlationID,
      hops: value.hops,
      policy: value.policy,
    };
  }
  /** Authenticates ownership first. A pending expired intent transitions and is
   * audited atomically, then throws expired (also on subsequent delivery calls).
   * Does not sweep other intents; schedule expirePending() for worker catch-up. */
  async deliver(
    operationID: string,
    expectedRevision: number,
    ttlMs = 30_000,
  ): Promise<Operation> {
    const principal = await this.actor();
    const row = this.persistence.transaction((db) =>
      db
        .query<{ owner_json: string }, [string]>(
          "SELECT owner_json FROM operations WHERE operation_id=? AND EXISTS(SELECT 1 FROM prompt_dispatches WHERE operation_id=operations.operation_id)",
        )
        .get(operationID),
    );
    if (!row) throw new DomainError("not_found");
    await this.authorization.authorizeReplay(
      principal,
      JSON.parse(row.owner_json),
    );
    if (this.expire(operationID).expired) throw new DomainError("expired");
    const lease = this.operations.claim(
      operationID,
      crypto.randomUUID(),
      ttlMs,
    );
    return this.operations.dispatch(
      principal,
      lease,
      expectedRevision,
      async (intent) => {
        const prompt = this.native(intent);
        const receipt = await this.host.send(prompt);
        if (receipt.state === "accepted")
          return receipt.messageID === prompt.messageID
            ? {
                state: "admitted",
                receiptID: receipt.messageID,
                channel: "host",
              }
            : { state: "unknown_outcome" };
        return { state: receipt.state };
      },
    );
  }
  /** T19 catch-up too: only typed message intents, pending->expired and audit in
   * one local transaction. Dispatching/unknown/admitted are never retracted. */
  expirePending(): number {
    return this.expire().count;
  }
  private expire(operationID?: string): { count: number; expired: boolean } {
    return this.persistence.transaction((db) => {
      const at = this.time();
      const rows = db
        .query<{ operation_id: string }, (number | string)[]>(
          `${dispatcherExpirySQL}${operationID === undefined ? "" : " AND operation_id=?"} RETURNING operation_id`,
        )
        .all(...(operationID === undefined ? [at] : [at, operationID]));
      for (const r of rows)
        db.query(
          "INSERT INTO operation_audit(operation_id,state,created_at) VALUES (?,'expired',?)",
        ).run(r.operation_id, at);
      return {
        count: rows.length,
        expired:
          operationID !== undefined &&
          db
            .query(
              "SELECT 1 FROM operations WHERE operation_id=? AND state='expired'",
            )
            .get(operationID) !== null,
      };
    });
  }
  recover(): number {
    return this.operations.recover();
  }
  async reconcile(operationID: string): Promise<Operation> {
    const principal = await this.actor();
    return this.operations.reconcile(principal, operationID, {
      inspect: async (id) => {
        const intent = this.persistence.transaction((db) =>
          db
            .query<
              {
                target_json: string;
                payload_json: string;
                payload_hash: string;
              },
              [string]
            >(
              "SELECT target_json,payload_json,payload_hash FROM operations WHERE operation_id=?",
            )
            .get(id),
        );
        if (!intent) throw new DomainError("not_found");
        const prompt = this.native({
          operationID: id,
          target: parseSessionRef(JSON.parse(intent.target_json)),
          payload: JSON.parse(intent.payload_json),
          payloadHash: intent.payload_hash,
        });
        const result = await this.host.inspect(prompt);
        if (result.state === "unknown_outcome")
          return {
            operationID: id,
            payloadHash: prompt.payloadHash,
            evidence: { state: "unknown_outcome" },
          };
        if (
          result.payloadHash !== prompt.payloadHash ||
          (result.state === "accepted" && result.messageID !== prompt.messageID)
        )
          throw new DomainError("conflict");
        return {
          operationID: id,
          payloadHash: result.payloadHash,
          evidence:
            result.state === "accepted"
              ? {
                  state: "admitted",
                  channel: "host",
                  receiptID: result.messageID,
                }
              : { state: "rejected" },
        };
      },
    });
  }
}
