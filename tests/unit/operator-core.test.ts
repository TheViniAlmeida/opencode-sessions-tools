import { afterEach, expect, test } from "bun:test";
import {
  OperatorCore,
  type OperatorIntention,
  operatorDigest,
  operatorRetentionMs,
  parseOperatorJSON,
} from "../../src/authorization/operator-core";
import { canonical } from "../../src/contracts";
import {
  fixture,
  localEffect,
  PUBLIC_BEARER,
} from "../fixtures/operator-core-worker";

const fixtures: ReturnType<typeof fixture>[] = [];
const setup = () => {
  const f = fixture();
  fixtures.push(f);
  return f;
};
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
test("rejected async local callback rolls back and does not escape as unhandled rejection", async () => {
  const module = new URL("../fixtures/operator-core-worker.ts", import.meta.url)
    .pathname;
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import { fixture } from ${JSON.stringify(module)};
    const f = fixture(); let unhandled = 0; let code = '';
    process.on('unhandledRejection', () => { unhandled++; });
    f.confirm(); const raw = f.raw(); const a = f.attempt(raw);
    try { f.core.admit(a, f.core.issue(a), raw, (sql) => {
      sql.exec("INSERT INTO synthetic_effects VALUES ('rejected')");
      return Promise.reject(new Error('PUBLIC_TEST_ONLY_REJECTION_SENTINEL'));
    }); } catch (error) { code = error.code; }
    await new Promise(resolve => setTimeout(resolve, 10));
    const n = f.db.query('SELECT COUNT(*) AS n FROM synthetic_effects').get().n;
    console.log(JSON.stringify({code, unhandled, n})); f.close();
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
    code: "invalid_input",
    unhandled: 0,
    n: 0,
  });
});

test("JSON grammar rejects escaped duplicate keys at any depth and invalid JSON", () => {
  for (const raw of [
    '{"a":1,"\\u0061":2}',
    '{"body":{"x":1,"x":2}}',
    '[{"x":1,"x":2}]',
    '{"__proto__":{}}',
    "[1,]",
    '{"a":1,}',
    "01",
    "1e999",
    "NaN",
    "undefined",
    '{"x":"\\q"}',
    '"unterminated',
    "true false",
  ]) {
    expect(() => parseOperatorJSON(raw)).toThrow("invalid_input");
  }
  expect(
    parseOperatorJSON(
      ' {"escaped":"a\\"b\\\\c","nested":[true,false,null,-0,1e0]} ',
    ),
  ).toEqual({ escaped: 'a"b\\c', nested: [true, false, null, -0, 1] });
  expect(() =>
    parseOperatorJSON(`${"[".repeat(66)}0${"]".repeat(66)}`),
  ).toThrow("invalid_input");
  expect(() => parseOperatorJSON(JSON.stringify("x".repeat(65536)))).toThrow(
    "invalid_input",
  );
});

test("lost response: fresh challenge recovers same operation without fresh confirmation/new-effect capability", () => {
  const f = setup();
  f.confirm();
  const raw = f.raw(),
    a = f.attempt(raw),
    c = f.core.issue(a);
  const first = f.core.admit(a, c, raw, localEffect);
  f.db.exec(
    "UPDATE synthetic_policy SET new_effect=0; DELETE FROM synthetic_capabilities; UPDATE operator_confirmations SET expires_at=0",
  );
  const recovered = f.core.admit(a, f.core.issue(a), raw, localEffect);
  expect(recovered).toEqual(first);
  expect(f.count()).toBe(1);
  expect(() => f.core.admit(a, c, raw, localEffect)).toThrow("forbidden");
});

test("numeric and transport equivalence: business canonical 1/1.0/1e0 and -0/0; raw hashes differ", () => {
  for (const [initial, next] of [
    ["1", "1.0"],
    ["1", "1e0"],
    ["0", "-0"],
  ]) {
    const f = setup();
    const value = Number(initial);
    f.confirm(f.intention({ body: { value } }));
    const raw = f.raw({ body: { value } }),
      a = f.attempt(raw),
      c = f.core.issue(a);
    const changed = raw.replace(`"value":${initial}`, `"value":${next}`);
    expect(operatorDigest(raw)).not.toBe(operatorDigest(changed));
    expect(() => f.core.admit(a, c, changed, localEffect)).toThrow("forbidden");
    const first = f.core.admit(a, c, raw, localEffect);
    const b = f.attempt(changed);
    expect(f.core.admit(b, f.core.issue(b), changed, localEffect)).toEqual(
      first,
    );
    expect(f.count()).toBe(1);
  }
});

