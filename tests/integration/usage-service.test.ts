import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, type Principal } from "../../src/contracts";
import { GROUPS_MIGRATION } from "../../src/groups/service";
import { Events, eventsMigration } from "../../src/observability/events";
import {
  canonicalUsageEvents,
  USAGE_MIGRATION,
  UsageService,
} from "../../src/observability/usage";
import { Persistence } from "../../src/persistence/database";

test("two file writers, restart, dedup, fresh ACL, budget event rollback and missing cost denial", async () => {
  const directory = mkdtempSync(join(tmpdir(), "usage-service-"));
  const path = join(directory, "usage.sqlite");
  const first = new Database(path);
  const second = new Database(path);
  const scope = {
    version: 1 as const,
    instanceID: "i",
    projectID: "p",
    sessionID: "s",
  };
  const principal: Principal = {
    kind: "operator",
    instanceID: "i",
    operatorID: "o",
    revision: 1,
  };
  let allowed = true;
  let eventFails = false;
  const events: unknown[] = [];
  const a = new Persistence(first, () => {});
  const b = new Persistence(second, () => {});
  const compose = (storage: Persistence) =>
    new UsageService(
      storage,
      { current: async () => principal },
      {
        check() {
          if (!allowed) throw new Error("revoked");
        },
      },
      {
        appendInTx(_sql, event) {
          if (eventFails) throw new Error("event failure");
          events.push(event);
        },
      },
    );
  try {
    first.exec("PRAGMA foreign_keys=ON");
    GROUPS_MIGRATION.apply(first, "fixture");
    USAGE_MIGRATION.apply(first, "fixture");
    for (const groupID of ["a", "b"]) {
      first.query("INSERT INTO groups_records VALUES (?,?)").run(
        groupID,
        JSON.stringify({
          version: 1,
          groupID,
          scope,
          owner: principal,
          name: groupID,
          kind: "group",
        }),
      );
      first
        .query("INSERT INTO groups_members VALUES (?,?)")
        .run(groupID, JSON.stringify(scope));
    }
    const service = compose(a);
    expect((await service.read(["a"])).cost.value).toBeNull();
    await service.changeBudget("a", 5, 0, "initial-budget");
    expect(() =>
      a.transaction((sql) =>
        service.reserveInTx(sql, principal, "a", "missing", 1),
      ),
    ).toThrow();
    a.transaction((sql) =>
      service.recordSnapshotInTx(sql, scope, {
        cost: { value: 1, quality: "reported" },
      }),
    );
    expect((await service.read(["a", "b"])).cost.value).toBe(1);
    const other = compose(b);
    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        a.transaction((sql) =>
          service.reserveInTx(sql, principal, "a", "one", 3),
        ),
      ),
      Promise.resolve().then(() =>
        b.transaction((sql) =>
          other.reserveInTx(sql, principal, "a", "two", 3),
        ),
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    eventFails = true;
    await expect(
      service.changeBudget("a", 100, 1, "failed-budget"),
    ).rejects.toThrow();
    expect(
      first
        .query<{ ceiling: number }, []>("SELECT ceiling FROM usage_budgets")
        .get()?.ceiling,
    ).toBe(5);
    expect(events).toEqual([
      {
        kind: "budget.changed",
        operationID: expect.any(String),
        target: scope,
        payload: { revision: 1 },
      },
    ]);
    allowed = false;
    await expect(service.read(["a"])).rejects.toThrow();
    allowed = true;
    const restarted = new Database(path);
    try {
      expect(
        (await compose(new Persistence(restarted, () => {})).read(["a", "b"]))
          .cost.value,
      ).toBe(1);
    } finally {
      restarted.close();
    }
    expect(canonical(scope)).toContain("sessionID");
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true });
  }
});

