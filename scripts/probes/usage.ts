/** T8 evidence only: no provider calls, accounting service or budget enforcement. */
import { createHarness } from "../harness";
import { fixture, importPath } from "./portability";

export function metric(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? { value, quality: "synthetic_import" as const }
    : { value: null, quality: "unavailable" as const };
}

export function parseSSE(text: string) {
  return text.split(/\r?\n\r?\n/).flatMap((frame) => {
    const lines = frame.split(/\r?\n/);
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return [];
    let value: unknown = data;
    try {
      value = JSON.parse(data);
    } catch {
      /* Encoded transport may contain text. */
    }
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        /* Keep transport string. */
      }
    }
    return [
      {
        id:
          lines
            .find((line) => line.startsWith("id:"))
            ?.slice(3)
            .trim() ?? null,
        data: value,
      },
    ];
  });
}

export async function runUsageProbe() {
  const host = await createHarness();
  try {
    const read = async (path: string) => {
      const response = await host.request(path);
      return {
        status: response.status,
        data: response.ok ? (await response.json()).data : null,
      };
    };
    const schema = await (await host.request("/openapi.json")).json();
    const statsPath =
      "/api/experimental/session/stats?from=1794009600000&to=1794182400000&timezone=America%2FBelem&tools=none";
    const before = await read(statsPath);
    const cases = [];
    for (const known of [true, false]) {
      const id = `ses_t8${crypto.randomUUID().replaceAll("-", "")}`;
      const transfer = fixture(id);
      const now = Date.parse("2026-11-07T12:00:00Z");
      transfer.info.location = { directory: host.root };
      transfer.info.time = { created: now, updated: now + 1000 };
      transfer.info.cost = known ? 0.125 : 0;
      transfer.info.tokens = {
        input: known ? 101 : 0,
        output: known ? 17 : 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      };
      transfer.messages = [
        {
          id: `msg_${id.slice(4)}`,
          type: "assistant",
          agent: "build",
          model: { providerID: "synthetic", id: "fixture" },
          time: { created: now, completed: now + 1000 },
          content: [{ type: "text", text: "T8 synthetic usage fixture" }],
          ...(known ? { cost: 0.125, tokens: transfer.info.tokens } : {}),
        },
      ];
      const imported = await host.request(importPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(transfer),
      });
      const exported = await read(`/api/experimental/session/${id}/export`);
      const session = await read(`/api/session/${id}`);
      const renamed = await host.request(`/api/session/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "T8 synthetic renamed" }),
      });
      const marker = await host.request(`/api/session/${id}/synthetic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "T8 synthetic log marker",
          description: "T8 probe",
          resume: false,
        }),
      });
      const logPath = `/api/experimental/session/${id}/log?follow=false`;
      const log = await host.request(logPath);
      const events = parseSSE(await log.text());
      const entries = events.filter(
        (event) => (event.data as { type?: string })?.type !== "log.synced",
      );
      const cursor =
        entries[0]?.id ??
        (entries[0]?.data as { seq?: number } | undefined)?.seq?.toString();
      const replay = cursor
        ? await host.request(`${logPath}&after=${encodeURIComponent(cursor)}`)
        : null;
      const replayEvents = replay?.ok ? parseSSE(await replay.text()) : [];
      const message = exported.data?.messages?.[0];
      cases.push({
        renameStatus: renamed.status,
        markerStatus: marker.status,
        known,
        importStatus: imported.status,
        exportStatus: exported.status,
        sessionStatus: session.status,
        messageCost: metric(message?.cost),
        messageInput: metric(message?.tokens?.input),
        sessionCost: metric(session.data?.cost),
        logStatus: log.status,
        eventCount: entries.length,
        cursorAvailable: cursor !== undefined,
        replayStatus: replay?.status ?? null,
        replayCount: replayEvents.filter(
          (event) => (event.data as { type?: string })?.type !== "log.synced",
        ).length,
        exclusiveCursorObserved:
          cursor !== undefined
            ? replayEvents
                .filter(
                  (event) =>
                    (event.data as { type?: string })?.type !== "log.synced",
                )
                .every(
                  (event) =>
                    Number((event.data as { seq?: number }).seq) >
                    Number(cursor),
                )
            : null,
      });
    }
    const after = await read(statsPath);
    const live = await host.request("/api/event?types=session.created");
    // Reading the handshake only, then disconnecting; never wait for a model event.
    const reader = live.body?.getReader();
    const handshake = reader ? await reader.read() : null;
    await reader?.cancel();
    return {
      state: cases.every(
        (item) => item.importStatus === 200 && item.exportStatus === 200,
      )
        ? "observed"
        : "failed",
      baseline: host.version,
      liveMutationExecuted: true,
      providerCalls: 0,
      cases,
      stats: { before, after },
      stream: {
        status: live.status,
        handshakeObserved: !!handshake?.value,
        replaySupported: false,
      },
      contract: {
        statsParameters: schema.paths[
          "/api/experimental/session/stats"
        ].get.parameters.map((p: { name: string }) => p.name),
        logParameters: schema.paths[
          "/api/experimental/session/{sessionID}/log"
        ].get.parameters.map((p: { name: string }) => p.name),
        messageUsageRequired:
          schema.components.schemas[
            "Session.Message.Assistant"
          ].required.includes("cost"),
        activitySchema: schema.components.schemas["SessionStats.Activity"],
      },
      limits: {
        realBillingProven: false,
        activeDurationProven: false,
        restartDurabilityProven: false,
        retentionProven: false,
        budgetEnforcementProven: false,
      },
    };
  } finally {
    await host.stop();
  }
}

if (import.meta.main)
  console.log(JSON.stringify(await runUsageProbe(), null, 2));