test("new namespace and changed intent never recover an old result", () => {
  const f = setup();
  f.confirm();
  const a = f.attempt();
  f.core.admit(a, f.core.issue(a), f.raw(), localEffect);
  const patches: Partial<OperatorIntention>[] = [
    { body: { value: 2 } },
    { target: { kind: "group", groupID: "other" } },
    { expectedRevision: 2 },
    { confirmationID: "other" },
    { operation: "synthetic.queryOwn" },
  ];
  for (const patch of patches) {
    const raw = f.raw(patch),
      b = f.attempt(raw, { operation: patch.operation ?? a.operation });
    expect(() => f.core.admit(b, f.core.issue(b), raw, localEffect)).toThrow(
      "conflict",
    );
    // Conflicting requests do not consume challenges; expire this synthetic batch.
    f.db.exec("UPDATE operator_challenges SET consumed=1");
  }
  const raw = f.raw({ projectID: "q" }),
    b = f.attempt(raw, { projectID: "q" });
  expect(() => f.core.admit(b, f.core.issue(b), raw, localEffect)).toThrow(
    "forbidden",
  );
  expect(f.count()).toBe(1);
});

test("revocation, expiration, current scope and current read-own deny recovery", () => {
  const f = setup();
  f.confirm();
  const a = f.attempt();
  f.core.admit(a, f.core.issue(a), f.raw(), localEffect);
  f.db.exec("UPDATE synthetic_policy SET read_own=0");
  expect(() => f.core.admit(a, f.core.issue(a), f.raw(), localEffect)).toThrow(
    "forbidden",
  );
  f.db.exec(
    "UPDATE synthetic_policy SET read_own=1; UPDATE operator_credentials SET revoked=1",
  );
  expect(() => f.core.issue(a)).toThrow("forbidden");
  f.db.exec("UPDATE operator_credentials SET revoked=0,projects='[]'");
  expect(() => f.core.issue(a)).toThrow("forbidden");
  f.db.exec(
    "UPDATE operator_credentials SET projects='[\"p\"]',expires_at=100000",
  );
  expect(() => f.core.issue(a)).toThrow("forbidden");
  expect(f.count()).toBe(1);
});

test("credential rotation retains stable operator namespace, revision invalidates challenge", () => {
  const f = setup();
  f.confirm();
  const a = f.attempt(),
    c = f.core.issue(a);
  f.db.exec("UPDATE operator_credentials SET revision=2");
  expect(() => f.core.admit(a, c, f.raw(), localEffect)).toThrow("forbidden");
  const first = f.core.admit(a, f.core.issue(a), f.raw(), localEffect);
  f.db
    .query("INSERT INTO operator_credentials VALUES (?,?,?,?,?,?,?,0)")
    .run(
      "rotated",
      "operator",
      "i",
      1,
      operatorDigest(PUBLIC_BEARER),
      '["p"]',
      Number.MAX_SAFE_INTEGER,
    );
  f.db.exec(
    "UPDATE operator_credentials SET revoked=1 WHERE credential_id='credential'",
  );
  const b = f.attempt(f.raw(), { credentialID: "rotated" });
  expect(f.core.admit(b, f.core.issue(b), f.raw(), localEffect)).toEqual(first);
  expect(() => f.core.issue(a)).toThrow("forbidden");
  expect(f.count()).toBe(1);
});

