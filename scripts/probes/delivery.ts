/** T4 admission evidence only. Never resumes a model or retries an uncertain write. */
import { createHarness } from "../harness";
import { createDeterministicProvider } from "./fixtures/deterministic-provider";
import { parseSSE } from "./usage";

export type DeliveryOutcome = "admitted" | "completed" | "failed" | "unknown";

export function deliveryOutcome(evidence: {
  receipt?: boolean;
  completed?: boolean;
  failed?: boolean;
}): DeliveryOutcome {
  if (evidence.failed) return "failed";
  if (evidence.completed) return "completed";
  return evidence.receipt ? "admitted" : "unknown";
}

type InboxItem = {
  id: string;
  sessionID: string;
  delivery: string;
  payload: { metadata?: { correlation?: string } };
};

export async function runDeliveryProbe() {
  const host = await createHarness();
  try {
    const post = (path: string, body: unknown) =>
      host.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const read = async (path: string) => {
      const response = await host.request(path);
      if (!response.ok) throw new Error(`T4 read failed: ${response.status}`);
      return (await response.json()).data;
    };
    const created = await post("/api/session", {
      location: { directory: host.root },
      title: "T4 synthetic admission fixture",
    });
    if (!created.ok) throw new Error(`T4 create failed: ${created.status}`);
    const sessionID: string = (await created.json()).data.id;
    const path = `/api/session/${sessionID}`;
    const correlation = `t4-${crypto.randomUUID()}`;
    const cases: {
      id: string;
      delivery: "queue" | "steer";
      status: number;
      outcome: DeliveryOutcome;
      correlationPreserved: boolean;
    }[] = [];
    for (const delivery of ["queue", "queue", "steer"] as const) {
      const id = `msg_t4${crypto.randomUUID().replaceAll("-", "")}`;
      const body = {
        id,
        text: "T4 synthetic request; do not execute",
        metadata: { correlation },
        delivery,
        resume: false,
      };
      const response = await post(`${path}/prompt`, body);
      const receipt = response.ok ? (await response.json()).data : null;
      cases.push({
        id,
        delivery,
        status: response.status,
        outcome: deliveryOutcome({ receipt: receipt?.id === id }),
        correlationPreserved:
          receipt?.payload?.metadata?.correlation === correlation,
      });
    }
    const notificationID = `msg_t4${crypto.randomUUID().replaceAll("-", "")}`;
    const notification = await post(`${path}/synthetic`, {
      id: notificationID,
      text: "T4 notification without wake",
      delivery: "queue",
      resume: false,
      metadata: { correlation },
    });
    await notification.arrayBuffer();

    // A loopback proxy forwards one write, then withholds its response until the
    // caller times out. The host reply is not exposed to the caller/reconciler.
    const uncertainID = `msg_t4${crypto.randomUUID().replaceAll("-", "")}`;
    let writes = 0;
    let forwarded = false;
    let release: (() => void) | undefined;
    let signalForwarded: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      signalForwarded = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        writes++;
        const response = await post(`${path}/prompt`, {
          id: uncertainID,
          text: "T4 lost response fixture",
          delivery: "queue",
          resume: false,
          metadata: { correlation },
        });
        await response.arrayBuffer();
        forwarded = true;
        signalForwarded?.();
        await held;
        return new Response(null, { status: 204 });
      },
    });
    const controller = new AbortController();
    const bounded = setTimeout(() => controller.abort(), 4_500);
    let timedOut = false;
    try {
      const attempt = fetch(`http://127.0.0.1:${proxy.port}`, {
        method: "POST",
        signal: controller.signal,
      }).catch(() => {
        timedOut = true;
      });
      await Promise.race([ready, attempt]);
      // Abort after forwarding models loss of the response, not failure to send.
      controller.abort(
        new DOMException("Injected response timeout", "TimeoutError"),
      );
      await attempt;
    } finally {
      clearTimeout(bounded);
      release?.();
      proxy.stop(true);
    }
    const inbox: InboxItem[] = await read(`${path}/inbox`);
    const messages = await read(`${path}/message`);
    const session = await read(path);
    const log = await host.request(
      `/api/experimental/session/${sessionID}/log?follow=false`,
    );
    const events = parseSSE(await log.text()).map(
      (entry) => entry.data as { type?: string },
    );
    const reconciled = inbox.filter(
      (item) => item.id === uncertainID && item.sessionID === sessionID,
    );
    await host.restart();
    const persisted: InboxItem[] = await read(`${path}/inbox`);
    return {
      state: "partial" as const,
      baseline: host.version,
      cases,
      notification: {
        status: notification.status,
        present: inbox.some((item) => item.id === notificationID),
        executionStarted: events.some(
          (event) => event.type === "session.execution.started",
        ),
        historyCount: messages.length,
        busy: session.time.busy !== undefined,
      },
      fifo: {
        admissionOrderPreserved:
          inbox
            .filter((item) => cases.some((entry) => entry.id === item.id))
            .map((item) => item.id)
            .join() === cases.map((item) => item.id).join(),
        consumptionProven: false,
      },
      timeout: {
        injected: timedOut && forwarded,
        beforeReconciliation: deliveryOutcome({}),
        afterReconciliation: deliveryOutcome({
          receipt: reconciled.length === 1,
        }),
        writes,
        matchingItems: reconciled.length,
        correlationPreserved:
          reconciled[0]?.payload.metadata?.correlation === correlation,
        restartMatches: persisted.filter((item) => item.id === uncertainID)
          .length,
      },
      limits: {
        busyProven: false,
        completionProven: false,
        pluginIdempotencyProven: false,
        providerExecutionAttempted: false,
      },
    };
  } finally {
    await host.stop();
  }
}

