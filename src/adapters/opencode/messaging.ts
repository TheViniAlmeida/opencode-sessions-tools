import type { SessionApi, SessionInboxUser } from "@opencode/client";
import type { NativePrompt, PromptHostPort } from "../../messaging/dispatcher";
import {
  parseTaskOutcome,
  type TaskOutcomePort,
} from "../../orchestration/runner";
import type { NativeSessionCatalog } from "./sessions";

/** Supplied by the admission/execution owner, never by assistant text or a tool
 * payload. SDK 2.2.5 assistant messages have no parent input/execution ID. The
 * owner must independently establish this binding; absent proof stays unknown. */
export interface NativeOutcomeBinding {
  readonly prompt: NativePrompt;
  readonly admissionID: string;
  readonly taskGeneration: number;
  readonly assistantMessageID: string;
}
export interface NativeMessagingOptions {
  readonly session: Pick<SessionApi, "get" | "prompt" | "inbox" | "message">;
  readonly catalog: NativeSessionCatalog;
  readonly bindings?: {
    lookup(operationID: string): Promise<NativeOutcomeBinding | null>;
  };
}
const marker = "session-orchestration.prompt";
const unknown = () => ({ state: "unknown_outcome" as const });
const proof = (prompt: NativePrompt) =>
  JSON.stringify([
    prompt.operationID,
    prompt.taskID,
    prompt.messageID,
    prompt.payloadHash,
    prompt.target.instanceID,
    prompt.target.projectID,
    prompt.target.sessionID,
    prompt.correlationID,
    prompt.hops,
    prompt.policy,
  ]);

/** No SQL, listeners, credential discovery or notification delivery. T19 inbox
 * remains local: even resume:false prompt would create an unwanted host input. */
export function createNativeMessaging(options: NativeMessagingOptions): {
  readonly prompts: PromptHostPort;
  readonly outcomes: TaskOutcomePort;
} {
  async function route(prompt: NativePrompt) {
    const { target } = prompt;
    const resolved = options.catalog.resolve(target);
    if (
      !resolved ||
      resolved.instanceID !== target.instanceID ||
      resolved.projectID !== target.projectID ||
      !resolved.location.directory.startsWith("/")
    )
      throw new Error("unavailable");
    const info = await options.session.get({ sessionID: target.sessionID });
    if (
      info.id !== target.sessionID ||
      info.projectID !== target.projectID ||
      info.location.directory !== resolved.location.directory
    )
      throw new Error("unavailable");
  }
  function matches(prompt: NativePrompt, receipt: SessionInboxUser) {
    return (
      receipt.id === prompt.messageID &&
      receipt.sessionID === prompt.target.sessionID &&
      receipt.type === "user" &&
      receipt.payload.text === prompt.content &&
      receipt.delivery === prompt.policy &&
      receipt.payload.metadata?.[marker] === proof(prompt)
    );
  }
  async function inspect(
    prompt: NativePrompt,
  ): ReturnType<PromptHostPort["inspect"]> {
    try {
      await route(prompt);
      const inbox = await options.session.inbox.list({
        sessionID: prompt.target.sessionID,
      });
      const receipt = inbox.find((item) => item.id === prompt.messageID);
      if (receipt?.type === "user" && matches(prompt, receipt))
        return {
          state: "accepted",
          messageID: prompt.messageID,
          payloadHash: prompt.payloadHash,
        };
      // Delivered inputs leave inbox. Read exactly the assigned ID, not history.
      const message = await options.session.message.get({
        sessionID: prompt.target.sessionID,
        messageID: prompt.messageID,
      });
      if (
        message.type === "user" &&
        message.id === prompt.messageID &&
        message.text === prompt.content &&
        message.metadata?.[marker] === proof(prompt)
      )
        return {
          state: "accepted",
          messageID: prompt.messageID,
          payloadHash: prompt.payloadHash,
        };
    } catch {
      // Missing, transport failure and correlation mismatch cannot prove rejection.
    }
    return unknown();
  }
  const prompts: PromptHostPort = {
    async send(prompt) {
      try {
        await route(prompt);
        const receipt = await options.session.prompt({
          sessionID: prompt.target.sessionID,
          id: prompt.messageID,
          text: prompt.content,
          metadata: { [marker]: proof(prompt) },
          delivery: prompt.policy,
          resume: true,
        });
        if (matches(prompt, receipt))
          return { state: "accepted", messageID: receipt.id };
      } catch {
        // Never retry a possibly accepted request here. Dispatcher owns recovery.
      }
      return unknown();
    },
    inspect,
  };
  return {
    prompts,
    outcomes: {
      async inspect(operationID) {
        try {
          const binding = await options.bindings?.lookup(operationID);
          if (
            !binding ||
            binding.prompt.operationID !== operationID ||
            !binding.assistantMessageID ||
            binding.assistantMessageID === binding.prompt.messageID ||
            (await inspect(binding.prompt)).state !== "accepted"
          )
            return null;
          const message = await options.session.message.get({
            sessionID: binding.prompt.target.sessionID,
            messageID: binding.assistantMessageID,
          });
          if (
            message.type !== "assistant" ||
            message.id !== binding.assistantMessageID ||
            !Number.isFinite(message.time.completed)
          )
            return null;
          const state =
            message.error || message.finish === "error"
              ? "failed"
              : message.finish === "stop"
                ? "completed"
                : null;
          if (!state) return null;
          return parseTaskOutcome({
            admissionID: binding.admissionID,
            operationID,
            correlationID: binding.prompt.correlationID,
            taskGeneration: binding.taskGeneration,
            state,
            evidence: JSON.stringify({
              source: "native-assistant",
              inputID: binding.prompt.messageID,
              assistantID: message.id,
              completed: message.time.completed,
              finish: message.finish ?? null,
              error: Boolean(message.error),
            }),
          });
        } catch {
          return null;
        }
      },
    },
  };
}
