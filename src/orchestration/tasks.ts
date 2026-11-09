import type { Database } from "bun:sqlite";
import {
  Authorizer,
  type TrustedPrincipalPort,
} from "../authorization/authorize";
import type { GrantPolicyPort } from "../authorization/grants";
import {
  canonical,
  DomainError,
  type Principal,
  parseSessionRef,
  parseTaskState,
  type SessionRef,
  type TaskState,
  transitionTask,
} from "../contracts";
import type { GroupActiveWorkPort, GroupRecord } from "../groups/service";
import type { Migration, Persistence } from "../persistence/database";

/** Fresh-schema descriptor, assigned a version by the bootstrap integrator.
 * Already-existing databases require a NEW explicit versioned migration to
 * rebuild these foreign keys and add task generation; this descriptor never
 * silently alters live tables.
 * Cascades cover plugin-owned graph/task metadata only, never host sessions. */
export const TASKS_MIGRATION: Omit<Migration, "version"> = {
  apply(sql) {
    sql.exec(`CREATE TABLE task_graphs(group_id TEXT PRIMARY KEY REFERENCES groups_records(group_id) ON DELETE CASCADE, revision INTEGER NOT NULL);
      CREATE TABLE task_records(task_id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES task_graphs(group_id) ON DELETE CASCADE, body TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0));
      CREATE INDEX task_group ON task_records(group_id);`);
  },
};
export interface TaskInput {
  objective: string;
  executor: SessionRef;
  expectedResult: string;
  dependencies: readonly string[];
}
export interface TaskRecord extends TaskInput {
  version: 1;
  taskID: string;
  groupID: string;
  author: Principal;
  state: TaskState;
}
export interface TaskGraph {
  groupID: string;
  revision: number;
  tasks: TaskRecord[];
}

/** INTERNAL trusted-runner commands. Never bind this port directly to model
 * payloads: final-result/cancellation evidence comes from the runner's host port. */
export type RunnerTaskAction = { kind: "execute" } | { kind: "cancel" };
export interface RunnerTaskContext {
  readonly task: Readonly<TaskRecord>;
  readonly graph: Readonly<TaskGraph>;
  readonly principal: Readonly<Principal>;
  readonly transitionKey: string;
  readonly taskGeneration: number;
}
export interface RunnerAdmissionEvidence {
  readonly admissionID: string;
  readonly groupID: string;
  readonly taskID: string;
  readonly owner: Principal;
  readonly operationID: string | null;
  readonly correlationID: string;
  readonly taskGeneration: number;
  readonly kind: "execution" | "cancellation";
}
export interface RunnerAdmissionEvidencePort {
  /** Trusted synchronous lookup in the supplied canonical SQL transaction.
   * Select the admission for this task's current generation and receipt kind;
   * never resolve IDs or ownership from caller/model payloads.
   * journal selects the stable active intent even when another receipt arrives.
   * accounting selects the admission bound to the earliest persisted eligible
   * receipt sequence, with a stable tie-breaker. The runner owns that ordering;
   * Tasks validates the selected binding and never accepts a caller selection.
   * Once a terminal transition wins, transitionTask rejects later receipts. */
  lookup(
    sql: Database,
    groupID: string,
    taskID: string,
    principal: Principal,
    purpose: "journal" | "accounting",
  ): RunnerAdmissionEvidence | null;
}
export interface TaskOutcomeEvidence {
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
}
export interface TaskOutcomePort {
  /** Persisted, verified host receipt only. Fetch/verify it asynchronously OUTSIDE
   * this port; this lookup does no host/network I/O and accepts no payload proof. */
  lookup(
    sql: Database,
    admission: RunnerAdmissionEvidence,
  ): TaskOutcomeEvidence | null;
}
export interface RunnerAccountingPorts {
  readonly admissions: RunnerAdmissionEvidencePort;
  readonly outcomes: TaskOutcomePort;
}
const terminal = new Set<TaskState>(["completed", "failed", "cancelled"]);
function text(v: unknown): asserts v is string {
  if (typeof v !== "string" || !v.trim())
    throw new DomainError("invalid_input");
}
function input(v: TaskInput): TaskInput {
  if (!v || typeof v !== "object") throw new DomainError("invalid_input");
  text(v.objective);
  text(v.expectedResult);
  if (!Array.isArray(v.dependencies)) throw new DomainError("invalid_input");
  for (const d of v.dependencies) text(d);
  if (new Set(v.dependencies).size !== v.dependencies.length)
    throw new DomainError("invalid_input");
  return {
    objective: v.objective,
    expectedResult: v.expectedResult,
    executor: parseSessionRef(v.executor),
    dependencies: [...v.dependencies],
  };
}
export function validateTaskGraph(
  tasks: readonly Pick<TaskRecord, "taskID" | "dependencies">[],
): void {
  const graph = new Map(tasks.map((t) => [t.taskID, t.dependencies]));
  if (graph.size !== tasks.length) throw new DomainError("conflict");
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (done.has(id)) return;
    const dependencies = graph.get(id);
    if (visiting.has(id) || !dependencies) throw new DomainError("conflict");
    visiting.add(id);
    for (const dep of dependencies) visit(dep);
    visiting.delete(id);
    done.add(id);
  };
  for (const id of graph.keys()) visit(id);
}

