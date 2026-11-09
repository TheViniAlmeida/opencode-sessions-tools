import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import {
  type AuthorizationSnapshot,
  Authorizer,
} from "../../src/authorization/authorize";
import {
  capabilities,
  type Principal,
  type SessionRef,
} from "../../src/contracts";
import {
  Dispatcher,
  dispatcherExpirySQL,
  dispatcherMigrationAt,
  type NativePrompt,
  type PromptHostPort,
} from "../../src/messaging/dispatcher";
import { Inbox, inboxMigrationAt } from "../../src/messaging/inbox";
import { Persistence } from "../../src/persistence/database";
import {
  operationMigrationAt,
  pendingGrantOperations,
} from "../../src/persistence/operations";
import {
  reconciliationMigrationAt,
  removedTargetPort,
} from "../../src/sessions/reconcile";

const databases: Database[] = [];
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("missing fixture value");
  return value;
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture(path = ":memory:") {
  const db = new Database(path);
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  for (const m of [
    operationMigrationAt(2),
    reconciliationMigrationAt(3),
    inboxMigrationAt(4),
    dispatcherMigrationAt(5),
  ])
    m.apply(db, "synthetic");
  const persistence = new Persistence(db, () => {});
  const source: SessionRef = {
    version: 1,
    instanceID: "isolated",
    projectID: "p",
    sessionID: "source",
  };
  const target: SessionRef = { ...source, projectID: "q", sessionID: "target" };
  let actor: Principal = { kind: "session", session: source };
  let now = 1000;
  let context: { correlationID: string; hops: number } | null = null;
  const identity = { current: async () => actor };
  const snapshot: AuthorizationSnapshot = {
    revision: 1,
    profile: "manage",
    profileCapabilities: capabilities,
    policyCapabilities: capabilities,
    hostCapabilities: capabilities,
    deniedCapabilities: [],
    operator: null,
    delegationCapabilities: null,
    approval: null,
    grants: [
      {
        version: 1,
        grantID: "g",
        source,
        target,
        capabilities: ["message"],
        revision: 1,
        issuer: {
          kind: "operator",
          instanceID: "isolated",
          operatorID: "o",
          revision: 1,
        },
        createdAt: new Date(0).toISOString(),
        expiresAt: null,
      },
    ],
  };
  db.exec("CREATE TABLE fixture_policy(body TEXT NOT NULL)");
  db.query("INSERT INTO fixture_policy VALUES (?)").run(
    JSON.stringify(snapshot),
  );
  const load = () =>
    JSON.parse(
      required(
        db.query<{ body: string }, []>("SELECT body FROM fixture_policy").get(),
      ).body,
    ) as AuthorizationSnapshot;
  const save = () =>
    db.query("UPDATE fixture_policy SET body=?").run(JSON.stringify(snapshot));
  const auth = new Authorizer(
    identity,
    {
      read: async () => persistence.transaction(load),
      admission: (_p, _t, check) =>
        persistence.transaction(() => {
          const s = load();
          const result = check(s);
          db.query("UPDATE fixture_policy SET body=?").run(JSON.stringify(s));
          return result;
        }),
    },
    () => now,
  );
  const sent: NativePrompt[] = [];
  let send: PromptHostPort["send"] = async (p) => ({
    state: "accepted",
    messageID: p.messageID,
  });
  let inspect: PromptHostPort["inspect"] = async (p) => ({
    state: "accepted",
    messageID: p.messageID,
    payloadHash: p.payloadHash,
  });
  const host: PromptHostPort = {
    send: async (p) => {
      expect(db.inTransaction).toBe(false);
      expect(
        db
          .query("SELECT * FROM prompt_dispatches WHERE message_id=?")
          .get(p.messageID),
      ).not.toBeNull();
      sent.push(p);
      return send(p);
    },
    inspect: (p) => inspect(p),
  };
  const worker = () =>
    new Dispatcher(
      persistence,
      identity,
      auth,
      { current: async () => context },
      host,
      () => now,
      removedTargetPort,
    );
  const input = (key = "k") => ({
    target,
    content: "PRIVATE",
    expiresAt: 2000,
    expectedRevision: 1,
    idempotencyKey: key,
  });
  const state = (id: string) =>
    db
      .query<{ state: string }, [string]>(
        "SELECT state FROM operations WHERE operation_id=?",
      )
      .get(id)?.state;
  return {
    db,
    persistence,
    source,
    target,
    snapshot,
    save,
    sent,
    worker,
    input,
    state,
    auth,
    identity,
    inbox: new Inbox(persistence, identity, auth, () => now, removedTargetPort),
    time: (n: number) => {
      now = n;
    },
    context: (c: typeof context) => {
      context = c;
    },
    actor: (p: Principal) => {
      actor = p;
    },
    send: (s: typeof send) => {
      send = s;
    },
    inspect: (s: typeof inspect) => {
      inspect = s;
    },
    revoke: () =>
      persistence.transaction((sql) => {
        const grant = required(snapshot.grants[0]);
        snapshot.grants = [];
        save();
        return pendingGrantOperations(() => now).revoke(sql, grant);
      }),
  };
}

