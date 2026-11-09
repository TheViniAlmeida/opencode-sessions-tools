import {
  createOperatorGateway,
  type GatewayClock,
} from "../../src/transport/operator-gateway";
import { fixture, localEffect, PUBLIC_BEARER } from "./operator-core-worker";

export function gatewayFixture(indexes = true) {
  const f = fixture();
  if (indexes)
    f.db.exec(
      "CREATE INDEX operator_gateway_quota ON operator_challenges(consumed,expires_at,credential_id); CREATE INDEX operator_gateway_expiry ON operator_challenges(expires_at)",
    );
  let now = 100000,
    seq = 0;
  const timers = new Map<number, { at: number; fn(): void }>();
  const clock: GatewayClock = {
    now: () => now,
    after(ms, fn) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return () => {
        timers.delete(id);
      };
    },
  };
  const options = {
    hostname: "127.0.0.1" as const,
    port: 0,
    allowedPorts: [],
    fixtureEphemeral: true,
    core: f.core,
    persistence: f.persistence,
    clock,
    operations: [
      {
        operation: "synthetic.mutate",
        route: "/synthetic",
        local: localEffect,
      },
    ],
  };
  function advance(ms: number) {
    now += ms;
    f.setNow(now);
    for (const [id, timer] of [...timers])
      if (timer.at <= now) {
        timers.delete(id);
        timer.fn();
      }
  }
  return {
    f,
    options,
    advance,
    timers,
    start: () => createOperatorGateway(options),
    headers(raw = f.raw(), overrides: Record<string, string> = {}) {
      const { bearer: _, credentialID, ...attempt } = f.attempt(raw);
      return {
        "content-type": "application/json",
        authorization: `Bearer ${PUBLIC_BEARER}`,
        "x-operator-credential": credentialID,
        "x-operator-attempt": JSON.stringify(attempt),
        ...overrides,
      };
    },
  };
}
