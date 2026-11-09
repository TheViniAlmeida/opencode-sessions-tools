import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AuthorizationSnapshot } from "../../src/authorization/authorize";
import { GRANTS_MIGRATION, Grants } from "../../src/authorization/grants";
import {
  type Capability,
  capabilities,
  DomainError,
  occurrenceID,
  type Principal,
  type SessionRef,
} from "../../src/contracts";
import { GROUPS_MIGRATION, Groups } from "../../src/groups/service";
import {
  Dispatcher,
  dispatcherMigration,
  type NativePrompt,
} from "../../src/messaging/dispatcher";
import { TASKS_MIGRATION, taskActiveWork } from "../../src/orchestration/tasks";
import { Persistence } from "../../src/persistence/database";
import {
  operationsMigration,
  pendingGrantOperations,
} from "../../src/persistence/operations";
import { SCHEDULES_MIGRATION, Scheduler } from "../../src/schedules/service";
import { openSyntheticScheduler } from "./fixtures/schedules-worker";

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("missing synthetic evidence");
  return value;
}

function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  GRANTS_MIGRATION.apply(db, "synthetic");
  db.exec(operationsMigration.sql);
  db.exec(dispatcherMigration.sql);
  GROUPS_MIGRATION.apply(db, "synthetic");
  TASKS_MIGRATION.apply(db, "synthetic");
  SCHEDULES_MIGRATION.apply(db, "synthetic");
  const storage = new Persistence(db, () => {});
  const target: SessionRef = {
    version: 1,
    instanceID: "fixture",
    projectID: "project",
    sessionID: "target",
  };
  const principal: Principal = {
    kind: "operator",
    operatorID: "operator",
    instanceID: "fixture",
    revision: 1,
  };
  const identity = { current: async () => principal };
  let now = 1000;
  let denied: readonly Capability[] = [];
  let profile: AuthorizationSnapshot["profile"] = "bounded-auto";
  let policyRevision = 1;
  let operatorExpiry: string | null = null;
  let limited = false;
  let unknown = false;
  let rejected = false;
  let afterRequest: (() => void) | null = null;
  let afterSend: (() => void) | null = null;
  let loseRequest = false;
  let failCommit = false;
  let removed = false;
  let wall = 1000;
  let mono = 1000;
  db.exec(
    "CREATE TABLE synthetic_approval(body TEXT NOT NULL); INSERT INTO synthetic_approval VALUES('null')",
  );
  const readApproval = (): AuthorizationSnapshot["approval"] =>
    JSON.parse(
      required(
        db
          .query<{ body: string }, []>("SELECT body FROM synthetic_approval")
          .get(),
      ).body,
    );
  const timers = new Map<number, () => void>();
  let timerID = 0;
  const outcomes = new Map<
    string,
    {
      occurrenceID: string;
      operationID: string;
      state: "completed";
      evidence: string;
    }
  >();
  const policy = {
    load: (): AuthorizationSnapshot => {
      const snapshot: AuthorizationSnapshot = {
        revision: policyRevision,
        profile,
        profileCapabilities: capabilities,
        policyCapabilities: capabilities,
        hostCapabilities: capabilities,
        deniedCapabilities: denied,
        grants: [],
        operator: {
          operatorID: "operator",
          instanceID: "fixture",
          revision: 1,
          capabilities,
          projects: ["project"],
          expiresAt: operatorExpiry,
        },
        delegationCapabilities: null,
        approval: readApproval(),
      };
      return snapshot;
    },
    save(_sql: Database, snapshot: AuthorizationSnapshot) {
      db.query("UPDATE synthetic_approval SET body=?").run(
        JSON.stringify(snapshot.approval),
      );
    },
  };
  const clock = {
    utc: () => wall,
    monotonic: () => mono,
    setTimer: (_delay: number, callback: () => void) => {
      const id = ++timerID;
      timers.set(id, callback);
      return () => {
        timers.delete(id);
      };
    },
  };
  const grants = new Grants(
    storage,
    identity,
    policy,
    pendingGrantOperations(() => now),
    () => now,
  );
  const sends: NativePrompt[] = [];
  const options = {
    storage,
    identity,
    policy,
    grants,
    clock,
    coordinator: {
      now: (sql: Database) => {
        expect(sql.inTransaction).toBe(true);
        return now;
      },
    },
    targets: {
      assertAvailable() {
        if (removed) throw new DomainError("not_found");
      },
    },
    limits: {
      assert() {
        if (limited) throw new Error("synthetic limit unavailable");
        if (failCommit)
          db.exec("INSERT INTO nonexistent_synthetic_table VALUES(1)");
      },
    },
    outcomes: {
      async inspect(o: { occurrenceID: string }) {
        return outcomes.get(o.occurrenceID) ?? null;
      },
    },
    dispatcher: (
      owner: Principal,
      authorization: ConstructorParameters<typeof Dispatcher>[2],
    ) => {
      const dispatcher = new Dispatcher(
        storage,
        { current: async () => owner },
        authorization,
        { current: async () => null },
        {
          async send(prompt: NativePrompt) {
            expect(db.inTransaction).toBe(false);
            sends.push(prompt);
            afterSend?.();
            if (rejected) return { state: "rejected" as const };
            return unknown
              ? { state: "unknown_outcome" as const }
              : { state: "accepted" as const, messageID: prompt.messageID };
          },
          async inspect() {
            return { state: "unknown_outcome" as const };
          },
        },
        () => now,
        { assertAvailable() {} },
      );
      return {
        request: async (input: unknown) => {
          const op = await dispatcher.request(input);
          afterRequest?.();
          if (loseRequest) {
            loseRequest = false;
            throw new Error("synthetic lost enqueue response");
          }
          return op;
        },
        deliver: dispatcher.deliver.bind(dispatcher),
        recover: dispatcher.recover.bind(dispatcher),
        reconcile: dispatcher.reconcile.bind(dispatcher),
      };
    },
  };
  const scheduler = new Scheduler(options);
  const create = (overrides: Record<string, unknown> = {}) =>
    scheduler.create(
      {
        target,
        content: "synthetic",
        schedule: {
          version: 1,
          kind: "interval",
          timezone: "UTC",
          anchorUTC: "1970-01-01T00:00:01.000Z",
          periodMs: 300_000,
        },
        expiresAt: 10_000_000,
        maxRuns: 10,
        groupID: null,
        ...overrides,
      },
      policyRevision,
    );
  return {
    supervised: () => {
      profile = "supervised";
    },
    approve: (capability: Capability = "schedule.manage") => {
      db.query("UPDATE synthetic_approval SET body=?").run(
        JSON.stringify({
          principal,
          target,
          capability,
          revision: policyRevision,
          expiresAt: new Date(now + 100_000).toISOString(),
          mode: "once",
        }),
      );
    },
    approval: readApproval,
    nativeReject: () => {
      rejected = true;
    },
    db,
    storage,
    scheduler,
    options,
    sends,
    target,
    create,
    timers,
    outcomes,
    identity,
    policy,
    principal,
    deny: (caps: readonly Capability[]) => {
      denied = caps;
    },
    policyRevision: (revision: number) => {
      policyRevision = revision;
    },
    expireOperator: () => {
      operatorExpiry = "1970-01-01T00:00:01.000Z";
    },
    limit: () => {
      limited = true;
    },
    unknown: () => {
      unknown = true;
    },
    afterRequest: (f: () => void) => {
      afterRequest = f;
    },
    afterSend: (f: () => void) => {
      afterSend = f;
    },
    loseRequest: () => {
      loseRequest = true;
    },
    failCommit: () => {
      failCommit = true;
    },
    removeTarget: () => {
      removed = true;
    },
    advance: (at: number) => {
      now = at;
      wall = at;
      mono = at;
    },
    jumpWall: () => {
      wall += 20_000;
    },
    close: () => {
      scheduler.dispose();
      storage.close();
    },
  };
}

