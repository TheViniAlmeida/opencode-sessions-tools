import type { Database } from "bun:sqlite";
import { canonical, DomainError, type Principal } from "../contracts";
import type { Dispatcher, PromptInput } from "../messaging/dispatcher";
import type { Migration } from "../persistence/database";
import {
  type RunnerTaskContext,
  type TaskGraph,
  type TaskRecord,
  type Tasks,
  validateTaskGraph,
} from "./tasks";

export type TaskAdmissionDecision =
  | { ready: true }
  | {
      ready: false;
      reason: "state" | "dependencies" | "concurrency_limit" | "depth_limit";
    };

/** Evaluate only the canonical graph supplied inside Tasks' CAS transaction.
 * A ready decision outside that transaction is not an admission capability. */
export function decideTaskAdmission(
  tasks: readonly TaskRecord[],
  taskID: string,
): TaskAdmissionDecision {
  validateTaskGraph(tasks);
  const graph = new Map(tasks.map((task) => [task.taskID, task]));
  const task = graph.get(taskID);
  if (!task) throw new DomainError("not_found");
  if (task.state !== "pending") return { ready: false, reason: "state" };
  const depths = new Map<string, number>();
  const depth = (id: string): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    const entry = graph.get(id);
    if (!entry) throw new DomainError("conflict");
    const value = 1 + Math.max(0, ...entry.dependencies.map(depth));
    depths.set(id, value);
    return value;
  };
  if (depth(taskID) > 4) return { ready: false, reason: "depth_limit" };
  if (task.dependencies.some((id) => graph.get(id)?.state !== "completed"))
    return { ready: false, reason: "dependencies" };
  if (
    tasks.filter((entry) =>
      [
        "running",
        "awaiting_input",
        "awaiting_approval",
        "cancel_requested",
      ].includes(entry.state),
    ).length >= 4
  )
    return { ready: false, reason: "concurrency_limit" };
  return { ready: true };
}

/** Only a trusted host outcome/reply adapter may supply these values. Native
 * prompt acceptance or idle events are deliberately not completion evidence. */
export interface TaskOutcome {
  readonly admissionID: string;
  readonly operationID: string;
  readonly correlationID: string;
  readonly taskGeneration: number;
  readonly state:
    | "completed"
    | "failed"
    | "cancelled"
    | "awaiting_input"
    | "awaiting_approval"
    | "running";
  readonly evidence: string;
}

export function parseTaskOutcome(value: unknown): TaskOutcome {
  if (!value || typeof value !== "object")
    throw new DomainError("invalid_input");
  const outcome = value as Record<string, unknown>;
  if (
    (outcome.state !== "completed" &&
      outcome.state !== "failed" &&
      outcome.state !== "cancelled" &&
      outcome.state !== "awaiting_input" &&
      outcome.state !== "awaiting_approval" &&
      outcome.state !== "running") ||
    typeof outcome.admissionID !== "string" ||
    !outcome.admissionID.trim() ||
    typeof outcome.correlationID !== "string" ||
    !outcome.correlationID.trim() ||
    !Number.isSafeInteger(outcome.taskGeneration) ||
    (outcome.taskGeneration as number) < 1 ||
    typeof outcome.operationID !== "string" ||
    !outcome.operationID.trim() ||
    typeof outcome.evidence !== "string" ||
    !outcome.evidence.trim()
  )
    throw new DomainError("invalid_input");
  return {
    admissionID: outcome.admissionID,
    correlationID: outcome.correlationID,
    taskGeneration: outcome.taskGeneration as number,
    operationID: outcome.operationID,
    state: outcome.state as TaskOutcome["state"],
    evidence: outcome.evidence,
  };
}

export interface TaskOutcomePort {
  inspect(operationID: string): Promise<TaskOutcome | null>;
}