test("timestamp, audience, route, method, nonce and TTL are exact bindings", () => {
  const f = setup();
  f.confirm();
  const a = f.attempt(),
    c = f.core.issue(a);
  for (const patch of [
    { bearer: "PUBLIC_TEST_ONLY_wrong" },
    { credentialID: "unknown" },
    { projectID: "no" },
    { timestamp: 69999 },
    { timestamp: 130001 },
    { method: "GET" },
    { route: "/alias" },
    { audience: { instanceID: "i", epoch: "restart" } },
    { operation: "unknown" },
  ])
    expect(() => f.core.issue({ ...a, ...patch })).toThrow();
  expect(() =>
    f.core.admit(
      a,
      { ...c, nonce: "PUBLIC_TEST_ONLY_wrong" },
      f.raw(),
      localEffect,
    ),
  ).toThrow("forbidden");
  expect(() =>
    f.core.admit({ ...a, timestamp: 100001 }, c, f.raw(), localEffect),
  ).toThrow("forbidden");
  f.setNow(130000);
  expect(() => f.core.admit(a, c, f.raw(), localEffect)).toThrow("forbidden");
  expect(f.count()).toBe(0);
});

test("pending quotas, strict knobs, parser bounds and unsupported operation fail closed", () => {
  const f = setup(),
    a = f.attempt();
  for (let n = 0; n < 4; n++) f.core.issue(a);
  expect(() => f.core.issue(a)).toThrow("forbidden");
  f.setNow(130001);
  expect(f.core.issue(f.attempt())).toBeDefined();
  expect(
    () => new OperatorCore(f.persistence, { ...f.options, ttlMs: 30001 }),
  ).toThrow("invalid_input");
  expect(
    () => new OperatorCore(f.persistence, { ...f.options, pendingGlobal: 0 }),
  ).toThrow("invalid_input");
  expect(() =>
    f.core.issue(f.attempt(f.raw(), { operation: "unknown" })),
  ).toThrow("unsupported");
});

test("malformed intention, forged operator and unknown role cannot grant authority", () => {
  const f = setup();
  const malformed = [
    canonical({
      key: "key",
      intention: { ...f.intention(), role: "operator" },
    }),
    f.raw({ operatorID: "forged" }),
    f.raw({ expectedRevision: -1 }),
    canonical({
      key: "key",
      intention: {
        ...f.intention(),
        target: { kind: "group", groupID: "g", extra: 1 },
      },
    }),
    canonical({
      key: "key",
      intention: { ...f.intention(), body: {}, unknown: 1 },
    }),
  ];
  for (const raw of malformed) {
    const a = f.attempt(raw);
    expect(() => f.core.admit(a, f.core.issue(a), raw, localEffect)).toThrow();
    f.db.exec("UPDATE operator_challenges SET consumed=1");
  }
  expect(f.count()).toBe(0);
});

test("atomic rollback of local SQL, confirmation, challenge and ledger; no async callbacks", () => {
  const f = setup();
  f.confirm();
  const a = f.attempt(),
    c = f.core.issue(a);
  expect(() =>
    f.core.admit(a, c, f.raw(), (sql, intent, id) => {
      localEffect(sql, intent, id);
      throw new Error("synthetic failure");
    }),
  ).toThrow("unavailable");
  expect(f.count()).toBe(0);
  expect(
    f.db
      .query<{ consumed: number }, []>(
        "SELECT consumed FROM operator_confirmations",
      )
      .get()?.consumed,
  ).toBe(0);
  expect(() => f.core.admit(a, c, f.raw(), async () => ({}))).toThrow(
    "invalid_input",
  );
  expect(f.core.admit(a, c, f.raw(), localEffect).expired).toBe(false);
  expect(f.count()).toBe(1);
});

test("retention markers never redispatch even after full result expires", () => {
  const f = setup();
  f.confirm();
  const a = f.attempt();
  const first = f.core.admit(a, f.core.issue(a), f.raw(), localEffect);
  f.setNow(100000 + operatorRetentionMs - 1);
  expect(f.core.expireResults()).toBe(0);
  f.setNow(100000 + operatorRetentionMs);
  expect(f.core.expireResults()).toBe(1);
  const b = f.attempt();
  const replay = f.core.admit(b, f.core.issue(b), f.raw(), localEffect);
  expect(replay).toEqual({
    operationID: first.operationID,
    result: null,
    expired: true,
  });
  expect(f.count()).toBe(1);
});