/** Required job adapter is T29's boundary. It must query this canonical DB,
 * synchronously and fail closed when jobs storage is unavailable. */
export function taskActiveWork(
  storage: Persistence,
  jobs: { active(sql: Database, groupID: string): boolean },
): GroupActiveWorkPort {
  const canonicalSQL = storage.transaction((sql) => sql);
  return {
    snapshot(sql, groupID) {
      if (
        sql !== canonicalSQL ||
        !sql.inTransaction ||
        !jobs ||
        typeof jobs.active !== "function"
      )
        throw new DomainError("unavailable");
      const tasks = sql
        .query<{ body: string }, [string]>(
          "SELECT body FROM task_records WHERE group_id=?",
        )
        .all(groupID);
      const activeJobs = jobs.active(sql, groupID);
      if (typeof activeJobs !== "boolean") throw new DomainError("unavailable");
      return {
        activeJobs,
        activeTasks: tasks.some(
          (row) => !terminal.has(parseTaskState(JSON.parse(row.body).state)),
        ),
      };
    },
  };
}

/** Local DAG persistence, not a runner. Identity/policy are trusted adapters,
 * never supplied by tool payload. All admissions use this canonical Persistence.
 * No journal is wired here: T22 integration must use the identical database. */
export class Tasks {
  constructor(
    private readonly storage: Persistence,
    private readonly identity: TrustedPrincipalPort,
    private readonly policy: GrantPolicyPort,
    private readonly clock: () => number,
    private readonly accounting?: RunnerAccountingPorts,
  ) {}

  private load(
    sql: Database,
    groupID: string,
  ): { group: GroupRecord; graph: TaskGraph } {
    text(groupID);
    const row = sql
      .query<{ body: string }, [string]>(
        "SELECT body FROM groups_records WHERE group_id=?",
      )
      .get(groupID);
    if (!row) throw new DomainError("not_found");
    const revision =
      sql
        .query<{ revision: number }, [string]>(
          "SELECT revision FROM task_graphs WHERE group_id=?",
        )
        .get(groupID)?.revision ?? 0;
    return {
      group: JSON.parse(row.body),
      graph: {
        groupID,
        revision,
        tasks: sql
          .query<{ body: string }, [string]>(
            "SELECT body FROM task_records WHERE group_id=? ORDER BY task_id",
          )
          .all(groupID)
          .map((r) => JSON.parse(r.body) as TaskRecord),
      },
    };
  }

