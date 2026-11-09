import type { Database } from "bun:sqlite";
import type {
  Authorizer,
  TrustedPrincipalPort,
} from "../authorization/authorize";
import {
  canonical,
  DomainError,
  type Principal,
  parseSessionRef,
  type SessionRef,
} from "../contracts";
import type { Persistence } from "../persistence/database";
import {
  type Operation,
  Operations,
  type RemovedTargetPort,
} from "../persistence/operations";
import type { RemovedSessionCleanupPort } from "../sessions/reconcile";
import {
  type ExportEnvelope,
  hashExportPayload,
  type TranscriptMessage,
} from "./export";

/** Compose explicitly with the global migration list; construction never migrates. */
export const importMigration = {
  name: "context-import-v1",
  sql: `CREATE TABLE context_import_plans (
    operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id),
    plan_json TEXT NOT NULL, effects_json TEXT NOT NULL
  );`,
} as const;
/** Additive descriptor: the integrator assigns the next global version.
 * Never expand the historical context-import-v1 SQL or migrate on construction.
 */
export const IMPORT_ATTACHMENTS_MIGRATION = {
  name: "context-import-attachments-v1",
  sql: `CREATE TABLE context_import_attachments (
    operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id),
    target_json TEXT NOT NULL, owner_json TEXT NOT NULL,
    content_json TEXT, payload_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
    redacted_at INTEGER
  );
  CREATE INDEX context_import_attachment_scope ON context_import_attachments(target_json,owner_json);`,
} as const;
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
function invalid(): never {
  throw new DomainError("invalid_input");
}
function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid();
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    invalid();
  return v;
}
function text(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}
/** Raw envelope size, not a reserialization. Digest proves integrity, NOT origin. */
export function parseImportEnvelope(raw: unknown): ExportEnvelope {
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw, "utf8") > MAX_IMPORT_BYTES
  )
    invalid();
  // Reject unpaired UTF-16 surrogates rather than silently replacing raw bytes.
  if (!raw.isWellFormed()) invalid();
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    invalid();
  }
  const envelope = record(json, ["payload", "sha256"]);
  const p = record(envelope.payload, [
    "version",
    "source",
    "createdAt",
    "mode",
    "projection",
    "loss",
  ]);
  if (
    p.version !== 1 ||
    !["selected-context", "native-transcript"].includes(p.mode as string)
  )
    invalid();
  parseSessionRef(p.source);
  if (
    typeof p.createdAt !== "string" ||
    !Number.isFinite(Date.parse(p.createdAt)) ||
    new Date(p.createdAt).toISOString() !== p.createdAt
  )
    invalid();
  const projection = record(p.projection, ["kind", "messages"]);
  if (
    projection.kind !== "text-messages-v1" ||
    !Array.isArray(projection.messages)
  )
    invalid();
  const ids = new Set<string>();
  for (const value of projection.messages) {
    const m = record(value, ["id", "role", "text"]);
    if (
      !text(m.id) ||
      ids.has(m.id) ||
      !["user", "assistant"].includes(m.role as string) ||
      typeof m.text !== "string" ||
      !m.text.isWellFormed()
    )
      invalid();
    ids.add(m.id);
  }
  const loss = record(p.loss, [
    "filesystem",
    "processes",
    "nativeState",
    "nonTextParts",
    "configuration",
    "authority",
  ]);
  if (
    Object.values(loss).some((v) => v !== true) ||
    typeof envelope.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(envelope.sha256) ||
    hashExportPayload(p) !== envelope.sha256
  )
    invalid();
  return json as ExportEnvelope;
}

export type ImportSelection =
  /** APPEND 1.0 is plugin-owned context attachment, NOT native history append. */
  | { readonly mode: "append"; readonly target: SessionRef }
  | {
      readonly mode: "create";
      readonly authorityTarget: SessionRef;
      readonly destination: {
        readonly instanceID: string;
        readonly projectID: string;
      };
    };