test("once approval cannot authorize another key; omissions conflict on replay", () => {
  const f = setup();
  f.confirm();
  const a = f.attempt();
  f.core.admit(a, f.core.issue(a), f.raw(), localEffect);
  const raw = f.raw({}, "different-key"),
    b = f.attempt(raw);
  expect(() => f.core.admit(b, f.core.issue(b), raw, localEffect)).toThrow(
    "forbidden",
  );
  const without = f.intention();
  delete without.confirmationID;
  const omitted = canonical({ key: "key", intention: without }),
    c = f.attempt(omitted);
  expect(() => f.core.admit(c, f.core.issue(c), omitted, localEffect)).toThrow(
    "conflict",
  );
  expect(f.count()).toBe(1);
});

test("whitespace/key order retry is equal; UTF-8 and strings are not normalized", () => {
  const f = setup();
  f.confirm();
  const a = f.attempt();
  const first = f.core.admit(a, f.core.issue(a), f.raw(), localEffect);
  const reordered = JSON.stringify(
      { intention: f.intention(), key: "key" },
      null,
      2,
    ),
    b = f.attempt(reordered);
  expect(f.core.admit(b, f.core.issue(b), reordered, localEffect)).toEqual(
    first,
  );
  for (const value of ["1", " 1", "é", "e\u0301"]) {
    const raw = f.raw({ body: { value } }),
      c = f.attempt(raw);
    expect(() => f.core.admit(c, f.core.issue(c), raw, localEffect)).toThrow(
      "conflict",
    );
    f.db.exec("UPDATE operator_challenges SET consumed=1");
  }
  expect(f.count()).toBe(1);
});

test("global challenge bound and per-credential scopes rechecked inside admission", () => {
  const f = setup();
  f.confirm();
  const core = new OperatorCore(f.persistence, {
    ...f.options,
    pendingGlobal: 1,
  });
  const a = f.attempt(),
    c = core.issue(a);
  expect(() => core.issue(a)).toThrow("forbidden");
  f.db.exec("UPDATE operator_credentials SET projects='[]'");
  expect(() => core.admit(a, c, f.raw(), localEffect)).toThrow("forbidden");
  expect(f.count()).toBe(0);
});

test("expired/wrong confirmation and body schema denial leave challenge reusable", () => {
  const f = setup();
  f.confirm(f.intention(), 100000);
  const a = f.attempt(),
    c = f.core.issue(a);
  expect(() => f.core.admit(a, c, f.raw(), localEffect)).toThrow("forbidden");
  f.db.exec(
    "UPDATE operator_confirmations SET expires_at=200000,intent_hash='wrong'",
  );
  expect(() => f.core.admit(a, c, f.raw(), localEffect)).toThrow("forbidden");
  expect(f.count()).toBe(0);
});

test("trusted registry normalization and session-target schema run before admission", () => {
  const f = setup();
  const core = new OperatorCore(f.persistence, {
    ...f.options,
    definitions: {
      resolve(operation) {
        if (operation !== "synthetic.queryOwn") return undefined;
        return {
          operation,
          capability: "synthetic-capability",
          method: "POST",
          route: "/synthetic",
          target: "session",
          requiresConfirmation: false,
          validateBody(body) {
            if (
              !body ||
              typeof body !== "object" ||
              Object.keys(body).some((key) => key !== "value")
            )
              throw new Error("synthetic schema denial");
            return { value: 1, ...body };
          },
        };
      },
    },
  });
  const intent = f.intention({
    operation: "synthetic.queryOwn",
    target: {
      kind: "session",
      version: 1,
      instanceID: "i",
      projectID: "p",
      sessionID: "s",
    },
    body: {},
  });
  delete intent.confirmationID;
  const raw = canonical({ key: "key", intention: intent }),
    a = f.attempt(raw, { operation: intent.operation });
  const first = core.admit(a, core.issue(a), raw, localEffect);
  const normalized = canonical({
      key: "key",
      intention: { ...intent, body: { value: 1 } },
    }),
    b = f.attempt(normalized, { operation: intent.operation });
  expect(core.admit(b, core.issue(b), normalized, localEffect)).toEqual(first);
  const invalid = canonical({
      key: "other",
      intention: { ...intent, target: { ...intent.target, version: 2 } },
    }),
    c = f.attempt(invalid, { operation: intent.operation });
  expect(() => core.admit(c, core.issue(c), invalid, localEffect)).toThrow(
    "invalid_input",
  );
  expect(f.count()).toBe(1);
});

