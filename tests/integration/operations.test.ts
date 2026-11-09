import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthorizationSnapshot,
  Authorizer,
} from "../../src/authorization/authorize";
import type { Principal, SessionRef } from "../../src/contracts";
import {
  openPersistence,
  type Persistence,
} from "../../src/persistence/database";
import {
  type OperationRequest,
  Operations,
  operationMigrationAt,
} from "../../src/persistence/operations";

function supervise(f: ReturnType<typeof fixture>, approved: boolean): void {
  f.snapshot.profile = "supervised";
  f.snapshot.approval = approved
    ? {
        principal: f.request().principal,
        target: f.request().target,
        capability: "message",
        revision: f.snapshot.revision,
        expiresAt: new Date(100_000).toISOString(),
        mode: "once",
      }
    : null;
}

test("supervised once: intent retains approval, dispatch consumes once, replay never sends again", async () => {
  const f = fixture();
  supervise(f, true);
  const op = await f.operations.enqueue(f.request());
  expect(f.snapshot.approval?.mode).toBe("once");
  const lease = f.operations.claim(op.operationID, "worker", 100);
  let sends = 0;
  const result = await f.operations.dispatch(
    f.request().principal,
    lease,
    1,
    async () => {
      sends++;
      return { state: "admitted", receiptID: "once-receipt", channel: "host" };
    },
  );
  expect(f.snapshot.approval).toBeNull();
  expect(await f.operations.enqueue(f.request())).toEqual(result);
  await expect(
    f.operations.dispatch(f.request().principal, lease, 1, async () => {
      sends++;
      return { state: "rejected" };
    }),
  ).rejects.toThrow();
  expect(sends).toBe(1);
});

test("supervised dispatch without approval has no host effect", async () => {
  const f = fixture();
  supervise(f, true);
  const op = await f.operations.enqueue(f.request());
  const lease = f.operations.claim(op.operationID, "worker", 100);
  f.snapshot.approval = null;
  let sends = 0;
  await expect(
    f.operations.dispatch(f.request().principal, lease, 1, async () => {
      sends++;
      return { state: "rejected" };
    }),
  ).rejects.toThrow("forbidden");
  expect(sends).toBe(0);
  expect(
    f.db
      .query<{ state: string }, [string]>(
        "SELECT state FROM operations WHERE operation_id=?",
      )
      .get(op.operationID)?.state,
  ).toBe("pending");
});

test("supervised revocation before dispatch denies even a fresh matching once approval", async () => {
  const f = fixture();
  supervise(f, true);
  const op = await f.operations.enqueue(f.request());
  const lease = f.operations.claim(op.operationID, "worker", 100);
  f.snapshot.revision = 2;
  supervise(f, true);
  f.snapshot.deniedCapabilities = ["message"];
  let sends = 0;
  await expect(
    f.operations.dispatch(f.request().principal, lease, 2, async () => {
      sends++;
      return { state: "rejected" };
    }),
  ).rejects.toThrow("forbidden");
  expect(sends).toBe(0);
  expect(f.snapshot.approval?.mode).toBe("once");
});

test("replay after revocation returns caller's original result without executing again", async () => {
  const f = fixture();
  // Isolate replay from the independent supervised-intent consumption regression.
  const op = await f.operations.enqueue(f.request());
  const lease = f.operations.claim(op.operationID, "worker", 100);
  let sends = 0;
  const result = await f.operations.dispatch(
    f.request().principal,
    lease,
    1,
    async () => {
      sends++;
      return {
        state: "admitted",
        receiptID: "replay-receipt",
        channel: "host",
      };
    },
  );
  supervise(f, false);
  f.snapshot.revision = 2;
  f.snapshot.deniedCapabilities = ["message"];
  expect(await f.operations.enqueue(f.request())).toEqual(result);
  expect(sends).toBe(1);
  expect(() =>
    f.operations.claim(op.operationID, "another-worker", 100),
  ).toThrow("conflict");
  await expect(
    f.operations.dispatch(f.request().principal, lease, 2, async () => {
      sends++;
      return { state: "rejected" };
    }),
  ).rejects.toThrow();
  expect(sends).toBe(1);
});

