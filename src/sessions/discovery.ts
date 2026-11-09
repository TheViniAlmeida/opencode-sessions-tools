import type { TrustedPrincipalPort } from "../authorization/authorize";
import {
  type AuthorizationPort,
  DomainError,
  type Page,
  type Principal,
  parseSessionRef,
  type SessionRef,
} from "../contracts";

export interface DiscoveryScope {
  readonly instanceID: string;
  readonly projectID: string;
}
export interface SessionMetadata {
  readonly ref: SessionRef;
  readonly title: string;
  readonly state: string;
  readonly parent: SessionRef | null;
}
export interface SessionLink {
  readonly source: SessionRef;
  readonly target: SessionRef;
}
/** Trusted adapter boundary, not native DTOs. No history method is available.
 * candidates() must enumerate the observed scope completely (including native
 * pages); get() maps native session 404 to null, other failures to DomainError.
 * links() returns organizational links, never implicit grants.
 */
export interface DiscoveryHostPort {
  candidates(scope: DiscoveryScope): Promise<readonly SessionRef[]>;
  get(ref: SessionRef): Promise<SessionMetadata | null>;
  links(ref: SessionRef): Promise<readonly SessionLink[]>;
}
/** T18 supplies durable missing-reference reconciliation; discovery only signals it. */
export interface MissingSessionPort {
  missing(ref: SessionRef): Promise<void>;
}
export interface DiscoveryQuery extends DiscoveryScope {
  readonly limit?: number;
  readonly cursor?: string;
}
export interface TreePage extends Page<SessionMetadata> {
  readonly links: readonly SessionLink[];
}
type Snapshot = {
  principal: Principal;
  query: string;
  refs: readonly SessionRef[];
  offset: number;
  expires: number;
};
const key = (ref: SessionRef) =>
  JSON.stringify([ref.instanceID, ref.sessionID]);
const same = (a: SessionRef, b: SessionRef) =>
  key(a) === key(b) && a.projectID === b.projectID;

export class DiscoveryService {
  // Process-local, five-minute cursors freeze only the observed candidate IDs.
  // They do not promise a global/native snapshot: metadata, edges and ACLs are
  // read afresh. Restart invalidates cursors; newly created IDs need a new query.
  private readonly cursors = new Map<string, Snapshot>();

  constructor(
    private readonly identity: TrustedPrincipalPort,
    private readonly authorization: AuthorizationPort,
    private readonly host: DiscoveryHostPort,
    private readonly reconciliation: MissingSessionPort,
    private readonly now: () => number = Date.now,
  ) {}

  /** Claims are deliberately ignored; only the boundary supplies identity. */
  async current(_claims?: unknown): Promise<SessionRef> {
    const actor = await this.actor();
    if (actor.kind !== "session") throw new DomainError("forbidden");
    return parseSessionRef(actor.session);
  }

  async get(input: SessionRef): Promise<SessionMetadata> {
    const actor = await this.actor();
    const ref = parseSessionRef(input);
    await this.authorization.authorize(actor, ref, "discover");
    const item = await this.load(ref);
    if (!item) throw new DomainError("not_found");
    return this.project(actor, item);
  }

  async list(query: DiscoveryQuery): Promise<Page<SessionMetadata>> {
    const { items, nextCursor } = await this.page(query);
    return { items, nextCursor };
  }

  async tree(root: SessionRef, query: DiscoveryQuery): Promise<TreePage> {
    const ref = parseSessionRef(root);
    if (
      !query ||
      ref.instanceID !== query.instanceID ||
      ref.projectID !== query.projectID
    )
      throw new DomainError("invalid_input");
    return this.page(query, ref);
  }

  private async actor(): Promise<Principal> {
    const actor = await this.identity.current();
    if (!actor) throw new DomainError("forbidden");
    return actor;
  }

  private async visible(actor: Principal, ref: SessionRef): Promise<boolean> {
    try {
      await this.authorization.authorize(actor, ref, "discover");
      return true;
    } catch (error) {
      if (
        error instanceof DomainError &&
        ["not_found", "forbidden"].includes(error.code)
      )
        return false;
      throw error;
    }
  }

  private async load(ref: SessionRef): Promise<SessionMetadata | null> {
    const item = await this.hostCall(() => this.host.get(ref));
    if (item === null) {
      await this.hostCall(() => this.reconciliation.missing(ref));
      return null;
    }
    if (
      !same(parseSessionRef(item.ref), ref) ||
      typeof item.title !== "string" ||
      typeof item.state !== "string"
    )
      throw new DomainError("unavailable");
    return item;
  }

