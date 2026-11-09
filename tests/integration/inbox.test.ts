import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  type AuthorizationSnapshot,
  Authorizer,
} from "../../src/authorization/authorize";
import {
  GRANTS_MIGRATION,
  type GrantPolicyPort,
  Grants,
} from "../../src/authorization/grants";
import {
  capabilities,
  type Principal,
  type SessionRef,
} from "../../src/contracts";
import {
  Inbox,
  inboxCleanupPort,
  inboxMigrationAt,
} from "../../src/messaging/inbox";
import { Persistence } from "../../src/persistence/database";
import {
  Operations,
  operationMigrationAt,
  pendingGrantOperations,
} from "../../src/persistence/operations";
import {
  reconciliationMigrationAt,
  removedTargetPort,
} from "../../src/sessions/reconcile";

const databases: Database[] = [];
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("missing fixture row");
  return value;
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  for (const descriptor of [
    { version: 2, ...GRANTS_MIGRATION },
    operationMigrationAt(3),
    reconciliationMigrationAt(4),
    inboxMigrationAt(5),
  ])
    descriptor.apply(db, "synthetic");
  const persistence = new Persistence(db, () => {});
  const source: SessionRef = {
    version: 1,
    instanceID: "fixture",
    projectID: "p",
    sessionID: "a",
  };
  const target: SessionRef = { ...source, projectID: "q", sessionID: "b" };
  let principal: Principal = { kind: "session", session: source };
  let now = 1000;
  const identity = { current: async () => principal };
  const snapshot: AuthorizationSnapshot = {
    revision: 1,
    profile: "manage",
    profileCapabilities: [...capabilities],
    policyCapabilities: [...capabilities],
    hostCapabilities: [...capabilities],
    deniedCapabilities: [],
    grants: [
      {
        version: 1,
        grantID: "g",
        source,
        target,
        capabilities: ["message"],
        revision: 1,
        issuer: {
          kind: "operator",
          instanceID: "fixture",
          operatorID: "o",
          revision: 1,
        },
        createdAt: new Date(0).toISOString(),
        expiresAt: null,
      },
    ],
    operator: null,
    delegationCapabilities: null,
    approval: null,
  };
  snapshot.grants = [
    ...snapshot.grants,
    {
      ...required(snapshot.grants[0]),
      grantID: "self-read",
      source: target,
      target,
      capabilities: ["read"],
    },
  ];
  db.exec("CREATE TABLE fixture_policy(body TEXT NOT NULL)");
  const save = () =>
    persistence.transaction((sql) => {
      sql
        .query("UPDATE fixture_policy SET body=?")
        .run(JSON.stringify(snapshot));
      sql.query("UPDATE grants_records SET revoked=1").run();
      for (const grant of snapshot.grants)
        sql
          .query("INSERT OR REPLACE INTO grants_records VALUES (?,?,0)")
          .run(grant.grantID, JSON.stringify(grant));
    });
  db.query("INSERT INTO fixture_policy VALUES (?)").run(
    JSON.stringify(snapshot),
  );
  save();
  const policy: GrantPolicyPort = {
    load: (sql) =>
      JSON.parse(
        required(
          sql
            .query<{ body: string }, []>("SELECT body FROM fixture_policy")
            .get(),
        ).body,
      ),
    save: (sql, s) => {
      sql.query("UPDATE fixture_policy SET body=?").run(JSON.stringify(s));
    },
  };
  const grants = new Grants(
    persistence,
    identity,
    policy,
    pendingGrantOperations(() => now),
    () => now,
  );
  const authorization = new Authorizer(
    identity,
    {
      read: async (p, target) =>
        persistence.transaction((sql) => ({
          ...policy.load(sql, p, target),
          grants: grants.snapshot(sql).grants,
        })),
      admission: (_principal, _target, check) =>
        persistence.transaction((sql) => {
          const s = JSON.parse(
            required(
              sql
                .query<{ body: string }, []>("SELECT body FROM fixture_policy")
                .get(),
            ).body,
          ) as AuthorizationSnapshot;
          s.grants = grants.snapshot(sql).grants;
          const result = check(s);
          sql.query("UPDATE fixture_policy SET body=?").run(JSON.stringify(s));
          return result;
        }),
    },
    () => now,
  );
  const inbox = new Inbox(
    persistence,
    identity,
    authorization,
    () => now,
    removedTargetPort,
  );
  const input = (content = "PRIVATE-CONTENT") => ({
    target,
    content,
    correlationID: "c",
    expiresAt: 2000,
    idempotencyKey: "key",
    expectedRevision: 1,
  });
  return {
    db,
    persistence,
    source,
    target,
    snapshot,
    save,
    inbox,
    operations: new Operations(
      persistence,
      authorization,
      () => now,
      removedTargetPort,
    ),
    input,
    actor: () => principal,
    asTarget: () => {
      principal = { kind: "session", session: target };
    },
    asOther: () => {
      principal = {
        kind: "session",
        session: { ...target, sessionID: "other" },
      };
    },
    time: (value: number) => {
      now = value;
    },
  };
}

