import type { Database } from "bun:sqlite";
import type {
  Authorizer,
  Profile,
  TrustedPrincipalPort,
} from "../authorization/authorize";
import {
  type Capability,
  capabilities,
  DomainError,
  parseSessionRef,
  type SessionRef,
} from "../contracts";
import type { Persistence } from "../persistence/database";
import type { Operation, Operations } from "../persistence/operations";

export type ControlCommand =
  | { action: "rename"; title: string }
  | { action: "model"; providerID: string; modelID: string }
  | { action: "agent"; agent: string }
  | { action: "style"; style: string }
  | { action: "interrupt" }
  | { action: "archive" }
  | { action: "restore" }
  | { action: "compact" }
  | { action: "profile"; profile: Profile }
  | { action: "reset"; transfer: readonly ("model" | "agent" | "style")[] };

export type ControlObservation =
  | { action: "rename"; title: string }
  | {
      action: "model";
      providerID: string;
      modelID: string;
      appliesTo: "future_executions";
    }
  | { action: "agent"; agent: string; appliesTo: "future_executions" }
  | { action: "style"; style: string; appliesTo: "future_executions" }
  | { action: "interrupt"; requested: true; interrupted: boolean }
  | { action: "archive"; archived: true }
  | { action: "restore"; archived: false }
  | { action: "compact"; status: "admitted" | "completed" }
  | {
      action: "profile";
      profile: Profile;
      capabilities: readonly Capability[];
      limits: Readonly<Record<string, number>>;
    }
  | { action: "reset"; successor: SessionRef };

/** Trusted adapter validates the host's model/agent/style catalog, observes native
 * results (not HTTP status), and correlates every effect with operationID.
 * Reset creates a clean successor: only explicitly selected configuration moves,
 * never history, grants, jobs or permissions. There is deliberately no DELETE.
 */
export interface ControlHostPort {
  validate(target: SessionRef, command: ControlCommand): Promise<void>;
  execute(
    target: SessionRef,
    command: ControlCommand,
    operationID: string,
  ): Promise<ControlObservation>;
}

/** T29 must implement on this SAME database. Archive disables local jobs before
 * acknowledging completion. Restore clears the session gate, never reenables jobs.
 */
export interface ControlJobsPort {
  archive(sql: Database, target: SessionRef): void;
  restore(sql: Database, target: SessionRef): void;
}

/** Trusted authorization-storage adapter. Reads current policy/host/delegation
 * ceiling and persists effective profile+limits on the SAME DB. Never adds grants.
 * Missing adapter is unavailable, not an in-memory production substitute.
 */
export interface ControlProfilePort {
  ceiling(
    sql: Database,
    target: SessionRef,
  ): {
    capabilities: readonly Capability[];
    limits: Readonly<Record<string, number>>;
  };
  save(
    sql: Database,
    target: SessionRef,
    selection: Extract<ControlObservation, { action: "profile" }>,
  ): void;
}
const profileCeilings: Record<Profile, readonly Capability[]> = {
  observe: ["discover", "read", "context.read"],
  collaborate: [
    "discover",
    "read",
    "message",
    "context.read",
    "context.write",
    "task.dispatch",
  ],
  manage: capabilities,
  supervised: capabilities,
  "bounded-auto": capabilities,
};

export const controlMigration = {
  name: "session-controls-v1",
  sql: `CREATE TABLE session_control_results (
    operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id),
    observation_json TEXT NOT NULL
  );`,
} as const;

export interface ControlRequest {
  target: SessionRef;
  command: ControlCommand;
  expectedRevision: number;
  idempotencyKey: string;
}
export interface ControlResult {
  operation: Operation;
  observation: ControlObservation | null;
}

const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
function command(input: ControlCommand): ControlCommand {
  if (!input || typeof input !== "object")
    throw new DomainError("invalid_input");
  switch (input.action) {
    case "rename":
      if (text(input.title))
        return { action: input.action, title: input.title };
      break;
    case "model":
      if (text(input.providerID) && text(input.modelID))
        return {
          action: input.action,
          providerID: input.providerID,
          modelID: input.modelID,
        };
      break;
    case "agent":
      if (text(input.agent))
        return { action: input.action, agent: input.agent };
      break;
    case "style":
      if (text(input.style))
        return { action: input.action, style: input.style };
      break;
    case "interrupt":
    case "archive":
    case "restore":
    case "compact":
      return { action: input.action };
    case "profile":
      if (Object.hasOwn(profileCeilings, input.profile))
        return { action: input.action, profile: input.profile };
      break;
    case "reset":
      if (
        Array.isArray(input.transfer) &&
        input.transfer.every((item) =>
          ["model", "agent", "style"].includes(item),
        ) &&
        new Set(input.transfer).size === input.transfer.length
      )
        return { action: input.action, transfer: [...input.transfer] };
  }
  throw new DomainError("invalid_input");
}
function observed(
  target: SessionRef,
  cmd: ControlCommand,
  result: ControlObservation,
): boolean {
  if (!result || result.action !== cmd.action) return false;
  switch (result.action) {
    case "rename":
      return text(result.title);
    case "model":
      return (
        cmd.action === "model" &&
        result.providerID === cmd.providerID &&
        result.modelID === cmd.modelID &&
        result.appliesTo === "future_executions"
      );
    case "agent":
      return (
        cmd.action === "agent" &&
        result.agent === cmd.agent &&
        result.appliesTo === "future_executions"
      );
    case "style":
      return (
        cmd.action === "style" &&
        result.style === cmd.style &&
        result.appliesTo === "future_executions"
      );
    case "interrupt":
      return (
        result.requested === true && typeof result.interrupted === "boolean"
      );
    case "archive":
      return result.archived === true;
    case "restore":
      return result.archived === false;
    case "compact":
      return ["admitted", "completed"].includes(result.status);
    case "profile":
      return false; // Profile is applied locally, never accepted from a host observation.
    case "reset": {
      const next = parseSessionRef(result.successor);
      return (
        next.instanceID === target.instanceID &&
        next.projectID === target.projectID &&
        next.sessionID !== target.sessionID
      );
    }
  }
}