test("different authenticated principal cannot replay or reveal another caller's result", async () => {
  const f = fixture();
  const ownerRequest = f.request();
  const op = await f.operations.enqueue(ownerRequest);
  const lease = f.operations.claim(op.operationID, "owner-worker", 100);
  const result = await f.operations.dispatch(
    ownerRequest.principal,
    lease,
    1,
    async () => ({
      state: "admitted",
      receiptID: "PRIVATE-RECEIPT",
      channel: "host",
    }),
  );
  f.switchIdentity();
  supervise(f, false);
  f.snapshot.deniedCapabilities = ["message"];
  for (const action of [
    () => f.operations.enqueue(ownerRequest),
    () => f.operations.enqueue(f.request()),
    () =>
      f.operations.dispatch(f.request().principal, lease, 1, async () => ({
        state: "rejected",
      })),
  ]) {
    const failure = await action().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(result.operationID);
    expect(String(failure)).not.toContain("PRIVATE-RECEIPT");
    expect(String(failure)).not.toContain("PRIVATE-CONTENT");
  }
});

const roots: string[] = [];
const databases: Database[] = [];
const persistences: Persistence[] = [];
afterEach(() => {
  for (const persistence of persistences.splice(0)) persistence.close();
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "operations-"));
  roots.push(root);
  const path = join(root, "synthetic.sqlite");
  const repositoryPath = join(root, "repo");
  mkdirSync(repositoryPath);
  writeFileSync(path, "", { mode: 0o600 });
  const stat = statSync(path);
  const options = {
    repositoryPath,
    claims: [
      {
        instanceID: "i",
        scopeID: "scope",
        installationID: "test",
        canonicalPath: realpathSync(path),
        databaseIdentity: `${stat.dev}:${stat.ino}`,
      },
    ],
    migrations: [operationMigrationAt(2)],
  };
  const persistence = openPersistence(options);
  persistences.push(persistence);
  const db = new Database(path);
  databases.push(db);
  db.exec("PRAGMA busy_timeout=5000");
  let now = 1000;
  let identity: Principal = {
    kind: "session",
    session: {
      version: 1,
      instanceID: "i",
      projectID: "p",
      sessionID: "source",
    },
  };
  const target: SessionRef = {
    version: 1,
    instanceID: "i",
    projectID: "p",
    sessionID: "target",
  };
  const snapshot: AuthorizationSnapshot = {
    revision: 1,
    profile: "collaborate",
    profileCapabilities: ["message"],
    policyCapabilities: ["message"],
    hostCapabilities: ["message"],
    deniedCapabilities: [],
    grants: [],
    operator: null,
    delegationCapabilities: null,
    approval: null,
  };
  const authorization = new Authorizer(
    { current: async () => identity },
    {
      read: async () => snapshot,
      admission: (_principal, _target, check) =>
        persistence.transaction(() => check(snapshot)),
    },
    () => now,
  );
  // Isolated T13 fixture only; NOT production reconciliation wiring.
  const operations = new Operations(persistence, authorization, () => now, {
    assertAvailable() {},
  });
  const request = (): OperationRequest => ({
    principal: identity,
    target,
    capability: "message",
    expectedRevision: 1,
    idempotencyKey: "key",
    payload: { content: "PRIVATE-CONTENT" },
  });
  return {
    path,
    db,
    operations,
    request,
    snapshot,
    persistence,
    authorization,
    options,
    advance: () => {
      now += 101;
    },
    switchIdentity: () => {
      identity = {
        kind: "session",
        session: { ...target, sessionID: "other" },
      };
    },
  };
}

test("durable same key/envelope, divergent conflict, and caller scopes isolated", async () => {
  const f = fixture();
  const first = await f.operations.enqueue(f.request());
  expect(await f.operations.enqueue(f.request())).toEqual(first);
  await expect(
    f.operations.enqueue({ ...f.request(), payload: { content: "different" } }),
  ).rejects.toThrow("conflict");
  f.switchIdentity();
  expect((await f.operations.enqueue(f.request())).operationID).not.toBe(
    first.operationID,
  );
  const restarted = new Operations(f.persistence, f.authorization, () => 1000, {
    assertAvailable() {},
  }); // Isolated fixture, NOT production wiring.
  expect(await restarted.enqueue(f.request())).toEqual(
    await f.operations.enqueue(f.request()),
  );
  expect(f.db.query("SELECT * FROM operation_outbox").all()).toHaveLength(2);
});

