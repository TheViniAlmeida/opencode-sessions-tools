import { beforeAll, describe, expect, test } from "bun:test";
import { runSchedulesProbe } from "../../scripts/probes/schedules";

type RuntimeState = {
  status: number;
  body: {
    message: string;
    data: {
      status: string;
      runCount: number;
      remainingRuns: number;
      lastOutcome: string;
      lastFiredAt: number;
      time: { created: number };
    };
  };
};
type RuntimeEvidence = {
  onceCreated: RuntimeState;
  onceObserved: boolean;
  onceSettled: boolean;
  onceFinal: RuntimeState;
  minimumInterval: RuntimeState;
  barrierEntered: boolean;
  requestsDuringHold: number;
  whileHeld: RuntimeState;
  busyFinal: RuntimeState[];
  intervalRequests: number;
  recurrenceCreated: RuntimeState;
  recurrenceFinal: RuntimeState;
  recurrenceSettled: boolean;
};

describe("T6 enabled native schedule contract, not full product acceptance", () => {
  let evidence: Awaited<ReturnType<typeof runSchedulesProbe>>;
  beforeAll(async () => {
    evidence = await runSchedulesProbe();
  }, 145_000);

  test("enabled fixture serves baseline and six operations", () => {
    expect(evidence.serverVersion).toBe("2.2.5");
    expect(evidence.operations).toHaveLength(6);
    expect(evidence.enabled.createStatus).toBe(200);
    expect(evidence.verdict).toBe("PARTIAL_RUNTIME");
  });
  test("create/list/get return the owned schedule", () => {
    const created = evidence.enabled.create.data;
    expect(evidence.enabled.listStatus).toBe(200);
    expect(evidence.enabled.list.data).toContainEqual(created);
    expect(evidence.lifecycle.get?.body.data.id).toBe(created.id);
    expect(evidence.lifecycle.get?.body.data.nextDueAt).toBe(created.nextDueAt);
    expect(created.runCount).toBe(0);
    expect(created.nextDueAt - created.time.created).toBe(365 * 86400000);
  });
  test("pause/resume transitions persist across independent HTTP reads", () => {
    for (const operation of ["pause", "paused", "resume", "resumed"])
      expect(evidence.lifecycle[operation]?.status).toBe(200);
    expect(evidence.lifecycle.paused?.body.data.status).toBe("paused");
    expect(evidence.lifecycle.resumed?.body.data.status).toBe("active");
    expect(evidence.lifecycle.resumed?.body.data.runCount).toBe(0);
  });
  test("cancel deletes the future job, not an already admitted execution", () => {
    expect(evidence.lifecycle.cancel?.status).toBe(204);
    expect(evidence.lifecycle.afterCancel?.status).toBe(404);
    expect(evidence.lifecycle.afterCancel?.body._tag).toBe(
      "ScheduleNotFoundError",
    );
  });
  test("interval and IANA cron are accepted with calculated initial deadline", () => {
    const interval = evidence.validation.find(
      (item) => item.name === "interval",
    );
    const cron = evidence.validation.find((item) => item.name === "cronIANA");
    expect(interval?.status).toBe(200);
    expect(interval?.body.data.remainingRuns).toBe(2);
    expect(
      interval?.body.data.nextDueAt - interval?.body.data.time.created,
    ).toBe(365 * 86400000);
    expect(cron?.status).toBe(200);
    expect(cron?.body.data.tz).toBe("America/New_York");
    const local = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(cron?.body.data.nextDueAt);
    expect(local).toBe("01/01, 00:00");
  });
  test("eight malformed timing/limit/prompt cases are rejected before execution", () => {
    const invalid = evidence.validation.filter(
      (item) =>
        !["interval", "cronIANA", "rpcTarget", "toolTarget"].includes(
          item.name,
        ),
    );
    expect(invalid).toHaveLength(8);
    for (const item of invalid) {
      expect(item.status).toBe(400);
      expect(item.body._tag).toBe("InvalidRequestError");
    }
  });
  test("config projection omits enabled flag; pending guarantees do not select a backend", () => {
    expect(evidence.config.schedules).toBeNull();
    expect(evidence.config.patchProperties).toEqual(["shell"]);
    expect(evidence.backendDecision).toBe(
      "own-scheduler-authorize-outbox-before-host-prompt",
    );
    expect(evidence.runtimeProven).toBe(true);
    expect(evidence.productSchedulerEnabled).toBe(false);
    expect(evidence.notValidated).toContain("overdue restart/catch-up");
    expect(evidence.executableConditionsTested).toBe(false);
  });
  test("future job and session survive process restart without deadline or count changes", () => {
    const created = evidence.enabled.create.data;
    expect(evidence.persistence.get?.status).toBe(200);
    expect(evidence.persistence.get?.body.data).toEqual(created);
    expect(evidence.persistence.list?.status).toBe(200);
    expect(evidence.persistence.list?.body.data).toContainEqual(created);
    expect(evidence.persistence.session?.status).toBe(200);
    expect(evidence.persistence.session?.body.data.id).toBe(created.sessionID);
  });
  test("short native timer dispatches to local provider and consumes its single run", () => {
    const runtime = evidence.execution as RuntimeEvidence;
    expect(runtime.onceCreated.status).toBe(200);
    expect(runtime.onceObserved).toBe(true);
    expect(runtime.onceSettled).toBe(true);
    expect(runtime.onceFinal.body.data.runCount).toBe(1);
    expect(runtime.onceFinal.body.data.remainingRuns).toBe(0);
    expect(runtime.onceFinal.body.data.lastOutcome).toBe("fired");
    expect(runtime.minimumInterval.status).toBe(400);
    expect(runtime.minimumInterval.body.message).toBe(
      "every must be at least 1 minute",
    );
  });
  test("busy session admits jobs without parallel provider calls; fired is not completion", () => {
    const runtime = evidence.execution as RuntimeEvidence;
    expect(runtime.barrierEntered).toBe(true);
    expect(runtime.requestsDuringHold).toBe(1);
    expect(runtime.whileHeld.body.data.status).toBe("done");
    expect(runtime.busyFinal).toHaveLength(2);
    for (const job of runtime.busyFinal) {
      expect(job.status).toBe(200);
      expect(job.body.data.runCount).toBe(1);
      expect(job.body.data.lastOutcome).toBe("fired");
    }
    expect(runtime.intervalRequests).toBeGreaterThanOrEqual(2);
  });
  test("one-minute recurrence fires twice and ends at its configured run limit", () => {
    const runtime = evidence.execution as RuntimeEvidence;
    expect(runtime.recurrenceCreated.status).toBe(200);
    expect(runtime.recurrenceSettled).toBe(true);
    expect(runtime.recurrenceFinal.body.data.runCount).toBe(2);
    expect(runtime.recurrenceFinal.body.data.remainingRuns).toBe(0);
    expect(runtime.recurrenceFinal.body.data.status).toBe("done");
    const elapsed =
      runtime.recurrenceFinal.body.data.lastFiredAt -
      runtime.recurrenceCreated.body.data.time.created;
    expect(elapsed).toBeGreaterThanOrEqual(120000);
    expect(elapsed).toBeLessThan(125000);
  });
  test("public action contract has no callback target", () => {
    expect(evidence.contract.createAdditionalProperties).toBe(false);
    expect(evidence.contract.createProperties).not.toContain("action");
    expect(evidence.contract.createProperties).not.toContain("tool");
    expect(evidence.contract.action).toEqual({
      anyOf: [{ $ref: "#/components/schemas/Schedule.Action.Prompt" }],
    });
    for (const name of ["rpcTarget", "toolTarget"]) {
      const result = evidence.validation.find((item) => item.name === name);
      expect(result?.status).toBe(200);
      expect(result?.body.data.action.type).toBe("prompt");
      expect(result?.body.data.action.prompt).toBe(
        "T6 synthetic never-due prompt",
      );
    }
  });
  test("paused state survives second restart and cancellation survives third restart", () => {
    expect(evidence.persistence.pause?.status).toBe(200);
    expect(evidence.persistence.pausedAfterRestart?.status).toBe(200);
    expect(evidence.persistence.pausedAfterRestart?.body.data.status).toBe(
      "paused",
    );
    expect(evidence.persistence.pausedAfterRestart?.body.data.runCount).toBe(0);
    expect(evidence.persistence.resume?.status).toBe(200);
    expect(evidence.persistence.deletedAfterRestart?.status).toBe(404);
    expect(evidence.persistence.deletedAfterRestart?.body._tag).toBe(
      "ScheduleNotFoundError",
    );
    expect(evidence.persistence.listAfterCancel?.status).toBe(200);
    expect(evidence.persistence.listAfterCancel?.body.data).toEqual([]);
  });
});
