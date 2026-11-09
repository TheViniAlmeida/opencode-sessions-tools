import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { createHarness } from "../../scripts/harness";
import {
  type AuthorizationSnapshot,
  Authorizer,
} from "../../src/authorization/authorize";
import {
  capabilities,
  DomainError,
  type Principal,
  type SessionRef,
} from "../../src/contracts";
import {
  type DiscoveryHostPort,
  DiscoveryService,
} from "../../src/sessions/discovery";

// Fixture-only HTTP adapter: no production SDK adapter or authentication claim.
// A/b are explicit fixture scopes by directory, not evidence of native Git project IDs.
test("T14 port over isolated 2.2.5 host: native pages, metadata, parent and native deletion", async () => {
  const host = await createHarness();
  const paths = { a: `${host.root}/project`, b: `${host.root}/discovery-b` };
  const owned = new Set<string>();
  const requests: string[] = [];
  async function call(path: string, method = "GET", body?: unknown) {
    requests.push(`${method} ${path.split("?")[0]}`);
    const response = await host.request(path, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  const ref = (sessionID: string, projectID = "a"): SessionRef => ({
    version: 1,
    instanceID: "fixture",
    projectID,
    sessionID,
  });
  async function create(project: "a" | "b", parentID?: string) {
    const result = await call("/api/session", "POST", {
      title: "T14 synthetic",
      location: { directory: paths[project] },
      ...(parentID ? { parentID } : {}),
    });
    expect(result.status).toBe(200);
    expect(typeof result.body.data.id).toBe("string");
    owned.add(result.body.data.id);
    return ref(result.body.data.id, project);
  }
  try {
    await mkdir(paths.b);
    const parent = await create("a");
    const child = await create("a", parent.sessionID);
    const foreign = await create("b");
    const principal: Principal = { kind: "session", session: parent };
    const identity = { current: async () => principal };
    const snapshot: AuthorizationSnapshot = {
      revision: 1,
      profile: "observe",
      profileCapabilities: capabilities,
      policyCapabilities: capabilities,
      hostCapabilities: capabilities,
      deniedCapabilities: [],
      grants: [],
      operator: null,
      delegationCapabilities: null,
      approval: null,
    };
    const auth = new Authorizer(
      identity,
      { read: async () => snapshot },
      () => 1000,
    );
    let nativePages = 0;
    const port: DiscoveryHostPort = {
      candidates: async (scope) => {
        const directory = paths[scope.projectID as "a" | "b"];
        if (!directory) throw new DomainError("not_found");
        const refs: SessionRef[] = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const params = new URLSearchParams(
            cursor
              ? { cursor, limit: "1" }
              : { directory, limit: "1", order: "asc" },
          );
          const result = await call(`/api/session?${params}`);
          expect(result.status).toBe(200);
          nativePages++;
          for (const item of result.body.data) {
            expect(owned.has(item.id)).toBe(true);
            refs.push(ref(item.id, scope.projectID));
          }
          cursor = result.body.cursor?.next;
          if (cursor && seen.has(cursor)) throw new DomainError("unavailable");
          if (cursor) seen.add(cursor);
        } while (cursor);
        return refs;
      },
      get: async (target) => {
        const result = await call(`/api/session/${target.sessionID}`);
        if (result.status === 404) return null;
        if (result.status !== 200) throw new DomainError("unavailable");
        const row = result.body.data;
        if (row.location.directory !== paths[target.projectID as "a" | "b"])
          throw new DomainError("not_found");
        return {
          ref: target,
          title: row.title,
          state: row.time.archived ? "archived" : "present",
          parent: row.parentID ? ref(row.parentID, target.projectID) : null,
        };
      },
      links: async () => [],
    };
    const missing: SessionRef[] = [];
    const service = new DiscoveryService(identity, auth, port, {
      missing: async (target) => {
        missing.push(target);
      },
    });
    const scope = { instanceID: "fixture", projectID: "a", limit: 1 };
    const first = await service.list(scope);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    if (!first.nextCursor) throw new Error("Missing fixture cursor");
    const next = await service.list({ ...scope, cursor: first.nextCursor });
    expect(
      new Set([...first.items, ...next.items].map((r) => r.ref.sessionID)).size,
    ).toBe(2);
    expect(nativePages).toBeGreaterThanOrEqual(2);
    expect((await service.get(child)).parent).toEqual(parent);
    await expect(service.get(foreign)).rejects.toMatchObject({
      code: "not_found",
    });
    snapshot.grants = [
      {
        version: 1,
        grantID: "fixture-grant",
        source: parent,
        target: foreign,
        capabilities: ["discover"],
        revision: 1,
        issuer: {
          kind: "operator",
          operatorID: "fixture",
          instanceID: "fixture",
          revision: 1,
        },
        createdAt: new Date(0).toISOString(),
        expiresAt: null,
      },
    ];
    expect(
      (await service.list({ ...scope, projectID: "b" })).items[0]?.ref,
    ).toEqual(foreign);
    snapshot.grants = [];
    await expect(service.get(foreign)).rejects.toMatchObject({
      code: "not_found",
    });
    // Only the owned leaf is removed, never a work session or its parent.
    expect(owned.has(child.sessionID)).toBe(true);
    expect(
      (await call(`/api/session/${child.sessionID}`, "DELETE")).status,
    ).toBe(204);
    await expect(service.get(child)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(missing).toEqual([child]);
    expect(requests.some((r) => /message|prompt|export|context/.test(r))).toBe(
      false,
    );
    const item = first.items[0];
    if (!item) throw new Error("Missing fixture session");
    expect(Object.keys(item).sort()).toEqual([
      "parent",
      "ref",
      "state",
      "title",
    ]);
  } finally {
    await host.stop();
  }
}, 120_000);
