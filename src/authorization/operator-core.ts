import type { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import { canonical, DomainError } from "../contracts";
import type { Persistence } from "../persistence/database";

/** Composed by the canonical DB owner; construction never installs schema. */
export const operatorCoreMigration = {
  name: "operator-core-v1",
  sql: `CREATE TABLE operator_credentials (
    credential_id TEXT PRIMARY KEY, operator_id TEXT NOT NULL, instance_id TEXT NOT NULL,
    revision INTEGER NOT NULL, digest TEXT NOT NULL, projects TEXT NOT NULL,
    expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE operator_challenges (
    challenge_id TEXT PRIMARY KEY, binding TEXT NOT NULL, credential_id TEXT NOT NULL,
    revision INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE operator_confirmations (
    confirmation_id TEXT PRIMARY KEY, intent_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE operator_ledger (
    namespace TEXT PRIMARY KEY, intent_hash TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL, result_json TEXT, expired INTEGER NOT NULL DEFAULT 0);`,
} as const;

export interface CredentialPrincipal {
  readonly credentialID: string;
  readonly operatorID: string;
  readonly instanceID: string;
  readonly revision: number;
}
export type OperatorTarget =
  | { kind: "group"; groupID: string }
  | {
      kind: "session";
      version: 1;
      instanceID: string;
      projectID: string;
      sessionID: string;
    };
export interface OperatorIntention {
  instanceID: string;
  projectID: string;
  operatorID: string;
  operation: string;
  target: OperatorTarget;
  body: unknown;
  expectedRevision?: number;
  confirmationID?: string;
}
export interface OperationDefinition {
  operation: string;
  capability: string;
  method: string;
  route: string;
  requiresConfirmation: boolean;
  target: "session" | "group";
  validateBody(body: unknown): unknown;
}
export interface OperationDefinitionPort {
  resolve(operation: string): OperationDefinition | undefined;
}
/** Trusted synchronous composition only: throw on denial; no host I/O. */
export interface OperatorAuthorizationPort {
  readOwn(
    sql: Database,
    principal: CredentialPrincipal,
    intention: OperatorIntention,
  ): void;
  newEffect(
    sql: Database,
    principal: CredentialPrincipal,
    intention: OperatorIntention,
    capability: string,
  ): void;
}
export interface Attempt {
  credentialID: string;
  bearer: string;
  projectID: string;
  method: string;
  route: string;
  operation: string;
  audience: { instanceID: string; epoch: string };
  timestamp: number;
  requestBodyHash: string;
}
export interface Challenge {
  challengeID: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}
interface CredentialRow {
  credential_id: string;
  operator_id: string;
  instance_id: string;
  revision: number;
  digest: string;
  projects: string;
  expires_at: number;
  revoked: number;
}
interface ChallengeRow {
  binding: string;
  revision: number;
  expires_at: number;
  consumed: number;
}
interface LedgerRow {
  intent_hash: string;
  operation_id: string;
  result_json: string | null;
  expired: number;
}
export interface OperatorCoreOptions {
  instanceID: string;
  epoch: string;
  clock(): number;
  generate(kind: "challenge" | "nonce" | "operation"): string;
  definitions: OperationDefinitionPort;
  authorization: OperatorAuthorizationPort;
  ttlMs?: number;
  skewMs?: number;
  pendingPerCredential?: number;
  pendingGlobal?: number;
}
export const operatorRetentionMs = 30 * 24 * 60 * 60 * 1000;
function deny(): never {
  throw new DomainError("forbidden");
}
function invalid(): never {
  throw new DomainError("invalid_input");
}
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 256;
export const operatorDigest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");
function sync<T>(fn: () => T): T {
  if (fn.constructor.name === "AsyncFunction") invalid();
  const value = fn();
  if (value && typeof (value as { then?: unknown }).then === "function") {
    void Promise.resolve(value).catch(() => {});
    invalid();
  }
  return value;
}

/** Grammar walk preserves duplicate-key evidence before JSON.parse discards it. */
export function parseOperatorJSON(raw: string): unknown {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 65536) invalid();
  let i = 0;
  const ws = () => {
    while (/[\x20\t\r\n]/.test(raw[i] ?? "x")) i++;
  };
  const string = (): string => {
    const start = i++;
    while (i < raw.length) {
      const c = raw[i++];
      if (c === '"') return JSON.parse(raw.slice(start, i));
      if (c === "\\") i++;
    }
    return invalid();
  };
  const value = (depth: number): void => {
    if (depth > 64) invalid();
    ws();
    const c = raw[i];
    if (c === '"') {
      string();
      return;
    }
    if (c === "{" || c === "[") {
      const object = c === "{";
      const end = object ? "}" : "]";
      const keys = new Set<string>();
      i++;
      ws();
      if (raw[i] === end) {
        i++;
        return;
      }
      while (i < raw.length) {
        if (object) {
          ws();
          if (raw[i] !== '"') invalid();
          const key = string();
          if (keys.has(key) || key === "__proto__") invalid();
          keys.add(key);
          ws();
          if (raw[i++] !== ":") invalid();
        }
        value(depth + 1);
        ws();
        if (raw[i] === end) {
          i++;
          return;
        }
        if (raw[i++] !== ",") invalid();
      }
      invalid();
    }
    const token =
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        raw.slice(i),
      );
    if (!token) invalid();
    i += token[0].length;
  };
  try {
    value(0);
    ws();
    if (i !== raw.length) invalid();
    const parsed: unknown = JSON.parse(raw);
    canonical(parsed);
    return parsed;
  } catch {
    return invalid();
  }
}
function record(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid();
  return value as Record<string, unknown>;
}
function fields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required = allowed,
): void {
  if (
    Object.keys(value).some((k) => !allowed.includes(k)) ||
    required.some((k) => !Object.hasOwn(value, k))
  )
    invalid();
}

