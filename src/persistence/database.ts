import { Database } from "bun:sqlite";
import {
  closeSync,
  fsyncSync,
  openSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  DomainError,
  type OwnershipEvidence,
  resolveOwnership,
} from "../contracts";

export interface Migration {
  readonly version: number;
  readonly apply: (database: Database, backupPath: string) => void;
}
export interface PersistenceOptions {
  readonly repositoryPath: string;
  readonly claims: readonly OwnershipEvidence[];
  /** Trusted application migrations only, never client SQL. */
  readonly migrations?: readonly Migration[];
}

function verifyFile(evidence: OwnershipEvidence, repositoryPath: string): void {
  const path = evidence.canonicalPath;
  const repo = realpathSync(repositoryPath);
  const within = relative(repo, path);
  const stat = statSync(path);
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    realpathSync(path) !== path ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (!within.startsWith("../") && within !== "..") ||
    evidence.databaseIdentity !== `${stat.dev}:${stat.ino}`
  )
    throw new DomainError("unavailable");
}

function version(database: Database): number {
  const row = database
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get();
  if (!row) throw new DomainError("unavailable");
  return row.user_version;
}

function backup(database: Database, path: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, database.serialize());
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const restored = new Database(path, { readonly: true });
  try {
    const result = restored
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .get();
    if (
      result?.integrity_check !== "ok" ||
      version(restored) !== version(database)
    )
      throw new DomainError("unavailable");
  } finally {
    restored.close();
  }
}

/** Synchronous local transactions only. No external I/O belongs inside a write callback. */
export class Persistence {
  constructor(
    private readonly database: Database,
    private readonly verify: () => void,
  ) {}
  get version(): number {
    return this.transaction(version);
  }
  transaction<T>(write: (database: Database) => T): T {
    try {
      this.verify();
      if (write.constructor.name === "AsyncFunction")
        throw new DomainError("invalid_input");
      return this.database
        .transaction(() => {
          const result = write(this.database);
          if (
            result &&
            typeof (result as { then?: unknown }).then === "function"
          )
            throw new DomainError("invalid_input");
          return result;
        })
        .immediate();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("unavailable");
    }
  }
  /** No action is invoked unless the local commit succeeded; no host atomicity claimed. */
  commitThen<T, R>(
    write: (database: Database) => T,
    action: (result: T) => R,
  ): R {
    try {
      if (this.database.inTransaction) throw new DomainError("conflict");
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("unavailable");
    }
    return action(this.transaction(write));
  }
  close(): void {
    this.database.close();
  }
}

export function openPersistence(options: PersistenceOptions): Persistence {
  let database: Database | undefined;
  try {
    const evidence = resolveOwnership(options.claims);
    const verify = () => verifyFile(evidence, options.repositoryPath);
    verify();
    database = new Database(evidence.canonicalPath, {
      readwrite: true,
      strict: true,
    });
    const db = database;
    db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON",
    );
    // A dedicated file may be empty at bootstrap; initialize its SQLite header.
    if (statSync(evidence.canonicalPath).size === 0)
      db.exec("PRAGMA user_version=0");
    const migrations: readonly Migration[] = [
      {
        version: 1,
        apply(sql) {
          sql.exec(
            "CREATE TABLE ownership (singleton INTEGER PRIMARY KEY CHECK(singleton=1), instance_id TEXT NOT NULL, scope_id TEXT NOT NULL, installation_id TEXT NOT NULL)",
          );
          sql
            .query("INSERT INTO ownership VALUES (1, ?, ?, ?)")
            .run(
              evidence.instanceID,
              evidence.scopeID,
              evidence.installationID,
            );
        },
      },
      ...(options.migrations ?? []),
    ];
    if (migrations.some((migration, index) => migration.version !== index + 1))
      throw new DomainError("invalid_input");
    db.transaction(() => {
      verify();
      if (version(db) > migrations.length) throw new DomainError("unavailable");
      if (version(db) >= 1) {
        const stored = db
          .query<
            { instance_id: string; scope_id: string; installation_id: string },
            []
          >("SELECT * FROM ownership WHERE singleton=1")
          .get();
        if (
          !stored ||
          stored.instance_id !== evidence.instanceID ||
          stored.scope_id !== evidence.scopeID ||
          stored.installation_id !== evidence.installationID
        )
          throw new DomainError("unavailable");
      }
      const current = version(db);
      if (
        current === 0 &&
        db
          .query(
            "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
          )
          .get()
      )
        throw new DomainError("unavailable");
      if (current === migrations.length) return;
      const backupPath = `${evidence.canonicalPath}.v${current}.${crypto.randomUUID()}.backup`;
      backup(db, backupPath);
      for (const migration of migrations.slice(current)) {
        migration.apply(db, backupPath);
        db.exec(`PRAGMA user_version=${migration.version}`);
      }
    }).exclusive();
    return new Persistence(db, verify);
  } catch (error) {
    database?.close();
    if (error instanceof DomainError) throw error;
    throw new DomainError("unavailable");
  }
}
