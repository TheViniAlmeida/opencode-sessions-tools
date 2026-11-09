import {
  type AuthorizationPort,
  type Capability,
  capabilities,
  DomainError,
  type Grant,
  type Principal,
  parseCapability,
  parseSessionRef,
  type SessionRef,
} from "../contracts";

export type Profile =
  | "observe"
  | "collaborate"
  | "manage"
  | "supervised"
  | "bounded-auto";
export type AuthorityAction =
  | "grant"
  | "policy"
  | "profile"
  | "always"
  | "configure";
export interface ScheduledOccurrence {
  readonly jobID: string;
  readonly scheduleRevision: number;
  readonly occurrenceID: string;
}
export interface AuthorizationSnapshot {
  revision: number;
  profile: Profile;
  profileCapabilities: readonly Capability[];
  policyCapabilities: readonly Capability[];
  hostCapabilities: readonly Capability[];
  deniedCapabilities: readonly Capability[];
  grants: readonly Grant[];
  operator: {
    operatorID: string;
    instanceID: string;
    revision: number;
    capabilities: readonly Capability[];
    projects: readonly string[];
    expiresAt: string | null;
  } | null;
  delegationCapabilities: readonly Capability[] | null;
  approval: {
    /** Reserved by intent, or supplied by trusted approval storage. Not model input. */
    operationID?: string;
    /** Intent reserves the delegated facets too; generic admission cannot spend it. */
    delegation?: {
      requested: readonly Capability[];
      requiredCapabilities: readonly Capability[];
    };
    scheduled?: {
      modality: "scheduled-message";
      occurrence?: ScheduledOccurrence;
    };
    principal: Principal;
    target: SessionRef;
    capability: Capability;
    revision: number;
    expiresAt: string;
    mode: "once" | "always";
  } | null;
}

/** Internal ports only. Never implement current() from payload, text, or Basic auth.
 * T3-PROD must supply the private gateway boundary; this module authenticates no credential.
 * read() must resolve current canonical scope and operator-approved records, not user claims.
 */
export interface TrustedPrincipalPort {
  current(): Promise<Principal | null>;
}
export interface AuthorizationSnapshotPort {
  read(
    principal: Principal,
    target: SessionRef,
  ): Promise<AuthorizationSnapshot>;
  /** T12/T13 adapter: load current snapshot and run callback synchronously in the
   * same local transaction as durable admission. Persist every approval mutation
   * before commit: operationID reservation as well as approval=null consumption.
   * Never perform host I/O in this callback.
   * Missing adapter fails closed; read() alone cannot admit effects.
   */
  admission?<T>(
    principal: Principal,
    target: SessionRef,
    check: (snapshot: AuthorizationSnapshot) => T,
  ): T;
}

