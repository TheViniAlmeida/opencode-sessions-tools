import { Database } from "bun:sqlite";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Attempt,
  type Challenge,
  OperatorCore,
  type OperatorCoreOptions,
  type OperatorIntention,
  operatorCoreMigration,
  operatorDigest,
} from "../../src/authorization/operator-core";
import { canonical, DomainError } from "../../src/contracts";
import {
  openPersistence,
  type PersistenceOptions,
} from "../../src/persistence/database";

// Public, deterministic test data. Never used by an endpoint or bootstrap.
export const PUBLIC_BEARER =
  "PUBLIC_TEST_ONLY_operator_core_bearer_not_a_real_credential";
export const definitions = {
  resolve(operation: string) {
    if (!["synthetic.mutate", "synthetic.queryOwn"].includes(operation))
      return undefined;
    return {
      operation,
      capability: "synthetic-capability",
      method: "POST",
      route: "/synthetic",
      target: "group" as const,
      requiresConfirmation: operation === "synthetic.mutate",
      validateBody(body: unknown) {
        canonical(body);
        return body;
      },
    };
  },
};
export function optionsFor(
  path: string,
  repositoryPath: string,
): PersistenceOptions {
  const stat = statSync(path);
  return {
    repositoryPath,
    claims: [
      {
        instanceID: "i",
        scopeID: "scope",
        installationID: "synthetic",
        canonicalPath: realpathSync(path),
        databaseIdentity: `${stat.dev}:${stat.ino}`,
      },
    ],
    migrations: [
      {
        version: 2,
        apply(sql) {
          sql.exec(operatorCoreMigration.sql);
          sql.exec(
            "CREATE TABLE synthetic_effects (id TEXT PRIMARY KEY); CREATE TABLE synthetic_policy (singleton INTEGER PRIMARY KEY, read_own INTEGER, new_effect INTEGER); INSERT INTO synthetic_policy VALUES (1,1,1)",
          );
          sql.exec(`CREATE TABLE synthetic_capabilities (
            instance_id TEXT, operator_id TEXT, project_id TEXT, operation TEXT, target_json TEXT, capability TEXT,
            PRIMARY KEY(instance_id,operator_id,project_id,operation,target_json,capability));
            CREATE TABLE synthetic_target_revisions (
            instance_id TEXT, project_id TEXT, target_json TEXT, revision INTEGER,
            PRIMARY KEY(instance_id,project_id,target_json))`);
        },
      },
    ],
  };
}
export function composition(
  clock: () => number,
  prefix = "fixture",
): OperatorCoreOptions {
  let counter = 0;
  return {
    instanceID: "i",
    epoch: "boot",
    clock,
    generate: (kind) => `PUBLIC_TEST_ONLY_${prefix}_${kind}_${++counter}`,
    definitions,
    authorization: {
      readOwn(sql) {
        if (
          !sql
            .query<{ read_own: number }, []>(
              "SELECT read_own FROM synthetic_policy",
            )
            .get()?.read_own
        )
          throw new DomainError("forbidden");
      },
      newEffect(sql, principal, intention, capability) {
        if (
          !sql
            .query<{ new_effect: number }, []>(
              "SELECT new_effect FROM synthetic_policy",
            )
            .get()?.new_effect
        )
          throw new DomainError("forbidden");
        const grant = sql
          .query<
            { capability: string },
            [string, string, string, string, string, string]
          >(
            "SELECT capability FROM synthetic_capabilities WHERE instance_id=? AND operator_id=? AND project_id=? AND operation=? AND target_json=? AND capability=?",
          )
          .get(
            principal.instanceID,
            principal.operatorID,
            intention.projectID,
            intention.operation,
            canonical(intention.target),
            capability,
          );
        if (!grant) throw new DomainError("forbidden");
        if (intention.expectedRevision !== undefined) {
          const target = sql
            .query<{ revision: number }, [string, string, string]>(
              "SELECT revision FROM synthetic_target_revisions WHERE instance_id=? AND project_id=? AND target_json=?",
            )
            .get(
              principal.instanceID,
              intention.projectID,
              canonical(intention.target),
            );
          if (target?.revision !== intention.expectedRevision)
            throw new DomainError("forbidden");
        }
      },
    },
  };
}
export const localEffect = (
  sql: Database,
  _intent: OperatorIntention,
  operationID: string,
) => {
  sql.query("INSERT INTO synthetic_effects VALUES (?)").run(operationID);
  return { state: "local_admitted" };
};
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), "operator-core-"));
  const path = join(root, "synthetic.sqlite");
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(path, "", { mode: 0o600 });
  const persistenceOptions = optionsFor(path, repo);
  const persistence = openPersistence(persistenceOptions);
  const db = new Database(path);
  db.exec("PRAGMA busy_timeout=5000");
  let now = 100000;
  const options = composition(() => now);
  const core = new OperatorCore(persistence, options);
  db.query("INSERT INTO operator_credentials VALUES (?,?,?,?,?,?,?,0)").run(
    "credential",
    "operator",
    "i",
    1,
    operatorDigest(PUBLIC_BEARER),
    JSON.stringify(["p", "q"]),
    Number.MAX_SAFE_INTEGER,
  );
  const intention = (
    patch: Partial<OperatorIntention> = {},
  ): OperatorIntention => ({
    instanceID: "i",
    operatorID: "operator",
    projectID: "p",
    operation: "synthetic.mutate",
    target: { kind: "group", groupID: "g" },
    body: { value: 1 },
    confirmationID: "confirmation",
    ...patch,
  });
  const raw = (patch: Partial<OperatorIntention> = {}, key = "key") =>
    canonical({ key, intention: intention(patch) });
  const grant = (intent = intention(), capability = "synthetic-capability") => {
    db.query("INSERT INTO synthetic_capabilities VALUES (?,?,?,?,?,?)").run(
      intent.instanceID,
      intent.operatorID,
      intent.projectID,
      intent.operation,
      canonical(intent.target),
      capability,
    );
  };
  grant();
  grant(intention({ projectID: "q" }));
  grant(intention({ operation: "synthetic.queryOwn" }));
  grant(
    intention({
      operation: "synthetic.queryOwn",
      target: {
        kind: "session",
        version: 1,
        instanceID: "i",
        projectID: "p",
        sessionID: "s",
      },
    }),
  );
  const attempt = (body = raw(), patch: Partial<Attempt> = {}): Attempt => ({
    credentialID: "credential",
    bearer: PUBLIC_BEARER,
    projectID: "p",
    method: "POST",
    route: "/synthetic",
    operation: "synthetic.mutate",
    audience: { instanceID: "i", epoch: "boot" },
    timestamp: now,
    requestBodyHash: operatorDigest(body),
    ...patch,
  });
  const confirm = (intent = intention(), expires = now + 10000) => {
    const { confirmationID, ...business } = intent;
    if (!confirmationID) throw new Error("synthetic confirmation ID missing");
    db.query("INSERT INTO operator_confirmations VALUES (?,?,?,0)").run(
      confirmationID,
      operatorDigest(canonical(business)),
      expires,
    );
  };
  const count = () =>
    db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM synthetic_effects")
      .get()?.n;
  return {
    root,
    path,
    repo,
    persistenceOptions,
    persistence,
    db,
    options,
    core,
    intention,
    raw,
    attempt,
    confirm,
    grant,
    count,
    setNow: (v: number) => {
      now = v;
    },
    close() {
      db.close();
      persistence.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

if (import.meta.main) {
  const input = JSON.parse(process.argv[2] ?? "null") as {
    path: string;
    repo: string;
    attempt: Attempt;
    challenge: Challenge;
    raw: string;
    prefix: string;
  };
  const persistence = openPersistence(optionsFor(input.path, input.repo));
  try {
    const core = new OperatorCore(
      persistence,
      composition(() => 100000, input.prefix),
    );
    await new Promise<void>((resolve) => {
      process.stdin.once("data", () => resolve());
      process.stdout.write("ready\n");
    });
    try {
      const result = core.admit(
        input.attempt,
        input.challenge,
        input.raw,
        localEffect,
      );
      process.stdout.write(
        JSON.stringify({ status: "admitted", operationID: result.operationID }),
      );
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          status: error instanceof DomainError ? error.code : "failed",
        }),
      );
    }
  } finally {
    persistence.close();
  }
}
