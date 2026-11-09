/** T6 capability experiment. Never enables executable schedule conditions. */
import { createHarness } from "../harness";
import { createDeterministicProvider } from "./fixtures/deterministic-provider";

export async function runSchedulesProbe() {
  const provider = createDeterministicProvider({ deadlineMs: 4500 });
  const host = await createHarness({
    schedules: true,
    deliveryProvider: { baseURL: provider.baseURL },
  }).catch(async (error) => {
    await provider.close();
    throw error;
  });
  let sessionID: string | undefined;
  const ownedSchedules = new Set<string>();
  async function call(path: string, method = "GET", body?: unknown) {
    const response = await host.request(path, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  try {
    const info = await (await host.request("/api/info")).json();
    const schema = await (await host.request("/openapi.json")).json();
    const schemas = schema.components.schemas;
    const operations = Object.entries(schema.paths)
      .filter(([path]) => path.includes("/schedule"))
      .flatMap(([path, methods]) =>
        Object.entries(methods as Record<string, { operationId: string }>).map(
          ([method, operation]) => ({
            path,
            method,
            id: operation.operationId,
          }),
        ),
      );
    const created = await call("/api/session", "POST", {
      title: "T6 synthetic schedule target",
      location: { directory: `${host.root}/project` },
    });
    if (created.status !== 200 || !created.body?.data?.id)
      throw new Error(
        `Synthetic session create failed: HTTP ${created.status}`,
      );
    sessionID = created.body.data.id;
    const config = await call(
      `/api/config?location[directory]=${encodeURIComponent(`${host.root}/project`)}`,
    );
    const payload = {
      sessionID,
      prompt: "T6 synthetic never-due prompt",
      when: { in: "365 days", tz: "America/Belem" },
    };
    const creation = await call("/api/experimental/schedule", "POST", payload);
    if (creation.status === 200 && creation.body?.data?.id)
      ownedSchedules.add(creation.body.data.id);
    const listing = await call(
      `/api/experimental/schedule?sessionID=${sessionID}`,
    );
    const lifecycle: Record<string, Awaited<ReturnType<typeof call>>> = {};
    const persistence: Record<string, Awaited<ReturnType<typeof call>>> = {};
    const id = creation.body?.data?.id;
    if (creation.status === 200 && id) {
      await host.restart();
      persistence.get = await call(`/api/experimental/schedule/${id}`);
      persistence.list = await call(
        `/api/experimental/schedule?sessionID=${sessionID}`,
      );
      persistence.session = await call(`/api/session/${sessionID}`);
      persistence.pause = await call(
        `/api/experimental/schedule/${id}/pause`,
        "POST",
      );
      await host.restart();
      persistence.pausedAfterRestart = await call(
        `/api/experimental/schedule/${id}`,
      );
      persistence.resume = await call(
        `/api/experimental/schedule/${id}/resume`,
        "POST",
      );
      for (const [name, path, method] of [
        ["get", `/api/experimental/schedule/${id}`, "GET"],
        ["pause", `/api/experimental/schedule/${id}/pause`, "POST"],
        ["paused", `/api/experimental/schedule/${id}`, "GET"],
        ["resume", `/api/experimental/schedule/${id}/resume`, "POST"],
        ["resumed", `/api/experimental/schedule/${id}`, "GET"],
        ["cancel", `/api/experimental/schedule/${id}`, "DELETE"],
        ["afterCancel", `/api/experimental/schedule/${id}`, "GET"],
      ] as const)
        lifecycle[name] = await call(path, method);
      ownedSchedules.delete(id);
      await host.restart();
      persistence.deletedAfterRestart = await call(
        `/api/experimental/schedule/${id}`,
      );
      persistence.listAfterCancel = await call(
        `/api/experimental/schedule?sessionID=${sessionID}`,
      );
    }
    const cases = [
      { name: "interval", when: { every: "365 days" }, ends: { times: 2 } },
      { name: "cronIANA", when: { cron: "0 0 1 1 *", tz: "America/New_York" } },
      { name: "invalidCron", when: { cron: "not a cron" } },
      { name: "invalidZone", when: { cron: "0 0 1 1 *", tz: "Invalid/Zone" } },
      { name: "invalidInterval", when: { every: "not a duration" } },
      { name: "zeroInterval", when: { every: "0 seconds" } },
      { name: "negativeInterval", when: { every: "-1 days" } },
      { name: "multipleTimers", when: { in: "365 days", every: "365 days" } },
      { name: "invalidLimit", when: { in: "365 days" }, ends: { times: 0 } },
      { name: "emptyPrompt", when: { in: "365 days" }, prompt: "" },
      {
        name: "rpcTarget",
        when: { in: "365 days" },
        action: { type: "rpc", method: "synthetic" },
      },
      { name: "toolTarget", when: { in: "365 days" }, tool: "synthetic" },
    ];
    const validation = [];
    for (const sample of cases) {
      const { name, ...input } = sample;
      const result = await call("/api/experimental/schedule", "POST", {
        ...payload,
        ...input,
      });
      const scheduleID = result.body?.data?.id;
      if (scheduleID) {
        ownedSchedules.add(scheduleID);
        await call(`/api/experimental/schedule/${scheduleID}`, "DELETE");
        ownedSchedules.delete(scheduleID);
      }
      validation.push({ name, ...result });
    }
    const execution: Record<string, unknown> = {};
    async function waitFor(
      predicate: () => Promise<boolean>,
      milliseconds = 7000,
    ) {
      const deadline = Date.now() + milliseconds;
      do {
        if (await predicate()) return true;
        await Bun.sleep(50);
      } while (Date.now() < deadline);
      return false;
    }
    async function runtimeJob(when: unknown, times: number) {
      const result = await call("/api/experimental/schedule", "POST", {
        ...payload,
        when,
        ends: { times },
      });
      const jobID = result.body?.data?.id;
      if (jobID) ownedSchedules.add(jobID);
      return { ...result, jobID };
    }
    const before = provider.requests.length;
    const once = await runtimeJob({ in: "1 second" }, 1);
    execution.onceCreated = once;
    if (once.jobID) {
      execution.onceObserved = await waitFor(
        async () => provider.requests.length > before,
      );
      execution.onceSettled = await waitFor(async () => {
        const state = await call(`/api/experimental/schedule/${once.jobID}`);
        return state.body?.data?.status === "done";
      });
      execution.onceFinal = await call(
        `/api/experimental/schedule/${once.jobID}`,
      );
    }
    execution.minimumInterval = await runtimeJob({ every: "1 second" }, 2);
    const barrier = provider.holdNext();
    const intervalBefore = provider.requests.length;
    const recurring = await runtimeJob({ in: "1 second" }, 1);
    execution.intervalCreated = recurring;
    if (recurring.jobID) {
      const entered = await waitFor(
        async () => provider.requests.length > intervalBefore,
        3500,
      );
      execution.barrierEntered = entered;
      if (entered) {
        execution.busyJobs = await Promise.all([
          runtimeJob({ in: "1 second" }, 1),
          runtimeJob({ in: "1 second" }, 1),
        ]);
        await Bun.sleep(2200);
        execution.requestsDuringHold =
          provider.requests.length - intervalBefore;
        execution.whileHeld = await call(
          `/api/experimental/schedule/${recurring.jobID}`,
        );
      }
      barrier.release();
      execution.intervalSettled = await waitFor(async () => {
        const state = await call(
          `/api/experimental/schedule/${recurring.jobID}`,
        );
        return state.body?.data?.status === "done";
      });
      execution.intervalFinal = await call(
        `/api/experimental/schedule/${recurring.jobID}`,
      );
      await waitFor(
        async () => provider.requests.length >= intervalBefore + 2,
        2000,
      );
      execution.busyFinal = await Promise.all(
        ((execution.busyJobs as { jobID: string }[] | undefined) ?? []).map(
          (job) => call(`/api/experimental/schedule/${job.jobID}`),
        ),
      );
      execution.intervalRequests = provider.requests.length - intervalBefore;
    } else barrier.release();
    execution.totalProviderRequests = provider.requests.length;
    const recurrence = await runtimeJob({ every: "1 minute" }, 2);
    execution.recurrenceCreated = recurrence;
    if (recurrence.jobID) {
      const started = Date.now();
      execution.recurrenceSettled = await waitFor(async () => {
        const state = await call(
          `/api/experimental/schedule/${recurrence.jobID}`,
        );
        return state.body?.data?.status === "done";
      }, 125000);
      execution.recurrenceElapsedMs = Date.now() - started;
      execution.recurrenceFinal = await call(
        `/api/experimental/schedule/${recurrence.jobID}`,
      );
      execution.providerRequestsAfterRecurrence = provider.requests.length;
    }
    return {
      baseline: host.version,
      serverVersion: info.version,
      operations,
      config: {
        status: config.status,
        schedules: config.body?.data?.experimental?.schedules ?? null,
        patchProperties: Object.keys(schemas["Config.Patch"].properties),
        patchAdditionalProperties: schemas["Config.Patch"].additionalProperties,
      },
      contract: {
        createProperties: Object.keys(
          schemas["Schedule.CreatePayload"].properties,
        ),
        createAdditionalProperties:
          schemas["Schedule.CreatePayload"].additionalProperties,
        action: schemas["Schedule.Action"],
        whenAlternatives: schemas["Schedule.WhenInput"].anyOf.map(
          (variant: { required: string[] }) => variant.required,
        ),
        endsProperties: Object.keys(schemas["Schedule.Ends"].properties),
        statusValues: schemas["Schedule.Status"].enum,
        resumeDescription:
          schema.paths["/api/experimental/schedule/{scheduleID}/resume"].post
            .description,
      },
      enabled: {
        createStatus: creation.status,
        create: creation.body,
        listStatus: listing.status,
        list: listing.body,
      },
      lifecycle,
      persistence,
      execution,
      validation,
      verdict:
        creation.status === 200 ? "PARTIAL_RUNTIME" : "BLOCKED_ENABLED_FLAG",
      backendDecision: "own-scheduler-authorize-outbox-before-host-prompt",
      productSchedulerEnabled: false,
      runtimeProven: execution.onceObserved === true,
      notValidated: [
        "overdue restart/catch-up",
        "anchored interval/no drift",
        "cron IANA/DST gap and fold",
        "busy target/coalescing",
        "grant revocation/run limits/leases",
      ],
      executableConditionsTested: false,
    };
  } finally {
    try {
      for (const id of ownedSchedules)
        await call(`/api/experimental/schedule/${id}`, "DELETE");
      if (sessionID) await call(`/api/session/${sessionID}`, "DELETE");
    } finally {
      try {
        await host.stop();
      } finally {
        await provider.close();
      }
    }
  }
}

if (import.meta.main)
  console.log(JSON.stringify(await runSchedulesProbe(), null, 2));