export interface RunnerAdmissionEvidence {
  readonly admissionID: string;
  readonly owner: Principal;
  readonly groupID: string;
  readonly taskID: string;
  readonly operationID: string | null;
  readonly correlationID: string;
  readonly taskGeneration: number;
  readonly kind: "execution" | "cancellation";
}
export interface RunnerAdmissionEvidencePort {
  lookup(
    sql: Database,
    groupID: string,
    taskID: string,
    principal: Principal,
    purpose: "journal" | "accounting",
  ): Readonly<RunnerAdmissionEvidence> | null;
}

/** Tasks owns fresh-principal/scope authorization, persisted-owner validation and
 * transaction entry. Accounting never consumes another execution approval. */
export interface TaskAdmissionPort extends Pick<Tasks, "runnerTransition"> {
  runnerJournal<T>(
    groupID: string,
    taskID: string,
    expectedGraphRevision: number,
    callback: (sql: Database, context: RunnerTaskContext) => T,
  ): Promise<T>;
  runnerAccount<T>(
    groupID: string,
    taskID: string,
    expectedGraphRevision: number,
    callback: (sql: Database, context: RunnerTaskContext) => T,
  ): Promise<{ graph: TaskGraph; value: T }>;
}

export const RUNNER_MIGRATION: Omit<Migration, "version"> = {
  apply(sql) {
    sql.exec(`CREATE TABLE runner_intents (
      admission_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task_records(task_id) ON DELETE CASCADE,
      group_id TEXT NOT NULL, owner_json TEXT NOT NULL,
      correlation_id TEXT NOT NULL UNIQUE, task_generation INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('execution','cancellation')),
      prompt_json TEXT NOT NULL, operation_id TEXT UNIQUE,
      lease_owner TEXT, lease_generation INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER NOT NULL DEFAULT 0,
      cancel_dispatch TEXT NOT NULL DEFAULT 'pending' CHECK(cancel_dispatch IN ('pending','dispatching','accepted','unknown_outcome'))
      , UNIQUE(task_id,task_generation,kind)
    );
    CREATE TABLE runner_outcomes(receipt_sequence INTEGER PRIMARY KEY AUTOINCREMENT, admission_id TEXT NOT NULL REFERENCES runner_intents(admission_id) ON DELETE CASCADE, body TEXT NOT NULL);
    CREATE INDEX runner_outcomes_admission ON runner_outcomes(admission_id,receipt_sequence);`);
  },
};

interface IntentRow {
  admission_id: string;
  task_id: string;
  group_id: string;
  owner_json: string;
  correlation_id: string;
  task_generation: number;
  kind: "execution" | "cancellation";
  prompt_json: string;
  operation_id: string | null;
  lease_owner: string | null;
  lease_generation: number;
  lease_until: number;
  cancel_dispatch: "pending" | "dispatching" | "accepted" | "unknown_outcome";
}
function intent(sql: Database, groupID: string, taskID: string): IntentRow {
  const row = sql
    .query<IntentRow, [string, string]>(
      "SELECT * FROM runner_intents WHERE group_id=? AND task_id=? ORDER BY task_generation DESC,kind ASC LIMIT 1",
    )
    .get(groupID, taskID);
  if (!row) throw new DomainError("not_found");
  return row;
}

export const runnerAdmissionEvidence: RunnerAdmissionEvidencePort = {
  lookup(sql, groupID, taskID, principal, purpose) {
    if (purpose !== "journal" && purpose !== "accounting")
      throw new DomainError("invalid_input");
    const row = sql
      .query<IntentRow, [string, string]>(
        purpose === "journal"
          ? "SELECT * FROM runner_intents WHERE group_id=? AND task_id=? ORDER BY task_generation DESC,kind ASC LIMIT 1"
          : `SELECT i.* FROM runner_intents i JOIN runner_outcomes o ON o.admission_id=i.admission_id
             WHERE i.group_id=? AND i.task_id=?
             AND i.task_generation=(SELECT MAX(task_generation) FROM runner_intents WHERE task_id=i.task_id)
             AND o.receipt_sequence=(SELECT MAX(receipt_sequence) FROM runner_outcomes WHERE admission_id=i.admission_id)
             AND ((i.kind='execution' AND json_extract(o.body,'$.state') IN ('running','awaiting_input','awaiting_approval','completed','failed'))
                  OR (i.kind='cancellation' AND json_extract(o.body,'$.state')='cancelled'))
             ORDER BY CASE WHEN json_extract(o.body,'$.state') IN ('completed','failed','cancelled') THEN 0 ELSE 1 END,
             o.receipt_sequence ASC LIMIT 1`,
      )
      .get(groupID, taskID);
    if (!row) return null;
    if (canonical(JSON.parse(row.owner_json)) !== canonical(principal))
      throw new DomainError("forbidden");
    return Object.freeze({
      admissionID: row.admission_id,
      owner: Object.freeze(JSON.parse(row.owner_json)),
      groupID: row.group_id,
      taskID: row.task_id,
      operationID: row.operation_id,
      correlationID: row.correlation_id,
      taskGeneration: row.task_generation,
      kind: row.kind,
    });
  },
};