const readOnly: readonly Capability[] = ["discover", "read", "context.read"];
const ceilings: Record<Profile, readonly Capability[]> = {
  observe: readOnly,
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
function fail(
  code: "forbidden" | "not_found" | "unavailable" | "conflict",
): never {
  throw new DomainError(code);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function capList(value: unknown): value is readonly Capability[] {
  return (
    Array.isArray(value) &&
    value.every(
      (c) => typeof c === "string" && capabilities.includes(c as Capability),
    )
  );
}
function same(a: SessionRef, b: SessionRef): boolean {
  return (
    a.instanceID === b.instanceID &&
    a.projectID === b.projectID &&
    a.sessionID === b.sessionID
  );
}
function validPrincipal(principal: Principal): void {
  if (principal?.kind === "session") parseSessionRef(principal.session);
  else if (
    principal?.kind !== "operator" ||
    !text(principal.operatorID) ||
    !text(principal.instanceID) ||
    !revision(principal.revision)
  )
    fail("forbidden");
}
function samePrincipal(a: Principal, b: Principal): boolean {
  return a.kind === "session"
    ? b.kind === "session" && same(a.session, b.session)
    : b.kind === "operator" &&
        a.operatorID === b.operatorID &&
        a.instanceID === b.instanceID &&
        a.revision === b.revision;
}
function validate(snapshot: AuthorizationSnapshot): void {
  try {
    if (
      !snapshot ||
      !revision(snapshot.revision) ||
      !Object.hasOwn(ceilings, snapshot.profile) ||
      ![
        snapshot.profileCapabilities,
        snapshot.policyCapabilities,
        snapshot.hostCapabilities,
        snapshot.deniedCapabilities,
      ].every(capList) ||
      !(
        snapshot.delegationCapabilities === null ||
        capList(snapshot.delegationCapabilities)
      ) ||
      !Array.isArray(snapshot.grants)
    )
      fail("unavailable");
    for (const g of snapshot.grants) {
      parseSessionRef(g.source);
      parseSessionRef(g.target);
      validPrincipal(g.issuer);
      if (
        g.version !== 1 ||
        !text(g.grantID) ||
        !revision(g.revision) ||
        !capList(g.capabilities) ||
        g.issuer.kind !== "operator" ||
        g.issuer.instanceID !== g.source.instanceID ||
        !timestamp(g.createdAt) ||
        !(g.expiresAt === null || timestamp(g.expiresAt))
      )
        fail("unavailable");
    }
    const o = snapshot.operator;
    if (
      o !== null &&
      (!o ||
        !text(o.operatorID) ||
        !text(o.instanceID) ||
        !revision(o.revision) ||
        !capList(o.capabilities) ||
        !Array.isArray(o.projects) ||
        !o.projects.every(text) ||
        !(o.expiresAt === null || timestamp(o.expiresAt)))
    )
      fail("unavailable");
    const a = snapshot.approval;
    if (a !== null) {
      validPrincipal(a.principal);
      parseSessionRef(a.target);
      parseCapability(a.capability);
      if (
        !revision(a.revision) ||
        !(a.operationID === undefined || text(a.operationID)) ||
        !(
          a.scheduled === undefined ||
          (a.scheduled &&
            a.scheduled.modality === "scheduled-message" &&
            text(a.operationID) &&
            a.delegation === undefined &&
            (a.scheduled.occurrence === undefined ||
              validOccurrence(a.scheduled.occurrence)))
        ) ||
        !(
          a.delegation === undefined ||
          (a.delegation &&
            capList(a.delegation.requested) &&
            capList(a.delegation.requiredCapabilities) &&
            a.delegation.requiredCapabilities.every((c) => c === "read") &&
            text(a.operationID))
        ) ||
        !timestamp(a.expiresAt) ||
        !["once", "always"].includes(a.mode)
      )
        fail("unavailable");
    }
  } catch {
    fail("unavailable");
  }
}

export class Authorizer implements AuthorizationPort {
  constructor(
    private readonly identity: TrustedPrincipalPort,
    private readonly snapshots: AuthorizationSnapshotPort,
    private readonly now: () => number,
  ) {}

  private async context(principal: Principal, target: SessionRef) {
    await this.authenticate(principal, target);
    const snapshot = await this.snapshots.read(principal, target);
    return this.checkedContext(snapshot);
  }

  private async authenticate(principal: Principal, target: SessionRef) {
    parseSessionRef(target);
    await this.authenticateCaller(principal);
  }

  private async authenticateCaller(principal: Principal) {
    validPrincipal(principal);
    // Object provenance, not matching IDs: caller must use the boundary's principal.
    if ((await this.identity.current()) !== principal) fail("forbidden");
  }

  private checkedContext(snapshot: AuthorizationSnapshot) {
    validate(snapshot);
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) fail("unavailable");
    return { snapshot, now };
  }

  private check(
    principal: Principal,
    target: SessionRef,
    capability: Capability,
    s: AuthorizationSnapshot,
    now: number,
    requireApproval = true,
  ): void {
    const cross =
      principal.kind === "session" &&
      (principal.session.instanceID !== target.instanceID ||
        principal.session.projectID !== target.projectID);
    const deny = (): never => fail(cross ? "not_found" : "forbidden");
    if (
      !ceilings[s.profile].includes(capability) ||
      !s.profileCapabilities.includes(capability) ||
      !s.policyCapabilities.includes(capability) ||
      !s.hostCapabilities.includes(capability) ||
      s.deniedCapabilities.includes(capability)
    )
      deny();
    if (principal.kind === "operator") {
      const o = s.operator;
      if (
        !o ||
        o.operatorID !== principal.operatorID ||
        o.instanceID !== principal.instanceID ||
        o.instanceID !== target.instanceID ||
        o.revision !== principal.revision ||
        !o.projects.includes(target.projectID) ||
        !o.capabilities.includes(capability) ||
        (o.expiresAt !== null && Date.parse(o.expiresAt) <= now)
      )
        deny();
    } else {
      if (
        s.delegationCapabilities !== null &&
        !s.delegationCapabilities.includes(capability)
      )
        deny();
      const self = same(principal.session, target);
      if (self && capability === "session.configure") deny();
      const minimal =
        !cross && (capability === "discover" || capability === "message");
      const granted = s.grants.some(
        (g) =>
          same(g.source, principal.session) &&
          same(g.target, target) &&
          g.capabilities.includes(capability) &&
          Date.parse(g.createdAt) <= now &&
          (g.expiresAt === null || Date.parse(g.expiresAt) > now),
      );
      if (!minimal && !granted) deny();
    }
    if (
      requireApproval &&
      s.profile === "supervised" &&
      !readOnly.includes(capability)
    ) {
      const a = s.approval;
      if (
        a?.mode !== "once" ||
        !samePrincipal(a.principal, principal) ||
        !same(a.target, target) ||
        a.capability !== capability ||
        a.revision !== s.revision ||
        Date.parse(a.expiresAt) <= now
      )
        deny();
    }
  }

  async authorize(
    principal: Principal,
    target: SessionRef,
    capability: Capability,
  ): Promise<void> {
    parseCapability(capability);
    const { snapshot, now } = await this.context(principal, target);
    this.check(principal, target, capability, snapshot, now);
  }

  async authorizeAction(
    principal: Principal,
    target: SessionRef,
    action: AuthorityAction,
  ): Promise<void> {
    if (!["grant", "policy", "profile", "always", "configure"].includes(action))
      throw new DomainError("invalid_input");
    if (action !== "configure" && principal?.kind !== "operator")
      fail("forbidden");
    await this.authorize(
      principal,
      target,
      action === "configure" ? "session.configure" : "manage",
    );
  }

  /** MSG-05: caller-owned stored operation view only. owner MUST come from the
   * trusted operation row/caller_scope, never the request. Does not read the
   * target, authorize another delivery, or bypass dispatch revalidation.
   * current() must supply a currently authenticated, non-revoked identity.
   */
  async authorizeReplay(principal: Principal, owner: Principal): Promise<void> {
    await this.authenticateCaller(principal);
    validPrincipal(owner);
    const owned =
      principal.kind === "session"
        ? owner.kind === "session" && same(principal.session, owner.session)
        : owner.kind === "operator" &&
          principal.instanceID === owner.instanceID &&
          principal.operatorID === owner.operatorID;
    if (!owned) fail("not_found");
  }

  /** Persist intent only, NOT permission for host effects. Requires the same
   * current approval as dispatch, but does not consume it: enqueue is not a
   * delivery admission. Generate operationID internally before insertion; an
   * operator may approve principal/target/capability/revision beforehand. Intent
   * reserves that once for this ID atomically, without consuming it.
   */
  async authorizeIntent<T>(
    principal: Principal,
    target: SessionRef,
    capability: Capability,
    expectedRevision: number,
    operationID: string,
    persistIntent: () => T,
  ): Promise<T> {
    return this.operationBoundary(
      principal,
      target,
      capability,
      expectedRevision,
      operationID,
      false,
      persistIntent,
    );
  }

  /** Consume once with pending->dispatching in admission()'s SAME local
   * transaction. Callback must reject stale state/lease; rollback restores once.
   * Host dispatch happens only after the adapter committed successfully.
   */
  async admitOperation<T>(
    principal: Principal,
    target: SessionRef,
    capability: Capability,
    expectedRevision: number,
    operationID: string,
    admitLocal: () => T,
  ): Promise<T> {
    return this.operationBoundary(
      principal,
      target,
      capability,
      expectedRevision,
      operationID,
      true,
      admitLocal,
    );
  }

  private async operationBoundary<T>(
    principal: Principal,
    target: SessionRef,
    capability: Capability,
    expectedRevision: number,
    operationID: string,
    consume: boolean,
    local: () => T,
  ): Promise<T> {
    parseCapability(capability);
    if (!revision(expectedRevision) || !text(operationID))
      throw new DomainError("invalid_input");
    await this.authenticate(principal, target);
    if (!this.snapshots.admission) fail("unavailable");
    return this.snapshots.admission(principal, target, (snapshot) => {
      const { now } = this.checkedContext(snapshot);
      this.check(principal, target, capability, snapshot, now);
      if (snapshot.revision !== expectedRevision) fail("conflict");
      if (snapshot.profile === "supervised" && !readOnly.includes(capability)) {
        if (
          snapshot.approval?.delegation !== undefined ||
          snapshot.approval?.scheduled !== undefined
        )
          fail("forbidden");
        if (
          !consume &&
          snapshot.approval &&
          snapshot.approval.operationID === undefined
        )
          snapshot.approval.operationID = operationID;
        if (snapshot.approval?.operationID !== operationID) fail("forbidden");
        if (consume) snapshot.approval = null;
      }
      return local();
    });
  }

  /** Durable LOCAL admission callback only, never a host call. T13 owns commit
   * and dispatch after commit. This is NOT a fence against the host.
   */
  async admit<T>(
    principal: Principal,
    target: SessionRef,
    capability: Capability,
    expectedRevision: number,
    effect: () => T,
  ): Promise<T> {
    parseCapability(capability);
    if (!revision(expectedRevision)) throw new DomainError("invalid_input");
    await this.authenticate(principal, target);
    if (!this.snapshots.admission) fail("unavailable");
    return this.snapshots.admission(principal, target, (snapshot) => {
      const { now } = this.checkedContext(snapshot);
      this.check(principal, target, capability, snapshot, now);
      if (snapshot.revision !== expectedRevision) fail("conflict");
      if (snapshot.profile === "supervised" && !readOnly.includes(capability)) {
        // Operation-bound approvals cannot be spent via the legacy action API.
        if (snapshot.approval?.operationID !== undefined) fail("forbidden");
        snapshot.approval = null;
      }
      return effect();
    });
  }

  async delegate<T>(
    principal: Principal,
    target: SessionRef,
    requested: readonly Capability[],
    effect: () => T,
  ): Promise<
    | { state: "awaiting_approval" }
    | {
        state: "admitted";
        data: T;
        capabilities: readonly Capability[];
        revision: number;
      }
  > {
    if (!capList(requested)) throw new DomainError("invalid_input");
    await this.authenticate(principal, target);
    if (!this.snapshots.admission) fail("unavailable");
    return this.snapshots.admission(principal, target, (snapshot) => {
      const { now } = this.checkedContext(snapshot);
      if (snapshot.delegationCapabilities === null)
        return { state: "awaiting_approval" as const };
      // Creation itself is management, even an empty delegated capability set.
      this.check(principal, target, "manage", snapshot, now);
      if (
        snapshot.profile === "supervised" &&
        snapshot.approval?.operationID !== undefined
      )
        fail("forbidden");
      for (const c of requested) {
        if (!snapshot.delegationCapabilities.includes(c)) fail("forbidden");
        this.check(principal, target, c, snapshot, now, false);
      }
      if (snapshot.profile === "supervised") snapshot.approval = null;
      const effective = [...new Set(requested)];
      return {
        state: "admitted" as const,
        data: effect(),
        capabilities: effective,
        revision: snapshot.revision,
      };
    });
  }

  /** T16 adapter for create/fork, inside the SAME admission() transaction as
   * intent insertion or pending->dispatching. requiredCapabilities is selected by
   * the trusted facade: [] for create, ["read"] for fork; not model authority.
   * One manage approval covers the operation. Extra read is independently
   * checked, never separately approved/consumed. Host I/O stays after commit.
   */
  async delegatedOperation<T>(
    principal: Principal,
    target: SessionRef,
    requested: readonly Capability[],
    expectedRevision: number,
    operationID: string,
    phase: "intent" | "admission",
    requiredCapabilities: readonly Capability[],
    local: () => T,
  ): Promise<
    | { state: "awaiting_approval" }
    | {
        state: "admitted";
        data: T;
        capabilities: readonly Capability[];
        revision: number;
      }
  > {
    if (
      !capList(requested) ||
      !revision(expectedRevision) ||
      !text(operationID) ||
      !["intent", "admission"].includes(phase) ||
      !capList(requiredCapabilities) ||
      !requiredCapabilities.every((c) => c === "read")
    )
      throw new DomainError("invalid_input");
    await this.authenticate(principal, target);
    if (!this.snapshots.admission) fail("unavailable");
    return this.snapshots.admission(principal, target, (snapshot) => {
      const { now } = this.checkedContext(snapshot);
      if (snapshot.revision !== expectedRevision) fail("conflict");
      if (snapshot.delegationCapabilities === null)
        return { state: "awaiting_approval" as const };
      this.check(principal, target, "manage", snapshot, now);
      for (const c of requiredCapabilities)
        this.check(principal, target, c, snapshot, now, false);
      for (const c of requested) {
        if (!snapshot.delegationCapabilities.includes(c)) fail("forbidden");
        this.check(principal, target, c, snapshot, now, false);
      }
      const effective = [...new Set(requested)];
      const required = [...new Set(requiredCapabilities)];
      if (snapshot.profile === "supervised") {
        const approval = snapshot.approval;
        if (!approval) fail("forbidden");
        if (approval.scheduled !== undefined) fail("forbidden");
        if (
          phase === "intent" &&
          approval.delegation === undefined &&
          (approval.operationID === undefined ||
            approval.operationID === operationID)
        ) {
          approval.operationID = operationID;
          approval.delegation = {
            requested: effective,
            requiredCapabilities: required,
          };
        }
        const bound = approval.delegation;
        if (
          approval.operationID !== operationID ||
          !bound ||
          !sameCapabilities(bound.requested, effective) ||
          !sameCapabilities(bound.requiredCapabilities, required)
        )
          fail("forbidden");
        if (phase === "admission") snapshot.approval = null;
      }
      return {
        state: "admitted" as const,
        data: local(),
        capabilities: effective,
        revision: snapshot.revision,
      };
    });
  }

  /** T20 facade only: schedule.manage approves this occurrence; message remains
   * a fresh capability prerequisite, NOT a second supervised approval. IDs come
   * from Operations (real operationID) and trusted scheduler storage, never an
   * occurrence ID substituted for operationID. Optional occurrence, when supplied,
   * must match at both phases. Callback is local SQL, host I/O only after commit.
   */
  async scheduledOperation<T>(
    principal: Principal,
    target: SessionRef,
    expectedRevision: number,
    realOperationID: string,
    phase: "intent" | "admission",
    local: () => T,
    occurrence?: ScheduledOccurrence,
  ): Promise<T> {
    if (
      !revision(expectedRevision) ||
      !text(realOperationID) ||
      !["intent", "admission"].includes(phase) ||
      !(occurrence === undefined || validOccurrence(occurrence))
    )
      throw new DomainError("invalid_input");
    await this.authenticate(principal, target);
    if (!this.snapshots.admission) fail("unavailable");
    return this.snapshots.admission(principal, target, (snapshot) => {
      const { now } = this.checkedContext(snapshot);
      if (snapshot.revision !== expectedRevision) fail("conflict");
      this.check(principal, target, "schedule.manage", snapshot, now);
      this.check(principal, target, "message", snapshot, now, false);
      if (snapshot.profile === "supervised") {
        const approval = snapshot.approval;
        if (!approval || approval.delegation !== undefined) fail("forbidden");
        if (
          phase === "intent" &&
          approval.scheduled === undefined &&
          (approval.operationID === undefined ||
            approval.operationID === realOperationID)
        ) {
          approval.operationID = realOperationID;
          approval.scheduled = {
            modality: "scheduled-message",
            ...(occurrence === undefined
              ? {}
              : { occurrence: { ...occurrence } }),
          };
        }
        const bound = approval.scheduled;
        if (
          approval.operationID !== realOperationID ||
          bound?.modality !== "scheduled-message" ||
          !sameOccurrence(bound.occurrence, occurrence)
        )
          fail("forbidden");
        if (phase === "admission") snapshot.approval = null;
      }
      return local();
    });
  }
}

function validOccurrence(value: ScheduledOccurrence): boolean {
  return (
    !!value &&
    text(value.jobID) &&
    revision(value.scheduleRevision) &&
    text(value.occurrenceID)
  );
}
function sameOccurrence(
  a: ScheduledOccurrence | undefined,
  b: ScheduledOccurrence | undefined,
): boolean {
  return a === undefined || b === undefined
    ? a === b
    : a.jobID === b.jobID &&
        a.scheduleRevision === b.scheduleRevision &&
        a.occurrenceID === b.occurrenceID;
}

function sameCapabilities(
  a: readonly Capability[],
  b: readonly Capability[],
): boolean {
  const left = new Set(a);
  return left.size === new Set(b).size && b.every((c) => left.has(c));
}
