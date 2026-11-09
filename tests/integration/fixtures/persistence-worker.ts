import {
  openPersistence,
  type PersistenceOptions,
} from "../../../src/persistence/database";

const input = process.argv[2];
if (!input) throw new Error("missing fixture options");
const options = JSON.parse(input) as PersistenceOptions;
const mode = process.argv[3];
const db = openPersistence(options);
try {
  if (mode === "compete") {
    for (let i = 0; i < 100; i++) {
      db.transaction((sql) => sql.exec("UPDATE counter SET value=value+1"));
    }
  } else if (mode === "crash") {
    db.transaction((sql) => {
      sql.exec("UPDATE counter SET value=9999");
      process.stdout.write("LOCKED\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    });
  } else if (mode === "committed") {
    db.transaction((sql) => sql.exec("UPDATE counter SET value=value+1"));
    process.stdout.write("COMMITTED\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  } else throw new Error("invalid fixture mode");
} finally {
  db.close();
}