export class SessionControls {
  constructor(
    private readonly persistence: Persistence,
    private readonly identity: TrustedPrincipalPort,
    private readonly authorization: Pick<Authorizer, "authorizeAction">,
    private readonly operations: Operations,
    private readonly host: ControlHostPort,
    private readonly jobs: ControlJobsPort,
    private readonly profiles?: ControlProfilePort,
  ) {}

  async apply(request: ControlRequest): Promise<ControlResult> {
    if (!request || typeof request !== "object")
      throw new DomainError("invalid_input");
    const actor = await this.identity.current();
    if (!actor) throw new DomainError("forbidden");
    const target = parseSessionRef(request.target);
    const cmd = command(request.command);
    const configure = ["model", "agent", "style"].includes(cmd.action);
    // T11's configure action enforces ACL-11 for self; no operator from input.
    if (configure)
      await this.authorization.authorizeAction(actor, target, "configure");
    if (cmd.action === "profile") {
      await this.authorization.authorizeAction(actor, target, "profile");
      if (!this.profiles) throw new DomainError("unavailable");
    }
    let operation = await this.operations.enqueue({
      principal: actor,
      target,
      capability: configure ? "session.configure" : "manage",
      expectedRevision: request.expectedRevision,
      idempotencyKey: request.idempotencyKey,
      payload: cmd,
    });
    if (operation.state === "pending") {
      // Validate catalogs before admission; invalid selection never reaches execute.
      if (cmd.action !== "profile") {
        try {
          await this.host.validate(target, cmd);
        } catch (error) {
          if (error instanceof DomainError) throw error;
          throw new DomainError("unavailable");
        }
      }
      const lease = this.operations.claim(
        operation.operationID,
        crypto.randomUUID(),
        30_000,
      );
      operation = await this.operations.dispatch(
        actor,
        lease,
        request.expectedRevision,
        async (intent) => {
          if (cmd.action === "profile") {
            const saved = this.persistence.transaction((sql) => {
              sql.exec("SAVEPOINT session_control_profile");
              try {
                if (!this.profiles) throw new DomainError("unavailable");
                const ceiling = this.profiles.ceiling(sql, target);
                if (
                  !ceiling.capabilities.every((cap) =>
                    capabilities.includes(cap),
                  ) ||
                  Object.values(ceiling.limits).some(
                    (limit) => !Number.isFinite(limit) || limit < 0,
                  )
                )
                  throw new DomainError("unavailable");
                const result: Extract<
                  ControlObservation,
                  { action: "profile" }
                > = {
                  action: "profile",
                  profile: cmd.profile,
                  capabilities: [
                    ...new Set(
                      ceiling.capabilities.filter((cap) =>
                        profileCeilings[cmd.profile].includes(cap),
                      ),
                    ),
                  ],
                  limits: { ...ceiling.limits },
                };
                this.profiles.save(sql, target, result);
                sql
                  .query(
                    "INSERT INTO session_control_results(operation_id,observation_json) VALUES (?,?)",
                  )
                  .run(intent.operationID, JSON.stringify(result));
              } catch {
                // Only a verified rollback is a definitive local rejection.
                // Rollback/release/outer COMMIT failures escape as unknown_outcome.
                sql.exec("ROLLBACK TO session_control_profile");
                sql.exec("RELEASE session_control_profile");
                return false;
              }
              sql.exec("RELEASE session_control_profile");
              return true;
            });
            if (!saved) return { state: "rejected" };
            return {
              state: "admitted",
              receiptID: intent.operationID,
              channel: "inbox",
            };
          }
          const result = await this.host.execute(
            target,
            cmd,
            intent.operationID,
          );
          if (!observed(target, cmd, result))
            return { state: "unknown_outcome" };
          this.persistence.transaction((sql) => {
            if (cmd.action === "archive") this.jobs.archive(sql, target);
            if (cmd.action === "restore") this.jobs.restore(sql, target);
            sql
              .query(
                "INSERT INTO session_control_results(operation_id,observation_json) VALUES (?,?)",
              )
              .run(intent.operationID, JSON.stringify(result));
          });
          return {
            state: "admitted",
            receiptID: intent.operationID,
            channel: "host",
          };
        },
      );
    }
    const row = this.persistence.transaction((sql) =>
      sql
        .query<{ observation_json: string }, [string]>(
          "SELECT observation_json FROM session_control_results WHERE operation_id=?",
        )
        .get(operation.operationID),
    );
    return {
      operation,
      observation: row
        ? (JSON.parse(row.observation_json) as ControlObservation)
        : null,
    };
  }
}