export const runnerOutcomeEvidence = {
  lookup(
    sql: Database,
    admission: RunnerAdmissionEvidence,
  ): TaskOutcome | null {
    const row = sql
      .query<{ body: string }, [string]>(
        "SELECT body FROM runner_outcomes WHERE admission_id=? ORDER BY receipt_sequence DESC LIMIT 1",
      )
      .get(admission.admissionID);
    return row ? Object.freeze(parseTaskOutcome(JSON.parse(row.body))) : null;
  },
};

export interface RunnerPromptPolicyPort {
  /** Trusted policy snapshot, not tool-supplied TTL/revision/target/content. */
  snapshot(
    task: Readonly<TaskRecord>,
  ): Readonly<{ expiresAt: number; expectedRevision: number }>;
}
export interface RunnerUsagePort {
  /** Required synchronous budget admission. Amount/pricing belong exclusively to
   * this trusted port, never the runner's public input or host prompt payload. */
  reserve(
    sql: Database,
    evidence: Readonly<{
      groupID: string;
      taskID: string;
      admissionID: string;
      principal: Principal;
    }>,
  ): void;
  record(
    sql: Database,
    evidence: Readonly<{
      taskID: string;
      operationID: string;
      outcome: TaskOutcome;
    }>,
  ): void;
}
export interface RunnerQuestionPort {
  /** Trusted composition must route through Requests.resume, consuming the bound
   * response inside Tasks' same accounting transaction. Never a tool argument. */
  resumeTask?(
    tasks: Pick<TaskAdmissionPort, "runnerAccount">,
    evidence: Readonly<RunnerAdmissionEvidence>,
    graphRevision: number,
  ): Promise<{ graph: TaskGraph; value: unknown }>;
  record(
    sql: Database,
    evidence: Readonly<{
      taskID: string;
      operationID: string;
      state: "awaiting_input" | "awaiting_approval";
    }>,
  ): void;
}

export interface RunnerCancellationPort {
  /** No automatic host retry: unknown or interrupted delivery uses inspect. */
  deliver(
    input: Readonly<{
      operationID: string;
      executionOperationID: string | null;
      correlationID: string;
      taskGeneration: number;
    }>,
  ): Promise<{ operationID: string; state: "accepted" | "unknown_outcome" }>;
  inspect(
    operationID: string,
  ): Promise<{ operationID: string; state: "accepted" | "unknown_outcome" }>;
}

export class Runner {
  constructor(
    private readonly tasks: TaskAdmissionPort,
    private readonly dispatcher: Pick<
      Dispatcher,
      "request" | "deliver" | "reconcile"
    >,
    private readonly outcomes: TaskOutcomePort,
    private readonly policy: RunnerPromptPolicyPort,
    private readonly usage: RunnerUsagePort,
    private readonly questions: RunnerQuestionPort,
    private readonly cancellation: RunnerCancellationPort,
    private readonly clock: () => number = Date.now,
  ) {}

