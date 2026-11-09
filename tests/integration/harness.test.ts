import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createHarness } from "../../scripts/harness";

test("operator plugin is opt-in, private, active and reused after restart", async () => {
  const host = await createHarness({
    operatorPlugin: true,
    identityPlugin: true,
  });
  try {
    const directory = `${host.root}/operator-plugin`;
    const artifact = Bun.file(`${directory}/index.js`);
    expect(await Bun.file(`${directory}/package.json`).json()).toEqual({
      name: "operator-private-fixture",
      type: "module",
      exports: { ".": "./index.js" },
    });
    expect(
      (await (await import("node:fs/promises")).stat(host.root)).mode & 0o777,
    ).toBe(0o700);
    const before = await artifact.text();
    const modified = (await artifact.stat()).mtimeMs;
    for (let run = 0; run < 2; run++) {
      const config = await Bun.file(
        `${host.env.XDG_CONFIG_HOME}/opencode/opencode.json`,
      ).json();
      expect(config.plugins).toEqual([
        `${host.root}/identity-plugin`,
        directory,
      ]);
      let status: string | undefined;
      const deadline = Date.now() + 10_000;
      do {
        const response = await host.request(
          `/api/plugin?location[directory]=${encodeURIComponent(`${host.root}/project`)}`,
        );
        expect(response.status).toBe(200);
        const result = (await response.json()) as {
          data: Array<{ id: string; state: { status: string } }>;
        };
        status = result.data.find(
          (entry) => entry.id === "operator-private-fixture",
        )?.state.status;
        if (status === "active") break;
        await Bun.sleep(100);
      } while (Date.now() < deadline);
      expect(status).toBe("active");
      if (run === 0) await host.restart();
    }
    expect(await artifact.text()).toBe(before);
    expect((await artifact.stat()).mtimeMs).toBe(modified);
  } finally {
    await host.stop();
  }
}, 90_000);

import { createDeterministicProvider } from "../../scripts/probes/fixtures/deterministic-provider";

test("delivery provider rejects noncanonical and external URLs", async () => {
  for (const baseURL of [
    "http://localhost:1234/v1",
    "https://127.0.0.1:1234/v1",
    "http://example.invalid:1234/v1",
    "http://127.0.0.1/v1",
    "http://user:pass@127.0.0.1:1234/v1",
    "http://127.0.0.1:1234/v1?q=1",
    "http://127.0.0.1:1234/v1#hash",
    "unix:/socket",
    "http://127.1:1234/v1",
    "http://127.0.0.1:1234/v1/",
    "http://127.0.0.1:0/v1",
  ]) {
    await expect(
      createHarness({ deliveryProvider: { baseURL } }),
    ).rejects.toThrow("delivery provider URL");
  }
});