export interface ImportInput {
  readonly raw: string;
  readonly selection: ImportSelection;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
}
export interface ImportPlan {
  readonly operationID: string;
  readonly selection: ImportSelection;
  readonly target: SessionRef;
  readonly messages: readonly (TranscriptMessage & {
    readonly sourceID: string;
  })[];
}
export interface ImportEffects {
  readonly attachmentID: string | null;
  /** Observations, including unexpected routing, never inferred from planned IDs. */
  readonly session: SessionRef | null;
  readonly messageIDs: readonly string[];
  readonly messageObservations: readonly {
    readonly session: SessionRef;
    readonly messageID: string;
  }[];
  /** Candidate IDs journaled BEFORE I/O; absence of receipt is not absence of effect. */
  readonly uncertain: readonly string[];
  readonly failure: "conflict" | "not_found" | null;
}
export interface ImportBatchObservation {
  readonly observedSession: SessionRef | null;
  readonly confirmedMessages: readonly {
    readonly session: SessionRef;
    readonly messageID: string;
  }[];
  readonly uncertainIDs: readonly string[];
}
export type ImportNewSessionReceipt =
  | { readonly state: "observed"; readonly value: ImportBatchObservation }
  | { readonly state: "no_effect"; readonly code: "conflict" | "not_found" };
export interface ImportHostPort {
  /** Bound requests to a deadline shorter than the T13 lease. A timeout/lost
   * response MUST throw (unknown), never report no_effect or retry a request.
   * An adapter unable to preserve planned IDs/roles must reject before mutation.
   */
  /** Required for create. Synchronous local capability check, no network/I/O.
   * Called only after T11 authorizes the caller, before intent/admission commits.
   */
  preflight?(plan: ImportPlan): void;
  /** Required for create. One batch with ALL planned IDs/messages. No retry of
   * ambiguous requests; timeouts MUST throw. Never transport native authority.
   */
  importNewSession?(plan: ImportPlan): Promise<ImportNewSessionReceipt>;
}
export interface ImportDestinationPort {
  /** Mandatory trusted synchronous preflight in SAME admission transaction.
   * Check support for the entire projection BEFORE any host mutation, effective
   * host project/location, operator preapproval when crossing
   * destination scopes, and permission to create there. Bind approval to plan,
   * principal and operationID; consume only at admission. Package source is NOT
   * an authority target. Never issue grants or perform host I/O here.
   * Missing routing/preapproval evidence must throw forbidden/unavailable.
   */
  check(
    sql: Database,
    plan: ImportPlan,
    principal: Principal,
    phase: "intent" | "admission",
  ): void;
}
export interface ImportResult {
  readonly modality: "context_attachment" | "native_batch";
  readonly operation: Operation;
  readonly effects: ImportEffects;
  readonly error: "unknown_outcome" | "conflict" | "not_found" | null;
}
export interface ContextAttachmentContent {
  readonly version: 1;
  readonly sha256: string;
  readonly projection: ExportEnvelope["payload"]["projection"];
  readonly loss: ExportEnvelope["payload"]["loss"];
}
export interface ContextAttachmentInfo {
  readonly kind: "context_attachment";
  readonly attachmentID: string;
  readonly target: SessionRef;
  readonly sha256: string;
  readonly createdAt: number;
}
export interface ContextAttachment extends ContextAttachmentInfo {
  readonly content: ContextAttachmentContent;
}
/** Compose into T18's cleanup callback in its SAME transaction. Redact plugin
 * transcript copies, retaining operation identity/hash/receipt and effect IDs.
 * No host mutation, grants or filesystem/environment restoration.
 */
