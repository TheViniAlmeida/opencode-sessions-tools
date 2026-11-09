import { afterEach, expect, test } from "bun:test";
import { OperatorCore } from "../../src/authorization/operator-core";
import { openPersistence } from "../../src/persistence/database";
import {
  composition,
  fixture,
  localEffect,
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

for (const sameChallenge of [true, false])
  test(`two independent processes racing ${sameChallenge ? "one challenge" : "fresh challenges"}/same key record exactly one local effect`, async () => {
    const f = setup();
    f.confirm();
    const attempt = f.attempt(),
      challenge = f.core.issue(attempt);
    const secondChallenge = sameChallenge ? challenge : f.core.issue(attempt);
    const workers = ["one", "two"].map((prefix, index) =>
      Bun.spawn(
        [
          process.execPath,
          new URL("../fixtures/operator-core-worker.ts", import.meta.url)
            .pathname,
          JSON.stringify({
            path: f.path,
            repo: f.repo,
            attempt,
            challenge: index === 0 ? challenge : secondChallenge,
            raw: f.raw(),
            prefix,
          }),
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      ),
    );
    const readers = workers.map((w) => w.stdout.getReader());
    try {
      for (const reader of readers) {
        const ready = await reader.read();
        expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
      }
      for (const worker of workers) {
        worker.stdin.write("go\n");
        worker.stdin.end();
      }
      const results = await Promise.all(
        readers.map(async (reader) => {
          let output = "";
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            output += new TextDecoder().decode(chunk.value);
          }
          return JSON.parse(output) as { status: string; operationID?: string };
        }),
      );
      expect(results.map((r) => r.status).sort()).toEqual(
        sameChallenge ? ["admitted", "forbidden"] : ["admitted", "admitted"],
      );
      if (!sameChallenge)
        expect(results[0]?.operationID).toBe(results[1]?.operationID);
      for (const worker of workers) {
        expect(await worker.exited).toBe(0);
        expect(await new Response(worker.stderr).text()).toBe("");
      }
      expect(f.count()).toBe(1);
      const winningID = results.find(
        (r) => r.status === "admitted",
      )?.operationID;
      if (!winningID) throw new Error("synthetic admission missing");
      expect(
        f.core.admit(attempt, f.core.issue(attempt), f.raw(), localEffect)
          .operationID,
      ).toBe(winningID);
    } finally {
      for (const worker of workers) worker.kill();
    }
  });

test("restart keeps canonical revocation and original ledger; core performs no enrollment", () => {
  const f = setup();
  f.confirm();
  const a = f.attempt();
  const first = f.core.admit(a, f.core.issue(a), f.raw(), localEffect);
  f.db.exec("UPDATE operator_credentials SET revoked=1");
  const reopened = openPersistence(f.persistenceOptions);
  try {
    const core = new OperatorCore(
      reopened,
      composition(() => 100000, "restart"),
    );
    expect(() => core.issue(a)).toThrow("forbidden");
    expect(
      f.db
        .query<{ operation_id: string }, []>(
          "SELECT operation_id FROM operator_ledger",
        )
        .get()?.operation_id,
    ).toBe(first.operationID);
    expect(f.count()).toBe(1);
  } finally {
    reopened.close();
  }
});

test("read-own denial after issuance and missing confirmation never commit local changes", () => {
  const f = setup(),
    a = f.attempt(),
    c = f.core.issue(a);
  expect(() => f.core.admit(a, c, f.raw(), localEffect)).toThrow("forbidden");
  f.confirm();
  f.db.exec("UPDATE synthetic_policy SET new_effect=0");
  expect(() => f.core.admit(a, c, f.raw(), localEffect)).toThrow("forbidden");
  f.db.exec("UPDATE synthetic_policy SET new_effect=1,read_own=0");
  expect(() => f.core.admit(a, c, f.raw(), localEffect)).toThrow("forbidden");
  f.db.exec("UPDATE synthetic_policy SET read_own=1");
  f.core.admit(a, c, f.raw(), localEffect);
  expect(f.count()).toBe(1);
});

test("generated challenge primary-key collision is unavailable and rolls back without consuming prior challenge or confirmation", () => {
  const f = setup();
  f.confirm();
  const a = f.attempt(),
    c = f.core.issue(a);
  let collide = true;
  const core = new OperatorCore(f.persistence, {
    ...f.options,
    generate(kind) {
      return kind === "challenge" && collide
        ? c.challengeID
        : f.options.generate(kind);
    },
  });
  expect(() => core.issue(a)).toThrow("unavailable");
  expect(
    f.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM operator_challenges")
      .get()?.n,
  ).toBe(1);
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
  expect(f.count()).toBe(0);
  collide = false;
  expect(core.admit(a, c, f.raw(), localEffect).expired).toBe(false);
  expect(f.count()).toBe(1);
  expect(core.issue(a).challengeID).not.toBe(c.challengeID);
});

test("generated operation unique collision rolls back local effect, challenge, confirmation and ledger; same challenge retry succeeds", () => {
  const f = setup();
  f.confirm();
  const a = f.attempt();
  const first = f.core.admit(a, f.core.issue(a), f.raw(), localEffect);
  const next = f.intention({ confirmationID: "confirmation-next" });
  f.confirm(next);
  const raw = f.raw({ confirmationID: "confirmation-next" }, "next-key"),
    b = f.attempt(raw),
    c = f.core.issue(b);
  let collide = true;
  const core = new OperatorCore(f.persistence, {
    ...f.options,
    generate(kind) {
      return kind === "operation" && collide
        ? first.operationID
        : f.options.generate(kind);
    },
  });
  // A separate unique local row ensures the fault reaches operator_ledger's
  // operation_id UNIQUE constraint, not the fixture effect table's primary key.
  const local = (
    sql: Parameters<typeof localEffect>[0],
    intent: Parameters<typeof localEffect>[1],
    id: string,
  ) => localEffect(sql, intent, `PUBLIC_TEST_ONLY_second_effect_${id}`);
  expect(() => core.admit(b, c, raw, local)).toThrow("unavailable");
  expect(f.count()).toBe(1);
  expect(
    f.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM operator_ledger")
      .get()?.n,
  ).toBe(1);
  expect(
    f.db
      .query<{ consumed: number }, [string]>(
        "SELECT consumed FROM operator_challenges WHERE challenge_id=?",
      )
      .get(c.challengeID)?.consumed,
  ).toBe(0);
  expect(
    f.db
      .query<{ consumed: number }, [string]>(
        "SELECT consumed FROM operator_confirmations WHERE confirmation_id=?",
      )
      .get("confirmation-next")?.consumed,
  ).toBe(0);
  expect(
    f.db
      .query<{ consumed: number }, [string]>(
        "SELECT consumed FROM operator_confirmations WHERE confirmation_id=?",
      )
      .get("confirmation")?.consumed,
  ).toBe(1);
  collide = false;
  const second = core.admit(b, c, raw, local);
  expect(second.operationID).not.toBe(first.operationID);
  expect(f.count()).toBe(2);
  expect(
    f.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM operator_ledger")
      .get()?.n,
  ).toBe(2);
  expect(
    f.db
      .query<{ consumed: number }, [string]>(
        "SELECT consumed FROM operator_challenges WHERE challenge_id=?",
      )
      .get(c.challengeID)?.consumed,
  ).toBe(1);
  expect(
    f.db
      .query<{ consumed: number }, [string]>(
        "SELECT consumed FROM operator_confirmations WHERE confirmation_id=?",
      )
      .get("confirmation-next")?.consumed,
  ).toBe(1);
  expect(core.admit(b, core.issue(b), raw, local)).toEqual(second);
  expect(f.count()).toBe(2);
});

test("reused nonce on distinct challenge IDs does not collapse attempt identity or duplicate an effect", () => {
  const f = setup();
  f.confirm();
  const a = f.attempt();
  const core = new OperatorCore(f.persistence, {
    ...f.options,
    generate(kind) {
      return kind === "nonce"
        ? "PUBLIC_TEST_ONLY_reused_nonce"
        : f.options.generate(kind);
    },
  });
  const one = core.issue(a),
    two = core.issue(a);
  expect(one.nonce).toBe(two.nonce);
  expect(one.challengeID).not.toBe(two.challengeID);
  const first = core.admit(a, one, f.raw(), localEffect);
  expect(core.admit(a, two, f.raw(), localEffect)).toEqual(first);
  expect(f.count()).toBe(1);
  expect(
    f.db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM operator_challenges WHERE consumed=1",
      )
      .get()?.n,
  ).toBe(2);
  expect(() => core.admit(a, one, f.raw(), localEffect)).toThrow("forbidden");
});
