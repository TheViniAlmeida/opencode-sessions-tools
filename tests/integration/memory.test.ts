import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthorizationSnapshot } from "../../src/authorization/authorize";
import { MEMORY_MIGRATION, SharedMemory } from "../../src/context/memory";
import {
  capabilities,
  type Principal,
  type SessionRef,
} from "../../src/contracts";
import { Persistence } from "../../src/persistence/database";

test("two file writers CAS, immediate expiry, managed tombstone and restart", async () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "memory-test-")),
    "state.sqlite",
  );
  const db = new Database(path);
  MEMORY_MIGRATION.apply(db, "unused-test");
  let now = Date.parse("2026-11-08T00:00:00.000Z");
  const scope: SessionRef = {
    version: 1,
    instanceID: "i",
    projectID: "p",
    sessionID: "s",
  };
  const principal: Principal = {
    kind: "operator",
    operatorID: "synthetic",
    instanceID: "i",
    revision: 1,
  };
  let denied = false;
  let approval: AuthorizationSnapshot["approval"] = null;
  let supervised = false;
  const policy = {
    load: (): AuthorizationSnapshot => ({
      revision: 1,
      profile: supervised ? "supervised" : "manage",
      profileCapabilities: capabilities,
      policyCapabilities: capabilities,
      hostCapabilities: capabilities,
      deniedCapabilities: denied ? ["context.read", "context.write"] : [],
      grants: [],
      operator: {
        operatorID: "synthetic",
        instanceID: "i",
        revision: 1,
        capabilities,
        projects: ["p"],
        expiresAt: null,
      },
      delegationCapabilities: null,
      approval: structuredClone(approval),
    }),
    save: (_sql: Database, snapshot: AuthorizationSnapshot) => {
      approval = snapshot.approval;
    },
  };
  const identity = { current: async () => principal };
  const store = new Persistence(db, () => {});
  const otherStore = new Persistence(new Database(path), () => {});
  const first = new SharedMemory(store, identity, policy, () => now);
  const second = new SharedMemory(otherStore, identity, policy, () => now);
  const input = {
    key: "synthetic-key",
    value: "synthetic-content",
    expectedRevision: 0,
    expiresAt: new Date(now + 1).toISOString(),
  };
  const results = await Promise.allSettled([
    first.write({ session: scope }, input, 1),
    second.write({ session: scope }, input, 1),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  supervised = true;
  approval = {
    principal,
    target: scope,
    capability: "context.write",
    revision: 1,
    expiresAt: new Date(now + 100000).toISOString(),
    mode: "once",
  };
  await first.read({ session: scope }, input.key);
  expect(approval).not.toBeNull();
  await expect(first.write({ session: scope }, input, 1)).rejects.toMatchObject(
    { code: "conflict" },
  );
  expect(approval).not.toBeNull();
  const updated = await first.write(
    { session: scope },
    { ...input, expectedRevision: 1 },
    1,
  );
  expect(updated.owner).toEqual(principal);
  expect(updated.author).toEqual(principal);
  expect(approval).toBeNull();
  await expect(
    first.write({ session: scope }, { ...input, expectedRevision: 2 }, 1),
  ).rejects.toMatchObject({ code: "forbidden" });
  now += 1;
  expect(await first.read({ session: scope }, input.key)).toBeNull();
  let tick: (() => void) | undefined;
  let cancelled = 0;
  const scheduler = {
    every: (ms: number, callback: () => void) => {
      expect(ms).toBeLessThanOrEqual(60000);
      tick = callback;
      return () => {
        cancelled++;
      };
    },
  };
  first.start(scheduler);
  first.start(scheduler);
  now += 59999;
  tick?.();
  expect(
    db
      .query<{ body: string | null }, []>("SELECT body FROM context_memory")
      .get()?.body,
  ).toBeNull();
  first.dispose();
  expect(cancelled).toBe(1);
  denied = true;
  await expect(
    second.read({ session: scope }, input.key),
  ).rejects.toMatchObject({ code: "forbidden" });
  denied = false;
  store.close();
  otherStore.close();
  const restartedStore = new Persistence(new Database(path), () => {});
  const restarted = new SharedMemory(
    restartedStore,
    identity,
    policy,
    () => now,
  );
  expect(await restarted.read({ session: scope }, input.key)).toBeNull();
  supervised = false;
  await expect(
    restarted.write({ session: scope }, { ...input, expiresAt: null }, 1),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(
    (
      await restarted.write(
        { session: scope },
        { ...input, expectedRevision: 3, expiresAt: null },
        1,
      )
    ).revision,
  ).toBe(4);
  let membership = true;
  const grouped = new SharedMemory(
    restartedStore,
    identity,
    policy,
    () => now,
    {
      check: (sql) => {
        expect(sql).toBeInstanceOf(Database);
        if (!membership) throw new Error("membership revoked");
      },
    },
  );
  await grouped.write(
    { session: scope, groupID: "synthetic-group" },
    { ...input, expiresAt: null },
    1,
  );
  expect(
    (
      await grouped.read(
        { session: scope, groupID: "synthetic-group" },
        input.key,
      )
    )?.revision,
  ).toBe(1);
  membership = false;
  await expect(
    grouped.read({ session: scope, groupID: "synthetic-group" }, input.key),
  ).rejects.toMatchObject({ code: "unavailable" });
  membership = true;
  denied = true;
  await expect(
    grouped.read({ session: scope, groupID: "synthetic-group" }, input.key),
  ).rejects.toMatchObject({ code: "forbidden" });
  await expect(
    grouped.write(
      { session: scope, groupID: "synthetic-group" },
      { ...input, expectedRevision: 1, expiresAt: null },
      1,
    ),
  ).rejects.toMatchObject({ code: "forbidden" });
  grouped.dispose();
  restarted.dispose();
  restartedStore.close();
});
