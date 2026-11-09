import { Database } from "bun:sqlite";
import {
  type AuthorizationSnapshot,
  Authorizer,
} from "../../../src/authorization/authorize";
import type { Principal } from "../../../src/contracts";
import { Dispatcher } from "../../../src/messaging/dispatcher";
import { Persistence } from "../../../src/persistence/database";
import { removedTargetPort } from "../../../src/sessions/reconcile";

const path = process.argv[2],
  id = process.argv[3];
if (!path || !id) throw new Error("missing fixture arguments");
const now = Number(process.argv[5] ?? 1000);
const db = new Database(path);
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
const persistence = new Persistence(db, () => {});
const load = () => {
  const row = db
    .query<{ body: string }, []>("SELECT body FROM fixture_policy")
    .get();
  if (!row) throw new Error("missing fixture policy");
  return JSON.parse(row.body) as AuthorizationSnapshot;
};
const owner = db
  .query<{ owner_json: string }, [string]>(
    "SELECT owner_json FROM operations WHERE operation_id=?",
  )
  .get(id);
if (!owner) throw new Error("missing fixture owner");
const principal = JSON.parse(owner.owner_json) as Principal;
const identity = { current: async () => principal };
const auth = new Authorizer(
  identity,
  {
    read: async () => persistence.transaction(load),
    admission: (_p, _t, check) =>
      persistence.transaction(() => {
        const s = load();
        const result = check(s);
        db.query("UPDATE fixture_policy SET body=?").run(JSON.stringify(s));
        return result;
      }),
  },
  () => now,
);
const worker = new Dispatcher(
  persistence,
  identity,
  auth,
  { current: async () => null },
  {
    send: async (prompt) => {
      if (db.inTransaction)
        throw new Error("native effect inside SQL transaction");
      persistence.transaction((sql) => {
        if (sql.query("SELECT 1 FROM fixture_host_active").get())
          throw new Error("overlapping host send");
        sql
          .query("INSERT INTO fixture_host_active VALUES (?)")
          .run(prompt.operationID);
        sql
          .query(
            "INSERT INTO fixture_host_log(operation_id,phase) VALUES (?,'enter')",
          )
          .run(prompt.operationID);
      });
      if (process.argv[4] === "hold") {
        console.log("ENTER");
        await Bun.stdin.text();
      }
      persistence.transaction((sql) => {
        sql
          .query("DELETE FROM fixture_host_active WHERE operation_id=?")
          .run(prompt.operationID);
        sql
          .query(
            "INSERT INTO fixture_host_log(operation_id,phase) VALUES (?,'leave')",
          )
          .run(prompt.operationID);
      });
      return { state: "accepted", messageID: prompt.messageID };
    },
    inspect: async () => ({ state: "unknown_outcome" }),
  },
  () => now,
  removedTargetPort,
);
try {
  console.log(`DONE ${(await worker.deliver(id, 1, 1)).state}`);
} catch (error) {
  console.log(`ERROR ${error instanceof Error ? error.message : "unexpected"}`);
} finally {
  db.close();
}