test("durable envelope before dispatch, busy recipient requires no host or model adapter", async () => {
  const f = fixture();
  // A busy runtime cannot be forced: this API has no host or wake port.
  const op = await f.inbox.enqueueNotification(f.input());
  expect(op.state).toBe("pending");
  const stored = required(
    f.db
      .query<{ payload_json: string }, []>(
        "SELECT payload_json FROM operations",
      )
      .get(),
  );
  expect(JSON.parse(stored.payload_json).source).toEqual({
    kind: "session",
    session: f.source,
  });
  expect(f.db.query("SELECT * FROM notification_inbox").all()).toHaveLength(0);
  const delivered = await f.inbox.deliverNotification(op.operationID, 1);
  expect(delivered).toMatchObject({
    state: "admitted",
    channel: "inbox",
    receiptID: op.operationID,
  });
  expect(f.db.query("SELECT * FROM operation_outbox").all()).toHaveLength(1);
  expect(
    JSON.stringify(f.db.query("SELECT * FROM operation_audit").all()),
  ).not.toContain("PRIVATE-CONTENT");
  f.asTarget();
  const inbox = await f.inbox.receive(f.target, 1);
  expect(inbox).toHaveLength(1);
  expect(inbox[0]).toMatchObject({
    envelopeID: op.operationID,
    content: "PRIVATE-CONTENT",
    state: "admitted",
    type: "notification",
  });
});

test("65536 UTF-8 persists, 65537 rejected before any operation or content", async () => {
  const f = fixture();
  await expect(
    f.inbox.enqueueNotification(f.input(`${"é".repeat(32768)}a`)),
  ).rejects.toThrow("invalid_input");
  expect(f.db.query("SELECT * FROM operations").all()).toHaveLength(0);
  const op = await f.inbox.enqueueNotification(f.input("é".repeat(32768)));
  await f.inbox.deliverNotification(op.operationID, 1);
  f.asTarget();
  expect(
    new TextEncoder().encode(
      required((await f.inbox.receive(f.target, 1))[0]).content,
    ).length,
  ).toBe(65536);
});

test("revoked policy prevents local admission; replay has no delivery effect", async () => {
  const f = fixture();
  const op = await f.inbox.enqueueNotification(f.input());
  f.snapshot.deniedCapabilities = ["message"];
  f.save();
  expect(await f.inbox.enqueueNotification(f.input())).toEqual(op);
  await expect(f.inbox.deliverNotification(op.operationID, 1)).rejects.toThrow(
    "not_found",
  );
  expect(f.db.query("SELECT * FROM notification_inbox").all()).toHaveLength(0);
  expect(f.db.query("SELECT * FROM operation_outbox").all()).toHaveLength(1);
});

test("real removedTargetPort refuses tombstoned destination before intent", async () => {
  const f = fixture();
  f.db
    .query("INSERT INTO session_tombstones VALUES (?,?,?,?)")
    .run(f.target.instanceID, f.target.sessionID, f.target.projectID, 1000);
  await expect(f.inbox.enqueueNotification(f.input())).rejects.toThrow(
    "not_found",
  );
  expect(f.db.query("SELECT * FROM operations").all()).toHaveLength(0);
});