test("dispatch is committed before I/O and timeout becomes unknown, never resent", async () => {
  const f = fixture();
  const operation = await f.operations.enqueue(f.request());
  const lease = f.operations.claim(operation.operationID, "worker", 100);
  let sends = 0;
  const result = await f.operations.dispatch(
    f.request().principal,
    lease,
    1,
    async () => {
      sends++;
      expect(f.db.inTransaction).toBe(false);
      expect(
        f.db.query<{ state: string }, []>("SELECT state FROM operations").get()
          ?.state,
      ).toBe("dispatching");
      throw new Error("PRIVATE-CONTENT");
    },
  );
  expect(result.state).toBe("unknown_outcome");
  await expect(
    f.operations.dispatch(f.request().principal, lease, 1, async () => {
      sends++;
      return { state: "rejected" };
    }),
  ).rejects.toThrow("conflict");
  expect(sends).toBe(1);
  expect(
    JSON.stringify(f.db.query("SELECT * FROM operation_audit").all()),
  ).not.toContain("PRIVATE-CONTENT");
  await expect(
    f.operations.reconcile(f.request().principal, operation.operationID, {
      inspect: async () => ({
        operationID: operation.operationID,
        payloadHash: "wrong",
        evidence: { state: "rejected" },
      }),
    }),
  ).rejects.toThrow("conflict");
  expect(
    (
      await f.operations.reconcile(
        f.request().principal,
        operation.operationID,
        {
          inspect: async () => ({
            operationID: operation.operationID,
            payloadHash: operation.payloadHash,
            evidence: {
              state: "admitted",
              receiptID: "receipt",
              channel: "host",
            },
          }),
        },
      )
    ).state,
  ).toBe("admitted");
});

test("fresh auth and lease CAS prevent new LOCAL admission by old worker", async () => {
  const f = fixture();
  const op = await f.operations.enqueue(f.request());
  const old = f.operations.claim(op.operationID, "old", 100);
  f.advance();
  const current = f.operations.claim(op.operationID, "new", 100);
  expect(current.generation).toBe(old.generation + 1);
  let sends = 0;
  const send = async () => {
    sends++;
    return { state: "rejected" as const };
  };
  await expect(
    f.operations.dispatch(f.request().principal, old, 1, send),
  ).rejects.toThrow("conflict");
  f.snapshot.deniedCapabilities = ["message"];
  await expect(
    f.operations.dispatch(f.request().principal, current, 1, send),
  ).rejects.toThrow("forbidden");
  expect(sends).toBe(0);
  f.snapshot.deniedCapabilities = [];
  f.snapshot.revision = 2;
  await expect(
    f.operations.dispatch(f.request().principal, current, 1, send),
  ).rejects.toThrow("conflict");
  expect(
    (await f.operations.dispatch(f.request().principal, current, 2, send))
      .state,
  ).toBe("rejected");
});

test("expiry after external admission exposes host window; recovery blocks retry", async () => {
  const f = fixture();
  const op = await f.operations.enqueue(f.request());
  const lease = f.operations.claim(op.operationID, "worker", 100);
  let hostEffects = 0;
  await expect(
    f.operations.dispatch(f.request().principal, lease, 1, async () => {
      f.advance();
      hostEffects++;
      return { state: "admitted", receiptID: "receipt", channel: "host" };
    }),
  ).rejects.toThrow("conflict");
  expect(hostEffects).toBe(1);
  expect(f.operations.recover()).toBe(1);
  expect(f.operations.recover()).toBe(0);
  expect(() => f.operations.claim(op.operationID, "new", 100)).toThrow(
    "conflict",
  );
});

test("DB failure before local admission never calls host; forged principal denied", async () => {
  const f = fixture();
  const op = await f.operations.enqueue(f.request());
  const lease = f.operations.claim(op.operationID, "worker", 100);
  let sends = 0;
  const send = async () => {
    sends++;
    return { state: "rejected" as const };
  };
  const principal = structuredClone(f.request().principal);
  await expect(
    f.operations.dispatch(principal, lease, 1, send),
  ).rejects.toThrow("forbidden");
  f.db.exec(
    "CREATE TRIGGER fail_admission BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT,'synthetic'); END",
  );
  await expect(
    f.operations.dispatch(f.request().principal, lease, 1, send),
  ).rejects.toThrow("unavailable");
  expect(sends).toBe(0);
});

test("two OS processes contend for one durable lease in the same SQLite file", async () => {
  const f = fixture();
  const op = await f.operations.enqueue(f.request());
  const source = `import {Database} from 'bun:sqlite';
    import {Persistence} from ${JSON.stringify(new URL("../../src/persistence/database.ts", import.meta.url).pathname)};
    import {Operations} from ${JSON.stringify(new URL("../../src/persistence/operations.ts", import.meta.url).pathname)};
    const db=new Database(process.argv[1]);db.exec('PRAGMA busy_timeout=5000');
    const p=new Persistence(db,()=>{});
    const o=new Operations(p, {},()=>1000, { assertAvailable() {} }); // Isolated fixture, NOT production wiring.
    try{o.claim(process.argv[2],process.argv[3],100);console.log('won')}catch{console.log('lost')}finally{db.close()}`;
  const children = ["a", "b"].map((owner) =>
    Bun.spawn(
      [process.execPath, "--eval", source, f.path, op.operationID, owner],
      { stdout: "pipe", stderr: "pipe" },
    ),
  );
  const results = await Promise.all(
    children.map(async (child) => {
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      return output.trim();
    }),
  );
  expect(results.sort()).toEqual(["lost", "won"]);
});