test("session cannot change budgets; foreign SQL is rejected before any source or event", async () => {
  const sql = new Database(":memory:");
  const foreign = new Database(":memory:");
  const storage = new Persistence(sql, () => {});
  const scope = {
    version: 1 as const,
    instanceID: "i",
    projectID: "p",
    sessionID: "s",
  };
  let calls = 0;
  const service = new UsageService(
    storage,
    { current: async () => ({ kind: "session" as const, session: scope }) },
    { check() {} },
    {
      appendInTx() {
        calls++;
      },
    },
  );
  const adapter = service.runnerAdapter({
    estimateReservation() {
      calls++;
      return 1;
    },
    snapshot() {
      calls++;
      return { session: scope, usage: {} };
    },
  });
  const eventPort = canonicalUsageEvents(storage, {
    appendInTx() {
      calls++;
    },
  });
  try {
    GROUPS_MIGRATION.apply(sql, "fixture");
    USAGE_MIGRATION.apply(sql, "fixture");
    await expect(
      service.changeBudget("absent", 1, 0, "denied"),
    ).rejects.toThrow();
    expect(sql.query("SELECT * FROM usage_budgets").all()).toEqual([]);
    foreign.transaction(() => {
      expect(() =>
        adapter.reserve(foreign, {
          groupID: "a",
          taskID: "task",
          admissionID: "id",
          principal: { kind: "session", session: scope },
        }),
      ).toThrow();
      expect(() =>
        eventPort.appendInTx(
          foreign,
          {
            kind: "budget.changed",
            operationID: "synthetic",
            target: scope,
            payload: { revision: 1 },
          },
          { kind: "session", session: scope },
        ),
      ).toThrow();
      expect(() => service.recordSnapshotInTx(foreign, scope, {})).toThrow();
      expect(() =>
        service.reserveInTx(
          foreign,
          { kind: "session", session: scope },
          "a",
          "id",
          1,
        ),
      ).toThrow();
      expect(() =>
        adapter.record(foreign, {
          taskID: "task",
          operationID: "op",
          outcome: {
            admissionID: "id",
            operationID: "op",
            correlationID: "id",
            taskGeneration: 1,
            state: "completed",
            evidence: "fixture",
          },
        }),
      ).toThrow();
    })();
    expect(calls).toBe(0);
    expect(sql.query("SELECT * FROM usage_facts").all()).toEqual([]);
    expect(sql.query("SELECT * FROM usage_reservations").all()).toEqual([]);
  } finally {
    foreign.close();
    sql.close();
  }
});

test("budget mutation replay is owner scoped, durable and atomic with real canonical Events", async () => {
  const directory = mkdtempSync(join(tmpdir(), "usage-ledger-"));
  const path = join(directory, "usage.sqlite");
  const sql = new Database(path);
  const storage = new Persistence(sql, () => {});
  const scope = {
    version: 1 as const,
    instanceID: "i",
    projectID: "p",
    sessionID: "s",
  };
  let principal: Principal = {
    kind: "operator",
    instanceID: "i",
    operatorID: "one",
    revision: 1,
  };
  let allowed = true;
  let failEvent = false;
  const identity = { current: async () => principal };
  const compose = (persistence: Persistence) => {
    const journal = new Events(
      persistence,
      identity,
      {
        authorize: async () => {
          throw new Error("unused read authorization");
        },
      },
      () => 1000,
    );
    return new UsageService(
      persistence,
      identity,
      {
        check() {
          if (!allowed) throw new Error("revoked");
        },
      },
      canonicalUsageEvents(persistence, {
        appendInTx(db, event, actor) {
          journal.appendInTransaction(db, event, actor);
          if (failEvent) throw new Error("synthetic after journal append");
        },
      }),
    );
  };
  try {
    GROUPS_MIGRATION.apply(sql, "fixture");
    USAGE_MIGRATION.apply(sql, "fixture");
    sql.exec(eventsMigration.sql);
    sql.query("INSERT INTO groups_records VALUES (?,?)").run(
      "a",
      JSON.stringify({
        version: 1,
        groupID: "a",
        scope,
        owner: principal,
        name: "a",
        kind: "group",
      }),
    );
    sql
      .query("INSERT INTO groups_members VALUES (?,?)")
      .run("a", canonical(scope));
    const service = compose(storage);
    expect(await service.changeBudget("a", 5, 0, "key")).toBe(1);
    const original = sql
      .query<{ operation_id: string }, []>(
        "SELECT operation_id FROM usage_budget_mutations",
      )
      .get();
    expect(original?.operation_id).toBeString();
    expect(await service.changeBudget("a", 5, 0, "key")).toBe(1);
    await expect(service.changeBudget("a", 6, 0, "key")).rejects.toThrow();
    await expect(service.changeBudget("a", 5, 1, "key")).rejects.toThrow();
    allowed = false;
    await expect(service.changeBudget("a", 5, 0, "key")).rejects.toThrow();
    allowed = true;
    principal = { ...principal, revision: 2 };
    expect(await service.changeBudget("a", 5, 0, "key")).toBe(1);
    principal = {
      kind: "operator",
      instanceID: "i",
      operatorID: "two",
      revision: 1,
    };
    await expect(service.changeBudget("a", 5, 0, "key")).rejects.toThrow();
    expect(await service.changeBudget("a", 6, 1, "key")).toBe(2);
    failEvent = true;
    await expect(service.changeBudget("a", 7, 2, "rollback")).rejects.toThrow();
    expect(
      sql.query("SELECT * FROM usage_budget_mutations").all(),
    ).toHaveLength(2);
    expect(sql.query("SELECT * FROM event_journal").all()).toHaveLength(2);
    expect(
      sql
        .query<{ revision: number }, []>("SELECT revision FROM usage_budgets")
        .get()?.revision,
    ).toBe(2);
    failEvent = false;
    const restarted = new Database(path);
    try {
      expect(
        await compose(new Persistence(restarted, () => {})).changeBudget(
          "a",
          6,
          1,
          "key",
        ),
      ).toBe(2);
      expect(restarted.query("SELECT * FROM event_journal").all()).toHaveLength(
        2,
      );
    } finally {
      restarted.close();
    }
    const event = JSON.parse(
      sql
        .query<{ event_json: string }, []>(
          "SELECT event_json FROM event_journal ORDER BY sequence LIMIT 1",
        )
        .get()?.event_json ?? "null",
    );
    expect(event.operationID).toBe(original?.operation_id);
    expect(event.payload).toEqual({ revision: 1 });
    // Last-write cumulative replacement, including an explicit correction/reset.
    storage.transaction((db) =>
      service.recordSnapshotInTx(db, scope, {
        cost: { value: 5, quality: "reported" },
      }),
    );
    storage.transaction((db) =>
      service.recordSnapshotInTx(db, scope, {
        cost: { value: 8, quality: "reported" },
      }),
    );
    expect((await service.read(["a"])).cost.value).toBe(8);
    storage.transaction((db) =>
      service.recordSnapshotInTx(db, scope, {
        cost: { value: 1, quality: "estimated" },
      }),
    );
    expect((await service.read(["a"])).cost).toEqual({
      value: 1,
      quality: "estimated",
    });
    sql.exec("PRAGMA foreign_keys=ON");
    storage.transaction((db) =>
      service.reserveInTx(db, principal, "a", "orphan", 1),
    );
    sql.query("DELETE FROM groups_records WHERE group_id=?").run("a");
    expect(sql.query("SELECT * FROM usage_reservations").all()).toHaveLength(1);
  } finally {
    sql.close();
    rmSync(directory, { recursive: true });
  }
});