test("real tombstone also fences already queued notification", async () => {
  const f = fixture();
  const op = await f.inbox.enqueueNotification(f.input());
  f.db
    .query("INSERT INTO session_tombstones VALUES (?,?,?,?)")
    .run(f.target.instanceID, f.target.sessionID, f.target.projectID, 1000);
  await expect(f.inbox.deliverNotification(op.operationID, 1)).rejects.toThrow(
    "not_found",
  );
  expect(f.db.query("SELECT * FROM notification_inbox").all()).toHaveLength(0);
});

test("incoming direction is destination-only, read scope and current policy apply", async () => {
  const f = fixture();
  const op = await f.inbox.enqueueNotification(f.input());
  await f.inbox.deliverNotification(op.operationID, 1);
  await expect(f.inbox.receive(f.target, 1)).rejects.toThrow("not_found");
  f.asOther();
  await expect(f.inbox.receive(f.target, 1)).rejects.toThrow("not_found");
  f.asTarget();
  expect(await f.inbox.receive(f.target, 1)).toHaveLength(1);
  f.snapshot.deniedCapabilities = ["read"];
  f.save();
  await expect(f.inbox.receive(f.target, 1)).rejects.toThrow("forbidden");
});

test("expiry is checked at admission and hidden at exact expiration", async () => {
  const f = fixture();
  const op = await f.inbox.enqueueNotification(f.input());
  f.time(2000);
  await expect(f.inbox.deliverNotification(op.operationID, 1)).rejects.toThrow(
    "expired",
  );
  expect(f.db.query("SELECT * FROM notification_inbox").all()).toHaveLength(0);
  expect(
    f.db.query<{ state: string }, []>("SELECT state FROM operations").get()
      ?.state,
  ).toBe("pending");
});

test("already expired new intent rolls back envelope, outbox and audit", async () => {
  const f = fixture();
  f.time(2000);
  await expect(f.inbox.enqueueNotification(f.input())).rejects.toThrow(
    "expired",
  );
  expect(f.db.query("SELECT * FROM operations").all()).toHaveLength(0);
  expect(f.db.query("SELECT * FROM operation_outbox").all()).toHaveLength(0);
  expect(f.db.query("SELECT * FROM operation_audit").all()).toHaveLength(0);
});

test("an admitted notification expires for incoming reads, replay retains original receipt", async () => {
  const f = fixture();
  const op = await f.inbox.enqueueNotification(f.input());
  const receipt = await f.inbox.deliverNotification(op.operationID, 1);
  f.time(2000);
  expect(await f.inbox.enqueueNotification(f.input())).toEqual(receipt);
  f.asTarget();
  expect(await f.inbox.receive(f.target, 1)).toHaveLength(0);
});

test("admitted replay never adds outbox or redelivers and cannot be claimed twice", async () => {
  const f = fixture();
  const op = await f.inbox.enqueueNotification(f.input());
  const admitted = await f.inbox.deliverNotification(op.operationID, 1);
  f.snapshot.deniedCapabilities = ["message"];
  f.save();
  expect(await f.inbox.enqueueNotification(f.input())).toEqual(admitted);
  await expect(f.inbox.deliverNotification(op.operationID, 1)).rejects.toThrow(
    "conflict",
  );
  expect(f.db.query("SELECT * FROM notification_inbox").all()).toHaveLength(1);
});

test("once consumption succeeds exactly once", async () => {
  const f = fixture();
  f.snapshot.profile = "supervised";
  f.snapshot.approval = {
    principal: { kind: "session", session: f.source },
    target: f.target,
    capability: "message",
    revision: 1,
    expiresAt: new Date(5000).toISOString(),
    mode: "once",
  };
  f.save();
  const op = await f.inbox.enqueueNotification(f.input());
  await f.inbox.deliverNotification(op.operationID, 1);
  const s = JSON.parse(
    required(
      f.db.query<{ body: string }, []>("SELECT body FROM fixture_policy").get(),
    ).body,
  );
  expect(s.approval).toBeNull();
});

test("cleanup redacts incoming/outgoing content on supplied transaction, keeps audit", async () => {
  const f = fixture();
  const op = await f.inbox.enqueueNotification(f.input());
  await f.inbox.deliverNotification(op.operationID, 1);
  expect(() => inboxCleanupPort.cleanup(f.db, f.source)).toThrow("unavailable");
  f.persistence.transaction((db) => inboxCleanupPort.cleanup(db, f.source));
  expect(
    f.db
      .query<{ content: string | null }, []>(
        "SELECT content FROM notification_inbox",
      )
      .get()?.content,
  ).toBeNull();
  expect(
    f.db
      .query<{ payload_json: string }, []>(
        "SELECT payload_json FROM operations",
      )
      .get()?.payload_json,
  ).toBe("null");
  expect(f.db.query("SELECT * FROM operation_audit").all()).toHaveLength(3);
});