export function contextImportCleanup(
  now: () => number,
): RemovedSessionCleanupPort {
  if (typeof now !== "function") throw new DomainError("invalid_input");
  return {
    cleanup(sql, ref) {
      ref = parseSessionRef(ref);
      if (!sql.inTransaction) throw new DomainError("unavailable");
      const at = now();
      if (!Number.isSafeInteger(at) || at < 0)
        throw new DomainError("unavailable");
      const target = canonical(ref);
      const rows = sql
        .query<
          { operation_id: string; plan_json: string },
          [string, string, string, string]
        >(
          `SELECT p.operation_id,p.plan_json FROM context_import_plans p JOIN operations o USING(operation_id)
        WHERE o.target_json=? OR (json_extract(p.plan_json,'$.target.instanceID')=json_extract(?,'$.instanceID')
       AND json_extract(p.plan_json,'$.target.projectID')=json_extract(?,'$.projectID')
        AND json_extract(p.plan_json,'$.target.sessionID')=json_extract(?,'$.sessionID'))`,
        )
        .all(target, target, target, target);
      for (const row of rows) {
        const plan: ImportPlan = JSON.parse(row.plan_json);
        sql
          .query(
            "UPDATE context_import_plans SET plan_json=? WHERE operation_id=?",
          )
          .run(
            JSON.stringify({
              ...plan,
              messages: plan.messages.map((m) => ({ ...m, text: "" })),
            }),
            row.operation_id,
          );
        sql
          .query(
            "UPDATE operations SET payload_json='null' WHERE operation_id=?",
          )
          .run(row.operation_id);
      }
      // Direct target scope also covers historical/orphan rows when FK enforcement
      // was disabled. Never use operation ID alone to redact another target's row.
      sql
        .query(
          "UPDATE context_import_attachments SET content_json=NULL,redacted_at=COALESCE(redacted_at,?) WHERE target_json=?",
        )
        .run(at, target);
    },
  };
}
type Auth = Pick<
  Authorizer,
  | "authorize"
  | "authorizeReplay"
  | "authorizeIntent"
  | "admitOperation"
  | "delegatedOperation"
>;
const same = (a: SessionRef, b: SessionRef) => canonical(a) === canonical(b);
function normalize(raw: ImportInput): {
  input: ImportInput;
  envelope: ExportEnvelope;
  anchor: SessionRef;
} {
  const v = record(raw, [
    "raw",
    "selection",
    "idempotencyKey",
    "expectedRevision",
  ]);
  const envelope = parseImportEnvelope(v.raw);
  if (
    !text(v.idempotencyKey) ||
    !Number.isSafeInteger(v.expectedRevision) ||
    (v.expectedRevision as number) < 0
  )
    invalid();
  let selection: ImportSelection;
  if (raw.selection?.mode === "append") {
    record(raw.selection, ["mode", "target"]);
    selection = {
      mode: "append",
      target: parseSessionRef(raw.selection.target),
    };
  } else if (raw.selection?.mode === "create") {
    record(raw.selection, ["mode", "authorityTarget", "destination"]);
    const d = record(raw.selection.destination, ["instanceID", "projectID"]);
    if (!text(d.instanceID) || !text(d.projectID)) invalid();
    selection = {
      mode: "create",
      authorityTarget: parseSessionRef(raw.selection.authorityTarget),
      destination: { instanceID: d.instanceID, projectID: d.projectID },
    };
  } else invalid();
  const input = {
    raw: raw.raw,
    selection,
    idempotencyKey: raw.idempotencyKey,
    expectedRevision: raw.expectedRevision,
  };
  return {
    input,
    envelope,
    anchor:
      selection.mode === "append"
        ? selection.target
        : selection.authorityTarget,
  };
}

export class ContextImportService {
  /** Production wiring must supply T18's real removedTargetPort on this DB and
   * real trusted destination/host adapters. Noop guards are fixtures only.
   * Append requires context.write, not read: it never reads existing context.
   * Create requires manage + explicit empty delegation through T11, never
   * authority inferred from the package or new grants on the created session.
   */
  constructor(
    private readonly db: Persistence,
    private readonly identity: TrustedPrincipalPort,
    private readonly auth: Auth,
    private readonly host: ImportHostPort,
    private readonly destination: ImportDestinationPort,
    private readonly removed: RemovedTargetPort,
    private readonly now: () => number = Date.now,
  ) {}