  private async hostCall<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof DomainError)
        throw new DomainError(error.code, error.retryable);
      throw new DomainError("unavailable", true);
    }
  }

  private async project(
    actor: Principal,
    item: SessionMetadata,
  ): Promise<SessionMetadata> {
    const parent = item.parent && parseSessionRef(item.parent);
    return {
      ref: parseSessionRef(item.ref),
      title: item.title,
      state: item.state,
      parent: parent && (await this.visible(actor, parent)) ? parent : null,
    };
  }

  private async page(
    query: DiscoveryQuery,
    root?: SessionRef,
  ): Promise<TreePage> {
    if (
      !query ||
      Object.keys(query).some(
        (k) => !["instanceID", "projectID", "limit", "cursor"].includes(k),
      ) ||
      typeof query.instanceID !== "string" ||
      !query.instanceID.trim() ||
      typeof query.projectID !== "string" ||
      !query.projectID.trim() ||
      (query.limit !== undefined &&
        (!Number.isInteger(query.limit) ||
          query.limit < 1 ||
          query.limit > 100)) ||
      (query.cursor !== undefined &&
        (typeof query.cursor !== "string" ||
          !/^[0-9a-f-]{36}$/.test(query.cursor)))
    )
      throw new DomainError("invalid_input");
    const actor = await this.actor();
    const limit = query.limit ?? 100;
    const binding = JSON.stringify([
      query.instanceID,
      query.projectID,
      limit,
      root ?? null,
    ]);
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new DomainError("unavailable");
    for (const [token, snapshot] of this.cursors)
      if (snapshot.expires <= now) this.cursors.delete(token);
    let snapshot: Snapshot;
    if (query.cursor !== undefined) {
      const saved = this.cursors.get(query.cursor);
      if (!saved || saved.principal !== actor || saved.query !== binding)
        throw new DomainError("invalid_input");
      snapshot = saved;
    } else {
      if (root) await this.authorization.authorize(actor, root, "discover");
      const candidates = await this.hostCall(() =>
        this.host.candidates({
          instanceID: query.instanceID,
          projectID: query.projectID,
        }),
      );
      const refs = new Map<string, SessionRef>();
      for (const candidate of candidates) {
        const ref = parseSessionRef(candidate);
        if (
          ref.instanceID !== query.instanceID ||
          ref.projectID !== query.projectID
        )
          throw new DomainError("unavailable");
        const previous = refs.get(key(ref));
        if (previous && !same(previous, ref))
          throw new DomainError("unavailable");
        refs.set(key(ref), ref);
      }
      snapshot = {
        principal: actor,
        query: binding,
        refs: [...refs.values()].sort((a, b) =>
          key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
        ),
        offset: 0,
        expires: now + 300_000,
      };
    }
    // Fresh authorization over the whole candidate set prevents counts/cursors
    // from revealing denied rows. Metadata is reloaded, not frozen by the cursor.
    const visible = new Map<string, SessionMetadata>();
    for (const ref of snapshot.refs) {
      if (!(await this.visible(actor, ref))) continue;
      const item = await this.load(ref);
      if (item) visible.set(key(ref), await this.project(actor, item));
    }
    if (visible.size === 0) {
      if (
        actor.kind !== "session" ||
        actor.session.instanceID !== query.instanceID ||
        actor.session.projectID !== query.projectID
      )
        throw new DomainError("not_found");
      await this.authorization.authorize(actor, actor.session, "discover");
    }
    const links: SessionLink[] = [];
    const ancestry: SessionLink[] = [];
    let selected = new Set(visible.keys());
    if (root) {
      if (!visible.has(key(root))) throw new DomainError("not_found");
      for (const item of visible.values()) {
        if (item.parent && visible.has(key(item.parent)))
          ancestry.push({ source: item.parent, target: item.ref });
        for (const link of await this.hostCall(() =>
          this.host.links(item.ref),
        )) {
          const source = parseSessionRef(link.source);
          const target = parseSessionRef(link.target);
          const destination = visible.get(key(target));
          if (
            same(source, item.ref) &&
            destination &&
            same(destination.ref, target)
          )
            links.push({ source, target });
        }
      }
      selected = new Set([key(root)]);
      const queue = [key(root)];
      for (let i = 0; i < queue.length; i++)
        for (const link of [...ancestry, ...links])
          if (
            key(link.source) === queue[i] &&
            !selected.has(key(link.target))
          ) {
            selected.add(key(link.target));
            queue.push(key(link.target));
          }
    }
    const remaining = snapshot.refs
      .slice(snapshot.offset)
      .filter((ref) => selected.has(key(ref)) && visible.has(key(ref)));
    const refs = remaining.slice(0, limit);
    let nextCursor: string | null = null;
    if (remaining.length > limit) {
      if (this.cursors.size >= 1024)
        throw new DomainError("rate_limited", true);
      nextCursor = crypto.randomUUID();
      const last = refs[refs.length - 1];
      if (!last) throw new DomainError("unavailable");
      this.cursors.set(nextCursor, {
        ...snapshot,
        offset: snapshot.refs.indexOf(last) + 1,
      });
    }
    const pageIDs = new Set(refs.map(key));
    return {
      items: refs.map((ref) => visible.get(key(ref)) as SessionMetadata),
      nextCursor,
      links: links.filter(
        (link, i) =>
          pageIDs.has(key(link.source)) &&
          links.findIndex(
            (other) =>
              same(other.source, link.source) &&
              same(other.target, link.target),
          ) === i,
      ),
    };
  }
}
