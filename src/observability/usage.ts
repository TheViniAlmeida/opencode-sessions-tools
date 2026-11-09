import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { TrustedPrincipalPort } from "../authorization/authorize";
import {
  canonical,
  DomainError,
  type Principal,
  parseSessionRef,
  type SessionRef,
} from "../contracts";
import type { GroupRecord } from "../groups/service";
import type { RunnerUsagePort } from "../orchestration/runner";
import type { Migration, Persistence } from "../persistence/database";

export type Metric = {
  readonly value: number | null;
  readonly quality:
    | "reported"
    | "estimated"
    | "synthetic_import"
    | "mixed"
    | "unavailable";
};
const fields = [
  "cost",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "activeMs",
  "elapsedMs",
] as const;
export type Usage = Record<(typeof fields)[number], Metric>;
function invalid(): never {
  throw new DomainError("invalid_input");
}
function amount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    invalid();
  return value;
}
function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) invalid();
}
export function parseUsage(value: unknown): Usage {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  const result = {} as Usage;
  for (const field of fields) {
    if (!Object.hasOwn(input, field)) {
      result[field] = { value: null, quality: "unavailable" };
      continue;
    }
    const metric = input[field] as Metric;
    if (!metric || typeof metric !== "object") invalid();
    if (metric.value === null && metric.quality === "unavailable") {
      result[field] = { ...metric };
      continue;
    }
    if (
      !["reported", "estimated", "synthetic_import", "mixed"].includes(
        metric.quality,
      )
    )
      invalid();
    result[field] = { value: amount(metric.value), quality: metric.quality };
  }
  return result;
}
export function aggregateUsage(values: readonly Usage[]): Usage {
  const result = parseUsage({});
  for (const field of fields) {
    if (!values.length || values.some((value) => value[field].value === null))
      continue;
    const total = values.reduce(
      (sum, value) => sum + (value[field].value as number),
      0,
    );
    amount(total);
    const qualities = new Set(values.map((value) => value[field].quality));
    result[field] = {
      value: total,
      quality:
        qualities.size === 1
          ? (values[0]?.[field].quality ?? "unavailable")
          : "mixed",
    };
  }
  return result;
}

/** Integrator supplies version and applies explicitly, alongside groups and runner. */
export const USAGE_MIGRATION: Omit<Migration, "version"> = {
  apply(sql) {
    sql.exec(`CREATE TABLE usage_facts(session_ref TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE usage_budgets(group_id TEXT PRIMARY KEY REFERENCES groups_records(group_id) ON DELETE CASCADE, ceiling REAL, revision INTEGER NOT NULL);
    CREATE TABLE usage_reservations(admission_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, amount REAL NOT NULL);
    CREATE TABLE usage_budget_mutations(owner TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, PRIMARY KEY(owner,idempotency_key));
    CREATE TABLE usage_receipts(admission_id TEXT NOT NULL, evidence TEXT NOT NULL, PRIMARY KEY(admission_id,evidence));`);
  },
};

/** Trusted synchronous LOCAL composition only: fresh ACL for every group and member.
 * Must reject unauthorized scopes; group membership is never an authorization grant. */
export interface UsageAccessPort {
  check(
    sql: Database,
    principal: Principal,
    target: SessionRef,
    action: "read" | "manage",
  ): void;
}
/** Composition must verify canonical database identity before invoking the journal.
 * Events.appendInTransaction alone does not verify that identity. */
export interface UsageEventPort {
  appendInTx(
    sql: Database,
    event: {
      kind: "budget.changed";
      operationID: string;
      target: SessionRef;
      payload: { revision: number };
    },
    actor: Principal,
  ): void;
}

export interface UsageAdmissionEvidence {
  readonly groupID: string;
  readonly taskID: string;
  readonly admissionID: string;
  readonly principal: Readonly<Principal>;
}

/** Synchronous trusted local accessor, never a price supplied by session text.
 * A null estimate (or absent accessor at runtime) fails closed before execution. */
export interface RunnerUsageSource {
  estimateReservation(
    sql: Database,
    evidence: UsageAdmissionEvidence,
  ): number | null;
  /** Complete cumulative per-session snapshot, NOT a delta or a group aggregate.
   * Last accepted write replaces the prior view, never adds it. Corrections and
   * resets are allowed, including lower counters; the source must label provenance
   * on each metric. This port does not assert monotonic provider billing. */
  snapshot(
    sql: Database,
    evidence: Parameters<RunnerUsagePort["record"]>[1],
  ): { readonly session: SessionRef; readonly usage: unknown } | null;
}

