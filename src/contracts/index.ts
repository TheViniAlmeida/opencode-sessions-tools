export { canonical } from "./canonical";

export const contractVersion = 1 as const;
export const capabilities = [
  "discover",
  "message",
  "read",
  "manage",
  "session.configure",
  "context.read",
  "context.write",
  "task.dispatch",
  "schedule.manage",
] as const;
export type Capability = (typeof capabilities)[number];
export const errorCodes = [
  "invalid_input",
  "not_found",
  "forbidden",
  "conflict",
  "unsupported",
  "expired",
  "rate_limited",
  "unavailable",
  "unknown_outcome",
] as const;
export type ErrorCode = (typeof errorCodes)[number];

// Messages are fixed domain text: never attach raw host errors or input payloads.
export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly retryable = false,
    public readonly operationID?: string,
  ) {
    super(code);
    this.name = "DomainError";
  }
}

function invalid(): never {
  throw new DomainError("invalid_input");
}
function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) return invalid();
  return result;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return invalid();
  return value;
}
function index(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return invalid();
  return value;
}
export interface SessionRef {
  readonly version: 1;
  readonly instanceID: string;
  readonly sessionID: string;
  readonly projectID: string;
}
export function parseSessionRef(input: unknown): SessionRef {
  const value = record(input, [
    "version",
    "instanceID",
    "sessionID",
    "projectID",
  ]);
  if (value.version !== contractVersion) return invalid();
  return {
    version: 1,
    instanceID: text(value.instanceID),
    sessionID: text(value.sessionID),
    projectID: text(value.projectID),
  };
}
export interface MutationInput {
  readonly version: 1;
  readonly idempotencyKey: string;
  readonly payload: unknown;
}
export function parseMutation(input: unknown): MutationInput {
  const value = record(input, ["version", "idempotencyKey", "payload"]);
  if (value.version !== contractVersion || !Object.hasOwn(value, "payload"))
    return invalid();
  return {
    version: 1,
    idempotencyKey: text(value.idempotencyKey),
    payload: value.payload,
  };
}

function member<const T extends readonly string[]>(
  values: T,
  value: unknown,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) return invalid();
  return value;
}
export function parseCapability(input: unknown): Capability {
  return member(capabilities, input);
}
export function parseDeliveryState(input: unknown): DeliveryState {
  return member(deliveryStates, input);
}
export function parseTaskState(input: unknown): TaskState {
  return member(taskStates, input);
}
export interface ErrorEnvelope {
  readonly version: 1;
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly operationID?: string;
}
export function parseError(input: unknown): ErrorEnvelope {
  const value = record(input, [
    "version",
    "code",
    "message",
    "retryable",
    "operationID",
  ]);
  const code = member(errorCodes, value.code);
  // The initial wire contract intentionally carries no free-form diagnostic data.
  if (
    value.version !== contractVersion ||
    value.message !== code ||
    typeof value.retryable !== "boolean"
  )
    return invalid();
  return {
    version: 1,
    code,
    message: code,
    retryable: value.retryable,
    ...(value.operationID === undefined
      ? {}
      : { operationID: text(value.operationID) }),
  };
}
export interface SuccessEnvelope<T> {
  readonly operationID: string;
  readonly state: string;
  readonly data: T;
  readonly capabilityVersion: 1;
}
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
export function parseMessageContent(input: unknown): string {
  if (
    typeof input !== "string" ||
    new TextEncoder().encode(input).byteLength > 65536
  )
    return invalid();
  return input;
}

type ScheduleBase = { readonly version: 1; readonly timezone: string };
export type Schedule = ScheduleBase &
  (
    | { readonly kind: "timer"; readonly delayMs: number }
    | { readonly kind: "date"; readonly dueUTC: string }
    | {
        readonly kind: "interval";
        readonly anchorUTC: string;
        readonly periodMs: number;
      }
    | {
        readonly kind: "cron";
        readonly expression: string;
        readonly referenceUTC: string;
      }
  );