test("failed outbox commit rolls back operation and audit atomically", async () => {
  const f = fixture();
  f.db.exec(
    "CREATE TRIGGER fail_outbox BEFORE INSERT ON operation_outbox BEGIN SELECT RAISE(ABORT,'synthetic'); END",
  );
  await expect(f.operations.enqueue(f.request())).rejects.toThrow(
    "unavailable",
  );
  expect(f.db.query("SELECT * FROM operations").all()).toHaveLength(0);
  expect(f.db.query("SELECT * FROM operation_audit").all()).toHaveLength(0);
});

test("receipt write failure after host effect survives database close/reopen as uncertain", async () => {
  const f = fixture();
  const op = await f.operations.enqueue(f.request());
  const lease = f.operations.claim(op.operationID, "worker", 100);
  let effects = 0;
  f.db.exec(
    "CREATE TRIGGER fail_receipt BEFORE UPDATE ON operations WHEN NEW.state='admitted' BEGIN SELECT RAISE(ABORT,'synthetic'); END",
  );
  await expect(
    f.operations.dispatch(f.request().principal, lease, 1, async () => {
      effects++;
      return { state: "admitted", receiptID: "receipt", channel: "host" };
    }),
  ).rejects.toThrow("unknown_outcome");
  expect(effects).toBe(1);
  f.persistence.close();
  persistences.splice(persistences.indexOf(f.persistence), 1);
  const reopened = openPersistence(f.options);
  persistences.push(reopened);
  const restarted = new Operations(reopened, f.authorization, () => 1101, {
    assertAvailable() {},
  }); // Isolated fixture, NOT production wiring.
  expect(restarted.recover()).toBe(1);
  expect(() => restarted.claim(op.operationID, "restart", 100)).toThrow(
    "conflict",
  );
});

test("two process enqueue converges; process exit after dispatch commit never retries on restart", async () => {
  const f = fixture();
  const source = `
    import {openPersistence} from ${JSON.stringify(new URL("../../src/persistence/database.ts", import.meta.url).pathname)};
    import {operationMigrationAt,Operations} from ${JSON.stringify(new URL("../../src/persistence/operations.ts", import.meta.url).pathname)};
    import {Authorizer} from ${JSON.stringify(new URL("../../src/authorization/authorize.ts", import.meta.url).pathname)};
    const options=${JSON.stringify({ repositoryPath: f.options.repositoryPath, claims: f.options.claims })};
    const p=openPersistence({...options,migrations:[operationMigrationAt(2)]});
    const request=${JSON.stringify(f.request())};
    const snapshot=${JSON.stringify(f.snapshot)};
    const auth=new Authorizer({current:async()=>request.principal},{read:async()=>snapshot,admission:(_p,_t,check)=>p.transaction(()=>check(snapshot))},()=>1000);
    const o=new Operations(p,auth,()=>1000, { assertAvailable() {} }); // Isolated fixture, NOT production wiring.
    const op=await o.enqueue(request);
    if(process.argv[1]==='crash'){
      const lease=o.claim(op.operationID,'crash',100);
      await o.dispatch(request.principal,lease,1,async()=>{process.exit(17)});
    }else{console.log(op.operationID);p.close()}
  `;
  const children = [1, 2].map(() =>
    Bun.spawn([process.execPath, "--eval", source, "enqueue"], {
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const ids = await Promise.all(
    children.map(async (child) => {
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      return output.trim();
    }),
  );
  expect(ids[0]).toBe(ids[1]);
  expect(f.db.query("SELECT * FROM operations").all()).toHaveLength(1);
  const child = Bun.spawn([process.execPath, "--eval", source, "crash"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(17);
  const restarted = new Operations(f.persistence, f.authorization, () => 1101, {
    assertAvailable() {},
  }); // Isolated fixture, NOT production wiring.
  expect(restarted.recover()).toBe(1);
  expect(() => restarted.claim(ids[0] ?? "", "restart", 100)).toThrow(
    "conflict",
  );
});
