import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  createCompositionRuntime,
  LegacyRequiresUpgradeError,
} from "../../src/composition/runtime";
import { openPersistence } from "../../src/persistence/database";
import {
  compositionMigrations,
  domainFingerprint,
  expectedCompositionFingerprint,
  schemaFingerprint,
} from "../../src/persistence/migrations";

for (const version of [20, 21, 22]) {
  test(`historical descriptor v${version} preserves its anchored fingerprint`, () => {
    const sql = new Database(":memory:");
    try {
      for (const migration of compositionMigrations.filter(
        (item) => item.version <= version,
      ))
        migration.apply(sql, "");
      expect(domainFingerprint(sql)).toBe(
        expectedCompositionFingerprint(version),
      );
      expect(
        sql
          .query(
            "SELECT name FROM sqlite_master WHERE name='context_import_attachments'",
          )
          .get(),
      ).toBeNull();
    } finally {
      sql.close();
    }
  });
}

const roots: string[] = [];
const handles: { dispose(): void }[] = [];
function fixtureRoot(label: string): string {
  const root = mkdtempSync(
    `/tmp/opencode/opencode-sessions-tools/composition-${label}-`,
  );
  roots.push(root);
  return root;
}
afterEach(() => {
  try {
    for (const handle of handles.splice(0)) handle.dispose();
  } finally {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true });
      expect(existsSync(root)).toBe(false);
    }
  }
});

test("fresh composition has integrity, foreign keys and exact gateway indexes", () => {
  const databasePath = join(fixtureRoot("db"), "state.sqlite");
  const runtime = createCompositionRuntime({
    databasePath,
    repositoryPath: process.cwd(),
    instanceID: "fixture",
    scopeID: "scope",
    installationID: "installation",
  });
  handles.push(runtime);
  runtime.persistence.transaction((sql) => {
    const tables =
      `ownership grants_revision grants_records grants_requests grants_audit operations operation_outbox operation_audit groups_records groups_members session_tombstones session_removal_audit session_creation_plans session_control_results notification_inbox prompt_dispatches prompt_chain_rejections request_replies reply_cursors event_heads event_journal event_cursors task_graphs task_records runner_intents runner_outcomes task_questions question_audit context_import_plans context_memory schedule_jobs schedule_occurrences schedule_outbox schedule_gates schedule_clock schedule_audit usage_facts usage_budgets usage_reservations usage_budget_mutations usage_receipts operator_credentials operator_challenges operator_confirmations operator_ledger composition_lineage`
        .split(" ")
        .concat("composition_policies", "composition_routes")
        .concat("operator_commands")
        .concat("context_import_attachments")
        .sort();
    expect(
      sql
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name),
    ).toEqual(tables);
    const expectedEdges = [
      "operator_commands:operation_id:operator_ledger:operation_id:NO ACTION",
      "context_import_attachments:operation_id:operations:operation_id:NO ACTION",
      "operation_outbox:operation_id:operations:operation_id:NO ACTION",
      "operation_audit:operation_id:operations:operation_id:NO ACTION",
      "groups_members:group_id:groups_records:group_id:CASCADE",
      "session_creation_plans:operation_id:operations:operation_id:NO ACTION",
      "session_control_results:operation_id:operations:operation_id:NO ACTION",
      "notification_inbox:envelope_id:operations:operation_id:NO ACTION",
      "prompt_dispatches:operation_id:operations:operation_id:NO ACTION",
      "request_replies:request_id:prompt_dispatches:operation_id:NO ACTION",
      "reply_cursors:request_id:prompt_dispatches:operation_id:NO ACTION",
      "task_graphs:group_id:groups_records:group_id:CASCADE",
      "task_records:group_id:task_graphs:group_id:CASCADE",
      "runner_intents:task_id:task_records:task_id:CASCADE",
      "runner_outcomes:admission_id:runner_intents:admission_id:CASCADE",
      "task_questions:task_id:task_records:task_id:CASCADE",
      "context_import_plans:operation_id:operations:operation_id:NO ACTION",
      "schedule_occurrences:job_id:schedule_jobs:job_id:NO ACTION",
      "schedule_outbox:occurrence_id:schedule_occurrences:occurrence_id:NO ACTION",
      "usage_budgets:group_id:groups_records:group_id:CASCADE",
    ].sort();
    const edges = tables
      .flatMap((table) =>
        sql
          .query<
            { from: string; table: string; to: string; on_delete: string },
            []
          >(`PRAGMA foreign_key_list(${table})`)
          .all()
          .map(
            (edge) =>
              `${table}:${edge.from}:${edge.table}:${edge.to}:${edge.on_delete}`,
          ),
      )
      .sort();
    expect(edges).toEqual(expectedEdges);
    expect(sql.query("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    expect(sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      sql
        .query(
          "SELECT sql FROM sqlite_master WHERE name='operator_gateway_expiry'",
        )
        .get(),
    ).toEqual({
      sql: "CREATE INDEX operator_gateway_expiry ON operator_challenges(expires_at)",
    });
    expect(
      sql
        .query(
          "SELECT sql FROM sqlite_master WHERE name='operator_gateway_quota'",
        )
        .get(),
    ).toEqual({
      sql: "CREATE INDEX operator_gateway_quota ON operator_challenges(consumed,expires_at,credential_id)",
    });
    expect(
      sql.query("PRAGMA foreign_key_list(task_records)").all(),
    ).toMatchObject([{ table: "task_graphs", on_delete: "CASCADE" }]);
    expect(sql.query("PRAGMA foreign_key_list(question_audit)").all()).toEqual(
      [],
    );
  });
  runtime.dispose();
});

