import { AsyncLocalStorage } from "node:async_hooks";
import type { TrustedPrincipalPort } from "../authorization/authorize";
import {
  DomainError,
  type OperatorPrincipal,
  type Principal,
  parseSessionRef,
  type SessionRef,
} from "../contracts";

/** Private host boundary only. This object must never be populated from tool input. */
export interface HostInvocationContext {
  readonly sessionID: string;
}
export interface TrustedSessionResolver {
  /** Resolve native session metadata and validate installation/project/location ownership. */
  resolve(context: HostInvocationContext): Promise<SessionRef | null>;
}
export interface AuthenticatedOperatorPort {
  /** Gateway authentication callback, not Basic auth or a serialized principal. */
  current(): Promise<OperatorPrincipal | null>;
}

export class InvocationIdentity implements TrustedPrincipalPort {
  private readonly calls = new AsyncLocalStorage<Principal>();
  constructor(
    private readonly instanceID: string,
    private readonly sessions: TrustedSessionResolver,
    private readonly operators: AuthenticatedOperatorPort,
  ) {
    if (!instanceID?.trim() || !sessions || !operators)
      throw new DomainError("unavailable");
  }
  async current(): Promise<Principal | null> {
    return this.calls.getStore() ?? null;
  }
  /** Internal entrypoint invoked with native ToolContext, never registered as a tool. */
  async runWithHostContext<T>(
    context: HostInvocationContext,
    call: (principal: Principal) => Promise<T>,
  ): Promise<T> {
    if (
      !context ||
      typeof context.sessionID !== "string" ||
      !context.sessionID.trim()
    )
      throw new DomainError("forbidden");
    const resolved = await this.sessions.resolve(
      Object.freeze({ sessionID: context.sessionID }),
    );
    if (!resolved) throw new DomainError("forbidden");
    const session = parseSessionRef(resolved);
    if (
      session.sessionID !== context.sessionID ||
      session.instanceID !== this.instanceID
    )
      throw new DomainError("forbidden");
    Object.freeze(session);
    const principal: Principal = Object.freeze({ kind: "session", session });
    return this.calls.run(principal, () => call(principal));
  }
  /** Only the private authenticated gateway invokes this; no principal argument. */
  async runWithAuthenticatedOperator<T>(
    call: (principal: OperatorPrincipal) => Promise<T>,
  ): Promise<T> {
    const authenticated = await this.operators.current();
    if (
      authenticated?.kind !== "operator" ||
      authenticated.instanceID !== this.instanceID ||
      !authenticated.operatorID?.trim() ||
      !Number.isSafeInteger(authenticated.revision) ||
      authenticated.revision < 0
    )
      throw new DomainError("forbidden");
    const principal: OperatorPrincipal = Object.freeze({
      kind: "operator",
      operatorID: authenticated.operatorID,
      instanceID: authenticated.instanceID,
      revision: authenticated.revision,
    });
    return this.calls.run(principal, () => call(principal));
  }
}
