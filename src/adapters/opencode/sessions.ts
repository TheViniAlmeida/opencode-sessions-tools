import {
  isSessionNotFoundError,
  type LocationPublicRef,
  type SessionApi,
  type SessionInfo,
} from "@opencode/client";
import { DomainError, type SessionRef } from "../../contracts";
import type {
  ControlCommand,
  ControlHostPort,
  ControlObservation,
} from "../../sessions/control";
import type { CreationHostPort, CreationPlan } from "../../sessions/create";
import type {
  DiscoveryHostPort,
  DiscoveryScope,
} from "../../sessions/discovery";
import type { ReconciliationHostPort } from "../../sessions/reconcile";

/** Installation-owned routing, never a project/directory supplied by a tool. */
export interface NativeSessionCatalog {
  resolve(
    scope: DiscoveryScope,
  ): (DiscoveryScope & { readonly location: LocationPublicRef }) | null;
}
export interface NativeSelectionCatalog {
  validate(
    scope: DiscoveryScope,
    command: Extract<ControlCommand, { action: "model" | "agent" }>,
  ): Promise<boolean>;
}
export interface NativeSessionsOptions {
  readonly session: Pick<
    SessionApi,
    | "get"
    | "list"
    | "create"
    | "update"
    | "switchModel"
    | "switchAgent"
    | "interrupt"
    | "compact"
  >;
  /** Trusted full SDK client authority: absent from Plugin.Context.session 2.2.5. */
  readonly fork?: Pick<SessionApi, "fork">;
  /** Optional installation-owned HTTP authority, never URL/token discovery.
   * SDK 2.2.5 declared errors discard HTTP status; tag alone cannot prove 404. */
  readonly absence?: {
    request(method: "GET", path: `/api/session/${string}`): Promise<Response>;
  };
  readonly catalog: NativeSessionCatalog;
  readonly selections: NativeSelectionCatalog;
  /** Organizational links are supplied by their local owner, never inferred. */
  readonly links?: DiscoveryHostPort["links"];
}
export interface NativeSessions {
  readonly creation: CreationHostPort;
  readonly control: ControlHostPort;
  readonly discovery: DiscoveryHostPort;
  readonly reconciliation: ReconciliationHostPort;
}
const marker = "session-orchestration.creation";
const unavailable = () => new DomainError("unavailable");
const sameScope = (a: DiscoveryScope, b: DiscoveryScope) =>
  a.instanceID === b.instanceID && a.projectID === b.projectID;
const proof = (plan: CreationPlan) =>
  JSON.stringify([
    plan.operationID,
    plan.kind,
    plan.source.instanceID,
    plan.source.projectID,
    plan.source.sessionID,
    plan.destination.instanceID,
    plan.destination.projectID,
    plan.planned?.sessionID ?? null,
    plan.parent?.sessionID ?? null,
  ]);

