import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { openPersistence } from "../../src/persistence/database";

const root = "/tmp/opencode/opencode-sessions-tools";
mkdirSync(root, { recursive: true });
function fixture() {
  const dir = mkdtempSync(join(root, "persistence-"));
  const path = join(dir, "plugin.sqlite");
  writeFileSync(path, "");
  const stat = statSync(path);
  const claim = {
    instanceID: "instance",
    scopeID: "scope",
    installationID: "installation",
    canonicalPath: path,
    databaseIdentity: `${stat.dev}:${stat.ino}`,
  };
  return {
    dir,
    path,
    claim,
    options: { repositoryPath: process.cwd(), claims: [claim] },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("versioned creation, durable transaction, rollback and fail-closed action", () => {
  const f = fixture();
  try {
    const db = openPersistence(f.options);
    expect(db.version).toBe(1);
    db.transaction((sql) => sql.exec("CREATE TABLE sample (value INTEGER)"));
    expect(() =>
      db.transaction((sql) => {
        sql.exec("INSERT INTO sample VALUES (1)");
        throw new Error("rollback");
      }),
    ).toThrow();
    expect(
      db.transaction((sql) => sql.query("SELECT * FROM sample").all()),
    ).toEqual([]);
    let effects = 0;
    expect(() =>
      db.commitThen(
        (sql) => sql.exec("INSERT INTO absent VALUES (1)"),
        () => effects++,
      ),
    ).toThrow("unavailable");
    expect(effects).toBe(0);
    db.commitThen(
      (sql) => sql.exec("INSERT INTO sample VALUES (2)"),
      () => effects++,
    );
    expect(effects).toBe(1);
    expect(() =>
      db.transaction(() =>
        db.commitThen(
          () => {},
          () => effects++,
        ),
      ),
    ).toThrow("conflict");
    let asyncCalled = false;
    expect(() =>
      db.transaction(async () => {
        asyncCalled = true;
      }),
    ).toThrow("invalid_input");
    expect(asyncCalled).toBe(false);
    db.close();
    const reopened = openPersistence(f.options);
    expect(
      reopened.transaction((sql) =>
        sql.query("SELECT value FROM sample").all(),
      ),
    ).toEqual([{ value: 2 }]);
    reopened.close();
    let writes = 0;
    expect(() =>
      reopened.commitThen(
        () => {
          writes++;
        },
        () => effects++,
      ),
    ).toThrow("unavailable");
    expect(effects).toBe(1);
    expect(writes).toBe(0);
  } finally {
    f.cleanup();
  }
});

test("backup precedes migration, restores and failed migration rolls back", () => {
  const f = fixture();
  try {
    const original = openPersistence(f.options);
    original.transaction((sql) =>
      sql.exec(
        "CREATE TABLE legacy (value TEXT); INSERT INTO legacy VALUES ('durable')",
      ),
    );
    original.close();
    let backup = "";
    expect(() =>
      openPersistence({
        ...f.options,
        migrations: [
          {
            version: 2,
            apply(sql, backupPath) {
              backup = backupPath;
              sql.exec("CREATE TABLE partial (id INTEGER)");
              throw new Error("synthetic");
            },
          },
        ],
      }),
    ).toThrow("unavailable");
    const source = new Database(f.path);
    expect(source.query("PRAGMA user_version").get()).toEqual({
      user_version: 1,
    });
    expect(
      source.query("SELECT name FROM sqlite_master WHERE name='partial'").all(),
    ).toEqual([]);
    source.close();
    const restore = join(f.dir, "restored.sqlite");
    copyFileSync(backup, restore);
    const restored = new Database(restore, { readonly: true });
    expect(restored.query("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    expect(restored.query("PRAGMA user_version").get()).toEqual({
      user_version: 1,
    });
    expect(restored.query("SELECT value FROM legacy").all()).toEqual([
      { value: "durable" },
    ]);
    restored.close();
    const migrated = openPersistence({
      ...f.options,
      migrations: [
        {
          version: 2,
          apply(sql) {
            sql.exec("CREATE TABLE next (id INTEGER)");
          },
        },
      ],
    });
    expect(migrated.version).toBe(2);
    migrated.close();
  } finally {
    f.cleanup();
  }
});

test("ownership rejects aliases, forged filesystem evidence and incompatible installations", () => {
  const f = fixture();
  try {
    openPersistence(f.options).close();
    expect(() =>
      openPersistence({
        ...f.options,
        claims: [{ ...f.claim, instanceID: "other" }],
      }),
    ).toThrow("unavailable");
    expect(() =>
      openPersistence({
        ...f.options,
        claims: [{ ...f.claim, databaseIdentity: "forged" }],
      }),
    ).toThrow("unavailable");
    const alias = join(f.dir, "alias.sqlite");
    symlinkSync(f.path, alias);
    expect(() =>
      openPersistence({
        ...f.options,
        claims: [{ ...f.claim, canonicalPath: alias }],
      }),
    ).toThrow("unavailable");
    expect(() =>
      openPersistence({ ...f.options, repositoryPath: f.dir }),
    ).toThrow("unavailable");
    const shared = openPersistence({
      ...f.options,
      claims: [f.claim, f.claim],
    });
    shared.close();
  } finally {
    f.cleanup();
  }
});

test("two real processes serialize writes; killed transactions roll back, committed writes survive", async () => {
  const f = fixture();
  const children: ReturnType<typeof Bun.spawn>[] = [];
  function child(mode: string) {
    const result = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/persistence-worker.ts"),
        JSON.stringify(f.options),
        mode,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    children.push(result);
    return result;
  }
  try {
    const initial = openPersistence(f.options);
    initial.transaction((sql) =>
      sql.exec(
        "CREATE TABLE counter (value INTEGER NOT NULL); INSERT INTO counter VALUES (0)",
      ),
    );
    initial.close();
    const a = child("compete");
    const b = child("compete");
    expect(await Promise.all([a.exited, b.exited])).toEqual([0, 0]);
    const inspect = () => {
      const db = openPersistence(f.options);
      try {
        return db.transaction((sql) =>
          sql.query("SELECT value FROM counter").get(),
        );
      } finally {
        db.close();
      }
    };
    expect(inspect()).toEqual({ value: 200 });
    for (const [mode, signal] of [
      ["crash", "LOCKED"],
      ["committed", "COMMITTED"],
    ] as const) {
      const coordinator = openPersistence(f.options);
      const worker = child(mode);
      const reader = worker.stdout.getReader();
      try {
        const ready = await reader.read();
        expect(new TextDecoder().decode(ready.value)).toContain(signal);
        if (mode === "crash") {
          let writes = 0;
          let effects = 0;
          expect(() =>
            coordinator.commitThen(
              () => {
                writes++;
              },
              () => effects++,
            ),
          ).toThrow("unavailable");
          expect(writes).toBe(0);
          expect(effects).toBe(0);
        }
      } finally {
        coordinator.close();
        reader.releaseLock();
        worker.kill("SIGKILL");
        await worker.exited;
      }
      expect(inspect()).toEqual({ value: mode === "crash" ? 200 : 201 });
    }
  } finally {
    for (const worker of children) {
      worker.kill();
      await worker.exited;
    }
    f.cleanup();
  }
}, 20000);
