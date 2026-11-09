import { expect, test } from "bun:test";
import { InvocationIdentity } from "../../src/composition/identity";
import type { SessionRef } from "../../src/contracts";

const ref = (sessionID: string): SessionRef => ({
  version: 1,
  instanceID: "fixture",
  projectID: "project",
  sessionID,
});
test("synthetic identity fixture: concurrent host calls preserve stable object provenance", async () => {
  const identity = new InvocationIdentity(
    "fixture",
    { resolve: async (c) => ref(c.sessionID) },
    { current: async () => null },
  );
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = identity.runWithHostContext({ sessionID: "one" }, async (p) => {
    await barrier;
    expect(await identity.current()).toBe(p);
    expect(p.kind === "session" && p.session.sessionID).toBe("one");
  });
  await identity.runWithHostContext({ sessionID: "two" }, async (p) => {
    expect(await identity.current()).toBe(p);
    await Promise.resolve();
    expect(await identity.current()).toBe(p);
    release();
  });
  await first;
  expect(await identity.current()).toBeNull();
});
test("synthetic identity fixture: unknown/native Basic identity cannot become operator", async () => {
  const identity = new InvocationIdentity(
    "fixture",
    { resolve: async () => null },
    { current: async () => null },
  );
  await expect(
    identity.runWithHostContext({ sessionID: "untrusted" }, async () => {}),
  ).rejects.toThrow("forbidden");
  await expect(
    identity.runWithAuthenticatedOperator(async () => {}),
  ).rejects.toThrow("forbidden");
  const foreign = new InvocationIdentity(
    "fixture",
    { resolve: async () => ({ ...ref("one"), instanceID: "other" }) },
    { current: async () => null },
  );
  await expect(
    foreign.runWithHostContext({ sessionID: "one" }, async () => {}),
  ).rejects.toThrow("forbidden");
});
test("synthetic identity fixture: trusted gateway identity is stable and cleared after exception", async () => {
  const identity = new InvocationIdentity(
    "fixture",
    { resolve: async (c) => ref(c.sessionID) },
    {
      current: async () => ({
        kind: "operator",
        instanceID: "fixture",
        operatorID: "fixture-operator",
        revision: 1,
      }),
    },
  );
  await expect(
    identity.runWithAuthenticatedOperator(async (p) => {
      expect(await identity.current()).toBe(p);
      throw new Error("fixture failure");
    }),
  ).rejects.toThrow("fixture failure");
  expect(await identity.current()).toBeNull();
});