function utc(input: unknown): string {
  const value = text(input);
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  )
    return invalid();
  return value;
}
function duration(input: unknown): number {
  const value = index(input);
  if (value === 0) return invalid();
  return value;
}
export function parseSchedule(input: unknown): Schedule {
  if (input && typeof input === "object" && Object.hasOwn(input, "conditions"))
    throw new DomainError("unsupported");
  const value = record(input, [
    "version",
    "kind",
    "timezone",
    "delayMs",
    "dueUTC",
    "anchorUTC",
    "periodMs",
    "expression",
    "referenceUTC",
  ]);
  if (value.version !== contractVersion) return invalid();
  const timezone = text(value.timezone);
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
  } catch {
    return invalid();
  }
  const base = { version: contractVersion, timezone };
  const common = ["version", "kind", "timezone"];
  switch (value.kind) {
    case "timer":
      record(input, [...common, "delayMs"]);
      return { ...base, kind: "timer", delayMs: duration(value.delayMs) };
    case "date":
      record(input, [...common, "dueUTC"]);
      return { ...base, kind: "date", dueUTC: utc(value.dueUTC) };
    case "interval":
      record(input, [...common, "anchorUTC", "periodMs"]);
      return {
        ...base,
        kind: "interval",
        anchorUTC: utc(value.anchorUTC),
        periodMs: duration(value.periodMs),
      };
    case "cron":
      record(input, [...common, "expression", "referenceUTC"]);
      // Calendar grammar and DST enumeration belong to the scheduler, not a host DTO.
      return {
        ...base,
        kind: "cron",
        expression: text(value.expression),
        referenceUTC: utc(value.referenceUTC),
      };
    default:
      return invalid();
  }
}

// Only trusted adapters supply principals. There is intentionally no payload parser
// or constructor that promotes client-supplied IDs to authenticated identities.
export type SessionPrincipal = {
  readonly kind: "session";
  readonly session: SessionRef;
};
export type OperatorPrincipal = {
  readonly kind: "operator";
  readonly operatorID: string;
  readonly instanceID: string;
  readonly revision: number;
};
export type Principal = SessionPrincipal | OperatorPrincipal;
export interface IdentityPort {
  current(): Promise<SessionPrincipal>;
}
export interface AuthorizationPort {
  authorize(
    principal: Principal,
    target: SessionRef,
    capability: Capability,
  ): Promise<void>;
}
export interface ClockPort {
  /** UTC epoch milliseconds, for persistence and calendar calculations. */
  utcNow(): number;
  /** Monotonic milliseconds, only for local elapsed time and waits. */
  monotonicNow(): number;
}
export interface DispatchIntent {
  readonly operationID: string;
  readonly target: SessionRef;
  readonly content: string;
  readonly payloadHash: string;
}
export type AdmissionEvidence =
  | {
      readonly state: "admitted";
      readonly channel: "host" | "inbox" | "context_attachment";
      readonly receiptID: string;
    }
  | { readonly state: "rejected" }
  | { readonly state: "unknown_outcome" };
/** Host adapter translates only public, served contracts; uncertainty is not a retry. */
export interface DeliveryPort {
  dispatch(intent: DispatchIntent): Promise<AdmissionEvidence>;
  reconcile(operationID: string): Promise<AdmissionEvidence>;
}
export interface Grant {
  readonly version: 1;
  readonly grantID: string;
  readonly source: SessionRef;
  readonly target: SessionRef;
  readonly capabilities: readonly Capability[];
  readonly revision: number;
  readonly issuer: OperatorPrincipal;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}
export interface Lease {
  readonly resource: string;
  readonly owner: string;
  readonly generation: number;
  readonly expiresAt: string;
}
export const eventKinds = [
  "grant.created",
  "grant.revoked",
  "message.admitted",
  "message.rejected",
  "task.state_changed",
  "request.resolved",
  "session.changed",
  "job.state_changed",
  "job.fired",
  "context.changed",
  "budget.changed",
  "operation.unknown",
] as const;
export type EventKind = (typeof eventKinds)[number];
export interface DomainEvent {
  readonly version: 1;
  readonly sequence: number;
  readonly kind: EventKind;
  readonly actor: Principal;
  readonly createdAt: string;
  readonly scope: string;
  readonly target: string;
  readonly operationID: string;
  readonly grant?: {
    readonly capabilities: readonly Capability[];
    readonly revision: number;
  };
}
export interface CapabilityEvidence {
  readonly supported: boolean;
}
export function requireCapability(evidence: CapabilityEvidence): void {
  if (evidence.supported !== true) throw new DomainError("unsupported");
}