test("durable correlated task, stable IDs/hash and native receipt, same-key replay has no send", async () => {
  const f = fixture(),
    w = f.worker();
  const op = await w.request(f.input());
  expect(f.sent).toHaveLength(0);
  expect(f.db.query("SELECT * FROM prompt_dispatches").all()).toHaveLength(1);
  const admitted = await w.deliver(op.operationID, 1);
  expect(admitted).toMatchObject({
    state: "admitted",
    channel: "host",
    receiptID: required(f.sent[0]).messageID,
  });
  expect(await w.request(f.input())).toEqual(admitted);
  expect(f.sent).toHaveLength(1);
  await expect(
    w.request({ ...f.input(), content: "different" }),
  ).rejects.toThrow("conflict");
  expect(f.sent[0]).toMatchObject({
    policy: "queue",
    hops: 1,
    payloadHash: op.payloadHash,
  });
});

test("direct delivery expires only its pending intent and audits atomically", async () => {
  const f = fixture(),
    w = f.worker();
  const expired = await w.request(f.input("expired"));
  const untouched = await w.request(f.input("untouched"));
  f.time(2000);
  await expect(w.deliver(expired.operationID, 1)).rejects.toThrow("expired");
  expect(f.state(expired.operationID)).toBe("expired");
  expect(f.state(untouched.operationID)).toBe("pending");
  expect(
    f.db.query("SELECT * FROM operation_audit WHERE state='expired'").all(),
  ).toHaveLength(1);
  await expect(w.deliver(expired.operationID, 1)).rejects.toThrow("expired");
  expect(
    f.db.query("SELECT * FROM operation_audit WHERE state='expired'").all(),
  ).toHaveLength(1);
  expect(f.sent).toHaveLength(0);
});

test("expiry audit failure rolls back state and direct delivery never sends", async () => {
  const f = fixture(),
    w = f.worker();
  const op = await w.request(f.input());
  f.db.exec(
    "CREATE TRIGGER fail_expiry BEFORE INSERT ON operation_audit WHEN NEW.state='expired' BEGIN SELECT RAISE(ABORT,'synthetic'); END",
  );
  f.time(2000);
  await expect(w.deliver(op.operationID, 1)).rejects.toThrow("unavailable");
  expect(f.state(op.operationID)).toBe("pending");
  expect(f.sent).toHaveLength(0);
});

test("catchup query plan searches partial pending-message index, not operation history", () => {
  const f = fixture();
  const plan = f.db
    .query<{ detail: string }, [number]>(
      `EXPLAIN QUERY PLAN ${dispatcherExpirySQL} RETURNING operation_id`,
    )
    .all(2000)
    .map((r) => r.detail)
    .join("\n");
  expect(plan).toContain(
    "SEARCH operations USING INDEX prompt_pending_message_expiry",
  );
  expect(plan).not.toMatch(/SCAN operations/);
});