  private async access<T>(
    groupID: string,
    extra: readonly SessionRef[],
    write: boolean,
    expected: number | undefined,
    effect: (sql: Database, graph: TaskGraph, principal: Principal) => T,
    runner?: { taskID: string; scopeOnly: boolean; selectedOnly?: boolean },
  ): Promise<T> {
    const principal = await this.identity.current();
    if (!principal) throw new DomainError("forbidden");
    const before = this.storage.transaction((sql) => this.load(sql, groupID));
    if (runner) this.task(before.graph, runner.taskID);
    const checkedAt = this.clock();
    if (!Number.isSafeInteger(checkedAt) || checkedAt < 0)
      throw new DomainError("unavailable");
    const snapshots = new Map<string, string>();
    const assertFreshTime = () => {
      const now = this.clock();
      if (!Number.isSafeInteger(now) || now < checkedAt)
        throw new DomainError("unavailable");
      // Secondary targets were checked asynchronously. A stable snapshot alone
      // cannot fence an expiry crossed before this synchronous local commit.
      for (const value of snapshots.values()) {
        const snapshot = JSON.parse(value);
        const expiries = [
          snapshot.operator?.expiresAt,
          snapshot.approval?.expiresAt,
          ...snapshot.grants.map(
            (g: { expiresAt: string | null }) => g.expiresAt,
          ),
        ];
        if (
          expiries.some(
            (expiry) =>
              expiry !== null &&
              expiry !== undefined &&
              Date.parse(expiry) > checkedAt &&
              Date.parse(expiry) <= now,
          )
        )
          throw new DomainError("conflict");
      }
    };
    const auth = new Authorizer(
      this.identity,
      {
        read: async (p, t) =>
          this.storage.transaction((sql) => {
            const snapshot = this.policy.load(sql, p, t);
            snapshots.set(canonical(t), canonical(snapshot));
            return snapshot;
          }),
        admission: (p, t, check) =>
          this.storage.transaction((sql) => {
            assertFreshTime();
            for (const [ref, snapshot] of snapshots) {
              if (
                canonical(this.policy.load(sql, p, JSON.parse(ref))) !==
                snapshot
              )
                throw new DomainError("conflict");
            }
            const snapshot = this.policy.load(sql, p, t);
            const result = check(snapshot);
            this.policy.save(sql, snapshot);
            return result;
          }),
      },
      this.clock,
    );
    const refs = [
      before.group.scope,
      ...(runner?.scopeOnly
        ? []
        : runner?.selectedOnly
          ? [this.task(before.graph, runner.taskID).executor]
          : before.graph.tasks.map((t) => t.executor)),
      ...extra,
    ];
    for (const ref of new Map(refs.map((r) => [canonical(r), r])).values()) {
      if (ref.instanceID !== before.group.scope.instanceID)
        throw new DomainError("conflict");
      await auth.authorize(principal, ref, write ? "task.dispatch" : "read");
    }
    const commit = () =>
      this.storage.transaction((sql) => {
        assertFreshTime();
        if (!write)
          for (const [ref, snapshot] of snapshots) {
            if (
              canonical(this.policy.load(sql, principal, JSON.parse(ref))) !==
              snapshot
            )
              throw new DomainError("conflict");
          }
        const current = this.load(sql, groupID);
        if (canonical(current) !== canonical(before))
          throw new DomainError("conflict");
        if (expected !== undefined && current.graph.revision !== expected)
          throw new DomainError("conflict");
        return effect(sql, current.graph, principal);
      });
    if (!write) return commit();
    const scopeJSON = snapshots.get(canonical(before.group.scope));
    if (!scopeJSON) throw new DomainError("unavailable");
    const scopeSnapshot = JSON.parse(scopeJSON);
    return auth.admit(
      principal,
      before.group.scope,
      "task.dispatch",
      scopeSnapshot.revision,
      commit,
    );
  }

