import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { InvocationIdentity } from "../../src/composition/identity";
import { OperatorRegistry } from "../../src/composition/operator-registry";
import { Persistence } from "../../src/persistence/database";

function registry() {
  const sql = new Database(":memory:");
  const storage = new Persistence(sql, () => {});
  const identity = new InvocationIdentity(
    "i",
    { resolve: async () => null },
    { current: async () => null },
  );
  return {
    sql,
    registry: new OperatorRegistry(
      storage,
      identity,
      { consume: () => null },
      { current: async () => null },
      {},
      () => 1,
      {
        revalidate() {
          throw new Error("not used by parser fixtures");
        },
      },
    ),
  };
}
function definition(registry: OperatorRegistry, name: string) {
  const found = registry.resolve(name);
  if (!found) throw new Error("Missing private fixture definition");
  return found;
}
test("private allowlist has five exact POST routes, no aliases, and all require confirmation", () => {
  const f = registry();
  try {
    const entries = [
      [
        "session.profile.set",
        "/operator/session/profile",
        "session.configure",
        "session",
      ],
      [
        "session.model.set",
        "/operator/session/model",
        "session.configure",
        "session",
      ],
      ["session.grant.link", "/operator/grants/link", "manage", "session"],
      ["group.budget.set", "/operator/groups/budget", "manage", "group"],
      [
        "question.approval.respond",
        "/operator/questions/approve",
        "manage",
        "session",
      ],
    ] as const;
    for (const [name, route, capability, target] of entries)
      expect(f.registry.resolve(name)).toMatchObject({
        operation: name,
        route,
        capability,
        target,
        method: "POST",
        requiresConfirmation: true,
      });
    for (const name of [
      "__proto__",
      "session.profile",
      "always",
      "group.budget.set ",
      "session.delete",
    ])
      expect(f.registry.resolve(name)).toBeUndefined();
  } finally {
    f.sql.close();
  }
});
test("rejected admission thenable is consumed without unhandled rejection or partial writes", async () => {
  const registryModule = new URL(
    "../../src/composition/operator-registry.ts",
    import.meta.url,
  ).pathname;
  const identityModule = new URL(
    "../../src/composition/identity.ts",
    import.meta.url,
  ).pathname;
  const persistenceModule = new URL(
    "../../src/persistence/database.ts",
    import.meta.url,
  ).pathname;
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import { Database } from 'bun:sqlite';
    import { OperatorRegistry } from ${JSON.stringify(registryModule)};
    import { InvocationIdentity } from ${JSON.stringify(identityModule)};
    import { Persistence } from ${JSON.stringify(persistenceModule)};
    const sql = new Database(':memory:'); sql.exec('CREATE TABLE markers(id TEXT)');
    const storage = new Persistence(sql, () => {});
    const identity = new InvocationIdentity('i', {resolve:async()=>null}, {current:async()=>null});
    const registry = new OperatorRegistry(storage, identity, {consume() {
      sql.exec("INSERT INTO markers VALUES ('synthetic')");
      return Promise.reject(new Error('PUBLIC_TEST_ONLY_REJECTION_SENTINEL'));
    }}, {current:async()=>null}, {}, ()=>1, {revalidate(){}});
    let unhandled=0; let code=''; process.on('unhandledRejection',()=>{unhandled++;});
    try { storage.transaction(db => registry.enqueue(db, {instanceID:'i',projectID:'p',operatorID:'o',operation:'group.budget.set',target:{kind:'group',groupID:'g'},body:{ceiling:1,expectedRevision:0},confirmationID:'confirmed'}, 'operation')); }
    catch(error) { code=error.code; }
    await new Promise(resolve=>setTimeout(resolve,10));
    console.log(JSON.stringify({code,unhandled,n:sql.query('SELECT COUNT(*) AS n FROM markers').get().n})); sql.close();
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).not.toContain("PUBLIC_TEST_ONLY_REJECTION_SENTINEL");
  expect(JSON.parse(stdout)).toEqual({
    code: "unavailable",
    unhandled: 0,
    n: 0,
  });
});
test("strict bodies use actual domain fields, reject extra authority and approval always/answer", () => {
  const f = registry();
  const ref = { version: 1, instanceID: "i", projectID: "p", sessionID: "s" };
  const good: Record<string, unknown> = {
    "session.profile.set": { profile: "bounded-auto", expectedRevision: 0 },
    "session.model.set": {
      providerID: "provider",
      modelID: "model",
      expectedRevision: 1,
    },
    "session.grant.link": {
      source: ref,
      capabilities: ["manage"],
      expiresAt: null,
      policyRevision: 1,
      grantRevision: 0,
    },
    "group.budget.set": { ceiling: 12, expectedRevision: 0 },
    "question.approval.respond": {
      requestID: "request",
      response: {
        revision: 1,
        admissionID: "a",
        operationID: "o",
        correlationID: "c",
        taskGeneration: 1,
        target: ref,
        decision: "once",
      },
    },
  };
  try {
    for (const [name, body] of Object.entries(good)) {
      const validate = definition(f.registry, name).validateBody;
      expect(validate(body)).toEqual(body);
      for (const invalid of [
        null,
        [],
        {},
        { ...(body as object), operatorID: "PUBLIC_TEST_ONLY_SECRET_SENTINEL" },
      ])
        expect(() => validate(invalid)).toThrow("invalid_input");
    }
    const validate = definition(
      f.registry,
      "question.approval.respond",
    ).validateBody;
    for (const decision of ["always", "answer", "reject"])
      expect(() =>
        validate({
          requestID: "r",
          response: {
            ...(good["question.approval.respond"] as { response: object })
              .response,
            decision,
          },
        }),
      ).toThrow("invalid_input");
    for (const ceiling of [-1, Infinity, NaN, "10"])
      expect(() =>
        definition(f.registry, "group.budget.set").validateBody({
          ceiling,
          expectedRevision: 0,
        }),
      ).toThrow("invalid_input");
  } finally {
    f.sql.close();
  }
});