test("supervised second blocked by pending head preserves once reservation and audit", async () => {
  const f = fixture(),
    w = f.worker();
  const head = await w.request(f.input("head"));
  f.snapshot.profile = "supervised";
  f.snapshot.approval = {
    principal: { kind: "session", session: f.source },
    target: f.target,
    capability: "message",
    revision: 1,
    expiresAt: new Date(5000).toISOString(),
    mode: "once",
  };
  f.save();
  const second = await w.request(f.input("second"));
  const before = required(
    f.db.query<{ body: string }, []>("SELECT body FROM fixture_policy").get(),
  ).body;
  const audit = f.db
    .query("SELECT * FROM operation_audit ORDER BY sequence")
    .all();
  await expect(w.deliver(second.operationID, 1)).rejects.toThrow("conflict");
  expect(
    required(
      f.db.query<{ body: string }, []>("SELECT body FROM fixture_policy").get(),
    ).body,
  ).toBe(before);
  expect(JSON.parse(before).approval.operationID).toBe(second.operationID);
  expect(
    f.db.query("SELECT * FROM operation_audit ORDER BY sequence").all(),
  ).toEqual(audit);
  expect(f.state(head.operationID)).toBe("pending");
  expect(f.state(second.operationID)).toBe("pending");
  expect(f.sent).toHaveLength(0);
});

test("chain limit rejection deduplicates and cannot write before authorization", async () => {
  const f = fixture(),
    w = f.worker();
  f.context({ correlationID: "same-chain", hops: 8 });
  for (let n = 0; n < 20; n++)
    await expect(w.request(f.input(`reject-${n}`))).rejects.toThrow(
      "rate_limited",
    );
  expect(
    f.db.query("SELECT * FROM prompt_chain_rejections").all(),
  ).toHaveLength(1);
  f.snapshot.deniedCapabilities = ["message"];
  f.save();
  f.context({ correlationID: "unauthorized-chain", hops: 8 });
  await expect(w.request(f.input("denied"))).rejects.toThrow("not_found");
  expect(
    f.db.query("SELECT * FROM prompt_chain_rejections").all(),
  ).toHaveLength(1);
  expect(f.db.query("SELECT * FROM operations").all()).toHaveLength(0);
});

