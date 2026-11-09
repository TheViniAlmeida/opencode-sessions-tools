import { expect, test } from "bun:test";
import { OpenCode, type SessionInfo } from "@opencode/client";
import { createHarness } from "../../scripts/harness";
import { createNativeContext } from "../../src/adapters/opencode/context";
import type { ImportPlan } from "../../src/context/import";
import { DomainError } from "../../src/contracts";

const source = {
  version: 1 as const,
  instanceID: "fixture",
  projectID: "global",
  sessionID: "ses_synthetic",
};
const info: SessionInfo = {
  id: source.sessionID,
  projectID: "global",
  location: { directory: "/synthetic" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
};
const branchPlan: ImportPlan = {
  operationID: "synthetic-branches",
  target: source,
  selection: {
    mode: "create",
    authorityTarget: source,
    destination: { instanceID: source.instanceID, projectID: source.projectID },
  },
  messages: [
    {
      id: "msg_branch1",
      sourceID: "msg_origin1",
      role: "user",
      text: "synthetic question",
    },
    {
      id: "msg_branch2",
      sourceID: "msg_origin2",
      role: "assistant",
      text: "synthetic answer",
    },
  ],
};

test("throwing catalog normalizes sensitive errors before native I/O", async () => {
  const sentinel = "SYNTHETIC_SENSITIVE_CATALOG_SENTINEL";
  let writes = 0;
  const adapter = createNativeContext({
    native: {
      import: async () => {
        writes++;
        return info;
      },
      export: async () => ({ info, messages: [] }),
    },
    catalog: {
      resolve: () => {
        throw new Error(sentinel);
      },
    },
  });
  const assertSafe = (error: unknown) => {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("unavailable");
    expect(String(error)).not.toContain(sentinel);
    expect((error as Error).stack).not.toContain(sentinel);
  };
  try {
    adapter.import.preflight(branchPlan);
    throw new Error("Expected failure");
  } catch (error) {
    assertSafe(error);
  }
  await adapter.import.importNewSession(branchPlan).then(() => {
    throw new Error("Expected failure");
  }, assertSafe);
  await adapter.export.transcript(source).then(() => {
    throw new Error("Expected failure");
  }, assertSafe);
  expect(writes).toBe(0);
});

test("malformed native-shaped location preserves known session and uncertainty", async () => {
  let reads = 0;
  const { location: _location, ...withoutLocation } = info;
  const adapter = createNativeContext({
    // Deliberate wire-corruption fixture, not a real-host/schema-valid response.
    native: {
      import: async (): Promise<SessionInfo> =>
        JSON.parse(JSON.stringify(withoutLocation)),
      export: async () => {
        reads++;
        return { info, messages: [] };
      },
    },
    catalog: {
      resolve: (scope) => ({ ...scope, location: { directory: "/synthetic" } }),
    },
  });
  expect(await adapter.import.importNewSession(branchPlan)).toEqual({
    state: "observed",
    value: {
      observedSession: source,
      confirmedMessages: [],
      uncertainIDs: [source.sessionID, ...branchPlan.messages.map((m) => m.id)],
    },
  });
  expect(reads).toBe(0);
});

test("native-shaped partial and duplicate export receipts confirm only unique exact matches", async () => {
  for (const duplicate of [false, true]) {
    const first = {
      id: "msg_branch1",
      type: "user" as const,
      text: "synthetic question",
      time: { created: 0 },
    };
    const adapter = createNativeContext({
      native: {
        import: async () => info,
        export: async () => ({
          info,
          messages: duplicate ? [first, first] : [first],
        }),
      },
      catalog: {
        resolve: (scope) => ({
          ...scope,
          location: { directory: "/synthetic" },
        }),
      },
    });
    expect(await adapter.import.importNewSession(branchPlan)).toEqual({
      state: "observed",
      value: {
        observedSession: source,
        confirmedMessages: duplicate
          ? []
          : [{ session: source, messageID: "msg_branch1" }],
        uncertainIDs: duplicate
          ? ["msg_branch1", "msg_branch2"]
          : ["msg_branch2"],
      },
    });
  }
});

test("native-shaped assistant text parts concatenate for export and batch verification", async () => {
  const adapter = createNativeContext({
    native: {
      import: async () => info,
      export: async () => ({
        info,
        messages: [
          {
            id: "msg_branch2",
            type: "assistant",
            agent: "imported",
            model: { id: "imported", providerID: "imported" },
            time: { created: 0, completed: 0 },
            content: [
              { type: "text", text: "synthetic " },
              { type: "reasoning", text: "not exported" },
              { type: "text", text: "answer" },
            ],
          },
        ],
      }),
    },
    catalog: {
      resolve: (scope) => ({ ...scope, location: { directory: "/synthetic" } }),
    },
  });
  expect(await adapter.export.transcript(source)).toEqual({
    compatible: true,
    messages: [
      { id: "msg_branch2", role: "assistant", text: "synthetic answer" },
    ],
  });
  expect(await adapter.import.importNewSession(branchPlan)).toEqual({
    state: "observed",
    value: {
      observedSession: source,
      confirmedMessages: [{ session: source, messageID: "msg_branch2" }],
      uncertainIDs: ["msg_branch1"],
    },
  });
});
function fixture() {
  let calls = 0;
  const adapter = createNativeContext({
    native: {
      import: async () => {
        calls++;
        return info;
      },
      export: async () => {
        calls++;
        return {
          info,
          messages: [
            {
              id: "msg_user",
              type: "user",
              text: "synthetic user",
              time: { created: 1 },
            },
            {
              id: "msg_skip",
              type: "synthetic",
              text: "not user authority",
              time: { created: 1 },
            },
          ],
        };
      },
    },
    catalog: {
      resolve: (scope) =>
        scope.instanceID === "fixture" && scope.projectID === "global"
          ? { ...scope, location: { directory: "/synthetic" } }
          : null,
    },
  });
  return { adapter, calls: () => calls };
}
test("native text projection allowlists fields and does not promote synthetic roles", async () => {
  const f = fixture();
  expect(await f.adapter.export.transcript(source)).toEqual({
    compatible: true,
    messages: [{ id: "msg_user", role: "user", text: "synthetic user" }],
  });
});
test("unsupported import is rejected synchronously before host I/O", async () => {
  const f = fixture();
  const plan = {
    operationID: "fixture",
    selection: { mode: "append" as const, target: source },
    target: source,
    messages: [],
  };
  expect(() => f.adapter.checkImport(plan)).toThrow("unsupported");
  await expect(f.adapter.import.importNewSession(plan)).rejects.toThrow(
    "unsupported",
  );
  expect(f.calls()).toBe(0);
});

test("isolated native batch preserves planned user and assistant IDs without authority inheritance", async () => {
  const host = await createHarness();
  try {
    let imports = 0;
    const importStatuses: number[] = [];
    const client = OpenCode.make({
      baseUrl: "http://fixture.invalid",
      fetch: Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          if (
            url.origin !== "http://fixture.invalid" ||
            (!url.pathname.startsWith("/api/experimental/session/") &&
              url.pathname !== "/api/session")
          )
            throw new Error("Unexpected fixture route");
          if (request.method === "POST" && url.pathname.endsWith("/import")) {
            imports++;
            const body = await request.clone().json();
            expect(body.info.permissions).toBeUndefined();
            expect(body.info.parentID).toBeUndefined();
            expect(body.info.metadata).toBeUndefined();
          }
          const response = await host.request(`${url.pathname}${url.search}`, {
            method: request.method,
            headers: request.headers,
            body: request.method === "GET" ? undefined : await request.text(),
          });
          if (url.pathname.endsWith("/import"))
            importStatuses.push(response.status);
          return response;
        },
        { preconnect() {} },
      ),
    });
    const seed = await client.session.create({
      location: { directory: host.root },
      title: "synthetic route seed",
    });
    const target = {
      ...source,
      projectID: seed.projectID,
      sessionID: `ses_${crypto.randomUUID().replaceAll("-", "")}`,
    };
    const plan: ImportPlan = {
      operationID: "batch-synthetic",
      target,
      selection: {
        mode: "create",
        authorityTarget: source,
        destination: {
          instanceID: target.instanceID,
          projectID: target.projectID,
        },
      },
      messages: [
        {
          id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
          sourceID: "msg_origin1",
          role: "user",
          text: "synthetic question",
        },
        {
          id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
          sourceID: "msg_origin2",
          role: "assistant",
          text: "synthetic answer",
        },
      ],
    };
    const adapter = createNativeContext({
      native: client.experimental.session,
      catalog: {
        resolve: (scope) => ({ ...scope, location: { directory: host.root } }),
      },
    });
    adapter.checkImport(plan);
    const taintedPackagePlan = {
      ...plan,
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
      parentID: "ses_orphan",
      metadata: { synthetic: true },
    };
    const outcome = await adapter.import.importNewSession(taintedPackagePlan);
    if (outcome.state !== "observed")
      throw new Error("Expected batch observation");
    const receipt = outcome.value;
    expect(receipt.observedSession).toEqual(target);
    const nativeExport = await client.experimental.session.export({
      sessionID: target.sessionID,
    });
    expect(nativeExport.info.parentID).toBeUndefined();
    expect(nativeExport.info.permissions ?? []).toEqual([]);
    expect(nativeExport.info.metadata).toBeUndefined();
    expect(
      (
        await client.experimental.session.export({
          sessionID: target.sessionID,
        })
      ).messages,
    ).toEqual(
      plan.messages.map((m) =>
        expect.objectContaining({ id: m.id, type: m.role }),
      ),
    );
    expect(receipt.uncertainIDs).toEqual([]);
    expect(receipt.confirmedMessages.map((m) => m.messageID)).toEqual(
      plan.messages.map((m) => m.id),
    );
    expect(await adapter.export.transcript(target)).toEqual({
      compatible: true,
      messages: plan.messages.map(({ sourceID, ...message }) => message),
    });
    const collisionOutcome = await adapter.import.importNewSession(plan);
    if (collisionOutcome.state !== "observed")
      throw new Error("Expected conservative collision observation");
    const collision = collisionOutcome.value;
    expect(collision.confirmedMessages).toEqual([]);
    expect(collision.uncertainIDs).toEqual([
      target.sessionID,
      ...plan.messages.map((m) => m.id),
    ]);
    expect(imports).toBe(2);
    expect(importStatuses).toEqual([200, 409]);
  } finally {
    await host.stop();
  }
}, 30000);