test("cross-project grant removed after intent denies admission without leaking content", async () => {
  const f = fixture();
  const op = await f.inbox.enqueueNotification(f.input());
  f.snapshot.grants = [];
  f.save();
  expect(await f.inbox.enqueueNotification(f.input())).toEqual(op);
  await expect(f.inbox.deliverNotification(op.operationID, 1)).rejects.toThrow(
    "not_found",
  );
  expect(f.db.query("SELECT * FROM notification_inbox").all()).toHaveLength(0);
});

test("another authenticated principal cannot deliver a guessed envelope ID", async () => {
  const f = fixture();
  const op = await f.inbox.enqueueNotification(f.input());
  f.asOther();
  await expect(f.inbox.deliverNotification(op.operationID, 1)).rejects.toThrow(
    "not_found",
  );
  expect(f.db.query("SELECT * FROM notification_inbox").all()).toHaveLength(0);
  expect(
    f.db
      .query<{ generation: number }, []>(
        "SELECT generation FROM operation_outbox",
      )
      .get()?.generation,
  ).toBe(0);
});

test("a forged stored source is refused at local admission, not used as envelope origin", async () => {
  const f = fixture();
  const op = await f.operations.enqueue({
    principal: f.actor(),
    target: f.target,
    capability: "message",
    expectedRevision: 1,
    idempotencyKey: "forged",
    payload: {
      version: 1,
      type: "notification",
      content: "PRIVATE-CONTENT",
      correlationID: "c",
      expiresAt: 2000,
      source: { kind: "session", session: f.target },
    },
  });
  await expect(f.inbox.deliverNotification(op.operationID, 1)).rejects.toThrow(
    "forbidden",
  );
  expect(f.db.query("SELECT * FROM notification_inbox").all()).toHaveLength(0);
  expect(
    f.db.query<{ state: string }, []>("SELECT state FROM operations").get()
      ?.state,
  ).toBe("pending");
});

test("lost final receipt is unknown_outcome, never retryable delivery or runtime completed", async () => {
  const f = fixture();
  const op = await f.inbox.enqueueNotification(f.input());
  f.db.exec(`CREATE TRIGGER lose_receipt BEFORE UPDATE OF state ON operations
    WHEN NEW.state='admitted' BEGIN SELECT RAISE(ABORT,'synthetic'); END`);
  await expect(f.inbox.deliverNotification(op.operationID, 1)).rejects.toThrow(
    "unknown_outcome",
  );
  expect(f.db.query("SELECT * FROM notification_inbox").all()).toHaveLength(1);
  f.time(31_000);
  expect(f.operations.recover()).toBe(1);
  expect(await f.inbox.enqueueNotification(f.input())).toMatchObject({
    state: "unknown_outcome",
    channel: null,
  });
  await expect(f.inbox.deliverNotification(op.operationID, 1)).rejects.toThrow(
    "conflict",
  );
  expect(f.db.query("SELECT * FROM notification_inbox").all()).toHaveLength(1);
});

test("expired local admission rolls back operation transition and reserved once consumption", async () => {
  const f = fixture();
  f.snapshot.profile = "supervised";
  f.snapshot.approval = {
    principal: { kind: "session", session: f.source },
    target: f.target,
    capability: "message",
    revision: 1,
    expiresAt: new Date(5000).toISOString(),
    mode: "once",
  };
  f.save();
  const op = await f.inbox.enqueueNotification(f.input());
  f.time(2000);
  await expect(f.inbox.deliverNotification(op.operationID, 1)).rejects.toThrow(
    "expired",
  );
  const row = f.db
    .query<{ body: string }, []>("SELECT body FROM fixture_policy")
    .get();
  expect(JSON.parse(row?.body ?? "null").approval.operationID).toBe(
    op.operationID,
  );
  expect(
    f.db.query<{ state: string }, []>("SELECT state FROM operations").get()
      ?.state,
  ).toBe("pending");
});
