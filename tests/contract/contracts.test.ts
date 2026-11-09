import { describe, expect, test } from "bun:test";
import baseline from "../../docs/compatibility/contracts-baseline.json";
import {
  capability,
  compare,
  type OpenAPI,
  probeContracts,
  sha256,
  subset,
} from "../../scripts/probes/contracts";

describe("T2 public host contract", () => {
  test("missing capability fails closed, existing operation is identified", () => {
    const fixture: OpenAPI = {
      openapi: "3.1.0",
      info: {},
      paths: { "/api/info": { get: { operationId: "server.info" } } },
      components: { schemas: {} },
    };
    expect(capability(fixture, "/api/info", "get")).toEqual({
      state: "present",
      operationID: "server.info",
    });
    expect(capability(fixture, "/api/session", "post")).toEqual({
      state: "unsupported",
      code: "unsupported",
    });
    expect(
      compare(fixture, { ...fixture, paths: {} }).operations[0]?.published
        .state,
    ).toBe("unsupported");
    expect(subset(fixture).schemas).toEqual({});
    expect(sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("authenticated disposable runtime matches candidate snapshot", async () => {
    const actual = await probeContracts();
    expect(actual.server.version).toBe("2.2.5");
    expect(actual.server).toEqual(baseline.server);
    expect(actual.served.sha256).toBe(baseline.served.sha256);
    expect(actual.served.paths).toEqual(baseline.served.paths);
    expect(actual.served.schemas).toEqual(baseline.served.schemas);
    expect(JSON.stringify(actual.absent)).toBe(JSON.stringify(baseline.absent));
    expect(actual.comparison.operations.length).toBeGreaterThan(20);
    expect(actual.candidateOnly).toBe(true);
    // Never persist runtime paths, connection URLs, PID, or authentication.
    expect(Object.keys(actual.server)).toEqual(["version"]);
  }, 90_000);
});
