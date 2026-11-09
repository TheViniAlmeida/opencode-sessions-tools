import type { Database } from "bun:sqlite";
import type {
  Authorizer,
  TrustedPrincipalPort,
} from "../authorization/authorize";
import {
  type Capability,
  DomainError,
  type Principal,
  parseCapability,
  parseSessionRef,
  type SessionRef,
} from "../contracts";
import type { Persistence } from "../persistence/database";
import {
  type Operation,
  Operations,
  type RemovedTargetPort,
} from "../persistence/operations";

/** Domain data only. T13 owns delivery state, owner, leases, audit and outbox. */
export const creationMigration = {
  name: "session-creation-v2",
  sql: `CREATE TABLE session_creation_plans (
    operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id),
    plan_json TEXT NOT NULL, observed_json TEXT, linked INTEGER NOT NULL DEFAULT 0
  );`,
} as const;

export interface CreationInput {
  readonly source: SessionRef;
  readonly destination: {
    readonly instanceID: string;
    readonly projectID: string;
  };
  readonly kind: "root" | "child" | "fork";
  readonly capabilities: readonly Capability[];
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
}
export interface CreationPlan {
  readonly operationID: string;
  readonly source: SessionRef;
  readonly destination: CreationInput["destination"];
  readonly kind: CreationInput["kind"];
  /** Native create accepts caller IDs; native fork assigns its own ID. */
  readonly planned: SessionRef | null;
  readonly parent: SessionRef | null;
  readonly capabilities: readonly Capability[];
  readonly authorizationRevision: number;
}
export interface CreationResult {
  readonly state: "delivery" | "awaiting_approval";
  readonly operation: Operation | null;
  readonly session: SessionRef | null;
  /** Local lineage/delegation recording, not execution or delivery state. */
  readonly linked: boolean;
}
export type CreationReceipt =
  | { readonly state: "created"; readonly session: SessionRef }
  /** Only an adapter's explicit pre-effect proof permits a definite rejection.
   * A thrown error, including DomainError(unavailable), remains uncertain. */
  | { readonly state: "pre_effect_unavailable" };
export interface CreationHostPort {
  /** Trusted IDs only. Fork must not copy plugin grants/jobs/approvals.
   * Root/child must honor planned ID; fork must return its actual native ID. */
  execute(plan: CreationPlan): Promise<CreationReceipt>;
  /** Verify source/lineage and operation correlation, not just ID existence.
   * Prefer known observed ID. Lost fork receipt with no ID requires adapter
   * correlation; absent unique proof return null. Never infer success from a
   * similar title, and never retry creation. T31 supplies the real adapter. */
  inspect(
    plan: CreationPlan & { readonly observed: SessionRef | null },
  ): Promise<SessionRef | null>;
}
export interface CreationRecordsPort {
  /** Trusted local routing registry, called only after authorization. */
  location(scope: { instanceID: string; projectID: string }): string;
  /** Operator-preapproved scope must bind operationID, source, destination,
   * kind and exact capabilities, issuer and expiry. consume=false is read-only;
   * consume=true consumes once in T11/T13's SAME admission transaction. */
  crossProjectApproval(
    sql: Database,
    plan: CreationPlan,
    principal: Principal,
    now: number,
    consume: boolean,
  ): boolean;
  /** Same-DB synchronous, idempotent lineage/explicit link + approved new grants.
   * Validate authorizationRevision against trusted local policy before issuing
   * grants; do not revive revoked delegation during delayed recovery.
   * Do not inherit source ACL/jobs/approvals. No host I/O. */
  record(
    sql: Database,
    plan: CreationPlan,
    observed: SessionRef,
    principal: Principal,
  ): void;
}
interface PlanRow {
  plan_json: string;
  observed_json: string | null;
  linked: number;
}
interface OwnedRow {
  operation_id: string;
  owner_json: string;
  state: Operation["state"];
  payload_hash: string;
  receipt_id: string | null;
  channel: Operation["channel"];
}
class AwaitingApproval extends DomainError {
  constructor() {
    super("forbidden");
  }
}
const cross = (plan: CreationPlan) =>
  plan.source.instanceID !== plan.destination.instanceID ||
  plan.source.projectID !== plan.destination.projectID;
const same = (a: SessionRef, b: SessionRef) =>
  a.instanceID === b.instanceID &&
  a.projectID === b.projectID &&
  a.sessionID === b.sessionID;

function normalize(input: CreationInput): CreationInput {
  if (
    !input ||
    Object.keys(input).some(
      (k) =>
        ![
          "source",
          "destination",
          "kind",
          "capabilities",
          "idempotencyKey",
          "expectedRevision",
        ].includes(k),
    ) ||
    !["root", "child", "fork"].includes(input.kind) ||
    !Array.isArray(input.capabilities) ||
    typeof input.idempotencyKey !== "string" ||
    !input.idempotencyKey.trim() ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    !input.destination ||
    Object.keys(input.destination).some(
      (k) => !["instanceID", "projectID"].includes(k),
    )
  )
    throw new DomainError("invalid_input");
  const source = parseSessionRef(input.source);
  const destination = parseSessionRef({
    version: 1,
    ...input.destination,
    sessionID: "validation",
  });
  return {
    source,
    destination: {
      instanceID: destination.instanceID,
      projectID: destination.projectID,
    },
    kind: input.kind,
    capabilities: [...new Set(input.capabilities.map(parseCapability))].sort(),
    idempotencyKey: input.idempotencyKey,
    expectedRevision: input.expectedRevision,
  };
}

