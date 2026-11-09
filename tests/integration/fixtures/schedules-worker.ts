import type { Database } from "bun:sqlite";
import { mkdirSync, statSync } from "node:fs";
import type { AuthorizationSnapshot } from "../../../src/authorization/authorize";
import { GRANTS_MIGRATION, Grants } from "../../../src/authorization/grants";
import {
  capabilities,
  type Principal,
  type SessionRef,
} from "../../../src/contracts";
import {
  Dispatcher,
  dispatcherMigration,
  type NativePrompt,
} from "../../../src/messaging/dispatcher";
import { openPersistence } from "../../../src/persistence/database";
import {
  operationsMigration,
  pendingGrantOperations,
} from "../../../src/persistence/operations";
import { SCHEDULES_MIGRATION, Scheduler } from "../../../src/schedules/service";

function readTime(sql: Database): number {
  const row = sql
    .query<{ now: number }, []>("SELECT now FROM synthetic_state")
    .get();
  if (!row) throw new Error("missing synthetic coordinator");
  return row.now;
}

export function openSyntheticScheduler(
  root: string,
  location: string,
  installationID = "installation",
) {
  mkdirSync(`${root}/${location}`, { recursive: true });
  const path = `${root}/canonical.sqlite`;
  const stat = statSync(path);
  const source: SessionRef = {
    version: 1,
    instanceID: "fixture",
    projectID: "project",
    sessionID: "source",
  };
  const target: SessionRef = { ...source, sessionID: "target" };
  const operator: Principal = {
    kind: "operator",
    operatorID: "operator",
    instanceID: "fixture",
    revision: 1,
  };
  const session: Principal = { kind: "session", session: source };
  let current: Principal = session;
  const descriptors = [
    GRANTS_MIGRATION,
    {
      apply(sql: Database) {
        sql.exec(operationsMigration.sql);
      },
    },
    {
      apply(sql: Database) {
        sql.exec(dispatcherMigration.sql);
      },
    },
    SCHEDULES_MIGRATION,
    {
      apply(sql: Database) {
        sql.exec(`CREATE TABLE synthetic_state(now INTEGER NOT NULL); INSERT INTO synthetic_state VALUES(1000);
      CREATE TABLE synthetic_sends(sequence INTEGER PRIMARY KEY,operation_id TEXT NOT NULL,payload_hash TEXT NOT NULL);`);
      },
    },
  ];
  const storage = openPersistence({
    repositoryPath: `${root}/${location}`,
    claims: [
      {
        instanceID: "fixture",
        scopeID: "scope",
        installationID,
        canonicalPath: path,
        databaseIdentity: `${stat.dev}:${stat.ino}`,
      },
    ],
    migrations: descriptors.map((descriptor, index) => ({
      ...descriptor,
      version: index + 2,
    })),
  });
  const time = () => storage.transaction(readTime);
  const identity = { current: async () => current };
  const policy = {
    load: (): AuthorizationSnapshot => ({
      revision: 1,
      profile: "bounded-auto",
      profileCapabilities: capabilities,
      policyCapabilities: capabilities,
      hostCapabilities: capabilities,
      deniedCapabilities: [],
      grants: [],
      operator: {
        operatorID: "operator",
        instanceID: "fixture",
        revision: 1,
        capabilities,
        projects: ["project"],
        expiresAt: null,
      },
      delegationCapabilities: null,
      approval: null,
    }),
    save() {},
  };
  const grants = new Grants(
    storage,
    identity,
    policy,
    pendingGrantOperations(time),
    time,
  );
  const targets = { assertAvailable() {} };
  const options = {
    storage,
    identity,
    policy,
    grants,
    targets,
    limits: { assert() {} },
    clock: { utc: time, monotonic: time, setTimer: () => () => {} },
    coordinator: { now: readTime },
    dispatcher: (
      owner: Principal,
      authorization: ConstructorParameters<typeof Dispatcher>[2],
    ) =>
      new Dispatcher(
        storage,
        { current: async () => owner },
        authorization,
        { current: async () => null },
        {
          async send(prompt: NativePrompt) {
            // External-effect surrogate: deliberately no UNIQUE dedup on this table.
            storage.commitThen(
              (sql) => {
                sql
                  .query(
                    "INSERT INTO synthetic_sends(operation_id,payload_hash) VALUES(?,?)",
                  )
                  .run(prompt.operationID, prompt.payloadHash);
              },
              () => {},
            );
            return { state: "accepted" as const, messageID: prompt.messageID };
          },
          async inspect() {
            return { state: "unknown_outcome" as const };
          },
        },
        time,
        targets,
      ),
  };
  const scheduler = new Scheduler(options);
  return {
    scheduler,
    storage,
    grants,
    target,
    source,
    operator,
    session,
    identity: (p: Principal) => {
      current = p;
    },
  };
}

if (import.meta.main) {
  const [root, location, mode, jobID] = process.argv.slice(2);
  if (!root || !location) throw new Error("synthetic worker arguments missing");
  const f = openSyntheticScheduler(root, location);
  try {
    if (mode === "old" && jobID) {
      f.scheduler.scan();
      const lease = f.scheduler.claim(jobID, location, 100);
      console.log(JSON.stringify({ claimed: lease.generation }));
      await new Response(Bun.stdin.stream()).text();
      try {
        await f.scheduler.admit(lease);
        await f.scheduler.work(lease);
        console.log(JSON.stringify({ staleAdmitted: true }));
      } catch (error) {
        console.log(
          JSON.stringify({
            staleRejected: error instanceof Error ? error.message : "error",
          }),
        );
      }
    } else {
      await f.scheduler.tick();
      console.log(JSON.stringify({ tick: "completed" }));
    }
  } finally {
    f.scheduler.dispose();
    f.storage.close();
  }
}
