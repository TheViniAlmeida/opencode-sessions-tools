import { describe, expect, test } from "bun:test";
import {
  type AuthorizationSnapshot,
  Authorizer,
} from "../../src/authorization/authorize";
import {
  capabilities,
  type Principal,
  type SessionRef,
} from "../../src/contracts";

const ref = (sessionID: string, projectID = "project"): SessionRef => ({
  version: 1,
  instanceID: "instance",
  projectID,
  sessionID,
});
const source = ref("source");
const target = ref("target");
const actor: Principal = { kind: "session", session: source };
const operator: Principal = {
  kind: "operator",
  operatorID: "fixture-only",
  instanceID: "instance",
  revision: 1,
};
// Synthetic trusted identity injection, NOT a product authentication proof.
function fixture(profile: AuthorizationSnapshot["profile"] = "manage") {
  let identity: Principal | null = actor;
  const snapshot: AuthorizationSnapshot = {
    revision: 1,
    profile,
    profileCapabilities: [...capabilities],
    policyCapabilities: [...capabilities],
    hostCapabilities: [...capabilities],
    deniedCapabilities: [],
    grants: [],
    operator: {
      operatorID: "fixture-only",
      instanceID: "instance",
      revision: 1,
      capabilities: [...capabilities],
      projects: ["project"],
      expiresAt: null,
    },
    delegationCapabilities: [...capabilities],
    approval: null,
  };
  const auth = new Authorizer(
    { current: async () => identity },
    {
      read: async () => snapshot,
      admission: (_principal, _target, check) => check(snapshot),
    },
    () => 1000,
  );
  return {
    auth,
    snapshot,
    identify: (value: Principal | null) => {
      identity = value;
    },
  };
}
const grant = (caps = [...capabilities]) => ({
  version: 1 as const,
  grantID: "grant",
  source,
  target,
  capabilities: caps,
  revision: 1,
  issuer: operator as Extract<Principal, { kind: "operator" }>,
  createdAt: new Date(0).toISOString(),
  expiresAt: null,
});

