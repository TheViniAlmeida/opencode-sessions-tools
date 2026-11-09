import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import {
  type AuthorizationSnapshot,
  Authorizer,
} from "../../src/authorization/authorize";
import { hashExportPayload } from "../../src/context/export";
import {
  ContextImportService,
  contextImportCleanup,
  IMPORT_ATTACHMENTS_MIGRATION,
  type ImportHostPort,
  type ImportInput,
  type ImportPlan,
  importMigration,
} from "../../src/context/import";
import {
  canonical,
  capabilities,
  DomainError,
  type SessionRef,
} from "../../src/contracts";
import { Persistence } from "../../src/persistence/database";
import {
  Operations,
  operationsMigration,
} from "../../src/persistence/operations";
import {
  ReconciliationService,
  reconciliationMigration,
  removedTargetPort,
} from "../../src/sessions/reconcile";

function envelope() {
  const payload = {
    version: 1,
    source: {
      version: 1,
      instanceID: "untrusted-origin",
      projectID: "foreign",
      sessionID: "old",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    mode: "native-transcript",
    projection: {
      kind: "text-messages-v1",
      messages: [{ id: "old-msg", role: "user", text: "synthetic text" }],
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
  return { payload, sha256: hashExportPayload(payload) };
}

test("historical base then additive attachments descriptor preserves existing ledger/plan rows", () => {
  const sql = new Database(":memory:");
  try {
    sql.exec(operationsMigration.sql);
    sql.exec(importMigration.sql);
    expect(
      sql
        .query(
          "SELECT name FROM sqlite_master WHERE name='context_import_attachments'",
        )
        .get(),
    ).toBeNull();
    sql
      .query("INSERT INTO operations VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        "migration-fixture",
        "scope",
        "{}",
        "key",
        "original-hash",
        "{}",
        "manage",
        "null",
        "pending",
        null,
        null,
      );
    sql
      .query("INSERT INTO context_import_plans VALUES (?,?,?)")
      .run("migration-fixture", "original-plan", "original-effects");
    sql.exec(IMPORT_ATTACHMENTS_MIGRATION.sql);
    expect(
      sql
        .query(
          "SELECT plan_json,effects_json FROM context_import_plans WHERE operation_id='migration-fixture'",
        )
        .get(),
    ).toEqual({ plan_json: "original-plan", effects_json: "original-effects" });
    expect(
      sql
        .query(
          "SELECT payload_hash,state FROM operations WHERE operation_id='migration-fixture'",
        )
        .get(),
    ).toEqual({ payload_hash: "original-hash", state: "pending" });
    expect(
      sql
        .query(
          "SELECT name FROM sqlite_master WHERE name='context_import_attachment_scope'",
        )
        .get(),
    ).toEqual({ name: "context_import_attachment_scope" });
  } finally {
    sql.close();
  }
});

// Real T11/T13 and SQLite; synthetic trusted adapters, NOT a native host/E2E.
test("APPEND 1.0 stores a plugin attachment without ANY host call", async () => {
  const f = fixture();
  const result = await f
    .service()
    .import({ ...f.input, selection: { mode: "append", target: f.target } });
  expect(f.calls()).toBe(0);
  expect(result).toHaveProperty("modality", "context_attachment");
  f.sql.close();
});
test("CREATE requires batch capability and cannot fall back to legacy host methods", async () => {
  const f = fixture();
  delete f.host.importNewSession;
  await expect(f.service().import(f.input)).rejects.toThrow("unsupported");
  expect(f.calls()).toBe(0);
  f.sql.close();
});
test("CREATE requires synchronous preflight even when a batch method exists", async () => {
  const f = fixture();
  delete f.host.preflight;
  await expect(f.service().import(f.input)).rejects.toThrow("unsupported");
  f.host.preflight = async () => {};
  await expect(f.service().import(f.input)).rejects.toThrow("unavailable");
  expect(f.calls()).toBe(0);
  expect(f.sql.query("SELECT count(*) AS n FROM operations").get()).toEqual({
    n: 0,
  });
  f.sql.close();
});
export function fixture(path = ":memory:", initialize = true) {
  const sql = new Database(path);
  if (initialize) {
    sql.exec(operationsMigration.sql);
    sql.exec(importMigration.sql);
    sql.exec(IMPORT_ATTACHMENTS_MIGRATION.sql);
    sql.exec(reconciliationMigration.sql);
  }
  const db = new Persistence(sql, () => {});
  const target: SessionRef = {
    version: 1,
    instanceID: "synthetic",
    projectID: "local",
    sessionID: "existing",
  };
  const principal = { kind: "session" as const, session: target };
  const identity = { current: async () => principal };
  let now = 1000;
  const snapshot: AuthorizationSnapshot = {
    revision: 1,
    profile: "manage",
    profileCapabilities: capabilities,
    policyCapabilities: capabilities,
    hostCapabilities: capabilities,
    deniedCapabilities: [],
    grants: [
      {
        version: 1,
        grantID: "fixture",
        revision: 1,
        source: target,
        target,
        issuer: {
          kind: "operator",
          instanceID: target.instanceID,
          operatorID: "fixture",
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
  const auth = new Authorizer(
    identity,
    {
      read: async () => structuredClone(snapshot),
      admission: (_p, _t, check) => db.transaction(() => check(snapshot)),
    },
    () => now,
  );
  let calls = 0;
  let mode = "success";
  let last: ImportPlan | undefined;
  let blocked = false;
  let destinationAllowed = true;
  let during: (() => void) | undefined;
  const host: ImportHostPort = {
    preflight: () => {},
    importNewSession: async (plan) => {
      expect(sql.inTransaction).toBe(false);
      calls++;
      last = plan;
      const persisted = sql
        .query<{ plan_json: string; effects_json: string }, []>(
          "SELECT * FROM context_import_plans",
        )
        .get();
      if (!persisted) throw new Error("fixture plan missing");
      expect(JSON.parse(persisted.plan_json)).toEqual(plan);
      expect(JSON.parse(persisted.effects_json).uncertain).toEqual([
        plan.target.sessionID,
        ...plan.messages.map((m) => m.id),
      ]);
      during?.();
      if (mode === "throw-create") throw new Error("lost receipt");
      if (mode === "collision") return { state: "no_effect", code: "conflict" };
      if (mode === "orphan") return { state: "no_effect", code: "not_found" };
      const messages =
        mode === "throw-append" || mode === "partial-conflict"
          ? []
          : mode === "throw-second"
            ? plan.messages.slice(0, 1)
            : plan.messages;
      return {
        state: "observed",
        value: {
          observedSession:
            mode === "rewrite"
              ? { ...plan.target, projectID: "unexpected" }
              : plan.target,
          confirmedMessages: messages.map((m) => ({
            session:
              mode === "rewrite-message"
                ? { ...plan.target, projectID: "unexpected" }
                : plan.target,
            messageID: m.id,
          })),
          uncertainIDs:
            mode === "throw-append"
              ? plan.messages.map((m) => m.id)
              : mode === "throw-second"
                ? plan.messages.slice(1).map((m) => m.id)
                : [],
        },
      };
    },
  };
  const removed = {
    assertAvailable(db: Database, ref: SessionRef) {
      removedTargetPort.assertAvailable(db, ref);
      if (blocked) throw new DomainError("not_found");
    },
  };
  const service = () =>
    new ContextImportService(
      db,
      identity,
      auth,
      host,
      {
        check(_sql, plan) {
          expect(_sql.inTransaction).toBe(true);
          expect(
            plan.selection.mode === "append" ||
              plan.target.projectID === "local",
          ).toBe(true);
          if (!destinationAllowed) throw new DomainError("forbidden");
        },
      },
      removed,
      () => now,
    );
  const input: ImportInput = {
    raw: JSON.stringify(envelope()),
    selection: {
      mode: "create",
      authorityTarget: target,
      destination: {
        instanceID: target.instanceID,
        projectID: target.projectID,
      },
    },
    idempotencyKey: "fixture-key",
    expectedRevision: 1,
  };
  return {
    sql,
    db,
    auth,
    identity,
    target,
    snapshot,
    input,
    service,
    host,
    removed,
    calls: () => calls,
    last: () => {
      if (!last) throw new Error("fixture plan missing");
      return last;
    },
    mode(v: string) {
      mode = v;
    },
    block() {
      blocked = true;
    },
    denyDestination() {
      destinationAllowed = false;
    },
    during(fn: () => void) {
      during = fn;
    },
    recover() {
      now += 31_000;
      return new Operations(db, auth, () => now, removed).recover();
    },
  };
}
test("new IDs and mapping persisted before I/O; same key returns original", async () => {
  const f = fixture();
  const result = await f.service().import(f.input);
  expect(result.operation.state).toBe("admitted");
  expect(result.error).toBeNull();
  expect(result.effects.messageIDs).toEqual([f.last().messages[0]?.id]);
  expect(f.last().messages[0]?.sourceID).toBe("old-msg");
  expect(f.last().messages[0]?.id).not.toBe("old-msg");
  expect(await f.service().import(f.input)).toEqual(result);
  expect(f.calls()).toBe(1);
  expect(f.sql.query("SELECT count(*) AS n FROM operations").get()).toEqual({
    n: 1,
  });
  f.sql.close();
});
test("explicit append checks context.write, not untrusted origin", async () => {
  const f = fixture();
  const input = {
    ...f.input,
    selection: { mode: "append" as const, target: f.target },
  };
  expect((await f.service().import(input)).operation.state).toBe("admitted");
  expect(f.calls()).toBe(0);
  f.sql.close();
});
test("invalid package and modality fail before mutation or intent", async () => {
  const f = fixture();
  for (const raw of [
    "{}",
    JSON.stringify({ ...envelope(), sha256: "f".repeat(64) }),
  ])
    await expect(f.service().import({ ...f.input, raw })).rejects.toThrow(
      "invalid_input",
    );
  await expect(
    f.service().import({
      ...f.input,
      selection: { mode: "auto" },
    } as unknown as ImportInput),
  ).rejects.toThrow("invalid_input");
  expect(f.calls()).toBe(0);
  expect(f.sql.query("SELECT count(*) AS n FROM operations").get()).toEqual({
    n: 0,
  });
  f.sql.close();
});
test("different package or selected modality with same key conflicts", async () => {
  const f = fixture();
  await f.service().import(f.input);
  await expect(
    f
      .service()
      .import({ ...f.input, selection: { mode: "append", target: f.target } }),
  ).rejects.toThrow("conflict");
  const e = envelope();
  e.payload.projection.messages = [
    { id: "old-msg", role: "user", text: "changed" },
  ];
  e.sha256 = hashExportPayload(e.payload);
  await expect(
    f.service().import({ ...f.input, raw: JSON.stringify(e) }),
  ).rejects.toThrow("conflict");
  expect(f.calls()).toBe(1);
  f.sql.close();
});
for (const [mode, error] of [
  ["collision", "conflict"],
  ["orphan", "not_found"],
] as const)
  test(`typed pre-effect ${mode} is rejected without invented IDs`, async () => {
    const f = fixture();
    f.mode(mode);
    const r = await f.service().import(f.input);
    expect(r.operation.state).toBe("rejected");
    expect(r.error).toBe(error);
    expect(r.effects.session).toBeNull();
    expect(r.effects.uncertain).toEqual([]);
    expect(await f.service().import(f.input)).toEqual(r);
    expect(f.calls()).toBe(1);
    f.sql.close();
  });
test("known-created destination plus ambiguous message keeps candidate, never retries", async () => {
  const f = fixture();
  f.mode("throw-append");
  const r = await f.service().import(f.input);
  expect(r.error).toBe("unknown_outcome");
  expect(r.operation.state).toBe("unknown_outcome");
  expect(r.effects.session).toEqual(f.last().target);
  expect(r.effects.messageIDs).toEqual([]);
  expect(r.effects.uncertain).toEqual([f.last().messages[0]?.id]);
  expect(await f.service().import(f.input)).toEqual(r);
  expect(f.calls()).toBe(1);
  f.sql.close();
});
test("omitted batch message IDs remain conservatively uncertain", async () => {
  const f = fixture();
  f.mode("partial-conflict");
  const r = await f.service().import(f.input);
  expect(r.error).toBe("unknown_outcome");
  expect(r.effects.failure).toBeNull();
  expect(r.effects.uncertain).toEqual(f.last().messages.map((m) => m.id));
  expect(r.effects.session).not.toBeNull();
  f.sql.close();
});
test("native routing rewrite observed but not trusted as requested destination", async () => {
  const f = fixture();
  f.mode("rewrite");
  const r = await f.service().import(f.input);
  expect(r.error).toBe("unknown_outcome");
  expect(r.effects.session?.projectID).toBe("unexpected");
  expect(f.calls()).toBe(1);
  f.sql.close();
});
test("restart preserves lost-response candidates and operation", async () => {
  const directory = mkdtempSync("/tmp/t27-");
  const path = `${directory}/journal.sqlite`;
  try {
    const f = fixture(path);
    f.mode("throw-create");
    const r = await f.service().import(f.input);
    f.sql.close();
    const g = fixture(path, false);
    expect(await g.service().import(g.input)).toEqual(r);
    expect(g.calls()).toBe(0);
    g.sql.close();
  } finally {
    rmSync(directory, { recursive: true });
  }
});
test("expired dispatch journal is recovered by T13, never resent", async () => {
  const f = fixture();
  f.mode("throw-create");
  const r = await f.service().import(f.input);
  // Synthetic crash image: T13 dispatch committed, final receipt not committed.
  f.sql
    .query("UPDATE operations SET state='dispatching' WHERE operation_id=?")
    .run(r.operation.operationID);
  expect(f.recover()).toBe(1);
  expect(await f.service().import(f.input)).toEqual(r);
  expect(f.calls()).toBe(1);
  f.sql.close();
});
test("authorization, delegation, destination preflight and mandatory removed guard fail closed", async () => {
  for (const reason of [
    "auth",
    "delegation",
    "destination",
    "removed",
  ] as const) {
    const f = fixture();
    if (reason === "auth") f.snapshot.deniedCapabilities = ["manage"];
    if (reason === "delegation") f.snapshot.delegationCapabilities = null;
    if (reason === "destination") f.denyDestination();
    if (reason === "removed") f.block();
    await expect(f.service().import(f.input)).rejects.toThrow(
      reason === "removed" ? "not_found" : "forbidden",
    );
    expect(f.calls()).toBe(0);
    f.sql.close();
  }
});
test("append cannot substitute manage for context.write", async () => {
  const f = fixture();
  f.snapshot.deniedCapabilities = ["context.write"];
  await expect(
    f
      .service()
      .import({ ...f.input, selection: { mode: "append", target: f.target } }),
  ).rejects.toThrow("forbidden");
  expect(f.calls()).toBe(0);
  f.sql.close();
});
test("database unavailable prevents host effects", async () => {
  const f = fixture();
  f.sql.close();
  await expect(f.service().import(f.input)).rejects.toThrow();
  expect(f.calls()).toBe(0);
});

test("partial import preserves confirmed message IDs separately from uncertain next ID", async () => {
  const f = fixture();
  const e = envelope();
  e.payload.projection.messages.push({
    id: "second-source",
    role: "assistant",
    text: "second text",
  });
  e.sha256 = hashExportPayload(e.payload);
  f.mode("throw-second");
  const input = { ...f.input, raw: JSON.stringify(e) };
  const r = await f.service().import(input);
  expect(r.error).toBe("unknown_outcome");
  expect(r.effects.messageIDs).toEqual([f.last().messages[0]?.id]);
  expect(r.effects.uncertain).toEqual([f.last().messages[1]?.id]);
  expect(await f.service().import(input)).toEqual(r);
  expect(f.calls()).toBe(1);
  f.sql.close();
});
test("unexpected message routing is preserved as observation, not attributed to created destination", async () => {
  const f = fixture();
  f.mode("rewrite-message");
  const r = await f.service().import(f.input);
  expect(r.error).toBe("unknown_outcome");
  expect(r.effects.session?.projectID).toBe("local");
  expect(r.effects.messageObservations[0]?.session.projectID).toBe(
    "unexpected",
  );
  f.sql.close();
});
test("journal failure before host I/O prevents mutation", async () => {
  const f = fixture();
  f.sql.exec(
    "CREATE TRIGGER fail_journal BEFORE UPDATE ON context_import_plans BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;",
  );
  const r = await f.service().import(f.input);
  expect(r.operation.state).toBe("unknown_outcome");
  expect(f.calls()).toBe(0);
  f.sql.close();
});
test("concurrent retry returns original dispatching operation without a second create", async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const host: ImportHostPort = {
    ...f.host,
    importNewSession: async (plan) => {
      started.resolve();
      await release.promise;
      if (!f.host.importNewSession) throw new Error("fixture batch missing");
      return f.host.importNewSession(plan);
    },
  };
  const service = new ContextImportService(
    f.db,
    f.identity,
    f.auth,
    host,
    { check() {} },
    f.removed,
    () => 1000,
  );
  const first = service.import(f.input);
  await started.promise;
  const replay = await f.service().import(f.input);
  expect(replay.operation.state).toBe("dispatching");
  expect(replay.error).toBe("unknown_outcome");
  expect(f.calls()).toBe(0);
  release.resolve();
  const completed = await first;
  expect(completed.operation.operationID).toBe(replay.operation.operationID);
  expect(f.calls()).toBe(1);
  f.sql.close();
});

test("attachment is durable local content, never native messages, same key has one effect", async () => {
  const f = fixture();
  delete f.host.preflight;
  delete f.host.importNewSession;
  const input: ImportInput = {
    ...f.input,
    selection: { mode: "append", target: f.target },
  };
  const r = await f.service().import(input);
  expect(r.modality).toBe("context_attachment");
  expect(r.operation.state).toBe("admitted");
  expect(r.operation.channel).toBe("context_attachment");
  expect(r.operation.receiptID).toBe(r.effects.attachmentID);
  expect(r.effects.messageIDs).toEqual([]);
  expect(r.effects.messageObservations).toEqual([]);
  expect(r.effects.session).toBeNull();
  expect(r.effects.uncertain).toEqual([]);
  expect(await f.service().import(input)).toEqual(r);
  expect(f.calls()).toBe(0);
  expect(
    f.sql.query("SELECT count(*) AS n FROM context_import_attachments").get(),
  ).toEqual({ n: 1 });
  const list = await f.service().listAttachments(f.target);
  expect(list.length).toBe(1);
  const first = list[0];
  if (!first) throw new Error("fixture expected attachment");
  const record = await f.service().getAttachment(f.target, first.attachmentID);
  expect(record.kind).toBe("context_attachment");
  expect(JSON.stringify(record.content)).toBe(
    JSON.stringify({
      version: 1,
      sha256: envelope().sha256,
      projection: envelope().payload.projection,
      loss: envelope().payload.loss,
    }),
  );
  expect(record).not.toHaveProperty("nativeMessages");
  expect(record.content).not.toHaveProperty("permissions");
  f.sql.close();
});
test("attachment reads require BOTH fresh read and context.read, never cached write authority", async () => {
  const f = fixture();
  const r = await f
    .service()
    .import({ ...f.input, selection: { mode: "append", target: f.target } });
  for (const denied of ["read", "context.read"] as const) {
    f.snapshot.deniedCapabilities = [denied];
    await expect(f.service().listAttachments(f.target)).rejects.toThrow(
      "forbidden",
    );
    await expect(
      f.service().getAttachment(f.target, r.operation.operationID),
    ).rejects.toThrow("forbidden");
  }
  f.sql.close();
});
test("attachment insertion failure rolls back same T11/T13 admission transaction", async () => {
  const f = fixture();
  f.sql.exec(
    "CREATE TRIGGER reject_attachment BEFORE INSERT ON context_import_attachments BEGIN SELECT RAISE(ABORT,'synthetic insert failure'); END;",
  );
  await expect(
    f
      .service()
      .import({ ...f.input, selection: { mode: "append", target: f.target } }),
  ).rejects.toThrow("unavailable");
  expect(
    f.sql.query("SELECT count(*) AS n FROM context_import_attachments").get(),
  ).toEqual({ n: 0 });
  expect(f.sql.query("SELECT state FROM operations").get()).toEqual({
    state: "pending",
  });
  expect(f.calls()).toBe(0);
  f.sql.close();
});
test("attachment restart replay retains exact operation/receipt and no host effect", async () => {
  const directory = mkdtempSync("/tmp/t27-attachment-");
  const path = `${directory}/journal.sqlite`;
  try {
    const f = fixture(path);
    const input: ImportInput = {
      ...f.input,
      selection: { mode: "append", target: f.target },
    };
    const r = await f.service().import(input);
    f.sql.close();
    const g = fixture(path, false);
    expect(await g.service().import(input)).toEqual(r);
    expect(
      g.sql.query("SELECT count(*) AS n FROM context_import_attachments").get(),
    ).toEqual({ n: 1 });
    expect(g.calls()).toBe(0);
    g.sql.close();
  } finally {
    rmSync(directory, { recursive: true });
  }
});
test("T18 redacts all plugin content copies but retains audit hashes and attachment receipt", async () => {
  const f = fixture();
  const input: ImportInput = {
    ...f.input,
    selection: { mode: "append", target: f.target },
  };
  const r = await f.service().import(input);
  const before = f.sql
    .query(
      "SELECT operation_id,payload_hash,state,receipt_id,channel FROM operations",
    )
    .get();
  const service = new ReconciliationService(
    f.db,
    f.identity,
    f.auth,
    { get: async () => null },
    contextImportCleanup(() => 4242),
    () => 2000,
  );
  await service.missing(f.target);
  expect(
    f.sql
      .query(
        "SELECT operation_id,payload_hash,state,receipt_id,channel FROM operations",
      )
      .get(),
  ).toEqual(before);
  expect(
    f.sql.query("SELECT content_json FROM context_import_attachments").get(),
  ).toEqual({ content_json: null });
  expect(
    f.sql.query("SELECT redacted_at FROM context_import_attachments").get(),
  ).toEqual({ redacted_at: 4242 });
  expect(f.sql.query("SELECT payload_json FROM operations").get()).toEqual({
    payload_json: "null",
  });
  expect(
    JSON.stringify(
      f.sql.query("SELECT plan_json FROM context_import_plans").get(),
    ),
  ).not.toContain("synthetic text");
  await expect(
    f.service().getAttachment(f.target, r.operation.operationID),
  ).rejects.toThrow("not_found");
  await expect(f.service().listAttachments(f.target)).rejects.toThrow(
    "not_found",
  );
  expect(await f.service().import(input)).toEqual(r);
  expect(f.calls()).toBe(0);
  f.sql.close();
});

test("ledger payload is metadata only while digest still detects changed packages for both modalities", async () => {
  for (const mode of ["append", "create"] as const) {
    const f = fixture();
    const input: ImportInput =
      mode === "append"
        ? { ...f.input, selection: { mode, target: f.target } }
        : f.input;
    const assertMetadata = () => {
      const row = f.sql
        .query<{ payload_json: string }, []>(
          "SELECT payload_json FROM operations",
        )
        .get();
      if (!row) throw new Error("fixture operation missing");
      expect(JSON.parse(row.payload_json)).toEqual({
        action: "context.import",
        selection: input.selection,
        sha256: envelope().sha256,
      });
      expect(row.payload_json).not.toContain("synthetic text");
      expect(row.payload_json).not.toContain("projection");
      expect(row.payload_json).not.toContain("envelope");
      expect(
        JSON.stringify(f.sql.query("SELECT * FROM operation_audit").all()),
      ).not.toContain("synthetic text");
    };
    if (mode === "create") f.during(assertMetadata);
    const original = await f.service().import(input);
    assertMetadata();
    const changed = envelope();
    changed.payload.projection.messages = [
      { id: "old-msg", role: "user", text: "different private content" },
    ];
    changed.sha256 = hashExportPayload(changed.payload);
    await expect(
      f.service().import({ ...input, raw: JSON.stringify(changed) }),
    ).rejects.toThrow("conflict");
    expect(await f.service().import(input)).toEqual(original);
    expect(f.calls()).toBe(mode === "create" ? 1 : 0);
    f.sql.close();
  }
});

test("cleanup directly redacts orphan attachment targets and does not wipe other refs by operation ID", async () => {
  const f = fixture();
  const input: ImportInput = {
    ...f.input,
    selection: { mode: "append", target: f.target },
  };
  const original = await f.service().import(input);
  const other = { ...f.target, sessionID: "unrelated-session" };
  // Deliberate historical corruption: operations cannot establish attachment
  // ownership, and an attachment can point at a different target than its plan.
  f.sql.exec("PRAGMA foreign_keys=OFF;");
  f.sql
    .query(
      "UPDATE context_import_attachments SET target_json=? WHERE operation_id=?",
    )
    .run(canonical(other), original.operation.operationID);
  const owner = await f.identity.current();
  f.sql
    .query("INSERT INTO context_import_attachments VALUES (?,?,?,?,?,?,NULL)")
    .run(
      "orphan-private",
      canonical(f.target),
      canonical(owner),
      "orphan private transcript",
      "orphan-hash",
      1000,
    );
  f.sql
    .query("INSERT INTO context_import_attachments VALUES (?,?,?,?,?,?,NULL)")
    .run(
      "orphan-other",
      canonical(other),
      canonical(owner),
      "unrelated private transcript",
      "unrelated-hash",
      1000,
    );
  const untouched = f.sql
    .query(
      "SELECT * FROM context_import_attachments WHERE target_json=? ORDER BY operation_id",
    )
    .all(canonical(other));
  f.db.transaction((sql) =>
    contextImportCleanup(() => 5151).cleanup(sql, f.target),
  );
  expect(
    f.sql
      .query(
        "SELECT content_json,redacted_at,payload_hash FROM context_import_attachments WHERE operation_id='orphan-private'",
      )
      .get(),
  ).toEqual({
    content_json: null,
    redacted_at: 5151,
    payload_hash: "orphan-hash",
  });
  expect(
    f.sql
      .query(
        "SELECT * FROM context_import_attachments WHERE target_json=? ORDER BY operation_id",
      )
      .all(canonical(other)),
  ).toEqual(untouched);
  f.db.transaction((sql) =>
    contextImportCleanup(() => 9999).cleanup(sql, f.target),
  );
  expect(
    f.sql
      .query(
        "SELECT redacted_at FROM context_import_attachments WHERE operation_id='orphan-private'",
      )
      .get(),
  ).toEqual({ redacted_at: 5151 });
  expect(await f.service().import(input)).toEqual(original);
  f.sql.close();
});

test("cleanup rejects invalid clocks before any redaction and requires the canonical transaction", async () => {
  const f = fixture();
  await f
    .service()
    .import({ ...f.input, selection: { mode: "append", target: f.target } });
  const before = f.sql.query("SELECT * FROM context_import_attachments").all();
  for (const at of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    expect(() =>
      f.db.transaction((sql) =>
        contextImportCleanup(() => at).cleanup(sql, f.target),
      ),
    ).toThrow("unavailable");
    expect(
      f.sql.query("SELECT * FROM context_import_attachments").all(),
    ).toEqual(before);
  }
  let reads = 0;
  expect(() =>
    contextImportCleanup(() => {
      reads++;
      return 1;
    }).cleanup(f.sql, f.target),
  ).toThrow("unavailable");
  expect(reads).toBe(0);
  f.sql.close();
});
test("capability preflight runs only AFTER authorization and before intent/admission commits", async () => {
  const f = fixture();
  let checks = 0;
  f.host.preflight = () => {
    checks++;
  };
  f.snapshot.deniedCapabilities = ["manage"];
  await expect(f.service().import(f.input)).rejects.toThrow("forbidden");
  expect(checks).toBe(0);
  f.snapshot.deniedCapabilities = [];
  f.host.preflight = () => {
    checks++;
    throw new DomainError("unsupported");
  };
  await expect(f.service().import(f.input)).rejects.toThrow("unsupported");
  expect(f.calls()).toBe(0);
  expect(f.sql.query("SELECT count(*) AS n FROM operations").get()).toEqual({
    n: 0,
  });
  checks = 0;
  f.host.preflight = () => {
    checks++;
    if (checks === 2) throw new DomainError("unsupported");
  };
  await expect(f.service().import(f.input)).rejects.toThrow("unsupported");
  expect(checks).toBe(2);
  expect(f.sql.query("SELECT state FROM operations").get()).toEqual({
    state: "pending",
  });
  expect(f.calls()).toBe(0);
  f.sql.close();
});
test("attachment access is scoped by target AND owner, not caller-supplied package origin", async () => {
  const f = fixture();
  const r = await f
    .service()
    .import({ ...f.input, selection: { mode: "append", target: f.target } });
  const other = { ...f.target, sessionID: "other" };
  const original = f.snapshot.grants[0];
  if (!original) throw new Error("fixture grant missing");
  f.snapshot.grants = [
    ...f.snapshot.grants,
    { ...original, grantID: "other-target", target: other },
    { ...original, grantID: "other-owner", source: other },
  ];
  expect(await f.service().listAttachments(other)).toEqual([]);
  await expect(
    f.service().getAttachment(other, r.operation.operationID),
  ).rejects.toThrow("not_found");
  const otherPrincipal = { kind: "session" as const, session: other };
  f.identity.current = async () => otherPrincipal;
  expect(await f.service().listAttachments(f.target)).toEqual([]);
  await expect(
    f.service().getAttachment(f.target, r.operation.operationID),
  ).rejects.toThrow("not_found");
  f.sql.close();
});
