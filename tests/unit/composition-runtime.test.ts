import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  createCompositionRuntime,
  LegacyRequiresUpgradeError,
} from "../../src/composition/runtime";

const roots: string[] = [];
const handles: { dispose(): void }[] = [];
test("non-SQLite bytes yield only a typed unavailable error", () => {
  const root = mkdtempSync(
    "/tmp/opencode/opencode-sessions-tools/composition-bytes-",
  );
  roots.push(root);
  const databasePath = join(root, "state.sqlite");
  writeFileSync(databasePath, "arbitrary non-SQLite fixture bytes", {
    mode: 0o600,
  });
  let caught: unknown;
  try {
    const runtime = createCompositionRuntime({
      databasePath,
      repositoryPath: process.cwd(),
      instanceID: "fixture",
      scopeID: "scope",
      installationID: "installation",
    });
    handles.push(runtime);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect(caught).toBeInstanceOf(LegacyRequiresUpgradeError);
  expect(caught).toMatchObject({ code: "unavailable" });
  expect(String(caught)).not.toContain(databasePath);
});

test("symlink ancestor rejection creates nothing through the alias", () => {
  const root = mkdtempSync(
    "/tmp/opencode/opencode-sessions-tools/composition-symlink-",
  );
  roots.push(root);
  const target = join(root, "target");
  mkdirSync(target);
  const alias = join(root, "alias");
  symlinkSync(target, alias);
  expect(() =>
    createCompositionRuntime({
      databasePath: join(alias, "unwanted", "state.sqlite"),
      repositoryPath: process.cwd(),
      instanceID: "fixture",
      scopeID: "scope",
      installationID: "installation",
    }),
  ).toThrow();
  expect(existsSync(join(target, "unwanted"))).toBe(false);
});
afterEach(() => {
  try {
    for (const handle of handles.splice(0)) handle.dispose();
  } finally {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true });
      expect(existsSync(root)).toBe(false);
    }
  }
});

test("explicit private database reopens with matching claims", () => {
  const directory = mkdtempSync(
    "/tmp/opencode/opencode-sessions-tools/composition-runtime-",
  );
  roots.push(directory);
  const options = {
    databasePath: join(directory, "private", "state.sqlite"),
    repositoryPath: process.cwd(),
    instanceID: "fixture",
    scopeID: "scope",
    installationID: "installation",
  };
  const first = createCompositionRuntime(options);
  handles.push(first);
  expect(first.persistence.version).toBe(23);
  expect(statSync(options.databasePath).mode & 0o777).toBe(0o600);
  expect(statSync(join(directory, "private")).mode & 0o777).toBe(0o700);
  first.dispose();
  first.dispose();
  const second = createCompositionRuntime(options);
  handles.push(second);
  expect(second.persistence.version).toBe(23);
  second.dispose();
  expect(() =>
    createCompositionRuntime({ ...options, scopeID: "different" }),
  ).toThrow();
});

test("two caller locations share one canonical database and reject divergent observations", () => {
  const root = mkdtempSync(
    "/tmp/opencode/opencode-sessions-tools/composition-locations-",
  );
  roots.push(root);
  const a = join(root, "caller-a");
  const b = join(root, "caller-b");
  mkdirSync(a);
  mkdirSync(b);
  const base = {
    databasePath: join(root, "state.sqlite"),
    instanceID: "fixture",
    scopeID: "scope",
    installationID: "installation",
  };
  const first = createCompositionRuntime({ ...base, repositoryPath: a });
  handles.push(first);
  const claim = first.ownership;
  first.dispose();
  const second = createCompositionRuntime({
    ...base,
    repositoryPath: b,
    claims: [claim],
  });
  handles.push(second);
  expect(second.ownership).toEqual(claim);
  expect(existsSync(join(a, "state.sqlite"))).toBe(false);
  expect(existsSync(join(b, "state.sqlite"))).toBe(false);
  second.dispose();
  expect(() =>
    createCompositionRuntime({
      ...base,
      repositoryPath: b,
      claims: [{ ...claim, installationID: "different" }],
    }),
  ).toThrow();
});
