import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { GRANTS_MIGRATION } from "../../src/authorization/grants";
import {
  type CredentialPrincipal,
  OperatorCore,
} from "../../src/authorization/operator-core";
import { InvocationIdentity } from "../../src/composition/identity";
import {
  OPERATOR_COMMANDS_MIGRATION,
  type OperatorCapabilityPort,
  type OperatorCommandHandlers,
  OperatorRegistry,
} from "../../src/composition/operator-registry";
import {
  CanonicalPolicy,
  POLICY_MIGRATION,
} from "../../src/composition/policy";
import {
  canonical,
  DomainError,
  type OperatorPrincipal,
} from "../../src/contracts";
import { GROUPS_MIGRATION } from "../../src/groups/service";
import { USAGE_MIGRATION, UsageService } from "../../src/observability/usage";
import { fixture } from "../fixtures/operator-core-worker";

const opened: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of opened.splice(0)) f.close();
});
// Synthetic authentication only. No server/enrollment/runtime wiring is established here.
function setup(
  override?: OperatorCommandHandlers,
  capabilityOverride?: OperatorCapabilityPort | null,
) {
  const f = fixture();
  opened.push(f);
  f.persistence.transaction((sql) => {
    for (const migration of [
      OPERATOR_COMMANDS_MIGRATION,
      GRANTS_MIGRATION,
      POLICY_MIGRATION,
      GROUPS_MIGRATION,
      USAGE_MIGRATION,
    ])
      migration.apply(sql, "disposable-fixture-only");
  });
  const owner: CredentialPrincipal = {
    credentialID: "credential",
    operatorID: "operator",
    instanceID: "i",
    revision: 1,
  };
  const principal: OperatorPrincipal = {
    kind: "operator",
    operatorID: owner.operatorID,
    instanceID: owner.instanceID,
    revision: 1,
  };
  let active = true;
  let latch: { sql: Database; owner: CredentialPrincipal } | null = null;
  let calls = 0;
  const identity = new InvocationIdentity(
    "i",
    { resolve: async () => null },
    { current: async () => (active ? principal : null) },
  );
  const policy = new CanonicalPolicy(
    f.persistence,
    "i",
    identity,
    () => 100000,
  );
  const scope = {
    version: 1 as const,
    instanceID: "i",
    projectID: "p",
    sessionID: "s",
  };
  const snapshot = {
    revision: 1,
    profile: "manage",
    profileCapabilities: ["manage"],
    policyCapabilities: ["manage"],
    hostCapabilities: ["manage"],
    deniedCapabilities: [],
    grants: [],
    operator: {
      operatorID: "operator",
      instanceID: "i",
      revision: 1,
      capabilities: ["manage"],
      projects: ["p"],
      expiresAt: null,
    },
    delegationCapabilities: null,
    approval: null,
  };
  f.db
    .query("INSERT INTO composition_policies VALUES (?,?,?,?,?,?)")
    .run("i", "p", "s", canonical(principal), 1, JSON.stringify(snapshot));
  f.db.query("INSERT INTO groups_records VALUES (?,?)").run(
    "g",
    JSON.stringify({
      version: 1,
      groupID: "g",
      scope,
      owner: principal,
      name: "fixture",
      kind: "group",
    }),
  );
  const check = (sql: Database) => {
    const loaded = policy.load(sql, principal, scope);
    if (
      loaded.revision !== 1 ||
      !loaded.operator?.capabilities.includes("manage") ||
      loaded.deniedCapabilities.includes("manage")
    )
      throw new DomainError("forbidden");
  };
  const events: string[] = [];
  const usage = new UsageService(
    f.persistence,
    identity,
    {
      check(sql) {
        check(sql);
      },
    },
    {
      appendInTx(_sql, event) {
        events.push(event.operationID);
      },
    },
  );
  const registry = new OperatorRegistry(
    f.persistence,
    identity,
    {
      consume(sql) {
        const result = latch;
        latch = null;
        return result?.sql === sql ? result.owner : null;
      },
    },
    { current: async () => (active ? owner : null) },
    override ?? {
      "group.budget.set": {
        revalidate(sql, _context, body) {
          check(sql);
          const row = sql
            .query<{ revision: number }, []>(
              "SELECT revision FROM usage_budgets WHERE group_id='g'",
            )
            .get();
          if ((row?.revision ?? 0) !== body.expectedRevision)
            throw new DomainError("conflict");
        },
        async execute(context, body) {
          calls++;
          // Real async identity + real domain method. Core's SQL callback has already committed.
          expect(f.db.inTransaction).toBe(false);
          expect(await identity.current()).toEqual(principal);
          if (context.intention.target.kind !== "group")
            throw new DomainError("invalid_input");
          await usage.changeBudget(
            context.intention.target.groupID,
            body.ceiling,
            body.expectedRevision,
            context.operationID,
          );
        },
      },
    },
    () => 100000,
    capabilityOverride === null
      ? (undefined as unknown as OperatorCapabilityPort)
      : (capabilityOverride ?? {
          revalidate(sql, current, capability, intention) {
            expect(current).toEqual(owner);
            expect(capability).toBe("manage");
            expect(intention.projectID).toBe("p");
            const loaded = policy.load(sql, principal, scope);
            if (
              !loaded.operator?.capabilities.includes(capability as "manage") ||
              !loaded.operator.projects.includes(intention.projectID) ||
              loaded.deniedCapabilities.includes(capability as "manage")
            )
              throw new DomainError("forbidden");
          },
        }),
  );
  const base = f.options.authorization;
  const core = new OperatorCore(f.persistence, {
    ...f.options,
    definitions: registry,
    authorization: {
      readOwn: base.readOwn,
      newEffect(sql, authenticated, intention) {
        check(sql);
        if (intention.operation !== "group.budget.set")
          throw new DomainError("forbidden");
        latch = { sql, owner: authenticated };
      },
    },
  });
  const intention = f.intention({
    operation: "group.budget.set",
    body: { ceiling: 10, expectedRevision: 0 },
  });
  const raw = canonical({ key: "registry-key", intention });
  const attempt = f.attempt(raw, {
    operation: intention.operation,
    route: "/operator/groups/budget",
  });
  const admit = () =>
    core.admit(attempt, core.issue(attempt), raw, registry.enqueue);
  return {
    ...f,
    registry,
    core,
    intention,
    raw,
    attempt,
    admit,
    events,
    calls: () => calls,
    active: (value: boolean) => {
      active = value;
    },
  };
}
test("actual core enqueues once, then canonical policy/identity + async budget execute after commit", async () => {
  const f = setup();
  f.confirm(f.intention);
  const admitted = f.admit();
  expect(admitted.result).toEqual({
    operationID: admitted.operationID,
    state: "pending",
  });
  expect(f.calls()).toBe(0);
  expect(await f.registry.execute(admitted.operationID)).toEqual({
    operationID: admitted.operationID,
    state: "completed",
  });
  expect(f.calls()).toBe(1);
  expect(
    f.db.query("SELECT ceiling,revision FROM usage_budgets").get(),
  ).toEqual({ ceiling: 10, revision: 1 });
  expect(f.events).toHaveLength(1);
  expect(
    f.db.query("SELECT operation_id FROM usage_budget_mutations").get(),
  ).toEqual({ operation_id: f.events[0] });
  expect(
    f.db.query("SELECT idempotency_key FROM usage_budget_mutations").get(),
  ).toEqual({ idempotency_key: admitted.operationID });
  expect(f.admit().operationID).toBe(admitted.operationID);
  await f.registry.execute(admitted.operationID);
  expect(f.calls()).toBe(1);
});
test("mandatory capability revalidation blocks revoked canonical manage with no-op business handler", async () => {
  let effects = 0;
  const f = setup({
    "group.budget.set": {
      revalidate() {},
      async execute() {
        effects++;
      },
    },
  });
  f.confirm(f.intention);
  const admitted = f.admit();
  const row = f.db
    .query<{ body: string }, []>("SELECT body FROM composition_policies")
    .get();
  const body = JSON.parse(row?.body ?? "{}");
  body.operator.capabilities = [];
  f.db
    .query("UPDATE composition_policies SET body=?")
    .run(JSON.stringify(body));
  await expect(f.registry.execute(admitted.operationID)).rejects.toThrow(
    "forbidden",
  );
  expect(effects).toBe(0);
  expect(f.db.query("SELECT state FROM operator_commands").get()).toEqual({
    state: "pending",
  });
});
test("canonical project revocation denies a no-op business handler before effect", async () => {
  let effects = 0;
  const f = setup({
    "group.budget.set": {
      revalidate() {},
      async execute() {
        effects++;
      },
    },
  });
  f.confirm(f.intention);
  const admitted = f.admit();
  const row = f.db
    .query<{ body: string }, []>("SELECT body FROM composition_policies")
    .get();
  const body = JSON.parse(row?.body ?? "{}");
  body.operator.projects = ["other-project"];
  f.db
    .query("UPDATE composition_policies SET body=?")
    .run(JSON.stringify(body));
  await expect(f.registry.execute(admitted.operationID)).rejects.toThrow(
    "forbidden",
  );
  expect(effects).toBe(0);
});
test("missing capability adapter is unavailable; capability/project are passed exactly", async () => {
  for (const mode of ["missing", "project", "capability"]) {
    let effects = 0;
    const f = setup(
      {
        "group.budget.set": {
          revalidate() {},
          async execute() {
            effects++;
          },
        },
      },
      mode === "missing"
        ? null
        : {
            revalidate(_sql, current, capability, intention) {
              expect(current.instanceID).toBe("i");
              expect(capability).toBe("manage");
              expect(intention.projectID).toBe("p");
              if (mode === "project" && intention.projectID !== "other-project")
                throw new DomainError("forbidden");
              if (mode === "capability" && capability !== "session.configure")
                throw new DomainError("forbidden");
            },
          },
    );
    f.confirm(f.intention);
    const admitted = f.admit();
    await expect(f.registry.execute(admitted.operationID)).rejects.toThrow(
      mode === "missing" ? "unavailable" : "forbidden",
    );
    expect(effects).toBe(0);
  }
});
test("missing confirmation denies before queue and revoked credential cannot execute", async () => {
  const f = setup();
  expect(() => f.admit()).toThrow("forbidden");
  expect(
    f.db.query("SELECT COUNT(*) AS n FROM operator_commands").get(),
  ).toEqual({ n: 0 });
  f.confirm(f.intention);
  const admitted = f.admit();
  f.db.exec("UPDATE operator_credentials SET revoked=1");
  await expect(f.registry.execute(admitted.operationID)).rejects.toThrow(
    "forbidden",
  );
  expect(f.calls()).toBe(0);
});
test("lost active context leaves pending; absent adapter fails unsupported, never succeeds silently", async () => {
  const f = setup({});
  f.confirm(f.intention);
  const admitted = f.admit();
  f.active(false);
  await expect(f.registry.execute(admitted.operationID)).rejects.toThrow(
    "unavailable",
  );
  f.active(true);
  await expect(f.registry.execute(admitted.operationID)).rejects.toThrow(
    "unsupported",
  );
  expect(f.db.query("SELECT state FROM operator_commands").get()).toEqual({
    state: "pending",
  });
});
test("stale canonical policy and stale budget revision deny before dispatch", async () => {
  for (const stale of ["policy", "budget"]) {
    const f = setup();
    f.confirm(f.intention);
    const admitted = f.admit();
    if (stale === "policy")
      f.db.exec("UPDATE composition_policies SET revision=2");
    else f.db.exec("INSERT INTO usage_budgets VALUES ('g',3,1)");
    await expect(f.registry.execute(admitted.operationID)).rejects.toThrow();
    expect(f.calls()).toBe(0);
  }
});
test("raw errors and malicious domain codes are redacted; ambiguous dispatch never retries", async () => {
  for (const error of [
    new Error("PUBLIC_TEST_ONLY_SECRET_SENTINEL"),
    new DomainError("unavailable"),
    Object.assign(new DomainError("forbidden"), {
      code: "PUBLIC_TEST_ONLY_SECRET_SENTINEL",
    }),
  ]) {
    let calls = 0;
    const f = setup({
      "group.budget.set": {
        revalidate() {},
        async execute() {
          calls++;
          throw error;
        },
      },
    });
    f.confirm(f.intention);
    const admitted = f.admit();
    const result = await f.registry.execute(admitted.operationID);
    expect(result).toEqual({
      operationID: admitted.operationID,
      state: "unknown",
      errorCode: "unavailable",
    });
    expect(canonical(result)).not.toContain("SECRET_SENTINEL");
    expect(
      JSON.stringify(f.db.query("SELECT * FROM operator_commands").all()),
    ).not.toContain("SECRET_SENTINEL");
    await f.registry.execute(admitted.operationID);
    expect(calls).toBe(1);
  }
});
test("stored body/confirmation tampering fails closed and dispatching crash never retries", async () => {
  for (const column of ["body_hash", "confirmation_binding"]) {
    const f = setup();
    f.confirm(f.intention);
    const admitted = f.admit();
    f.db.query(`UPDATE operator_commands SET ${column}='tampered'`).run();
    await expect(f.registry.execute(admitted.operationID)).rejects.toThrow(
      "forbidden",
    );
    expect(f.calls()).toBe(0);
  }
  const f = setup();
  f.confirm(f.intention);
  const admitted = f.admit();
  f.db.exec("UPDATE operator_commands SET state='dispatching'");
  expect(await f.registry.execute(admitted.operationID)).toEqual({
    operationID: admitted.operationID,
    state: "dispatching",
  });
  expect(f.calls()).toBe(0);
});
test("admission cannot use payload owner without a core-authentication latch", () => {
  const f = setup();
  expect(() =>
    f.persistence.transaction((sql) =>
      f.registry.enqueue(sql, f.intention, "forged"),
    ),
  ).toThrow("forbidden");
  expect(
    f.db.query("SELECT COUNT(*) AS n FROM operator_commands").get(),
  ).toEqual({ n: 0 });
});
