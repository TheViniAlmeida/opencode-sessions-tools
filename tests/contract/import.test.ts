import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  type AuthorizationSnapshot,
  Authorizer,
} from "../../src/authorization/authorize";
import { hashExportPayload } from "../../src/context/export";
import {
  ContextImportService,
  IMPORT_ATTACHMENTS_MIGRATION,
  importMigration,
  parseImportEnvelope,
} from "../../src/context/import";
import { capabilities, type SessionRef } from "../../src/contracts";
import { Persistence } from "../../src/persistence/database";
import { operationsMigration } from "../../src/persistence/operations";

// Synthetic native-shaped DTO projection, NOT a native server/adapter certification.
// T7 establishes data.id and possible project/location rewrites. No HTTP request.
function contract(rewritten: boolean) {
  const sql = new Database(":memory:");
  sql.exec(operationsMigration.sql);
  sql.exec(importMigration.sql);
  sql.exec(IMPORT_ATTACHMENTS_MIGRATION.sql);
  const db = new Persistence(sql, () => {});
  const target: SessionRef = {
    version: 1,
    instanceID: "fixture",
    projectID: "project",
    sessionID: "authority",
  };
  const principal = {
    kind: "operator" as const,
    instanceID: "fixture",
    operatorID: "operator",
    revision: 1,
  };
  const identity = { current: async () => principal };
  const snapshot: AuthorizationSnapshot = {
    revision: 1,
    profile: "manage",
    profileCapabilities: capabilities,
    policyCapabilities: capabilities,
    hostCapabilities: capabilities,
    deniedCapabilities: [],
    grants: [],
    operator: {
      ...principal,
      capabilities,
      projects: ["project"],
      expiresAt: null,
    },
    delegationCapabilities: [],
    approval: null,
  };
  const auth = new Authorizer(
    identity,
    {
      read: async () => snapshot,
      admission: (_p, _t, check) => db.transaction(() => check(snapshot)),
    },
    () => 1000,
  );
  let calls = 0;
  const service = new ContextImportService(
    db,
    identity,
    auth,
    {
      preflight: () => {},
      importNewSession: async (plan) => {
        calls++;
        // Native-shaped receipt, explicitly projected by the SYNTHETIC adapter.
        const response = {
          data: {
            id: plan.target.sessionID,
            projectID: rewritten ? "rewritten-project" : "project",
            location: { directory: "/synthetic/effective" },
          },
        };
        return {
          state: "observed",
          value: {
            observedSession: {
              version: 1,
              instanceID: "fixture",
              projectID: response.data.projectID,
              sessionID: response.data.id,
            },
            confirmedMessages: plan.messages.map((message) => ({
              session: plan.target,
              messageID: message.id,
            })),
            uncertainIDs: [],
          },
        };
      },
    },
    {
      check() {
        /* Isolated trusted preapproval fixture; production must use real routing. */
      },
    },
    {
      assertAvailable() {
        /* Isolated tombstone fixture. */
      },
    },
    () => 1000,
  );
  const payload = {
    version: 1,
    source: { ...target, instanceID: "claimed-foreign-origin" },
    createdAt: "2026-01-01T00:00:00.000Z",
    mode: "selected-context",
    projection: {
      kind: "text-messages-v1",
      messages: [
        { id: "old", role: "assistant", text: "synthetic assistant context" },
      ],
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
  const input = {
    raw: JSON.stringify({ payload, sha256: hashExportPayload(payload) }),
    selection: {
      mode: "create" as const,
      authorityTarget: target,
      destination: { instanceID: "fixture", projectID: "project" },
    },
    idempotencyKey: "fixture",
    expectedRevision: 1,
  };
  return { sql, service, input, calls: () => calls };
}
test("synthetic data.id adapter confirms selected destination without origin authority", async () => {
  const f = contract(false);
  const r = await f.service.import(f.input);
  expect(r.operation.state).toBe("admitted");
  expect(r.effects.session?.projectID).toBe("project");
  expect(f.calls()).toBe(1);
  if (!r.effects.session) throw new Error("fixture expected created session");
  expect(r.effects.messageObservations[0]?.session).toEqual(r.effects.session);
  expect(
    f.sql
      .query(
        "SELECT count(*) AS n FROM sqlite_master WHERE name IN ('grants','jobs','permissions','config')",
      )
      .get(),
  ).toEqual({ n: 0 });
  f.sql.close();
});
test("synthetic native project rewrite cannot become successful destination import", async () => {
  const f = contract(true);
  const r = await f.service.import(f.input);
  expect(r.error).toBe("unknown_outcome");
  expect(r.effects.session?.projectID).toBe("rewritten-project");
  expect(f.calls()).toBe(1);
  expect(await f.service.import(f.input)).toEqual(r);
  expect(f.calls()).toBe(1);
  f.sql.close();
});
test("raw native transfer DTO is not accepted as plugin envelope", () => {
  expect(() =>
    parseImportEnvelope(
      JSON.stringify({
        info: {
          id: "ses_fixture",
          projectID: "foreign",
          permissions: [{ effect: "allow" }],
          location: { directory: "/synthetic" },
        },
        messages: [],
      }),
    ),
  ).toThrow("invalid_input");
});
