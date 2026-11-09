import type { Database } from "bun:sqlite";
import type { TrustedPrincipalPort } from "../authorization/authorize";
import {
  canonical,
  DomainError,
  type Principal,
  parseSessionRef,
  type SessionRef,
} from "../contracts";
import type { Migration, Persistence } from "../persistence/database";
import {
  parseTaskOutcome,
  type RunnerQuestionPort,
  runnerAdmissionEvidence,
  runnerOutcomeEvidence,
} from "./runner";
import type {
  RunnerAdmissionEvidence,
  RunnerTaskContext,
  Tasks,
} from "./tasks";

/** Fresh-schema descriptor: bootstrap assigns the next explicit version.
 * Existing databases need a future explicit migration rebuilding question_audit
 * without its former cascading FK. No automatic/live migration is performed. */
export const REQUESTS_MIGRATION: Omit<Migration, "version"> = {
  apply(sql) {
    sql.exec(`CREATE TABLE task_questions (
      request_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES task_records(task_id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL, generation INTEGER NOT NULL,
      body TEXT NOT NULL, response TEXT, response_sequence INTEGER,
      consumed INTEGER NOT NULL DEFAULT 0,
      UNIQUE(task_id,generation,operation_id));
      CREATE TABLE question_audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        kind TEXT NOT NULL, actor TEXT, created_at INTEGER NOT NULL);`);
  },
};

export interface QuestionBinding {
  readonly admissionID: string;
  readonly operationID: string;
  readonly correlationID: string;
  readonly taskGeneration: number;
  readonly taskID: string;
  readonly groupID: string;
  readonly owner: Principal;
}
export interface QuestionPolicy {
  readonly respondent: Principal;
  readonly target: SessionRef;
  readonly policyRevision: number;
  readonly expiresAt: number;
}
/** Synchronous trusted LOCAL policy. It must validate current identity, scope,
 * revocation and operator revision, using this exact transaction/Database.
 * It selects the respondent; no tool payload may implement this adapter. */
export interface QuestionPolicyPort {
  snapshot(
    sql: Database,
    binding: Readonly<QuestionBinding>,
    state: "awaiting_input" | "awaiting_approval",
  ): QuestionPolicy;
}
/** Host-authenticated human interaction ONLY. Never expose respondAsOperator as
 * a session/model command, or derive this identity from a payload principal.
 * Real authentication/composition belongs to the host, not this module. */
export interface QuestionOperatorPort {
  current(sql: Database): Principal | null;
}
export interface TaskQuestion extends QuestionBinding, QuestionPolicy {
  readonly requestID: string;
  readonly kind: "input" | "human_approval";
  readonly createdAt: number;
  readonly state:
    | "pending"
    | "answered"
    | "approved_once"
    | "denied"
    | "expired";
}
export interface QuestionResponse {
  readonly revision: number;
  readonly admissionID: string;
  readonly operationID: string;
  readonly correlationID: string;
  readonly taskGeneration: number;
  readonly target: SessionRef;
  readonly decision: "answer" | "once" | "deny";
  readonly content?: string;
}
interface Row {
  body: string;
  response: string | null;
  response_sequence: number | null;
  consumed: number;
}

function principal(value: Principal): Principal {
  if (!value || typeof value !== "object") throw new DomainError("forbidden");
  if (value.kind === "session")
    return { kind: "session", session: parseSessionRef(value.session) };
  if (
    value.kind !== "operator" ||
    typeof value.operatorID !== "string" ||
    !value.operatorID.trim() ||
    typeof value.instanceID !== "string" ||
    !value.instanceID.trim() ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  )
    throw new DomainError("forbidden");
  return {
    kind: "operator",
    operatorID: value.operatorID,
    instanceID: value.instanceID,
    revision: value.revision,
  };
}
function response(value: QuestionResponse): QuestionResponse {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).some(
      (key) =>
        ![
          "revision",
          "admissionID",
          "operationID",
          "correlationID",
          "taskGeneration",
          "target",
          "decision",
          "content",
        ].includes(key),
    ) ||
    !["answer", "once", "deny"].includes(value.decision) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Number.isSafeInteger(value.taskGeneration) ||
    value.taskGeneration < 1 ||
    [value.admissionID, value.operationID, value.correlationID].some(
      (s) => typeof s !== "string" || !s.trim(),
    ) ||
    (value.decision === "answer"
      ? typeof value.content !== "string" || !value.content.trim()
      : value.content !== undefined)
  )
    throw new DomainError("invalid_input");
  return {
    revision: value.revision,
    admissionID: value.admissionID,
    operationID: value.operationID,
    correlationID: value.correlationID,
    taskGeneration: value.taskGeneration,
    target: parseSessionRef(value.target),
    decision: value.decision,
    ...(value.content === undefined ? {} : { content: value.content }),
  };
}