/** Bind the event port to this persistence component, not merely an active SQL tx. */
export function canonicalUsageEvents(
  storage: Persistence,
  journal: UsageEventPort,
): UsageEventPort {
  return {
    appendInTx(sql, event, actor) {
      if (!sql.inTransaction) throw new DomainError("unavailable");
      storage.transaction((canonicalSQL) => {
        if (sql !== canonicalSQL) throw new DomainError("unavailable");
        journal.appendInTx(sql, event, actor);
      });
    },
  };
}
export class UsageService {
  constructor(
    private readonly storage: Persistence,
    private readonly identity: TrustedPrincipalPort,
    private readonly access: UsageAccessPort,
    private readonly events: UsageEventPort,
  ) {}

  private group(
    sql: Database,
    principal: Principal,
    groupID: string,
    action: "read" | "manage",
  ): GroupRecord {
    id(groupID);
    const row = sql
      .query<{ body: string }, [string]>(
        "SELECT body FROM groups_records WHERE group_id=?",
      )
      .get(groupID);
    if (!row) throw new DomainError("not_found");
    const group = JSON.parse(row.body) as GroupRecord;
    this.access.check(sql, principal, parseSessionRef(group.scope), action);
    if (
      principal.kind === "session" &&
      (group.owner.kind !== "session" ||
        canonical(group.owner.session) !== canonical(principal.session))
    )
      throw new DomainError("not_found");
    return group;
  }
  private snapshot(
    sql: Database,
    principal: Principal,
    groups: readonly string[],
  ): Usage {
    const members = new Map<string, SessionRef>();
    for (const groupID of groups) {
      this.group(sql, principal, groupID, "read");
      for (const row of sql
        .query<{ session_ref: string }, [string]>(
          "SELECT session_ref FROM groups_members WHERE group_id=?",
        )
        .all(groupID)) {
        const ref = parseSessionRef(JSON.parse(row.session_ref));
        this.access.check(sql, principal, ref, "read");
        members.set(canonical(ref), ref);
      }
    }
    return aggregateUsage(
      [...members.keys()].map((key) => {
        const row = sql
          .query<{ body: string }, [string]>(
            "SELECT body FROM usage_facts WHERE session_ref=?",
          )
          .get(key);
        return row ? parseUsage(JSON.parse(row.body)) : parseUsage({});
      }),
    );
  }
  async read(groupIDs: readonly string[]): Promise<Usage> {
    if (!Array.isArray(groupIDs)) invalid();
    const principal = await this.identity.current();
    if (!principal) throw new DomainError("forbidden");
    return this.storage.transaction((sql) =>
      this.snapshot(sql, principal, groupIDs),
    );
  }
  async changeBudget(
    groupID: string,
    ceiling: unknown,
    expectedRevision: number,
    idempotencyKey: string,
  ): Promise<number> {
    id(idempotencyKey);
    if (ceiling !== null) amount(ceiling);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      invalid();
    const principal = await this.identity.current();
    if (principal?.kind !== "operator") throw new DomainError("forbidden");
    return this.storage.transaction((sql) => {
      const group = this.group(sql, principal, groupID, "manage");
      // Stable authenticated owner scope excludes the principal's changing revision.
      const owner = canonical([principal.instanceID, principal.operatorID]);
      const hash = createHash("sha256")
        .update(canonical({ groupID, ceiling, expectedRevision }))
        .digest("hex");
      const replay = sql
        .query<{ payload_hash: string; revision: number }, [string, string]>(
          "SELECT payload_hash,revision FROM usage_budget_mutations WHERE owner=? AND idempotency_key=?",
        )
        .get(owner, idempotencyKey);
      if (replay) {
        if (replay.payload_hash !== hash) throw new DomainError("conflict");
        return replay.revision;
      }
      const previous = sql
        .query<{ revision: number }, [string]>(
          "SELECT revision FROM usage_budgets WHERE group_id=?",
        )
        .get(groupID);
      if ((previous?.revision ?? 0) !== expectedRevision)
        throw new DomainError("conflict");
      const revision = expectedRevision + 1;
      if (!Number.isSafeInteger(revision)) invalid();
      const operationID = crypto.randomUUID();
      sql
        .query(
          "INSERT INTO usage_budgets VALUES (?,?,?) ON CONFLICT(group_id) DO UPDATE SET ceiling=excluded.ceiling,revision=excluded.revision",
        )
        .run(groupID, ceiling as number | null, revision);
      this.events.appendInTx(
        sql,
        {
          kind: "budget.changed",
          operationID,
          target: group.scope,
          payload: { revision },
        },
        principal,
      );
      sql
        .query("INSERT INTO usage_budget_mutations VALUES (?,?,?,?,?)")
        .run(owner, idempotencyKey, hash, operationID, revision);
      return revision;
    });
  }
  /** Trusted runner admission callback, inside its canonical write transaction.
   * Local reservation only: running provider bills may exceed this amount.
   * Reservations survive missing/unknown outcomes until terminal accounting.
   * No blind refund: a missing intent or host receipt does not prove no billing.
   * No group FK deliberately: safe task/group cleanup cannot silently refund
   * admitted executions or be blocked by this accounting history. */
  reserveInTx(
    sql: Database,
    principal: Principal,
    groupID: string,
    admissionID: string,
    requested: unknown,
  ): void {
    if (!sql.inTransaction) throw new DomainError("unavailable");
    this.storage.transaction((canonicalSQL) => {
      if (canonicalSQL !== sql || !sql.inTransaction)
        throw new DomainError("unavailable");
      id(admissionID);
      const reserve = amount(requested);
      this.group(sql, principal, groupID, "manage");
      const existing = sql
        .query<{ group_id: string; amount: number }, [string]>(
          "SELECT group_id,amount FROM usage_reservations WHERE admission_id=?",
        )
        .get(admissionID);
      if (existing) {
        if (existing.group_id !== groupID || existing.amount !== reserve)
          throw new DomainError("conflict");
        return;
      }
      const budget = sql
        .query<{ ceiling: number | null }, [string]>(
          "SELECT ceiling FROM usage_budgets WHERE group_id=?",
        )
        .get(groupID);
      if (budget?.ceiling !== null && budget?.ceiling !== undefined) {
        const cost = this.snapshot(sql, principal, [groupID]).cost;
        if (cost.value === null) throw new DomainError("unavailable");
        const rows = sql
          .query<{ amount: number }, [string]>(
            "SELECT amount FROM usage_reservations WHERE group_id=?",
          )
          .all(groupID);
        const total = amount(
          rows.reduce((sum, row) => sum + amount(row.amount), cost.value) +
            reserve,
        );
        if (total > amount(budget.ceiling)) throw new DomainError("conflict");
      }
      sql
        .query("INSERT INTO usage_reservations VALUES (?,?,?)")
        .run(admissionID, groupID, reserve);
    });
  }
  /** Trusted per-session cumulative snapshot replacement, never a delta sum.
   * Corrections/resets may decrease counters and must retain metric provenance.
   * Not exposed as a session/tool mutation. */
  recordSnapshotInTx(sql: Database, session: SessionRef, usage: unknown): void {
    if (!sql.inTransaction) throw new DomainError("unavailable");
    this.storage.transaction((canonicalSQL) => {
      if (sql !== canonicalSQL || !sql.inTransaction)
        throw new DomainError("unavailable");
      sql
        .query(
          "INSERT INTO usage_facts VALUES (?,?) ON CONFLICT(session_ref) DO UPDATE SET body=excluded.body",
        )
        .run(canonical(parseSessionRef(session)), canonical(parseUsage(usage)));
    });
  }
  /** Adapter reads persisted T8-compatible snapshots locally; no host I/O in tx.
   * Null means no evidence: accounting fails and preserves runner's receipt. */
  runnerAdapter(source: RunnerUsageSource): RunnerUsagePort & {
    reserve(sql: Database, evidence: UsageAdmissionEvidence): void;
  } {
    return {
      reserve: (sql, evidence) => {
        if (!sql.inTransaction) throw new DomainError("unavailable");
        this.storage.transaction((canonicalSQL) => {
          if (
            sql !== canonicalSQL ||
            typeof source?.estimateReservation !== "function"
          )
            throw new DomainError("unavailable");
          const estimate = source.estimateReservation(sql, evidence);
          if (estimate === null) throw new DomainError("unavailable");
          this.reserveInTx(
            sql,
            evidence.principal,
            evidence.groupID,
            evidence.admissionID,
            estimate,
          );
        });
      },
      record: (sql, evidence) => {
        if (!sql.inTransaction) throw new DomainError("unavailable");
        return this.storage.transaction((canonicalSQL) => {
          if (sql !== canonicalSQL || !sql.inTransaction)
            throw new DomainError("unavailable");
          const key = canonical(evidence);
          if (
            sql
              .query(
                "SELECT 1 FROM usage_receipts WHERE admission_id=? AND evidence=?",
              )
              .get(evidence.outcome.admissionID, key)
          )
            return;
          const snapshot = source.snapshot(sql, evidence);
          if (!snapshot) throw new DomainError("unavailable");
          this.recordSnapshotInTx(sql, snapshot.session, snapshot.usage);
          sql
            .query("INSERT INTO usage_receipts VALUES (?,?)")
            .run(evidence.outcome.admissionID, key);
          if (
            ["completed", "failed", "cancelled"].includes(
              evidence.outcome.state,
            )
          )
            sql
              .query("DELETE FROM usage_reservations WHERE admission_id=?")
              .run(evidence.outcome.admissionID);
        });
      },
    };
  }
}