  private save(sql: Database, graph: TaskGraph): TaskGraph {
    validateTaskGraph(graph.tasks);
    graph.tasks.sort((a, b) =>
      a.taskID < b.taskID ? -1 : a.taskID > b.taskID ? 1 : 0,
    );
    graph.revision++;
    sql
      .query(
        "INSERT INTO task_graphs VALUES (?,?) ON CONFLICT(group_id) DO UPDATE SET revision=excluded.revision",
      )
      .run(graph.groupID, graph.revision);
    for (const task of graph.tasks)
      sql
        .query(
          "INSERT INTO task_records(task_id,group_id,body) VALUES (?,?,?) ON CONFLICT(task_id) DO UPDATE SET body=excluded.body",
        )
        .run(task.taskID, graph.groupID, canonical(task));
    return graph;
  }
  get(groupID: string): Promise<TaskGraph> {
    return this.access(groupID, [], false, undefined, (_sql, graph) => graph);
  }
  async create(
    groupID: string,
    value: TaskInput,
    expectedRevision: number,
  ): Promise<TaskGraph> {
    const metadata = input(value);
    this.revision(expectedRevision);
    return this.access(
      groupID,
      [metadata.executor],
      true,
      expectedRevision,
      (sql, graph, principal) => {
        graph.tasks.push({
          ...metadata,
          version: 1,
          taskID: crypto.randomUUID(),
          groupID,
          author: structuredClone(principal),
          state: "pending",
        });
        this.block(graph);
        return this.save(sql, graph);
      },
    );
  }
  private revision(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0)
      throw new DomainError("invalid_input");
  }
  private task(graph: TaskGraph, taskID: string): TaskRecord {
    text(taskID);
    const task = graph.tasks.find((t) => t.taskID === taskID);
    if (!task) throw new DomainError("not_found");
    return task;
  }
  private block(graph: TaskGraph): void {
    const blocked = new Set(
      graph.tasks
        .filter((t) => ["failed", "cancelled", "blocked"].includes(t.state))
        .map((t) => t.taskID),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of graph.tasks)
        if (
          !blocked.has(t.taskID) &&
          t.dependencies.some((d) => blocked.has(d))
        ) {
          if (t.state !== "pending") throw new DomainError("conflict");
          t.state = transitionTask(t.state, "blocked");
          blocked.add(t.taskID);
          changed = true;
        }
    }
  }
  /** INTERNAL state primitive, not a transport API. Transport handlers must use
   * runner admission/accounting for terminal outcomes, never caller text or
   * bare evidence flags. Keep this boundary at the T31 tool surface. */
  async transition(
    groupID: string,
    taskID: string,
    state: TaskState,
    expectedRevision: number,
  ): Promise<TaskGraph> {
    this.revision(expectedRevision);
    parseTaskState(state);
    return this.access(groupID, [], true, expectedRevision, (sql, graph) => {
      const task = this.task(graph, taskID);
      if (
        state === "running" &&
        task.dependencies.some((d) => this.task(graph, d).state !== "completed")
      )
        throw new DomainError("conflict");
      task.state = transitionTask(task.state, state);
      this.block(graph);
      return this.save(sql, graph);
    });
  }

  /** INTERNAL only. No dispatch/network calls inside callback. Its synchronous
   * local intent and the task transition share the canonical transaction,
   * including CAS, fresh authorization and once-approval consumption. Throws
   * conflict on readiness/limit/CAS failure, preserving pending/waiting state.
   * Fixed per-group ceilings (4 active, DAG depth 4) are not client options. */
  async runnerTransition<T>(
    groupID: string,
    taskID: string,
    action: RunnerTaskAction,
    expectedGraphRevision: number,
    callback: (sql: Database, context: RunnerTaskContext) => T,
  ): Promise<{ graph: TaskGraph; value: T }> {
    this.revision(expectedGraphRevision);
    text(taskID);
    if (!action || typeof action !== "object" || typeof callback !== "function")
      throw new DomainError("invalid_input");
    const cancellation = action.kind === "cancel";
    if (!["execute", "cancel"].includes(action.kind))
      throw new DomainError("invalid_input");
    return this.access(
      groupID,
      [],
      true,
      expectedGraphRevision,
      (sql, graph, principal) => {
        const task = this.task(graph, taskID);
        let next: TaskState;
        if (action.kind === "execute") {
          if (task.state !== "pending") throw new DomainError("conflict");
          if (
            task.dependencies.some(
              (id) => this.task(graph, id).state !== "completed",
            )
          )
            throw new DomainError("conflict");
          validateTaskGraph(graph.tasks);
          const depths = new Map<string, number>();
          const depth = (id: string): number => {
            const cached = depths.get(id);
            if (cached !== undefined) return cached;
            const n =
              1 + Math.max(0, ...this.task(graph, id).dependencies.map(depth));
            depths.set(id, n);
            return n;
          };
          const active = graph.tasks.filter((t) =>
            [
              "running",
              "awaiting_input",
              "awaiting_approval",
              "cancel_requested",
            ].includes(t.state),
          );
          if (
            depth(taskID) > 4 ||
            active.filter((t) => t.taskID !== taskID).length >= 4
          )
            throw new DomainError("conflict");
          next = "running";
        } else {
          next =
            task.state === "pending" || task.state === "blocked"
              ? "cancelled"
              : "cancel_requested";
        }
        task.state = transitionTask(task.state, next);
        this.block(graph);
        this.save(sql, graph);
        if (action.kind === "execute")
          sql
            .query(
              "UPDATE task_records SET generation=generation+1 WHERE task_id=?",
            )
            .run(taskID);
        // Detached views cannot mutate trusted rows or the returned graph.
        const context: RunnerTaskContext = {
          task: structuredClone(task),
          graph: structuredClone(graph),
          principal: structuredClone(principal),
          transitionKey: `task:${taskID}:revision:${graph.revision}:state:${next}`,
          taskGeneration: this.generation(sql, taskID),
        };
        const value = callback(sql, context);
        if (
          value !== null &&
          (typeof value === "object" || typeof value === "function") &&
          "then" in value &&
          typeof value.then === "function"
        )
          throw new DomainError("invalid_input");
        return { graph, value };
      },
      { taskID, scopeOnly: cancellation },
    );
  }

  private generation(sql: Database, taskID: string): number {
    const value = sql
      .query<{ generation: number }, [string]>(
        "SELECT generation FROM task_records WHERE task_id=?",
      )
      .get(taskID)?.generation;
    if (value === undefined || !Number.isSafeInteger(value) || value < 0)
      throw new DomainError("conflict");
    return value;
  }

  private admission(
    sql: Database,
    groupID: string,
    taskID: string,
    principal: Principal,
    journal: boolean,
  ): RunnerAdmissionEvidence {
    this.task(this.load(sql, groupID).graph, taskID);
    const port = this.accounting?.admissions;
    if (!port || typeof port.lookup !== "function")
      throw new DomainError("unavailable");
    const admission = port.lookup(
      sql,
      groupID,
      taskID,
      principal,
      journal ? "journal" : "accounting",
    );
    if (!admission) throw new DomainError("not_found");
    text(admission.admissionID);
    text(admission.correlationID);
    if (!journal || admission.operationID !== null) text(admission.operationID);
    if (
      admission.groupID !== groupID ||
      admission.taskID !== taskID ||
      !["execution", "cancellation"].includes(admission.kind) ||
      admission.taskGeneration !== this.generation(sql, taskID) ||
      (admission.kind === "execution" && admission.taskGeneration < 1)
    )
      throw new DomainError("conflict");
    // Owner is structurally checked and authenticated by authorizeReplay before
    // any callback; equality with this detached snapshot is rechecked in commit.
    return structuredClone(admission);
  }

  /** INTERNAL local runner journal only: no task/graph/generation mutation,
   * no dispatch admission and no approval consumption. An existing admitted
   * intent may have operationID=null while the runner claims a lease or records
   * the eventual dispatcher operation. No outcome receipt is required here. */
  async runnerJournal<T>(
    groupID: string,
    taskID: string,
    expectedGraphRevision: number,
    callback: (sql: Database, context: RunnerTaskContext) => T,
  ): Promise<T> {
    this.revision(expectedGraphRevision);
    text(groupID);
    text(taskID);
    if (typeof callback !== "function") throw new DomainError("invalid_input");
    const principal = await this.identity.current();
    if (!principal) throw new DomainError("forbidden");
    const before = this.storage.transaction((sql) =>
      this.admission(sql, groupID, taskID, principal, true),
    );
    const auth = new Authorizer(
      this.identity,
      {
        read: async (p, ref) =>
          this.storage.transaction((sql) => this.policy.load(sql, p, ref)),
      },
      this.clock,
    );
    await auth.authorizeReplay(principal, before.owner);
    return this.access(
      groupID,
      [],
      false,
      expectedGraphRevision,
      (sql, graph, currentPrincipal) => {
        if (canonical(currentPrincipal) !== canonical(principal))
          throw new DomainError("forbidden");
        if (
          canonical(this.admission(sql, groupID, taskID, principal, true)) !==
          canonical(before)
        )
          throw new DomainError("conflict");
        const snapshot = canonical(this.load(sql, groupID));
        const generations = () =>
          canonical(
            sql
              .query<{ task_id: string; generation: number }, [string]>(
                "SELECT task_id,generation FROM task_records WHERE group_id=? ORDER BY task_id",
              )
              .all(groupID),
          );
        const generationSnapshot = generations();
        const task = this.task(graph, taskID);
        const value = callback(sql, {
          task: structuredClone(task),
          graph: structuredClone(graph),
          principal: structuredClone(principal),
          taskGeneration: before.taskGeneration,
          transitionKey: `task:${taskID}:revision:${graph.revision}:state:${task.state}`,
        });
        if (
          value !== null &&
          (typeof value === "object" || typeof value === "function") &&
          "then" in value &&
          typeof value.then === "function"
        )
          throw new DomainError("invalid_input");
        const after = this.admission(sql, groupID, taskID, principal, true);
        if (
          canonical(this.load(sql, groupID)) !== snapshot ||
          generations() !== generationSnapshot ||
          canonical({ ...after, operationID: before.operationID }) !==
            canonical(before) ||
          (before.operationID !== null &&
            after.operationID !== before.operationID)
        )
          throw new DomainError("conflict");
        return value;
      },
      { taskID, scopeOnly: true },
    );
  }

  /** INTERNAL accounting of an already admitted execution/cancellation. Read
   * authority + replay ownership only: never consumes another once approval.
   * The host receipt is selected by trusted persisted ports, NOT by the caller.
   * Execution completion/failure from cancel_requested follows transitionTask;
   * cancellation requires its own matching cancellation admission and receipt. */
  async runnerAccount<T>(
    groupID: string,
    taskID: string,
    expectedGraphRevision: number,
    callback: (sql: Database, context: RunnerTaskContext) => T,
  ): Promise<{ graph: TaskGraph; value: T }> {
    this.revision(expectedGraphRevision);
    text(groupID);
    text(taskID);
    const ports = this.accounting;
    if (
      !ports ||
      typeof ports.admissions?.lookup !== "function" ||
      typeof ports.outcomes?.lookup !== "function"
    )
      throw new DomainError("unavailable");
    if (typeof callback !== "function") throw new DomainError("invalid_input");
    const principal = await this.identity.current();
    if (!principal) throw new DomainError("forbidden");
    const lookup = (sql: Database) => {
      const admission = this.admission(sql, groupID, taskID, principal, false);
      const outcome = ports.outcomes.lookup(sql, structuredClone(admission));
      if (!outcome) throw new DomainError("not_found");
      if (
        outcome.admissionID !== admission.admissionID ||
        outcome.operationID !== admission.operationID ||
        outcome.correlationID !== admission.correlationID ||
        outcome.taskGeneration !== admission.taskGeneration ||
        ![
          "completed",
          "failed",
          "cancelled",
          "awaiting_input",
          "awaiting_approval",
          "running",
        ].includes(outcome.state) ||
        (outcome.state === "cancelled"
          ? admission.kind !== "cancellation"
          : admission.kind !== "execution")
      )
        throw new DomainError("conflict");
      return structuredClone({ admission, outcome });
    };
    const before = this.storage.transaction(lookup);
    const auth = new Authorizer(
      this.identity,
      {
        read: async (p, ref) =>
          this.storage.transaction((sql) => this.policy.load(sql, p, ref)),
      },
      this.clock,
    );
    await auth.authorizeReplay(principal, before.admission.owner);
    return this.access(
      groupID,
      [],
      false,
      expectedGraphRevision,
      (sql, graph, currentPrincipal) => {
        if (canonical(currentPrincipal) !== canonical(principal))
          throw new DomainError("forbidden");
        if (canonical(lookup(sql)) !== canonical(before))
          throw new DomainError("conflict");
        const task = this.task(graph, taskID);
        task.state = transitionTask(task.state, before.outcome.state);
        this.block(graph);
        this.save(sql, graph);
        const context: RunnerTaskContext = {
          task: structuredClone(task),
          graph: structuredClone(graph),
          principal: structuredClone(principal),
          transitionKey: `task:${taskID}:revision:${graph.revision}:state:${task.state}`,
          taskGeneration: this.generation(sql, taskID),
        };
        const value = callback(sql, context);
        if (
          value !== null &&
          (typeof value === "object" || typeof value === "function") &&
          "then" in value &&
          typeof value.then === "function"
        )
          throw new DomainError("invalid_input");
        return { graph, value };
      },
      {
        taskID,
        scopeOnly: before.outcome.state === "cancelled",
        selectedOnly: true,
      },
    );
  }
  /** INTERNAL graph primitive; do not expose as caller-supplied outcome evidence
   * at the T31 transport surface. Terminal outcomes belong to runner accounting.
   * Replans dependencies only; terminal states cannot be reopened. Unblocking
   * is explicit for each named task, never a side effect of upstream success. */
  async replan(
    groupID: string,
    changes: readonly {
      taskID: string;
      dependencies: readonly string[];
      replanned: boolean;
    }[],
    expectedRevision: number,
  ): Promise<TaskGraph> {
    this.revision(expectedRevision);
    if (!Array.isArray(changes) || !changes.length)
      throw new DomainError("invalid_input");
    for (const change of changes) {
      if (
        !change ||
        typeof change !== "object" ||
        typeof change.replanned !== "boolean"
      )
        throw new DomainError("invalid_input");
      text(change.taskID);
    }
    if (new Set(changes.map((c) => c.taskID)).size !== changes.length)
      throw new DomainError("invalid_input");
    return this.access(groupID, [], true, expectedRevision, (sql, graph) => {
      for (const change of changes) {
        const task = this.task(graph, change.taskID);
        if (
          terminal.has(task.state) ||
          (task.state !== "pending" && task.state !== "blocked")
        )
          throw new DomainError("conflict");
        task.dependencies = input({
          ...task,
          dependencies: change.dependencies,
        }).dependencies;
        if (task.state === "blocked")
          task.state = transitionTask("blocked", "pending", {
            replanned: change.replanned,
          });
      }
      validateTaskGraph(graph.tasks);
      this.block(graph);
      return this.save(sql, graph);
    });
  }
}
