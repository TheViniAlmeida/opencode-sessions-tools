/** Disposable P0 feasibility harness. Not an OpenCode plugin. */
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { deliveryProviderConfig } from "./probes/fixtures/deterministic-provider";

export const temporaryBase = "/tmp/opencode/opencode-sessions-tools";
export const hostVersion = "opencode v2.2.5";

export async function createHarness(
  options: {
    temporaryBase?: string;
    schedules?: boolean;
    identityPlugin?: boolean;
    operatorPlugin?: boolean;
    deliveryProvider?: { baseURL: string };
  } = {},
) {
  let deliveryConfig: ReturnType<typeof deliveryProviderConfig> | undefined;
  if (options.deliveryProvider) {
    const baseURL = options.deliveryProvider.baseURL;
    if (!/^http:\/\/127\.0\.0\.1:([1-9]\d*)\/v1$/.test(baseURL))
      throw new Error(
        "Invalid delivery provider URL; require http://127.0.0.1:<port>/v1",
      );
    try {
      deliveryConfig = deliveryProviderConfig(baseURL);
    } catch {
      throw new Error(
        "Invalid delivery provider URL; require http://127.0.0.1:<port>/v1",
      );
    }
  }
  const base = resolve(options.temporaryBase ?? temporaryBase);
  if (base !== temporaryBase && !base.startsWith(`${temporaryBase}/`))
    throw new Error("Temporary base must stay inside the approved root");
  try {
    let current = temporaryBase;
    for (const part of [
      "",
      ...relative(temporaryBase, base).split("/").filter(Boolean),
    ]) {
      current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new Error("Symlink temporary base is forbidden");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await mkdir(base, { recursive: true, mode: 0o700 });
  } catch {
    throw new Error(
      `Cannot prepare approved temporary base ${temporaryBase}. Ask the operator to provision this exact directory with ownership for the current user and mode 700; do not select another root.`,
    );
  }
  // Managed config cannot be disabled by HOME/XDG. Refuse it instead of importing it.
  if (existsSync("/etc/opencode"))
    throw new Error("Managed OpenCode config exists; isolation not proven");
  const executable = Bun.which("opencode");
  if (!executable) throw new Error("OpenCode executable missing");
  const binary = executable;
  const root = await mkdtemp(`${base}/fixture-`);
  const env: Record<string, string> = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: `${root}/home`,
    TMPDIR: `${root}/tmp`,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    XDG_CACHE_HOME: `${root}/cache`,
    XDG_STATE_HOME: `${root}/state`,
    OPENCODE_DB: `${root}/data/host.db`,
  };
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let startupTimeout: ReturnType<typeof setTimeout> | undefined;
  let url = "";
  let headers: { Authorization: string } = { Authorization: "" };
  let stopped = false;
  let restarting = false;
  let cleanupPromise: Promise<void> | undefined;
  let lifecycle = Promise.resolve();
  function serialize(operation: () => Promise<void>) {
    const next = lifecycle.then(operation);
    lifecycle = next.catch(() => {});
    return next;
  }
  let removed = false;
  async function removeRoot() {
    if (!removed) {
      await rm(root, { recursive: true, force: true });
      removed = true;
    }
  }
  async function terminate() {
    clearTimeout(startupTimeout);
    if (child) {
      const process = child;
      if (process.exitCode === null) process.kill("SIGTERM");
      const timeout = setTimeout(() => process.kill("SIGKILL"), 5_000);
      try {
        await process.exited;
      } finally {
        clearTimeout(timeout);
      }
    }
    headers = { Authorization: "" };
  }
  function cleanup() {
    if (!cleanupPromise) {
      stopped = true;
      cleanupPromise = serialize(async () => {
        await terminate();
        await removeRoot();
      });
    }
    return cleanupPromise;
  }
  try {
    await Promise.all(
      Object.values(env)
        .filter((path) => path.startsWith(root) && !path.endsWith(".db"))
        .map((path) => mkdir(path, { recursive: true })),
    );
    const cwd = `${root}/project`;
    await mkdir(cwd);
    await mkdir(`${env.XDG_CONFIG_HOME}/opencode`);
    const plugins: string[] = [];
    async function bundleFixedPlugin(kind: "identity" | "operator") {
      const directory = `${root}/${kind}-plugin`;
      const artifact = `${directory}/index.js`;
      const result = await Bun.build({
        entrypoints: [resolve(`scripts/probes/fixtures/${kind}-plugin.ts`)],
        target: "bun",
        format: "esm",
        packages: "bundle",
        env: "disable",
      });
      if (!result.success || result.outputs.length !== 1)
        throw new Error("Fixed plugin fixture bundle failed");
      await mkdir(directory);
      await Bun.write(artifact, result.outputs[0]);
      await writeFile(
        `${directory}/package.json`,
        JSON.stringify({
          name: `${kind}-private-fixture`,
          type: "module",
          exports: { ".": "./index.js" },
        }),
      );
      plugins.push(directory);
    }
    if (options.identityPlugin) await bundleFixedPlugin("identity");
    if (options.operatorPlugin === true) await bundleFixedPlugin("operator");
    await writeFile(
      `${env.XDG_CONFIG_HOME}/opencode/opencode.json`,
      JSON.stringify({
        providers: {},
        ...deliveryConfig,
        plugins,
        mcp: {},
        ...(options.schedules ? { experimental: { schedules: true } } : {}),
      }),
    );
    const versionResult = Bun.spawnSync([executable, "--version"], {
      env,
      cwd,
    });
    const version = versionResult.stdout.toString().trim();
    if (versionResult.exitCode !== 0 || version !== hostVersion)
      throw new Error(`Unsupported host baseline: ${version}`);
    async function launch() {
      const reservation = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(),
      });
      const port = reservation.port;
      reservation.stop(true);
      url = `http://127.0.0.1:${port}`;
      child = Bun.spawn(
        [binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)],
        { env, cwd, stdout: "pipe", stderr: "ignore" },
      );
      const process = child;
      startupTimeout = setTimeout(() => process.kill("SIGKILL"), 30_000);
      const reader = (process.stdout as ReadableStream<Uint8Array>).getReader();
      let startup = "";
      while (
        !startup.includes("server password ") ||
        !startup.split("server password ")[1]?.includes("\n")
      ) {
        const chunk = await reader.read();
        if (chunk.done)
          throw new Error("Server did not provide ephemeral authentication");
        startup += new TextDecoder().decode(chunk.value);
      }
      const password = startup
        .split("server password ")[1]
        ?.split("\n")[0]
        ?.trim();
      clearTimeout(startupTimeout);
      headers = { Authorization: `Basic ${btoa(`opencode:${password}`)}` };
      startup = "";
      void (async () => {
        try {
          while (!(await reader.read()).done) {
            /* Discard all later output. */
          }
        } catch {
          /* Process shutdown closes stdout. */
        }
      })();
      const deadline = Date.now() + 30_000;
      while (true) {
        if (process.exitCode !== null)
          throw new Error(`Isolated server exited: ${process.exitCode}`);
        try {
          const response = await fetch(`${url}/api/info`, {
            headers,
            signal: AbortSignal.timeout(500),
          });
          if (response.ok) break;
        } catch {
          /* Socket is not ready yet. */
        }
        if (Date.now() >= deadline)
          throw new Error("Isolated server readiness timed out");
        await Bun.sleep(100);
      }
    }
    await launch();
    return {
      root,
      env,
      get url() {
        return url;
      },
      version,
      get process() {
        if (!child) throw new Error("Isolated server has not launched");
        return child;
      },
      stop: cleanup,
      restart: async () => {
        if (stopped) throw new Error("Harness is stopped");
        if (restarting) throw new Error("Harness restart already in progress");
        restarting = true;
        return serialize(async () => {
          try {
            await terminate();
            if (stopped) throw new Error("Harness is stopped");
            await launch();
            if (stopped) {
              await terminate();
              throw new Error("Harness is stopped");
            }
          } catch (error) {
            stopped = true;
            await terminate();
            await removeRoot();
            throw error;
          } finally {
            restarting = false;
          }
        });
      },
      request: (path: string, init: RequestInit = {}) => {
        if (stopped || restarting)
          throw new Error("Harness is stopped or restarting");
        for (const key of Object.keys(init)) {
          if (!["method", "body", "headers", "signal"].includes(key))
            throw new Error(`Unsupported request option: ${key}`);
        }
        const target = new URL(path, url);
        if (target.origin !== url || !path.startsWith("/"))
          throw new Error("Harness requests must stay on the isolated server");
        const requestHeaders = new Headers(init.headers);
        for (const [key, value] of Object.entries(headers))
          requestHeaders.set(key, value);
        return fetch(target, {
          method: init.method,
          body: init.body,
          headers: requestHeaders,
          redirect: "error",
          signal: AbortSignal.any([
            AbortSignal.timeout(5_000),
            ...(init.signal ? [init.signal] : []),
          ]),
        });
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
