import { describe, expect, test } from "bun:test";
import {
  envelope,
  fixture,
  importer,
  maxPackageBytes,
  type Request,
  runPortabilityProbe,
  validateEnvelope,
} from "../../scripts/probes/portability";

const raw = (id = "ses_t7parent", parentID?: string) =>
  JSON.stringify(envelope(fixture(id, parentID)));

describe("T7 portability probe (simulated transport, not live host evidence)", () => {
  test("synthetic parent/child round-trip preserves relationship", () => {
    expect(validateEnvelope(raw())).toEqual(fixture("ses_t7parent"));
    expect(
      validateEnvelope(raw("ses_t7child", "ses_t7parent")).info.parentID,
    ).toBe("ses_t7parent");
  });
  test("tampered hash, version, byte limit and grants fail before requests", () => {
    let calls = 0;
    const run = importer(async () => {
      calls++;
      return Response.json({});
    });
    const value = envelope(fixture("ses_t7parent"));
    expect(() =>
      run("hash", JSON.stringify({ ...value, payload: `${value.payload} ` })),
    ).toThrow("invalid_hash");
    expect(() =>
      run("version", JSON.stringify({ ...value, version: 2 })),
    ).toThrow("incompatible_version");
    expect(() => run("size", "é".repeat(maxPackageBytes / 2 + 1))).toThrow(
      "package_too_large",
    );
    const grants = fixture("ses_t7parent");
    grants.info.permissions = [{ effect: "allow" }];
    expect(() => run("grants", JSON.stringify(envelope(grants)))).toThrow(
      "unsupported_info_field",
    );
    expect(calls).toBe(0);
  });
  test("receives ID from data.id; collision does not invent a created ID", async () => {
    let count = 0;
    const request: Request = async (_path, init) => {
      expect(init?.method).toBe("POST");
      count++;
      return count === 1
        ? Response.json({ data: { id: "ses_t7parent" } })
        : new Response(null, { status: 409 });
    };
    const run = importer(request);
    expect((await run("first", raw())).knownIDs).toEqual(["ses_t7parent"]);
    expect(await run("collision", raw())).toMatchObject({
      state: "rejected",
      knownIDs: [],
      status: 409,
    });
  });
  test("partial bundle retains parent evidence and never repeats ambiguous child", async () => {
    let calls = 0;
    const run = importer(async () => {
      calls++;
      if (calls === 1) return Response.json({ data: { id: "ses_t7parent" } });
      throw new Error("synthetic timeout after possible effect");
    });
    const parent = await run("bundle:parent", raw());
    const child = await run("bundle:child", raw("ses_t7child", "ses_t7parent"));
    expect(parent.knownIDs).toEqual(["ses_t7parent"]);
    expect(child).toMatchObject({
      state: "unknown_outcome",
      uncertainIDs: ["ses_t7child"],
    });
    expect(await run("bundle:child", raw("ses_t7child", "ses_t7parent"))).toBe(
      child,
    );
    expect(calls).toBe(2);
  });
  test("malformed success and server failure stay uncertain", async () => {
    for (const response of [
      Response.json({ data: { id: "ses_unexpected" } }),
      new Response(null, { status: 500 }),
    ]) {
      expect(await importer(async () => response)("op", raw())).toMatchObject({
        state: "unknown_outcome",
        knownIDs: [],
      });
    }
  });
  test("live isolated 2.2.5 import/export evidence", async () => {
    const result = await runPortabilityProbe();
    expect(result.state).toBe("observed");
    expect(result.parent.status).toBe(200);
    expect(result.child.status).toBe(200);
    expect(result.collision.status).toBe(409);
    expect(result.collisionDiffPaths).toEqual([]);
    expect(result.missingParent.status).toBe(404);
    expect(result.orphanLookupStatus).toBe(404);
    expect(result.nativeRoundTrip.result.status).toBe(200);
    expect(result.nativeRoundTrip.exportStatus).toBe(200);
    expect(result.nativeRoundTrip.diffPaths).toEqual(["/info/time/updated"]);
    expect(result.exportDiffPaths).toEqual([
      "/info/location/directory",
      "/info/projectID",
      "/info/time/updated",
    ]);
    expect(result.childDiffPaths).toEqual(result.exportDiffPaths);
    expect(result.sanitizeDiffPaths).toEqual([
      "/info/location/directory",
      "/info/title",
      "/messages/0/text",
    ]);
    expect(result.malformed.result.status).toBe(400);
    expect(result.malformed.lookupStatus).toBe(404);
    expect(result.partial.evidence.state).toBe("unknown_outcome");
    expect(result.partial.attempts).toBe(1);
    expect(result.partial.reconciledStatus).toBe(200);
    expect(result.partial.confirmedID).toBe(
      result.partial.evidence.uncertainIDs[0],
    );
    expect(result.atomicityProven).toBe(false);
  }, 30000);
});
