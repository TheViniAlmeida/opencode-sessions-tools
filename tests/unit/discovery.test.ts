import { expect, test } from "bun:test";
import {
  type AuthorizationSnapshot,
  Authorizer,
} from "../../src/authorization/authorize";
import {
  capabilities,
  type Grant,
  type Principal,
  type SessionRef,
} from "../../src/contracts";
import {
  DiscoveryService,
  type SessionLink,
  type SessionMetadata,
} from "../../src/sessions/discovery";

const ref = (sessionID: string, projectID = "a"): SessionRef => ({
  version: 1,
  instanceID: "i",
  projectID,
  sessionID,
});
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Missing fixture value");
  return value;
}
function fixture(count = 2) {
  const principal: Principal = { kind: "session", session: ref("caller") };
  let actor: Principal | null = principal;
  let time = 1000;
  const identity = { current: async () => actor };
  const snapshot: AuthorizationSnapshot = {
    revision: 1,
    profile: "observe",
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
    { read: async () => snapshot },
    () => time,
  );
  const rows = new Map<string, SessionMetadata>();
  for (let i = 0; i < count; i++)
    rows.set(`s${String(i).padStart(3, "0")}`, {
      ref: ref(`s${String(i).padStart(3, "0")}`),
      title: `title ${i}`,
      state: "idle",
      parent: null,
      ...{
        messages: "private",
        path: "/private",
        metadata: { secret: "fixture" },
      },
    });
  const edges: SessionLink[] = [];
  const missing: SessionRef[] = [];
  let reads = 0;
  const service = new DiscoveryService(
    identity,
    auth,
    {
      candidates: async (scope) =>
        [...rows.values()]
          .filter((r) => r.ref.projectID === scope.projectID)
          .map((r) => r.ref),
      get: async (r) => {
        reads++;
        return rows.get(r.sessionID) ?? null;
      },
      links: async (r) =>
        edges.filter((e) => e.source.sessionID === r.sessionID),
    },
    {
      missing: async (r) => {
        missing.push(r);
      },
    },
    () => time,
  );
  return {
    service,
    rows,
    edges,
    missing,
    snapshot,
    principal,
    auth,
    identity,
    reads: () => reads,
    identify: (p: Principal | null) => {
      actor = p;
    },
    advance: () => {
      time += 300_001;
    },
  };
}
const query = { instanceID: "i", projectID: "a" };
function grant(target: SessionRef): Grant {
  return {
    version: 1,
    grantID: "g",
    source: ref("caller"),
    target,
    capabilities: ["discover"],
    revision: 1,
    issuer: {
      kind: "operator",
      operatorID: "test",
      instanceID: "i",
      revision: 1,
    },
    createdAt: new Date(0).toISOString(),
    expiresAt: null,
  };
}

test("current ignores claims, metadata allowlist does not imply read", async () => {
  const f = fixture();
  expect(
    await f.service.current({ principal: "operator", sessionID: "forged" }),
  ).toEqual(ref("caller"));
  const result = await f.service.get(ref("s000"));
  expect(Object.keys(result).sort()).toEqual([
    "parent",
    "ref",
    "state",
    "title",
  ]);
  await expect(
    f.auth.authorize(f.principal, ref("s000"), "read"),
  ).rejects.toMatchObject({ code: "forbidden" });
  await expect(
    f.auth.authorize({ ...f.principal }, ref("s000"), "discover"),
  ).rejects.toMatchObject({ code: "forbidden" });
  f.identify(null);
  await expect(f.service.current()).rejects.toMatchObject({
    code: "forbidden",
  });
});

test("100 maximum, deterministic observed candidate snapshot, opaque scoped expiring cursor", async () => {
  const f = fixture(103);
  const first = await f.service.list(query);
  expect(first.items).toHaveLength(100);
  expect(first.nextCursor).toMatch(/^[0-9a-f-]{36}$/);
  f.rows.set("new", {
    ref: ref("new"),
    title: "new",
    state: "idle",
    parent: null,
  });
  const cursor = required(first.nextCursor);
  const second = await f.service.list({ ...query, cursor });
  expect(second.items.map((r) => r.ref.sessionID)).toEqual([
    "s100",
    "s101",
    "s102",
  ]);
  expect(second.nextCursor).toBeNull();
  for (const bad of [
    { ...query, limit: 101 },
    { ...query, cursor: "forged" },
    { ...query, cursor, projectID: "b" },
    { ...query, cursor, instanceID: "other" },
    { ...query, cursor, limit: 1 },
  ])
    await expect(f.service.list(bad)).rejects.toMatchObject({
      code: "invalid_input",
    });
  f.identify({ ...f.principal });
  await expect(f.service.list({ ...query, cursor })).rejects.toMatchObject({
    code: "invalid_input",
  });
  f.identify(f.principal);
  f.advance();
  await expect(f.service.list({ ...query, cursor })).rejects.toMatchObject({
    code: "invalid_input",
  });
});