export const deliveryStates = [
  "pending",
  "dispatching",
  "admitted",
  "rejected",
  "expired",
  "unknown_outcome",
] as const;
export type DeliveryState = (typeof deliveryStates)[number];
export const taskStates = [
  "pending",
  "blocked",
  "running",
  "awaiting_input",
  "awaiting_approval",
  "cancel_requested",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TaskState = (typeof taskStates)[number];
const deliveryEdges: Record<DeliveryState, readonly DeliveryState[]> = {
  pending: ["dispatching", "rejected", "expired"],
  dispatching: ["admitted", "rejected", "unknown_outcome"],
  unknown_outcome: ["admitted", "rejected"],
  admitted: [],
  rejected: [],
  expired: [],
};
const taskEdges: Record<TaskState, readonly TaskState[]> = {
  pending: ["running", "blocked", "cancelled"],
  blocked: ["pending", "cancelled"],
  running: [
    "completed",
    "failed",
    "awaiting_input",
    "awaiting_approval",
    "cancel_requested",
  ],
  awaiting_input: ["running", "cancel_requested"],
  awaiting_approval: ["running", "cancel_requested"],
  cancel_requested: ["cancelled", "completed", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};
export function transitionDelivery(
  from: DeliveryState,
  to: DeliveryState,
  evidence?: { readonly reconciled: boolean },
): DeliveryState {
  if (
    !Object.hasOwn(deliveryEdges, from) ||
    !deliveryEdges[from].includes(to) ||
    (from === "unknown_outcome" && evidence?.reconciled !== true)
  )
    throw new DomainError("conflict");
  return to;
}
export function transitionTask(
  from: TaskState,
  to: TaskState,
  evidence?: { readonly replanned: boolean },
): TaskState {
  if (
    !Object.hasOwn(taskEdges, from) ||
    !taskEdges[from].includes(to) ||
    (from === "blocked" && to === "pending" && evidence?.replanned !== true)
  )
    throw new DomainError("conflict");
  return to;
}

export function occurrenceID(
  jobID: string,
  scheduleRevision: number,
  dueIndex: number,
): string {
  return JSON.stringify([
    contractVersion,
    text(jobID),
    index(scheduleRevision),
    index(dueIndex),
  ]);
}

/** Bootstrap adapter supplies realpath + stable file identity, never a raw alias.
 * Missing/conflicting evidence refuses startup; this is not global discovery or
 * host fencing. T10 must prove evidence against the actual shared database. */
export interface OwnershipEvidence {
  readonly instanceID: string;
  readonly scopeID: string;
  readonly installationID: string;
  readonly canonicalPath: string;
  readonly databaseIdentity: string;
}
export interface OwnershipPort {
  inspect(): Promise<readonly OwnershipEvidence[]>;
}
export function resolveOwnership(
  claims: readonly OwnershipEvidence[],
): OwnershipEvidence {
  const first = claims[0];
  const keys = [
    "instanceID",
    "scopeID",
    "installationID",
    "canonicalPath",
    "databaseIdentity",
  ] as const;
  if (
    !first ||
    claims.some(
      (claim) =>
        keys.some(
          (key) =>
            typeof claim[key] !== "string" ||
            claim[key].trim().length === 0 ||
            claim[key] !== first[key],
        ) ||
        !claim.canonicalPath.startsWith("/") ||
        claim.canonicalPath
          .split("/")
          .some((part) => part === "." || part === ".."),
    )
  )
    throw new DomainError("unavailable");
  return { ...first };
}