test("failed next migration rolls back and leaves a restorable backup", () => {
  const directory = fixtureRoot("rollback");
  const databasePath = join(directory, "state.sqlite");
  const options = {
    databasePath,
    repositoryPath: process.cwd(),
    instanceID: "fixture",
    scopeID: "scope",
    installationID: "installation",
  };
  const runtime = createCompositionRuntime(options);
  handles.push(runtime);
  const ownership = runtime.ownership;
  runtime.dispose();
  expect(() =>
    openPersistence({
      repositoryPath: process.cwd(),
      claims: [ownership],
      migrations: [
        ...compositionMigrations,
        {
          version: 24,
          apply(sql) {
            sql.exec("CREATE TABLE failed_slice(id INTEGER)");
            throw new Error("fixture failure");
          },
        },
      ],
    }),
  ).toThrow();
  const backup = readdirSync(directory).find(
    (name) => name.includes(".v23.") && name.endsWith(".backup"),
  );
  expect(backup).toBeDefined();
  if (!backup) throw new Error("Fixture backup missing");
  const restored = new Database(join(directory, backup), { readonly: true });
  try {
    expect(restored.query("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    expect(
      restored
        .query("SELECT name FROM sqlite_master WHERE name='failed_slice'")
        .get(),
    ).toBeNull();
  } finally {
    restored.close();
  }
  const reopened = createCompositionRuntime(options);
  reopened.dispose();
});

test("user_version does not recognize an unknown database", () => {
  const databasePath = join(fixtureRoot("unknown"), "state.sqlite");
  const sql = new Database(databasePath, { create: true });
  try {
    sql.exec("CREATE TABLE unknown(id INTEGER); PRAGMA user_version=20");
  } finally {
    sql.close();
  }
  expect(() =>
    createCompositionRuntime({
      databasePath,
      repositoryPath: process.cwd(),
      instanceID: "fixture",
      scopeID: "scope",
      installationID: "installation",
    }),
  ).toThrow(LegacyRequiresUpgradeError);
  let caught: unknown;
  try {
    createCompositionRuntime({
      databasePath,
      repositoryPath: process.cwd(),
      instanceID: "fixture",
      scopeID: "scope",
      installationID: "installation",
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect(caught).toMatchObject({
    code: "unavailable",
    internalReason: "legacy_requires_upgrade",
  });
});

for (const priorVersion of [20, 21, 22]) {
  test(`recognized internal v${priorVersion} upgrades to v23 and reopens`, () => {
    const root = fixtureRoot(`known-v${priorVersion}`);
    const databasePath = join(root, "state.sqlite");
    closeSync(openSync(databasePath, "wx", 0o600));
    const stat = statSync(databasePath);
    const options = {
      databasePath,
      repositoryPath: process.cwd(),
      instanceID: "fixture",
      scopeID: "scope",
      installationID: "installation",
    };
    const claim = {
      instanceID: options.instanceID,
      scopeID: options.scopeID,
      installationID: options.installationID,
      canonicalPath: databasePath,
      databaseIdentity: `${stat.dev}:${stat.ino}`,
    };
    const previous = openPersistence({
      repositoryPath: options.repositoryPath,
      claims: [claim],
      migrations: compositionMigrations.filter(
        (migration) => migration.version <= priorVersion,
      ),
    });
    try {
      expect(previous.version).toBe(priorVersion);
    } finally {
      previous.close();
    }
    const upgraded = createCompositionRuntime({ ...options, claims: [claim] });
    handles.push(upgraded);
    expect(upgraded.persistence.version).toBe(23);
    upgraded.persistence.transaction((sql) => {
      expect(domainFingerprint(sql)).toBe(expectedCompositionFingerprint(23));
      expect(
        sql
          .query(
            "SELECT fingerprint FROM composition_lineage WHERE singleton=1",
          )
          .get(),
      ).toEqual({ fingerprint: schemaFingerprint(sql) });
      expect(
        sql
          .query(
            "SELECT name FROM sqlite_master WHERE name IN ('composition_policies','composition_routes') ORDER BY name",
          )
          .all(),
      ).toEqual([
        { name: "composition_policies" },
        { name: "composition_routes" },
      ]);
      expect(sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
    });
    upgraded.dispose();
    const reopened = createCompositionRuntime(options);
    handles.push(reopened);
    expect(reopened.persistence.version).toBe(23);
  });
}

test("re-stamping an altered known schema cannot authorize a partial upgrade", () => {
  const databasePath = join(fixtureRoot("altered-lineage"), "state.sqlite");
  const options = {
    databasePath,
    repositoryPath: process.cwd(),
    instanceID: "fixture",
    scopeID: "scope",
    installationID: "installation",
  };
  const runtime = createCompositionRuntime(options);
  handles.push(runtime);
  runtime.dispose();
  const sql = new Database(databasePath);
  try {
    sql.exec(
      "DROP TABLE operator_commands; CREATE TABLE unexpected(id INTEGER); PRAGMA user_version=21",
    );
    sql
      .query("UPDATE composition_lineage SET fingerprint=?")
      .run(schemaFingerprint(sql));
  } finally {
    sql.close();
  }
  expect(() => createCompositionRuntime(options)).toThrow(
    LegacyRequiresUpgradeError,
  );
  const probe = new Database(databasePath, { readonly: true });
  try {
    expect(probe.query("PRAGMA user_version").get()).toEqual({
      user_version: 21,
    });
    expect(
      probe
        .query("SELECT name FROM sqlite_master WHERE name='operator_commands'")
        .get(),
    ).toBeNull();
  } finally {
    probe.close();
  }
});

test("private command deferred foreign key rejects a different core operation and rolls back", () => {
  const databasePath = join(fixtureRoot("command-fk"), "state.sqlite");
  const runtime = createCompositionRuntime({
    databasePath,
    repositoryPath: process.cwd(),
    instanceID: "fixture",
    scopeID: "scope",
    installationID: "installation",
  });
  handles.push(runtime);
  let caught: unknown;
  try {
    runtime.persistence.transaction((sql) => {
      const schema = sql
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE name='operator_commands'",
        )
        .get();
      expect(schema?.sql).toContain(
        "REFERENCES operator_ledger(operation_id) DEFERRABLE INITIALLY DEFERRED",
      );
      sql
        .query(
          "INSERT INTO operator_commands(operation_id,credential_id,credential_revision,owner_json,intention_json,body_hash,confirmation_binding,state) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          "wrong-core-operation",
          "fixture",
          1,
          "{}",
          "{}",
          "fixture-hash",
          "fixture-binding",
          "pending",
        );
      expect(
        sql.query("SELECT count(*) AS count FROM operator_commands").get(),
      ).toEqual({ count: 1 });
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  runtime.persistence.transaction((sql) => {
    expect(
      sql.query("SELECT count(*) AS count FROM operator_commands").get(),
    ).toEqual({ count: 0 });
    expect(sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