  async execute(
    groupID: string,
    taskID: string,
    expectedGraphRevision: number,
  ) {
    if (typeof this.usage?.reserve !== "function")
      throw new DomainError("unavailable");
    return this.tasks.runnerTransition(
      groupID,
      taskID,
      { kind: "execute" },
      expectedGraphRevision,
      (sql, context) => {
        const bounds = this.policy.snapshot(context.task);
        if (
          !Number.isSafeInteger(bounds.expiresAt) ||
          bounds.expiresAt <= this.clock() ||
          !Number.isSafeInteger(bounds.expectedRevision) ||
          bounds.expectedRevision < 0
        )
          throw new DomainError("invalid_input");
        const correlationID = context.transitionKey;
        if (typeof this.usage?.reserve !== "function")
          throw new DomainError("unavailable");
        const reserved: unknown = this.usage.reserve(
          sql,
          Object.freeze({
            groupID,
            taskID,
            admissionID: correlationID,
            principal: Object.freeze(structuredClone(context.principal)),
          }),
        );
        if (
          reserved !== null &&
          (typeof reserved === "object" || typeof reserved === "function") &&
          "then" in reserved &&
          typeof reserved.then === "function"
        )
          throw new DomainError("unavailable");
        const prompt: PromptInput = {
          target: context.task.executor,
          content: `${context.task.objective}\n\nExpected result:\n${context.task.expectedResult}`,
          ...bounds,
          idempotencyKey: `runner:${correlationID}`,
          policy: "queue",
        };
        sql
          .query(
            "INSERT INTO runner_intents(admission_id,task_id,group_id,owner_json,correlation_id,task_generation,kind,prompt_json) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            correlationID,
            taskID,
            groupID,
            canonical(context.principal),
            correlationID,
            context.taskGeneration,
            "execution",
            canonical(prompt),
          );
        return { correlationID };
      },
    );
  }

  /** Lease fences local journal writes only. Dispatcher owns host admission. */
  async work(groupID: string, taskID: string, revision: number): Promise<void> {
    const worker = crypto.randomUUID();
    const claim = await this.tasks.runnerJournal(
      groupID,
      taskID,
      revision,
      (sql, context) => {
        if (!["running", "cancel_requested"].includes(context.task.state))
          return null;
        const now = this.clock();
        if (!Number.isSafeInteger(now) || now < 0)
          throw new DomainError("unavailable");
        const row = sql
          .query<IntentRow, [string, number, string, string, number]>(
            "UPDATE runner_intents SET lease_owner=?,lease_until=?,lease_generation=lease_generation+1 WHERE admission_id=(SELECT admission_id FROM runner_intents WHERE group_id=? AND task_id=? ORDER BY task_generation DESC,kind ASC LIMIT 1) AND lease_until<=? RETURNING *",
          )
          .get(worker, now + 30_000, groupID, taskID, now);
        return row ?? null;
      },
    );
    if (!claim) return;
    try {
      if (claim.kind === "cancellation") {
        await this.deliverCancellation(
          groupID,
          taskID,
          revision,
          worker,
          claim,
        );
        return;
      }
      const prompt = JSON.parse(claim.prompt_json) as PromptInput;
      // Crash before journal correlation is safe: this exact frozen payload/key
      // replays the same operation; no host call occurs until correlation commits.
      const operation = await this.dispatcher.request(prompt);
      const deliver = await this.tasks.runnerJournal(
        groupID,
        taskID,
        revision,
        (sql, context) => {
          const row = intent(sql, groupID, taskID);
          this.checkLease(row, worker, claim.lease_generation);
          if (
            row.operation_id !== null &&
            row.operation_id !== operation.operationID
          )
            throw new DomainError("conflict");
          sql
            .query(
              "UPDATE runner_intents SET operation_id=? WHERE admission_id=? AND lease_owner=? AND lease_generation=?",
            )
            .run(
              operation.operationID,
              claim.admission_id,
              worker,
              claim.lease_generation,
            );
          return context.task.state === "running";
        },
      );
      if (!deliver) return;
      if (operation.state === "pending")
        await this.dispatcher.deliver(
          operation.operationID,
          prompt.expectedRevision,
        );
      else if (
        operation.state === "dispatching" ||
        operation.state === "unknown_outcome"
      )
        await this.dispatcher.reconcile(operation.operationID);
    } finally {
      await this.tasks.runnerJournal(groupID, taskID, revision, (sql) => {
        sql
          .query(
            "UPDATE runner_intents SET lease_owner=NULL,lease_until=0 WHERE admission_id=? AND lease_owner=? AND lease_generation=?",
          )
          .run(claim.admission_id, worker, claim.lease_generation);
      });
    }
  }

