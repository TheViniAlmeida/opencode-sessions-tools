import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import {
  type AuthorizationSnapshot,
  Authorizer,
} from "../../src/authorization/authorize";
import {
  capabilities,
  DomainError,
  type Principal,
  type SessionRef,
} from "../../src/contracts";
import { Persistence } from "../../src/persistence/database";
import {
  canonicalPayloadHash,
  Operations,
  operationsMigration,
} from "../../src/persistence/operations";
import {
  type CreationHostPort,
  type CreationInput,
  type CreationPlan,
  type CreationResult,
  CreationService,
  creationMigration,
} from "../../src/sessions/create";

function operationID(result: CreationResult): string {
  if (!result.operation) throw new Error("fixture expected an operation");
  return result.operation.operationID;
}

// Real T11/T13, trusted local snapshot/routing adapters; NOT T3-PROD or T31.
function fixture(path = ":memory:") {
  let sql = new Database(path);
  sql.exec(operationsMigration.sql);
  sql.exec(creationMigration.sql);
  sql.exec(
    "CREATE TABLE approvals(operation_id TEXT PRIMARY KEY, expires INTEGER, consumed INTEGER, scope TEXT, issuer TEXT); CREATE TABLE links(operation_id TEXT PRIMARY KEY, observed TEXT)",
  );
  let db = new Persistence(sql, () => {});
  const source: SessionRef = {
    version: 1,
    instanceID: "synthetic",
    projectID: "project",
    sessionID: "source",
  };
  const principal: Principal = { kind: "session", session: source };
  const approvalScope = (plan: CreationPlan, owner: Principal) =>
    canonicalPayloadHash({
      operationID: plan.operationID,
      source: plan.source,
      destination: plan.destination,
      kind: plan.kind,
      capabilities: plan.capabilities,
      authorizationRevision: plan.authorizationRevision,
      owner,
    });
  let snapshot: AuthorizationSnapshot = {
    revision: 1,
    profile: "manage",
    profileCapabilities: capabilities,
    policyCapabilities: capabilities,
    hostCapabilities: capabilities,
    deniedCapabilities: [],
    grants: [
      {
        version: 1,
        grantID: "synthetic-grant",
        revision: 1,
        source,
        target: source,
        issuer: {
          kind: "operator",
          instanceID: source.instanceID,
          operatorID: "operator",
          revision: 1,
        },
        capabilities,
        createdAt: "1970-01-01T00:00:00.000Z",
        expiresAt: null,
      },
    ],
    operator: null,
    delegationCapabilities: capabilities,
    approval: null,
  };
  const identity = { current: async () => principal };
  const auth = new Authorizer(
    identity,
    {
      read: async () => structuredClone(snapshot),
      admission: (_p, _t, check) =>
        db.transaction(() => {
          const next = structuredClone(snapshot);
          const result = check(next);
          snapshot = next;
          return result;
        }),
    },
    () => 1000,
  );
  let calls = 0;
  let locations = 0;
  let recordFails = false;
  let lost = false;
  let correlation = true;
  let preflight = false;
  let genericUnavailable = false;
  let removedAtAdmission = false;
  let last: CreationPlan | undefined;
  const sessions = new Map<string, SessionRef>();
  const byOperation = new Map<string, SessionRef>();
  const host: CreationHostPort = {
    execute: async (plan) => {
      expect(sql.inTransaction).toBe(false);
      calls++;
      last = plan;
      if (preflight) return { state: "pre_effect_unavailable" };
      const observed =
        plan.kind === "fork"
          ? {
              ...source,
              projectID: plan.destination.projectID,
              sessionID: `native-fork-${calls}`,
            }
          : plan.planned;
      if (!observed) throw new Error("fixture expected caller ID for create");
      sessions.set(observed.sessionID, observed);
      byOperation.set(plan.operationID, observed);
      if (genericUnavailable) throw new DomainError("unavailable");
      if (lost) throw new Error("response lost");
      return { state: "created", session: observed };
    },
    inspect: async (plan) => {
      expect(sql.inTransaction).toBe(false);
      return (
        plan.observed ??
        (correlation
          ? (byOperation.get(plan.operationID) ?? null)
          : (plan.planned && sessions.get(plan.planned.sessionID)) || null)
      );
    },
  };
  const records = {
    location: (scope: { projectID: string }) => {
      locations++;
      return scope.projectID;
    },
    crossProjectApproval: (
      tx: Database,
      plan: CreationPlan,
      owner: Principal,
      now: number,
      consume: boolean,
    ) => {
      expect(tx.inTransaction).toBe(true);
      const scope = approvalScope(plan, owner);
      if (!consume)
        return !!tx
          .query(
            "SELECT operation_id FROM approvals WHERE operation_id=? AND expires>? AND consumed=0 AND scope=? AND issuer='fixture-operator'",
          )
          .get(plan.operationID, now, scope);
      return (
        tx
          .query(
            "UPDATE approvals SET consumed=1 WHERE operation_id=? AND expires>? AND consumed=0 AND scope=? AND issuer='fixture-operator'",
          )
          .run(plan.operationID, now, scope).changes === 1
      );
    },
    record: (tx: Database, plan: CreationPlan, observed: SessionRef) => {
      expect(tx.inTransaction).toBe(true);
      if (recordFails) throw new Error("record failed");
      tx.query("INSERT OR IGNORE INTO links VALUES (?,?)").run(
        plan.operationID,
        JSON.stringify(observed),
      );
    },
  };
  const removed = {
    assertAvailable: (tx: Database) => {
      expect(tx.inTransaction).toBe(true);
      if (
        removedAtAdmission &&
        tx
          .query("SELECT operation_id FROM operations WHERE state='pending'")
          .get()
      )
        throw new DomainError("not_found");
    },
  };
  const service = () =>
    new CreationService(db, identity, auth, host, records, removed, () => 1000);
  const input: CreationInput = {
    source,
    destination: { instanceID: source.instanceID, projectID: source.projectID },
    kind: "child",
    capabilities: ["read"],
    idempotencyKey: "key",
    expectedRevision: 1,
  };
  return {
    get sql() {
      return sql;
    },
    get db() {
      return db;
    },
    approve(operationID: string, expires = 2000, matchesScope = true) {
      const row = sql
        .query<{ plan_json: string }, [string]>(
          "SELECT plan_json FROM session_creation_plans WHERE operation_id=?",
        )
        .get(operationID);
      if (!row) throw new Error("fixture plan not found");
      const plan = JSON.parse(row.plan_json) as CreationPlan;
      sql
        .query(
          "INSERT OR REPLACE INTO approvals VALUES (?,?,0,?,'fixture-operator')",
        )
        .run(
          operationID,
          expires,
          matchesScope ? approvalScope(plan, principal) : "wrong-scope",
        );
    },
    reopen() {
      if (path === ":memory:") throw new Error("disk fixture required");
      db.close();
      sql = new Database(path);
      db = new Persistence(sql, () => {});
    },
    input,
    principal,
    service,
    sessions,
    get snapshot() {
      return snapshot;
    },
    get calls() {
      return calls;
    },
    get locations() {
      return locations;
    },
    get last() {
      return last;
    },
    failRecord: (v: boolean) => {
      recordFails = v;
    },
    lose: (correlates = true) => {
      lost = true;
      correlation = correlates;
    },
    preflight: () => {
      preflight = true;
    },
    uncertainUnavailable: () => {
      genericUnavailable = true;
    },
    removeAtAdmission: () => {
      removedAtAdmission = true;
    },
    recoverLeases: () =>
      new Operations(db, auth, () => 1000, removed).recover(),
  };
}

