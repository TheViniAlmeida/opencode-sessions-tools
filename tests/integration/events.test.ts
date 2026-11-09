import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthorizationSnapshot,
  Authorizer,
} from "../../src/authorization/authorize";
import type { Principal, SessionRef } from "../../src/contracts";
import {
  EVENT_RETENTION_MS,
  type EventInput,
  Events,
  eventsMigrationAt,
} from "../../src/observability/events";
import {
  openPersistence,
  type Persistence,
} from "../../src/persistence/database";
import { operationMigrationAt } from "../../src/persistence/operations";

const roots: string[] = [];
const stores: Persistence[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const target: SessionRef = {
  version: 1,
  instanceID: "i",
  projectID: "p",
  sessionID: "target",
};
const actor: Principal = {
  kind: "session",
  session: { ...target, sessionID: "source" },
};
const input: EventInput = {
  kind: "message.admitted",
  target,
  operationID: "synthetic-op",
  payload: { channel: "inbox" },
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "events-"));
  roots.push(root);
  const repositoryPath = join(root, "repo");
  mkdirSync(repositoryPath);
  const path = join(root, "synthetic.sqlite");
  writeFileSync(path, "", { mode: 0o600 });
  const stat = statSync(path);
  const options = {
    repositoryPath,
    claims: [
      {
        instanceID: "i",
        scopeID: "scope",
        installationID: "test",
        canonicalPath: realpathSync(path),
        databaseIdentity: `${stat.dev}:${stat.ino}`,
      },
    ],
    migrations: [operationMigrationAt(2), eventsMigrationAt(3)],
  };
  let now = 1000;
  const snapshot: AuthorizationSnapshot = {
    revision: 1,
    profile: "observe",
    profileCapabilities: ["read"],
    policyCapabilities: ["read"],
    hostCapabilities: ["read"],
    deniedCapabilities: [],
    operator: null,
    delegationCapabilities: null,
    approval: null,
    grants: [
      {
        version: 1,
        grantID: "g",
        source: { ...target, sessionID: "source" },
        target,
        capabilities: ["read"],
        revision: 1,
        issuer: {
          kind: "operator",
          instanceID: "i",
          operatorID: "op",
          revision: 1,
        },
        createdAt: new Date(0).toISOString(),
        expiresAt: null,
      },
    ],
  };
  let current: Principal | null = actor;
  const identity = { current: async () => current };
  const authorizer = new Authorizer(
    identity,
    { read: async () => snapshot },
    () => now,
  );
  const open = () => {
    const db = openPersistence(options);
    stores.push(db);
    return { db, events: new Events(db, identity, authorizer, () => now) };
  };
  return {
    options,
    open,
    snapshot,
    setIdentity: (principal: Principal | null) => {
      current = principal;
    },
    setTime: (at: number) => {
      now = at;
    },
  };
}

test("file cursor reconnect/restart replays durable plugin journal with real T11 revocation", async () => {
  const f = fixture();
  const first = f.open();
  first.events.append(input, actor);
  const page = await first.events.read({ target, limit: 1 });
  first.events.append(
    { ...input, kind: "operation.unknown", payload: {} },
    actor,
  );
  first.events.dispose();
  first.db.close();
  stores.splice(stores.indexOf(first.db), 1);
  const restarted = f.open();
  const replay = await restarted.events.read({ target, cursor: page.cursor });
  expect(replay.items.map((e) => [e.sequence, e.kind])).toEqual([
    [2, "operation.unknown"],
  ]);
  f.snapshot.grants = [];
  await expect(
    restarted.events.read({ target, cursor: page.cursor }),
  ).rejects.toThrow("forbidden");
});

test("two independent processes append unique ordered sequences in canonical owned file", async () => {
  const f = fixture();
  const parent = f.open();
  const modulePath = new URL(
    "../../src/observability/events.ts",
    import.meta.url,
  ).pathname;
  const persistencePath = new URL(
    "../../src/persistence/database.ts",
    import.meta.url,
  ).pathname;
  const operationsPath = new URL(
    "../../src/persistence/operations.ts",
    import.meta.url,
  ).pathname;
  const code = `import { Events,eventsMigrationAt } from ${JSON.stringify(modulePath)};
    import { openPersistence } from ${JSON.stringify(persistencePath)};
    import { operationMigrationAt } from ${JSON.stringify(operationsPath)};
    const options=${JSON.stringify({ repositoryPath: f.options.repositoryPath, claims: f.options.claims })};
    const db=openPersistence({...options,migrations:[operationMigrationAt(2),eventsMigrationAt(3)]});
    const events=new Events(db,{current:async()=>null},{authorize:async()=>{}},()=>1000);
    for(let i=0;i<30;i++) events.append(${JSON.stringify(input)},${JSON.stringify(actor)});
    db.close();`;
  const children = [0, 1].map(() =>
    Bun.spawn([process.execPath, "--eval", code], {
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  for (const child of children) {
    const output = await new Response(child.stderr).text();
    expect(output).toBe("");
    expect(await child.exited).toBe(0);
  }
  const page = await parent.events.read({ target });
  expect(page.items.map((e) => e.sequence)).toEqual(
    Array.from({ length: 60 }, (_, i) => i + 1),
  );
});

test("retention survives restart, expired issued cursor directs snapshot", async () => {
  const f = fixture();
  const first = f.open();
  const page = await first.events.read({ target });
  first.events.append(input, actor);
  f.setTime(1000 + EVENT_RETENTION_MS);
  first.events.prune();
  first.events.dispose();
  first.db.close();
  stores.splice(stores.indexOf(first.db), 1);
  const second = f.open();
  await expect(
    second.events.read({ target, cursor: page.cursor }),
  ).rejects.toMatchObject({ code: "expired", resynchronize: "snapshot" });
  expect(second.events.append(input, actor).sequence).toBe(2);
});

test("real authorizer rejects revoked operator credential and expired grant on replay", async () => {
  const f = fixture();
  const store = f.open();
  store.events.append(input, actor);
  const sessionCursor = (await store.events.read({ target })).cursor;
  f.snapshot.grants = f.snapshot.grants.map((grant) => ({
    ...grant,
    expiresAt: new Date(1001).toISOString(),
  }));
  f.setTime(1001);
  await expect(
    store.events.read({ target, cursor: sessionCursor }),
  ).rejects.toThrow("forbidden");
  const operator: Principal = {
    kind: "operator",
    instanceID: "i",
    operatorID: "operator",
    revision: 1,
  };
  f.snapshot.operator = {
    ...operator,
    capabilities: ["read"],
    projects: ["p"],
    expiresAt: null,
  };
  f.setIdentity(operator);
  const operatorCursor = (await store.events.read({ target })).cursor;
  f.snapshot.operator.revision = 2;
  await expect(
    store.events.read({ target, cursor: operatorCursor }),
  ).rejects.toThrow("forbidden");
});