  private async deliverCancellation(
    groupID: string,
    taskID: string,
    revision: number,
    worker: string,
    claim: IntentRow,
  ) {
    const send = await this.tasks.runnerJournal(
      groupID,
      taskID,
      revision,
      (sql) => {
        const row = intent(sql, groupID, taskID);
        this.checkLease(row, worker, claim.lease_generation);
        if (row.cancel_dispatch !== "pending") return false;
        sql
          .query(
            "UPDATE runner_intents SET cancel_dispatch='dispatching' WHERE admission_id=?",
          )
          .run(row.admission_id);
        return true;
      },
    );
    if (!claim.operation_id) throw new DomainError("conflict");
    const receipt = send
      ? await this.cancellation.deliver({
          operationID: claim.operation_id,
          executionOperationID: JSON.parse(claim.prompt_json)
            .executionOperationID,
          correlationID: claim.correlation_id,
          taskGeneration: claim.task_generation,
        })
      : await this.cancellation.inspect(claim.operation_id);
    if (
      !receipt ||
      receipt.operationID !== claim.operation_id ||
      !["accepted", "unknown_outcome"].includes(receipt.state)
    )
      throw new DomainError("invalid_input");
    await this.tasks.runnerJournal(groupID, taskID, revision, (sql) => {
      this.checkLease(
        intent(sql, groupID, taskID),
        worker,
        claim.lease_generation,
      );
      sql
        .query(
          "UPDATE runner_intents SET cancel_dispatch=? WHERE admission_id=?",
        )
        .run(receipt.state, claim.admission_id);
    });
  }

  private checkLease(row: IntentRow, worker: string, generation: number): void {
    if (
      row.lease_owner !== worker ||
      row.lease_generation !== generation ||
      row.lease_until <= this.clock()
    )
      throw new DomainError("conflict");
  }

  async cancel(groupID: string, taskID: string, revision: number) {
    return this.tasks.runnerTransition(
      groupID,
      taskID,
      { kind: "cancel" },
      revision,
      (sql, context) => {
        const execution = sql
          .query<IntentRow, [string, string, number]>(
            "SELECT * FROM runner_intents WHERE group_id=? AND task_id=? AND task_generation=? AND kind='execution'",
          )
          .get(groupID, taskID, context.taskGeneration);
        if (!execution) throw new DomainError("conflict");
        const operationID = crypto.randomUUID();
        sql
          .query(
            "INSERT INTO runner_intents(admission_id,task_id,group_id,owner_json,correlation_id,task_generation,kind,prompt_json,operation_id) VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .run(
            context.transitionKey,
            taskID,
            groupID,
            canonical(context.principal),
            context.transitionKey,
            context.taskGeneration,
            "cancellation",
            canonical({ executionOperationID: execution.operation_id }),
            operationID,
          );
        return { operationID };
      },
    );
  }

