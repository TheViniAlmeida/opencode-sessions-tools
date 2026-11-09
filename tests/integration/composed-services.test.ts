import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { AuthorizationSnapshot } from "../../src/authorization/authorize";
import { createCompositionRuntime } from "../../src/composition/runtime";
import {
  assertComposedServices,
  createComposedServices,
} from "../../src/composition/services";
import { hashExportPayload } from "../../src/context/export";
import {
  canonical,
  capabilities,
  DomainError,
  type Principal,
  type SessionRef,
} from "../../src/contracts";
import { Events } from "../../src/observability/events";

function localFixture() {
  const root = mkdtempSync(
    "/tmp/opencode/opencode-sessions-tools/composed-services-",
  );
  const runtime = createCompositionRuntime({
    databasePath: `${root}/state.sqlite`,
    repositoryPath: process.cwd(),
    instanceID: "fixture",
    scopeID: "scope",
    installationID: "installation",
  });
  const source: SessionRef = {
    version: 1,
    instanceID: "fixture",
    projectID: "source-project",
    sessionID: "source",
  };
  const target: SessionRef = {
    ...source,
    projectID: "target-project",
    sessionID: "target",
  };
  const actor: Principal = { kind: "session", session: source };
  const operator = {
    kind: "operator" as const,
    instanceID: "fixture",
    operatorID: "test-only",
    revision: 1,
  };
  let hostCalls = 0;
  let failCleanup = false;
  const unavailable = () => {
    hostCalls++;
    throw new DomainError("unavailable");
  };
  const graph = createComposedServices({
    runtime,
    clock: () => 1000,
    sessions: { resolve: async () => source },
    operators: { current: async () => operator },
    discovery: {
      candidates: async () => {
        hostCalls++;
        return [target];
      },
      get: async () => {
        hostCalls++;
        return null;
      },
      links: async () => {
        hostCalls++;
        return [];
      },
    },
    activeWork: { snapshot: unavailable },
    memoryGroups: {
      check(sql, scope, principal) {
        if (!scope.groupID) throw new DomainError("forbidden");
        runtime.persistence.transaction((current) => {
          if (current !== sql) throw new DomainError("unavailable");
        });
        const group = sql
          .query<{ body: string }, [string]>(
            "SELECT body FROM groups_records WHERE group_id=?",
          )
          .get(scope.groupID);
        if (
          !group ||
          canonical(JSON.parse(group.body).scope) !==
            canonical(scope.session) ||
          principal.kind !== "session"
        )
          throw new DomainError("forbidden");
        const member = principal.session;
        if (
          !sql
            .query(
              "SELECT 1 FROM groups_members WHERE group_id=? AND session_ref=?",
            )
            .get(
              scope.groupID,
              JSON.stringify({
                version: 1,
                instanceID: member.instanceID,
                projectID: member.projectID,
                sessionID: member.sessionID,
              }),
            )
        )
          throw new DomainError("forbidden");
      },
    },
    importHost: {
      preflight: unavailable,
      importNewSession: async () => unavailable(),
    },
    importDestination: { check: unavailable },
    exportHost: { transcript: async () => unavailable() },
    remainingCleanup: {
      cleanup() {
        if (failCleanup) throw new DomainError("unavailable");
      },
    },
  });
  // TEST ONLY bootstrap: persisted authority, never a factory default or bypass.
  const seed = (
    principal: Principal,
    t = target,
    allowed: AuthorizationSnapshot["policyCapabilities"] = capabilities,
  ) =>
    runtime.persistence.transaction((sql) => {
      const snapshot: AuthorizationSnapshot = {
        revision: 1,
        profile: "manage",
        profileCapabilities: allowed,
        policyCapabilities: allowed,
        hostCapabilities: allowed,
        deniedCapabilities: [],
        grants: [],
        delegationCapabilities: allowed,
        approval: null,
        operator:
          principal.kind === "operator"
            ? {
                operatorID: operator.operatorID,
                instanceID: operator.instanceID,
                revision: 1,
                capabilities: allowed,
                projects: [source.projectID, target.projectID],
                expiresAt: null,
              }
            : null,
      };
      sql
        .query(
          "INSERT OR REPLACE INTO composition_policies VALUES (?,?,?,?,?,?)",
        )
        .run(
          t.instanceID,
          t.projectID,
          t.sessionID,
          canonical(principal),
          1,
          JSON.stringify(snapshot),
        );
    });
  const link = async () => {
    seed(operator);
    await graph.identity.runWithAuthenticatedOperator(() =>
      graph.grants.link({
        source,
        target,
        capabilities: [...capabilities],
        expiresAt: null,
        policyRevision: 1,
        grantRevision: 0,
      }),
    );
  };
  return {
    runtime,
    graph,
    source,
    target,
    actor,
    seed,
    link,
    calls: () => hostCalls,
    failCleanup: () => {
      failCleanup = true;
    },
    close() {
      runtime.dispose();
      rmSync(root, { recursive: true });
    },
  };
}

