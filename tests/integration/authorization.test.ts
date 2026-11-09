import { expect, test } from "bun:test";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  type AuthorizationSnapshot,
  type AuthorizationSnapshotPort,
  Authorizer,
} from "../../src/authorization/authorize";
import {
  capabilities,
  type Principal,
  type SessionRef,
} from "../../src/contracts";
import {
  openPersistence,
  type Persistence,
} from "../../src/persistence/database";

test("persisted snapshot survives reopen; current revision and one-shot approval gate local admission atomically", async () => {
  const root = mkdtempSync(
    "/tmp/opencode/opencode-sessions-tools/t11-authorization-",
  );
  let db: Persistence | undefined;
  try {
    const path = `${root}/synthetic.sqlite`;
    writeFileSync(path, "", { mode: 0o600 });
    const stat = statSync(path);
    const options = {
      repositoryPath: process.cwd(),
      claims: [
        {
          instanceID: "fixture",
          scopeID: "project",
          installationID: "synthetic",
          canonicalPath: realpathSync(path),
          databaseIdentity: `${stat.dev}:${stat.ino}`,
        },
      ],
      migrations: [
        {
          version: 2,
          apply(sql: import("bun:sqlite").Database) {
            sql.exec(
              "CREATE TABLE fixture_snapshot (id INTEGER PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE fixture_admissions (id INTEGER PRIMARY KEY)",
            );
          },
        },
      ],
    };
    const target: SessionRef = {
      version: 1,
      instanceID: "fixture",
      projectID: "project",
      sessionID: "target",
    };
    const source = { ...target, sessionID: "source" };
    const principal: Principal = { kind: "session", session: source };
    const issuer = {
      kind: "operator" as const,
      operatorID: "synthetic",
      instanceID: "fixture",
      revision: 1,
    };
    const snapshot: AuthorizationSnapshot = {
      revision: 1,
      profile: "supervised",
      profileCapabilities: [...capabilities],
      policyCapabilities: [...capabilities],
      hostCapabilities: [...capabilities],
      deniedCapabilities: [],
      grants: [
        {
          version: 1,
          grantID: "fixture-grant",
          source,
          target,
          capabilities: ["manage"],
          revision: 1,
          issuer,
          createdAt: new Date(0).toISOString(),
          expiresAt: null,
        },
      ],
      operator: null,
      delegationCapabilities: [...capabilities],
      approval: {
        principal,
        target,
        capability: "manage",
        revision: 1,
        expiresAt: new Date(2000).toISOString(),
        mode: "once",
      },
    };
    db = openPersistence(options);
    db.transaction((sql) =>
      sql
        .query("INSERT INTO fixture_snapshot VALUES (1, ?)")
        .run(JSON.stringify(snapshot)),
    );
    db.close();
    db = openPersistence(options);
    const storage = db;
    const read = () =>
      storage.transaction(
        (sql) =>
          JSON.parse(
            sql
              .query<{ body: string }, []>(
                "SELECT body FROM fixture_snapshot WHERE id=1",
              )
              .get()?.body ?? "null",
          ) as AuthorizationSnapshot,
      );
    // Fixture adapter is trusted injection only, NOT T3-PROD authentication.
    const port: AuthorizationSnapshotPort = {
      read: async () => read(),
      admission: (_principal, _target, check) =>
        storage.transaction((sql) => {
          const current = JSON.parse(
            sql
              .query<{ body: string }, []>(
                "SELECT body FROM fixture_snapshot WHERE id=1",
              )
              .get()?.body ?? "null",
          ) as AuthorizationSnapshot;
          const result = check(current);
          sql
            .query("UPDATE fixture_snapshot SET body=? WHERE id=1")
            .run(JSON.stringify(current));
          return result;
        }),
    };
    const auth = new Authorizer(
      { current: async () => principal },
      port,
      () => 1000,
    );
    await expect(
      auth.admit(principal, target, "manage", 1, () => {
        throw new Error("synthetic local write failure");
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(read().approval?.mode).toBe("once");
    const effect = () =>
      storage.transaction((sql) =>
        sql.query("INSERT INTO fixture_admissions DEFAULT VALUES").run(),
      );
    await auth.admit(principal, target, "manage", 1, effect);
    expect(read().approval).toBeNull();
    await expect(
      auth.admit(principal, target, "manage", 1, effect),
    ).rejects.toMatchObject({ code: "forbidden" });
    snapshot.profile = "manage";
    snapshot.revision = 2;
    snapshot.approval = null;
    storage.transaction((sql) =>
      sql
        .query("UPDATE fixture_snapshot SET body=?")
        .run(JSON.stringify(snapshot)),
    );
    await expect(
      auth.admit(principal, target, "manage", 1, effect),
    ).rejects.toMatchObject({ code: "conflict" });
    snapshot.policyCapabilities = [];
    storage.transaction((sql) =>
      sql
        .query("UPDATE fixture_snapshot SET body=?")
        .run(JSON.stringify(snapshot)),
    );
    await expect(
      auth.admit(principal, target, "manage", 2, effect),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      storage.transaction(
        (sql) =>
          sql
            .query<{ count: number }, []>(
              "SELECT count(*) AS count FROM fixture_admissions",
            )
            .get()?.count,
      ),
    ).toBe(1);
    // Local T13 stub: 100=pending, 101=dispatching. No operations worker or host.
    snapshot.profile = "supervised";
    snapshot.revision = 3;
    snapshot.policyCapabilities = [...capabilities];
    snapshot.approval = {
      principal,
      target,
      capability: "manage",
      revision: 3,
      expiresAt: new Date(2000).toISOString(),
      mode: "once",
    };
    storage.transaction((sql) =>
      sql
        .query("UPDATE fixture_snapshot SET body=?")
        .run(JSON.stringify(snapshot)),
    );
    await auth.authorizeIntent(
      principal,
      target,
      "manage",
      3,
      "synthetic-operation",
      () =>
        storage.transaction((sql) =>
          sql.query("INSERT INTO fixture_admissions VALUES (100)").run(),
        ),
    );
    expect(read().approval?.operationID).toBe("synthetic-operation");
    const dispatchLocal = () =>
      storage.transaction((sql) => {
        const changed = sql
          .query("UPDATE fixture_admissions SET id=101 WHERE id=100")
          .run();
        if (changed.changes !== 1)
          throw new Error("stale synthetic pending state");
      });
    await expect(
      auth.admitOperation(
        principal,
        target,
        "manage",
        3,
        "synthetic-operation",
        () => {
          dispatchLocal();
          throw new Error("synthetic transaction failure after state change");
        },
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(read().approval?.operationID).toBe("synthetic-operation");
    expect(
      storage.transaction((sql) =>
        sql.query("SELECT id FROM fixture_admissions WHERE id=100").get(),
      ),
    ).not.toBeNull();
    await auth.admitOperation(
      principal,
      target,
      "manage",
      3,
      "synthetic-operation",
      dispatchLocal,
    );
    expect(read().approval).toBeNull();
    expect(
      storage.transaction((sql) =>
        sql.query("SELECT id FROM fixture_admissions WHERE id=101").get(),
      ),
    ).not.toBeNull();
    await expect(
      auth.admitOperation(
        principal,
        target,
        "manage",
        3,
        "synthetic-operation",
        dispatchLocal,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await auth.authorizeReplay(principal, { kind: "session", session: source });
    // Delegated fork stub: 200=pending, 201=dispatching; no session/host API.
    snapshot.revision = 4;
    const creatorGrant = snapshot.grants[0];
    if (!creatorGrant) throw new Error("missing synthetic creator grant");
    snapshot.grants = [
      { ...creatorGrant, capabilities: ["manage", "read", "message"] },
    ];
    snapshot.approval = {
      principal,
      target,
      capability: "manage",
      revision: 4,
      expiresAt: new Date(2000).toISOString(),
      mode: "once",
    };
    storage.transaction((sql) =>
      sql
        .query("UPDATE fixture_snapshot SET body=?")
        .run(JSON.stringify(snapshot)),
    );
    const insertFork = () =>
      storage.transaction((sql) =>
        sql.query("INSERT INTO fixture_admissions VALUES (200)").run(),
      );
    await expect(
      auth.delegatedOperation(
        principal,
        target,
        ["message"],
        4,
        "fork-op",
        "intent",
        ["read"],
        () => {
          insertFork();
          throw new Error("synthetic intent failure after reservation");
        },
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(read().approval?.operationID).toBeUndefined();
    expect(
      storage.transaction((sql) =>
        sql.query("SELECT id FROM fixture_admissions WHERE id=200").get(),
      ),
    ).toBeNull();
    await auth.delegatedOperation(
      principal,
      target,
      ["message"],
      4,
      "fork-op",
      "intent",
      ["read"],
      insertFork,
    );
    expect(read().approval?.delegation).toEqual({
      requested: ["message"],
      requiredCapabilities: ["read"],
    });
    const reserved = read();
    const persist = (value: AuthorizationSnapshot) =>
      storage.transaction((sql) =>
        sql
          .query("UPDATE fixture_snapshot SET body=?")
          .run(JSON.stringify(value)),
      );
    const dispatchFork = () =>
      storage.transaction((sql) => {
        const result = sql
          .query("UPDATE fixture_admissions SET id=201 WHERE id=200")
          .run();
        if (result.changes !== 1) throw new Error("stale synthetic fork state");
      });
    const reduced = structuredClone(reserved);
    reduced.grants = reduced.grants.map((g) => ({
      ...g,
      capabilities: ["manage", "message"],
    }));
    persist(reduced);
    await expect(
      auth.delegatedOperation(
        principal,
        target,
        ["message"],
        4,
        "fork-op",
        "admission",
        ["read"],
        dispatchFork,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    reserved.revision = 5;
    persist(reserved);
    await expect(
      auth.delegatedOperation(
        principal,
        target,
        ["message"],
        4,
        "fork-op",
        "admission",
        ["read"],
        dispatchFork,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      auth.delegatedOperation(
        principal,
        target,
        ["message"],
        5,
        "fork-op",
        "admission",
        ["read"],
        dispatchFork,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    reserved.revision = 4;
    persist(reserved);
    await expect(
      auth.delegatedOperation(
        principal,
        target,
        ["message"],
        4,
        "fork-op",
        "admission",
        ["read"],
        () => {
          dispatchFork();
          throw new Error("synthetic delegated admission rollback");
        },
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(read().approval?.operationID).toBe("fork-op");
    expect(
      storage.transaction((sql) =>
        sql.query("SELECT id FROM fixture_admissions WHERE id=200").get(),
      ),
    ).not.toBeNull();
    await auth.delegatedOperation(
      principal,
      target,
      ["message"],
      4,
      "fork-op",
      "admission",
      ["read"],
      dispatchFork,
    );
    expect(read().approval).toBeNull();
    expect(
      storage.transaction((sql) =>
        sql.query("SELECT id FROM fixture_admissions WHERE id=201").get(),
      ),
    ).not.toBeNull();
    // Scheduled boundary uses the actual operation ID, with no approval transfer.
    const scheduled = read();
    scheduled.revision = 6;
    scheduled.grants = scheduled.grants.map((g) => ({
      ...g,
      capabilities: [...g.capabilities, "schedule.manage"],
    }));
    scheduled.approval = {
      principal,
      target,
      capability: "schedule.manage",
      revision: 6,
      expiresAt: new Date(2000).toISOString(),
      mode: "once",
    };
    persist(scheduled);
    const occurrence = {
      jobID: "synthetic-job",
      scheduleRevision: 3,
      occurrenceID: "synthetic-occurrence",
    };
    const insertScheduled = () =>
      storage.transaction((sql) =>
        sql.query("INSERT INTO fixture_admissions VALUES (300)").run(),
      );
    await expect(
      auth.scheduledOperation(
        principal,
        target,
        6,
        "real-scheduled-op",
        "intent",
        () => {
          insertScheduled();
          throw new Error("synthetic scheduled intent rollback");
        },
        occurrence,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(read().approval?.operationID).toBeUndefined();
    expect(
      storage.transaction((sql) =>
        sql.query("SELECT id FROM fixture_admissions WHERE id=300").get(),
      ),
    ).toBeNull();
    await auth.scheduledOperation(
      principal,
      target,
      6,
      "real-scheduled-op",
      "intent",
      insertScheduled,
      occurrence,
    );
    const scheduledReserved = read();
    expect(scheduledReserved.approval?.scheduled).toEqual({
      modality: "scheduled-message",
      occurrence,
    });
    const dispatchScheduled = () =>
      storage.transaction((sql) => {
        if (
          sql.query("UPDATE fixture_admissions SET id=301 WHERE id=300").run()
            .changes !== 1
        )
          throw new Error("stale scheduled state");
      });
    scheduledReserved.revision = 7;
    persist(scheduledReserved);
    await expect(
      auth.scheduledOperation(
        principal,
        target,
        6,
        "real-scheduled-op",
        "admission",
        dispatchScheduled,
        occurrence,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      auth.scheduledOperation(
        principal,
        target,
        7,
        "real-scheduled-op",
        "admission",
        dispatchScheduled,
        occurrence,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    scheduledReserved.revision = 6;
    persist(scheduledReserved);
    const revokedScheduled = structuredClone(scheduledReserved);
    revokedScheduled.grants = [];
    persist(revokedScheduled);
    await expect(
      auth.scheduledOperation(
        principal,
        target,
        6,
        "real-scheduled-op",
        "admission",
        dispatchScheduled,
        occurrence,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    persist(scheduledReserved);
    await expect(
      auth.scheduledOperation(
        principal,
        target,
        6,
        "real-scheduled-op",
        "admission",
        () => {
          dispatchScheduled();
          throw new Error("synthetic scheduled admission rollback");
        },
        occurrence,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(read().approval?.operationID).toBe("real-scheduled-op");
    expect(
      storage.transaction((sql) =>
        sql.query("SELECT id FROM fixture_admissions WHERE id=300").get(),
      ),
    ).not.toBeNull();
    await auth.scheduledOperation(
      principal,
      target,
      6,
      "real-scheduled-op",
      "admission",
      dispatchScheduled,
      occurrence,
    );
    expect(read().approval).toBeNull();
    expect(
      storage.transaction((sql) =>
        sql.query("SELECT id FROM fixture_admissions WHERE id=301").get(),
      ),
    ).not.toBeNull();
    db.close();
    db = openPersistence(options);
    expect(
      db.transaction(
        (sql) =>
          JSON.parse(
            sql
              .query<{ body: string }, []>("SELECT body FROM fixture_snapshot")
              .get()?.body ?? "null",
          ).revision,
      ),
    ).toBe(6);
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