  async collect(groupID: string, taskID: string, revision: number) {
    const candidates = await this.tasks.runnerJournal(
      groupID,
      taskID,
      revision,
      (sql) => {
        const current = intent(sql, groupID, taskID);
        return sql
          .query<
            IntentRow & { received_outcome: string | null },
            [string, string, number]
          >(
            "SELECT i.*,(SELECT body FROM runner_outcomes o WHERE o.admission_id=i.admission_id ORDER BY receipt_sequence DESC LIMIT 1) received_outcome FROM runner_intents i WHERE i.group_id=? AND i.task_id=? AND i.task_generation=? ORDER BY i.kind ASC",
          )
          .all(groupID, taskID, current.task_generation);
      },
    );
    let received: { admitted: IntentRow; outcome: TaskOutcome } | null = null;
    for (const candidate of candidates) {
      if (!candidate.operation_id) continue;
      const value =
        (await this.outcomes.inspect(candidate.operation_id)) ??
        (candidate.received_outcome
          ? JSON.parse(candidate.received_outcome)
          : null);
      if (value === null) continue;
      const outcome = parseTaskOutcome(value);
      if (
        (candidate.kind === "cancellation" && outcome.state !== "cancelled") ||
        (candidate.kind === "execution" && outcome.state === "cancelled")
      )
        throw new DomainError("conflict");
      if (
        candidates.length > 1 &&
        candidate.kind === "execution" &&
        !["completed", "failed"].includes(outcome.state)
      )
        continue;
      received = { admitted: candidate, outcome };
      break;
    }
    if (!received) return null;
    const { admitted, outcome } = received;
    const operationID = admitted.operation_id;
    if (!operationID) throw new DomainError("conflict");
    if (
      outcome.operationID !== operationID ||
      outcome.admissionID !== admitted.admission_id ||
      outcome.correlationID !== admitted.correlation_id ||
      outcome.taskGeneration !== admitted.task_generation
    )
      throw new DomainError("conflict");
    await this.tasks.runnerJournal(groupID, taskID, revision, (sql) => {
      const row = sql
        .query<IntentRow, [string]>(
          "SELECT * FROM runner_intents WHERE admission_id=?",
        )
        .get(admitted.admission_id);
      if (!row) throw new DomainError("conflict");
      if (
        row.admission_id !== outcome.admissionID ||
        row.operation_id !== operationID
      )
        throw new DomainError("conflict");
      const existing = sql
        .query<{ body: string }, [string]>(
          "SELECT body FROM runner_outcomes WHERE admission_id=? ORDER BY receipt_sequence DESC LIMIT 1",
        )
        .get(row.admission_id);
      if (existing && existing.body !== canonical(outcome)) {
        const previous = parseTaskOutcome(JSON.parse(existing.body));
        if (
          !["awaiting_input", "awaiting_approval", "running"].includes(
            previous.state,
          )
        )
          throw new DomainError("conflict");
      }
      if (existing?.body === canonical(outcome)) return;
      sql
        .query("INSERT INTO runner_outcomes(admission_id,body) VALUES(?,?)")
        .run(row.admission_id, canonical(outcome));
    });
    const selected = await this.tasks.runnerJournal(
      groupID,
      taskID,
      revision,
      (sql, context) => {
        const admission = runnerAdmissionEvidence.lookup(
          sql,
          groupID,
          taskID,
          context.principal,
          "accounting",
        );
        if (!admission) throw new DomainError("conflict");
        const receipt = runnerOutcomeEvidence.lookup(sql, admission);
        if (!receipt) throw new DomainError("conflict");
        return { admission, receipt };
      },
    );
    if (selected.receipt.state === "running") {
      if (!this.questions.resumeTask) throw new DomainError("forbidden");
      return this.questions.resumeTask(
        this.tasks,
        selected.admission,
        revision,
      );
    }
    return this.tasks.runnerAccount(
      groupID,
      taskID,
      revision,
      (sql, context) => {
        const winner = runnerAdmissionEvidence.lookup(
          sql,
          groupID,
          taskID,
          context.principal,
          "accounting",
        );
        if (!winner?.operationID) throw new DomainError("conflict");
        const accounted = runnerOutcomeEvidence.lookup(sql, winner);
        if (!accounted) throw new DomainError("conflict");
        if (accounted.state === "running") throw new DomainError("forbidden");
        if (
          accounted.state === "awaiting_input" ||
          accounted.state === "awaiting_approval"
        )
          this.questions.record(sql, {
            taskID,
            operationID: winner.operationID,
            state: accounted.state,
          });
        else
          this.usage.record(sql, {
            taskID,
            operationID: winner.operationID,
            outcome: accounted,
          });
      },
    );
  }
}