/** No registrations, listener, credentials, DB access, background work or deletion. */
export function createNativeSessions(
  options: NativeSessionsOptions,
): NativeSessions {
  const { session, catalog } = options;
  function route(scope: DiscoveryScope) {
    let resolved: ReturnType<NativeSessionCatalog["resolve"]>;
    try {
      resolved = catalog.resolve(scope);
    } catch {
      throw unavailable();
    }
    if (
      !resolved ||
      !sameScope(scope, resolved) ||
      !resolved.location.directory.startsWith("/")
    )
      throw unavailable();
    return resolved;
  }
  function reference(info: SessionInfo, scope: DiscoveryScope): SessionRef {
    const trusted = route(scope);
    if (
      !info.id ||
      info.projectID !== trusted.projectID ||
      info.location.directory !== trusted.location.directory
    )
      throw unavailable();
    return {
      version: 1,
      instanceID: trusted.instanceID,
      projectID: trusted.projectID,
      sessionID: info.id,
    };
  }
  async function read(ref: SessionRef): Promise<SessionInfo | null> {
    route(ref);
    let info: SessionInfo;
    try {
      info = await session.get({ sessionID: ref.sessionID });
    } catch (error) {
      if (isSessionNotFoundError(error) && options.absence) {
        try {
          const response = await options.absence.request(
            "GET",
            `/api/session/${encodeURIComponent(ref.sessionID)}`,
          );
          await response.body?.cancel();
          if (response.status === 404) return null;
        } catch {
          throw unavailable();
        }
      }
      throw unavailable();
    }
    if (reference(info, ref).sessionID !== ref.sessionID) throw unavailable();
    return info;
  }
  async function required(ref: SessionRef) {
    const info = await read(ref);
    if (!info) throw unavailable();
    return info;
  }
  async function safe<T>(effect: () => Promise<T>): Promise<T> {
    try {
      return await effect();
    } catch {
      throw unavailable();
    }
  }
  function preflight(plan: CreationPlan) {
    route(plan.source);
    const destination = route(plan.destination);
    // Native parent/fork cannot move a session between installations/locations.
    if (plan.kind !== "root" && !sameScope(plan.source, plan.destination))
      throw unavailable();
    if (plan.kind === "fork") {
      if (!options.fork || plan.planned !== null) throw unavailable();
    } else if (
      !plan.planned ||
      !sameScope(plan.planned, plan.destination) ||
      !plan.planned.sessionID ||
      plan.planned.sessionID === plan.source.sessionID
    )
      throw unavailable();
    if (
      plan.kind === "child" &&
      (!plan.parent ||
        !sameScope(plan.parent, plan.source) ||
        plan.parent.sessionID !== plan.source.sessionID)
    )
      throw unavailable();
    if (plan.kind === "root" && plan.parent !== null) throw unavailable();
    return destination;
  }
  const creation: CreationHostPort = {
    async execute(plan) {
      let destination: ReturnType<typeof route>;
      try {
        destination = preflight(plan);
      } catch {
        return { state: "pre_effect_unavailable" };
      }
      // From the first host read onward failures remain uncertain, never no-effect.
      await required(plan.source);
      const info = await safe(async () => {
        if (plan.kind === "fork") {
          const fork = options.fork;
          if (!fork) throw unavailable();
          return fork.fork({ sessionID: plan.source.sessionID });
        }
        return session.create({
          id: plan.planned?.sessionID,
          location: destination.location,
          ...(plan.kind === "child" ? { parentID: plan.source.sessionID } : {}),
          metadata: { [marker]: proof(plan) },
        });
      });
      const ref = reference(info, destination);
      if (plan.kind === "fork") {
        if (
          info.fork?.sessionID !== plan.source.sessionID ||
          info.id === plan.source.sessionID
        )
          throw unavailable();
      } else if (
        info.id !== plan.planned?.sessionID ||
        info.metadata?.[marker] !== proof(plan) ||
        (info.parentID ?? null) !==
          (plan.kind === "child" ? plan.source.sessionID : null)
      )
        throw unavailable();
      return { state: "created", session: ref };
    },
    async inspect(plan) {
      preflight(plan);
      // Fork has no atomic operation marker in 2.2.5; lineage alone is not correlation.
      if (plan.kind === "fork") return null;
      const candidate = plan.observed ?? plan.planned;
      if (
        !candidate ||
        !plan.planned ||
        !sameScope(candidate, plan.planned) ||
        candidate.sessionID !== plan.planned.sessionID
      )
        return null;
      const info = await read(candidate);
      if (
        !info ||
        info.metadata?.[marker] !== proof(plan) ||
        (info.parentID ?? null) !==
          (plan.kind === "child" ? plan.source.sessionID : null)
      )
        return null;
      return reference(info, plan.destination);
    },
  };
  const discovery: DiscoveryHostPort = {
    async candidates(scope) {
      const trusted = route(scope);
      const refs: SessionRef[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await safe(() =>
          session.list({
            directory: trusted.location.directory,
            project: trusted.projectID,
            limit: 100,
            cursor,
          }),
        );
        for (const info of page.data) refs.push(reference(info, scope));
        cursor = page.cursor.next ?? undefined;
        if (cursor && cursors.has(cursor)) throw unavailable();
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return refs;
    },
    async get(ref) {
      const info = await read(ref);
      if (!info) return null;
      return {
        ref: reference(info, ref),
        title: info.title ?? "",
        state: info.time.archived !== undefined ? "archived" : "active",
        parent: info.parentID
          ? {
              version: 1,
              instanceID: ref.instanceID,
              projectID: ref.projectID,
              sessionID: info.parentID,
            }
          : null,
      };
    },
    async links(ref) {
      route(ref);
      const links = options.links;
      if (!links) throw unavailable();
      return safe(() => links(ref));
    },
  };
  async function validate(target: SessionRef, command: ControlCommand) {
    route(target);
    if (
      command.action === "style" ||
      command.action === "profile" ||
      (command.action === "reset" && command.transfer.includes("style"))
    )
      throw unavailable();
    if (
      (command.action === "model" || command.action === "agent") &&
      !(await safe(() => options.selections.validate(target, command)))
    )
      throw unavailable();
  }
  const control: ControlHostPort = {
    validate,
    async execute(target, command, operationID): Promise<ControlObservation> {
      await validate(target, command);
      if (!operationID.trim()) throw unavailable();
      const before = await required(target);
      const sessionID = target.sessionID;
      switch (command.action) {
        case "rename":
          await safe(() => session.update({ sessionID, title: command.title }));
          if ((await required(target)).title !== command.title)
            throw unavailable();
          return { action: "rename", title: command.title };
        case "archive":
        case "restore": {
          const archived = command.action === "archive";
          await safe(() => session.update({ sessionID, archived }));
          if (
            ((await required(target)).time.archived !== undefined) !==
            archived
          )
            throw unavailable();
          return archived
            ? { action: "archive", archived: true }
            : { action: "restore", archived: false };
        }
        case "model":
          await safe(() =>
            session.switchModel({
              sessionID,
              model: { providerID: command.providerID, id: command.modelID },
            }),
          );
          {
            const info = await required(target);
            if (
              info.model?.id !== command.modelID ||
              info.model.providerID !== command.providerID
            )
              throw unavailable();
          }
          return { ...command, appliesTo: "future_executions" };
        case "agent":
          await safe(() =>
            session.switchAgent({ sessionID, agent: command.agent }),
          );
          if ((await required(target)).agent !== command.agent)
            throw unavailable();
          return { ...command, appliesTo: "future_executions" };
        case "interrupt": {
          const result = await safe(() =>
            session.interrupt({ sessionID, resume: false }),
          );
          return {
            action: "interrupt",
            requested: true,
            interrupted: result.interrupted,
          };
        }
        case "compact": {
          const result = await safe(() =>
            session.compact({ sessionID, id: operationID, delivery: "queue" }),
          );
          if (
            result.id !== operationID ||
            result.sessionID !== sessionID ||
            result.type !== "compaction"
          )
            throw unavailable();
          return { action: "compact", status: "admitted" };
        }
        case "reset": {
          const trusted = route(target);
          const result = await safe(() =>
            session.create({
              location: trusted.location,
              ...(command.transfer.includes("model") && before.model
                ? { model: before.model }
                : {}),
              ...(command.transfer.includes("agent") && before.agent
                ? { agent: before.agent }
                : {}),
              metadata: {
                [marker]: JSON.stringify([
                  operationID,
                  "reset",
                  sessionID,
                  command.transfer,
                ]),
              },
            }),
          );
          const successor = reference(result, target);
          if (
            successor.sessionID === sessionID ||
            result.parentID ||
            result.fork
          )
            throw unavailable();
          if (
            command.transfer.includes("model") &&
            before.model &&
            JSON.stringify(before.model) !== JSON.stringify(result.model)
          )
            throw unavailable();
          if (
            command.transfer.includes("agent") &&
            before.agent &&
            before.agent !== result.agent
          )
            throw unavailable();
          return { action: "reset", successor };
        }
        default:
          throw unavailable();
      }
    },
  };
  return { creation, control, discovery, reconciliation: { get: read } };
}
