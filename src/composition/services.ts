import { Authorizer } from "../authorization/authorize";
import { Grants } from "../authorization/grants";
import {
  type ContextExportHostPort,
  ContextExportService,
} from "../context/export";
import {
  ContextImportService,
  contextImportCleanup,
  type ImportDestinationPort,
  type ImportHostPort,
} from "../context/import";
import { type MemoryGroupPort, SharedMemory } from "../context/memory";
import { DomainError } from "../contracts";
import { type GroupActiveWorkPort, Groups } from "../groups/service";
import { Inbox, inboxCleanupPort } from "../messaging/inbox";
import { repliesRemovedCleanup } from "../messaging/replies";
import { Events } from "../observability/events";
import {
  COMPOSITION_LINEAGE,
  COMPOSITION_VERSION,
  domainFingerprint,
  expectedCompositionFingerprint,
  schemaFingerprint,
} from "../persistence/migrations";
import { Operations, pendingGrantOperations } from "../persistence/operations";
import {
  type DiscoveryHostPort,
  DiscoveryService,
} from "../sessions/discovery";
import {
  ReconciliationService,
  type RemovedSessionCleanupPort,
  removedTargetPort,
} from "../sessions/reconcile";
import {
  type AuthenticatedOperatorPort,
  InvocationIdentity,
  type TrustedSessionResolver,
} from "./identity";
import { CanonicalPolicy } from "./policy";
import type { CompositionRuntime } from "./runtime";

/** Trusted internal dependencies, never tool input. No database creation or migration. */
export interface ComposedServicesOptions {
  readonly runtime: CompositionRuntime;
  readonly sessions: TrustedSessionResolver;
  readonly operators: AuthenticatedOperatorPort;
  readonly discovery: DiscoveryHostPort;
  readonly activeWork: GroupActiveWorkPort;
  readonly memoryGroups: MemoryGroupPort;
  readonly importHost: ImportHostPort;
  readonly importDestination: ImportDestinationPort;
  readonly exportHost: ContextExportHostPort;
  /** Required cleanup for unassembled domains (requests/tasks/jobs/etc.). Same DB only. */
  readonly remainingCleanup: RemovedSessionCleanupPort;
  readonly clock: () => number;
}

/** Partial local graph only: no Runner, prompts, outcomes, transport or timers. */
export function createComposedServices(options: ComposedServicesOptions) {
  const { runtime, clock } = options;
  const storage = runtime.persistence;
  storage.transaction((sql) => {
    const stamp = sql
      .query<{ lineage: string; fingerprint: string }, []>(
        "SELECT lineage,fingerprint FROM composition_lineage WHERE singleton=1",
      )
      .get();
    if (
      storage.version !== COMPOSITION_VERSION ||
      stamp?.lineage !== COMPOSITION_LINEAGE ||
      stamp.fingerprint !== schemaFingerprint(sql) ||
      domainFingerprint(sql) !==
        expectedCompositionFingerprint(COMPOSITION_VERSION)
    )
      throw new DomainError("unavailable");
  });
  if (
    !options.activeWork ||
    !options.memoryGroups ||
    !options.remainingCleanup ||
    typeof clock !== "function"
  )
    throw new DomainError("unavailable");
  const identity = new InvocationIdentity(
    runtime.ownership.instanceID,
    options.sessions,
    options.operators,
  );
  const policy = new CanonicalPolicy(
    storage,
    runtime.ownership.instanceID,
    identity,
    clock,
  );
  const authorizer = new Authorizer(identity, policy, clock);
  const operations = new Operations(
    storage,
    authorizer,
    clock,
    removedTargetPort,
  );
  const grants = new Grants(
    storage,
    identity,
    policy,
    pendingGrantOperations(clock),
    clock,
  );
  const importedCleanup = contextImportCleanup(clock);
  const reconciliation = new ReconciliationService(
    storage,
    identity,
    authorizer,
    options.discovery,
    {
      cleanup(sql, ref) {
        // Validate connection identity before any composed cleanup writes.
        storage.transaction((current) => {
          if (current !== sql || !sql.inTransaction)
            throw new DomainError("unavailable");
          for (const port of [
            inboxCleanupPort,
            importedCleanup,
            repliesRemovedCleanup,
            options.remainingCleanup,
          ]) {
            const result: unknown = port.cleanup(sql, ref);
            if (
              result &&
              typeof (result as { then?: unknown }).then === "function"
            )
              throw new DomainError("unavailable");
          }
        });
      },
    },
    clock,
  );
  const events = new Events(storage, identity, authorizer, clock);
  // Events accepts a transaction handle; the composition additionally binds it
  // to the canonical connection rather than trusting any SQLite transaction.
  const append = events.appendInTransaction.bind(events);
  events.appendInTransaction = (sql, input, actor) =>
    storage.transaction((current) => {
      if (sql !== current || !sql.inTransaction)
        throw new DomainError("unavailable");
      return append(sql, input, actor);
    });
  return {
    identity,
    policy,
    authorizer,
    operations,
    grants,
    reconciliation,
    events,
    discovery: new DiscoveryService(
      identity,
      authorizer,
      options.discovery,
      reconciliation,
      clock,
    ),
    groups: new Groups(storage, identity, policy, options.activeWork, clock),
    inbox: new Inbox(storage, identity, authorizer, clock, removedTargetPort),
    contextImport: new ContextImportService(
      storage,
      identity,
      authorizer,
      options.importHost,
      options.importDestination,
      removedTargetPort,
      clock,
    ),
    contextExport: new ContextExportService(
      identity,
      authorizer,
      options.exportHost,
      clock,
    ),
    sharedMemory: new SharedMemory(
      storage,
      identity,
      policy,
      clock,
      options.memoryGroups,
    ),
  };
}
