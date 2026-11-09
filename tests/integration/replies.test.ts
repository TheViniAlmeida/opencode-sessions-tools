import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
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
  dispatcherMigrationAt,
} from "../../src/messaging/dispatcher";
import {
  Replies,
  type ReplyTimerPort,
  type ReplyWakePort,
  repliesMigrationAt,
  repliesRemovedCleanup,
} from "../../src/messaging/replies";
import { Persistence } from "../../src/persistence/database";
import { operationMigrationAt } from "../../src/persistence/operations";
import {
  reconciliationMigrationAt,
  removedTargetPort,
} from "../../src/sessions/reconcile";

const databases: Database[] = [];
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
    dispatcherMigrationAt(4),
    repliesMigrationAt(5),
  ])
    m.apply(db, "synthetic");
  const persistence = new Persistence(db, () => {});
  const source: SessionRef = {
    version: 1,
    instanceID: "isolated",
    projectID: "p",
    sessionID: "source",
  };
  const target: SessionRef = { ...source, sessionID: "target" };
  const sender: Principal = { kind: "session", session: source };
  const receiver: Principal = { kind: "session", session: target };
  let actor: Principal = sender;
  const identity = { current: async () => actor };
  const snapshot: AuthorizationSnapshot = {
    revision: 1,
    profile: "manage",
    profileCapabilities: capabilities,
    policyCapabilities: capabilities,
    hostCapabilities: capabilities,
    deniedCapabilities: [],
    grants: [],
    operator: null,
    delegationCapabilities: null,
    approval: null,
  };
  const auth = new Authorizer(
    identity,
    {
      read: async () => snapshot,
      admission: (_p, _t, check) =>
        persistence.transaction(() => check(snapshot)),
    },
    () => 1000,
  );
  const listeners = new Set<() => void>();
  let onSubscribe: (() => void) | undefined;
  const wakes: ReplyWakePort = {
    subscribe(_id, wake) {
      listeners.add(wake);
      onSubscribe?.();
      return () => {
        listeners.delete(wake);
      };
    },
    publish() {
      for (const wake of listeners) wake();
    },
  };
  let deadline: (() => void) | undefined;
  let timers = 0;
  const clock: ReplyTimerPort = {
    schedule(ms, wake) {
      expect(ms).toBeLessThanOrEqual(30000);
      deadline = wake;
      timers++;
      return () => {
        timers--;
        deadline = undefined;
      };
    },
  };
  const service = () =>
    new Replies(
      persistence,
      identity,
      auth,
      removedTargetPort,
      wakes,
      () => 1000,
      clock,
    );
  const receiverIdentity = { current: async () => receiver };
  const receiverAuth = new Authorizer(
    receiverIdentity,
    {
      read: async () => snapshot,
      admission: (_p, _t, check) =>
        persistence.transaction(() => check(snapshot)),
    },
    () => 1000,
  );
  const receiverService = () =>
    new Replies(
      persistence,
      receiverIdentity,
      receiverAuth,
      removedTargetPort,
      wakes,
      () => 1000,
      clock,
    );
  const dispatcher = new Dispatcher(
    persistence,
    identity,
    auth,
    { current: async () => null },
    {
      send: async (p) => ({ state: "accepted", messageID: p.messageID }),
      inspect: async () => ({ state: "unknown_outcome" }),
    },
    () => 1000,
    removedTargetPort,
  );
  const request = async (deliver = true) => {
    actor = sender;
    const op = await dispatcher.request({
      target,
      content: "question",
      expiresAt: 2000,
      expectedRevision: 1,
      idempotencyKey: crypto.randomUUID(),
    });
    if (deliver) await dispatcher.deliver(op.operationID, 1);
    return op.operationID;
  };
  const reply = (
    id: string,
    type: "notification" | "final" = "final",
    key = "k",
    content = "answer",
  ) =>
    service().reply({
      requestID: id,
      expectedRevision: 1,
      idempotencyKey: key,
      body: { type, content },
    });
  return {
    db,
    persistence,
    service,
    receiverService,
    identity,
    auth,
    wakes,
    clock,
    request,
    reply,
    snapshot,
    sender,
    receiver,
    source,
    target,
    listeners,
    actor(p: Principal) {
      actor = p;
    },
    wake() {
      wakes.publish("ignored");
    },
    timeout() {
      deadline?.();
    },
    subscribe(fn: () => void) {
      onSubscribe = fn;
    },
    timers: () => timers,
  };
}
async function subscribed(f: ReturnType<typeof fixture>) {
  // Drain a bounded number of microtasks, never model or real-time polling.
  for (let i = 0; i < 100 && f.listeners.size === 0; i++)
    await Promise.resolve();
  expect(f.listeners.size).toBe(1);
}
test("real dispatcher correlation, trusted author, receipt, durable instance recreation", async () => {
  const f = fixture();
  const id = await f.request();
  f.actor(f.receiver);
  const receipt = await f.reply(id);
  expect(receipt.author).toEqual(f.receiver);
  expect(receipt.requestMessageID).toMatch(/^msg_/);
  expect(receipt.taskID).toBe(`task_${id}`);
  expect(receipt.correlationID.length).toBeGreaterThan(0);
  expect(await f.reply(id)).toEqual(receipt);
  await expect(f.reply(id, "final", "k", "different")).rejects.toThrow(
    "conflict",
  );
  f.actor(f.sender);
  const page = await f.service().getResult(id);
  expect(page.state).toBe("completed");
  expect(page.items).toEqual([receipt]);
  expect(page.cursor).not.toContain(id);
  expect((await f.service().getResult(id, page.cursor)).items).toEqual([]);
});
test("third sessions cannot reply, getResult or reuse another cursor; fake and pending IDs rejected", async () => {
  const f = fixture();
  const id = await f.request();
  const pending = await f.request(false);
  const cursor = (await f.service().getResult(id)).cursor;
  f.actor({ kind: "session", session: { ...f.source, sessionID: "third" } });
  await expect(f.reply(id)).rejects.toThrow("not_found");
  await expect(f.service().getResult(id, cursor)).rejects.toThrow("not_found");
  f.actor(f.receiver);
  await expect(f.reply("invented")).rejects.toThrow("not_found");
  await expect(f.reply(pending)).rejects.toThrow("not_found");
  f.actor(f.sender);
  await expect(f.service().getResult(pending, cursor)).rejects.toThrow(
    "not_found",
  );
});
test("notification and task outcome do not imply final; no idle dependency", async () => {
  const f = fixture();
  const id = await f.request();
  f.actor(f.receiver);
  await f.reply(id, "notification");
  await f.service().reply({
    requestID: id,
    expectedRevision: 1,
    idempotencyKey: "outcome",
    body: {
      type: "task_outcome",
      outcome: "completed",
      content: "task done",
    },
  });
  f.actor(f.sender);
  const page = await f.service().getResult(id);
  expect(page.state).toBe("pending");
  expect(page.items.length).toBe(2);
  f.actor(f.receiver);
  await f.reply(id, "final", "final");
  await expect(f.reply(id, "notification", "late")).rejects.toThrow("conflict");
  f.actor(f.sender);
  expect((await f.service().getResult(id, page.cursor)).state).toBe(
    "completed",
  );
});
test("bounded wait timeout cleans subscription/timer; late reply is replayed once", async () => {
  const f = fixture();
  const id = await f.request();
  const wait = f.service().wait(id);
  await subscribed(f);
  f.timeout();
  const page = await wait;
  expect(page.state).toBe("pending");
  expect(page.items).toEqual([]);
  expect(f.listeners.size).toBe(0);
  expect(f.timers()).toBe(0);
  f.actor(f.receiver);
  await f.reply(id);
  f.actor(f.sender);
  const later = await f.service().wait(id, { cursor: page.cursor });
  expect(later.items.length).toBe(1);
  expect((await f.service().getResult(id, later.cursor)).items).toEqual([]);
  await expect(f.service().wait(id, { timeoutMs: 30001 })).rejects.toThrow(
    "invalid_input",
  );
});
test("cancel and pre-cancel return pending cursor without leaked resources", async () => {
  const f = fixture();
  const id = await f.request();
  const control = new AbortController();
  const wait = f.service().wait(id, { signal: control.signal });
  await subscribed(f);
  control.abort();
  expect((await wait).state).toBe("pending");
  expect(f.listeners.size).toBe(0);
  expect(f.timers()).toBe(0);
  expect((await f.service().wait(id, { signal: control.signal })).state).toBe(
    "pending",
  );
  expect(f.listeners.size).toBe(0);
});
test("mid-wait revocation fails closed on wake and timeout; no counts or content", async () => {
  for (const trigger of ["wake", "timeout"] as const) {
    const f = fixture();
    const id = await f.request();
    const wait = f.service().wait(id);
    await subscribed(f);
    f.snapshot.deniedCapabilities = ["message"];
    f[trigger]();
    await expect(wait).rejects.toThrow("forbidden");
    expect(f.listeners.size).toBe(0);
    expect(f.timers()).toBe(0);
  }
});
test("subscribe race is caught by second DB read, no lost wakeup", async () => {
  const f = fixture();
  const id = await f.request();
  // Simulate another already-committed connection between first check/subscribe.
  f.actor(f.receiver);
  await f.reply(id);
  f.actor(f.sender);
  const row = f.db
    .query<{ sequence: number }, []>("SELECT sequence FROM request_replies")
    .get();
  expect(row).not.toBeNull();
  f.db.exec(
    "CREATE TEMP TABLE race_reply AS SELECT * FROM request_replies; DELETE FROM request_replies",
  );
  f.subscribe(() => {
    f.db.exec("INSERT INTO request_replies SELECT * FROM race_reply");
  });
  const page = await f.service().wait(id);
  expect(page.items.length).toBe(1);
  expect(page.state).toBe("completed");
  expect(f.listeners.size).toBe(0);
  expect(f.timers()).toBe(0);
});
test("tombstones block replay and T18 cleanup removes only related plugin content", async () => {
  const f = fixture();
  const id = await f.request();
  f.actor(f.receiver);
  await f.reply(id);
  f.actor(f.sender);
  await f.service().getResult(id);
  f.persistence.transaction((db) => {
    db.query("INSERT INTO session_tombstones VALUES (?,?,?,?)").run(
      f.target.instanceID,
      f.target.sessionID,
      f.target.projectID,
      1000,
    );
    repliesRemovedCleanup.cleanup(db, f.target);
  });
  await expect(f.service().getResult(id)).rejects.toThrow("not_found");
  expect(f.db.query("SELECT * FROM request_replies").all()).toEqual([]);
  expect(f.db.query("SELECT * FROM reply_cursors").all()).toEqual([]);
});
test("committed reply wakes an active wait using distinct trusted caller contexts", async () => {
  const f = fixture();
  const id = await f.request();
  const wait = f.service().wait(id);
  await subscribed(f);
  await f.receiverService().reply({
    requestID: id,
    expectedRevision: 1,
    idempotencyKey: "live",
    body: { type: "final", content: "live answer" },
  });
  const page = await wait;
  expect(page.items[0]?.body.content).toBe("live answer");
  expect(page.state).toBe("completed");
  expect(f.listeners.size).toBe(0);
  expect(f.timers()).toBe(0);
});
test("file-backed SQLite restart preserves replies and opaque cursors; revoked ACL still wins", async () => {
  const root = mkdtempSync(
    "/tmp/opencode/opencode-sessions-tools/t21-replies-",
  );
  const path = join(root, "replies.sqlite");
  const f = fixture(path);
  const id = await f.request();
  const pending = await f.service().getResult(id);
  await f.receiverService().reply({
    requestID: id,
    expectedRevision: 1,
    idempotencyKey: "restart",
    body: { type: "final", content: "persisted" },
  });
  f.db.close();
  databases.splice(databases.indexOf(f.db), 1);
  const restored = new Database(path);
  const service = new Replies(
    new Persistence(restored, () => {}),
    f.identity,
    f.auth,
    removedTargetPort,
    f.wakes,
    () => 1000,
    f.clock,
  );
  try {
    const page = await service.getResult(id, pending.cursor);
    expect(page.items[0]?.body.content).toBe("persisted");
    expect(page.state).toBe("completed");
    expect((await service.getResult(id, page.cursor)).items).toEqual([]);
    f.snapshot.deniedCapabilities = ["message"];
    await expect(service.getResult(id, pending.cursor)).rejects.toThrow(
      "forbidden",
    );
  } finally {
    restored.close();
    for (const entry of readdirSync(root)) unlinkSync(join(root, entry));
    rmdirSync(root);
  }
});