test("explicit cross-project grant, no existence/count leak, fresh revocation on cursor and get", async () => {
  const f = fixture(3);
  for (const [id, row] of f.rows) f.rows.set(id, { ...row, ref: ref(id, "b") });
  const other = { ...query, projectID: "b", limit: 1 };
  await expect(f.service.list(other)).rejects.toMatchObject({
    code: "not_found",
  });
  expect(f.reads()).toBe(0);
  f.snapshot.grants = [grant(ref("s000", "b"))];
  const one = await f.service.list(other);
  expect(one.items).toHaveLength(1);
  expect(one.nextCursor).toBeNull();
  f.snapshot.grants = [grant(ref("s000", "b")), grant(ref("s001", "b"))];
  const first = await f.service.list(other);
  expect(first.nextCursor).not.toBeNull();
  f.snapshot.grants = [];
  await expect(
    f.service.list({ ...other, cursor: required(first.nextCursor) }),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(f.service.get(ref("s000", "b"))).rejects.toMatchObject({
    code: "not_found",
  });
});

test("cycles deduplicate IDs, links separate from authorized parent affiliation", async () => {
  const f = fixture(3);
  f.rows.set("s001", { ...required(f.rows.get("s001")), parent: ref("s000") });
  f.rows.set("s002", {
    ...required(f.rows.get("s002")),
    parent: ref("hidden", "b"),
  });
  f.edges.push(
    { source: ref("s001"), target: ref("s002") },
    { source: ref("s002"), target: ref("s000") },
    { source: ref("s002"), target: ref("hidden", "b") },
  );
  const tree = await f.service.tree(ref("s000"), query);
  expect(tree.items).toHaveLength(3);
  expect(tree.links).toHaveLength(2);
  expect(tree.items.find((r) => r.ref.sessionID === "s002")?.parent).toBeNull();
  expect(tree.links).not.toContainEqual({
    source: ref("s000"),
    target: ref("s001"),
  });
});

test("missing native reference signals future T18 reconciler, no cached success", async () => {
  const f = fixture();
  await f.service.get(ref("s000"));
  f.rows.delete("s000");
  await expect(f.service.get(ref("s000"))).rejects.toMatchObject({
    code: "not_found",
  });
  expect(f.missing).toEqual([ref("s000")]);
});

test("tree pagination is bound to root/method and revalidates current denies", async () => {
  const f = fixture(3);
  f.edges.push(
    { source: ref("s000"), target: ref("s001") },
    { source: ref("s001"), target: ref("s002") },
    { source: ref("s002"), target: ref("s000") },
  );
  const first = await f.service.tree(ref("s000"), { ...query, limit: 1 });
  const cursor = required(first.nextCursor);
  await expect(
    f.service.list({ ...query, limit: 1, cursor }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(
    f.service.tree(ref("s001"), { ...query, limit: 1, cursor }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  const second = await f.service.tree(ref("s000"), {
    ...query,
    limit: 1,
    cursor,
  });
  expect(second.items[0]?.ref).toEqual(ref("s001"));
  const third = await f.service.tree(ref("s000"), {
    ...query,
    limit: 1,
    cursor: required(second.nextCursor),
  });
  expect(third.items[0]?.ref).toEqual(ref("s002"));
  expect(third.nextCursor).toBeNull();
  f.snapshot.deniedCapabilities = ["discover"];
  await expect(
    f.service.tree(ref("s000"), { ...query, limit: 1, cursor }),
  ).rejects.toMatchObject({ code: "forbidden" });
});

test("host failures propagate fail-closed and forged ref/query fields are not principals", async () => {
  const f = fixture();
  await expect(
    f.service.get({ ...ref("s000"), ...{ principal: "operator" } }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(
    f.service.list({ ...query, ...{ principal: "operator" } }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  const service = new DiscoveryService(
    f.identity,
    f.auth,
    {
      candidates: async () => [ref("s000")],
      get: async () => {
        throw new Error("synthetic host failure");
      },
      links: async () => [],
    },
    {
      missing: async () => {
        throw new Error("should not reconcile a failure");
      },
    },
  );
  await expect(service.list(query)).rejects.toMatchObject({
    code: "unavailable",
    message: "unavailable",
  });
});