function attachmentRaw() {
  const payload = {
    version: 1,
    source: {
      version: 1,
      instanceID: "untrusted",
      projectID: "old",
      sessionID: "old",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    mode: "native-transcript",
    projection: {
      kind: "text-messages-v1",
      messages: [{ id: "old", role: "user", text: "private-local-content" }],
    },
    loss: {
      filesystem: true,
      processes: true,
      nativeState: true,
      nonTextParts: true,
      configuration: true,
      authority: true,
    },
  };
  return JSON.stringify({ payload, sha256: hashExportPayload(payload) });
}

test("factory graph freezes security members without freezing domain state", () => {
  const first = localFixture();
  const second = localFixture();
  try {
    expect(Object.isFrozen(first.graph)).toBe(true);
    for (const key of ["authorizer", "policy", "identity"] as const) {
      const original = first.graph[key];
      expect(Reflect.set(first.graph, key, second.graph[key])).toBe(false);
      expect(() =>
        Object.defineProperty(first.graph, key, { value: second.graph[key] }),
      ).toThrow(TypeError);
      expect(first.graph[key]).toBe(original);
      expect(Object.isFrozen(original)).toBe(false);
    }
    expect(() =>
      assertComposedServices(first.runtime, first.graph),
    ).not.toThrow();
  } finally {
    first.close();
    second.close();
  }
});

test("provenance rejects replacement of the runtime persistence object", () => {
  const first = localFixture();
  const second = localFixture();
  const original = first.runtime.persistence;
  try {
    expect(
      Reflect.set(first.runtime, "persistence", second.runtime.persistence),
    ).toBe(true);
    expect(() => assertComposedServices(first.runtime, first.graph)).toThrow(
      DomainError,
    );
  } finally {
    Reflect.set(first.runtime, "persistence", original);
    first.close();
    second.close();
  }
});

test("factory provenance accepts only the exact graph and runtime objects", () => {
  const first = localFixture();
  const second = localFixture();
  try {
    expect(() =>
      assertComposedServices(first.runtime, first.graph),
    ).not.toThrow();
    expect(() =>
      assertComposedServices(first.runtime, { ...first.graph }),
    ).toThrow(DomainError);
    expect(() =>
      assertComposedServices(first.runtime, Object.create(first.graph)),
    ).toThrow(DomainError);
    expect(() => assertComposedServices(second.runtime, first.graph)).toThrow(
      DomainError,
    );
    expect(() => assertComposedServices(first.runtime, second.graph)).toThrow(
      DomainError,
    );
    expect(() =>
      assertComposedServices({ ...first.runtime }, first.graph),
    ).toThrow(DomainError);
    expect(() =>
      assertComposedServices(first.runtime, { assertLocalGraph() {} }),
    ).toThrow(DomainError);
    first.runtime.dispose();
    expect(() => assertComposedServices(first.runtime, first.graph)).toThrow(
      DomainError,
    );
  } finally {
    first.close();
    second.close();
  }
});

test("factory provenance revalidates current runtime lineage rather than caching admission", () => {
  const f = localFixture();
  try {
    assertComposedServices(f.runtime, f.graph);
    f.runtime.persistence.transaction((sql) => {
      sql
        .query("UPDATE composition_lineage SET fingerprint=? WHERE singleton=1")
        .run("test-only-invalid-fingerprint");
    });
    expect(() => assertComposedServices(f.runtime, f.graph)).toThrow(
      DomainError,
    );
  } finally {
    f.close();
  }
});

test("valid event cannot use another canonical database and local event mutation rolls back atomically", async () => {
  const first = localFixture();
  const second = localFixture();
  const input = {
    kind: "message.admitted" as const,
    target: first.target,
    operationID: "valid-operation",
    payload: { channel: "inbox" as const },
  };
  try {
    // Both databases have the actual journal schema: parsing/schema errors cannot
    // substitute for the connection guard in this negative test.
    expect(() =>
      second.runtime.persistence.transaction((sql) =>
        first.graph.events.appendInTransaction(sql, input, first.actor),
      ),
    ).toThrow(DomainError);
    expect(
      second.runtime.persistence.transaction((sql) =>
        sql.query("SELECT * FROM event_journal").all(),
      ),
    ).toHaveLength(0);
    // Fresh-object mutant: deliberately remove only the composition wrapper.
    // The same valid foreign write now succeeds, proving the guard assertion
    // above would fail without that wrapper (no source reset or file mutation).
    second.runtime.persistence.transaction((sql) =>
      Events.prototype.appendInTransaction.call(
        first.graph.events,
        sql,
        input,
        first.actor,
      ),
    );
    expect(
      second.runtime.persistence.transaction((sql) =>
        sql.query("SELECT * FROM event_journal").all(),
      ),
    ).toHaveLength(1);
    expect(() =>
      first.runtime.persistence.transaction((sql) => {
        first.graph.events.appendInTransaction(sql, input, first.actor);
        sql
          .query("INSERT INTO groups_records VALUES (?,?)")
          .run("rollback-marker", "{}");
        throw new DomainError("conflict");
      }),
    ).toThrow(DomainError);
    expect(
      first.runtime.persistence.transaction((sql) =>
        sql.query("SELECT * FROM event_journal").all(),
      ),
    ).toHaveLength(0);
    expect(
      first.runtime.persistence.transaction((sql) =>
        sql.query("SELECT * FROM event_heads").all(),
      ),
    ).toHaveLength(0);
    expect(
      first.runtime.persistence.transaction((sql) =>
        sql.query("SELECT * FROM groups_records").all(),
      ),
    ).toHaveLength(0);
  } finally {
    first.close();
    second.close();
  }
});

test("canonical cross-project link admits local notification and attachment without native calls; memory CAS", async () => {
  const f = localFixture();
  try {
    expect(f.runtime.persistence.version).toBe(23);
    f.seed(f.actor);
    await f.graph.identity.runWithHostContext(
      { sessionID: "source" },
      async (actor) => {
        await expect(
          f.graph.authorizer.authorize(actor, f.target, "message"),
        ).rejects.toMatchObject({ code: "not_found" });
      },
    );
    await f.link();
    await f.graph.identity.runWithHostContext(
      { sessionID: "source" },
      async (actor) => {
        const notification = await f.graph.inbox.enqueueNotification({
          target: f.target,
          content: "private-local-content",
          correlationID: "correlation",
          expiresAt: 10000,
          idempotencyKey: "notification",
          expectedRevision: 1,
        });
        await f.graph.inbox.deliverNotification(notification.operationID, 1);
        const imported = await f.graph.contextImport.import({
          raw: attachmentRaw(),
          selection: { mode: "append", target: f.target },
          idempotencyKey: "attachment",
          expectedRevision: 1,
        });
        const attachments = await f.graph.contextImport.listAttachments(
          f.target,
        );
        expect(attachments).toHaveLength(1);
        const attachment = attachments[0];
        if (!attachment) throw new Error("Expected local attachment");
        expect(
          JSON.stringify(
            await f.graph.contextImport.getAttachment(
              f.target,
              attachment.attachmentID,
            ),
          ),
        ).toContain("private-local-content");
        expect(imported).toBeDefined();
        expect(f.calls()).toBe(0);
        f.seed(
          f.actor,
          f.target,
          capabilities.filter((c) => c !== "read"),
        );
        await expect(
          f.graph.contextImport.getAttachment(
            f.target,
            attachment.attachmentID,
          ),
        ).rejects.toMatchObject({ code: "not_found" });
        f.seed(
          f.actor,
          f.target,
          capabilities.filter((c) => c !== "context.read"),
        );
        await expect(
          f.graph.contextImport.listAttachments(f.target),
        ).rejects.toMatchObject({ code: "not_found" });
        f.seed(f.actor);
        const scope = { session: f.target };
        const value = {
          key: "key",
          value: "private-memory",
          expectedRevision: 0,
          expiresAt: null,
        };
        expect(
          (await f.graph.sharedMemory.write(scope, value, 1)).revision,
        ).toBe(1);
        await expect(
          f.graph.sharedMemory.write(scope, value, 1),
        ).rejects.toMatchObject({ code: "conflict" });
        expect((await f.graph.sharedMemory.read(scope, "key"))?.value).toBe(
          "private-memory",
        );
        const group = await f.graph.groups.create(
          f.target,
          { name: "local-group", kind: "group" },
          1,
        );
        const groupScope = { session: f.target, groupID: group.groupID };
        await expect(
          f.graph.sharedMemory.write(groupScope, value, 1),
        ).rejects.toMatchObject({ code: "forbidden" });
        f.seed(f.actor, f.source);
        await f.graph.groups.addMember(group.groupID, f.source, 1);
        expect(
          (await f.graph.sharedMemory.write(groupScope, value, 1)).revision,
        ).toBe(1);
        // Membership is only a restriction, never a capability grant.
        f.seed(
          f.actor,
          f.target,
          capabilities.filter((c) => c !== "context.write"),
        );
        await expect(
          f.graph.sharedMemory.write(
            groupScope,
            { ...value, expectedRevision: 1 },
            1,
          ),
        ).rejects.toMatchObject({ code: "not_found" });
        f.seed(f.actor);
        await f.graph.groups.removeMember(group.groupID, f.source, 1);
        await expect(
          f.graph.sharedMemory.read(groupScope, "key"),
        ).rejects.toMatchObject({ code: "forbidden" });
        f.runtime.persistence.transaction((sql) => {
          f.graph.events.appendInTransaction(
            sql,
            {
              kind: "message.admitted",
              target: f.target,
              operationID: notification.operationID,
              payload: { channel: "inbox" },
            },
            actor,
          );
          expect(sql.query("SELECT * FROM event_journal").all()).toHaveLength(
            1,
          );
          expect(
            JSON.stringify(sql.query("SELECT * FROM event_journal").all()),
          ).not.toContain("private-local-content");
        });
      },
    );
  } finally {
    f.close();
  }
});

test("native GET absence reconciles real local content and blocks subsequent enqueue", async () => {
  const f = localFixture();
  try {
    f.seed(f.actor);
    await f.link();
    await f.graph.identity.runWithHostContext(
      { sessionID: "source" },
      async () => {
        const notification = await f.graph.inbox.enqueueNotification({
          target: f.target,
          content: "private-local-content",
          correlationID: "cleanup",
          expiresAt: 10000,
          idempotencyKey: "before",
          expectedRevision: 1,
        });
        await f.graph.inbox.deliverNotification(notification.operationID, 1);
        await f.graph.contextImport.import({
          raw: attachmentRaw(),
          selection: { mode: "append", target: f.target },
          idempotencyKey: "attachment",
          expectedRevision: 1,
        });
        await expect(f.graph.discovery.get(f.target)).rejects.toMatchObject({
          code: "not_found",
        });
        expect(f.calls()).toBe(2); // Discovery observation plus reconciliation confirmation GET.
        f.runtime.persistence.transaction((sql) => {
          expect(
            sql.query("SELECT * FROM session_tombstones").all(),
          ).toHaveLength(1);
          expect(
            sql
              .query(
                "SELECT * FROM notification_inbox WHERE content IS NOT NULL",
              )
              .all(),
          ).toHaveLength(0);
          expect(
            sql
              .query(
                "SELECT * FROM context_import_attachments WHERE content_json IS NOT NULL",
              )
              .all(),
          ).toHaveLength(0);
          expect(
            sql
              .query("SELECT * FROM operations WHERE payload_json!='null'")
              .all(),
          ).toHaveLength(0);
          expect(
            JSON.stringify(sql.query("SELECT * FROM operation_audit").all()),
          ).not.toContain("private-local-content");
        });
        await expect(
          f.graph.inbox.enqueueNotification({
            target: f.target,
            content: "blocked",
            correlationID: "cleanup",
            expiresAt: 10000,
            idempotencyKey: "after",
            expectedRevision: 1,
          }),
        ).rejects.toMatchObject({ code: "not_found" });
      },
    );
  } finally {
    f.close();
  }
});

test("failing remaining cleanup rolls back tombstone and already composed content cleanup", async () => {
  const f = localFixture();
  try {
    f.seed(f.actor);
    await f.link();
    await f.graph.identity.runWithHostContext(
      { sessionID: "source" },
      async () => {
        await f.graph.contextImport.import({
          raw: attachmentRaw(),
          selection: { mode: "append", target: f.target },
          idempotencyKey: "rollback-attachment",
          expectedRevision: 1,
        });
        f.failCleanup();
        await expect(f.graph.discovery.get(f.target)).rejects.toMatchObject({
          code: "unavailable",
        });
        f.runtime.persistence.transaction((sql) => {
          expect(
            sql.query("SELECT * FROM session_tombstones").all(),
          ).toHaveLength(0);
          expect(
            sql.query("SELECT * FROM session_removal_audit").all(),
          ).toHaveLength(0);
          expect(
            sql
              .query(
                "SELECT * FROM context_import_attachments WHERE content_json IS NOT NULL",
              )
              .all(),
          ).toHaveLength(1);
        });
      },
    );
  } finally {
    f.close();
  }
});

test("canonical partial graph binds invocation, minimal policy and removal to one DB", async () => {
  const root = mkdtempSync(
    "/tmp/opencode/opencode-sessions-tools/composed-services-",
  );
  const runtime = createCompositionRuntime({
    databasePath: `${root}/state.sqlite`,
    repositoryPath: process.cwd(),
    instanceID: "fixture",
    scopeID: "scope",
    installationID: "installation",
  });
  const ref: SessionRef = {
    version: 1,
    instanceID: "fixture",
    projectID: "p",
    sessionID: "s",
  };
  let cleanupCalls = 0;
  const unavailable = () => {
    throw new DomainError("unavailable");
  };
  try {
    // Explicit fixture ports. Unassembled task/job, membership and destination
    // authority fail closed rather than pretend to be production adapters.
    const graph = createComposedServices({
      runtime,
      clock: () => 1000,
      sessions: { resolve: async () => ref },
      operators: { current: async () => null },
      discovery: {
        candidates: async () => [ref],
        get: async () => null,
        links: async () => [],
      },
      activeWork: { snapshot: unavailable },
      memoryGroups: { check: unavailable },
      importHost: {},
      importDestination: { check: unavailable },
      exportHost: {
        transcript: async () => {
          throw new DomainError("unavailable");
        },
      },
      remainingCleanup: {
        cleanup(sql) {
          runtime.persistence.transaction((current) =>
            expect(current).toBe(sql),
          );
          cleanupCalls++;
        },
      },
    });
    await expect(graph.discovery.current()).rejects.toMatchObject({
      code: "forbidden",
    });
    await graph.identity.runWithHostContext(
      { sessionID: "s" },
      async (actor) => {
        expect(await graph.discovery.current()).toEqual(ref);
        const policy = await graph.policy.read(actor, ref);
        expect(policy.grants).toEqual([]);
        expect(policy.policyCapabilities).toEqual(["discover", "message"]);
        await expect(
          graph.authorizer.authorize(actor, ref, "read"),
        ).rejects.toMatchObject({ code: "forbidden" });
        await graph.reconciliation.missing(ref);
        expect(cleanupCalls).toBe(1);
        runtime.persistence.transaction((sql) => {
          expect(
            sql.query("SELECT * FROM session_tombstones").all(),
          ).toHaveLength(1);
          expect(
            sql.query("SELECT * FROM composition_policies").all(),
          ).toHaveLength(0);
        });
      },
    );
    const foreign = new Database(":memory:");
    try {
      foreign.transaction(() => {
        expect(() =>
          graph.events.appendInTransaction(foreign, {} as never, {
            kind: "session",
            session: ref,
          }),
        ).toThrow();
      })();
    } finally {
      foreign.close();
    }
  } finally {
    runtime.dispose();
    rmSync(root, { recursive: true });
  }
});