/** Local admission, not a gateway or a credential/bootstrap API. */
export class OperatorCore {
  private readonly ttl: number;
  private readonly skew: number;
  private readonly perCredential: number;
  private readonly global: number;
  constructor(
    private readonly persistence: Persistence,
    private readonly options: OperatorCoreOptions,
  ) {
    const bounded = (value: number | undefined, max: number) => {
      const n = value ?? max;
      if (!Number.isSafeInteger(n) || n < 1 || n > max) invalid();
      return n;
    };
    this.ttl = bounded(options.ttlMs, 30000);
    this.skew = bounded(options.skewMs, 30000);
    this.perCredential = bounded(options.pendingPerCredential, 4);
    this.global = bounded(options.pendingGlobal, 128);
    if (
      !text(options.instanceID) ||
      !text(options.epoch) ||
      !options.authorization ||
      !options.definitions
    )
      invalid();
    for (const fn of [
      options.clock,
      options.generate,
      options.definitions.resolve,
      options.authorization.readOwn,
      options.authorization.newEffect,
    ]) {
      if (typeof fn !== "function" || fn.constructor.name === "AsyncFunction")
        invalid();
    }
  }
  private now(): number {
    const now = this.options.clock();
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now > Number.MAX_SAFE_INTEGER - 30000
    )
      deny();
    return now;
  }
  private generated(kind: "challenge" | "nonce" | "operation"): string {
    const value = this.options.generate(kind);
    if (!text(value)) deny();
    return value;
  }
  private authenticate(
    sql: Database,
    a: Attempt,
    now: number,
  ): CredentialPrincipal {
    const owner = sql
      .query<{ instance_id: string }, []>(
        "SELECT instance_id FROM ownership WHERE singleton=1",
      )
      .get();
    if (owner?.instance_id !== this.options.instanceID) deny();
    if (
      !a ||
      !text(a.credentialID) ||
      !text(a.bearer) ||
      !text(a.projectID) ||
      !text(a.method) ||
      !text(a.route) ||
      !text(a.operation)
    )
      deny();
    const row = sql
      .query<CredentialRow, [string]>(
        "SELECT * FROM operator_credentials WHERE credential_id=?",
      )
      .get(a.credentialID);
    const digest =
      row && /^[a-f0-9]{64}$/.test(row.digest) ? row.digest : "0".repeat(64);
    const equal = timingSafeEqual(
      Buffer.from(operatorDigest(a.bearer), "hex"),
      Buffer.from(digest, "hex"),
    );
    if (
      !equal ||
      !row ||
      row.revoked !== 0 ||
      !text(row.operator_id) ||
      !Number.isSafeInteger(row.expires_at) ||
      row.expires_at <= now ||
      row.instance_id !== this.options.instanceID ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1
    )
      deny();
    const projects: unknown = JSON.parse(row.projects);
    if (
      !Array.isArray(projects) ||
      !projects.every(text) ||
      !projects.includes(a.projectID)
    )
      deny();
    if (
      !a.audience ||
      canonical(a.audience) !==
        canonical({
          instanceID: this.options.instanceID,
          epoch: this.options.epoch,
        }) ||
      !Number.isSafeInteger(a.timestamp) ||
      Math.abs(a.timestamp - now) > this.skew ||
      !/^[a-f0-9]{64}$/.test(a.requestBodyHash)
    )
      deny();
    const definition = sync(() =>
      this.options.definitions.resolve(a.operation),
    );
    if (!definition) throw new DomainError("unsupported");
    if (definition.method !== a.method || definition.route !== a.route) deny();
    return {
      credentialID: row.credential_id,
      operatorID: row.operator_id,
      instanceID: row.instance_id,
      revision: row.revision,
    };
  }
  private binding(a: Attempt, c: Challenge): string {
    return canonical({
      credentialID: a.credentialID,
      projectID: a.projectID,
      method: a.method,
      route: a.route,
      operation: a.operation,
      audience: a.audience,
      timestamp: a.timestamp,
      requestBodyHash: a.requestBodyHash,
      ...c,
    });
  }
  issue(a: Attempt): Challenge {
    return this.persistence.transaction((sql) => {
      const now = this.now();
      const principal = this.authenticate(sql, a, now);
      const count = sql
        .query<{ total: number; own: number }, [number, string]>(
          "SELECT COUNT(*) AS total, COALESCE(SUM(credential_id=?2),0) AS own FROM operator_challenges WHERE consumed=0 AND expires_at>?1",
        )
        .get(now, a.credentialID);
      if (
        !count ||
        count.total >= this.global ||
        count.own >= this.perCredential
      )
        deny();
      const c = {
        challengeID: this.generated("challenge"),
        nonce: this.generated("nonce"),
        issuedAt: now,
        expiresAt: now + this.ttl,
      };
      sql
        .query("INSERT INTO operator_challenges VALUES (?,?,?,?,?,0)")
        .run(
          c.challengeID,
          this.binding(a, c),
          a.credentialID,
          principal.revision,
          c.expiresAt,
        );
      return c;
    });
  }
  private intention(
    raw: string,
    p: CredentialPrincipal,
    a: Attempt,
  ): {
    key: string;
    intention: OperatorIntention;
    definition: OperationDefinition;
  } {
    const envelope = record(parseOperatorJSON(raw));
    fields(envelope, ["key", "intention"]);
    if (!text(envelope.key)) invalid();
    const v = record(envelope.intention);
    fields(
      v,
      [
        "instanceID",
        "projectID",
        "operatorID",
        "operation",
        "target",
        "body",
        "expectedRevision",
        "confirmationID",
      ],
      ["instanceID", "projectID", "operatorID", "operation", "target", "body"],
    );
    if (
      v.instanceID !== p.instanceID ||
      v.operatorID !== p.operatorID ||
      v.projectID !== a.projectID ||
      v.operation !== a.operation
    )
      deny();
    if (
      Object.hasOwn(v, "expectedRevision") &&
      (!Number.isSafeInteger(v.expectedRevision) ||
        (v.expectedRevision as number) < 0)
    )
      invalid();
    if (Object.hasOwn(v, "confirmationID") && !text(v.confirmationID))
      invalid();
    const definition = sync(() =>
      this.options.definitions.resolve(a.operation),
    );
    if (
      !definition ||
      definition.operation !== a.operation ||
      !text(definition.capability)
    )
      throw new DomainError("unsupported");
    const target = record(v.target);
    if (definition.target === "session") {
      fields(target, [
        "kind",
        "version",
        "instanceID",
        "projectID",
        "sessionID",
      ]);
      if (
        target.kind !== "session" ||
        target.version !== 1 ||
        !text(target.sessionID) ||
        target.instanceID !== p.instanceID ||
        target.projectID !== a.projectID
      )
        invalid();
    } else {
      fields(target, ["kind", "groupID"]);
      if (target.kind !== "group" || !text(target.groupID)) invalid();
    }
    if (
      typeof definition.requiresConfirmation !== "boolean" ||
      !["session", "group"].includes(definition.target) ||
      definition.validateBody.constructor.name === "AsyncFunction"
    )
      invalid();
    const body = sync(() => definition.validateBody(v.body));
    canonical(body);
    return {
      key: envelope.key,
      intention: { ...v, body } as unknown as OperatorIntention,
      definition,
    };
  }
  admit(
    a: Attempt,
    challenge: Challenge,
    raw: string,
    local: (
      sql: Database,
      intention: OperatorIntention,
      operationID: string,
    ) => unknown,
  ): { operationID: string; result: unknown; expired: boolean } {
    if (
      typeof local !== "function" ||
      local.constructor.name === "AsyncFunction"
    )
      invalid();
    return this.persistence.transaction((sql) => {
      const now = this.now();
      const p = this.authenticate(sql, a, now);
      if (
        typeof raw !== "string" ||
        Buffer.byteLength(raw) > 65536 ||
        operatorDigest(raw) !== a.requestBodyHash ||
        !challenge ||
        !text(challenge.challengeID)
      )
        deny();
      const c = sql
        .query<ChallengeRow, [string]>(
          "SELECT * FROM operator_challenges WHERE challenge_id=?",
        )
        .get(challenge.challengeID);
      if (
        !c ||
        c.consumed ||
        c.expires_at <= now ||
        c.revision !== p.revision ||
        c.binding !== this.binding(a, challenge)
      )
        deny();
      const { key, intention, definition } = this.intention(raw, p, a);
      sync(() => this.options.authorization.readOwn(sql, p, intention));
      const namespace = canonical([
        p.instanceID,
        p.operatorID,
        a.projectID,
        key,
      ]);
      const hash = operatorDigest(canonical(intention));
      const prior = sql
        .query<LedgerRow, [string]>(
          "SELECT * FROM operator_ledger WHERE namespace=?",
        )
        .get(namespace);
      if (prior && prior.intent_hash !== hash)
        throw new DomainError("conflict");
      if (
        sql
          .query(
            "UPDATE operator_challenges SET consumed=1 WHERE challenge_id=? AND consumed=0",
          )
          .run(challenge.challengeID).changes !== 1
      )
        deny();
      if (prior)
        return {
          operationID: prior.operation_id,
          result:
            prior.result_json === null ? null : JSON.parse(prior.result_json),
          expired: prior.expired === 1,
        };
      sync(() =>
        this.options.authorization.newEffect(
          sql,
          p,
          intention,
          definition.capability,
        ),
      );
      if (definition.requiresConfirmation) {
        if (!intention.confirmationID) deny();
        const { confirmationID, ...business } = intention;
        if (
          sql
            .query(
              "UPDATE operator_confirmations SET consumed=1 WHERE confirmation_id=? AND intent_hash=? AND expires_at>? AND consumed=0",
            )
            .run(confirmationID, operatorDigest(canonical(business)), now)
            .changes !== 1
        )
          deny();
      }
      const operationID = this.generated("operation");
      // Local SQL hook only; never native/host dispatch inside this transaction.
      const result = sync(() => local(sql, intention, operationID));
      const json = canonical(result);
      sql
        .query("INSERT INTO operator_ledger VALUES (?,?,?,?,?,0)")
        .run(namespace, hash, operationID, now, json);
      return { operationID, result: JSON.parse(json), expired: false };
    });
  }
  /** Namespace/hash markers remain; full results survive at least thirty days. */
  expireResults(): number {
    return this.persistence.transaction(
      (sql) =>
        sql
          .query(
            "UPDATE operator_ledger SET expired=1,result_json=NULL WHERE expired=0 AND created_at<=?",
          )
          .run(this.now() - operatorRetentionMs).changes,
    );
  }
}