test("delivery provider writes only fixture config and combines flags", async () => {
  const provider = createDeterministicProvider();
  const harness = await createHarness({
    deliveryProvider: { baseURL: provider.baseURL },
    schedules: true,
    identityPlugin: true,
  });
  try {
    const config = await Bun.file(
      `${harness.env.XDG_CONFIG_HOME}/opencode/opencode.json`,
    ).json();
    expect(config.model).toBe("delivery-fixture/deterministic");
    expect(config.providers["delivery-fixture"].settings.baseURL).toBe(
      provider.baseURL,
    );
    expect(config.experimental.schedules).toBe(true);
    expect(config.plugins).toEqual([`${harness.root}/identity-plugin`]);
    const created = await harness.request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Synthetic deterministic provider integration",
        location: { directory: `${harness.root}/project` },
      }),
    });
    expect(created.status).toBe(200);
    const { data } = (await created.json()) as { data: { id: string } };
    const prompted = await harness.request(`/api/session/${data.id}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "Synthetic local fixture request",
        resume: true,
      }),
    });
    expect(prompted.status).toBe(200);
    let messages = "";
    const deadline = Date.now() + 10_000;
    do {
      const response = await harness.request(`/api/session/${data.id}/message`);
      expect(response.status).toBe(200);
      messages = await response.text();
      if (messages.includes("fixture-response-1")) break;
      await Bun.sleep(100);
    } while (Date.now() < deadline);
    expect(messages).toContain("fixture-response-1");
    expect(provider.requests).toEqual([
      { sequence: 1, stream: true, model: "deterministic" },
    ]);
  } finally {
    await harness.stop();
    await provider.close();
  }
}, 60_000);

test("concurrent stop and restart leave no process or recreated root", async () => {
  for (const delay of [0, 1, 20, 100]) {
    const harness = await createHarness();
    const previous = harness.process;
    const restarting = harness.restart().then(
      () => undefined,
      () => undefined,
    );
    await Bun.sleep(delay);
    await Promise.all([harness.stop(), restarting]);
    expect(previous.exitCode).not.toBeNull();
    expect(harness.process.exitCode).not.toBeNull();
    expect(existsSync(harness.root)).toBe(false);
    await expect(fetch(`${harness.url}/api/info`)).rejects.toThrow();
  }
}, 90_000);

test("identity fixture is bundled once into private config and survives restart", async () => {
  const harness = await createHarness({ identityPlugin: true });
  try {
    const directory = `${harness.root}/identity-plugin`;
    const artifact = `${directory}/index.js`;
    expect(await Bun.file(`${directory}/package.json`).json()).toEqual({
      name: "identity-private-fixture",
      type: "module",
      exports: { ".": "./index.js" },
    });
    expect(existsSync(artifact)).toBe(true);
    const before = await Bun.file(artifact).text();
    expect(before).toContain("identity-private-fixture");
    const stat = await Bun.file(artifact).stat();
    for (let run = 0; run < 2; run++) {
      const config = await Bun.file(
        `${harness.env.XDG_CONFIG_HOME}/opencode/opencode.json`,
      ).json();
      expect(config.plugins).toEqual([directory]);
      const deadline = Date.now() + 10_000;
      let status: string | undefined;
      do {
        const response = await harness.request(
          `/api/plugin?location[directory]=${encodeURIComponent(`${harness.root}/project`)}`,
        );
        expect(response.status).toBe(200);
        const result = (await response.json()) as {
          data: Array<{
            id: string;
            state: { status: string };
            source: { path?: string };
          }>;
        };
        const plugin = result.data.find(
          (entry) => entry.id === "identity-private-fixture",
        );
        status = plugin?.state.status;
        if (status === "active") {
          expect(plugin?.source.path).toBe(directory);
          break;
        }
        await Bun.sleep(100);
      } while (Date.now() < deadline);
      expect(status).toBe("active");
      if (run === 0) await harness.restart();
    }
    expect((await Bun.file(artifact).stat()).mtimeMs).toBe(stat.mtimeMs);
    expect(await Bun.file(artifact).text()).toBe(before);
  } finally {
    await harness.stop();
  }
}, 90_000);

test("harness restart preserves synthetic session and renews private server", async () => {
  const harness = await createHarness({ schedules: true });
  const original = harness.process;
  const root = harness.root;
  try {
    expect(
      (
        await Bun.file(
          `${harness.env.XDG_CONFIG_HOME}/opencode/opencode.json`,
        ).json()
      ).experimental.schedules,
    ).toBe(true);
    const created = await harness.request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Synthetic restart fixture",
        location: { directory: `${root}/project` },
      }),
    });
    expect(created.status).toBe(200);
    const { data } = (await created.json()) as { data: { id: string } };
    expect(typeof data.id).toBe("string");
    await harness.restart();
    expect(original.exitCode).not.toBeNull();
    expect(harness.process.pid).not.toBe(original.pid);
    expect(harness.root).toBe(root);
    expect(existsSync(harness.env.OPENCODE_DB)).toBe(true);
    const persisted = await harness.request(`/api/session/${data.id}`);
    expect(persisted.status).toBe(200);
    expect(((await persisted.json()) as { data: { id: string } }).data.id).toBe(
      data.id,
    );
    expect((await fetch(`${harness.url}/api/info`)).status).toBe(401);
    expect(() => harness.request("http://example.invalid/api/info")).toThrow();
    const transport: string = "unix";
    expect(() =>
      harness.request("/api/info", { [transport]: "/unrelated/socket" }),
    ).toThrow("Unsupported request option");
  } finally {
    await harness.stop();
    await harness.stop();
  }
  expect(harness.process.exitCode).not.toBeNull();
  expect(existsSync(root)).toBe(false);
  await expect(fetch(`${harness.url}/api/info`)).rejects.toThrow();
  await expect(harness.restart()).rejects.toThrow("stopped");
}, 90_000);

test("T1 revision: creates absent nested base and rejects transport escape", async () => {
  const base = `/tmp/opencode/opencode-sessions-tools/nested-${crypto.randomUUID()}`;
  expect(existsSync(base)).toBe(false);
  const harness = await createHarness({ temporaryBase: `${base}/child` });
  try {
    expect(harness.root.startsWith(`${base}/child/fixture-`)).toBe(true);
    expect(() => harness.request("http://example.invalid/api/info")).toThrow();
    for (const key of ["unix", "s3", "tls", "session", "proxy", "redirect"]) {
      expect(() =>
        harness.request("/api/info", { [key]: "/unrelated/socket" }),
      ).toThrow("Unsupported request option");
    }
    const controller = new AbortController();
    controller.abort();
    await expect(
      harness.request("/api/info", { signal: controller.signal }),
    ).rejects.toThrow();
  } finally {
    await harness.stop();
    await (await import("node:fs/promises")).rm(base, { recursive: true });
  }
  await expect(
    createHarness({ temporaryBase: "/tmp/unapproved" }),
  ).rejects.toThrow("approved");
}, 60_000);

test("T1: isolated server starts, owns its data and terminates", async () => {
  const harness = await createHarness();
  try {
    expect(existsSync(`${harness.root}/operator-plugin`)).toBe(false);
    expect(
      (
        await Bun.file(
          `${harness.env.XDG_CONFIG_HOME}/opencode/opencode.json`,
        ).json()
      ).plugins,
    ).toEqual([]);
    expect(
      harness.root.startsWith("/tmp/opencode/opencode-sessions-tools/fixture-"),
    ).toBe(true);
    expect(new URL(harness.url).hostname).toBe("127.0.0.1");
    expect(harness.env.HOME).toBe(`${harness.root}/home`);
    expect(harness.env.XDG_CONFIG_HOME).toBe(`${harness.root}/config`);
    expect(harness.env.OPENCODE_DB).toBe(`${harness.root}/data/host.db`);
    expect(Object.keys(harness.env).sort()).toEqual(
      [
        "HOME",
        "OPENCODE_DB",
        "PATH",
        "TMPDIR",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
      ].sort(),
    );
    const configResponse = await harness.request("/api/config");
    expect(configResponse.status).toBe(200);
    const config = (await configResponse.json()) as Array<{ path: string }>;
    expect(config.map((entry) => entry.path)).toEqual([
      `${harness.root}/config/opencode/opencode.json`,
      `${harness.root}/config/opencode`,
    ]);
    expect((await fetch(`${harness.url}/api/info`)).status).toBe(401);
    expect(existsSync(harness.env.OPENCODE_DB)).toBe(true);
    const response = await harness.request("/openapi.json");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { openapi: string }).openapi).toMatch(
      /^3\./,
    );
  } finally {
    await harness.stop();
  }
  expect(harness.process.exitCode).not.toBeNull();
  expect(existsSync(harness.root)).toBe(false);
  await expect(fetch(`${harness.url}/openapi.json`)).rejects.toThrow();
}, 60_000);
