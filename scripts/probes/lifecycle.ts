/** T5 destructive feasibility experiment: synthetic sessions in a private host only. */
import { createHash } from "node:crypto";
import { createHarness } from "../harness";

type Session = {
  id: string;
  parentID?: string;
  fork?: { sessionID: string };
  title?: string;
  agent?: string;
  model?: unknown;
  location: { directory?: string };
  time: { archived?: number };
};

export async function runLifecycleProbe() {
  const host = await createHarness();
  const owned = new Set<string>();
  const location = { directory: `${host.root}/project` };
  const trace: string[] = [];
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
    // Only return parsed protocol data; never log headers or transport errors.
    const text = await response.text();
    const value = text ? JSON.parse(text) : {};
    return { status: response.status, data: value.data };
  }
  async function create(title: string, parentID?: string) {
    if (parentID && !owned.has(parentID)) throw new Error("Unowned parent");
    const result = await call("/api/session", "POST", {
      title: `T5 synthetic ${title}`,
      location,
      ...(parentID ? { parentID } : {}),
    });
    if (result.status !== 200 || typeof result.data?.id !== "string")
      throw new Error(`Synthetic create failed: HTTP ${result.status}`);
    owned.add(result.data.id);
    return result.data as Session;
  }
  async function remove(id: string) {
    if (!owned.has(id)) throw new Error("Refusing deletion of unowned session");
    return call(`/api/session/${id}`, "DELETE");
  }
  const read = (id: string) => call(`/api/session/${id}`);
  try {
    const infoResponse = await host.request("/api/info");
    const info = await infoResponse.json();
    const schemaResponse = await host.request("/openapi.json");
    const schema = await schemaResponse.json();
    const deleteSchema = schema.paths["/api/session/{sessionID}"].delete;
    const parent = await create("parent");
    const child = await create("child", parent.id);
    const independent = await create("independent reference");
    const synthetic = await call(
      `/api/session/${parent.id}/synthetic`,
      "POST",
      { text: "T5 synthetic history", resume: false },
    );
    const sourceID = `ses_t5${crypto.randomUUID().replaceAll("-", "")}`;
    const source = {
      info: {
        ...parent,
        id: sourceID,
        title: "T5 synthetic fork source",
      },
      messages: [
        {
          id: `msg_${sourceID.slice(4)}`,
          type: "synthetic",
          time: { created: 1 },
          text: "T5 synthetic transcript",
        },
      ],
    };
    const imported = await call(
      "/api/experimental/session/import",
      "POST",
      source,
    );
    if (imported.status !== 200)
      throw new Error("Synthetic source import failed");
    owned.add(source.info.id);
    const forkResult = await call(
      `/api/session/${source.info.id}/fork`,
      "POST",
      {},
    );
    if (forkResult.status !== 200 || !forkResult.data?.id)
      throw new Error(`Synthetic fork failed: HTTP ${forkResult.status}`);
    const fork = forkResult.data as Session;
    owned.add(fork.id);
    const forkMessages = await call(`/api/session/${fork.id}/message`);
    const renamed = await call(`/api/session/${parent.id}`, "PATCH", {
      title: "T5 synthetic renamed",
    });
    const renameObserved = await read(parent.id);
    const archived = await call(`/api/session/${source.info.id}`, "PATCH", {
      archived: true,
    });
    const archiveObserved = await read(source.info.id);
    const archiveMessages = await call(
      `/api/session/${source.info.id}/message`,
    );
    const restored = await call(`/api/session/${source.info.id}`, "PATCH", {
      archived: false,
    });
    const restoreObserved = await read(source.info.id);
    const agents = await call(
      `/api/agent?location[directory]=${encodeURIComponent(location.directory)}`,
    );
    const agent = Array.isArray(agents.data) ? agents.data[0]?.id : undefined;
    const agentSelection = agent
      ? await call(`/api/session/${parent.id}/agent`, "POST", { agent })
      : null;
    const agentObserved = await read(parent.id);
    const invalidModel = await call(`/api/session/${parent.id}/model`, "POST", {
      model: { providerID: "t5-missing", modelID: "t5-missing" },
    });
    const interrupt = await call(
      `/api/session/${parent.id}/interrupt`,
      "POST",
      {},
    );
    const compact = await call(`/api/session/${parent.id}/compact`, "POST", {});
    let compactMessages = await call(`/api/session/${parent.id}/message`);
    const compactID = compact.data?.id;
    const compactDeadline = Date.now() + 2_000;
    const terminalCompaction = () =>
      compactMessages.data?.find(
        (message: { id: string; status?: string }) =>
          message.id === compactID &&
          ["completed", "failed"].includes(message.status ?? ""),
      );
    while (!terminalCompaction() && Date.now() < compactDeadline) {
      await Bun.sleep(20);
      compactMessages = await call(`/api/session/${parent.id}/message`);
    }
    const completion = terminalCompaction();
    const compactInbox = await call(`/api/session/${parent.id}/inbox`);
    // No model/provider credentials: admission is not evidence of successful compaction.
    await call(`/api/session/${parent.id}/interrupt`, "POST", {});

    // Local reference deliberately does not confer native parentage or deletion rights.
    const externalReference = { source: independent.id, target: parent.id };
    const preview = [parent.id, child.id].sort();
    const digest = createHash("sha256")
      .update(JSON.stringify(preview))
      .digest("hex");
    trace.push("preview");
    const beforeParent = await read(parent.id);
    const beforeChild = await read(child.id);
    if (beforeParent.status !== 200 || beforeChild.data?.parentID !== parent.id)
      throw new Error("Synthetic preview validation failed");
    trace.push("validated");
    // Independent native HTTP writer, outside any proposed plugin lock, AFTER validation.
    const extra = await create("external writer child", parent.id);
    trace.push("external-child-created");
    const extraBefore = await read(extra.id);
    trace.push("delete-called");
    const deleted = await remove(parent.id);
    const after = await Promise.all(
      [parent.id, child.id, extra.id].map(async (id) => ({
        id,
        status: (await read(id)).status,
      })),
    );
    const independentAfter = await read(independent.id);
    const sourceDeleted = await remove(source.info.id);
    const forkAfter = await read(fork.id);
    const extraDeleted =
      after.find((item) => item.id === extra.id)?.status === 404;
    return {
      baseline: host.version,
      serverVersion: info.version,
      verdict: extraDeleted ? "NO-GO" : "REVIEW_REQUIRED",
      blockedRequirements: ["LIF-09", "LIF-10"],
      productDeleteEnabled: false,
      create: { parent, child, independent },
      fork: {
        status: forkResult.status,
        sourceID: source.info.id,
        info: fork,
        messages: forkMessages,
      },
      syntheticStatus: synthetic.status,
      rename: { status: renamed.status, observed: renameObserved.data?.title },
      archive: {
        status: archived.status,
        observed: archiveObserved.data?.time?.archived ?? null,
        messages: archiveMessages,
      },
      restore: {
        status: restored.status,
        observed: restoreObserved.data?.time?.archived ?? null,
      },
      configuration: {
        agentSelection,
        selectedAgent: agentObserved.data?.agent ?? null,
        invalidModelStatus: invalidModel.status,
        style: "unsupported: no dedicated native style operation in T2",
        futureExecutionSelectionProven: false,
      },
      interrupt,
      compact: {
        admission: compact,
        messages: compactMessages,
        inbox: compactInbox,
        observedCompletion: completion?.status ?? "not_observed",
        successfulCompletionProven: completion?.status === "completed",
      },
      deletion: {
        nativeRequestBody: deleteSchema.requestBody ?? null,
        nativeParameters: deleteSchema.parameters.map(
          (parameter: { name: string; in: string }) => ({
            name: parameter.name,
            in: parameter.in,
          }),
        ),
        preview,
        digest,
        trace,
        extraID: extra.id,
        extraBeforeStatus: extraBefore.status,
        extraParentID: extraBefore.data?.parentID,
        deleteStatus: deleted.status,
        after,
        unapprovedExtraDeleted: extraDeleted,
      },
      references: {
        externalReference,
        independentAfterStatus: independentAfter.status,
        forkAfterStatus: forkAfter.status,
        forkSourceDeleteStatus: sourceDeleted.status,
        targetMissing: after[0]?.status === 404,
        pluginCleanupProven: false,
      },
    };
  } finally {
    // All IDs originate in this private harness. No foreign/tree discovery is deleted.
    try {
      for (const id of owned) {
        if ((await read(id)).status === 200) await remove(id);
      }
    } finally {
      await host.stop();
    }
  }
}

if (import.meta.main)
  console.log(JSON.stringify(await runLifecycleProbe(), null, 2));
