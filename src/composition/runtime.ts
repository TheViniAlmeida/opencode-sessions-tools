import { Database } from "bun:sqlite";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  DomainError,
  type OwnershipEvidence,
  resolveOwnership,
} from "../contracts";
import { openPersistence, type Persistence } from "../persistence/database";
import {
  COMPOSITION_LINEAGE,
  compositionMigrations,
  domainFingerprint,
  expectedCompositionFingerprint,
  SUPPORTED_COMPOSITION_LINEAGE_VERSIONS,
  schemaFingerprint,
} from "../persistence/migrations";

export class LegacyRequiresUpgradeError extends DomainError {
  readonly internalReason = "legacy_requires_upgrade";
  constructor() {
    super("unavailable");
  }
}
export interface CompositionRuntimeOptions {
  readonly databasePath: string;
  readonly repositoryPath: string;
  readonly instanceID: string;
  readonly scopeID: string;
  readonly installationID: string;
  /** Independent observations from other locations, never fabricated copies. */
  readonly claims?: readonly OwnershipEvidence[];
}
export interface CompositionRuntime {
  readonly persistence: Persistence;
  readonly ownership: OwnershipEvidence;
  dispose(): void;
}

function validateExistingAncestors(parent: string): void {
  let ancestor = parent;
  while (true) {
    try {
      const stat = lstatSync(ancestor);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        realpathSync(ancestor) !== ancestor
      )
        throw new DomainError("unavailable");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const next = dirname(ancestor);
    if (next === ancestor) return;
    ancestor = next;
  }
}

/** Internal storage factory only: no host adapter, registry, timer or listener. */
export function createCompositionRuntime(
  options: CompositionRuntimeOptions,
): CompositionRuntime {
  const path = options.databasePath;
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new Error("Explicit canonical database path required");
  const repo = realpathSync(options.repositoryPath);
  const inside = relative(repo, path);
  if (!inside.startsWith("../") && inside !== "..")
    throw new Error("Database must be outside repository");
  validateExistingAncestors(dirname(path));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (realpathSync(dirname(path)) !== dirname(path))
    throw new Error("Database parent must be canonical");
  try {
    const fd = openSync(path, "wx", 0o600);
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = statSync(path);
  if (realpathSync(path) !== path || !stat.isFile() || stat.nlink !== 1)
    throw new Error("Database identity unavailable");
  const ownership = resolveOwnership([
    {
      instanceID: options.instanceID,
      scopeID: options.scopeID,
      installationID: options.installationID,
      canonicalPath: path,
      databaseIdentity: `${stat.dev}:${stat.ino}`,
    },
    ...(options.claims ?? []),
  ]);
  if (stat.size !== 0) {
    let probe: Database | undefined;
    try {
      try {
        probe = new Database(path, { readonly: true });
        const stamp = probe
          .query<{ lineage: string; fingerprint: string }, []>(
            "SELECT lineage,fingerprint FROM composition_lineage WHERE singleton=1",
          )
          .get();
        const version = probe
          .query<{ user_version: number }, []>("PRAGMA user_version")
          .get();
        if (
          !version ||
          !SUPPORTED_COMPOSITION_LINEAGE_VERSIONS.some(
            (value) => value === version.user_version,
          ) ||
          stamp?.lineage !== COMPOSITION_LINEAGE ||
          stamp.fingerprint !== schemaFingerprint(probe) ||
          domainFingerprint(probe) !==
            expectedCompositionFingerprint(version.user_version)
        )
          throw new LegacyRequiresUpgradeError();
      } finally {
        probe?.close();
      }
    } catch {
      throw new LegacyRequiresUpgradeError();
    }
  }
  if (
    (stat.mode & 0o777) !== 0o600 ||
    (statSync(dirname(path)).mode & 0o777) !== 0o700
  )
    throw new Error("Private database permissions required");
  const persistence = openPersistence({
    repositoryPath: repo,
    claims: [ownership],
    migrations: compositionMigrations,
  });
  let disposed = false;
  return {
    persistence,
    ownership,
    dispose() {
      if (disposed) return;
      disposed = true;
      persistence.close();
    },
  };
}