test("closed canonical persistence cannot admit or invoke a local callback", () => {
  const f = setup();
  f.confirm();
  const a = f.attempt(),
    c = f.core.issue(a);
  f.persistence.close();
  expect(() => f.core.admit(a, c, f.raw(), localEffect)).toThrow("unavailable");
  expect(f.count()).toBe(0);
});

test("registry stores digest only, absent bearer denied and unknown outcome never promoted", () => {
  const f = setup();
  f.confirm();
  const a = f.attempt();
  expect(() => f.core.issue({ ...a, bearer: "" })).toThrow("forbidden");
  expect(() =>
    f.core.issue({ ...a, bearer: "PUBLIC_TEST_ONLY_native_transport_token" }),
  ).toThrow("forbidden");
  const stored = f.db
    .query<{ digest: string }, []>("SELECT digest FROM operator_credentials")
    .get();
  expect(stored?.digest).toBe(operatorDigest(PUBLIC_BEARER));
  expect(stored?.digest.includes(PUBLIC_BEARER)).toBe(false);
  const first = f.core.admit(a, f.core.issue(a), f.raw(), (sql, intent, id) => {
    localEffect(sql, intent, id);
    return { state: "unknown_outcome" };
  });
  expect(first.result).toEqual({ state: "unknown_outcome" });
  expect(f.core.admit(a, f.core.issue(a), f.raw(), localEffect)).toEqual(first);
  expect(f.count()).toBe(1);
});

test("same key in another project/operator is new admission; another installation cannot claim canonical DB", () => {
  const f = setup();
  f.confirm();
  const a = f.attempt();
  const first = f.core.admit(a, f.core.issue(a), f.raw(), localEffect);
  const other = f.intention({
    projectID: "q",
    confirmationID: "confirmation-q",
  });
  f.confirm(other);
  const raw = canonical({ key: "key", intention: other }),
    b = f.attempt(raw, { projectID: "q" });
  const second = f.core.admit(b, f.core.issue(b), raw, localEffect);
  expect(second.operationID).not.toBe(first.operationID);
  f.db
    .query("INSERT INTO operator_credentials VALUES (?,?,?,?,?,?,?,0)")
    .run(
      "other",
      "other-operator",
      "i",
      1,
      operatorDigest(PUBLIC_BEARER),
      '["p"]',
      Number.MAX_SAFE_INTEGER,
    );
  const own = f.intention({
    operatorID: "other-operator",
    confirmationID: "confirmation-other",
  });
  f.grant(own);
  f.confirm(own);
  const ownRaw = canonical({ key: "key", intention: own }),
    c = f.attempt(ownRaw, { credentialID: "other" });
  const third = f.core.admit(c, f.core.issue(c), ownRaw, localEffect);
  expect(third.operationID).not.toBe(first.operationID);
  const wrong = new OperatorCore(f.persistence, {
    ...f.options,
    instanceID: "other-installation",
  });
  expect(() => wrong.issue(a)).toThrow("forbidden");
  expect(f.count()).toBe(3);
});

test("TTL last millisecond and inclusive skew boundaries are admitted, next millisecond denied", () => {
  const f = setup();
  f.confirm(f.intention(), 200000);
  const a = f.attempt(),
    c = f.core.issue(a);
  expect(f.core.issue({ ...a, timestamp: 70000 })).toBeDefined();
  expect(f.core.issue({ ...a, timestamp: 130000 })).toBeDefined();
  f.setNow(129999);
  expect(f.core.admit(a, c, f.raw(), localEffect).expired).toBe(false);
  expect(f.count()).toBe(1);
});

