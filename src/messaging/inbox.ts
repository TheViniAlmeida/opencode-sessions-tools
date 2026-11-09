import type { Database } from "bun:sqlite";
import type {
  Authorizer,
  TrustedPrincipalPort,
} from "../authorization/authorize";
import {
  DomainError,
  type Principal,
  parseMessageContent,
  parseSessionRef,
  type SessionRef,
} from "../contracts";
import type { Migration, Persistence } from "../persistence/database";
import {
  canonicalPayloadHash,
  type OperationDispatch,
  Operations,
  type RemovedTargetPort,
} from "../persistence/operations";
import type { RemovedSessionCleanupPort } from "../sessions/reconcile";

export const inboxMigration = {
  name: "notification-inbox-v1",
  sql: `CREATE TABLE notification_inbox (
    envelope_id TEXT PRIMARY KEY REFERENCES operations(operation_id),
    source_json TEXT NOT NULL, target_json TEXT NOT NULL,
    correlation_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
    content TEXT, admitted_at INTEGER NOT NULL
  );
  CREATE INDEX notification_inbox_target ON notification_inbox(target_json,admitted_at,envelope_id);`,
} as const;

export function inboxMigrationAt(version: number): Migration {
  if (!Number.isSafeInteger(version) || version < 2)
    throw new DomainError("invalid_input");
  return { version, apply: (db) => db.exec(inboxMigration.sql) };
}

export interface NotificationInput {
  readonly target: SessionRef;
  readonly content: string;
  readonly correlationID: string;
  readonly expiresAt: number;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
export function parseNotification(input: unknown): NotificationInput {
  if (
    !input ||
    typeof input !== "object" ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    throw new DomainError("invalid_input");
  const value = input as Record<string, unknown>;
  const keys = [
    "target",
    "content",
    "correlationID",
    "expiresAt",
    "idempotencyKey",
    "expectedRevision",
  ];
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !keys.includes(key),
    ) ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (d) => !("value" in d),
    ) ||
    !nonempty(value.correlationID) ||
    !nonempty(value.idempotencyKey) ||
    !integer(value.expiresAt) ||
    !integer(value.expectedRevision)
  )
    throw new DomainError("invalid_input");
  return {
    target: parseSessionRef(value.target),
    content: parseMessageContent(value.content),
    correlationID: value.correlationID,
    expiresAt: value.expiresAt,
    idempotencyKey: value.idempotencyKey,
    expectedRevision: value.expectedRevision,
  };
}
function refKey(ref: SessionRef): string {
  return JSON.stringify(parseSessionRef(ref));
}
interface StoredNotification {
  version: 1;
  type: "notification";
  source: Principal;
  content: string;
  correlationID: string;
  expiresAt: number;
}
export interface InboxEnvelope extends StoredNotification {
  readonly envelopeID: string;
  readonly target: SessionRef;
  /** Local durable availability only; not runtime completion or model execution. */
  readonly state: "admitted";
  readonly channel: "inbox";
}
interface InboxRow {
  envelope_id: string;
  source_json: string;
  target_json: string;
  correlation_id: string;
  expires_at: number;
  content: string;
}

/** Notifications have no host adapter by construction. Outgoing intent and replay
 * belong to T13. The decorator inserts the inbox in T11/T12's SAME synchronous
 * admission transaction as pending->dispatching and once consumption. */
export class Inbox {
  private readonly operations: Operations;
  constructor(
    private readonly persistence: Persistence,
    private readonly identity: TrustedPrincipalPort,
    private readonly authorization: Pick<
      Authorizer,
      | "authorize"
      | "authorizeReplay"
      | "authorizeIntent"
      | "admitOperation"
      | "admit"
    >,
    private readonly now: () => number,
    private readonly removedTargets: RemovedTargetPort,
  ) {
    this.operations = new Operations(
      persistence,
      {
        authorize: (...args) => authorization.authorize(...args),
        authorizeReplay: (...args) => authorization.authorizeReplay(...args),
        authorizeIntent: (principal, target, capability, revision, id, local) =>
          authorization.authorizeIntent(
            principal,
            target,
            capability,
            revision,
            id,
            () => {
              const result = local();
              this.persistence.transaction((db) => {
                const row = db
                  .query<{ payload_json: string }, [string]>(
                    "SELECT payload_json FROM operations WHERE operation_id=?",
                  )
                  .get(id);
                if (!row) throw new DomainError("unavailable");
                this.validPayload(JSON.parse(row.payload_json), principal);
              });
              return result;
            },
          ),
        admitOperation: (principal, target, capability, revision, id, local) =>
          authorization.admitOperation(
            principal,
            target,
            capability,
            revision,
            id,
            () => {
              const intent = local();
              // This Operations instance dispatches only this module's typed intents.
              if (capability !== "message")
                throw new DomainError("invalid_input");
              this.store(intent as OperationDispatch, principal);
              return intent;
            },
          ),
      },
      now,
      removedTargets,
    );
  }

