import {
  type AuthorizationSnapshot,
  Authorizer,
} from "../../../src/authorization/authorize";
import {
  GRANTS_MIGRATION,
  type GrantPolicyPort,
  Grants,
} from "../../../src/authorization/grants";
import type { Principal, SessionRef } from "../../../src/contracts";
import {
  openPersistence,
  type PersistenceOptions,
} from "../../../src/persistence/database";

const input = JSON.parse(await Bun.stdin.text()) as {
  options: PersistenceOptions;
  grantID: string;
  mode: "admit" | "revoke";
};
if (
  !/^\/tmp\/opencode\/opencode-sessions-tools\/t12-grants-[^/]+\/synthetic\.sqlite$/.test(
    input.options.claims[0]?.canonicalPath ?? "",
  )
)
  throw new Error("synthetic fixture only");
const db = openPersistence({
  ...input.options,
  migrations: [
    { version: 2, ...GRANTS_MIGRATION },
    {
      version: 3,
      apply() {
        throw new Error("fixture must already exist");
      },
    },
  ],
});
try {
  const target: SessionRef = {
    version: 1,
    instanceID: "fixture",
    projectID: "project",
    sessionID: "target",
  };
  const operator: Principal = {
    kind: "operator",
    operatorID: "synthetic",
    instanceID: "fixture",
    revision: 1,
  };
  const origin: Principal = {
    kind: "session",
    session: { ...target, sessionID: "source" },
  };
  const principal = input.mode === "admit" ? origin : operator;
  const identity = { current: async () => principal };
  const policy: GrantPolicyPort = {
    load: (sql) =>
      JSON.parse(
        sql.query<{ body: string }, []>("SELECT body FROM fixture_policy").get()
          ?.body ?? "null",
      ) as AuthorizationSnapshot,
    save: (sql, s) => {
      sql
        .query("UPDATE fixture_policy SET body=?")
        .run(JSON.stringify({ ...s, grants: [] }));
    },
  };
  const service = new Grants(
    db,
    identity,
    policy,
    {
      revoke(sql, g) {
        const rows = sql
          .query<{ id: string; state: string }, [string]>(
            "SELECT id,state FROM fixture_pending WHERE grant_id=?",
          )
          .all(g.grantID);
        sql
          .query(
            "UPDATE fixture_pending SET state='rejected' WHERE grant_id=? AND state='pending'",
          )
          .run(g.grantID);
        return {
          rejected: rows.filter((r) => r.state === "pending").map((r) => r.id),
          already_admitted: rows
            .filter((r) => r.state === "admitted")
            .map((r) => r.id),
        };
      },
    },
    () => 1000,
  );
  if (input.mode === "revoke")
    console.log(JSON.stringify(await service.unlink(input.grantID, 1, 1)));
  else {
    const authorizer = new Authorizer(
      identity,
      {
        read: async (p, t) =>
          db.transaction((sql) => ({
            ...policy.load(sql, p, t),
            grants: service.snapshot(sql).grants,
          })),
        admission: (p, t, check) =>
          db.transaction((sql) => {
            const s = {
              ...policy.load(sql, p, t),
              grants: service.snapshot(sql).grants,
            };
            const result = check(s);
            policy.save(sql, s);
            return result;
          }),
      },
      () => 1000,
    );
    try {
      const result = await authorizer.admit(origin, target, "read", 1, () =>
        db.transaction((sql) => {
          sql
            .query(
              "UPDATE fixture_pending SET state='admitted' WHERE id='race' AND state='pending'",
            )
            .run();
          return "admitted";
        }),
      );
      console.log(JSON.stringify({ state: result }));
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "forbidden")
        throw error;
      console.log(JSON.stringify({ state: "rejected" }));
    }
  }
} finally {
  db.close();
}