export class CreationService {
  constructor(
    private readonly db: Persistence,
    private readonly identity: TrustedPrincipalPort,
    private readonly authorization: Pick<
      Authorizer,
      "delegatedOperation" | "authorize" | "authorizeReplay"
    >,
    private readonly host: CreationHostPort,
    private readonly records: CreationRecordsPort,
    private readonly removed: RemovedTargetPort,
    private readonly now: () => number,
  ) {}

  private operations(input: CreationInput): Operations {
    const boundary = async <T>(
      principal: Principal,
      target: SessionRef,
      _capability: Capability,
      revision: number,
      operationID: string,
      phase: "intent" | "admission",
      local: () => T,
    ): Promise<T> => {
      const result = await this.authorization.delegatedOperation(
        principal,
        target,
        input.capabilities,
        revision,
        operationID,
        phase,
        input.kind === "fork" ? ["read"] : [],
        () =>
          this.db.transaction((sql) => {
            if (phase === "intent") {
              // Authorizer has checked manage/delegation/read before routing lookup.
              const a = this.records.location(input.source);
              const b = this.records.location(input.destination);
              if (!a || !b) throw new DomainError("unavailable");
              const plan: CreationPlan = {
                operationID,
                source: input.source,
                destination: input.destination,
                kind: input.kind,
                capabilities: input.capabilities,
                authorizationRevision: input.expectedRevision,
                planned:
                  input.kind === "fork"
                    ? null
                    : {
                        version: 1,
                        ...input.destination,
                        sessionID: `ses_${crypto.randomUUID().replaceAll("-", "")}`,
                      },
                parent:
                  input.kind === "child" &&
                  input.source.instanceID === input.destination.instanceID &&
                  input.source.projectID === input.destination.projectID &&
                  a === b
                    ? input.source
                    : null,
              };
              // T13 must insert the referenced operation in this same transaction.
              const data = local();
              sql
                .query(
                  "INSERT INTO session_creation_plans(operation_id,plan_json) VALUES (?,?)",
                )
                .run(operationID, JSON.stringify(plan));
              return data;
            }
            const plan = this.plan(operationID).plan;
            // A queued approval must not make a stale cross-location parent safe.
            const sourceLocation = this.records.location(plan.source);
            const destinationLocation = this.records.location(plan.destination);
            if (!sourceLocation || !destinationLocation)
              throw new DomainError("unavailable");
            const nativeParent =
              plan.kind === "child" &&
              !cross(plan) &&
              sourceLocation === destinationLocation;
            if (nativeParent !== (plan.parent !== null))
              throw new DomainError("conflict");
            if (
              cross(plan) &&
              !this.records.crossProjectApproval(
                sql,
                plan,
                principal,
                this.now(),
                true,
              )
            )
              throw new AwaitingApproval();
            return local();
          }),
      );
      if (result.state === "awaiting_approval") throw new AwaitingApproval();
      return result.data;
    };
    return new Operations(
      this.db,
      {
        authorize: (p, t, c) => this.authorization.authorize(p, t, c),
        authorizeReplay: (p, owner) =>
          this.authorization.authorizeReplay(p, owner),
        authorizeIntent: (p, t, c, r, id, local) =>
          boundary(p, t, c, r, id, "intent", local),
        admitOperation: (p, t, c, r, id, local) =>
          boundary(p, t, c, r, id, "admission", local),
      },
      this.now,
      this.removed,
    );
  }