  private stored(id: string): { plan: ImportPlan; effects: ImportEffects } {
    const row = this.db.transaction((sql) =>
      sql
        .query<{ plan_json: string; effects_json: string }, [string]>(
          "SELECT plan_json,effects_json FROM context_import_plans WHERE operation_id=?",
        )
        .get(id),
    );
    if (!row) throw new DomainError("unavailable", false, id);
    return {
      plan: JSON.parse(row.plan_json),
      effects: JSON.parse(row.effects_json),
    };
  }
  private save(id: string, effects: ImportEffects): void {
    this.db.transaction((sql) => {
      if (
        sql
          .query(
            "UPDATE context_import_plans SET effects_json=? WHERE operation_id=?",
          )
          .run(JSON.stringify(effects), id).changes !== 1
      )
        throw new DomainError("unavailable");
    });
  }
  async import(raw: ImportInput): Promise<ImportResult> {
    const { input, envelope, anchor } = normalize(raw);
    const principal = await this.identity.current();
    if (!principal) throw new DomainError("forbidden");
    const boundary = async <T>(
      p: Principal,
      t: SessionRef,
      r: number,
      id: string,
      phase: "intent" | "admission",
      local: () => T,
    ): Promise<T> => {
      const work = () =>
        this.db.transaction((sql) => {
          const plan: ImportPlan =
            phase === "intent"
              ? {
                  operationID: id,
                  selection: input.selection,
                  target:
                    input.selection.mode === "append"
                      ? input.selection.target
                      : {
                          version: 1,
                          ...input.selection.destination,
                          sessionID: `ses_${crypto.randomUUID().replaceAll("-", "")}`,
                        },
                  messages:
                    input.selection.mode === "append"
                      ? []
                      : envelope.payload.projection.messages.map((m) => ({
                          sourceID: m.id,
                          id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
                          role: m.role,
                          text: m.text,
                        })),
                }
              : this.stored(id).plan;
          if (plan.selection.mode === "create") {
            if (
              !this.destination ||
              typeof this.destination.check !== "function"
            )
              throw new DomainError("unavailable");
            const checked: unknown = this.destination.check(
              sql,
              plan,
              p,
              phase,
            );
            if (
              checked &&
              typeof (checked as { then?: unknown }).then === "function"
            )
              throw new DomainError("unavailable");
            if (
              typeof this.host.preflight !== "function" ||
              typeof this.host.importNewSession !== "function"
            )
              throw new DomainError("unsupported");
            const supported: unknown = this.host.preflight(plan);
            if (
              supported &&
              typeof (supported as { then?: unknown }).then === "function"
            )
              throw new DomainError("unavailable");
          }
          if (phase === "admission")
            this.removed.assertAvailable(sql, plan.target);
          const result = local();
          if (phase === "intent")
            sql.query("INSERT INTO context_import_plans VALUES (?,?,?)").run(
              id,
              JSON.stringify(plan),
              JSON.stringify({
                session: null,
                attachmentID: null,
                messageIDs: [],
                messageObservations: [],
                uncertain: [],
                failure: null,
              }),
            );
          if (phase === "admission" && plan.selection.mode === "append") {
            const content: ContextAttachmentContent = {
              version: 1,
              sha256: envelope.sha256,
              projection: envelope.payload.projection,
              loss: envelope.payload.loss,
            };
            const at = this.now();
            if (!Number.isSafeInteger(at) || at < 0)
              throw new DomainError("unavailable");
            sql
              .query(
                "INSERT INTO context_import_attachments VALUES (?,?,?,?,?,?,NULL)",
              )
              .run(
                id,
                canonical(plan.target),
                canonical(p),
                JSON.stringify(content),
                envelope.sha256,
                at,
              );
            const effects = { ...this.stored(id).effects, attachmentID: id };
            this.save(id, effects);
          }
          return result;
        });
      if (input.selection.mode === "create") {
        const result = await this.auth.delegatedOperation(
          p,
          t,
          [],
          r,
          id,
          phase,
          [],
          work,
        );
        if (result.state !== "admitted") throw new DomainError("forbidden");
        return result.data;
      }
      return phase === "intent"
        ? this.auth.authorizeIntent(p, t, "context.write", r, id, work)
        : this.auth.admitOperation(p, t, "context.write", r, id, work);
    };
    const ops = new Operations(
      this.db,
      {
        authorize: (p, t, c) => this.auth.authorize(p, t, c),
        authorizeReplay: (p, o) => this.auth.authorizeReplay(p, o),
        authorizeIntent: (p, t, _c, r, id, local) =>
          boundary(p, t, r, id, "intent", local),
        admitOperation: (p, t, _c, r, id, local) =>
          boundary(p, t, r, id, "admission", local),
      },
      this.now,
      this.removed,
    );
    const request = {
      principal,
      target: anchor,
      capability:
        input.selection.mode === "append"
          ? ("context.write" as const)
          : ("manage" as const),
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      payload: {
        action: "context.import",
        selection: input.selection,
        sha256: envelope.sha256,
      },
    };
    let operation = await ops.enqueue(request);
    if (operation.state === "pending") {
      try {
        const lease = ops.claim(
          operation.operationID,
          crypto.randomUUID(),
          30_000,
        );
        operation = await ops.dispatch(
          principal,
          lease,
          input.expectedRevision,
          async () => this.execute(this.stored(operation.operationID).plan),
        );
      } catch (e) {
        if (
          !(e instanceof DomainError) ||
          !["conflict", "unknown_outcome"].includes(e.code)
        )
          throw e;
        operation = await ops.enqueue(request);
      }
    }
    const effects = this.stored(operation.operationID).effects;
    return {
      modality:
        input.selection.mode === "append"
          ? "context_attachment"
          : "native_batch",
      operation,
      effects,
      error:
        operation.state === "unknown_outcome" ||
        operation.state === "dispatching"
          ? "unknown_outcome"
          : effects.failure,
    };
  }
  private async execute(
    plan: ImportPlan,
  ): Promise<import("../contracts").AdmissionEvidence> {
    let effects = this.stored(plan.operationID).effects;
    if (plan.selection.mode === "append") {
      if (effects.attachmentID !== plan.operationID)
        throw new DomainError("unavailable");
      return {
        state: "admitted",
        channel: "context_attachment",
        receiptID: effects.attachmentID,
      };
    }
    if (!this.host.importNewSession) throw new DomainError("unsupported");
    effects = {
      ...effects,
      uncertain: [plan.target.sessionID, ...plan.messages.map((m) => m.id)],
    };
    this.save(plan.operationID, effects);
    const receipt = await this.host.importNewSession(plan);
    if (receipt.state === "no_effect") {
      if (!["conflict", "not_found"].includes(receipt.code))
        return { state: "unknown_outcome" };
      this.save(plan.operationID, {
        ...effects,
        uncertain: [],
        failure: receipt.code,
      });
      return { state: "rejected" };
    }
    if (receipt.state !== "observed") return { state: "unknown_outcome" };
    const observation = receipt.value;
    if (observation.observedSession !== null) {
      const observed = parseSessionRef(observation.observedSession);
      effects = {
        ...effects,
        session: observed,
        uncertain: same(observed, plan.target)
          ? effects.uncertain.filter((id) => id !== plan.target.sessionID)
          : effects.uncertain,
      };
      this.save(plan.operationID, effects);
    }
    for (const message of observation.confirmedMessages) {
      const session = parseSessionRef(message.session);
      if (!text(message.messageID)) return { state: "unknown_outcome" };
      effects = {
        ...effects,
        messageIDs: [...effects.messageIDs, message.messageID],
        messageObservations: [
          ...effects.messageObservations,
          { session, messageID: message.messageID },
        ],
        uncertain: same(session, plan.target)
          ? effects.uncertain.filter((id) => id !== message.messageID)
          : effects.uncertain,
      };
      this.save(plan.operationID, effects);
    }
    if (
      !Array.isArray(observation.uncertainIDs) ||
      observation.uncertainIDs.some((id) => !text(id))
    )
      return { state: "unknown_outcome" };
    const confirmed = new Set(
      effects.messageObservations
        .filter((m) => same(m.session, plan.target))
        .map((m) => m.messageID),
    );
    const missing = plan.messages
      .filter((m) => !confirmed.has(m.id))
      .map((m) => m.id);
    effects = {
      ...effects,
      uncertain: [
        ...new Set([
          ...(effects.session && same(effects.session, plan.target)
            ? []
            : [plan.target.sessionID]),
          ...missing,
          ...observation.uncertainIDs,
        ]),
      ],
    };
    this.save(plan.operationID, effects);
    if (
      effects.uncertain.length ||
      effects.messageObservations.length !== plan.messages.length ||
      confirmed.size !== plan.messages.length
    )
      return { state: "unknown_outcome" };
    return {
      state: "admitted",
      channel: "host",
      receiptID: plan.target.sessionID,
    };
  }