  private time(): number {
    const value = this.now();
    if (!integer(value)) throw new DomainError("unavailable");
    return value;
  }
  private async actor(): Promise<Principal> {
    const actor = await this.identity.current();
    if (!actor) throw new DomainError("forbidden");
    return actor;
  }
  /** Persist complete envelope before delivery. Replays never claim or dispatch. */
  async enqueueNotification(input: unknown) {
    const request = parseNotification(input);
    const principal = await this.actor();
    // Expiry is checked again at admission; T13 owns replay even after expiry.
    return this.operations.enqueue({
      principal,
      target: request.target,
      capability: "message",
      expectedRevision: request.expectedRevision,
      idempotencyKey: request.idempotencyKey,
      payload: {
        version: 1,
        type: "notification",
        source: principal,
        content: request.content,
        correlationID: request.correlationID,
        expiresAt: request.expiresAt,
      } satisfies StoredNotification,
    });
  }
  /** Internal worker entry, not a tool payload dispatcher. No retry after uncertainty. */
  async deliverNotification(operationID: string, expectedRevision: number) {
    const principal = await this.actor();
    // Authenticate ownership before claiming a lease (including guessed IDs).
    const owner = this.persistence.transaction((db) =>
      db
        .query<{ owner_json: string }, [string]>(
          "SELECT owner_json FROM operations WHERE operation_id=?",
        )
        .get(operationID),
    );
    if (!owner) throw new DomainError("not_found");
    await this.authorization.authorizeReplay(
      principal,
      JSON.parse(owner.owner_json) as Principal,
    );
    const lease = this.operations.claim(
      operationID,
      crypto.randomUUID(),
      30_000,
    );
    return this.operations.dispatch(
      principal,
      lease,
      expectedRevision,
      async (intent) => ({
        state: "admitted",
        receiptID: intent.operationID,
        channel: "inbox",
      }),
    );
  }

  private validPayload(
    payload: unknown,
    principal: Principal,
  ): StoredNotification {
    const value = payload as StoredNotification;
    if (
      value?.version !== 1 ||
      value.type !== "notification" ||
      !integer(value.expiresAt) ||
      !nonempty(value.correlationID)
    )
      throw new DomainError("invalid_input");
    parseMessageContent(value.content);
    if (canonicalPayloadHash(value.source) !== canonicalPayloadHash(principal))
      throw new DomainError("forbidden");
    if (value.expiresAt <= this.time()) throw new DomainError("expired");
    return value;
  }
  private store(intent: OperationDispatch, principal: Principal): void {
    const value = this.validPayload(intent.payload, principal);
    const at = this.time();
    this.persistence.transaction((db) => {
      if (!db.inTransaction) throw new DomainError("unavailable");
      this.guard(db, intent.target);
      db.query("INSERT INTO notification_inbox VALUES (?,?,?,?,?,?,?)").run(
        intent.operationID,
        JSON.stringify(value.source),
        refKey(intent.target),
        value.correlationID,
        value.expiresAt,
        value.content,
        at,
      );
    });
  }
  private guard(db: Database, target: SessionRef): void {
    if (
      !this.removedTargets ||
      typeof this.removedTargets.assertAvailable !== "function"
    )
      throw new DomainError("unavailable");
    const result: unknown = this.removedTargets.assertAvailable(db, target);
    if (result && typeof (result as { then?: unknown }).then === "function")
      throw new DomainError("unavailable");
  }

  /** Incoming direction: a session can read ONLY its own destination. Operators
   * must independently hold read authority for the explicit destination scope.
   * Existing read grants still apply, including self-read authorization. No
   * reverse destination->sender message grant is inferred or required. */
  async receive(
    targetInput: SessionRef,
    expectedRevision: number,
    limit = 100,
  ): Promise<readonly InboxEnvelope[]> {
    const target = parseSessionRef(targetInput);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new DomainError("invalid_input");
    const principal = await this.actor();
    if (
      principal.kind === "session" &&
      refKey(principal.session) !== refKey(target)
    )
      throw new DomainError("not_found");
    return this.authorization.admit(
      principal,
      target,
      "read",
      expectedRevision,
      () =>
        this.persistence.transaction((db) => {
          this.guard(db, target);
          return db
            .query<
              InboxRow,
              [string, number, number]
            >(`SELECT * FROM notification_inbox
          WHERE target_json=? AND expires_at>? AND content IS NOT NULL
          ORDER BY admitted_at,envelope_id LIMIT ?`)
            .all(refKey(target), this.time(), limit)
            .map((row) => ({
              version: 1 as const,
              type: "notification" as const,
              envelopeID: row.envelope_id,
              source: JSON.parse(row.source_json) as Principal,
              target,
              correlationID: row.correlation_id,
              expiresAt: row.expires_at,
              content: row.content,
              state: "admitted" as const,
              channel: "inbox" as const,
            }));
        }),
    );
  }
}

/** Compose with T18 cleanup, on the supplied transaction only. Retain identifiers
 * and payload-free operation audit; redact both incoming and outgoing content. */
export const inboxCleanupPort: RemovedSessionCleanupPort = {
  cleanup(db, input) {
    if (!db.inTransaction) throw new DomainError("unavailable");
    const ref = parseSessionRef(input);
    db.query(`UPDATE notification_inbox SET content=NULL WHERE target_json=? OR (
      json_extract(source_json,'$.kind')='session' AND
      json_extract(source_json,'$.session.instanceID')=? AND
      json_extract(source_json,'$.session.projectID')=? AND
      json_extract(source_json,'$.session.sessionID')=?)`).run(
      refKey(ref),
      ref.instanceID,
      ref.projectID,
      ref.sessionID,
    );
    db.query(`UPDATE operations SET payload_json='null' WHERE
      json_extract(payload_json,'$.type')='notification' AND
      json_extract(payload_json,'$.source.kind')='session' AND
      json_extract(payload_json,'$.source.session.instanceID')=? AND
      json_extract(payload_json,'$.source.session.projectID')=? AND
      json_extract(payload_json,'$.source.session.sessionID')=?`).run(
      ref.instanceID,
      ref.projectID,
      ref.sessionID,
    );
  },
};
