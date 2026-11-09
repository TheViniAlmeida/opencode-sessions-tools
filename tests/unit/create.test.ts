import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { Principal, SessionRef } from "../../src/contracts";
import { Persistence } from "../../src/persistence/database";
import {
  type CreationInput,
  CreationService,
  creationMigration,
} from "../../src/sessions/create";

test("creation rejects untrusted fields/invalid capabilities before trusted adapters", async () => {
  const sql = new Database(":memory:");
  sql.exec(creationMigration.sql);
  const db = new Persistence(sql, () => {});
  const source: SessionRef = {
    version: 1,
    instanceID: "synthetic",
    projectID: "project",
    sessionID: "source",
  };
  const principal: Principal = { kind: "session", session: source };
  const unexpected = () => {
    throw new Error("trusted adapter must not be called");
  };
  const service = new CreationService(
    db,
    { current: async () => principal },
    {
      delegatedOperation: unexpected,
      authorize: unexpected,
      authorizeReplay: unexpected,
    },
    { execute: unexpected, inspect: unexpected },
    {
      location: unexpected,
      crossProjectApproval: unexpected,
      record: unexpected,
    },
    { assertAvailable: unexpected },
    () => 1000,
  );
  const input: CreationInput = {
    source,
    destination: { instanceID: "synthetic", projectID: "project" },
    kind: "root",
    capabilities: [],
    idempotencyKey: "key",
    expectedRevision: 1,
  };
  try {
    const cases = [
      { ...input, principal: { kind: "operator" } },
      { ...input, parentID: "untrusted" },
      { ...input, plannedID: "untrusted" },
      {
        ...input,
        destination: { ...input.destination, location: "untrusted" },
      },
      { ...input, capabilities: ["not-a-capability"] },
      { ...input, idempotencyKey: " " },
      { ...input, kind: "delete" },
    ];
    for (const value of cases) {
      await expect(
        service.create(value as CreationInput),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(sql.query("SELECT * FROM session_creation_plans").all()).toEqual([]);
  } finally {
    db.close();
  }
});

test("creation descriptor owns no global migration version or host delete surface", () => {
  expect(Object.keys(creationMigration).sort()).toEqual(["name", "sql"]);
  expect(creationMigration.sql).not.toMatch(/PRAGMA|DELETE|DROP/);
});
