import { expect, test } from "bun:test";
import {
  ContextExportService,
  hashExportPayload,
} from "../../src/context/export";
import { canonical, type SessionRef } from "../../src/contracts";

test("synthetic host-port contract: explicit lossy transcript envelope v1", async () => {
  const source: SessionRef = {
    version: 1,
    instanceID: "fixture",
    projectID: "project",
    sessionID: "session",
  };
  const service = new ContextExportService(
    {
      async current() {
        return { kind: "session", session: source };
      },
    },
    { async authorize() {} },
    {
      async transcript() {
        return {
          compatible: true,
          messages: [{ id: "message", role: "user", text: "fixture only" }],
          grants: [],
          jobs: [],
          approvals: [],
          configuration: { token: "must-not-export" },
        };
      },
    },
    () => 0,
  );
  const envelope = await service.export({ source, mode: "native-transcript" });
  expect(Object.keys(envelope).sort()).toEqual(["payload", "sha256"]);
  expect(Object.keys(envelope.payload).sort()).toEqual([
    "createdAt",
    "loss",
    "mode",
    "projection",
    "source",
    "version",
  ]);
  expect(envelope.payload.version).toBe(1);
  expect(envelope.payload.source).toEqual(source);
  expect(envelope.payload.loss).toEqual({
    filesystem: true,
    processes: true,
    nativeState: true,
    nonTextParts: true,
    configuration: true,
    authority: true,
  });
  expect(canonical(envelope)).not.toContain("must-not-export");
  expect(envelope.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(envelope.sha256).toBe(
    hashExportPayload(JSON.parse(canonical(envelope.payload))),
  );
  expect(
    hashExportPayload({
      ...envelope.payload,
      source: { ...source, instanceID: "forged" },
    }),
  ).not.toBe(envelope.sha256);
});