test("supervised once is reserved against REAL T20 operation and consumed only at final admission", async () => {
  const f = fixture();
  try {
    f.supervised();
    f.approve();
    const job = await f.create();
    expect(f.approval()).toBeNull();
    f.policyRevision(7);
    f.approve();
    f.scheduler.scan();
    const lease = f.scheduler.claim(job.jobID, "worker");
    const admitted = required(await f.scheduler.admit(lease));
    expect(admitted.state).toBe("ready");
    expect(admitted.policyRevision).toBe(7);
    expect(admitted.scheduleRevision).toBe(1);
    expect(admitted.operationID).not.toBe(admitted.occurrenceID);
    expect(f.approval()).toMatchObject({
      operationID: admitted.operationID,
      scheduled: {
        modality: "scheduled-message",
        occurrence: {
          jobID: job.jobID,
          scheduleRevision: 1,
          occurrenceID: admitted.occurrenceID,
        },
      },
    });
    expect((await f.scheduler.get(job.jobID)).runs).toBe(0);
    expect(f.sends).toHaveLength(0);
    await new Scheduler(f.options).work(lease);
    expect(f.sends).toHaveLength(1);
    expect(f.approval()).toBeNull();
    expect((await f.scheduler.get(job.jobID)).runs).toBe(1);
    const first = required((await f.scheduler.occurrences(job.jobID))[0]);
    f.outcomes.set(first.occurrenceID, {
      occurrenceID: first.occurrenceID,
      operationID: required(first.operationID),
      state: "completed",
      evidence: "synthetic terminal",
    });
    await f.scheduler.collect(first.occurrenceID);
    f.advance(301_000);
    await f.scheduler.tick();
    expect(f.sends).toHaveLength(1);
    expect((await f.scheduler.get(job.jobID)).runs).toBe(1);
    f.advance(601_000);
    f.approve();
    await f.scheduler.tick();
    expect(f.sends).toHaveLength(2);
    expect(f.approval()).toBeNull();
  } finally {
    f.close();
  }
});

test("supervised revision/revocation/facet/operation-ID changes block without consuming the approval", async () => {
  for (const change of [
    "revision",
    "revoke_schedule",
    "revoke_message",
    "facet",
    "operationID",
  ] as const) {
    const f = fixture();
    try {
      const job = await f.create();
      f.supervised();
      f.approve();
      f.scheduler.scan();
      const lease = f.scheduler.claim(job.jobID, "worker");
      const ready = required(await f.scheduler.admit(lease));
      if (change === "revision") f.policyRevision(2);
      if (change === "revoke_schedule") f.deny(["schedule.manage"]);
      if (change === "revoke_message") f.deny(["message"]);
      if (change === "facet" || change === "operationID") {
        const approval = required(f.approval());
        if (change === "facet")
          approval.scheduled = {
            ...required(approval.scheduled),
            occurrence: {
              ...required(required(approval.scheduled).occurrence),
              scheduleRevision: 2,
            },
          };
        else approval.operationID = "another-real-operation";
        f.db
          .query("UPDATE synthetic_approval SET body=?")
          .run(JSON.stringify(approval));
      }
      const unchanged = f.approval();
      await expect(f.scheduler.work(lease)).rejects.toThrow();
      expect(f.sends).toHaveLength(0);
      expect(f.approval()).toEqual(unchanged);
      expect((await f.scheduler.get(job.jobID)).runs).toBe(0);
      expect(
        f.db
          .query<{ state: string }, [string]>(
            "SELECT state FROM operations WHERE operation_id=?",
          )
          .get(required(ready.operationID))?.state,
      ).toBe("pending");
    } finally {
      f.close();
    }
  }
});

