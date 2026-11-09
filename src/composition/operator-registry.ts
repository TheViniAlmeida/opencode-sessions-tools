import type { Database } from "bun:sqlite";
import type { Profile } from "../authorization/authorize";
import type { LinkInput } from "../authorization/grants";
import type {
  CredentialPrincipal,
  OperationDefinition,
  OperationDefinitionPort,
  OperatorIntention,
} from "../authorization/operator-core";
import { operatorDigest } from "../authorization/operator-core";
import {
  canonical,
  DomainError,
  parseCapability,
  parseSessionRef,
} from "../contracts";
import type { QuestionResponse } from "../orchestration/requests";
import type { Migration, Persistence } from "../persistence/database";
import type { InvocationIdentity } from "./identity";

/** This module never migrates on its own; the canonical owner registers this descriptor
 * as v22 in compositionMigrations. */
export const OPERATOR_COMMANDS_MIGRATION: Omit<Migration, "version"> = {
  apply(sql) {
    sql.exec(`CREATE TABLE operator_commands (
      operation_id TEXT PRIMARY KEY REFERENCES operator_ledger(operation_id) DEFERRABLE INITIALLY DEFERRED,
      credential_id TEXT NOT NULL, credential_revision INTEGER NOT NULL,
      owner_json TEXT NOT NULL, intention_json TEXT NOT NULL, body_hash TEXT NOT NULL,
      confirmation_binding TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','dispatching','completed','failed','unknown')),
      error_code TEXT
    )`);
  },
};

export interface OperatorCommandBodies {
  "session.profile.set": { profile: Profile; expectedRevision: number };
  "session.model.set": {
    providerID: string;
    modelID: string;
    expectedRevision: number;
  };
  "session.grant.link": Omit<LinkInput, "target">;
  "group.budget.set": { ceiling: number | null; expectedRevision: number };
  "question.approval.respond": {
    requestID: string;
    response: QuestionResponse;
  };
}
export type OperatorCommandName = keyof OperatorCommandBodies;
export type OperatorCommand = {
  [K in OperatorCommandName]: { operation: K; body: OperatorCommandBodies[K] };
}[OperatorCommandName];
export interface OperatorCommandReceipt {
  operationID: string;
  state: "pending" | "dispatching" | "completed" | "failed" | "unknown";
  errorCode?: string;
}
/** Populated only by the verified core authorization callback in the SAME call/SQL scope.
 * consume must clear the latch; replay never manufactures admission authority. */
export interface TrustedAdmissionPrincipalPort {
  consume(sql: Database): CredentialPrincipal | null;
}
/** Active private gateway authentication, never reconstructed from command records. */
export interface OperatorExecutionAuthorityPort {
  current(): Promise<CredentialPrincipal | null>;
}
/** Required canonical authorization adapter. Security is independent of business handlers.
 * Resolve group scope canonically; check the exact capability, project, target and current
 * operator policy using T11, in this SQL transaction. No host I/O or permissive fallback. */
