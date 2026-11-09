import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  DomainError,
  type Principal,
  type SessionRef,
} from "../../src/contracts";
import {
  EVENT_RETENTION_MS,
  type EventInput,
  Events,
  eventKinds,
  eventsMigration,
  eventsMigrationAt,
} from "../../src/observability/events";
import { Persistence } from "../../src/persistence/database";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const target: SessionRef = {
  version: 1,
  instanceID: "i",
  projectID: "p",
  sessionID: "target",
};
const actor: Principal = { kind: "session", session: target };
const input: EventInput = {
  kind: "session.changed",
  target,
  operationID: "op-1",
  payload: {},
};
function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(eventsMigration.sql);
  let now = 1000;
  let allowed = true;
  let identity: Principal | null = actor;
  let checks = 0;
  let duringCheck: (() => void) | undefined;
  const events = new Events(
    new Persistence(db, () => {}),
    { current: async () => identity },
    {
      async authorize() {
        checks++;
        duringCheck?.();
        if (!allowed) throw new DomainError("forbidden");
      },
    },
    () => now,
  );
  return {
    db,
    events,
    setTime: (at: number) => {
      now = at;
    },
    revoke: () => {
      allowed = false;
    },
    identity: (p: Principal | null) => {
      identity = p;
    },
    checks: () => checks,
    onCheck: (fn: () => void) => {
      duringCheck = fn;
    },
  };
}

test("exact catalog, composed migration, no automatic schema installation", () => {
  expect(eventKinds).toEqual([
    "grant.created",
    "grant.revoked",
    "message.admitted",
    "message.rejected",
    "task.state_changed",
    "request.resolved",
    "session.changed",
    "job.state_changed",
    "job.fired",
    "context.changed",
    "budget.changed",
    "operation.unknown",
  ]);
  expect(eventsMigrationAt(9).version).toBe(9);
  expect(() => eventsMigrationAt(1)).toThrow("invalid_input");
  const db = new Database(":memory:");
  databases.push(db);
  const events = new Events(
    new Persistence(db, () => {}),
    { current: async () => actor },
    { authorize: async () => {} },
    () => 1000,
  );
  expect(() => events.append(input, actor)).toThrow("unavailable");
});

test("strict minimal payloads reject prompt/token/raw-error/secret fields before storage", () => {
  const f = fixture();
  for (const key of ["prompt", "token", "secret", "error", "content"]) {
    expect(() =>
      f.events.append(
        { ...input, payload: { [key]: "SYNTHETIC-PRIVATE" } } as EventInput,
        actor,
      ),
    ).toThrow("invalid_input");
  }
  expect(() =>
    f.events.append(
      { ...input, kind: "log.synced" } as unknown as EventInput,
      actor,
    ),
  ).toThrow("invalid_input");
  expect(() =>
    f.events.append(input, {
      ...actor,
      token: "SYNTHETIC-PRIVATE",
    } as Principal),
  ).toThrow("forbidden");
  expect(f.db.query("SELECT * FROM event_journal").all()).toEqual([]);
  expect(f.events.append(input, actor).sequence).toBe(1);
});

test("every catalog schema accepts only its defined minimal fields", () => {
  const f = fixture();
  const payloads = [
    { capabilities: ["read"], revision: 2 },
    { capabilities: ["read"], revision: 3 },
    { channel: "inbox" },
    {},
    { state: "running" },
    { state: "denied" },
    {},
    { state: "paused" },
    {},
    { revision: 1 },
    { revision: 1 },
    {},
  ];
  for (const [index, kind] of eventKinds.entries()) {
    const event = { ...input, kind, payload: payloads[index] } as EventInput;
    expect(f.events.append(event, actor).kind).toBe(kind);
    expect(() =>
      f.events.append(
        {
          ...event,
          payload: { ...event.payload, extra: true },
        } as unknown as EventInput,
        actor,
      ),
    ).toThrow("invalid_input");
  }
  expect(() =>
    f.events.append(
      {
        ...input,
        kind: "grant.created",
        payload: { capabilities: ["root"], revision: 1 },
      } as unknown as EventInput,
      actor,
    ),
  ).toThrow("invalid_input");
});

test("opaque cursor is bound to target and fresh authenticated principal, no hidden counts", async () => {
  const f = fixture();
  f.events.append(input, actor);
  const other = { ...target, sessionID: "other" };
  for (let i = 0; i < 5; i++)
    f.events.append({ ...input, target: other }, actor);
  f.events.append(input, actor);
  const page = await f.events.read({ target, limit: 1 });
  expect(Object.keys(page).sort()).toEqual(["cursor", "items"]);
  expect(page.cursor).toMatch(/^[a-f0-9]{64}$/);
  const next = await f.events.read({ target, cursor: page.cursor });
  expect(next.items.map((e) => e.sequence)).toEqual([2]);
  await expect(
    f.events.read({ target: other, cursor: page.cursor }),
  ).rejects.toThrow("not_found");
  f.identity({ kind: "session", session: other });
  await expect(f.events.read({ target, cursor: page.cursor })).rejects.toThrow(
    "not_found",
  );
  f.identity(null);
  await expect(f.events.read({ target })).rejects.toThrow("forbidden");
});

