import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { GRANTS_MIGRATION } from "../authorization/grants";
import { operatorCoreMigration } from "../authorization/operator-core";
import { OPERATOR_COMMANDS_MIGRATION } from "../composition/operator-registry";
import { POLICY_MIGRATION } from "../composition/policy";
import { IMPORT_ATTACHMENTS_MIGRATION } from "../context/import";
import { MEMORY_MIGRATION } from "../context/memory";
import { GROUPS_MIGRATION } from "../groups/service";
import { dispatcherMigrationAt } from "../messaging/dispatcher";
import { inboxMigrationAt } from "../messaging/inbox";
import { repliesMigrationAt } from "../messaging/replies";
import { eventsMigrationAt } from "../observability/events";
import { USAGE_MIGRATION } from "../observability/usage";
import { REQUESTS_MIGRATION } from "../orchestration/requests";
import { RUNNER_MIGRATION } from "../orchestration/runner";
import { TASKS_MIGRATION } from "../orchestration/tasks";
import { SCHEDULES_MIGRATION } from "../schedules/service";
import { controlMigration } from "../sessions/control";
import { creationMigration } from "../sessions/create";
import { reconciliationMigrationAt } from "../sessions/reconcile";
import type { Migration } from "./database";
import { operationMigrationAt } from "./operations";

export const COMPOSITION_LINEAGE = "composition-internal-v1";
export const COMPOSITION_VERSION = 23;
export const SUPPORTED_COMPOSITION_LINEAGE_VERSIONS: readonly number[] =
  Object.freeze([20, 21, 22, 23]);
/** Reviewed historical schema digests: never regenerate from mutable descriptors. */
const HISTORICAL_FINGERPRINTS: Readonly<Record<number, string>> = Object.freeze(
  {
    20: "fb100479d8d7455522469cf6c1678048bcfee6789bb9ebd606f5e31b2745f451",
    21: "ae53e249f60e5cdbccab50d39f27b6ca23ad423f1d968e1f463b81e4ad1fc0ff",
    22: "b74b1e6c6970cb918b870d2f03ec0fe3016078478694b2e0c54bc0f8bf77f2d8",
  },
);
export function schemaFingerprint(sql: Database): string {
  const rows = sql
    .query(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
/** Trusted descriptors, not SQL read from the candidate database. */
export function expectedCompositionFingerprint(
  version = COMPOSITION_VERSION,
): string {
  if (!SUPPORTED_COMPOSITION_LINEAGE_VERSIONS.includes(version))
    throw new Error("Unsupported internal composition lineage version");
  if (HISTORICAL_FINGERPRINTS[version]) return HISTORICAL_FINGERPRINTS[version];
  const reference = new Database(":memory:");
  try {
    // Ownership DDL is included separately in the full fingerprint at runtime.
    for (const migration of compositionMigrations)
      if (migration.version <= version) migration.apply(reference, "");
    return domainFingerprint(reference);
  } finally {
    reference.close();
  }
}
export function domainFingerprint(sql: Database): string {
  const rows = sql
    .query(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> 'ownership' ORDER BY type,name",
    )
    .all();
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
const wrap = (version: number, sql: string): Migration => ({
  version,
  apply(database) {
    database.exec(sql);
  },
});
/** Immutable published v15 DDL. Later import features require new versions. */
const HISTORICAL_IMPORT_V15_SQL = `CREATE TABLE context_import_plans (
    operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id),
    plan_json TEXT NOT NULL, effects_json TEXT NOT NULL
  );`;

/** v1 belongs exclusively to openPersistence; policy owner publishes v21. */
export const compositionMigrations: readonly Migration[] = [
  { version: 2, ...GRANTS_MIGRATION },
  operationMigrationAt(3),
  { version: 4, ...GROUPS_MIGRATION },
  reconciliationMigrationAt(5),
  wrap(6, creationMigration.sql),
  wrap(7, controlMigration.sql),
  inboxMigrationAt(8),
  dispatcherMigrationAt(9),
  repliesMigrationAt(10),
  eventsMigrationAt(11),
  { version: 12, ...TASKS_MIGRATION },
  { version: 13, ...RUNNER_MIGRATION },
  { version: 14, ...REQUESTS_MIGRATION },
  wrap(15, HISTORICAL_IMPORT_V15_SQL),
  { version: 16, ...MEMORY_MIGRATION },
  { version: 17, ...SCHEDULES_MIGRATION },
  { version: 18, ...USAGE_MIGRATION },
  wrap(19, operatorCoreMigration.sql),
  {
    version: 20,
    apply(sql) {
      sql.exec(
        "CREATE INDEX operator_gateway_quota ON operator_challenges(consumed,expires_at,credential_id)",
      );
      sql.exec(
        "CREATE INDEX operator_gateway_expiry ON operator_challenges(expires_at)",
      );
      sql.exec(
        "CREATE TABLE composition_lineage(singleton INTEGER PRIMARY KEY CHECK(singleton=1), lineage TEXT NOT NULL, fingerprint TEXT NOT NULL)",
      );
      sql
        .query("INSERT INTO composition_lineage VALUES(1,?,?)")
        .run(COMPOSITION_LINEAGE, schemaFingerprint(sql));
    },
  },
  {
    version: 21,
    ...POLICY_MIGRATION,
    apply(sql, backupPath) {
      if (domainFingerprint(sql) !== HISTORICAL_FINGERPRINTS[20])
        throw new Error("Unrecognized internal v20 schema");
      POLICY_MIGRATION.apply(sql, backupPath);
      sql
        .query("UPDATE composition_lineage SET fingerprint=? WHERE singleton=1")
        .run(schemaFingerprint(sql));
    },
  },
  {
    version: 22,
    ...OPERATOR_COMMANDS_MIGRATION,
    apply(sql, backupPath) {
      if (domainFingerprint(sql) !== HISTORICAL_FINGERPRINTS[21])
        throw new Error("Unrecognized internal v21 schema");
      OPERATOR_COMMANDS_MIGRATION.apply(sql, backupPath);
      sql
        .query("UPDATE composition_lineage SET fingerprint=? WHERE singleton=1")
        .run(schemaFingerprint(sql));
    },
  },
  {
    version: 23,
    apply(sql) {
      if (domainFingerprint(sql) !== HISTORICAL_FINGERPRINTS[22])
        throw new Error("Unrecognized internal v22 schema");
      sql.exec(IMPORT_ATTACHMENTS_MIGRATION.sql);
      sql
        .query("UPDATE composition_lineage SET fingerprint=? WHERE singleton=1")
        .run(schemaFingerprint(sql));
    },
  },
];