export interface OperatorCapabilityPort {
  revalidate(
    sql: Database,
    current: CredentialPrincipal,
    capability: string,
    intention: OperatorIntention,
  ): void;
}
export interface OperatorCommandContext {
  readonly operationID: string;
  readonly owner: CredentialPrincipal;
  readonly intention: OperatorIntention;
}
export type OperatorCommandHandlers = {
  [K in OperatorCommandName]?: {
    /** Local canonical policy/target revisions and request bindings. Throw on stale authority. */
    revalidate(
      sql: Database,
      context: OperatorCommandContext,
      body: OperatorCommandBodies[K],
    ): void;
    /** Called post-commit under InvocationIdentity. No host adapter means no handler. */
    execute(
      context: OperatorCommandContext,
      body: OperatorCommandBodies[K],
    ): Promise<void>;
  };
};
function invalid(): never {
  throw new DomainError("invalid_input");
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256)
    invalid();
  return value;
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    invalid();
  return value;
}
function session(value: unknown) {
  object(value, ["version", "instanceID", "projectID", "sessionID"]);
  return parseSessionRef(value);
}
function validateBody(operation: OperatorCommandName, input: unknown): unknown {
  switch (operation) {
    case "session.profile.set": {
      const b = object(input, ["profile", "expectedRevision"]);
      if (
        typeof b.profile !== "string" ||
        ![
          "observe",
          "collaborate",
          "manage",
          "supervised",
          "bounded-auto",
        ].includes(b.profile)
      )
        invalid();
      return {
        profile: b.profile,
        expectedRevision: revision(b.expectedRevision),
      };
    }
    case "session.model.set": {
      const b = object(input, ["providerID", "modelID", "expectedRevision"]);
      return {
        providerID: text(b.providerID),
        modelID: text(b.modelID),
        expectedRevision: revision(b.expectedRevision),
      };
    }
    case "group.budget.set": {
      const b = object(input, ["ceiling", "expectedRevision"]);
      if (
        b.ceiling !== null &&
        (typeof b.ceiling !== "number" ||
          !Number.isFinite(b.ceiling) ||
          b.ceiling < 0)
      )
        invalid();
      return {
        ceiling: b.ceiling,
        expectedRevision: revision(b.expectedRevision),
      };
    }
    case "session.grant.link": {
      const b = object(input, [
        "source",
        "capabilities",
        "expiresAt",
        "policyRevision",
        "grantRevision",
      ]);
      if (!Array.isArray(b.capabilities) || !b.capabilities.length) invalid();
      if (
        b.expiresAt !== null &&
        (typeof b.expiresAt !== "string" ||
          !Number.isFinite(Date.parse(b.expiresAt)))
      )
        invalid();
      return {
        source: session(b.source),
        capabilities: [...new Set(b.capabilities.map(parseCapability))].sort(),
        expiresAt: b.expiresAt,
        policyRevision: revision(b.policyRevision),
        grantRevision: revision(b.grantRevision),
      };
    }
    case "question.approval.respond": {
      const b = object(input, ["requestID", "response"]);
      const r = object(b.response, [
        "revision",
        "admissionID",
        "operationID",
        "correlationID",
        "taskGeneration",
        "target",
        "decision",
      ]);
      if (r.decision !== "once" && r.decision !== "deny") invalid();
      if (revision(r.taskGeneration) < 1) invalid();
      return {
        requestID: text(b.requestID),
        response: {
          revision: revision(r.revision),
          admissionID: text(r.admissionID),
          operationID: text(r.operationID),
          correlationID: text(r.correlationID),
          taskGeneration: r.taskGeneration,
          target: session(r.target),
          decision: r.decision,
        },
      };
    }
  }
}
const definitions: readonly OperationDefinition[] = (
  [
    [
      "session.profile.set",
      "/operator/session/profile",
      "session.configure",
      "session",
    ],
    [
      "session.model.set",
      "/operator/session/model",
      "session.configure",
      "session",
    ],
    ["session.grant.link", "/operator/grants/link", "manage", "session"],
    ["group.budget.set", "/operator/groups/budget", "manage", "group"],
    [
      "question.approval.respond",
      "/operator/questions/approve",
      "manage",
      "session",
    ],
  ] as const
).map(([operation, route, capability, target]) =>
  Object.freeze({
    operation,
    route,
    capability,
    target,
    method: "POST",
    requiresConfirmation: true,
    validateBody: (body: unknown) => validateBody(operation, body),
  }),
);
interface Row {
  operation_id: string;
  credential_id: string;
  credential_revision: number;
  owner_json: string;
  intention_json: string;
  body_hash: string;
  confirmation_binding: string;
  state: OperatorCommandReceipt["state"];
  error_code: string | null;
}
const receipt = (row: Row): OperatorCommandReceipt => ({
  operationID: row.operation_id,
  state: row.state,
  ...(row.error_code ? { errorCode: row.error_code } : {}),
});
function same(a: CredentialPrincipal, b: CredentialPrincipal): boolean {
  return canonical(a) === canonical(b);
}
function synchronous<T>(call: () => T): T {
  const result = call();
  if (result && typeof (result as { then?: unknown }).then === "function") {
    void Promise.resolve(result).catch(() => {});
    throw new DomainError("unavailable");
  }
  return result;
}