/** Generic task questions are NOT T12 access requests. No link/grant/config API
 * is available here. `once` resolves one bound question, never an ACL capability. */
export class Requests implements RunnerQuestionPort {
  private readonly sql: Database;
  constructor(
    private readonly storage: Persistence,
    private readonly identity: TrustedPrincipalPort,
    private readonly operator: QuestionOperatorPort,
    private readonly policy: QuestionPolicyPort,
    private readonly clock: () => number = Date.now,
  ) {
    this.sql = storage.transaction((sql) => sql);
  }

  private transaction(sql: Database): void {
    if (sql !== this.sql || !sql.inTransaction)
      throw new DomainError("unavailable");
  }
  private now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new DomainError("unavailable");
    return now;
  }
  private audit(
    sql: Database,
    q: TaskQuestion,
    kind: string,
    actor: Principal | null,
  ): void {
    sql
      .query(
        "INSERT INTO question_audit(request_id,kind,actor,created_at) VALUES(?,?,?,?)",
      )
      .run(
        q.requestID,
        kind,
        actor === null ? null : canonical(actor),
        this.now(),
      );
  }
  private load(
    sql: Database,
    id: string,
  ): { row: Row; question: TaskQuestion } {
    const row = sql
      .query<Row, [string]>(
        "SELECT body,response,response_sequence,consumed FROM task_questions WHERE request_id=?",
      )
      .get(id);
    if (!row) throw new DomainError("not_found");
    return { row, question: JSON.parse(row.body) };
  }
  private binding(
    sql: Database,
    taskID: string,
    operationID: string,
  ): { binding: QuestionBinding; state: string; target: SessionRef } {
    const row = sql
      .query<
        {
          admission_id: string;
          task_id: string;
          group_id: string;
          owner_json: string;
          operation_id: string;
          correlation_id: string;
          task_generation: number;
          body: string;
        },
        [string, string]
      >(
        `SELECT i.*,t.body FROM runner_intents i JOIN task_records t ON t.task_id=i.task_id
       WHERE i.task_id=? AND i.operation_id=? AND i.kind='execution'
       AND i.task_generation=t.generation AND i.group_id=t.group_id
       AND i.task_generation=(SELECT MAX(task_generation) FROM runner_intents WHERE task_id=i.task_id)`,
      )
      .get(taskID, operationID);
    if (!row) throw new DomainError("conflict");
    const task = JSON.parse(row.body);
    return {
      binding: {
        admissionID: row.admission_id,
        taskID: row.task_id,
        groupID: row.group_id,
        owner: principal(JSON.parse(row.owner_json)),
        operationID: row.operation_id,
        correlationID: row.correlation_id,
        taskGeneration: row.task_generation,
      },
      state: task.state,
      target: parseSessionRef(task.executor),
    };
  }
  private snapshot(
    sql: Database,
    b: QuestionBinding,
    state: "awaiting_input" | "awaiting_approval",
  ): QuestionPolicy {
    const p = this.policy.snapshot(
      sql,
      Object.freeze(structuredClone(b)),
      state,
    );
    if (
      !p ||
      !Number.isSafeInteger(p.policyRevision) ||
      p.policyRevision < 0 ||
      !Number.isSafeInteger(p.expiresAt) ||
      p.expiresAt < 0
    )
      throw new DomainError("unavailable");
    const respondent = principal(p.respondent);
    if (state === "awaiting_approval" && respondent.kind !== "operator")
      throw new DomainError("forbidden");
    return {
      respondent,
      target: parseSessionRef(p.target),
      expiresAt: p.expiresAt,
      policyRevision: p.policyRevision,
    };
  }
  record(
    sql: Database,
    evidence: Parameters<RunnerQuestionPort["record"]>[1],
  ): TaskQuestion {
    this.transaction(sql);
    if (!["awaiting_input", "awaiting_approval"].includes(evidence.state))
      throw new DomainError("invalid_input");
    const {
      binding: b,
      state,
      target,
    } = this.binding(sql, evidence.taskID, evidence.operationID);
    const outcome = runnerOutcomeEvidence.lookup(sql, {
      ...b,
      kind: "execution",
    });
    if (
      !outcome ||
      outcome.state !== evidence.state ||
      state !== evidence.state ||
      outcome.admissionID !== b.admissionID ||
      outcome.operationID !== b.operationID ||
      outcome.correlationID !== b.correlationID ||
      outcome.taskGeneration !== b.taskGeneration
    )
      throw new DomainError("conflict");
    const existing = sql
      .query<{ request_id: string }, [string, number, string]>(
        "SELECT request_id FROM task_questions WHERE task_id=? AND generation=? AND operation_id=?",
      )
      .get(b.taskID, b.taskGeneration, b.operationID);
    if (existing) {
      const q = this.load(sql, existing.request_id).question;
      if ((q.kind === "human_approval") !== (state === "awaiting_approval"))
        throw new DomainError("conflict");
      return q;
    }
    const p = this.snapshot(sql, b, evidence.state);
    const now = this.now();
    if (
      canonical(p.target) !== canonical(target) ||
      p.expiresAt <= now ||
      p.expiresAt > now + 86_400_000
    )
      throw new DomainError("invalid_input");
    const q: TaskQuestion = {
      ...b,
      ...p,
      requestID: crypto.randomUUID(),
      createdAt: now,
      kind: state === "awaiting_approval" ? "human_approval" : "input",
      state: "pending",
    };
    sql
      .query(
        "INSERT INTO task_questions(request_id,task_id,operation_id,generation,body) VALUES(?,?,?,?,?)",
      )
      .run(
        q.requestID,
        b.taskID,
        b.operationID,
        b.taskGeneration,
        canonical(q),
      );
    this.audit(sql, q, "pending", b.owner);
    return q;
  }
  /** Identical response replay is idempotent only while the current policy is
   * unchanged. A changed/revoked policy returns forbidden, without a new audit. */
  async respond(id: string, input: QuestionResponse): Promise<TaskQuestion> {
    const payload = response(input);
    const p = await this.identity.current();
    if (p?.kind !== "session") throw new DomainError("forbidden");
    return this.storage.transaction((sql) =>
      this.resolve(sql, id, payload, principal(p), false),
    );
  }
  /** Host-only entry point. Never register as a model/session command.
   * Replay also requires unchanged current policy; revocation is forbidden and
   * creates no new audit event. */
  async respondAsOperator(
    id: string,
    input: QuestionResponse,
  ): Promise<TaskQuestion> {
    const payload = response(input);
    return this.storage.transaction((sql) => {
      const p = this.operator.current(sql);
      if (p?.kind !== "operator") throw new DomainError("forbidden");
      return this.resolve(sql, id, payload, principal(p), true);
    });
  }
  private resolve(
    sql: Database,
    id: string,
    input: QuestionResponse,
    actor: Principal,
    human: boolean,
  ): TaskQuestion {
    const { row, question: q } = this.load(sql, id);
    if (
      canonical(actor) !== canonical(q.respondent) ||
      (q.kind === "human_approval" && !human)
    )
      throw new DomainError("forbidden");
    if (
      input.revision !== q.policyRevision ||
      input.admissionID !== q.admissionID ||
      input.operationID !== q.operationID ||
      input.correlationID !== q.correlationID ||
      input.taskGeneration !== q.taskGeneration ||
      canonical(input.target) !== canonical(q.target)
    )
      throw new DomainError("conflict");
    const {
      binding: b,
      target,
      state,
    } = this.binding(sql, q.taskID, q.operationID);
    if (
      canonical(b) !==
        canonical({
          admissionID: q.admissionID,
          operationID: q.operationID,
          correlationID: q.correlationID,
          taskGeneration: q.taskGeneration,
          taskID: q.taskID,
          groupID: q.groupID,
          owner: q.owner,
        }) ||
      canonical(target) !== canonical(q.target)
    )
      throw new DomainError("conflict");
    const wait =
      q.kind === "human_approval" ? "awaiting_approval" : "awaiting_input";
    const p = this.snapshot(sql, b, wait);
    if (
      canonical(p) !==
      canonical({
        respondent: q.respondent,
        target: q.target,
        expiresAt: q.expiresAt,
        policyRevision: q.policyRevision,
      })
    )
      throw new DomainError("forbidden");
    const receipt = canonical({ actor, input });
    if (row.response !== null) {
      if (row.response !== receipt) throw new DomainError("conflict");
      return q;
    }
    if (q.state === "expired") return q;
    if (q.expiresAt <= this.now()) {
      const expired: TaskQuestion = { ...q, state: "expired" };
      sql
        .query("UPDATE task_questions SET body=? WHERE request_id=?")
        .run(canonical(expired), id);
      this.audit(sql, expired, "expired", null);
      return expired;
    }
    if (q.state !== "pending" || state !== wait)
      throw new DomainError("conflict");
    if (
      (q.kind === "human_approval" && input.decision === "answer") ||
      (q.kind === "input" && input.decision === "once")
    )
      throw new DomainError("invalid_input");
    const resolved: TaskQuestion = {
      ...q,
      state:
        input.decision === "deny"
          ? "denied"
          : input.decision === "once"
            ? "approved_once"
            : "answered",
    };
    sql
      .query(
        "UPDATE task_questions SET body=?,response=?,response_sequence=(SELECT COALESCE(MAX(receipt_sequence),0) FROM runner_outcomes WHERE admission_id=?) WHERE request_id=?",
      )
      .run(canonical(resolved), receipt, q.admissionID, id);
    this.audit(sql, resolved, resolved.state, actor);
    return resolved;
  }

  /** Execution-owner workflow, after the trusted host response adapter delivered
   * the bound reply and Runner journaled a matching explicit running receipt.
   * No response, timeout, denial, native idle or bare transition is such proof.
   * Tasks performs fresh authorization/CAS and the transition in the same DB. */
  async resume(
    tasks: Pick<Tasks, "runnerAccount">,
    id: string,
    graphRevision: number,
  ) {
    const q = this.storage.transaction((sql) => this.load(sql, id).question);
    return tasks.runnerAccount(
      q.groupID,
      q.taskID,
      graphRevision,
      (sql, context) => {
        return this.consume(sql, context, id);
      },
    );
  }

  /** Trusted Runner composition only. Resolve the exact persisted question in
   * Tasks' accounting transaction, never by a tool request ID or latest-row
   * fallback. Supplied evidence must equal the canonical selected admission. */
  async resumeForAdmission(
    tasks: Pick<Tasks, "runnerAccount">,
    evidence: Readonly<RunnerAdmissionEvidence>,
    graphRevision: number,
  ) {
    const expected = structuredClone(evidence);
    return tasks.runnerAccount(
      expected.groupID,
      expected.taskID,
      graphRevision,
      (sql, context) => {
        this.transaction(sql);
        const selected = runnerAdmissionEvidence.lookup(
          sql,
          expected.groupID,
          expected.taskID,
          context.principal,
          "accounting",
        );
        if (
          selected?.kind !== "execution" ||
          canonical(selected) !== canonical(expected)
        )
          throw new DomainError("conflict");
        const row = sql
          .query<{ request_id: string }, [string, number, string]>(
            "SELECT request_id FROM task_questions WHERE task_id=? AND generation=? AND operation_id=?",
          )
          .get(
            selected.taskID,
            selected.taskGeneration,
            selected.operationID ?? "",
          );
        if (!row) throw new DomainError("conflict");
        return this.consume(sql, context, row.request_id, selected);
      },
    );
  }

  private consume(
    sql: Database,
    context: RunnerTaskContext,
    id: string,
    expected?: Readonly<RunnerAdmissionEvidence>,
  ): TaskQuestion {
    this.transaction(sql);
    const { row, question } = this.load(sql, id);
    if (
      row.consumed ||
      !["answered", "approved_once"].includes(question.state) ||
      !row.response ||
      question.expiresAt <= this.now() ||
      context.taskGeneration !== question.taskGeneration ||
      context.task.taskID !== question.taskID ||
      context.graph.groupID !== question.groupID ||
      context.task.state !== "running" ||
      canonical(context.principal) !== canonical(question.owner)
    )
      throw new DomainError("conflict");
    const { binding: b } = this.binding(
      sql,
      question.taskID,
      question.operationID,
    );
    const admission: RunnerAdmissionEvidence = { ...b, kind: "execution" };
    const selected = runnerAdmissionEvidence.lookup(
      sql,
      question.groupID,
      question.taskID,
      context.principal,
      "accounting",
    );
    if (
      canonical(selected) !== canonical(admission) ||
      (expected && canonical(admission) !== canonical(expected)) ||
      question.admissionID !== admission.admissionID ||
      question.correlationID !== admission.correlationID ||
      canonical(question.owner) !== canonical(admission.owner)
    )
      throw new DomainError("conflict");
    const outcome = runnerOutcomeEvidence.lookup(sql, admission);
    const sequence = sql
      .query<{ sequence: number }, [string]>(
        "SELECT MAX(receipt_sequence) sequence FROM runner_outcomes WHERE admission_id=?",
      )
      .get(question.admissionID)?.sequence;
    if (
      !outcome ||
      row.response_sequence === null ||
      sequence === undefined ||
      sequence <= row.response_sequence ||
      parseTaskOutcome(outcome).state !== "running" ||
      outcome.admissionID !== question.admissionID ||
      outcome.operationID !== question.operationID ||
      outcome.correlationID !== question.correlationID ||
      outcome.taskGeneration !== question.taskGeneration
    )
      throw new DomainError("conflict");
    const p = this.snapshot(
      sql,
      b,
      question.kind === "human_approval"
        ? "awaiting_approval"
        : "awaiting_input",
    );
    if (
      canonical(p) !==
      canonical({
        respondent: question.respondent,
        target: question.target,
        expiresAt: question.expiresAt,
        policyRevision: question.policyRevision,
      })
    )
      throw new DomainError("forbidden");
    const changed = sql
      .query(
        "UPDATE task_questions SET consumed=1 WHERE request_id=? AND consumed=0",
      )
      .run(id);
    if (changed.changes !== 1) throw new DomainError("conflict");
    this.audit(sql, question, "consumed", context.principal);
    return question;
  }

  /** Scheduler hook; expires local pending questions without resuming a task or
   * creating any grant. Integrator schedules it; the module starts no timers. */
  expire(): number {
    return this.storage.transaction((sql) => {
      let count = 0;
      for (const row of sql
        .query<{ body: string }, []>(
          "SELECT body FROM task_questions WHERE response IS NULL",
        )
        .all()) {
        const q: TaskQuestion = JSON.parse(row.body);
        if (q.state !== "pending" || q.expiresAt > this.now()) continue;
        const expired: TaskQuestion = { ...q, state: "expired" };
        sql
          .query("UPDATE task_questions SET body=? WHERE request_id=?")
          .run(canonical(expired), q.requestID);
        this.audit(sql, expired, "expired", null);
        count++;
      }
      return count;
    });
  }

  /** T18 local targeted cleanup only; never host sessions, grants or other DBs. */
  cleanup(sql: Database, target: SessionRef): number {
    this.transaction(sql);
    const selected = canonical(parseSessionRef(target));
    let deleted = 0;
    for (const row of sql
      .query<{ request_id: string; body: string }, []>(
        "SELECT request_id,body FROM task_questions",
      )
      .all()) {
      const q: TaskQuestion = JSON.parse(row.body);
      const refs = [
        q.target,
        ...(q.respondent.kind === "session" ? [q.respondent.session] : []),
        ...(q.owner.kind === "session" ? [q.owner.session] : []),
      ];
      if (!refs.some((r) => selected === canonical(r))) continue;
      sql
        .query("DELETE FROM task_questions WHERE request_id=?")
        .run(row.request_id);
      deleted++;
    }
    return deleted;
  }
}

/** Bootstrap-owned adapter for T31 and Runner; never accept a replacement from
 * model/tool input. Both hooks keep Requests' canonical DB and transaction gates. */
export function questionsRunnerPort(requests: Requests): RunnerQuestionPort {
  return Object.freeze({
    record: (sql, evidence) => requests.record(sql, evidence),
    resumeTask: (tasks, evidence, revision) =>
      requests.resumeForAdmission(tasks, evidence, revision),
  } satisfies RunnerQuestionPort);
}