if (import.meta.main)
  console.log(
    JSON.stringify(
      {
        admission: await runDeliveryProbe(),
        runtime: await runDeliveryRuntimeProbe(),
      },
      null,
      2,
    ),
  );

/** Bounded host observations; mock receipt alone is never counted as busy. */
export async function runDeliveryRuntimeProbe() {
  const fixture = createDeterministicProvider();
  const host = await createHarness({
    deliveryProvider: { baseURL: fixture.baseURL },
  }).catch(async (error) => {
    await fixture.close();
    throw error;
  });
  try {
    const post = async (path: string, body: unknown) => {
      const response = await host.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Runtime admission ${response.status}`);
      return (await response.json()).data;
    };
    const read = async (path: string) =>
      (await (await host.request(path)).json()).data;
    const wait = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if (await check()) return true;
        await Bun.sleep(20);
      }
      return false;
    };
    const created = await post("/api/session", {
      location: { directory: host.root },
      title: "T4 runtime synthetic",
    });
    const path = `/api/session/${created.id}`;
    const barrier = fixture.holdNext();
    const initial = await post(`${path}/prompt`, {
      text: "synthetic initial",
      delivery: "queue",
    });
    const hostBusy = await wait(async () =>
      Boolean((await read(path)).time.busy),
    );
    const correlation = `runtime-${crypto.randomUUID()}`;
    const admitted: InboxItem[] = [];
    for (const [text, delivery] of [
      ["synthetic queue 1", "queue"],
      ["synthetic queue 2", "queue"],
      ["synthetic steer", "steer"],
    ]) {
      admitted.push(
        await post(`${path}/prompt`, {
          text,
          delivery,
          resume: false,
          metadata: { correlation },
        }),
      );
    }
    const notification = await post(`${path}/synthetic`, {
      text: "synthetic notification",
      delivery: "queue",
      resume: false,
    });
    const heldInbox = await read(`${path}/inbox`);
    const heldMessages = await read(`${path}/message`);
    barrier.release();
    const completed = await wait(async () =>
      (await read(`${path}/message`)).some(
        (m: { type: string; outcome?: string }) =>
          m.type === "idle" && m.outcome === "succeeded",
      ),
    );
    const messages = await read(`${path}/message`);
    const remaining = await read(`${path}/inbox`);
    const orderedIDs = messages
      .filter(
        (m: { type: string }) => m.type === "user" || m.type === "synthetic",
      )
      .reverse()
      .map((m: { id: string }) => m.id);
    const idle = await post("/api/session", {
      location: { directory: host.root },
      title: "T4 idle resume control",
    });
    const idlePath = `/api/session/${idle.id}`;
    const beforeCalls = fixture.requests.length;
    const sleeping = await post(`${idlePath}/synthetic`, {
      text: "synthetic idle notification",
      resume: false,
    });
    const idleHistory = await read(`${idlePath}/message`);
    const idleSession = await read(idlePath);
    const noWake =
      fixture.requests.length === beforeCalls &&
      idleHistory.length === 0 &&
      !idleSession.time.busy;
    await post(`${idlePath}/prompt`, {
      text: "synthetic explicit wake",
      resume: true,
    });
    const resumed = await wait(async () =>
      (await read(`${idlePath}/message`)).some(
        (m: { type: string; outcome?: string }) =>
          m.type === "idle" && m.outcome === "succeeded",
      ),
    );
    const resumedMessages = await read(`${idlePath}/message`);
    const failed = await post("/api/session", {
      location: { directory: host.root },
      title: "T4 failure runtime",
    });
    const failedPath = `/api/session/${failed.id}`;
    fixture.failNext();
    await post(`${failedPath}/prompt`, {
      text: "synthetic deterministic failure",
      resume: true,
    });
    const failedObserved = await wait(async () =>
      (await read(`${failedPath}/message`)).some(
        (m: { type: string; outcome?: string }) =>
          m.type === "idle" && m.outcome === "failed",
      ),
    );
    const failedMessages = await read(`${failedPath}/message`);
    return {
      hostBusy,
      initialID: initial.id,
      admitted: admitted.map((item) => ({
        id: item.id,
        delivery: item.delivery,
        correlation: item.payload.metadata?.correlation,
      })),
      heldInbox,
      heldMessages,
      notificationID: notification.id,
      completed,
      messages,
      remaining,
      orderedIDs,
      noWake,
      resumed,
      resumedNotificationInHistory: resumedMessages.some(
        (m: { id: string }) => m.id === sleeping.id,
      ),
      failedObserved,
      failedMessages,
      providerCalls: fixture.requests.length,
      productFIFOProven: false,
    };
  } finally {
    await host.stop();
    await fixture.close();
  }
}