/** No listener, credentials, enrollment, background worker, or bootstrap authority. */
export class OperatorRegistry implements OperationDefinitionPort {
  constructor(
    private readonly storage: Persistence,
    private readonly identity: InvocationIdentity,
    private readonly admission: TrustedAdmissionPrincipalPort,
    private readonly authority: OperatorExecutionAuthorityPort,
    private readonly handlers: OperatorCommandHandlers,
    private readonly clock: () => number,
    private readonly capability: OperatorCapabilityPort,
  ) {}

  resolve(operation: string): OperationDefinition | undefined {
    return definitions.find((d) => d.operation === operation);
  }

  private credential(
    sql: Database,
    owner: CredentialPrincipal,
    intention: OperatorIntention,
  ): void {
    const row = sql
      .query<
        {
          operator_id: string;
          instance_id: string;
          revision: number;
          revoked: number;
          expires_at: number;
          projects: string;
        },
        [string]
      >(
        "SELECT operator_id,instance_id,revision,revoked,expires_at,projects FROM operator_credentials WHERE credential_id=?",
      )
      .get(owner.credentialID);
    const now = this.clock();
    if (
      !Number.isSafeInteger(now) ||
      !row ||
      row.revoked ||
      row.expires_at <= now ||
      row.operator_id !== owner.operatorID ||
      row.instance_id !== owner.instanceID ||
      row.revision !== owner.revision ||
      intention.operatorID !== owner.operatorID ||
      intention.instanceID !== owner.instanceID ||
      !JSON.parse(row.projects).includes(intention.projectID)
    )
      throw new DomainError("forbidden");
  }

  /** Pass directly to OperatorCore.admit. Pure local enqueue; never calls an async domain. */
  readonly enqueue = (
    sql: Database,
    input: OperatorIntention,
    operationID: string,
  ): OperatorCommandReceipt => {
    if (!sql.inTransaction) throw new DomainError("unavailable");
    const definition = this.resolve(input.operation);
    if (!definition) throw new DomainError("unsupported");
    const intention = { ...input, body: definition.validateBody(input.body) };
    if (!intention.confirmationID) throw new DomainError("forbidden");
    if (definition.target !== intention.target.kind) invalid();
    const body = intention.body as Record<string, unknown>;
    if (
      intention.expectedRevision !== undefined &&
      body.expectedRevision !== undefined &&
      intention.expectedRevision !== body.expectedRevision
    )
      invalid();
    if (intention.operation === "question.approval.respond") {
      const target = (body.response as QuestionResponse).target;
      const { kind: _kind, ...expected } = intention.target;
      if (canonical(target) !== canonical(expected)) invalid();
    }
    const owner = synchronous(() => this.admission.consume(sql));
    if (!owner) throw new DomainError("forbidden");
    this.credential(sql, owner, intention);
    const { confirmationID, ...business } = intention;
    sql
      .query(
        "INSERT INTO operator_commands(operation_id,credential_id,credential_revision,owner_json,intention_json,body_hash,confirmation_binding,state) VALUES (?,?,?,?,?,?,?,'pending')",
      )
      .run(
        operationID,
        owner.credentialID,
        owner.revision,
        canonical(owner),
        canonical(intention),
        operatorDigest(canonical(intention.body)),
        operatorDigest(canonical({ confirmationID, business })),
      );
    return { operationID, state: "pending" };
  };