describe("local authorization boundary", () => {
  test("scheduled occurrence reserves schedule.manage once for the real operation and checks message without consuming twice", async () => {
    const f = fixture("supervised");
    let effects = 0;
    f.snapshot.grants = [grant(["schedule.manage"])];
    f.snapshot.approval = {
      principal: actor,
      target,
      capability: "schedule.manage",
      revision: 1,
      expiresAt: new Date(2000).toISOString(),
      mode: "once",
    };
    const occurrence = {
      jobID: "job",
      scheduleRevision: 1,
      occurrenceID: "occurrence",
    };
    await f.auth.scheduledOperation(
      actor,
      target,
      1,
      "real-op",
      "intent",
      () => ++effects,
      occurrence,
    );
    expect(f.snapshot.approval?.operationID).toBe("real-op");
    expect(f.snapshot.approval?.mode).toBe("once");
    await expect(
      f.auth.authorizeIntent(
        actor,
        target,
        "schedule.manage",
        1,
        "real-op",
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.auth.admitOperation(
        actor,
        target,
        "schedule.manage",
        1,
        "real-op",
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.auth.admit(actor, target, "schedule.manage", 1, () => ++effects),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.auth.scheduledOperation(
        actor,
        target,
        1,
        "occurrence",
        "admission",
        () => ++effects,
        occurrence,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.auth.scheduledOperation(
        actor,
        target,
        1,
        "real-op",
        "admission",
        () => ++effects,
        { ...occurrence, jobID: "other" },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.auth.scheduledOperation(
        actor,
        target,
        1,
        "real-op",
        "admission",
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await f.auth.scheduledOperation(
      actor,
      target,
      1,
      "real-op",
      "admission",
      () => ++effects,
      occurrence,
    );
    expect(f.snapshot.approval).toBeNull();
    expect(effects).toBe(2);
  });
  test("scheduled modality cannot be stolen by delegation and cross-project message still needs its own grant", async () => {
    const f = fixture("supervised");
    let effects = 0;
    f.snapshot.grants = [grant()];
    f.snapshot.approval = {
      principal: actor,
      target,
      capability: "schedule.manage",
      revision: 1,
      expiresAt: new Date(2000).toISOString(),
      mode: "once",
    };
    await f.auth.scheduledOperation(
      actor,
      target,
      1,
      "scheduled",
      "intent",
      () => ++effects,
    );
    if (!f.snapshot.approval) throw new Error("missing fixture approval");
    f.snapshot.approval.capability = "manage";
    await expect(
      f.auth.delegatedOperation(
        actor,
        target,
        [],
        1,
        "scheduled",
        "intent",
        [],
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.auth.delegate(actor, target, [], () => ++effects),
    ).rejects.toMatchObject({ code: "forbidden" });
    f.snapshot.approval.scheduled = undefined;
    f.snapshot.approval.delegation = {
      requested: [],
      requiredCapabilities: [],
    };
    f.snapshot.approval.capability = "schedule.manage";
    await expect(
      f.auth.scheduledOperation(
        actor,
        target,
        1,
        "scheduled",
        "intent",
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const crossTarget = ref("target", "other-project");
    f.snapshot.approval = {
      principal: actor,
      target: crossTarget,
      capability: "schedule.manage",
      revision: 1,
      expiresAt: new Date(2000).toISOString(),
      mode: "once",
    };
    f.snapshot.grants = [
      { ...grant(["schedule.manage"]), target: crossTarget },
    ];
    await expect(
      f.auth.scheduledOperation(
        actor,
        crossTarget,
        1,
        "cross-op",
        "intent",
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    f.snapshot.grants = [
      { ...grant(["schedule.manage", "message"]), target: crossTarget },
    ];
    await f.auth.scheduledOperation(
      actor,
      crossTarget,
      1,
      "cross-op",
      "intent",
      () => ++effects,
    );
    await f.auth.scheduledOperation(
      actor,
      crossTarget,
      1,
      "cross-op",
      "admission",
      () => ++effects,
    );
    await expect(
      f.auth.scheduledOperation(
        actor,
        target,
        1,
        "bad",
        "intent",
        () => ++effects,
        { jobID: "j", scheduleRevision: -1, occurrenceID: "o" },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(effects).toBe(3);
  });
  test("scheduled occurrence revalidates message, source caps, expiry and revision; non-supervised needs no approval", async () => {
    const f = fixture("supervised");
    let effects = 0;
    f.snapshot.grants = [grant()];
    const approval = {
      principal: actor,
      target,
      capability: "schedule.manage" as const,
      revision: 1,
      expiresAt: new Date(2000).toISOString(),
      mode: "once" as const,
    };
    f.snapshot.approval = { ...approval };
    f.snapshot.deniedCapabilities = ["message"];
    await expect(
      f.auth.scheduledOperation(
        actor,
        target,
        1,
        "op",
        "intent",
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(f.snapshot.approval.operationID).toBeUndefined();
    f.snapshot.deniedCapabilities = [];
    await f.auth.scheduledOperation(
      actor,
      target,
      1,
      "op",
      "intent",
      () => ++effects,
    );
    f.snapshot.grants = [];
    await expect(
      f.auth.scheduledOperation(
        actor,
        target,
        1,
        "op",
        "admission",
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    f.snapshot.grants = [grant()];
    f.snapshot.revision = 2;
    await expect(
      f.auth.scheduledOperation(
        actor,
        target,
        1,
        "op",
        "admission",
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      f.auth.scheduledOperation(
        actor,
        target,
        2,
        "op",
        "admission",
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    f.snapshot.revision = 1;
    f.snapshot.approval.expiresAt = new Date(1000).toISOString();
    await expect(
      f.auth.scheduledOperation(
        actor,
        target,
        1,
        "op",
        "admission",
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    f.snapshot.profile = "bounded-auto";
    f.snapshot.approval = null;
    await f.auth.scheduledOperation(
      actor,
      target,
      1,
      "auto-op",
      "intent",
      () => ++effects,
    );
    await f.auth.scheduledOperation(
      actor,
      target,
      1,
      "auto-op",
      "admission",
      () => ++effects,
    );
    f.snapshot.delegationCapabilities = ["message"];
    await expect(
      f.auth.scheduledOperation(
        actor,
        target,
        1,
        "auto-op2",
        "intent",
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.auth.scheduledOperation(
        actor,
        target,
        1,
        "op",
        "invalid" as never,
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(effects).toBe(3);
  });
  test("delegated operation reserves manage approval, checks fork read without a second consumption", async () => {
    const f = fixture("supervised");
    let effects = 0;
    f.snapshot.grants = [grant()];
    f.snapshot.approval = {
      principal: actor,
      target,
      capability: "manage",
      revision: 1,
      expiresAt: new Date(2000).toISOString(),
      mode: "once",
    };
    const intent = await f.auth.delegatedOperation(
      actor,
      target,
      ["message"],
      1,
      "fork",
      "intent",
      ["read"],
      () => ++effects,
    );
    expect(intent).toMatchObject({
      state: "admitted",
      data: 1,
      capabilities: ["message"],
      revision: 1,
    });
    expect(f.snapshot.approval?.mode).toBe("once");
    await expect(
      f.auth.admitOperation(
        actor,
        target,
        "manage",
        1,
        "fork",
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.auth.delegatedOperation(
        actor,
        target,
        ["read"],
        1,
        "fork",
        "admission",
        ["read"],
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.auth.delegatedOperation(
        actor,
        target,
        ["message"],
        1,
        "fork",
        "admission",
        [],
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await f.auth.delegatedOperation(
      actor,
      target,
      ["message"],
      1,
      "fork",
      "admission",
      ["read"],
      () => ++effects,
    );
    expect(f.snapshot.approval).toBeNull();
    expect(effects).toBe(2);
  });
  test("delegated operation missing policy awaits approval; excess, expiry, revision and fork read fail before effects", async () => {
    const f = fixture("supervised");
    let effects = 0;
    f.snapshot.grants = [grant()];
    f.snapshot.approval = {
      principal: actor,
      target,
      capability: "manage",
      revision: 1,
      expiresAt: new Date(2000).toISOString(),
      mode: "once",
    };
    f.snapshot.delegationCapabilities = null;
    expect(
      await f.auth.delegatedOperation(
        actor,
        target,
        [],
        1,
        "op",
        "intent",
        [],
        () => ++effects,
      ),
    ).toEqual({ state: "awaiting_approval" });
    f.snapshot.delegationCapabilities = ["manage"];
    await expect(
      f.auth.delegatedOperation(
        actor,
        target,
        ["read"],
        1,
        "op",
        "intent",
        [],
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    f.snapshot.delegationCapabilities = [...capabilities];
    f.snapshot.grants = [grant(["manage"])];
    await expect(
      f.auth.delegatedOperation(
        actor,
        target,
        [],
        1,
        "op",
        "intent",
        ["read"],
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    f.snapshot.grants = [grant()];
    await f.auth.delegatedOperation(
      actor,
      target,
      [],
      1,
      "op",
      "intent",
      [],
      () => ++effects,
    );
    f.snapshot.revision = 2;
    await expect(
      f.auth.delegatedOperation(
        actor,
        target,
        [],
        1,
        "op",
        "admission",
        [],
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      f.auth.delegatedOperation(
        actor,
        target,
        [],
        2,
        "op",
        "admission",
        [],
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    f.snapshot.revision = 1;
    if (!f.snapshot.approval) throw new Error("missing fixture approval");
    f.snapshot.approval.expiresAt = new Date(1000).toISOString();
    await expect(
      f.auth.delegatedOperation(
        actor,
        target,
        [],
        1,
        "op",
        "admission",
        [],
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.auth.delegatedOperation(
        actor,
        target,
        [],
        1,
        "op",
        "unknown" as never,
        [],
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      f.auth.delegatedOperation(
        actor,
        target,
        [],
        1,
        "op",
        "intent",
        ["message"],
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(effects).toBe(1);
  });
  test("operator may approve before an operation ID exists; intent reserves it without consumption", async () => {
    const f = fixture("supervised");
    let effects = 0;
    f.snapshot.approval = {
      principal: actor,
      target,
      capability: "message",
      revision: 1,
      expiresAt: new Date(2000).toISOString(),
      mode: "once",
    };
    await f.auth.authorizeIntent(
      actor,
      target,
      "message",
      1,
      "internally-generated",
      () => ++effects,
    );
    expect(f.snapshot.approval?.operationID).toBe("internally-generated");
    expect(f.snapshot.approval?.mode).toBe("once");
    await expect(
      f.auth.authorizeIntent(
        actor,
        target,
        "message",
        1,
        "different-operation",
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await f.auth.admitOperation(
      actor,
      target,
      "message",
      1,
      "internally-generated",
      () => ++effects,
    );
    expect(f.snapshot.approval).toBeNull();
    expect(effects).toBe(2);
  });
  test("operation intent preserves once, dispatch consumes it, authenticated replay needs no target approval", async () => {
    const f = fixture("supervised");
    let effects = 0;
    f.snapshot.approval = {
      principal: actor,
      target,
      capability: "message",
      revision: 1,
      expiresAt: new Date(2000).toISOString(),
      mode: "once",
      operationID: "op-1",
    };
    await f.auth.authorizeIntent(
      actor,
      target,
      "message",
      1,
      "op-1",
      () => ++effects,
    );
    expect(f.snapshot.approval?.operationID).toBe("op-1");
    await expect(
      f.auth.admit(actor, target, "message", 1, () => ++effects),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.auth.admitOperation(
        actor,
        target,
        "message",
        1,
        "op-2",
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await f.auth.admitOperation(
      actor,
      target,
      "message",
      1,
      "op-1",
      () => ++effects,
    );
    expect(f.snapshot.approval).toBeNull();
    f.snapshot.policyCapabilities = [];
    await f.auth.authorizeReplay(actor, { kind: "session", session: source });
    await expect(
      f.auth.authorizeReplay(actor, { kind: "session", session: target }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      f.auth.authorizeReplay({ ...actor }, actor),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(effects).toBe(2);
  });
  test("operation intent requires current approval; revision change or revocation prevents dispatch", async () => {
    const f = fixture("supervised");
    let effects = 0;
    await expect(
      f.auth.authorizeIntent(
        actor,
        target,
        "message",
        1,
        "op",
        () => ++effects,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    f.snapshot.approval = {
      principal: actor,
      target,
      capability: "message",
      revision: 1,
      expiresAt: new Date(2000).toISOString(),
      mode: "once",
      operationID: "op",
    };
    await f.auth.authorizeIntent(
      actor,
      target,
      "message",
      1,
      "op",
      () => ++effects,
    );
    f.snapshot.revision = 2;
    await expect(
      f.auth.admitOperation(actor, target, "message", 2, "op", () => ++effects),
    ).rejects.toMatchObject({ code: "forbidden" });
    f.snapshot.revision = 1;
    f.snapshot.deniedCapabilities = ["message"];
    await expect(
      f.auth.admitOperation(actor, target, "message", 1, "op", () => ++effects),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(effects).toBe(1);
  });
  test("operation approval cannot outlive the grant or be reused with another target/capability", async () => {
    const f = fixture("supervised");
    let effects = 0;
    f.snapshot.grants = [grant()];
    f.snapshot.approval = {
      principal: actor,
      target,
      capability: "manage",
      revision: 1,
      expiresAt: new Date(2000).toISOString(),
      mode: "once",
      operationID: "op",
    };
    await f.auth.authorizeIntent(
      actor,
      target,
      "manage",
      1,
      "op",
      () => ++effects,
    );
    await expect(
      f.auth.admitOperation(actor, source, "manage", 1, "op", () => ++effects),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.auth.admitOperation(actor, target, "message", 1, "op", () => ++effects),
    ).rejects.toMatchObject({ code: "forbidden" });
    f.snapshot.grants = [];
    await expect(
      f.auth.admitOperation(actor, target, "manage", 1, "op", () => ++effects),
    ).rejects.toMatchObject({ code: "forbidden" });
    await f.auth.authorizeReplay(actor, actor);
    expect(effects).toBe(1);
  });
  test("same-project minimum is discover/message, never history or management", async () => {
    const { auth } = fixture();
    await auth.authorize(actor, target, "discover");
    await auth.authorize(actor, target, "message");
    for (const cap of capabilities.filter(
      (c) => c !== "discover" && c !== "message",
    ))
      await expect(auth.authorize(actor, target, cap)).rejects.toMatchObject({
        code: "forbidden",
      });
  });
  test("forged principal, missing boundary and cross-project denial do not disclose", async () => {
    const f = fixture();
    await expect(
      f.auth.authorize({ ...actor }, target, "discover"),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.auth.authorize(actor, ref("secret", "other"), "discover"),
    ).rejects.toMatchObject({ code: "not_found", message: "not_found" });
    f.identify(null);
    await expect(
      f.auth.authorize(actor, target, "discover"),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
  test("exact profile ceilings intersect grants, current policy and host denies", async () => {
    for (const profile of [
      "observe",
      "collaborate",
      "manage",
      "supervised",
      "bounded-auto",
    ] as const) {
      const f = fixture(profile);
      f.snapshot.grants = [grant()];
      for (const cap of capabilities) {
        const allowed =
          profile === "observe"
            ? ["discover", "read", "context.read"].includes(cap)
            : profile === "collaborate"
              ? !["manage", "session.configure", "schedule.manage"].includes(
                  cap,
                )
              : true;
        const mutation = !["discover", "read", "context.read"].includes(cap);
        if (allowed && !(profile === "supervised" && mutation))
          await f.auth.authorize(actor, target, cap);
        else
          await expect(
            f.auth.authorize(actor, target, cap),
          ).rejects.toMatchObject({ code: "forbidden" });
      }
      f.snapshot.deniedCapabilities = ["read"];
      await expect(
        f.auth.authorize(actor, target, "read"),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
  });
  test("direction, expiry, revision and current restrictions rechecked before callback", async () => {
    const f = fixture();
    f.snapshot.grants = [grant()];
    await f.auth.authorizeAction(actor, target, "configure");
    let effects = 0;
    await f.auth.admit(actor, target, "read", 1, () => ++effects);
    f.snapshot.policyCapabilities = [];
    await expect(
      f.auth.admit(actor, target, "read", 1, () => ++effects),
    ).rejects.toMatchObject({ code: "forbidden" });
    f.snapshot.policyCapabilities = [...capabilities];
    f.snapshot.revision = 2;
    await expect(
      f.auth.admit(actor, target, "read", 1, () => ++effects),
    ).rejects.toMatchObject({ code: "conflict" });
    f.snapshot.grants = [
      { ...grant(), expiresAt: new Date(1000).toISOString() },
    ];
    await expect(f.auth.authorize(actor, target, "read")).rejects.toMatchObject(
      { code: "forbidden" },
    );
    f.snapshot.grants = [{ ...grant(), source: target, target: source }];
    await expect(f.auth.authorize(actor, target, "read")).rejects.toMatchObject(
      { code: "forbidden" },
    );
    expect(effects).toBe(1);
  });
  test("sessions cannot selfgrant, always, policy/profile change or selfconfigure", async () => {
    const f = fixture();
    f.snapshot.grants = [grant()];
    for (const action of [
      "grant",
      "policy",
      "profile",
      "always",
      "configure",
    ] as const)
      await expect(
        f.auth.authorizeAction(actor, source, action),
      ).rejects.toMatchObject({ code: "forbidden" });
    f.identify(operator);
    await f.auth.authorizeAction(operator, source, "grant");
    if (!f.snapshot.operator) throw new Error("missing fixture operator");
    f.snapshot.operator.revision = 2;
    await expect(
      f.auth.authorizeAction(operator, source, "grant"),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
  test("delegation absent waits; excess rejects before effect; existing children use current policy", async () => {
    const f = fixture();
    f.snapshot.grants = [grant()];
    let effects = 0;
    f.snapshot.delegationCapabilities = null;
    expect(
      await f.auth.delegate(actor, target, ["read"], () => ++effects),
    ).toEqual({ state: "awaiting_approval" });
    f.snapshot.delegationCapabilities = ["discover", "manage"];
    await expect(
      f.auth.delegate(actor, target, ["read"], () => ++effects),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(effects).toBe(0);
    await expect(f.auth.authorize(actor, target, "read")).rejects.toMatchObject(
      { code: "forbidden" },
    );
    expect(
      await f.auth.delegate(actor, target, ["discover"], () => ++effects),
    ).toEqual({
      state: "admitted",
      data: 1,
      capabilities: ["discover"],
      revision: 1,
    });
  });
  test("supervised individual approval binds principal, target, capability, revision and time; always not reused", async () => {
    const f = fixture("supervised");
    f.snapshot.grants = [grant()];
    f.snapshot.approval = {
      principal: actor,
      target,
      capability: "message",
      revision: 1,
      expiresAt: new Date(2000).toISOString(),
      mode: "once",
    };
    await f.auth.authorize(actor, target, "message");
    await f.auth.admit(actor, target, "message", 1, () => undefined);
    await expect(
      f.auth.admit(actor, target, "message", 1, () => undefined),
    ).rejects.toMatchObject({ code: "forbidden" });
    f.snapshot.approval = {
      principal: actor,
      target,
      capability: "message",
      revision: 1,
      expiresAt: new Date(2000).toISOString(),
      mode: "always",
    };
    f.snapshot.approval.mode = "always";
    await expect(
      f.auth.authorize(actor, target, "message"),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
  test("unknown runtime input and malformed snapshot fail closed", async () => {
    const f = fixture();
    await expect(
      f.auth.authorize(actor, target, "delete" as never),
    ).rejects.toMatchObject({ code: "invalid_input" });
    f.snapshot.profile = "admin" as never;
    await expect(
      f.auth.authorize(actor, target, "discover"),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
  test("self scope still requires grants, and self configuration never follows a grant", async () => {
    const f = fixture();
    f.snapshot.grants = [{ ...grant(), target: source }];
    for (const cap of capabilities) {
      if (cap === "session.configure")
        await expect(
          f.auth.authorize(actor, source, cap),
        ).rejects.toMatchObject({ code: "forbidden" });
      else await f.auth.authorize(actor, source, cap);
    }
  });
  test("operator scope, expiry and caps do not bypass any host restriction", async () => {
    const f = fixture();
    f.identify(operator);
    await f.auth.authorize(operator, target, "manage");
    for (const field of [
      "profileCapabilities",
      "policyCapabilities",
      "hostCapabilities",
    ] as const) {
      f.snapshot[field] = [];
      await expect(
        f.auth.authorize(operator, target, "manage"),
      ).rejects.toMatchObject({ code: "forbidden" });
      f.snapshot[field] = [...capabilities];
    }
    if (!f.snapshot.operator) throw new Error("missing fixture operator");
    f.snapshot.operator.expiresAt = new Date(1000).toISOString();
    await expect(
      f.auth.authorize(operator, target, "manage"),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
  test("delegation cannot exceed creator grant, missing admission adapter cannot invoke callback", async () => {
    const f = fixture();
    let effects = 0;
    f.snapshot.grants = [grant(["manage"])];
    await expect(
      f.auth.delegate(actor, target, ["read"], () => ++effects),
    ).rejects.toMatchObject({ code: "forbidden" });
    const readOnlyAuth = new Authorizer(
      { current: async () => actor },
      { read: async () => f.snapshot },
      () => 1000,
    );
    await expect(
      readOnlyAuth.admit(actor, target, "message", 1, () => ++effects),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(effects).toBe(0);
  });
  test("malformed security records and expired or mismatched saved approval fail closed", async () => {
    const f = fixture("supervised");
    f.snapshot.grants = [grant()];
    const approval = {
      principal: actor,
      target,
      capability: "message" as const,
      revision: 1,
      expiresAt: new Date(2000).toISOString(),
      mode: "once" as const,
    };
    for (const change of [
      { expiresAt: new Date(1000).toISOString() },
      { revision: 0 },
      { target: source },
      { principal: operator },
      { capability: "manage" as const },
    ]) {
      f.snapshot.approval = { ...approval, ...change };
      await expect(
        f.auth.authorize(actor, target, "message"),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    f.snapshot.grants = [{ ...grant(), expiresAt: "tomorrow" }];
    await expect(
      f.auth.authorize(actor, target, "message"),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});
