import type { Database } from "bun:sqlite";
import { Cron, Result } from "effect";
import {
  Authorizer,
  type TrustedPrincipalPort,
} from "../authorization/authorize";
import type { GrantPolicyPort, Grants } from "../authorization/grants";
import {
  canonical,
  DomainError,
  occurrenceID,
  type Principal,
  parseMessageContent,
  parseSchedule,
  parseSessionRef,
  type Schedule,
  type SessionRef,
} from "../contracts";
import type { Dispatcher, PromptInput } from "../messaging/dispatcher";
import type { Migration, Persistence } from "../persistence/database";
import type { Operation, RemovedTargetPort } from "../persistence/operations";
import type { ControlJobsPort } from "../sessions/control";

export function validateSchedule(input: unknown): Schedule {
  if (
    input &&
    typeof input === "object" &&
    ["conditions", "if", "until"].some((k) => Object.hasOwn(input, k))
  )
    throw new DomainError("unsupported");
  const schedule = parseSchedule(input);
  // Intl also accepts numeric offsets; those are not IANA zone identifiers.
  if (/^[+-]/.test(schedule.timezone)) throw new DomainError("invalid_input");
  if (schedule.kind === "cron") {
    if (Result.isFailure(Cron.parse(schedule.expression, schedule.timezone)))
      throw new DomainError("invalid_input");
    nextScheduleDue(schedule, 0, Date.parse(schedule.referenceUTC));
  }
  return schedule;
}

export const SCHEDULES_MIGRATION: Omit<Migration, "version"> = {
  apply(sql) {
    sql.exec(`CREATE TABLE schedule_jobs (
      job_id TEXT PRIMARY KEY, group_id TEXT, target_json TEXT NOT NULL, owner_json TEXT NOT NULL,
      schedule_revision INTEGER NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL,
      next_index INTEGER NOT NULL, next_due INTEGER, runs INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT, lease_generation INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX schedule_due ON schedule_jobs(state,next_due);
    CREATE TABLE schedule_occurrences (
      occurrence_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES schedule_jobs(job_id),
      schedule_revision INTEGER NOT NULL, due_index INTEGER NOT NULL, through_index INTEGER NOT NULL,
      due_at INTEGER NOT NULL, last_due INTEGER NOT NULL, state TEXT NOT NULL,
      grant_revision INTEGER, policy_revision INTEGER, evidence TEXT, run_reserved INTEGER NOT NULL DEFAULT 0,
      UNIQUE(job_id,schedule_revision,due_index)
    );
    CREATE UNIQUE INDEX schedule_one_pending ON schedule_occurrences(job_id) WHERE state='pending';
    CREATE UNIQUE INDEX schedule_one_active ON schedule_occurrences(job_id) WHERE state IN ('ready','dispatching','admitted','unknown_outcome');
    CREATE INDEX schedule_occurrence_state ON schedule_occurrences(job_id,state);
    CREATE TABLE schedule_outbox (
      occurrence_id TEXT PRIMARY KEY REFERENCES schedule_occurrences(occurrence_id),
      prompt_json TEXT NOT NULL, operation_id TEXT UNIQUE
    );
    CREATE TABLE schedule_gates(target_json TEXT PRIMARY KEY, archived INTEGER NOT NULL);
    CREATE TABLE schedule_clock(singleton INTEGER PRIMARY KEY CHECK(singleton=1), suspended INTEGER NOT NULL);
    INSERT INTO schedule_clock VALUES(1,0);
    CREATE TABLE schedule_audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL,
      occurrence_id TEXT, kind TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL);`);
  },
};