test("two subprocess workers serialize file SQLite FIFO while pending and dispatching", async () => {
  const root = mkdtempSync("/tmp/opencode/opencode-sessions-tools/dispatcher-");
  const f = fixture(`${root}/worker.sqlite`),
    w = f.worker();
  f.db.exec("PRAGMA journal_mode=WAL");
  f.db.exec(
    "CREATE TABLE fixture_host_active(operation_id TEXT PRIMARY KEY); CREATE TABLE fixture_host_log(sequence INTEGER PRIMARY KEY,operation_id TEXT NOT NULL,phase TEXT NOT NULL)",
  );
  const head = await w.request(f.input("head")),
    second = await w.request(f.input("second"));
  const launch = (id: string, hold = false, at = 1000) =>
    Bun.spawn(
      [
        process.execPath,
        `${import.meta.dir}/fixtures/dispatcher-worker.ts`,
        `${root}/worker.sqlite`,
        id,
        hold ? "hold" : "send",
        String(at),
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
  const blocked = async (at: number, generation: number) => {
    const child = launch(second.operationID, false, at);
    expect(await new Response(child.stdout).text()).toBe("ERROR conflict\n");
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
    expect(
      f.db
        .query<{ generation: number }, [string]>(
          "SELECT generation FROM operation_outbox WHERE operation_id=?",
        )
        .get(second.operationID)?.generation,
    ).toBe(generation);
  };
  let active: ReturnType<typeof launch> | undefined;
  try {
    await blocked(1000, 1);
    active = launch(head.operationID, true);
    const reader = active.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      "ENTER\n",
    );
    expect(f.state(head.operationID)).toBe("dispatching");
    await blocked(1001, 2);
    expect(f.db.query("SELECT * FROM fixture_host_active").all()).toHaveLength(
      1,
    );
    active.stdin.end();
    let output = "";
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      output += new TextDecoder().decode(part.value);
    }
    expect(output).toBe("DONE admitted\n");
    expect(await active.exited).toBe(0);
    expect(await new Response(active.stderr).text()).toBe("");
    // Advance the deterministic worker clock past B's failed-attempt lease.
    const last = launch(second.operationID, false, 1002);
    expect(await new Response(last.stdout).text()).toBe("DONE admitted\n");
    expect(await last.exited).toBe(0);
    expect(await new Response(last.stderr).text()).toBe("");
    expect(
      f.db
        .query(
          "SELECT operation_id,phase FROM fixture_host_log ORDER BY sequence",
        )
        .all(),
    ).toEqual([
      { operation_id: head.operationID, phase: "enter" },
      { operation_id: head.operationID, phase: "leave" },
      { operation_id: second.operationID, phase: "enter" },
      { operation_id: second.operationID, phase: "leave" },
    ]);
    expect(f.db.query("SELECT * FROM fixture_host_active").all()).toHaveLength(
      0,
    );
  } finally {
    if (active && active.exitCode === null) {
      active.stdin.end();
      await active.exited;
    }
    f.db.close();
    databases.splice(databases.indexOf(f.db), 1);
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
test("two workers serialize FIFO per target; steer explicitly bypasses plugin queue", async () => {
  const f = fixture(),
    a = f.worker(),
    b = f.worker();
  const first = await a.request(f.input("1")),
    second = await a.request(f.input("2"));
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let entered!: () => void;
  const entry = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.send(async (p) => {
    if (p.operationID === first.operationID) {
      entered();
      await gate;
    }
    return { state: "accepted", messageID: p.messageID };
  });
  const running = a.deliver(first.operationID, 1);
  // Await actual host entry, not a timer or assumed microtask count.
  await entry;
  await expect(b.deliver(second.operationID, 1, 10)).rejects.toThrow(
    "conflict",
  );
  const steer = await b.request({ ...f.input("3"), policy: "steer" });
  await b.deliver(steer.operationID, 1);
  expect(f.sent.map((p) => p.operationID)).toEqual([
    first.operationID,
    steer.operationID,
  ]);
  release();
  await running;
  f.time(1010);
  await b.deliver(second.operationID, 1);
  expect(f.sent.map((p) => p.operationID)).toEqual([
    first.operationID,
    steer.operationID,
    second.operationID,
  ]);
});
test("out-of-order head pending cannot overtake, concurrent same operation sends once", async () => {
  const f = fixture(),
    a = f.worker(),
    b = f.worker();
  const one = await a.request(f.input("1")),
    two = await b.request(f.input("2"));
  await expect(b.deliver(two.operationID, 1)).rejects.toThrow("conflict");
  const results = await Promise.allSettled([
    a.deliver(one.operationID, 1),
    b.deliver(one.operationID, 1),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(f.sent).toHaveLength(1);
});
test("trusted chain reaches hop eight and refuses ninth; forged input never resets chain", async () => {
  const f = fixture(),
    w = f.worker();
  f.context({ correlationID: "trusted", hops: 7 });
  const op = await w.request(f.input());
  await w.deliver(op.operationID, 1);
  expect(f.sent[0]).toMatchObject({ correlationID: "trusted", hops: 8 });
  f.context({ correlationID: "trusted", hops: 8 });
  await expect(w.request(f.input("next"))).rejects.toThrow("rate_limited");
  expect(
    f.db
      .query("SELECT reason,correlation_id,hops FROM prompt_chain_rejections")
      .all(),
  ).toEqual([{ reason: "hop_limit", correlation_id: "trusted", hops: 8 }]);
  await expect(w.request({ ...f.input("forge"), hops: 0 })).rejects.toThrow(
    "invalid_input",
  );
});
test("pending revocation rejects; after local admission revocation reports already_admitted", async () => {
  const f = fixture(),
    w = f.worker();
  const op = await w.request(f.input());
  expect(f.revoke()).toEqual({
    rejected: [op.operationID],
    already_admitted: [],
  });
  await expect(w.deliver(op.operationID, 1)).rejects.toThrow("conflict");
  expect(f.sent).toHaveLength(0);
  const g = fixture(),
    v = g.worker();
  const admitted = await v.request(g.input());
  g.send(async (p) => {
    expect(g.revoke().already_admitted).toEqual([admitted.operationID]);
    return { state: "accepted", messageID: p.messageID };
  });
  expect((await v.deliver(admitted.operationID, 1)).state).toBe("admitted");
});
test("fresh policy denial and tombstone prevent host effect", async () => {
  const f = fixture(),
    w = f.worker();
  const op = await w.request(f.input());
  f.snapshot.deniedCapabilities = ["message"];
  f.save();
  await expect(w.deliver(op.operationID, 1)).rejects.toThrow("not_found");
  expect(f.sent).toHaveLength(0);
  const g = fixture(),
    v = g.worker();
  const pending = await v.request(g.input());
  g.db
    .query("INSERT INTO session_tombstones VALUES (?,?,?,?)")
    .run(g.target.instanceID, g.target.sessionID, g.target.projectID, 1000);
  await expect(v.deliver(pending.operationID, 1)).rejects.toThrow("not_found");
  expect(g.sent).toHaveLength(0);
});
test("expiry catchup terminalizes T19 notifications and prompts with audit, no host effect", async () => {
  const f = fixture(),
    w = f.worker();
  const op = await w.request(f.input());
  const notification = await f.inbox.enqueueNotification({
    ...f.input("n"),
    correlationID: "notification",
  });
  f.time(2000);
  expect(w.expirePending()).toBe(2);
  expect(w.expirePending()).toBe(0);
  expect(f.state(op.operationID)).toBe("expired");
  expect(f.state(notification.operationID)).toBe("expired");
  expect(
    f.db.query("SELECT * FROM operation_audit WHERE state='expired'").all(),
  ).toHaveLength(2);
  expect((await w.request(f.input())).state).toBe("expired");
  await expect(w.deliver(op.operationID, 1)).rejects.toThrow("expired");
  expect(f.sent).toHaveLength(0);
});
test("already expired new request rolls back task/operation/once reservation", async () => {
  const f = fixture();
  f.time(2000);
  await expect(f.worker().request(f.input())).rejects.toThrow("expired");
  expect(f.db.query("SELECT * FROM prompt_dispatches").all()).toHaveLength(0);
  expect(f.db.query("SELECT * FROM operations").all()).toHaveLength(0);
});
test("timeout after acceptance stays unknown; blocks FIFO and reconciles identity without retry", async () => {
  const f = fixture(),
    w = f.worker();
  const first = await w.request(f.input()),
    next = await w.request(f.input("next"));
  f.send(async () => {
    throw new Error("timeout");
  });
  expect((await w.deliver(first.operationID, 1)).state).toBe("unknown_outcome");
  await expect(w.deliver(first.operationID, 1)).rejects.toThrow("conflict");
  await expect(w.deliver(next.operationID, 1)).rejects.toThrow("conflict");
  expect((await w.reconcile(first.operationID)).state).toBe("admitted");
  expect(f.sent).toHaveLength(1);
});
test("lease expiration never requeues possible host admission and stale finisher cannot write", async () => {
  const f = fixture(),
    a = f.worker(),
    b = f.worker();
  const op = await a.request(f.input());
  f.send(async (p) => {
    f.time(1010);
    expect(b.recover()).toBe(1);
    return { state: "accepted", messageID: p.messageID };
  });
  await expect(a.deliver(op.operationID, 1, 10)).rejects.toThrow("conflict");
  expect(f.state(op.operationID)).toBe("unknown_outcome");
  await expect(b.deliver(op.operationID, 1)).rejects.toThrow("conflict");
  expect((await b.reconcile(op.operationID)).state).toBe("admitted");
  expect(f.sent).toHaveLength(1);
});
test("mismatched native acceptance and inspection never count as receipt", async () => {
  const f = fixture(),
    w = f.worker();
  const op = await w.request(f.input());
  f.send(async () => ({ state: "accepted", messageID: "wrong" }));
  expect((await w.deliver(op.operationID, 1)).state).toBe("unknown_outcome");
  f.inspect(async (p) => ({
    state: "accepted",
    messageID: p.messageID,
    payloadHash: "wrong",
  }));
  await expect(w.reconcile(op.operationID)).rejects.toThrow("unknown_outcome");
  expect(f.state(op.operationID)).toBe("unknown_outcome");
});
test("guessed operation cannot be leased by different principal", async () => {
  const f = fixture(),
    w = f.worker();
  const op = await w.request(f.input());
  f.actor({ kind: "session", session: f.target });
  await expect(w.deliver(op.operationID, 1)).rejects.toThrow("not_found");
  expect(
    f.db
      .query<{ generation: number }, []>(
        "SELECT generation FROM operation_outbox",
      )
      .get()?.generation,
  ).toBe(0);
});

test("journal persistence failure rolls back intent and forbids native send", async () => {
  const f = fixture();
  f.db.exec(
    "CREATE TRIGGER fail_plan BEFORE INSERT ON prompt_dispatches BEGIN SELECT RAISE(ABORT,'synthetic'); END",
  );
  await expect(f.worker().request(f.input())).rejects.toThrow("unavailable");
  expect(f.db.query("SELECT * FROM operations").all()).toHaveLength(0);
  expect(f.db.query("SELECT * FROM operation_outbox").all()).toHaveLength(0);
  expect(f.sent).toHaveLength(0);
});

test("receipt persistence loss recovers uncertain without second native send", async () => {
  const f = fixture(),
    w = f.worker();
  const op = await w.request(f.input());
  f.db.exec(
    "CREATE TRIGGER fail_receipt BEFORE UPDATE OF state ON operations WHEN NEW.state='admitted' BEGIN SELECT RAISE(ABORT,'synthetic'); END",
  );
  await expect(w.deliver(op.operationID, 1)).rejects.toThrow("unknown_outcome");
  f.time(31_000);
  expect(w.recover()).toBe(1);
  await expect(w.deliver(op.operationID, 1)).rejects.toThrow("conflict");
  expect(f.state(op.operationID)).toBe("unknown_outcome");
  expect(f.sent).toHaveLength(1);
});

test("once approval consumed with local admission, never a failed FIFO attempt", async () => {
  const f = fixture(),
    w = f.worker();
  f.snapshot.profile = "supervised";
  f.snapshot.approval = {
    principal: { kind: "session", session: f.source },
    target: f.target,
    capability: "message",
    revision: 1,
    expiresAt: new Date(5000).toISOString(),
    mode: "once",
  };
  f.save();
  const op = await w.request(f.input());
  expect(
    JSON.parse(
      required(
        f.db
          .query<{ body: string }, []>("SELECT body FROM fixture_policy")
          .get(),
      ).body,
    ).approval.operationID,
  ).toBe(op.operationID);
  await w.deliver(op.operationID, 1);
  expect(
    JSON.parse(
      required(
        f.db
          .query<{ body: string }, []>("SELECT body FROM fixture_policy")
          .get(),
      ).body,
    ).approval,
  ).toBeNull();
});

test("explicit native rejection is terminal and unresolved inspection never permits retry", async () => {
  const f = fixture(),
    w = f.worker();
  f.send(async () => ({ state: "rejected" }));
  const rejected = await w.request(f.input());
  expect((await w.deliver(rejected.operationID, 1)).state).toBe("rejected");
  const unknown = await w.request(f.input("unknown"));
  f.send(async () => ({ state: "unknown_outcome" }));
  await w.deliver(unknown.operationID, 1);
  f.inspect(async () => ({ state: "unknown_outcome" }));
  expect((await w.reconcile(unknown.operationID)).state).toBe(
    "unknown_outcome",
  );
  await expect(w.deliver(unknown.operationID, 1)).rejects.toThrow("conflict");
  expect(f.sent).toHaveLength(2);
});
