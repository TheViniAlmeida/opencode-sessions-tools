import { createHash } from "node:crypto";
import type { TrustedPrincipalPort } from "../authorization/authorize";
import {
  type AuthorizationPort,
  canonical,
  DomainError,
  parseSessionRef,
  type SessionRef,
} from "../contracts";

export type ExportMode = "selected-context" | "native-transcript";
export interface TranscriptMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
}
/** Adapter projects native messages to text. Never pass raw config or native DTOs.
 * compatible certifies this projection, not a lossless native round trip.
 */
export interface ContextExportHostPort {
  transcript(source: SessionRef): Promise<{
    readonly compatible: boolean;
    readonly messages: readonly TranscriptMessage[];
  }>;
}
export interface ExportPayload {
  readonly version: 1;
  readonly source: SessionRef;
  readonly createdAt: string;
  readonly mode: ExportMode;
  readonly projection: {
    readonly kind: "text-messages-v1";
    readonly messages: readonly TranscriptMessage[];
  };
  readonly loss: {
    readonly filesystem: true;
    readonly processes: true;
    readonly nativeState: true;
    readonly nonTextParts: true;
    readonly configuration: true;
    readonly authority: true;
  };
}
export interface ExportEnvelope {
  readonly payload: ExportPayload;
  readonly sha256: string;
}
/** Integrity only: this digest does not authenticate the claimed source. */
export function hashExportPayload(payload: unknown): string {
  return createHash("sha256").update(canonical(payload), "utf8").digest("hex");
}

export class ContextExportService {
  constructor(
    private readonly identity: TrustedPrincipalPort,
    private readonly authorization: AuthorizationPort,
    private readonly host: ContextExportHostPort,
    private readonly now: () => number = Date.now,
  ) {}

  /** Mode and IDs are explicit consent to export content, not a sanitizer.
   * Arbitrary user text can contain secrets; no content is logged here.
   * The 10 MiB import limit belongs to T27, not this read-only producer.
   */
  async export(input: unknown): Promise<ExportEnvelope> {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Object.prototype
    )
      throw new DomainError("invalid_input");
    const value = input as Record<string, unknown>;
    if (
      Object.keys(value).some(
        (key) => !["source", "mode", "messageIDs"].includes(key),
      )
    )
      throw new DomainError("invalid_input");
    const source = parseSessionRef(value.source);
    const mode = value.mode;
    if (mode !== "selected-context" && mode !== "native-transcript")
      throw new DomainError("invalid_input");
    let selected: Set<string> | undefined;
    if (mode === "selected-context") {
      if (
        !Array.isArray(value.messageIDs) ||
        value.messageIDs.length === 0 ||
        value.messageIDs.some((id) => typeof id !== "string" || !id.trim())
      )
        throw new DomainError("invalid_input");
      selected = new Set(value.messageIDs as string[]);
      if (selected.size !== value.messageIDs.length)
        throw new DomainError("invalid_input");
    } else if (Object.hasOwn(value, "messageIDs"))
      throw new DomainError("invalid_input");
    const actor = await this.identity.current();
    if (!actor) throw new DomainError("forbidden");
    const check = async () => {
      await this.authorization.authorize(actor, source, "context.read");
      await this.authorization.authorize(actor, source, "read");
    };
    await check();
    let native: Awaited<ReturnType<ContextExportHostPort["transcript"]>>;
    try {
      native = await this.host.transcript(source);
    } catch (error) {
      if (error instanceof DomainError)
        throw new DomainError(error.code, error.retryable);
      throw new DomainError("unavailable", true);
    }
    if (native?.compatible !== true) throw new DomainError("unsupported");
    if (!Array.isArray(native.messages)) throw new DomainError("unavailable");
    const seen = new Set<string>();
    const messages: TranscriptMessage[] = [];
    for (const item of native.messages) {
      if (
        !item ||
        typeof item.id !== "string" ||
        !item.id.trim() ||
        seen.has(item.id) ||
        !["user", "assistant"].includes(item.role) ||
        typeof item.text !== "string"
      )
        throw new DomainError("unavailable");
      seen.add(item.id);
      if (!selected || selected.has(item.id))
        messages.push({ id: item.id, role: item.role, text: item.text });
    }
    if (selected && [...selected].some((id) => !seen.has(id)))
      throw new DomainError("invalid_input");
    const time = this.now();
    if (!Number.isSafeInteger(time) || time < 0 || time > 8_640_000_000_000_000)
      throw new DomainError("unavailable");
    const payload: ExportPayload = {
      version: 1,
      source,
      createdAt: new Date(time).toISOString(),
      mode,
      projection: { kind: "text-messages-v1", messages },
      loss: {
        filesystem: true,
        processes: true,
        nativeState: true,
        nonTextParts: true,
        configuration: true,
        authority: true,
      },
    };
    const sha256 = hashExportPayload(payload);
    await check();
    return { payload, sha256 };
  }
}
