import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { Plugin } from "@opencode/plugin";
import {
  OperatorCore,
  operatorCoreMigration,
  operatorDigest,
} from "../../../src/authorization/operator-core";
import { DomainError } from "../../../src/contracts";
import { Persistence } from "../../../src/persistence/database";
import { createOperatorGateway } from "../../../src/transport/operator-gateway";

// Public marker, not a provisioned credential. Never print request headers.
export const operatorTestMarker =
  "PUBLIC_TEST_ONLY_operator_lifecycle_not_a_credential";
export function requireOperatorFixtureHome(home: string | undefined): string {
  if (
    !home ||
    !/^\/tmp\/opencode\/opencode-sessions-tools\/fixture-[A-Za-z0-9_-]+\/home$/.test(
      home,
    ) ||
    realpathSync(home) !== home
  )
    throw new Error("Operator fixture requires canonical isolated HOME");
  return home;
}

export default Plugin.define({
  id: "operator-private-fixture",
  async setup() {
    const home = requireOperatorFixtureHome(process.env.HOME);
    const epoch = randomUUID();
    const instanceID = "operator-lifecycle-synthetic";
    const path = `${home}/operator-synthetic.sqlite`;
    const initialize = !existsSync(path);
    if (initialize) writeFileSync(path, "", { flag: "wx", mode: 0o600 });
    const db = new Database(path);
    const persistence = new Persistence(db, () => {
      requireOperatorFixtureHome(home);
    });
    let gateway: ReturnType<typeof createOperatorGateway> | undefined;
    let count = 0;
    const publish = (state: string) =>
      writeFileSync(
        `${home}/operator-channel.json`,
        JSON.stringify({
          state,
          pid: process.pid,
          port: gateway ? Number(new URL(gateway.url).port) : null,
          audience: { instanceID, epoch },
          callbackCount: count,
        }),
        { mode: 0o600 },
      );
    try {
      // Explicit fixture initialization; no production migrations or enrollment.
      if (initialize) {
        db.exec(
          "CREATE TABLE ownership (singleton INTEGER PRIMARY KEY, instance_id TEXT NOT NULL)",
        );
        db.query("INSERT INTO ownership VALUES (1, ?)").run(instanceID);
        db.exec(operatorCoreMigration.sql);
        db.exec(
          "CREATE INDEX operator_gateway_quota ON operator_challenges(consumed,expires_at,credential_id); CREATE INDEX operator_gateway_expiry ON operator_challenges(expires_at); CREATE TABLE synthetic_effects (operation_id TEXT PRIMARY KEY)",
        );
        db.query(
          "INSERT INTO operator_credentials VALUES (?,?,?,?,?,?,?,0)",
        ).run(
          "fixture",
          "synthetic-operator",
          instanceID,
          1,
          operatorDigest(operatorTestMarker),
          JSON.stringify(["synthetic-project"]),
          Number.MAX_SAFE_INTEGER,
        );
      }
      let sequence = 0;
      const core = new OperatorCore(persistence, {
        instanceID,
        epoch,
        clock: Date.now,
        generate: (kind) => `PUBLIC_TEST_ONLY_${epoch}_${kind}_${++sequence}`,
        definitions: {
          resolve(operation) {
            if (operation !== "synthetic.counter") return undefined;
            return {
              operation,
              capability: "synthetic-counter",
              method: "POST",
              route: "/synthetic",
              target: "group" as const,
              requiresConfirmation: false,
              validateBody(body) {
                return body;
              },
            };
          },
        },
        authorization: {
          readOwn(_sql, principal, intention) {
            if (
              principal.operatorID !== "synthetic-operator" ||
              intention.projectID !== "synthetic-project" ||
              intention.operation !== "synthetic.counter" ||
              intention.target.kind !== "group" ||
              intention.target.groupID !== "synthetic"
            )
              throw new DomainError("forbidden");
          },
          newEffect(_sql, principal, intention, capability) {
            if (
              principal.operatorID !== "synthetic-operator" ||
              intention.projectID !== "synthetic-project" ||
              capability !== "synthetic-counter"
            )
              throw new DomainError("forbidden");
          },
        },
      });
      gateway = createOperatorGateway({
        hostname: "127.0.0.1",
        port: 0,
        allowedPorts: [],
        fixtureEphemeral: true,
        core,
        persistence,
        operations: [
          {
            operation: "synthetic.counter",
            route: "/synthetic",
            local(sql, _intention, operationID) {
              sql
                .query("INSERT INTO synthetic_effects VALUES (?)")
                .run(operationID);
              return { state: "local_admitted" };
            },
          },
        ],
      });
      // Count is read from committed SQL only, never incremented outside admission.
      const updateCount = () => {
        count =
          db
            .query<{ n: number }, []>(
              "SELECT COUNT(*) AS n FROM synthetic_effects",
            )
            .get()?.n ?? 0;
      };
      updateCount();
      await publish("active");
      return async () => {
        await gateway?.stop();
        updateCount();
        await publish("unloaded");
        persistence.close();
      };
    } catch {
      await gateway?.stop();
      persistence.close();
      throw new Error("Operator synthetic setup failed");
    }
  },
});