  /** Explicit same-invocation dispatch. Replays do not repeat dispatching/ambiguous effects. */
  async execute(operationID: string): Promise<OperatorCommandReceipt> {
    text(operationID);
    const current = await this.authority.current();
    if (!current) throw new DomainError("unavailable");
    return this.identity.runWithAuthenticatedOperator(async (principal) => {
      if (
        principal.operatorID !== current.operatorID ||
        principal.instanceID !== current.instanceID ||
        principal.revision !== current.revision
      )
        throw new DomainError("forbidden");
      const dispatch = this.storage.transaction((sql) => {
        const row = sql
          .query<Row, [string]>(
            "SELECT * FROM operator_commands WHERE operation_id=?",
          )
          .get(operationID);
        if (!row) throw new DomainError("not_found");
        const owner: CredentialPrincipal = JSON.parse(row.owner_json);
        const intention: OperatorIntention = JSON.parse(row.intention_json);
        if (
          !same(current, owner) ||
          row.credential_id !== owner.credentialID ||
          row.credential_revision !== owner.revision
        )
          throw new DomainError("forbidden");
        this.credential(sql, owner, intention);
        const definition = this.resolve(intention.operation);
        if (!definition || definition.target !== intention.target.kind)
          throw new DomainError("forbidden");
        const body = definition.validateBody(intention.body);
        const { confirmationID, ...business } = intention;
        if (
          !confirmationID ||
          row.body_hash !== operatorDigest(canonical(body)) ||
          row.confirmation_binding !==
            operatorDigest(canonical({ confirmationID, business }))
        )
          throw new DomainError("forbidden");
        if (
          !this.capability ||
          typeof this.capability.revalidate !== "function" ||
          this.capability.revalidate.constructor.name === "AsyncFunction"
        )
          throw new DomainError("unavailable");
        synchronous(() =>
          this.capability.revalidate(
            sql,
            current,
            definition.capability,
            intention,
          ),
        );
        if (row.state !== "pending") return { row };
        // A mapped union is narrowed by its operation at admission; handlers are trusted composition, not payload.
        const handler = this.handlers[
          intention.operation as OperatorCommandName
        ] as
          | {
              revalidate(
                sql: Database,
                context: OperatorCommandContext,
                body: unknown,
              ): void;
              execute(
                context: OperatorCommandContext,
                body: unknown,
              ): Promise<void>;
            }
          | undefined;
        if (!handler) throw new DomainError("unsupported");
        if (handler.revalidate.constructor.name === "AsyncFunction")
          throw new DomainError("unavailable");
        const context = { operationID, owner, intention };
        synchronous(() => handler.revalidate(sql, context, body));
        sql
          .query(
            "UPDATE operator_commands SET state='dispatching' WHERE operation_id=? AND state='pending'",
          )
          .run(operationID);
        return { row, handler, context, body };
      });
      if (!dispatch.handler) return receipt(dispatch.row);
      try {
        await dispatch.handler.execute(dispatch.context, dispatch.body);
      } catch (error) {
        // Domain errors carry only stable codes; messages/stacks and untrusted codes never cross this boundary.
        const codes = [
          "invalid_input",
          "forbidden",
          "not_found",
          "conflict",
          "unsupported",
        ];
        const code =
          error instanceof DomainError && codes.includes(error.code)
            ? error.code
            : "unavailable";
        const state = code === "unavailable" ? "unknown" : "failed";
        this.storage.transaction((sql) =>
          sql
            .query(
              "UPDATE operator_commands SET state=?,error_code=? WHERE operation_id=?",
            )
            .run(state, code, operationID),
        );
        return { operationID, state, errorCode: code };
      }
      this.storage.transaction((sql) =>
        sql
          .query(
            "UPDATE operator_commands SET state='completed' WHERE operation_id=?",
          )
          .run(operationID),
      );
      return { operationID, state: "completed" };
    });
  }
}