  private async attachmentScope(
    target: SessionRef,
  ): Promise<{ target: SessionRef; principal: Principal }> {
    target = parseSessionRef(target);
    const principal = await this.identity.current();
    if (!principal) throw new DomainError("forbidden");
    await this.auth.authorizeReplay(principal, principal);
    await this.auth.authorize(principal, target, "context.read");
    await this.auth.authorize(principal, target, "read");
    return { target, principal };
  }
  /** Explicit tool-facing access only. Nothing injects attachments into execution
   * or claims to rewrite native history. Content is scoped to target AND owner.
   */
  async listAttachments(
    target: SessionRef,
  ): Promise<readonly ContextAttachmentInfo[]> {
    const scope = await this.attachmentScope(target);
    return this.db.transaction((sql) => {
      this.removed.assertAvailable(sql, scope.target);
      return sql
        .query<
          { operation_id: string; payload_hash: string; created_at: number },
          [string, string]
        >(
          "SELECT operation_id,payload_hash,created_at FROM context_import_attachments WHERE target_json=? AND owner_json=? AND content_json IS NOT NULL ORDER BY created_at,operation_id",
        )
        .all(canonical(scope.target), canonical(scope.principal))
        .map((row) => ({
          kind: "context_attachment" as const,
          attachmentID: row.operation_id,
          target: scope.target,
          sha256: row.payload_hash,
          createdAt: row.created_at,
        }));
    });
  }
  async getAttachment(
    target: SessionRef,
    attachmentID: string,
  ): Promise<ContextAttachment> {
    if (!text(attachmentID)) invalid();
    const scope = await this.attachmentScope(target);
    return this.db.transaction((sql) => {
      this.removed.assertAvailable(sql, scope.target);
      const row = sql
        .query<
          { content_json: string; payload_hash: string; created_at: number },
          [string, string, string]
        >(
          "SELECT content_json,payload_hash,created_at FROM context_import_attachments WHERE operation_id=? AND target_json=? AND owner_json=? AND content_json IS NOT NULL",
        )
        .get(attachmentID, canonical(scope.target), canonical(scope.principal));
      if (!row) throw new DomainError("not_found");
      return {
        kind: "context_attachment",
        attachmentID,
        target: scope.target,
        sha256: row.payload_hash,
        createdAt: row.created_at,
        content: JSON.parse(row.content_json),
      };
    });
  }
}
