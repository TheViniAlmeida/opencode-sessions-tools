import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  type AuthorizationSnapshot,
  Authorizer,
} from "../../src/authorization/authorize";
import {
  capabilities,
  type Principal,
  type SessionRef,
} from "../../src/contracts";
import { Persistence } from "../../src/persistence/database";
import { operationsMigration } from "../../src/persistence/operations";
import {
  type CreationHostPort,
  CreationService,
  creationMigration,
} from "../../src/sessions/create";

/** Native-shaped synthetic probe only. No SDK/server/auth-production claim.
 * T31 must certify public API DTOs, project routing and no inheritance on host.
 */
test("native-shaped fork accepts no caller ID and returns a different host ID; create honors ID", async () => {
  const sql = new Database(":memory:");
  sql.exec(operationsMigration.sql);
  sql.exec(creationMigration.sql);
  const db = new Persistence(sql, () => {});
  const source: SessionRef = {
    version: 1,
    instanceID: "fixture",
    projectID: "project",
    sessionID: "native-source",
  };
  const principal: Principal = {
    kind: "operator",
    instanceID: source.instanceID,
    operatorID: "fixture-operator",
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
    delegationCapabilities: capabilities,
    approval: null,
    operator: {
      operatorID: principal.operatorID,
      instanceID: principal.instanceID,
      revision: 1,
      capabilities,
      projects: [source.projectID],
      expiresAt: null,
    },
  };
  const auth = new Authorizer(
    identity,
    {
      read: async () => snapshot,
      admission: (_p, _t, local) =>
        db.transaction(() => local(structuredClone(snapshot))),
    },
    () => 1000,
  );
  const native = {
    create: async (body: { id: string; parentID?: string }) => {
      expect(Object.keys(body).sort()).toEqual(["id", "parentID"]);
      return { id: body.id, parentID: body.parentID };
    },
    fork: async (path: { sessionID: string }) => {
      expect(path).toEqual({ sessionID: source.sessionID });
      expect(path).not.toHaveProperty("id");
      return { id: "native-assigned-fork", parentID: source.sessionID };
    },
  };
  const host: CreationHostPort = {
    execute: async (plan) => {
      expect(sql.inTransaction).toBe(false);
      let response: { id: string; parentID?: string };
      if (plan.kind === "fork")
        response = await native.fork({ sessionID: plan.source.sessionID });
      else {
        if (!plan.planned) throw new Error("create requires caller ID");
        response = await native.create({
          id: plan.planned.sessionID,
          parentID: plan.parent?.sessionID,
        });
      }
      return {
        state: "created",
        session: { version: 1, ...plan.destination, sessionID: response.id },
      };
    },
    inspect: async (plan) => plan.observed,
  };
  const service = new CreationService(
    db,
    identity,
    auth,
    host,
    {
      location: () => "fixture-location",
      crossProjectApproval: () => false,
      record: (_tx, plan, observed) => {
        if (plan.kind === "fork") {
          expect(plan.planned).toBeNull();
          expect(observed.sessionID).toBe("native-assigned-fork");
        } else expect(plan.planned).toEqual(observed);
      },
    },
    { assertAvailable: () => {} },
    () => 1000,
  );
  try {
    for (const kind of ["root", "child", "fork"] as const) {
      const result = await service.create({
        source,
        destination: {
          instanceID: source.instanceID,
          projectID: source.projectID,
        },
        kind,
        capabilities: [],
        expectedRevision: 1,
        idempotencyKey: `native-${kind}`,
      });
      expect(result.operation?.state).toBe("admitted");
      expect(result.operation?.receiptID).toBe(result.session?.sessionID);
      if (kind === "fork")
        expect(result.session?.sessionID).toBe("native-assigned-fork");
      else expect(result.session?.sessionID).toStartWith("ses_");
    }
  } finally {
    db.close();
  }
});