test("create uses T13 admitted receipt, native child, audit/outbox and replay", async () => {
  const f = fixture();
  try {
    const result = await f.service().create(f.input);
    expect(result.operation?.state).toBe("admitted");
    expect(result.linked).toBe(true);
    expect(result.operation?.receiptID).toBe(result.session?.sessionID);
    expect(f.last?.parent).toEqual(f.input.source);
    expect(await f.service().create(f.input)).toEqual(result);
    expect(f.calls).toBe(1);
    expect(
      f.sql.query("SELECT state FROM operation_audit ORDER BY rowid").all(),
    ).toEqual([
      { state: "pending" },
      { state: "dispatching" },
      { state: "admitted" },
    ]);
    await expect(
      f.service().create({ ...f.input, capabilities: [] }),
    ).rejects.toMatchObject({ code: "conflict" });
  } finally {
    f.db.close();
  }
});

test("missing delegation awaits without routing oracle; excessive delegation forbidden", async () => {
  const f = fixture();
  try {
    f.snapshot.delegationCapabilities = null;
    expect((await f.service().create(f.input)).state).toBe("awaiting_approval");
    expect(f.locations).toBe(0);
    f.snapshot.delegationCapabilities = [];
    await expect(f.service().create(f.input)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(f.calls).toBe(0);
    expect(f.sql.query("SELECT * FROM operations").all()).toEqual([]);
  } finally {
    f.db.close();
  }
});

test("cross-project approval binds operation, expires, consumes once with admission", async () => {
  const f = fixture();
  try {
    const input = {
      ...f.input,
      destination: { ...f.input.destination, projectID: "other" },
    };
    const pending = await f.service().create(input);
    expect(pending.state).toBe("awaiting_approval");
    expect(pending.operation?.state).toBe("pending");
    expect(f.calls).toBe(0);
    f.approve(operationID(pending), 1000);
    expect((await f.service().create(input)).state).toBe("awaiting_approval");
    f.approve(operationID(pending), 2000, false);
    expect((await f.service().create(input)).state).toBe("awaiting_approval");
    f.approve(operationID(pending));
    f.sql.query("UPDATE approvals SET expires=2000").run();
    const admitted = await f.service().create(input);
    expect(admitted.operation?.state).toBe("admitted");
    expect(f.last?.parent).toBeNull();
    expect(f.sql.query("SELECT consumed FROM approvals").get()).toEqual({
      consumed: 1,
    });
    await f.service().create(input);
    expect(f.calls).toBe(1);
  } finally {
    f.db.close();
  }
});

test("supervised once preserves delegation binding at intent and consumes at dispatch", async () => {
  const f = fixture();
  try {
    f.snapshot.profile = "supervised";
    f.snapshot.approval = {
      principal: f.principal,
      target: f.input.source,
      capability: "manage",
      revision: 1,
      mode: "once",
      expiresAt: "1970-01-01T00:00:10.000Z",
    };
    const result = await f.service().create(f.input);
    expect(result.operation?.state).toBe("admitted");
    expect(f.snapshot.approval).toBeNull();
    expect((await f.service().create(f.input)).operation?.state).toBe(
      "admitted",
    );
    expect(f.calls).toBe(1);
  } finally {
    f.db.close();
  }
});

test("fork accepts host-assigned ID and plan allowlist; no adapter inheritance proof", async () => {
  const f = fixture();
  try {
    const result = await f
      .service()
      .create({ ...f.input, kind: "fork", capabilities: [] });
    expect(result.operation?.state).toBe("admitted");
    expect(result.session?.sessionID).toBe("native-fork-1");
    expect(result.operation?.receiptID).toBe("native-fork-1");
    expect(f.last?.planned).toBeNull();
    expect(f.last?.capabilities).toEqual([]);
    expect(f.last).not.toHaveProperty("grants");
    expect(f.last).not.toHaveProperty("jobs");
  } finally {
    f.db.close();
  }
});

test("lost fork response without correlation remains unknown; never retries", async () => {
  const f = fixture();
  try {
    f.lose(false);
    const input = { ...f.input, kind: "fork" as const };
    const result = await f.service().create(input);
    expect(result.operation?.state).toBe("unknown_outcome");
    expect(result.session).toBeNull();
    expect(
      (await f.service().recover(operationID(result))).operation?.state,
    ).toBe("unknown_outcome");
    await f.service().create(input);
    expect(f.calls).toBe(1);
  } finally {
    f.db.close();
  }
});

test("lost correlated fork response recovers native observed ID", async () => {
  const f = fixture();
  try {
    f.lose();
    const input = { ...f.input, kind: "fork" as const };
    const result = await f.service().create(input);
    const recovered = await f.service().recover(operationID(result));
    expect(recovered.operation?.state).toBe("admitted");
    expect(recovered.session?.sessionID).toBe("native-fork-1");
    expect(recovered.linked).toBe(true);
    expect(f.calls).toBe(1);
  } finally {
    f.db.close();
  }
});

test("observed fork ID persists before failed lineage recording and recovers without host retry", async () => {
  const root = mkdtempSync(
    "/tmp/opencode/opencode-sessions-tools/t16-creation-",
  );
  const f = fixture(`${root}/synthetic.sqlite`);
  try {
    f.failRecord(true);
    const input = { ...f.input, kind: "fork" as const };
    const result = await f.service().create(input);
    expect(result.operation?.state).toBe("admitted");
    expect(result.session?.sessionID).toBe("native-fork-1");
    expect(result.linked).toBe(false);
    f.reopen();
    f.failRecord(false);
    expect((await f.service().recover(operationID(result))).linked).toBe(true);
    expect(f.calls).toBe(1);
  } finally {
    f.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit pre-effect unavailable rejects; thrown unavailable after call stays uncertain", async () => {
  const a = fixture();
  const b = fixture();
  try {
    a.preflight();
    expect((await a.service().create(a.input)).operation?.state).toBe(
      "rejected",
    );
    expect(a.sessions.size).toBe(0);
    b.uncertainUnavailable();
    expect((await b.service().create(b.input)).operation?.state).toBe(
      "unknown_outcome",
    );
    expect(b.sessions.size).toBe(1);
  } finally {
    a.db.close();
    b.db.close();
  }
});

test("concurrent replay exposes actual inflight state, not invented unknown", async () => {
  const f = fixture();
  try {
    const results = await Promise.all([
      f.service().create(f.input),
      f.service().create(f.input),
    ]);
    expect(results[0]?.operation?.operationID).toBe(
      results[1]?.operation?.operationID,
    );
    expect(results.every((r) => r.operation?.state !== "unknown_outcome")).toBe(
      true,
    );
    expect(f.calls).toBe(1);
  } finally {
    f.db.close();
  }
});

test("replay/recovery compare caller with persisted owner, not caller with itself", async () => {
  const f = fixture();
  try {
    const result = await f.service().create(f.input);
    const foreign: Principal = {
      kind: "session",
      session: { ...f.input.source, sessionID: "other-owner" },
    };
    f.sql
      .query("UPDATE operations SET owner_json=?")
      .run(JSON.stringify(foreign));
    await expect(f.service().create(f.input)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      f.service().recover(operationID(result)),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(f.calls).toBe(1);
  } finally {
    f.db.close();
  }
});

test("supervised cross-project intent saves full delegated once binding until exact-operation approval", async () => {
  const f = fixture();
  try {
    f.snapshot.profile = "supervised";
    f.snapshot.approval = {
      principal: f.principal,
      target: f.input.source,
      capability: "manage",
      revision: 1,
      mode: "once",
      expiresAt: "1970-01-01T00:00:10.000Z",
    };
    const input = {
      ...f.input,
      destination: { ...f.input.destination, projectID: "other" },
    };
    const pending = await f.service().create(input);
    expect(pending.operation?.state).toBe("pending");
    expect(f.snapshot.approval?.operationID).toBe(operationID(pending));
    expect(f.snapshot.approval?.delegation).toEqual({
      requested: ["read"],
      requiredCapabilities: [],
    });
    expect(f.calls).toBe(0);
    f.approve(operationID(pending));
    expect((await f.service().create(input)).operation?.state).toBe("admitted");
    expect(f.snapshot.approval).toBeNull();
    expect(f.calls).toBe(1);
  } finally {
    f.db.close();
  }
});

test("fork read/manage checks are enforced before host by real delegated admission", async () => {
  const f = fixture();
  try {
    f.snapshot.deniedCapabilities = ["read"];
    await expect(
      f.service().create({ ...f.input, kind: "fork", capabilities: [] }),
    ).rejects.toMatchObject({ code: "forbidden" });
    f.snapshot.deniedCapabilities = ["manage"];
    await expect(
      f.service().create({ ...f.input, kind: "fork", capabilities: [] }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(f.calls).toBe(0);
    expect(f.locations).toBe(0);
  } finally {
    f.db.close();
  }
});

test("removed-target guard rolls back cross-project consumption in the same admission transaction", async () => {
  const f = fixture();
  try {
    f.snapshot.profile = "supervised";
    f.snapshot.approval = {
      principal: f.principal,
      target: f.input.source,
      capability: "manage",
      revision: 1,
      mode: "once",
      expiresAt: "1970-01-01T00:00:10.000Z",
    };
    const input = {
      ...f.input,
      destination: { ...f.input.destination, projectID: "other" },
    };
    const pending = await f.service().create(input);
    const before = structuredClone(f.snapshot.approval);
    f.approve(operationID(pending));
    f.removeAtAdmission();
    await expect(f.service().create(input)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(f.sql.query("SELECT consumed FROM approvals").get()).toEqual({
      consumed: 0,
    });
    expect(f.sql.query("SELECT state FROM operations").get()).toEqual({
      state: "pending",
    });
    expect(
      f.sql.query("SELECT state FROM operation_audit ORDER BY rowid").all(),
    ).toEqual([{ state: "pending" }]);
    expect(f.calls).toBe(0);
    expect(f.snapshot.approval).toEqual(before);
  } finally {
    f.db.close();
  }
});

test("synthetic dispatching crash snapshot is fenced/recovered by T13, never domain retries", async () => {
  const f = fixture();
  try {
    f.lose(false);
    const result = await f.service().create(f.input);
    const id = operationID(result);
    // Reconstruct the persisted boundary before finish() after a hypothetical
    // process death. This is state-injection, not a real killed-host E2E test.
    f.sql
      .query("UPDATE operations SET state='dispatching' WHERE operation_id=?")
      .run(id);
    f.sql
      .query("UPDATE operation_outbox SET expires_at=999 WHERE operation_id=?")
      .run(id);
    expect((await f.service().create(f.input)).operation?.state).toBe(
      "dispatching",
    );
    expect((await f.service().recover(id)).operation?.state).toBe(
      "dispatching",
    );
    expect(f.recoverLeases()).toBe(1);
    const recovered = await f.service().recover(id);
    expect(recovered.operation?.state).toBe("admitted");
    expect(recovered.session).toEqual(f.last?.planned ?? null);
    expect(f.calls).toBe(1);
    expect(
      f.sql
        .query("SELECT state FROM operation_audit ORDER BY rowid DESC LIMIT 2")
        .all(),
    ).toEqual([{ state: "admitted" }, { state: "unknown_outcome" }]);
  } finally {
    f.db.close();
  }
});