test("scheduled intent atomically rolls back occurrence, T20 intent, both outboxes and once reservation", async () => {
  const f = fixture();
  try {
    const job = await f.create();
    f.supervised();
    f.approve();
    f.scheduler.scan();
    const lease = f.scheduler.claim(job.jobID, "worker");
    const before = f.approval();
    f.db.exec(
      "CREATE TRIGGER synthetic_reject_intent BEFORE INSERT ON operations BEGIN SELECT RAISE(ABORT,'synthetic T20 insert failure'); END",
    );
    await expect(f.scheduler.admit(lease)).rejects.toThrow();
    expect(f.approval()).toEqual(before);
    expect((await f.scheduler.occurrences(job.jobID))[0]?.state).toBe(
      "pending",
    );
    expect((await f.scheduler.get(job.jobID)).runs).toBe(0);
    for (const table of ["operations", "operation_outbox", "schedule_outbox"])
      expect(
        f.db.query<{ n: number }, []>(`SELECT count(*) n FROM ${table}`).get()
          ?.n,
      ).toBe(0);
    expect(f.sends).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("scheduled facade rejects other capability, wrong actual operationID and changed persisted facet", async () => {
  const f = fixture();
  try {
    const original = f.options.dispatcher;
    let facade: ConstructorParameters<typeof Dispatcher>[2] | undefined;
    let factoryOwner: Principal | undefined;
    f.options.dispatcher = (owner, authorization) => {
      facade = authorization;
      factoryOwner = owner;
      return original(owner, authorization);
    };
    const job = await f.create();
    f.supervised();
    f.approve();
    f.scheduler.scan();
    const lease = f.scheduler.claim(job.jobID, "worker");
    const occurrence = required(await f.scheduler.admit(lease));
    const authorization = required(facade);
    let called = false;
    await expect(
      authorization.authorizeIntent(
        required(factoryOwner),
        f.target,
        "manage",
        1,
        "another-op",
        () => {
          called = true;
        },
      ),
    ).rejects.toThrow("unsupported");
    await expect(
      authorization.admitOperation(
        required(factoryOwner),
        f.target,
        "message",
        1,
        "another-op",
        () => {
          called = true;
        },
      ),
    ).rejects.toThrow("conflict");
    f.db
      .query("UPDATE schedule_jobs SET schedule_revision=2 WHERE job_id=?")
      .run(job.jobID);
    await expect(f.scheduler.work(lease)).rejects.toThrow("conflict");
    expect(called).toBe(false);
    expect(f.sends).toHaveLength(0);
    expect(f.approval()?.operationID).toBe(required(occurrence.operationID));
    expect((await f.scheduler.get(job.jobID)).runs).toBe(0);
  } finally {
    f.close();
  }
});

test("final T20 CAS failure rolls back dispatch counter and once consumption", async () => {
  const f = fixture();
  try {
    const job = await f.create();
    f.supervised();
    f.approve();
    f.scheduler.scan();
    const lease = f.scheduler.claim(job.jobID, "worker");
    await f.scheduler.admit(lease);
    const before = f.approval();
    f.db.exec(
      "CREATE TRIGGER synthetic_reject_dispatch BEFORE UPDATE OF state ON operations WHEN NEW.state='dispatching' BEGIN SELECT RAISE(ABORT,'synthetic final CAS failure'); END",
    );
    await expect(f.scheduler.work(lease)).rejects.toThrow();
    expect(f.approval()).toEqual(before);
    expect((await f.scheduler.get(job.jobID)).runs).toBe(0);
    expect((await f.scheduler.occurrences(job.jobID))[0]?.state).toBe("ready");
    expect(
      f.db.query<{ state: string }, []>("SELECT state FROM operations").get()
        ?.state,
    ).toBe("pending");
    expect(f.sends).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("supervised message permission is independently required before any durable intent", async () => {
  const f = fixture();
  try {
    const job = await f.create();
    f.supervised();
    f.approve();
    f.deny(["message"]);
    const before = f.approval();
    await f.scheduler.tick();
    expect(f.approval()).toEqual(before);
    expect(
      f.db.query<{ n: number }, []>("SELECT count(*) n FROM operations").get()
        ?.n,
    ).toBe(0);
    expect(
      f.db
        .query<{ n: number }, []>("SELECT count(*) n FROM schedule_outbox")
        .get()?.n,
    ).toBe(0);
    expect((await f.scheduler.get(job.jobID)).runs).toBe(0);
  } finally {
    f.close();
  }
});

test("one-shot blocked without approval finalizes without run or intent; group can be deleted", async () => {
  const f = fixture();
  try {
    const groups = new Groups(
      f.storage,
      f.identity,
      f.policy,
      taskActiveWork(f.storage, f.scheduler.jobs),
      () => 1000,
    );
    const group = await groups.create(
      f.target,
      { name: "one-shot", kind: "group" },
      1,
    );
    const job = await f.create({
      groupID: group.groupID,
      schedule: {
        version: 1,
        kind: "date",
        timezone: "UTC",
        dueUTC: "1970-01-01T00:00:01.000Z",
      },
    });
    f.supervised();
    f.scheduler.scan();
    const lease = f.scheduler.claim(job.jobID, "unapproved-worker");
    await expect(f.scheduler.admit(lease)).rejects.toThrow("forbidden");
    f.advance(31_000);
    await f.scheduler.tick();
    expect(await f.scheduler.get(job.jobID)).toMatchObject({
      state: "completed",
      runs: 0,
      nextDue: null,
    });
    expect((await f.scheduler.occurrences(job.jobID))[0]?.state).toBe(
      "blocked",
    );
    expect(
      f.db
        .query<{ evidence: string }, []>(
          "SELECT evidence FROM schedule_occurrences",
        )
        .get()?.evidence,
    ).toBe("forbidden");
    expect(
      f.db.query<{ n: number }, []>("SELECT count(*) n FROM operations").get()
        ?.n,
    ).toBe(0);
    f.approve("manage");
    // Group removal is independently authorized, not a scheduler once spend.
    f.storage.transaction((sql) =>
      expect(f.scheduler.jobs.active(sql, group.groupID)).toBe(false),
    );
    await groups.deleteGroup(group.groupID, 1);
  } finally {
    f.close();
  }
});

test("one-shot native rejection is terminal with reason retained and no admitted run", async () => {
  const f = fixture();
  try {
    const job = await f.create({
      schedule: {
        version: 1,
        kind: "date",
        timezone: "UTC",
        dueUTC: "1970-01-01T00:00:01.000Z",
      },
    });
    f.nativeReject();
    await f.scheduler.tick();
    expect(await f.scheduler.get(job.jobID)).toMatchObject({
      state: "completed",
      runs: 0,
      nextDue: null,
    });
    expect((await f.scheduler.occurrences(job.jobID))[0]?.state).toBe(
      "rejected",
    );
    expect(
      f.db
        .query<{ evidence: string }, []>(
          "SELECT evidence FROM schedule_occurrences",
        )
        .get()?.evidence,
    ).toBe("rejected");
  } finally {
    f.close();
  }
});

test("one-shot revoked after atomic intent finalizes with zero runs and rejected T20 pending intent", async () => {
  const f = fixture();
  try {
    const job = await f.create({
      schedule: {
        version: 1,
        kind: "date",
        timezone: "UTC",
        dueUTC: "1970-01-01T00:00:01.000Z",
      },
    });
    f.supervised();
    f.approve();
    f.afterRequest(() => f.deny(["schedule.manage"]));
    await f.scheduler.tick();
    expect(await f.scheduler.get(job.jobID)).toMatchObject({
      state: "completed",
      runs: 0,
      nextDue: null,
    });
    expect((await f.scheduler.occurrences(job.jobID))[0]?.state).toBe(
      "blocked",
    );
    expect(
      f.db.query<{ state: string }, []>("SELECT state FROM operations").get()
        ?.state,
    ).toBe("rejected");
    expect(f.sends).toHaveLength(0);
    expect(f.approval()?.scheduled?.modality).toBe("scheduled-message");
  } finally {
    f.close();
  }
});

test("exhausted one-shot with admitted or unknown external work still blocks group deletion", async () => {
  for (const unknown of [false, true]) {
    const f = fixture();
    try {
      const groups = new Groups(
        f.storage,
        f.identity,
        f.policy,
        taskActiveWork(f.storage, f.scheduler.jobs),
        () => 1000,
      );
      const group = await groups.create(
        f.target,
        { name: "active one-shot", kind: "group" },
        1,
      );
      const job = await f.create({
        groupID: group.groupID,
        schedule: {
          version: 1,
          kind: "date",
          timezone: "UTC",
          dueUTC: "1970-01-01T00:00:01.000Z",
        },
      });
      if (unknown) f.unknown();
      await f.scheduler.tick();
      expect(await f.scheduler.get(job.jobID)).toMatchObject({
        state: "active",
        runs: 1,
        nextDue: null,
      });
      f.storage.transaction((sql) =>
        expect(f.scheduler.jobs.active(sql, group.groupID)).toBe(true),
      );
      await expect(groups.deleteGroup(group.groupID, 1)).rejects.toThrow(
        "conflict",
      );
    } finally {
      f.close();
    }
  }
});

test("SCH-02/03/04: anchored restart catch-up, durable occurrence and explicit non-overlap", async () => {
  const f = fixture();
  try {
    const job = await f.scheduler.create(
      {
        target: f.target,
        content: "synthetic",
        schedule: {
          version: 1,
          kind: "interval",
          timezone: "UTC",
          anchorUTC: "1970-01-01T00:00:01.000Z",
          periodMs: 300_000,
        },
        expiresAt: 10_000_000,
        maxRuns: 10,
        groupID: null,
      },
      1,
    );
    f.advance(901_000);
    await f.scheduler.tick();
    expect(f.sends).toHaveLength(1);
    const occurrences = await f.scheduler.occurrences(job.jobID);
    expect(occurrences[0]?.occurrenceID).toBe(occurrenceID(job.jobID, 1, 0));
    expect(occurrences[0]?.throughIndex).toBe(3);
    expect(occurrences[0]?.state).toBe("admitted");
    f.advance(1_801_000);
    await new Scheduler(f.options).tick();
    await f.scheduler.tick();
    expect(f.sends).toHaveLength(1);
    expect(
      (await f.scheduler.occurrences(job.jobID)).filter(
        (o) => o.state === "pending",
      ),
    ).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("terminal evidence releases overlap; idle/acceptance alone never does", async () => {
  const f = fixture();
  try {
    const job = await f.create();
    await f.scheduler.tick();
    const first = required((await f.scheduler.occurrences(job.jobID))[0]);
    f.advance(901_000);
    await f.scheduler.tick();
    await f.scheduler.collect(first.occurrenceID);
    await f.scheduler.tick();
    expect(f.sends).toHaveLength(1);
    f.outcomes.set(first.occurrenceID, {
      occurrenceID: first.occurrenceID,
      operationID: required(first.operationID),
      state: "completed",
      evidence: "synthetic correlated terminal result",
    });
    await f.scheduler.collect(first.occurrenceID);
    await f.scheduler.tick();
    expect(f.sends).toHaveLength(2);
    expect((await f.scheduler.occurrences(job.jobID))[1]).toMatchObject({
      dueIndex: 1,
      throughIndex: 3,
      state: "admitted",
    });
  } finally {
    f.close();
  }
});

test("SCH-05: fresh permission, expiry and limits; rollback produces no outbox or send", async () => {
  for (const deny of ["grant", "expiry", "limit", "rollback"] as const) {
    const f = fixture();
    try {
      const job = await f.create();
      f.scheduler.scan();
      const lease = f.scheduler.claim(job.jobID, "worker");
      if (deny === "grant") f.deny(["schedule.manage"]);
      if (deny === "expiry") f.expireOperator();
      if (deny === "limit") f.limit();
      if (deny === "rollback") f.failCommit();
      await expect(f.scheduler.admit(lease)).rejects.toThrow();
      expect(f.sends).toHaveLength(0);
      expect((await f.scheduler.occurrences(job.jobID))[0]?.state).toBe(
        "pending",
      );
      expect(
        f.db
          .query<{ n: number }, []>("SELECT count(*) n FROM schedule_outbox")
          .get()?.n,
      ).toBe(0);
    } finally {
      f.close();
    }
  }
});

test("SCH-05/07: revoke and pause after T20 enqueue prevent host output", async () => {
  for (const change of ["revoke", "archive"] as const) {
    const f = fixture();
    try {
      const job = await f.create();
      f.afterRequest(() => {
        if (change === "revoke") f.deny(["schedule.manage"]);
        else
          f.storage.transaction((sql) =>
            f.scheduler.jobs.archive(sql, f.target),
          );
      });
      await f.scheduler.tick();
      expect(f.sends).toHaveLength(0);
      expect((await f.scheduler.occurrences(job.jobID))[0]?.state).toBe(
        "blocked",
      );
      expect(
        f.db.query<{ state: string }, []>("SELECT state FROM operations").get()
          ?.state,
      ).toBe("rejected");
    } finally {
      f.close();
    }
  }
});

test("SCH-06: expired old worker cannot create a NEW local admission", async () => {
  const f = fixture();
  try {
    const job = await f.create();
    f.scheduler.scan();
    const old = f.scheduler.claim(job.jobID, "old", 100);
    f.advance(1100);
    const current = new Scheduler(f.options).claim(job.jobID, "current");
    await expect(f.scheduler.admit(old)).rejects.toThrow("conflict");
    await f.scheduler.admit(current);
    await expect(f.scheduler.work(old)).rejects.toThrow("conflict");
    await f.scheduler.work(current);
    expect(f.sends).toHaveLength(1);
    expect((await f.scheduler.get(job.jobID)).runs).toBe(1);
  } finally {
    f.close();
  }
});

test("unknown outcome blocks overlap and never retries delivery; inspection is distinct", async () => {
  const f = fixture();
  try {
    const job = await f.create();
    f.unknown();
    await f.scheduler.tick();
    const first = required((await f.scheduler.occurrences(job.jobID))[0]);
    expect(first.state).toBe("unknown_outcome");
    f.advance(901_000);
    await new Scheduler(f.options).tick();
    await f.scheduler.reconcile(first.occurrenceID);
    await f.scheduler.tick();
    expect(f.sends).toHaveLength(1);
    expect(
      (await f.scheduler.occurrences(job.jobID)).filter(
        (o) => o.state === "pending",
      ),
    ).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("crash after durable T20 request replays frozen key/payload without duplicating", async () => {
  const f = fixture();
  try {
    const job = await f.create();
    f.loseRequest();
    await expect(f.scheduler.tick()).rejects.toThrow(
      "synthetic lost enqueue response",
    );
    expect(f.sends).toHaveLength(0);
    await new Scheduler(f.options).tick();
    expect(f.sends).toHaveLength(1);
    expect(
      f.db.query<{ n: number }, []>("SELECT count(*) n FROM operations").get()
        ?.n,
    ).toBe(1);
    expect((await f.scheduler.occurrences(job.jobID))[0]?.state).toBe(
      "admitted",
    );
  } finally {
    f.close();
  }
});

test("LIF-06: archive gates creation/admission; restore never reenables jobs", async () => {
  const f = fixture();
  try {
    const job = await f.create();
    f.storage.transaction((sql) => f.scheduler.jobs.archive(sql, f.target));
    await expect(f.create()).rejects.toThrow("conflict");
    f.storage.transaction((sql) => f.scheduler.jobs.restore(sql, f.target));
    await f.scheduler.tick();
    expect(f.sends).toHaveLength(0);
    expect((await f.scheduler.get(job.jobID)).state).toBe("suspended");
    await f.scheduler.change(job.jobID, "resume", 1);
    await f.scheduler.tick();
    expect(f.sends).toHaveLength(1);
    f.storage.transaction((sql) => f.scheduler.jobs.archive(sql, f.target));
    f.advance(901_000);
    f.storage.transaction((sql) => f.scheduler.jobs.restore(sql, f.target));
    await f.scheduler.tick();
    expect(f.sends).toHaveLength(1);
    await f.scheduler.change(job.jobID, "cancel", 1);
    expect((await f.scheduler.occurrences(job.jobID))[0]?.state).toBe(
      "admitted",
    );
  } finally {
    f.close();
  }
});

test("clock discontinuity suspends both locations until coordinator reconciliation", async () => {
  const f = fixture();
  try {
    await f.create();
    f.scheduler.scan();
    // Initial sample without processing a future timer.
    await f.scheduler.tick();
    f.jumpWall();
    await expect(f.scheduler.tick()).rejects.toThrow("unavailable");
    await expect(new Scheduler(f.options).tick()).rejects.toThrow(
      "unavailable",
    );
    f.scheduler.reconcileClock();
    await f.scheduler.tick();
    expect(f.sends).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("maintenance lifecycle has one timer, dispose cancels, reload adds only its own timer", () => {
  const f = fixture();
  try {
    f.scheduler.start();
    f.scheduler.start();
    expect(f.timers.size).toBe(1);
    f.scheduler.dispose();
    expect(f.timers.size).toBe(0);
    const reload = new Scheduler(f.options);
    reload.start();
    expect(f.timers.size).toBe(1);
    reload.dispose();
    expect(f.timers.size).toBe(0);
  } finally {
    f.close();
  }
});

test("maintenance callback processes committed outbox and cannot rearm after dispose", async () => {
  const f = fixture();
  try {
    await f.create();
    f.scheduler.start();
    const [id, callback] = required([...f.timers.entries()][0]);
    f.timers.delete(id);
    callback();
    await f.scheduler.tick();
    f.scheduler.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.sends).toHaveLength(1);
    expect(f.timers.size).toBe(0);
  } finally {
    f.close();
  }
});

test("AD-008: lease loss AFTER last check may still produce a host effect; never resend", async () => {
  const f = fixture();
  try {
    const job = await f.create();
    f.scheduler.scan();
    const old = f.scheduler.claim(job.jobID, "old", 100);
    await f.scheduler.admit(old);
    f.afterSend(() => {
      // Port entry represents the exposed check->host boundary. The host cannot
      // enforce this DB generation, and the already-started send is not retracted.
      f.advance(1200);
      new Scheduler(f.options).claim(job.jobID, "new");
      f.deny(["schedule.manage"]);
    });
    await expect(f.scheduler.work(old)).rejects.toThrow("conflict");
    expect(f.sends).toHaveLength(1);
    // Expire the new local worker too, so interrupted dispatch is recovered.
    f.advance(40_000);
    f.scheduler.scan();
    expect((await f.scheduler.occurrences(job.jobID))[0]?.state).toBe(
      "unknown_outcome",
    );
    await new Scheduler(f.options).tick();
    expect(f.sends).toHaveLength(1);
    await f.scheduler.reconcile(occurrenceID(job.jobID, 1, 0));
    expect((await f.scheduler.occurrences(job.jobID))[0]?.state).toBe(
      "admitted",
    );
    expect(f.sends).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("maxRuns, job deadline and resume preserve anchor/revision without retracting admitted", async () => {
  const f = fixture();
  try {
    const job = await f.create({ maxRuns: 1 });
    await f.scheduler.change(job.jobID, "pause", 1);
    f.advance(601_000);
    await f.scheduler.tick();
    expect(f.sends).toHaveLength(0);
    const resumed = await f.scheduler.change(job.jobID, "resume", 1);
    expect(resumed.scheduleRevision).toBe(1);
    expect(resumed.schedule).toEqual(job.schedule);
    await f.scheduler.tick();
    const first = required((await f.scheduler.occurrences(job.jobID))[0]);
    expect(first).toMatchObject({
      dueIndex: 0,
      throughIndex: 2,
      state: "admitted",
    });
    f.outcomes.set(first.occurrenceID, {
      occurrenceID: first.occurrenceID,
      operationID: required(first.operationID),
      state: "completed",
      evidence: "synthetic terminal",
    });
    await f.scheduler.collect(first.occurrenceID);
    f.advance(901_000);
    await f.scheduler.tick();
    expect(f.sends).toHaveLength(1);
    const expired = await f.create({ expiresAt: 902_000 });
    f.advance(902_000);
    await f.scheduler.tick();
    expect((await f.scheduler.get(expired.jobID)).state).toBe("completed");
    expect(f.sends).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("schedule revision changes identities but cannot overlap an older admitted run", async () => {
  const f = fixture();
  try {
    const job = await f.create();
    await f.scheduler.tick();
    const first = required((await f.scheduler.occurrences(job.jobID))[0]);
    await f.scheduler.reschedule(
      job.jobID,
      {
        version: 1,
        kind: "date",
        timezone: "UTC",
        dueUTC: "1970-01-01T00:00:01.000Z",
      },
      1,
    );
    await f.scheduler.tick();
    expect(f.sends).toHaveLength(1);
    const pending = required((await f.scheduler.occurrences(job.jobID))[1]);
    expect(pending.occurrenceID).toBe(occurrenceID(job.jobID, 2, 0));
    expect(pending.state).toBe("pending");
    f.outcomes.set(first.occurrenceID, {
      occurrenceID: first.occurrenceID,
      operationID: required(first.operationID),
      state: "completed",
      evidence: "synthetic terminal",
    });
    await f.scheduler.collect(first.occurrenceID);
    await f.scheduler.tick();
    expect(f.sends).toHaveLength(2);
  } finally {
    f.close();
  }
});

test("T15/T23 real SQL active-work blocks group deletion; wrong DB fails closed", async () => {
  const f = fixture();
  const other = new Database(":memory:");
  try {
    const groups = new Groups(
      f.storage,
      f.identity,
      f.policy,
      taskActiveWork(f.storage, f.scheduler.jobs),
      () => 1000,
    );
    const group = await groups.create(
      f.target,
      { name: "synthetic", kind: "group" },
      1,
    );
    const job = await f.create({ groupID: group.groupID });
    expect(
      f.storage.transaction((sql) =>
        taskActiveWork(f.storage, f.scheduler.jobs).snapshot(
          sql,
          group.groupID,
        ),
      ),
    ).toEqual({ activeJobs: true, activeTasks: false });
    expect(() =>
      other.transaction(() => f.scheduler.jobs.active(other, group.groupID))(),
    ).toThrow("unavailable");
    await expect(groups.deleteGroup(group.groupID, 1)).rejects.toThrow(
      "conflict",
    );
    await f.scheduler.change(job.jobID, "cancel", 1);
    await groups.deleteGroup(group.groupID, 1);
  } finally {
    other.close();
    f.close();
  }
});

test("fresh policy revision and destination are checked again immediately before sending", async () => {
  const f = fixture();
  try {
    const job = await f.create();
    f.afterRequest(() => f.policyRevision(2));
    await f.scheduler.tick();
    expect((await f.scheduler.occurrences(job.jobID))[0]?.policyRevision).toBe(
      2,
    );
    const second = await f.create();
    f.afterRequest(() => f.removeTarget());
    await f.scheduler.tick();
    expect(f.sends).toHaveLength(1);
    expect((await f.scheduler.occurrences(second.jobID))[0]?.state).toBe(
      "blocked",
    );
  } finally {
    f.close();
  }
});

test("composite boundary revalidates schedule.manage even while message remains allowed", async () => {
  const f = fixture();
  try {
    const job = await f.create();
    f.scheduler.scan();
    const lease = f.scheduler.claim(job.jobID, "worker");
    await f.scheduler.admit(lease);
    f.deny(["schedule.manage"]);
    await expect(f.scheduler.work(lease)).rejects.toThrow("forbidden");
    expect(f.sends).toHaveLength(0);
    expect((await f.scheduler.occurrences(job.jobID))[0]?.state).toBe("ready");
    expect(
      f.db.query<{ state: string }, []>("SELECT state FROM operations").get()
        ?.state,
    ).toBe("pending");
  } finally {
    f.close();
  }
});

test("T12: fresh grant revision at admission, and revoked/expired grants fail closed", async () => {
  const root = mkdtempSync(
    "/tmp/opencode/opencode-sessions-tools/schedules-t29-grants-",
  );
  writeFileSync(`${root}/canonical.sqlite`, "", { mode: 0o600 });
  const f = openSyntheticScheduler(root, "parent");
  try {
    expect(() =>
      openSyntheticScheduler(
        root,
        "incompatible-location",
        "other-installation",
      ),
    ).toThrow("unavailable");
    f.identity(f.operator);
    const grant = await f.grants.link({
      source: f.source,
      target: f.target,
      capabilities: ["schedule.manage", "message"],
      expiresAt: null,
      policyRevision: 1,
      grantRevision: 0,
    });
    f.identity(f.session);
    const job = await f.scheduler.create(
      {
        target: f.target,
        content: "synthetic grant revisions",
        schedule: {
          version: 1,
          kind: "date",
          timezone: "UTC",
          dueUTC: "1970-01-01T00:00:01.000Z",
        },
        expiresAt: 100_000,
        maxRuns: 10,
        groupID: null,
      },
      1,
    );
    f.scheduler.scan();
    const lease = f.scheduler.claim(job.jobID, "worker");
    f.identity(f.operator);
    await f.grants.unlink(grant.grantID, 1, 1);
    const replacement = await f.grants.link({
      source: f.source,
      target: f.target,
      capabilities: ["schedule.manage", "message"],
      expiresAt: "1970-01-01T00:00:02.000Z",
      policyRevision: 1,
      grantRevision: 2,
    });
    f.identity(f.session);
    await f.scheduler.admit(lease);
    expect((await f.scheduler.occurrences(job.jobID))[0]?.grantRevision).toBe(
      3,
    );
    f.storage.transaction((sql) =>
      sql.query("UPDATE synthetic_state SET now=2000").run(),
    );
    await expect(f.scheduler.work(lease)).rejects.toThrow("forbidden");
    expect(
      f.storage.transaction(
        (sql) =>
          sql
            .query<{ n: number }, []>("SELECT count(*) n FROM synthetic_sends")
            .get()?.n,
      ),
    ).toBe(0);
    f.identity(f.operator);
    await f.grants.unlink(replacement.grantID, 1, 3);
    f.identity(f.session);
    // Revocation is fresh at LOCAL admission too, not only the host-output guard.
    await f.scheduler
      .reschedule(
        job.jobID,
        { version: 1, kind: "timer", timezone: "UTC", delayMs: 1 },
        1,
      )
      .then(
        () => {
          throw new Error("revoked schedule permission accepted");
        },
        (error) => expect(error.message).toBe("forbidden"),
      );
  } finally {
    f.scheduler.dispose();
    f.storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("SCH-10: conditions are unsupported before operator or agent authorization", async () => {
  const f = fixture();
  try {
    for (const condition of [
      { conditions: { shell: "false" } },
      { if: "code mode" },
      { until: "code mode" },
    ])
      await expect(f.create(condition)).rejects.toThrow("unsupported");
    await expect(
      f.create({
        schedule: {
          version: 1,
          kind: "timer",
          timezone: "UTC",
          delayMs: 1,
          conditions: { code: "false" },
        },
      }),
    ).rejects.toThrow("unsupported");
    expect(await f.scheduler.list()).toEqual([]);
    expect(f.sends).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("bounded maintenance is not starved by a full batch of overlapping active jobs", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 102; i++) await f.create();
    await f.scheduler.tick();
    expect(f.sends).toHaveLength(100);
    f.advance(301_000);
    f.scheduler.scan(1000);
    await f.scheduler.tick();
    expect(f.sends).toHaveLength(102);
  } finally {
    f.close();
  }
});

test("large cron catch-up is bounded per pass and cannot emit several recovery runs", async () => {
  const f = fixture();
  try {
    const job = await f.create({
      schedule: {
        version: 1,
        kind: "cron",
        timezone: "UTC",
        expression: "* * * * * *",
        referenceUTC: "1970-01-01T00:00:00.000Z",
      },
    });
    f.advance(1_001_000);
    await f.scheduler.tick();
    expect(f.sends).toHaveLength(0);
    expect((await f.scheduler.occurrences(job.jobID))[0]).toMatchObject({
      dueIndex: 0,
      throughIndex: 511,
      state: "pending",
    });
    await new Scheduler(f.options).tick();
    expect(f.sends).toHaveLength(1);
    expect((await f.scheduler.occurrences(job.jobID))[0]).toMatchObject({
      dueIndex: 0,
      throughIndex: 1000,
      state: "admitted",
    });
    await new Scheduler(f.options).tick();
    expect(f.sends).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("SCH-09: persisted New York DST cursor survives reload without renumbering or fold replay", async () => {
  const f = fixture();
  try {
    const job = await f.create({
      expiresAt: Date.parse("2027-01-01T00:00:00.000Z"),
      schedule: {
        version: 1,
        kind: "cron",
        timezone: "America/New_York",
        expression: "30 1 * * *",
        referenceUTC: "2026-11-01T00:00:00.000Z",
      },
    });
    f.advance(Date.parse("2026-11-01T05:30:00.000Z"));
    await f.scheduler.tick();
    const first = required((await f.scheduler.occurrences(job.jobID))[0]);
    f.outcomes.set(first.occurrenceID, {
      occurrenceID: first.occurrenceID,
      operationID: required(first.operationID),
      state: "completed",
      evidence: "synthetic terminal",
    });
    await f.scheduler.collect(first.occurrenceID);
    f.advance(Date.parse("2026-11-01T06:30:00.000Z"));
    await new Scheduler(f.options).tick();
    expect(f.sends).toHaveLength(1);
    expect((await f.scheduler.get(job.jobID)).nextDue).toBe(
      Date.parse("2026-11-02T06:30:00.000Z"),
    );
    f.advance(Date.parse("2026-11-02T06:30:00.000Z"));
    await new Scheduler(f.options).tick();
    expect(f.sends).toHaveLength(2);
    expect((await f.scheduler.occurrences(job.jobID))[1]?.occurrenceID).toBe(
      occurrenceID(job.jobID, 1, 1),
    );
  } finally {
    f.close();
  }
});

test("SCH-09: gap never sends a shifted prompt; recovery admits only the next matching instant", async () => {
  const f = fixture();
  try {
    const job = await f.create({
      expiresAt: Date.parse("2027-01-01T00:00:00.000Z"),
      schedule: {
        version: 1,
        kind: "cron",
        timezone: "America/New_York",
        expression: "30 2 * * *",
        referenceUTC: "2026-03-08T00:00:00.000Z",
      },
    });
    f.advance(Date.parse("2026-03-08T07:30:00.000Z"));
    await f.scheduler.tick();
    expect(f.sends).toHaveLength(0);
    f.advance(Date.parse("2026-03-09T06:30:00.000Z"));
    await new Scheduler(f.options).tick();
    expect(f.sends).toHaveLength(1);
    expect((await f.scheduler.occurrences(job.jobID))[0]).toMatchObject({
      dueIndex: 0,
      dueAt: Date.parse("2026-03-09T06:30:00.000Z"),
    });
  } finally {
    f.close();
  }
});

test("SCH-06: two PROCESSES/two locations share canonical ownership and emit once", async () => {
  const root = mkdtempSync(
    "/tmp/opencode/opencode-sessions-tools/schedules-t29-process-",
  );
  writeFileSync(`${root}/canonical.sqlite`, "", { mode: 0o600 });
  const f = openSyntheticScheduler(root, "parent");
  try {
    f.identity(f.operator);
    await f.grants.link({
      source: f.source,
      target: f.target,
      capabilities: ["schedule.manage", "message"],
      expiresAt: null,
      policyRevision: 1,
      grantRevision: 0,
    });
    f.identity(f.session);
    const job = await f.scheduler.create(
      {
        target: f.target,
        content: "synthetic two process",
        schedule: { version: 1, kind: "timer", timezone: "UTC", delayMs: 1 },
        expiresAt: 100_000,
        maxRuns: 1,
        groupID: null,
      },
      1,
    );
    f.storage.transaction((sql) =>
      sql.query("UPDATE synthetic_state SET now=2000").run(),
    );
    const worker = new URL("./fixtures/schedules-worker.ts", import.meta.url)
      .pathname;
    const children = ["location-a", "location-b"].map((location) =>
      Bun.spawn([process.execPath, worker, root, location, "tick"], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const results = await Promise.all(
      children.map(async (child) => ({
        code: await child.exited,
        stdout: await new Response(child.stdout).text(),
        stderr: await new Response(child.stderr).text(),
      })),
    );
    expect(results).toEqual(
      results.map(() => ({
        code: 0,
        stdout: '{"tick":"completed"}\n',
        stderr: "",
      })),
    );
    expect(
      f.storage.transaction(
        (sql) =>
          sql
            .query<{ n: number }, []>("SELECT count(*) n FROM synthetic_sends")
            .get()?.n,
      ),
    ).toBe(1);
    expect(await f.scheduler.occurrences(job.jobID)).toHaveLength(1);
    expect((await f.scheduler.get(job.jobID)).runs).toBe(1);
  } finally {
    f.scheduler.dispose();
    f.storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("SCH-06: worker expired in another PROCESS is fenced at NEW local admission", async () => {
  const root = mkdtempSync(
    "/tmp/opencode/opencode-sessions-tools/schedules-t29-fence-",
  );
  writeFileSync(`${root}/canonical.sqlite`, "", { mode: 0o600 });
  const f = openSyntheticScheduler(root, "parent");
  try {
    f.identity(f.operator);
    await f.grants.link({
      source: f.source,
      target: f.target,
      capabilities: ["schedule.manage", "message"],
      expiresAt: null,
      policyRevision: 1,
      grantRevision: 0,
    });
    f.identity(f.session);
    const job = await f.scheduler.create(
      {
        target: f.target,
        content: "synthetic fencing",
        schedule: {
          version: 1,
          kind: "date",
          timezone: "UTC",
          dueUTC: "1970-01-01T00:00:01.000Z",
        },
        expiresAt: 100_000,
        maxRuns: 1,
        groupID: null,
      },
      1,
    );
    const worker = new URL("./fixtures/schedules-worker.ts", import.meta.url)
      .pathname;
    const old = Bun.spawn(
      [process.execPath, worker, root, "old-location", "old", job.jobID],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    const reader = old.stdout.getReader();
    const claimed = await reader.read();
    expect(new TextDecoder().decode(claimed.value)).toContain('"claimed":1');
    f.storage.transaction((sql) =>
      sql.query("UPDATE synthetic_state SET now=2000").run(),
    );
    const current = Bun.spawn(
      [process.execPath, worker, root, "new-location", "tick"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await current.exited).toBe(0);
    expect(await new Response(current.stderr).text()).toBe("");
    old.stdin.end();
    let output = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += new TextDecoder().decode(chunk.value);
    }
    expect(await old.exited).toBe(0);
    expect(output).toContain('"staleRejected":"conflict"');
    expect(await new Response(old.stderr).text()).toBe("");
    expect(
      f.storage.transaction(
        (sql) =>
          sql
            .query<{ n: number }, []>("SELECT count(*) n FROM synthetic_sends")
            .get()?.n,
      ),
    ).toBe(1);
    expect((await f.scheduler.get(job.jobID)).runs).toBe(1);
  } finally {
    f.scheduler.dispose();
    f.storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});