test("current authorization is checked on replay and again before returning", async () => {
  const f = fixture();
  f.events.append(input, actor);
  const page = await f.events.read({ target });
  f.revoke();
  await expect(f.events.read({ target, cursor: page.cursor })).rejects.toThrow(
    "forbidden",
  );
  const g = fixture();
  g.events.append(input, actor);
  g.onCheck(() => {
    if (g.checks() === 2) g.revoke();
  });
  await expect(g.events.read({ target })).rejects.toThrow("forbidden");
});

test("request resolutions have origin-only scope and do not leak counts to shared read grants", async () => {
  const f = fixture();
  f.events.append(input, actor);
  f.events.append(
    { ...input, kind: "request.resolved", payload: { state: "denied" } },
    actor,
  );
  f.events.append(input, actor);
  const shared = await f.events.read({ target });
  expect(shared.items.map((event) => event.sequence)).toEqual([1, 2]);
  const privatePage = await f.events.read({ target, stream: "requests" });
  expect(privatePage.items.map((event) => event.sequence)).toEqual([1]);
  await expect(
    f.events.read({ target, stream: "session", cursor: privatePage.cursor }),
  ).rejects.toThrow("not_found");
  f.identity({ kind: "session", session: { ...target, sessionID: "reader" } });
  await expect(f.events.read({ target, stream: "requests" })).rejects.toThrow(
    "not_found",
  );
  expect((await f.events.read({ target })).items).toHaveLength(2);
});

test("retention boundary expires even empty cursors, exposes snapshot instruction, never silently skips", async () => {
  const f = fixture();
  const empty = await f.events.read({ target });
  f.events.append(input, actor);
  f.setTime(1000 + EVENT_RETENTION_MS);
  await expect(
    f.events.read({ target, cursor: empty.cursor }),
  ).rejects.toMatchObject({
    code: "expired",
    retryable: false,
    resynchronize: "snapshot",
  });
  f.events.prune();
  await expect(f.events.read({ target, cursor: empty.cursor })).rejects.toThrow(
    "expired",
  );
  expect((await f.events.read({ target })).items).toEqual([]);
  expect(f.events.append(input, actor).sequence).toBe(2);
});

test("rollback atomically removes event and sequence allocation", () => {
  const f = fixture();
  expect(() =>
    f.db.transaction(() => {
      f.events.appendInTransaction(f.db, input, actor);
      throw new Error("synthetic rollback");
    })(),
  ).toThrow();
  expect(f.events.append(input, actor).sequence).toBe(1);
});

test("a still-young cursor fails expired if unread events aged out, before and after pruning", async () => {
  for (const prune of [false, true]) {
    const f = fixture();
    f.setTime(1001);
    const cursor = (await f.events.read({ target })).cursor;
    // Controlled clock regression models an old timestamp admitted after the cursor.
    f.setTime(1000);
    f.events.append(input, actor);
    f.setTime(1000 + EVENT_RETENTION_MS);
    if (prune) f.events.prune();
    await expect(f.events.read({ target, cursor })).rejects.toThrow("expired");
  }
});

test("storage outage exposes only typed unavailable and never raw SQLite diagnostics", async () => {
  const f = fixture();
  f.db.exec("DROP TABLE event_journal");
  expect(() => f.events.append(input, actor)).toThrow("unavailable");
  await expect(f.events.read({ target })).rejects.toMatchObject({
    code: "unavailable",
    message: "unavailable",
    retryable: false,
  });
});

test("rebind/dispose owns one listener and ignores callbacks retained by old source", async () => {
  const f = fixture();
  const callbacks: ((input: EventInput, actor: Principal) => void)[] = [];
  let active = 0;
  const source = {
    subscribe(callback: (input: EventInput, actor: Principal) => void) {
      callbacks.push(callback);
      active++;
      return () => {
        active--;
      };
    },
  };
  const oldDispose = f.events.subscribe(source);
  const dispose = f.events.subscribe(source);
  oldDispose();
  expect(active).toBe(1);
  callbacks[0]?.(input, actor);
  callbacks[1]?.(input, actor);
  expect((await f.events.read({ target })).items).toHaveLength(1);
  dispose();
  dispose();
  f.events.dispose();
  f.events.dispose();
  expect(active).toBe(0);
  callbacks[1]?.(input, actor);
  expect(f.db.query("SELECT * FROM event_journal").all()).toHaveLength(1);
  expect(() => f.events.subscribe(source)).toThrow("unavailable");
});

test("malformed cursor/limit returns sanitized typed domain errors", async () => {
  const f = fixture();
  await expect(
    f.events.read({ target, cursor: "SYNTHETIC-PRIVATE" }),
  ).rejects.toMatchObject({
    code: "invalid_input",
    message: "invalid_input",
    retryable: false,
  });
  await expect(f.events.read({ target, limit: 101 })).rejects.toThrow(
    "invalid_input",
  );
});
