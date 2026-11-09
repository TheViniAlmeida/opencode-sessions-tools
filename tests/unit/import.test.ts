import { expect, test } from "bun:test";
import { hashExportPayload } from "../../src/context/export";
import {
  contextImportCleanup,
  IMPORT_ATTACHMENTS_MIGRATION,
  type ImportHostPort,
  importMigration,
  MAX_IMPORT_BYTES,
  parseImportEnvelope,
} from "../../src/context/import";

test("host port exposes only batch/preflight, with compile-time rejection of legacy routes", () => {
  const supported: (keyof ImportHostPort)[] = ["preflight", "importNewSession"];
  // @ts-expect-error Legacy session creation is not a supported import port.
  const oldCreate: keyof ImportHostPort = "create";
  // @ts-expect-error Native message append is not a supported import port.
  const oldAppend: keyof ImportHostPort = "append";
  expect(supported).not.toContain(oldCreate);
  expect(supported).not.toContain(oldAppend);
});
test("cleanup factory has no implicit clock", () => {
  expect(() => {
    // @ts-expect-error A deterministic clock is mandatory at composition.
    contextImportCleanup();
  }).toThrow("invalid_input");
});

test("historical import migration SQL is immutable; attachments are additive and unversioned", () => {
  expect(importMigration.name).toBe("context-import-v1");
  expect(importMigration.sql).toBe(`CREATE TABLE context_import_plans (
    operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id),
    plan_json TEXT NOT NULL, effects_json TEXT NOT NULL
  );`);
  expect(importMigration.sql).not.toContain("context_import_attachments");
  expect(IMPORT_ATTACHMENTS_MIGRATION.name).toBe(
    "context-import-attachments-v1",
  );
  expect(IMPORT_ATTACHMENTS_MIGRATION.sql).toContain(
    "CREATE TABLE context_import_attachments",
  );
  expect(IMPORT_ATTACHMENTS_MIGRATION).not.toHaveProperty("version");
});

export function envelope() {
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
test("v1 round trip integrity is not source authentication", () => {
  expect(JSON.stringify(parseImportEnvelope(JSON.stringify(envelope())))).toBe(
    JSON.stringify(envelope()),
  );
});
test("size measures raw UTF8 bytes including whitespace", () => {
  const raw = JSON.stringify(envelope());
  expect(
    JSON.stringify(
      parseImportEnvelope(
        raw + " ".repeat(MAX_IMPORT_BYTES - Buffer.byteLength(raw)),
      ),
    ),
  ).toBe(JSON.stringify(envelope()));
  expect(() => parseImportEnvelope(raw + " ".repeat(MAX_IMPORT_BYTES))).toThrow(
    "invalid_input",
  );
  expect(() =>
    parseImportEnvelope(`"${"é".repeat(MAX_IMPORT_BYTES / 2)}"`),
  ).toThrow("invalid_input");
});
test("malformed JSON, primitive envelopes and raw ill-formed UTF16 fail closed", () => {
  for (const raw of ["{", "null", "[]", "true", "\ud800"])
    expect(() => parseImportEnvelope(raw)).toThrow("invalid_input");
});
test("strict payload validation even with recomputed digest", () => {
  const mutations: [string, unknown][] = [
    ["version", 2],
    ["source.version", 2],
    ["source.permissions", []],
    ["source.projectID", ""],
    ["mode", "filesystem"],
    ["createdAt", "yesterday"],
    ["projection.kind", "native"],
    ["loss.authority", false],
    ["loss.configuration", undefined],
    ["permissions", []],
    ["jobs", []],
    ["grants", []],
    ["projection.messages.0.role", "system"],
    ["projection.messages.0.text", {}],
    ["projection.messages.0.id", 42],
    ["projection.messages.0.permissions", []],
    ["projection.messages", [null]],
    ["projection.messages.0.text", "\ud800"],
  ];
  for (const [path, value] of mutations) {
    const e = envelope();
    const segments = path.split(".");
    let parent = e.payload as unknown as Record<string, unknown>;
    for (const key of segments.slice(0, -1))
      parent = parent[key] as Record<string, unknown>;
    const key = segments.at(-1);
    if (!key) throw new Error("fixture path missing");
    if (value === undefined) delete parent[key];
    else parent[key] = value;
    e.sha256 = hashExportPayload(e.payload);
    expect(() => parseImportEnvelope(JSON.stringify(e))).toThrow(
      "invalid_input",
    );
  }
});
test("tampered digest and envelope extensions rejected", () => {
  expect(() =>
    parseImportEnvelope(
      JSON.stringify({ ...envelope(), sha256: "0".repeat(64) }),
    ),
  ).toThrow("invalid_input");
  expect(() =>
    parseImportEnvelope(JSON.stringify({ ...envelope(), config: {} })),
  ).toThrow("invalid_input");
});
