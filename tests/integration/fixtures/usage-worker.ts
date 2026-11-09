import { Database } from "bun:sqlite";
import { DomainError, type Principal } from "../../../src/contracts";
import { UsageService } from "../../../src/observability/usage";
import { Persistence } from "../../../src/persistence/database";

const path = process.argv[2];
const admissionID = process.argv[3];
if (!path || !admissionID) throw new Error("missing fixture arguments");
const sql = new Database(path);
sql.exec("PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON");
const storage = new Persistence(sql, () => {});
const principal: Principal = {
  kind: "operator",
  instanceID: "i",
  operatorID: "o",
  revision: 1,
};
const service = new UsageService(
  storage,
  { current: async () => principal },
  { check() {} },
  { appendInTx() {} },
);
console.log("ready");
await Bun.stdin.text();
let code = 0;
try {
  storage.transaction((db) =>
    service.reserveInTx(db, principal, "a", admissionID, 3),
  );
} catch (error) {
  if (!(error instanceof DomainError) || error.code !== "conflict") throw error;
  code = 2;
} finally {
  sql.close();
}
process.exit(code);