test("trusted capability port denies valid bearer/confirmation without exact principal intention capability grant", () => {
  const f = setup();
  f.confirm();
  const a = f.attempt(),
    c = f.core.issue(a);
  f.db.exec(`CREATE TABLE IF NOT EXISTS synthetic_capabilities (
    instance_id TEXT, operator_id TEXT, project_id TEXT, operation TEXT, target_json TEXT, capability TEXT,
    PRIMARY KEY(instance_id,operator_id,project_id,operation,target_json,capability));
    DELETE FROM synthetic_capabilities`);
  const grant = (
    instance = "i",
    operator = "operator",
    project = "p",
    operation = "synthetic.mutate",
    target = canonical(f.intention().target),
    capability = "synthetic-capability",
  ) =>
    f.db
      .query("INSERT INTO synthetic_capabilities VALUES (?,?,?,?,?,?)")
      .run(instance, operator, project, operation, target, capability);
  const unchanged = () => {
    expect(f.count()).toBe(0);
    expect(
      f.db
        .query<{ consumed: number }, [string]>(
          "SELECT consumed FROM operator_challenges WHERE challenge_id=?",
        )
        .get(c.challengeID)?.consumed,
    ).toBe(0);
    expect(
      f.db
        .query<{ consumed: number }, []>(
          "SELECT consumed FROM operator_confirmations",
        )
        .get()?.consumed,
    ).toBe(0);
    expect(
      f.db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM operator_ledger")
        .get()?.n,
    ).toBe(0);
  };
  expect(() => f.core.admit(a, c, f.raw(), localEffect)).toThrow("forbidden");
  unchanged();
  for (const values of [
    [
      "other",
      "operator",
      "p",
      "synthetic.mutate",
      canonical(f.intention().target),
      "synthetic-capability",
    ],
    [
      "i",
      "other",
      "p",
      "synthetic.mutate",
      canonical(f.intention().target),
      "synthetic-capability",
    ],
    [
      "i",
      "operator",
      "q",
      "synthetic.mutate",
      canonical(f.intention().target),
      "synthetic-capability",
    ],
    [
      "i",
      "operator",
      "p",
      "synthetic.queryOwn",
      canonical(f.intention().target),
      "synthetic-capability",
    ],
    [
      "i",
      "operator",
      "p",
      "synthetic.mutate",
      canonical({ kind: "group", groupID: "other" }),
      "synthetic-capability",
    ],
    [
      "i",
      "operator",
      "p",
      "synthetic.mutate",
      canonical(f.intention().target),
      "wrong-capability",
    ],
  ] as const) {
    f.db.exec("DELETE FROM synthetic_capabilities");
    grant(...values);
    expect(() => f.core.admit(a, c, f.raw(), localEffect)).toThrow("forbidden");
    unchanged();
  }
  f.db.exec("DELETE FROM synthetic_capabilities");
  grant();
  const changedCapability = new OperatorCore(f.persistence, {
    ...f.options,
    definitions: {
      resolve(operation) {
        const definition = f.options.definitions.resolve(operation);
        return definition
          ? { ...definition, capability: "other-required-capability" }
          : undefined;
      },
    },
  });
  expect(() => changedCapability.admit(a, c, f.raw(), localEffect)).toThrow(
    "forbidden",
  );
  unchanged();
  expect(f.core.admit(a, c, f.raw(), localEffect).expired).toBe(false);
  expect(f.count()).toBe(1);
});

test("expectedRevision is enforced by trusted newEffect target revision hook, not core schema", () => {
  const f = setup();
  const intent = f.intention({ expectedRevision: 8 });
  f.confirm(intent);
  f.db.exec(
    `CREATE TABLE IF NOT EXISTS synthetic_target_revisions (instance_id TEXT, project_id TEXT, target_json TEXT, revision INTEGER, PRIMARY KEY(instance_id,project_id,target_json))`,
  );
  f.db
    .query("INSERT OR REPLACE INTO synthetic_target_revisions VALUES (?,?,?,?)")
    .run("i", "p", canonical(intent.target), 9);
  const raw = f.raw({ expectedRevision: 8 }),
    a = f.attempt(raw),
    c = f.core.issue(a);
  expect(() => f.core.admit(a, c, raw, localEffect)).toThrow("forbidden");
  expect(f.count()).toBe(0);
  expect(
    f.db
      .query<{ consumed: number }, [string]>(
        "SELECT consumed FROM operator_challenges WHERE challenge_id=?",
      )
      .get(c.challengeID)?.consumed,
  ).toBe(0);
  expect(
    f.db
      .query<{ consumed: number }, []>(
        "SELECT consumed FROM operator_confirmations",
      )
      .get()?.consumed,
  ).toBe(0);
  f.db.exec("UPDATE synthetic_target_revisions SET revision=8");
  expect(f.core.admit(a, c, raw, localEffect).expired).toBe(false);
  expect(f.count()).toBe(1);
});