  async create(raw: CreationInput): Promise<CreationResult> {
    const input = normalize(raw);
    const principal = await this.identity.current();
    if (!principal) throw new DomainError("forbidden");
    const ops = this.operations(input);
    const request = {
      principal,
      target: input.source,
      capability: "manage" as const,
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      payload: {
        action: "session.create",
        kind: input.kind,
        destination: input.destination,
        capabilities: input.capabilities,
      },
    };
    let operation: Operation;
    try {
      operation = await ops.enqueue(request);
    } catch (error) {
      if (error instanceof AwaitingApproval)
        return {
          state: "awaiting_approval",
          operation: null,
          session: null,
          linked: false,
        };
      throw error;
    }
    if (operation.state !== "pending") return this.result(operation);
    const { plan } = this.plan(operation.operationID);
    // No lease is acquired while an operator approval is absent/expired.
    if (
      cross(plan) &&
      !this.db.transaction((sql) =>
        this.records.crossProjectApproval(
          sql,
          plan,
          principal,
          this.now(),
          false,
        ),
      )
    )
      return this.result(operation, "awaiting_approval");
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
        async () => {
          const receipt = await this.host.execute(plan);
          if (receipt.state === "pre_effect_unavailable")
            return { state: "rejected" };
          const observed = this.validateObserved(plan, receipt.session);
          this.observe(plan, observed);
          return {
            state: "admitted",
            channel: "host",
            receiptID: observed.sessionID,
          };
        },
      );
    } catch (error) {
      // T13 replay checks the PERSISTED owner and returns actual in-flight state.
      if (error instanceof AwaitingApproval)
        return this.result(await ops.enqueue(request), "awaiting_approval");
      if (error instanceof DomainError && error.code === "conflict")
        return this.result(await ops.enqueue(request));
      throw error;
    }
    if (operation.state === "admitted") this.tryRecord(plan, principal);
    return this.result(operation);
  }

  /** Read-only host recovery; never enqueue/dispatch/claim/retry a creation.
   * Expired dispatching leases are transitioned by T13's recovery worker, not by
   * this domain service. A still-dispatching operation remains dispatching. */
  async recover(operationID: string): Promise<CreationResult> {
    const principal = await this.identity.current();
    if (!principal) throw new DomainError("forbidden");
    const row = this.db.transaction((sql) =>
      sql
        .query<OwnedRow, [string]>(
          "SELECT operation_id,owner_json,state,payload_hash,receipt_id,channel FROM operations WHERE operation_id=?",
        )
        .get(operationID),
    );
    if (!row) throw new DomainError("not_found");
    await this.authorization.authorizeReplay(
      principal,
      JSON.parse(row.owner_json) as Principal,
    );
    let operation: Operation = {
      operationID,
      state: row.state,
      payloadHash: row.payload_hash,
      receiptID: row.receipt_id,
      channel: row.channel,
    };
    const { plan, observed } = this.plan(operationID);
    if (operation.state === "unknown_outcome") {
      const input: CreationInput = {
        source: plan.source,
        destination: plan.destination,
        kind: plan.kind,
        capabilities: plan.capabilities,
        expectedRevision: 0,
        idempotencyKey: "reconciliation-only",
      };
      operation = await this.operations(input).reconcile(
        principal,
        operationID,
        {
          inspect: async () => {
            const found = await this.host.inspect({ ...plan, observed });
            if (!found)
              return {
                operationID,
                payloadHash: operation.payloadHash,
                evidence: { state: "unknown_outcome" },
              };
            const verified = this.validateObserved(plan, found);
            this.observe(plan, verified);
            return {
              operationID,
              payloadHash: operation.payloadHash,
              evidence: {
                state: "admitted",
                channel: "host",
                receiptID: verified.sessionID,
              },
            };
          },
        },
      );
    }
    if (operation.state === "admitted") this.tryRecord(plan, principal);
    return this.result(operation);
  }

  private plan(operationID: string): {
    plan: CreationPlan;
    observed: SessionRef | null;
    linked: boolean;
  } {
    const row = this.db.transaction((sql) =>
      sql
        .query<PlanRow, [string]>(
          "SELECT plan_json,observed_json,linked FROM session_creation_plans WHERE operation_id=?",
        )
        .get(operationID),
    );
    if (!row) throw new DomainError("unavailable", false, operationID);
    return {
      plan: JSON.parse(row.plan_json) as CreationPlan,
      observed: row.observed_json
        ? parseSessionRef(JSON.parse(row.observed_json))
        : null,
      linked: row.linked === 1,
    };
  }
  private validateObserved(plan: CreationPlan, value: SessionRef): SessionRef {
    const observed = parseSessionRef(value);
    if (
      observed.instanceID !== plan.destination.instanceID ||
      observed.projectID !== plan.destination.projectID ||
      (plan.planned && !same(plan.planned, observed)) ||
      same(plan.source, observed)
    )
      throw new DomainError("unknown_outcome", false, plan.operationID);
    return observed;
  }
  private observe(plan: CreationPlan, observed: SessionRef): void {
    this.db.transaction((sql) => {
      const previous = this.plan(plan.operationID).observed;
      if (previous && !same(previous, observed))
        throw new DomainError("conflict");
      sql
        .query(
          "UPDATE session_creation_plans SET observed_json=? WHERE operation_id=?",
        )
        .run(JSON.stringify(observed), plan.operationID);
    });
  }
  private tryRecord(plan: CreationPlan, principal: Principal): void {
    try {
      this.db.transaction((sql) => {
        const stored = this.plan(plan.operationID);
        if (stored.linked || !stored.observed) return;
        this.records.record(sql, plan, stored.observed, principal);
        sql
          .query(
            "UPDATE session_creation_plans SET linked=1 WHERE operation_id=?",
          )
          .run(plan.operationID);
      });
    } catch {
      /* Keep admitted delivery + observed ID; local recording is recoverable. */
    }
  }
  private result(
    operation: Operation,
    state: CreationResult["state"] = "delivery",
  ): CreationResult {
    const stored = this.plan(operation.operationID);
    return {
      state,
      operation,
      session: stored.observed,
      linked: stored.linked,
    };
  }
}