test("missing trusted reservation accessor fails closed on canonical SQL", () => {
  const sql = new Database(":memory:");
  const storage = new Persistence(sql, () => {});
  const principal: Principal = {
    kind: "operator",
    instanceID: "i",
    operatorID: "o",
    revision: 1,
  };
  const service = new UsageService(
    storage,
    { current: async () => principal },
    { check() {} },
    { appendInTx() {} },
  );
  const source = { estimateReservation: () => 1, snapshot: () => null };
  const adapter = service.runnerAdapter(source);
  Reflect.deleteProperty(source, "estimateReservation");
  try {
    expect(() =>
      storage.transaction((db) =>
        adapter.reserve(db, {
          groupID: "a",
          taskID: "task",
          admissionID: "id",
          principal,
        }),
      ),
    ).toThrow();
  } finally {
    sql.close();
  }
});

test("two independent processes reserve a shared file without overspending", async () => {
  const directory = mkdtempSync(join(tmpdir(), "usage-processes-"));
  const path = join(directory, "usage.sqlite");
  const sql = new Database(path);
  const scope = {
    version: 1 as const,
    instanceID: "i",
    projectID: "p",
    sessionID: "s",
  };
  const principal: Principal = {
    kind: "operator",
    instanceID: "i",
    operatorID: "o",
    revision: 1,
  };
  const storage = new Persistence(sql, () => {});
  const service = new UsageService(
    storage,
    { current: async () => principal },
    { check() {} },
    { appendInTx() {} },
  );
  try {
    GROUPS_MIGRATION.apply(sql, "fixture");
    USAGE_MIGRATION.apply(sql, "fixture");
    sql.query("INSERT INTO groups_records VALUES (?,?)").run(
      "a",
      JSON.stringify({
        version: 1,
        groupID: "a",
        scope,
        owner: principal,
        kind: "group",
        name: "a",
      }),
    );
    sql
      .query("INSERT INTO groups_members VALUES (?,?)")
      .run("a", canonical(scope));
    storage.transaction((db) =>
      service.recordSnapshotInTx(db, scope, {
        cost: { value: 1, quality: "reported" },
      }),
    );
    await service.changeBudget("a", 5, 0, "initial-budget");
    const worker = join(import.meta.dir, "fixtures/usage-worker.ts");
    const processes = ["one", "two"].map((id) =>
      Bun.spawn([process.execPath, worker, path, id], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    // Both processes are alive before their admission attempts are released.
    await Promise.all(
      processes.map(async (child) => {
        const reader = child.stdout.getReader();
        const ready = await reader.read();
        expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
        reader.releaseLock();
      }),
    );
    for (const child of processes) {
      child.stdin.write("go\n");
      child.stdin.end();
    }
    const codes = await Promise.all(processes.map((child) => child.exited));
    expect(codes.sort()).toEqual([0, 2]);
    expect(
      sql
        .query<{ total: number; count: number }, []>(
          "SELECT SUM(amount) total, COUNT(*) count FROM usage_reservations",
        )
        .get(),
    ).toEqual({ total: 3, count: 1 });
    expect(
      1 +
        (sql
          .query<{ total: number }, []>(
            "SELECT SUM(amount) total FROM usage_reservations",
          )
          .get()?.total ?? 0),
    ).toBeLessThanOrEqual(5);
  } finally {
    sql.close();
    rmSync(directory, { recursive: true });
  }
});