test("lost batch response has one write and reports all candidate IDs uncertain", async () => {
  let writes = 0;
  const adapter = createNativeContext({
    native: {
      import: async () => {
        writes++;
        throw new Error("synthetic lost response");
      },
      export: async () => {
        throw new Error("must not guess effects");
      },
    },
    catalog: {
      resolve: (scope) => ({ ...scope, location: { directory: "/synthetic" } }),
    },
  });
  const plan: ImportPlan = {
    operationID: "synthetic-loss",
    target: source,
    selection: {
      mode: "create",
      authorityTarget: source,
      destination: {
        instanceID: source.instanceID,
        projectID: source.projectID,
      },
    },
    messages: [
      {
        id: "msg_loss",
        sourceID: "msg_origin",
        role: "user",
        text: "synthetic",
      },
    ],
  };
  expect(await adapter.import.importNewSession(plan)).toEqual({
    state: "observed",
    value: {
      observedSession: null,
      confirmedMessages: [],
      uncertainIDs: [source.sessionID, "msg_loss"],
    },
  });
  expect(writes).toBe(1);
});
test("untrusted routing fails before native export", async () => {
  const f = fixture();
  await expect(
    f.adapter.export.transcript({ ...source, instanceID: "other" }),
  ).rejects.toThrow("unavailable");
  expect(f.calls()).toBe(0);
});

test("observed routing rewrite records session but never confirms planned messages", async () => {
  let reads = 0;
  const adapter = createNativeContext({
    native: {
      import: async () => ({
        ...info,
        projectID: "rewritten",
        location: { directory: "/other-synthetic" },
      }),
      export: async () => {
        reads++;
        return { info, messages: [] };
      },
    },
    catalog: {
      resolve: (scope) => ({ ...scope, location: { directory: "/synthetic" } }),
    },
  });
  const plan: ImportPlan = {
    operationID: "synthetic-rewrite",
    target: source,
    selection: {
      mode: "create",
      authorityTarget: source,
      destination: {
        instanceID: source.instanceID,
        projectID: source.projectID,
      },
    },
    messages: [
      {
        id: "msg_rewrite",
        sourceID: "msg_origin",
        role: "user",
        text: "synthetic",
      },
    ],
  };
  const receipt = await adapter.import.importNewSession(plan);
  expect(receipt).toEqual({
    state: "observed",
    value: {
      observedSession: { ...source, projectID: "rewritten" },
      confirmedMessages: [],
      uncertainIDs: [source.sessionID, "msg_rewrite"],
    },
  });
  expect(reads).toBe(0);
});
