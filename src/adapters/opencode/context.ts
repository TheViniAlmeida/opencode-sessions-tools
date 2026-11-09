import type {
  ExperimentalSessionExportInput,
  ExperimentalSessionImportInput,
  SessionInfo,
  SessionTransferData,
} from "@opencode/client";
import type {
  ContextExportHostPort,
  TranscriptMessage,
} from "../../context/export";
import type {
  ImportBatchObservation,
  ImportHostPort,
  ImportNewSessionReceipt,
  ImportPlan,
} from "../../context/import";
import { DomainError, type SessionRef } from "../../contracts";
import type { NativeSessionCatalog } from "./sessions";

export interface NativeContextOptions {
  /** Full trusted native client, not Plugin.Context.session or package authority. */
  readonly native: {
    export(
      input: ExperimentalSessionExportInput,
      options?: { readonly signal?: AbortSignal },
    ): Promise<SessionTransferData>;
    import(
      input: ExperimentalSessionImportInput,
      options?: { readonly signal?: AbortSignal },
    ): Promise<SessionInfo>;
  };
  readonly catalog: NativeSessionCatalog;
}

/** APPEND belongs to plugin-local attachment storage, never native delivery. */
export function createNativeContext(options: NativeContextOptions) {
  const unsupported = (): never => {
    throw new DomainError("unsupported");
  };
  const unavailable = (): never => {
    throw new DomainError("unavailable");
  };
  const resolve = (ref: SessionRef) => {
    try {
      const scope = options.catalog.resolve(ref);
      if (
        !scope ||
        scope.instanceID !== ref.instanceID ||
        scope.projectID !== ref.projectID ||
        !scope.location?.directory?.startsWith("/")
      )
        return unavailable();
      return scope;
    } catch {
      return unavailable();
    }
  };
  const checkImport = (plan: ImportPlan): void => {
    if (plan.selection.mode !== "create") unsupported();
    if (
      plan.selection.mode === "create" &&
      (plan.selection.destination.instanceID !== plan.target.instanceID ||
        plan.selection.destination.projectID !== plan.target.projectID)
    )
      unavailable();
    resolve(plan.target);
    if (
      !plan.target.sessionID.startsWith("ses_") ||
      new Set(plan.messages.map((m) => m.id)).size !== plan.messages.length ||
      plan.messages.some(
        (m) =>
          !m.id.startsWith("msg_") ||
          !m.text.isWellFormed() ||
          !["user", "assistant"].includes(m.role),
      )
    )
      unsupported();
  };
  const observeBatch = async (
    plan: ImportPlan,
  ): Promise<ImportBatchObservation> => {
    checkImport(plan);
    const signal = AbortSignal.timeout(5_000);
    const scope = resolve(plan.target);
    const unknown: ImportBatchObservation = {
      observedSession: null,
      confirmedMessages: [],
      uncertainIDs: [plan.target.sessionID, ...plan.messages.map((m) => m.id)],
    };
    const time = { created: 0 };
    const input: ExperimentalSessionImportInput = {
      info: {
        id: plan.target.sessionID,
        projectID: scope.projectID,
        location: { directory: scope.location.directory },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        time: { created: 0, updated: 0 },
      },
      location: { directory: scope.location.directory },
      messages: plan.messages.map(
        (m): ExperimentalSessionImportInput["messages"][number] =>
          m.role === "user"
            ? { id: m.id, type: "user", text: m.text, time }
            : {
                id: m.id,
                type: "assistant",
                agent: "imported",
                model: { id: "imported", providerID: "imported" },
                content: [{ type: "text", text: m.text }],
                time: { created: 0, completed: 0 },
                finish: "stop",
              },
      ),
    };
    let result: SessionInfo;
    try {
      result = await options.native.import(input, { signal });
    } catch {
      return unknown;
    }
    if (
      !result ||
      typeof result.id !== "string" ||
      !result.id ||
      typeof result.projectID !== "string" ||
      !result.projectID
    )
      return unknown;
    const observedSession: SessionRef = {
      version: 1,
      instanceID: scope.instanceID,
      projectID: result.projectID,
      sessionID: result.id,
    };
    if (
      result.id !== plan.target.sessionID ||
      result.projectID !== scope.projectID ||
      result.location?.directory !== scope.location.directory
    )
      return { ...unknown, observedSession };
    try {
      const data = await options.native.export(
        {
          sessionID: result.id,
          sanitize: false,
        },
        { signal },
      );
      if (
        data.info.id !== result.id ||
        data.info.projectID !== scope.projectID ||
        data.info.location.directory !== scope.location.directory
      )
        return { ...unknown, observedSession };
      const confirmedMessages = plan.messages
        .filter((expected) => {
          const matches = data.messages.filter((m) => m.id === expected.id);
          if (matches.length !== 1) return false;
          const actual = matches[0];
          if (!actual) return false;
          return (
            actual.type === expected.role &&
            (actual.type === "user"
              ? actual.text
              : actual.type === "assistant"
                ? actual.content
                    .filter((p) => p.type === "text")
                    .map((p) => p.text)
                    .join("")
                : null) === expected.text
          );
        })
        .map((m) => ({ session: observedSession, messageID: m.id }));
      return {
        observedSession,
        confirmedMessages,
        uncertainIDs: plan.messages
          .filter((m) => !confirmedMessages.some((c) => c.messageID === m.id))
          .map((m) => m.id),
      };
    } catch {
      return { ...unknown, observedSession };
    }
  };
  const importNewSession = async (
    plan: ImportPlan,
  ): Promise<ImportNewSessionReceipt> => ({
    state: "observed",
    value: await observeBatch(plan),
  });
  const host = {
    preflight: checkImport,
    importNewSession,
  } satisfies ImportHostPort;
  return {
    checkImport,
    import: host,
    export: {
      async transcript(
        source: SessionRef,
      ): ReturnType<ContextExportHostPort["transcript"]> {
        try {
          const scope = resolve(source);
          const data = await options.native.export(
            {
              sessionID: source.sessionID,
              sanitize: false,
            },
            { signal: AbortSignal.timeout(5_000) },
          );
          if (
            data.info.id !== source.sessionID ||
            data.info.projectID !== scope.projectID ||
            data.info.location.directory !== scope.location.directory
          )
            unavailable();
          const messages: TranscriptMessage[] = [];
          const ids = new Set<string>();
          for (const message of data.messages) {
            if (!message.id || ids.has(message.id)) unavailable();
            ids.add(message.id);
            if (message.type === "user") {
              if (
                typeof message.text !== "string" ||
                !message.text.isWellFormed()
              )
                unavailable();
              messages.push({
                id: message.id,
                role: "user",
                text: message.text,
              });
            } else if (message.type === "assistant") {
              const text = message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("");
              if (!text.isWellFormed()) unavailable();
              messages.push({ id: message.id, role: "assistant", text });
            }
          }
          return { compatible: true, messages };
        } catch {
          // Native errors may carry transport headers or transcript content.
          return unavailable();
        }
      },
    },
  };
}
