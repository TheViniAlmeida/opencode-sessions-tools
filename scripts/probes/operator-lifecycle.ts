import { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import { operatorDigest } from "../../src/authorization/operator-core";
import { canonical } from "../../src/contracts";
import { createHarness } from "../harness";
import { operatorTestMarker } from "./fixtures/operator-plugin";

type Descriptor = {
  state: string;
  pid: number;
  port: number;
  audience: { instanceID: string; epoch: string };
  callbackCount: number;
};
export async function probeOperatorLifecycle() {
  const host = await createHarness({ operatorPlugin: true });
  let stage = "initialize";
  const descriptorPath = `${host.root}/home/operator-channel.json`;
  const location = `?location[directory]=${encodeURIComponent(`${host.root}/project`)}`;
  const persistedCount = () => {
    const db = new Database(`${host.root}/home/operator-synthetic.sqlite`, {
      readonly: true,
    });
    try {
      return db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM synthetic_effects")
        .get()?.n;
    } finally {
      db.close();
    }
  };
  const initialize = async (): Promise<Descriptor> => {
    const response = await host.request(`/api/agent${location}`);
    await response.body?.cancel();
    if (!response.ok || !(await Bun.file(descriptorPath).exists()))
      throw new Error(
        "BLOCKED: harness operatorPlugin fixed bundle option required",
      );
    const descriptor = await Bun.file(descriptorPath).json();
    if (
      descriptor.state !== "active" ||
      !Number.isInteger(descriptor.port) ||
      descriptor.port < 1 ||
      descriptor.port > 65535 ||
      descriptor.pid !== host.process.pid ||
      ((await stat(descriptorPath)).mode & 0o777) !== 0o600
    )
      throw new Error("Operator fixture descriptor invalid");
    return descriptor;
  };
  const raw = (d: Descriptor, key: string) =>
    canonical({
      key,
      intention: {
        instanceID: d.audience.instanceID,
        operatorID: "synthetic-operator",
        projectID: "synthetic-project",
        operation: "synthetic.counter",
        target: { kind: "group", groupID: "synthetic" },
        body: { value: 1 },
      },
    });
  const attempt = (d: Descriptor, body: string) => ({
    projectID: "synthetic-project",
    method: "POST",
    route: "/synthetic",
    operation: "synthetic.counter",
    audience: d.audience,
    timestamp: Date.now(),
    requestBodyHash: operatorDigest(body),
  });
  const post = async (
    d: Descriptor,
    path: string,
    body: string,
    binding: ReturnType<typeof attempt>,
    challenge?: unknown,
  ) => {
    const response = await fetch(`http://127.0.0.1:${d.port}${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(2000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${operatorTestMarker}`,
        "X-Operator-Credential": "fixture",
        "X-Operator-Attempt": JSON.stringify(binding),
        ...(challenge
          ? { "X-Operator-Challenge": JSON.stringify(challenge) }
          : {}),
      },
      body,
    });
    return { status: response.status, payload: await response.json() };
  };
  const closed = async (d: Descriptor) => {
    try {
      await fetch(`http://127.0.0.1:${d.port}/synthetic`, {
        signal: AbortSignal.timeout(1000),
      });
      return false;
    } catch (error) {
      return (error as { code?: string }).code === "ECONNREFUSED";
    }
  };
  const configure = async (disabled: boolean) => {
    const path = `${host.root}/config/opencode/opencode.json`;
    const config = await Bun.file(path).json();
    config.plugins = config.plugins.filter(
      (item: string) => item !== "-operator-private-fixture",
    );
    if (disabled) config.plugins.push("-operator-private-fixture");
    await Bun.write(path, JSON.stringify(config));
  };
  try {
    const first = await initialize();
    const initialCount = persistedCount();
    const body = raw(first, "old-challenge");
    const binding = attempt(first, body);
    stage = "issue-old-challenge";
    const issued = await post(first, "/operator/challenge", "{}", binding);
    if (issued.status !== 200)
      throw new Error("Synthetic challenge issuance failed");
    // A separate, never submitted challenge isolates epoch binding from the
    // obsolete-attempt rejection below. Only audience changes on its attempt.
    stage = "issue-unused-epoch-challenge";
    const epochBody = raw(first, "unused-epoch-challenge");
    const epochBinding = attempt(first, epochBody);
    const epochChallenge = await post(
      first,
      "/operator/challenge",
      "{}",
      epochBinding,
    );
    if (epochChallenge.status !== 200)
      throw new Error("Synthetic unused challenge issuance failed");
    const start = await Bun.file(`/proc/${first.pid}/stat`).text();
    stage = "disable-unload";
    await configure(true);
    let unloaded: Descriptor | undefined;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const value = await Bun.file(descriptorPath).json();
      if (value.state === "unloaded" && (await closed(first))) {
        unloaded = value;
        break;
      }
      await Bun.sleep(50);
    }
    if (!unloaded) throw new Error("Operator unload not observed");
    const unloadedDescriptorMode = (await stat(descriptorPath)).mode & 0o777;
    const unloadedCountPersisted = persistedCount();
    const info = await host.request("/api/info");
    const processStart = (value: string) =>
      value.split(") ")[1]?.split(" ")[19];
    const hostAlive =
      info.ok &&
      Boolean(processStart(start)) &&
      processStart(start) ===
        processStart(await Bun.file(`/proc/${first.pid}/stat`).text());
    await info.body?.cancel();
    stage = "re-enable";
    await configure(false);
    let second: Descriptor | undefined;
    const reloadDeadline = Date.now() + 8000;
    while (Date.now() < reloadDeadline) {
      try {
        const d = await initialize();
        if (d.audience.epoch !== first.audience.epoch) {
          second = d;
          break;
        }
      } catch {
        /* Wait for real host setup. */
      }
      await Bun.sleep(50);
    }
    if (!second) throw new Error("Operator reload not observed");
    const reenabledHostSame =
      second.pid === first.pid &&
      processStart(start) ===
        processStart(await Bun.file(`/proc/${second.pid}/stat`).text());
    stage = "reject-old-challenge";
    const old = await post(
      second,
      "/synthetic",
      body,
      binding,
      issued.payload.value,
    );
    const countAfterOldChallenge = persistedCount();
    stage = "reject-stale-challenge-current-audience";
    const currentAudienceBinding = {
      ...epochBinding,
      audience: second.audience,
    };
    const staleChallenge = await post(
      second,
      "/synthetic",
      epochBody,
      currentAudienceBinding,
      epochChallenge.payload.value,
    );
    const countAfterStaleChallenge = persistedCount();
    const freshBody = raw(second, "new-challenge");
    const freshBinding = attempt(second, freshBody);
    const fresh = await post(second, "/operator/challenge", "{}", freshBinding);
    stage = "fresh-admission";
    const admitted = await post(
      second,
      "/synthetic",
      freshBody,
      freshBinding,
      fresh.payload.value,
    );
    const countBeforeRestart = persistedCount();
    stage = "restart";
    await host.restart();
    const restartedClosed = await closed(second);
    const third = await initialize();
    const countAfterRestart = persistedCount();
    stage = "restart-idempotent-admission";
    const retryBinding = attempt(third, freshBody);
    const retryChallenge = await post(
      third,
      "/operator/challenge",
      "{}",
      retryBinding,
    );
    const retry = await post(
      third,
      "/synthetic",
      freshBody,
      retryBinding,
      retryChallenge.payload.value,
    );
    const countAfterRetry = persistedCount();
    stage = "final-stop";
    const restartEpochChanged = third.audience.epoch !== second.audience.epoch;
    await host.stop();
    return {
      hostVersion: host.version,
      hostAlive,
      reenabledHostSame,
      reenabledEpochChanged: second.audience.epoch !== first.audience.epoch,
      initialCount,
      countAfterOldChallenge,
      unusedEpochChallengeStatus: epochChallenge.status,
      staleChallengeCurrentAudienceStatus: staleChallenge.status,
      staleChallengeUsedCurrentAudience:
        currentAudienceBinding.audience.epoch === second.audience.epoch &&
        currentAudienceBinding.audience.epoch !== first.audience.epoch,
      countAfterStaleChallenge,
      countBeforeRestart,
      countAfterRestart,
      retryChallengeStatus: retryChallenge.status,
      retryStatus: retry.status,
      countAfterRetry,
      restartedDescriptorCount: third.callbackCount,
      unloadedState: unloaded.state,
      unloadedDescriptorMode,
      unloadedCountPersisted,
      unloadedCount: unloaded.callbackCount,
      oldChallengeStatus: old.status,
      freshChallengeStatus: fresh.status,
      admissionStatus: admitted.status,
      restartedClosed,
      restartEpochChanged,
      stoppedClosed: await closed(third),
      rawLogAudit:
        "NOT_VALIDATED: harness discards stderr and post-start stdout",
      productionProvisioningProven: false,
      operationalAllowlistProven: false,
    };
  } catch {
    throw new Error(`Operator lifecycle failed at ${stage}`);
  } finally {
    await host.stop();
  }
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await probeOperatorLifecycle()));
  } catch (error) {
    console.error(
      error instanceof Error &&
        /^Operator lifecycle failed at [a-z-]+$/.test(error.message)
        ? error.message
        : "Operator lifecycle initialization failed",
    );
    process.exitCode = 1;
  }
}