export interface SchedulerClock {
  utc(): number;
  monotonic(): number;
  /** Uses monotonic elapsed time; returns cancellation of this timer only. */
  setTimer(delayMs: number, callback: () => void): () => void;
}
export interface ScheduleJobInput {
  target: SessionRef;
  schedule: Schedule;
  content: string;
  expiresAt: number;
  maxRuns: number;
  groupID: string | null;
}
export interface ScheduleJob extends ScheduleJobInput {
  jobID: string;
  scheduleRevision: number;
  owner: Principal;
  createdAt: number;
  /** completed means exhausted, not necessarily successful: occurrence history retains rejection/block reasons. */
  state: "active" | "paused" | "suspended" | "cancelled" | "completed";
  runs: number;
  nextIndex: number;
  nextDue: number | null;
}
export interface ScheduleOccurrence {
  occurrenceID: string;
  jobID: string;
  scheduleRevision: number;
  dueIndex: number;
  throughIndex: number;
  dueAt: number;
  lastDue: number;
  state:
    | "pending"
    | "ready"
    | "dispatching"
    | "admitted"
    | "unknown_outcome"
    | "blocked"
    | "rejected"
    | "completed"
    | "failed";
  operationID: string | null;
  grantRevision: number | null;
  policyRevision: number | null;
}
export interface ScheduleLease {
  readonly jobID: string;
  readonly owner: string;
  readonly generation: number;
  readonly expiresAt: number;
}
type DeliveryAuthorization = ConstructorParameters<typeof Dispatcher>[2];
export interface SchedulerOptions {
  storage: Persistence;
  identity: TrustedPrincipalPort;
  policy: GrantPolicyPort;
  grants: Pick<Grants, "snapshot">;
  clock: SchedulerClock;
  /** Trusted canonical DB coordinator time, never a lease timestamp supplied by a worker. */
  coordinator: { now(sql: Database): number };
  targets: RemovedTargetPort;
  limits: {
    assert(
      sql: Database,
      job: Readonly<ScheduleJob>,
      phase: "create" | "admission" | "dispatch",
    ): void;
  };
  /** Compose T20 with this authenticated persisted owner and guarded authorizer on
   * the SAME storage. request() is durable/idempotent and does not send to host. */
  dispatcher(
    owner: Principal,
    authorization: DeliveryAuthorization,
  ): Pick<Dispatcher, "request" | "deliver" | "recover" | "reconcile">;
  /** Trusted correlated terminal evidence, never idle or native prompt acceptance. */
  outcomes?: {
    inspect(occurrence: Readonly<ScheduleOccurrence>): Promise<{
      occurrenceID: string;
      operationID: string;
      state: "completed" | "failed";
      evidence: string;
    } | null>;
  };
  onError?: (error: unknown) => void;
}
interface JobRow {
  job_id: string;
  group_id: string | null;
  target_json: string;
  owner_json: string;
  schedule_revision: number;
  state: ScheduleJob["state"];
  body: string;
  next_index: number;
  next_due: number | null;
  runs: number;
  lease_owner: string | null;
  lease_generation: number;
  lease_until: number;
}
interface OccurrenceRow {
  run_reserved: number;
  occurrence_id: string;
  job_id: string;
  schedule_revision: number;
  due_index: number;
  through_index: number;
  due_at: number;
  last_due: number;
  state: ScheduleOccurrence["state"];
  operation_id: string | null;
  grant_revision: number | null;
  policy_revision: number | null;
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function synchronous(value: unknown): void {
  if (value && typeof (value as { then?: unknown }).then === "function")
    throw new DomainError("unavailable");
}
function jobView(row: JobRow): ScheduleJob {
  return {
    ...JSON.parse(row.body),
    jobID: row.job_id,
    scheduleRevision: row.schedule_revision,
    owner: JSON.parse(row.owner_json),
    state: row.state,
    runs: row.runs,
    nextIndex: row.next_index,
    nextDue: row.next_due,
  };
}
function occurrenceView(row: OccurrenceRow): ScheduleOccurrence {
  return {
    occurrenceID: row.occurrence_id,
    jobID: row.job_id,
    scheduleRevision: row.schedule_revision,
    dueIndex: row.due_index,
    throughIndex: row.through_index,
    dueAt: row.due_at,
    lastDue: row.last_due,
    state: row.state,
    operationID: row.operation_id ?? null,
    grantRevision: row.grant_revision,
    policyRevision: row.policy_revision,
  };
}
function jobInput(input: unknown): ScheduleJobInput {
  if (
    !input ||
    typeof input !== "object" ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    throw new DomainError("invalid_input");
  const v = input as Record<string, unknown>;
  if (["conditions", "if", "until"].some((k) => Object.hasOwn(v, k)))
    throw new DomainError("unsupported");
  if (
    Reflect.ownKeys(v).some(
      (k) =>
        typeof k !== "string" ||
        ![
          "target",
          "schedule",
          "content",
          "expiresAt",
          "maxRuns",
          "groupID",
        ].includes(k),
    ) ||
    Object.values(Object.getOwnPropertyDescriptors(v)).some(
      (d) => !("value" in d),
    ) ||
    !integer(v.expiresAt) ||
    !integer(v.maxRuns) ||
    v.maxRuns === 0 ||
    !(v.groupID === null || nonempty(v.groupID))
  )
    throw new DomainError("invalid_input");
  return {
    target: parseSessionRef(v.target),
    schedule: validateSchedule(v.schedule),
    content: parseMessageContent(v.content),
    expiresAt: v.expiresAt,
    maxRuns: v.maxRuns,
    groupID: v.groupID,
  };
}

/** SQLite admission/lease fencing is LOCAL. It cannot fence bytes already sent
 * to a host lacking its own CAS; uncertainty retains the non-overlap reservation. */
export class Scheduler {
  private readonly sql: Database;
  private disposed = false;
  private cancelTimer: (() => void) | null = null;
  private started = false;
  private ticking: Promise<void> | null = null;
  private sample: { utc: number; mono: number } | null = null;
  readonly jobs: ControlJobsPort & {
    active(sql: Database, groupID: string): boolean;
  };

  constructor(private readonly options: SchedulerOptions) {
    this.sql = options.storage.transaction((sql) => sql);
    this.jobs = {
      active: (sql, groupID) => {
        this.canonicalDB(sql);
        return (
          sql
            .query(`SELECT 1 FROM schedule_jobs j WHERE group_id=? AND
          (state NOT IN ('cancelled','completed') OR EXISTS (SELECT 1 FROM schedule_occurrences o WHERE o.job_id=j.job_id AND o.state IN ('ready','dispatching','admitted','unknown_outcome')))`)
            .get(groupID) !== null
        );
      },
      archive: (sql, target) => {
        this.canonicalDB(sql);
        const key = canonical(parseSessionRef(target));
        sql
          .query(
            "INSERT INTO schedule_gates VALUES (?,1) ON CONFLICT(target_json) DO UPDATE SET archived=1",
          )
          .run(key);
        for (const row of sql
          .query<JobRow, [string]>(
            "SELECT * FROM schedule_jobs WHERE target_json=? AND state IN ('active','paused')",
          )
          .all(key)) {
          sql
            .query("UPDATE schedule_jobs SET state='suspended' WHERE job_id=?")
            .run(row.job_id);
          this.block(sql, row.job_id, "archived");
        }
      },
      restore: (sql, target) => {
        this.canonicalDB(sql);
        sql
          .query(
            "INSERT INTO schedule_gates VALUES (?,0) ON CONFLICT(target_json) DO UPDATE SET archived=0",
          )
          .run(canonical(parseSessionRef(target)));
      },
    };
  }
  private canonicalDB(sql: Database): void {
    if (sql !== this.sql || !sql.inTransaction)
      throw new DomainError("unavailable");
  }
  private time(sql: Database): number {
    this.canonicalDB(sql);
    const now = this.options.coordinator.now(sql);
    if (!integer(now)) throw new DomainError("unavailable");
    return now;
  }
  private row(sql: Database, jobID: string): JobRow {
    if (!nonempty(jobID)) throw new DomainError("invalid_input");
    const row = sql
      .query<JobRow, [string]>("SELECT * FROM schedule_jobs WHERE job_id=?")
      .get(jobID);
    if (!row) throw new DomainError("not_found");
    return row;
  }
  private audit(
    sql: Database,
    jobID: string,
    kind: string,
    id: string | null = null,
    detail: unknown = {},
  ): void {
    sql
      .query(
        "INSERT INTO schedule_audit(job_id,occurrence_id,kind,detail,created_at) VALUES(?,?,?,?,?)",
      )
      .run(jobID, id, kind, canonical(detail), this.time(sql));
  }
  private snapshot(sql: Database, p: Principal, target: SessionRef) {
    const snapshot = this.options.policy.load(sql, p, target);
    const grants = this.options.grants.snapshot(sql);
    snapshot.grants = [...grants.grants];
    return { snapshot, grantRevision: grants.revision };
  }
  private authorizer(
    identity: TrustedPrincipalPort,
    guard?: (sql: Database) => void,
  ): Authorizer {
    return new Authorizer(
      identity,
      {
        read: async (p, t) =>
          this.options.storage.transaction(
            (sql) => this.snapshot(sql, p, t).snapshot,
          ),
        admission: (p, t, check) =>
          this.options.storage.transaction((sql) => {
            const current = this.snapshot(sql, p, t);
            guard?.(sql);
            const result = check(current.snapshot);
            synchronous(result);
            synchronous(this.options.policy.save(sql, current.snapshot));
            return result;
          }),
      },
      () => this.options.storage.transaction((sql) => this.time(sql)),
    );
  }
  private async actor(): Promise<Principal> {
    const p = await this.options.identity.current();
    if (!p) throw new DomainError("forbidden");
    return p;
  }
  private async owned(jobID: string): Promise<JobRow> {
    const p = await this.actor();
    const row = this.options.storage.transaction((sql) => this.row(sql, jobID));
    await this.authorizer(this.options.identity).authorizeReplay(
      p,
      JSON.parse(row.owner_json),
    );
    return row;
  }
  async get(jobID: string): Promise<ScheduleJob> {
    return jobView(await this.owned(jobID));
  }
  async list(): Promise<ScheduleJob[]> {
    const p = await this.actor();
    return this.options.storage.transaction((sql) =>
      sql
        .query<JobRow, [string]>(
          "SELECT * FROM schedule_jobs WHERE owner_json=? ORDER BY job_id",
        )
        .all(canonical(p))
        .map(jobView),
    );
  }
  async occurrences(jobID: string): Promise<ScheduleOccurrence[]> {
    await this.owned(jobID);
    return this.options.storage.transaction((sql) =>
      sql
        .query<OccurrenceRow, [string]>(
          `SELECT o.*,b.operation_id FROM schedule_occurrences o LEFT JOIN schedule_outbox b USING(occurrence_id) WHERE o.job_id=? ORDER BY o.schedule_revision,o.due_index`,
        )
        .all(jobID)
        .map(occurrenceView),
    );
  }
  async create(input: unknown, policyRevision: number): Promise<ScheduleJob> {
    const value = jobInput(input);
    const p = await this.actor();
    return this.authorizer(this.options.identity).admit(
      p,
      value.target,
      "schedule.manage",
      policyRevision,
      () =>
        this.options.storage.transaction((sql) => {
          if (this.disposed) throw new DomainError("unavailable");
          const createdAt = this.time(sql);
          const jobID = crypto.randomUUID();
          const job: ScheduleJob = {
            ...value,
            jobID,
            scheduleRevision: 1,
            owner: structuredClone(p),
            createdAt,
            state: "active",
            runs: 0,
            nextIndex: 0,
            nextDue: nextScheduleDue(value.schedule, 0, createdAt),
          };
          if (value.expiresAt <= createdAt) throw new DomainError("expired");
          this.available(sql, job);
          if (job.groupID !== null) {
            const group = sql
              .query<{ body: string }, [string]>(
                "SELECT body FROM groups_records WHERE group_id=?",
              )
              .get(job.groupID);
            if (!group) throw new DomainError("not_found");
            const g = JSON.parse(group.body);
            if (
              canonical(g.owner) !== canonical(p) ||
              g.scope.instanceID !== value.target.instanceID ||
              g.scope.projectID !== value.target.projectID
            )
              throw new DomainError("not_found");
          }
          synchronous(this.options.limits.assert(sql, job, "create"));
          sql
            .query(
              "INSERT INTO schedule_jobs(job_id,group_id,target_json,owner_json,schedule_revision,state,body,next_index,next_due) VALUES(?,?,?,?,1,'active',?,0,?)",
            )
            .run(
              jobID,
              value.groupID,
              canonical(value.target),
              canonical(p),
              canonical({ ...value, createdAt }),
              job.nextDue,
            );
          this.audit(sql, jobID, "created");
          return job;
        }),
    );
  }
  private available(sql: Database, job: ScheduleJob): void {
    if (
      sql
        .query<{ archived: number }, [string]>(
          "SELECT archived FROM schedule_gates WHERE target_json=?",
        )
        .get(canonical(job.target))?.archived
    )
      throw new DomainError("conflict");
    synchronous(this.options.targets.assertAvailable(sql, job.target));
  }
  private block(
    sql: Database,
    jobID: string,
    reason: string,
    finalize = true,
  ): void {
    const rows = sql
      .query<OccurrenceRow, [string]>(
        "SELECT o.*,b.operation_id FROM schedule_occurrences o LEFT JOIN schedule_outbox b USING(occurrence_id) WHERE o.job_id=? AND o.state IN ('pending','ready')",
      )
      .all(jobID);
    for (const row of rows) {
      // T20 may have committed enqueue before its response/correlation was lost.
      const operationID =
        row.operation_id ??
        sql
          .query<{ operation_id: string }, [string, string]>(
            "SELECT operation_id FROM operations WHERE owner_json=? AND idempotency_key=?",
          )
          .get(this.row(sql, jobID).owner_json, `schedule:${row.occurrence_id}`)
          ?.operation_id;
      if (operationID) {
        sql
          .query(
            "UPDATE schedule_outbox SET operation_id=? WHERE occurrence_id=?",
          )
          .run(operationID, row.occurrence_id);
        const changed = sql
          .query(
            "UPDATE operations SET state='rejected' WHERE operation_id=? AND state='pending'",
          )
          .run(operationID);
        if (changed.changes)
          sql
            .query(
              "INSERT INTO operation_audit(operation_id,state,created_at) VALUES (?,'rejected',?)",
            )
            .run(operationID, this.time(sql));
      }
      sql
        .query(
          "UPDATE schedule_occurrences SET state='blocked',evidence=? WHERE occurrence_id=?",
        )
        .run(reason, row.occurrence_id);
      this.audit(sql, jobID, "blocked", row.occurrence_id, { reason });
    }
    if (finalize) this.finishExhausted(sql, jobID);
  }
  private finishExhausted(sql: Database, jobID: string): void {
    const job = this.row(sql, jobID);
    if (job.next_due !== null || ["completed", "cancelled"].includes(job.state))
      return;
    if (
      sql
        .query(
          "SELECT 1 FROM schedule_occurrences WHERE job_id=? AND state IN ('pending','ready','dispatching','admitted','unknown_outcome')",
        )
        .get(jobID)
    )
      return;
    sql
      .query("UPDATE schedule_jobs SET state='completed' WHERE job_id=?")
      .run(jobID);
    this.audit(sql, jobID, "exhausted");
  }
  async change(
    jobID: string,
    action: "pause" | "resume" | "cancel",
    policyRevision: number,
  ): Promise<ScheduleJob> {
    if (!["pause", "resume", "cancel"].includes(action))
      throw new DomainError("invalid_input");
    await this.owned(jobID);
    const p = await this.actor();
    const original = this.options.storage.transaction((sql) =>
      jobView(this.row(sql, jobID)),
    );
    return this.authorizer(this.options.identity).admit(
      p,
      original.target,
      "schedule.manage",
      policyRevision,
      () =>
        this.options.storage.transaction((sql) => {
          const job = jobView(this.row(sql, jobID));
          if (["cancelled", "completed"].includes(job.state))
            throw new DomainError("conflict");
          if (action === "resume") this.available(sql, job);
          sql
            .query("UPDATE schedule_jobs SET state=? WHERE job_id=?")
            .run(
              action === "resume"
                ? "active"
                : action === "pause"
                  ? "paused"
                  : "cancelled",
              jobID,
            );
          if (action !== "resume") this.block(sql, jobID, action);
          this.audit(sql, jobID, action);
          return jobView(this.row(sql, jobID));
        }),
    );
  }
  async reschedule(
    jobID: string,
    input: unknown,
    policyRevision: number,
  ): Promise<ScheduleJob> {
    const schedule = validateSchedule(input);
    const original = jobView(await this.owned(jobID));
    const p = await this.actor();
    return this.authorizer(this.options.identity).admit(
      p,
      original.target,
      "schedule.manage",
      policyRevision,
      () =>
        this.options.storage.transaction((sql) => {
          const row = this.row(sql, jobID);
          const job = jobView(row);
          if (
            ["cancelled", "completed"].includes(job.state) ||
            !Number.isSafeInteger(row.schedule_revision + 1)
          )
            throw new DomainError("conflict");
          this.available(sql, job);
          this.block(sql, jobID, "rescheduled", false);
          const body = {
            ...JSON.parse(row.body),
            schedule,
            createdAt: this.time(sql),
          };
          sql
            .query(
              "UPDATE schedule_jobs SET schedule_revision=schedule_revision+1,body=?,next_index=0,next_due=? WHERE job_id=?",
            )
            .run(
              canonical(body),
              nextScheduleDue(schedule, 0, body.createdAt),
              jobID,
            );
          this.audit(sql, jobID, "rescheduled");
          return jobView(this.row(sql, jobID));
        }),
    );
  }
  /** Trusted worker API, not a public tool accepting principal/lease evidence. */
  claim(jobID: string, owner: string, ttlMs = 30_000): ScheduleLease {
    if (!nonempty(owner) || !integer(ttlMs) || ttlMs === 0)
      throw new DomainError("invalid_input");
    return this.options.storage.transaction((sql) => {
      this.running(sql);
      const now = this.time(sql);
      if (!integer(now + ttlMs)) throw new DomainError("invalid_input");
      const row = sql
        .query<JobRow, [string, number, string, number]>(
          "UPDATE schedule_jobs SET lease_owner=?,lease_generation=lease_generation+1,lease_until=? WHERE job_id=? AND lease_until<=? AND state='active' RETURNING *",
        )
        .get(owner, now + ttlMs, jobID, now);
      if (!row || !integer(row.lease_generation))
        throw new DomainError("conflict");
      return {
        jobID,
        owner,
        generation: row.lease_generation,
        expiresAt: row.lease_until,
      };
    });
  }
  private running(sql: Database): void {
    if (
      this.disposed ||
      sql
        .query<{ suspended: number }, []>(
          "SELECT suspended FROM schedule_clock WHERE singleton=1",
        )
        .get()?.suspended !== 0
    )
      throw new DomainError("unavailable");
  }
  private fenced(sql: Database, lease: ScheduleLease): JobRow {
    this.running(sql);
    const row = this.row(sql, lease.jobID);
    if (
      row.lease_owner !== lease.owner ||
      row.lease_generation !== lease.generation ||
      row.lease_until <= this.time(sql)
    )
      throw new DomainError("conflict");
    return row;
  }
  private eligible(
    sql: Database,
    row: JobRow,
    phase: "admission" | "dispatch",
  ): ScheduleJob {
    const job = jobView(row);
    if (job.state !== "active") throw new DomainError("conflict");
    if (job.expiresAt <= this.time(sql)) throw new DomainError("expired");
    if (job.runs >= job.maxRuns) throw new DomainError("rate_limited");
    this.available(sql, job);
    synchronous(this.options.limits.assert(sql, job, phase));
    return job;
  }
  /** Accumulate ranges, never emit one catch-up per missed index. Cron processing
   * is bounded per pass; no admission until its persisted cursor reaches now. */
  scan(batchSize = 100): void {
    if (!integer(batchSize) || batchSize < 1 || batchSize > 1000)
      throw new DomainError("invalid_input");
    this.options.storage.transaction((sql) => {
      this.running(sql);
      const now = this.time(sql);
      for (const row of sql
        .query<JobRow, [number, number]>(
          "SELECT * FROM schedule_jobs WHERE state='active' AND next_due<=? ORDER BY next_due,job_id LIMIT ?",
        )
        .all(now, batchSize)) {
        const job = jobView(row);
        if (job.expiresAt <= now || job.runs >= job.maxRuns) {
          this.block(
            sql,
            job.jobID,
            job.expiresAt <= now ? "expired" : "max_runs",
          );
          sql
            .query("UPDATE schedule_jobs SET state='completed' WHERE job_id=?")
            .run(job.jobID);
          continue;
        }
        let index = row.next_index;
        let due = row.next_due;
        if (due === null) continue;
        const firstIndex = index;
        const firstDue = due;
        let lastDue = due;
        if (job.schedule.kind === "interval") {
          index =
            Math.floor(
              (now - Date.parse(job.schedule.anchorUTC)) /
                job.schedule.periodMs,
            ) + 1;
          lastDue =
            Date.parse(job.schedule.anchorUTC) +
            (index - 1) * job.schedule.periodMs;
          due = nextScheduleDue(job.schedule, index, job.createdAt);
        } else {
          for (
            let steps = 0;
            steps < 512 && due !== null && due <= now;
            steps++
          ) {
            lastDue = due;
            due = nextScheduleDue(job.schedule, ++index, job.createdAt, due);
          }
        }
        const pending = sql
          .query<OccurrenceRow, [string]>(
            "SELECT * FROM schedule_occurrences WHERE job_id=? AND state='pending'",
          )
          .get(job.jobID);
        const id =
          pending?.occurrence_id ??
          occurrenceID(job.jobID, job.scheduleRevision, firstIndex);
        if (pending)
          sql
            .query(
              "UPDATE schedule_occurrences SET through_index=?,last_due=? WHERE occurrence_id=?",
            )
            .run(index - 1, lastDue, id);
        else
          sql
            .query(
              "INSERT INTO schedule_occurrences(occurrence_id,job_id,schedule_revision,due_index,through_index,due_at,last_due,state) VALUES(?,?,?,?,?,?,?,'pending')",
            )
            .run(
              id,
              job.jobID,
              job.scheduleRevision,
              firstIndex,
              index - 1,
              firstDue,
              lastDue,
            );
        sql
          .query(
            "UPDATE schedule_jobs SET next_index=?,next_due=? WHERE job_id=?",
          )
          .run(index, due, job.jobID);
        this.audit(sql, job.jobID, "due_range", id, {
          fromIndex: firstIndex,
          throughIndex: index - 1,
          firstDue,
          lastDue,
          observedAt: now,
        });
      }
      // A dispatch interrupted after its local commit is uncertain, not pending.
      const stale = sql
        .query<OccurrenceRow, [number]>(
          "SELECT o.* FROM schedule_occurrences o JOIN schedule_jobs j USING(job_id) WHERE o.state='dispatching' AND j.lease_until<=?",
        )
        .all(now);
      for (const occurrence of stale) {
        sql
          .query(
            "UPDATE schedule_occurrences SET state='unknown_outcome' WHERE occurrence_id=?",
          )
          .run(occurrence.occurrence_id);
        this.audit(
          sql,
          occurrence.job_id,
          "unknown_outcome",
          occurrence.occurrence_id,
        );
      }
    });
  }
  async admit(lease: ScheduleLease): Promise<ScheduleOccurrence | null> {
    const row = this.options.storage.transaction((sql) =>
      this.fenced(sql, lease),
    );
    const owner: Principal = JSON.parse(row.owner_json);
    const target = parseSessionRef(JSON.parse(row.target_json));
    const revision = this.options.storage.transaction(
      (sql) => this.snapshot(sql, owner, target).snapshot.revision,
    );
    const pending = this.options.storage.transaction((sql) =>
      sql
        .query<OccurrenceRow, [string]>(
          "SELECT * FROM schedule_occurrences WHERE job_id=? AND state='pending'",
        )
        .get(lease.jobID),
    );
    if (!pending) return null;
    const ready = this.options.storage.transaction((sql) => {
      const current = this.fenced(sql, lease);
      return (
        (current.next_due === null || current.next_due > this.time(sql)) &&
        !sql
          .query(
            "SELECT 1 FROM schedule_occurrences WHERE job_id=? AND state IN ('ready','dispatching','admitted','unknown_outcome')",
          )
          .get(lease.jobID)
      );
    });
    if (!ready) return null;
    const prompt: PromptInput = {
      target,
      content: jobView(row).content,
      expiresAt: jobView(row).expiresAt,
      expectedRevision: revision,
      idempotencyKey: `schedule:${pending.occurrence_id}`,
      policy: "queue",
    };
    const dispatcher = this.options.dispatcher(
      owner,
      this.deliveryAuthorization(owner, lease, pending.occurrence_id, prompt),
    );
    // T20 supplies its REAL operationID to the facade. The facade commits the
    // occurrence, both outboxes and T20 intent together; no host call is made here.
    await dispatcher.request(prompt);
    return this.options.storage.transaction((sql) =>
      occurrenceView(this.occurrence(sql, pending.occurrence_id)),
    );
  }
  private occurrence(sql: Database, id: string): OccurrenceRow {
    const row = sql
      .query<OccurrenceRow, [string]>(
        "SELECT o.*,b.operation_id FROM schedule_occurrences o LEFT JOIN schedule_outbox b USING(occurrence_id) WHERE o.occurrence_id=?",
      )
      .get(id);
    if (!row) throw new DomainError("not_found");
    return row;
  }
  private deliveryAuthorization(
    owner: Principal,
    lease: ScheduleLease,
    id: string,
    prompt?: PromptInput,
  ): DeliveryAuthorization {
    const identity = { current: async () => owner };
    const plain = this.authorizer(identity);
    const boundary = async <T>(
      phase: "intent" | "admission",
      principal: Principal,
      target: SessionRef,
      capability: Parameters<Authorizer["authorizeIntent"]>[2],
      revision: number,
      operationID: string,
      local: () => T,
    ): Promise<T> => {
      if (capability !== "message") throw new DomainError("unsupported");
      const facet = this.options.storage.transaction((sql) => {
        const row = this.fenced(sql, lease);
        const occurrence = this.occurrence(sql, id);
        if (
          canonical(principal) !== canonical(owner) ||
          row.owner_json !== canonical(owner) ||
          row.target_json !== canonical(target) ||
          occurrence.job_id !== lease.jobID ||
          occurrence.schedule_revision !== row.schedule_revision ||
          occurrence.occurrence_id !==
            occurrenceID(
              row.job_id,
              row.schedule_revision,
              occurrence.due_index,
            )
        )
          throw new DomainError("conflict");
        return {
          jobID: row.job_id,
          scheduleRevision: row.schedule_revision,
          occurrenceID: occurrence.occurrence_id,
        };
      });
      const guarded = this.authorizer(identity, (sql) => {
        const row = this.fenced(sql, lease);
        const occurrence = this.occurrence(sql, id);
        this.eligible(sql, row, phase === "intent" ? "admission" : "dispatch");
        if (
          row.schedule_revision !== facet.scheduleRevision ||
          row.owner_json !== canonical(owner) ||
          row.target_json !== canonical(target) ||
          occurrence.job_id !== facet.jobID ||
          occurrence.schedule_revision !== facet.scheduleRevision ||
          occurrence.occurrence_id !== facet.occurrenceID ||
          occurrence.state !== (phase === "intent" ? "pending" : "ready")
        )
          throw new DomainError("conflict");
        if (phase === "intent") {
          if (
            !prompt ||
            (row.next_due !== null && row.next_due <= this.time(sql)) ||
            sql
              .query(
                "SELECT 1 FROM schedule_occurrences WHERE job_id=? AND state IN ('ready','dispatching','admitted','unknown_outcome')",
              )
              .get(row.job_id)
          )
            throw new DomainError("conflict");
        } else if (occurrence.operation_id !== operationID)
          throw new DomainError("conflict");
      });
      return guarded.scheduledOperation(
        principal,
        target,
        revision,
        operationID,
        phase,
        () =>
          this.options.storage.transaction((sql) => {
            const current = this.snapshot(sql, owner, target);
            if (phase === "intent") {
              if (!prompt) throw new DomainError("unavailable");
              sql
                .query(
                  "UPDATE schedule_occurrences SET state='ready',grant_revision=?,policy_revision=? WHERE occurrence_id=? AND state='pending'",
                )
                .run(current.grantRevision, revision, id);
              sql
                .query(
                  "INSERT INTO schedule_outbox(occurrence_id,prompt_json,operation_id) VALUES(?,?,?)",
                )
                .run(id, canonical(prompt), operationID);
              this.audit(sql, lease.jobID, "local_admission", id, {
                grantRevision: current.grantRevision,
                leaseGeneration: lease.generation,
                operationID,
              });
            } else {
              sql
                .query(
                  "UPDATE schedule_occurrences SET state='dispatching',run_reserved=1,grant_revision=?,policy_revision=? WHERE occurrence_id=?",
                )
                .run(current.grantRevision, revision, id);
              sql
                .query("UPDATE schedule_jobs SET runs=runs+1 WHERE job_id=?")
                .run(lease.jobID);
              this.audit(sql, lease.jobID, "dispatching", id, {
                grantRevision: current.grantRevision,
                leaseGeneration: lease.generation,
              });
            }
            const result = local();
            synchronous(result);
            return result;
          }),
        facet,
      );
    };
    return {
      authorize: (...args) => {
        if (args[2] !== "message") throw new DomainError("unsupported");
        return plain.authorize(...args);
      },
      authorizeReplay: (...args) => plain.authorizeReplay(...args),
      authorizeIntent: (...args) => boundary("intent", ...args),
      admitOperation: (...args) => boundary("admission", ...args),
    };
  }
  async work(lease: ScheduleLease): Promise<void> {
    const ready = this.options.storage.transaction((sql) => {
      this.fenced(sql, lease);
      return sql
        .query<OccurrenceRow, [string]>(
          "SELECT * FROM schedule_occurrences WHERE job_id=? AND state='ready'",
        )
        .get(lease.jobID);
    });
    if (!ready) return;
    const owner: Principal = this.options.storage.transaction((sql) =>
      JSON.parse(this.row(sql, lease.jobID).owner_json),
    );
    const dispatcher = this.options.dispatcher(
      owner,
      this.deliveryAuthorization(owner, lease, ready.occurrence_id),
    );
    const operation = this.options.storage.transaction((sql) =>
      sql
        .query<Operation, [string]>(
          `SELECT p.operation_id AS operationID,p.state,p.payload_hash AS payloadHash,p.receipt_id AS receiptID,p.channel
       FROM operations p JOIN schedule_outbox b USING(operation_id) WHERE b.occurrence_id=?`,
        )
        .get(ready.occurrence_id),
    );
    if (!operation) throw new DomainError("unavailable");
    let result = operation;
    if (operation.state === "pending") {
      const revision = this.options.storage.transaction(
        (sql) =>
          this.snapshot(
            sql,
            owner,
            parseSessionRef(JSON.parse(this.row(sql, lease.jobID).target_json)),
          ).snapshot.revision,
      );
      result = await dispatcher.deliver(operation.operationID, revision);
    }
    this.options.storage.transaction((sql) => {
      this.fenced(sql, lease);
      this.recordDelivery(sql, ready.occurrence_id, result);
    });
  }
  private recordDelivery(sql: Database, id: string, result: Operation): void {
    const row = this.occurrence(sql, id);
    if (row.operation_id !== result.operationID)
      throw new DomainError("conflict");
    const state =
      result.state === "admitted"
        ? "admitted"
        : ["rejected", "expired"].includes(result.state)
          ? "rejected"
          : "unknown_outcome";
    if (state === "rejected" && row.run_reserved === 1) {
      sql
        .query("UPDATE schedule_jobs SET runs=runs-1 WHERE job_id=? AND runs>0")
        .run(row.job_id);
      sql
        .query(
          "UPDATE schedule_occurrences SET run_reserved=0 WHERE occurrence_id=?",
        )
        .run(id);
    }
    sql
      .query(
        "UPDATE schedule_occurrences SET state=?,evidence=CASE WHEN ?='rejected' THEN ? ELSE evidence END WHERE occurrence_id=?",
      )
      .run(state, state, result.state, id);
    this.audit(sql, row.job_id, state, id, {
      operationID: result.operationID,
      operationState: result.state,
    });
    this.finishExhausted(sql, row.job_id);
  }
  /** Only inspection can resolve uncertainty. This never calls deliver(). */
  async reconcile(id: string): Promise<void> {
    const row = this.options.storage.transaction((sql) =>
      this.occurrence(sql, id),
    );
    if (row.state !== "unknown_outcome" || row.operation_id === null)
      throw new DomainError("conflict");
    const operationID = row.operation_id;
    const job = this.options.storage.transaction((sql) =>
      this.row(sql, row.job_id),
    );
    const owner: Principal = JSON.parse(job.owner_json);
    const dispatcher = this.options.dispatcher(
      owner,
      this.authorizer({ current: async () => owner }),
    );
    dispatcher.recover();
    // T20 may have durably recorded a receipt before the scheduler worker lost
    // its lease/crashed. That existing receipt is not another host admission.
    const known = this.options.storage.transaction((sql) =>
      sql
        .query<
          Operation,
          [string]
        >(`SELECT operation_id AS operationID,state,payload_hash AS payloadHash,
        receipt_id AS receiptID,channel FROM operations WHERE operation_id=?`)
        .get(operationID),
    );
    if (!known) throw new DomainError("unavailable");
    if (known.state === "dispatching") return;
    if (known.state === "pending") throw new DomainError("conflict");
    const result =
      known.state === "unknown_outcome"
        ? await dispatcher.reconcile(operationID)
        : known;
    this.options.storage.transaction((sql) => {
      if (this.occurrence(sql, id).state !== "unknown_outcome")
        throw new DomainError("conflict");
      this.recordDelivery(sql, id, result);
    });
  }
  async collect(id: string): Promise<void> {
    if (!this.options.outcomes) throw new DomainError("unavailable");
    const occurrence = this.options.storage.transaction((sql) =>
      occurrenceView(this.occurrence(sql, id)),
    );
    if (
      !["admitted", "unknown_outcome"].includes(occurrence.state) ||
      occurrence.operationID === null
    )
      throw new DomainError("conflict");
    const proof = await this.options.outcomes.inspect(
      Object.freeze(occurrence),
    );
    if (proof === null) return;
    if (
      proof.occurrenceID !== id ||
      proof.operationID !== occurrence.operationID ||
      !["completed", "failed"].includes(proof.state) ||
      !nonempty(proof.evidence)
    )
      throw new DomainError("conflict");
    this.options.storage.transaction((sql) => {
      const row = this.occurrence(sql, id);
      if (
        row.operation_id !== proof.operationID ||
        !["admitted", "unknown_outcome"].includes(row.state)
      )
        throw new DomainError("conflict");
      sql
        .query(
          "UPDATE schedule_occurrences SET state=?,evidence=? WHERE occurrence_id=?",
        )
        .run(proof.state, proof.evidence, id);
      this.audit(sql, row.job_id, proof.state, id);
      const job = this.row(sql, row.job_id);
      if (
        (job.next_due === null || job.runs >= jobView(job).maxRuns) &&
        !sql
          .query(
            "SELECT 1 FROM schedule_occurrences WHERE job_id=? AND state='pending'",
          )
          .get(job.job_id)
      )
        sql
          .query(
            "UPDATE schedule_jobs SET state='completed' WHERE job_id=? AND state='active'",
          )
          .run(job.job_id);
    });
  }
  private clockCheck(): void {
    const utc = this.options.clock.utc();
    const mono = this.options.clock.monotonic();
    if (!integer(utc) || !Number.isFinite(mono) || mono < 0)
      throw new DomainError("unavailable");
    const last = this.sample;
    this.sample = { utc, mono };
    if (
      last &&
      (mono < last.mono || Math.abs(utc - last.utc - (mono - last.mono)) > 5000)
    ) {
      this.options.storage.transaction((sql) => {
        sql
          .query("UPDATE schedule_clock SET suspended=1 WHERE singleton=1")
          .run();
        sql
          .query(
            "UPDATE schedule_jobs SET lease_generation=lease_generation+1,lease_owner=NULL,lease_until=0",
          )
          .run();
      });
      throw new DomainError("unavailable");
    }
  }
  /** Trusted coordinator acknowledgement after a wall-clock discontinuity. */
  reconcileClock(): void {
    this.options.storage.transaction((sql) => {
      this.time(sql);
      sql
        .query("UPDATE schedule_clock SET suspended=0 WHERE singleton=1")
        .run();
    });
    this.sample = null;
    this.scan();
  }
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }
  private async runTick(): Promise<void> {
    this.clockCheck();
    this.scan();
    const candidates = this.options.storage.transaction((sql) => {
      const now = this.time(sql);
      return sql
        .query<
          { job_id: string },
          [number, number]
        >(`SELECT job_id FROM schedule_jobs j
        WHERE state='active' AND lease_until<=? AND (next_due IS NULL OR next_due>?) AND
        (EXISTS(SELECT 1 FROM schedule_occurrences o WHERE o.job_id=j.job_id AND o.state='ready') OR
        (EXISTS(SELECT 1 FROM schedule_occurrences o WHERE o.job_id=j.job_id AND o.state='pending') AND
         NOT EXISTS(SELECT 1 FROM schedule_occurrences o WHERE o.job_id=j.job_id AND o.state IN ('dispatching','admitted','unknown_outcome'))))
        ORDER BY job_id LIMIT 100`)
        .all(now, now);
    });
    for (const candidate of candidates) {
      let lease: ScheduleLease | undefined;
      try {
        lease = this.claim(candidate.job_id, crypto.randomUUID());
        await this.admit(lease);
        await this.work(lease);
      } catch (error) {
        if (
          error instanceof DomainError &&
          ["forbidden", "not_found", "expired", "rate_limited"].includes(
            error.code,
          )
        ) {
          this.options.storage.transaction((sql) => {
            if (lease) this.fenced(sql, lease);
            this.block(sql, candidate.job_id, error.code);
          });
        } else if (!(error instanceof DomainError && error.code === "conflict"))
          throw error;
      } finally {
        const held = lease;
        if (held)
          this.options.storage.transaction((sql) =>
            sql
              .query(
                "UPDATE schedule_jobs SET lease_owner=NULL,lease_until=0 WHERE job_id=? AND lease_owner=? AND lease_generation=?",
              )
              .run(held.jobID, held.owner, held.generation),
          );
      }
    }
  }
  start(periodMs = 1000): void {
    if (
      !integer(periodMs) ||
      periodMs < 1 ||
      periodMs > 60_000 ||
      this.disposed
    )
      throw new DomainError("invalid_input");
    if (this.started) return;
    this.started = true;
    const arm = (deadline: number) => {
      if (!this.started || this.disposed) return;
      this.cancelTimer = this.options.clock.setTimer(
        Math.max(0, deadline - this.options.clock.monotonic()),
        () => {
          this.cancelTimer = null;
          void this.tick()
            .catch((error) => this.options.onError?.(error))
            .finally(() => arm(this.options.clock.monotonic() + periodMs));
        },
      );
    };
    arm(this.options.clock.monotonic());
  }
  dispose(): void {
    this.disposed = true;
    this.started = false;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }
}

/** Cron uses a persisted previous instant, never re-enumerates history after reload. */
export function nextScheduleDue(
  schedule: Schedule,
  index: number,
  createdAt: number,
  previous?: number,
): number | null {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0
  )
    throw new DomainError("invalid_input");
  let due: number;
  switch (schedule.kind) {
    case "date":
      return index === 0 ? Date.parse(schedule.dueUTC) : null;
    case "timer":
      if (index !== 0) return null;
      due = createdAt + schedule.delayMs;
      break;
    case "interval":
      due = Date.parse(schedule.anchorUTC) + index * schedule.periodMs;
      break;
    case "cron": {
      if (index > 0 && previous === undefined)
        throw new DomainError("invalid_input");
      const parsed = Cron.parse(schedule.expression, schedule.timezone);
      if (Result.isFailure(parsed)) throw new DomainError("invalid_input");
      let cursor = previous ?? Date.parse(schedule.referenceUTC);
      // Effect normalizes a DST gap forward. Reject that nonmatching candidate;
      // bounded enumeration also fails closed for pathological/impossible dates.
      for (let tries = 0; tries < 16; tries++) {
        try {
          due = Cron.next(parsed.success, new Date(cursor)).getTime();
        } catch {
          throw new DomainError("invalid_input");
        }
        if (!Number.isSafeInteger(due) || due <= cursor)
          throw new DomainError("invalid_input");
        if (Cron.match(parsed.success, new Date(due))) return due;
        cursor = due;
      }
      throw new DomainError("invalid_input");
    }
  }
  if (!Number.isSafeInteger(due) || !Number.isFinite(new Date(due).getTime()))
    throw new DomainError("invalid_input");
  return due;
}
