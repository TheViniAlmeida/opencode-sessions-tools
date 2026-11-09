import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import manifest from "../../package.json";

test("T1: versions fixed and manifest cannot publish or pose as a plugin", () => {
  expect(manifest.private).toBe(true);
  expect(manifest.packageManager).toBe(`bun@${Bun.version}`);
  const node = Bun.spawnSync(["node", "--version"]);
  expect(node.exitCode).toBe(0);
  expect(manifest.engines.node).toBe(
    node.stdout.toString().trim().replace(/^v/, ""),
  );
  for (const version of Object.values(manifest.devDependencies)) {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  }
  expect("exports" in manifest).toBe(false);
  expect("main" in manifest).toBe(false);
});

test("T1: absent suites and unimplemented probes never pass silently", async () => {
  const sandbox = await mkdtemp("/tmp/opencode/opencode-sessions-tools/empty-");
  try {
    for (const layer of ["unit", "contract", "e2e"]) {
      const result = Bun.spawn(
        [process.execPath, "scripts/test-layer.ts", layer, "--root", sandbox],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await result.exited).not.toBe(0);
      expect(await new Response(result.stderr).text()).toContain(
        "NOT_IMPLEMENTED",
      );
    }
  } finally {
    await rm(sandbox, { recursive: true });
  }
  for (const scenario of [
    `missing-${crypto.randomUUID()}`,
    "toString",
    "constructor",
    "hasOwnProperty",
  ]) {
    const probe = Bun.spawn(
      [process.execPath, "run", "probe", "--", scenario],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await probe.exited).toBe(2);
    expect(await new Response(probe.stderr).text()).toContain(
      "NOT_IMPLEMENTED",
    );
  }
});

test("T1: actual tarball excludes synthetic credentials, databases and fixtures", async () => {
  const root = await mkdtemp("/tmp/opencode/opencode-sessions-tools/package-");
  try {
    await writeFile(`${root}/package.json`, JSON.stringify(manifest));
    await mkdir(`${root}/dist`);
    await cp(resolve("dist/harness.js"), `${root}/dist/harness.js`);
    await mkdir(`${root}/tests`);
    await writeFile(`${root}/empty-npmrc`, "");
    await writeFile(`${root}/global-npmrc`, "");
    for (const file of [
      ".env",
      "auth.json",
      "host.db",
      "tests/private.json",
      "dist/auth.json",
    ]) {
      await writeFile(`${root}/${file}`, "SYNTHETIC_PRIVATE_SENTINEL");
    }
    const pack = Bun.spawn(
      ["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", root],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          TMPDIR: root,
          npm_config_cache: `${root}/cache`,
          npm_config_userconfig: `${root}/empty-npmrc`,
          npm_config_globalconfig: `${root}/global-npmrc`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = await new Response(pack.stdout).text();
    const errors = await new Response(pack.stderr).text();
    if (await pack.exited)
      throw new Error(`Synthetic package failed: ${errors}`);
    expect(await pack.exited).toBe(0);
    const [record] = JSON.parse(output);
    expect(
      record.files.map((file: { path: string }) => file.path).sort(),
    ).toEqual(["dist/harness.js", "package.json"]);
    const tar = Bun.spawn(["tar", "-xOf", `${root}/${record.filename}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await new Response(tar.stdout).text()).not.toContain(
      "SYNTHETIC_PRIVATE_SENTINEL",
    );
    expect(await tar.exited).toBe(0);
  } finally {
    await rm(root, { recursive: true });
  }
}, 30_000);
