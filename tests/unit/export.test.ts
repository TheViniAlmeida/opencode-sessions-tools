import { describe, expect, test } from "bun:test";
import {
  ContextExportService,
  hashExportPayload,
} from "../../src/context/export";
import {
  type Capability,
  DomainError,
  type SessionRef,
} from "../../src/contracts";

const source: SessionRef = {
  version: 1,
  instanceID: "i",
  projectID: "p",
  sessionID: "s",
};
function fixture() {
  const calls: Capability[] = [];
  let denied: Capability | undefined;
  let reads = 0;
  const host = {
    async transcript() {
      reads++;
      return {
        compatible: true,
        messages: [
          {
            id: "m1",
            role: "user" as const,
            text: "explicit user content",
            credentials: "excluded",
          },
          { id: "m2", role: "assistant" as const, text: "answer" },
        ],
        permissions: ["excluded"],
        configuration: "excluded",
      };
    },
  };
  const service = new ContextExportService(
    {
      async current() {
        return { kind: "session" as const, session: source };
      },
    },
    {
      async authorize(_actor, _target, capability) {
        calls.push(capability);
        if (denied === capability) throw new DomainError("forbidden");
      },
    },
    host,
    () => 0,
  );
  return {
    service,
    host,
    calls,
    deny(c: Capability) {
      denied = c;
    },
    get reads() {
      return reads;
    },
  };
}
describe("context export", () => {
  test("incompatible native projection is refused", async () => {
    const f = fixture();
    const read = f.host.transcript;
    f.host.transcript = async () => ({ ...(await read()), compatible: false });
    await expect(
      f.service.export({ source, mode: "native-transcript" }),
    ).rejects.toThrow("unsupported");
  });
  test("host diagnostics never escape", async () => {
    const f = fixture();
    f.host.transcript = async () => {
      throw new Error("private host diagnostics");
    };
    await expect(
      f.service.export({ source, mode: "native-transcript" }),
    ).rejects.toThrow("unavailable");
  });
  test("rejects invalid scope and implicit selection before host", async () => {
    const f = fixture();
    await expect(
      f.service.export({
        source: { ...source, projectID: "" },
        mode: "native-transcript",
      }),
    ).rejects.toThrow("invalid_input");
    await expect(
      f.service.export({ source, mode: "selected-context", messageIDs: [] }),
    ).rejects.toThrow("invalid_input");
    await expect(
      f.service.export({ source, mode: "native-transcript", grants: [] }),
    ).rejects.toThrow("invalid_input");
    expect(f.reads).toBe(0);
  });
  test("context permission never implies history permission", async () => {
    const f = fixture();
    f.deny("read");
    await expect(
      f.service.export({ source, mode: "native-transcript" }),
    ).rejects.toThrow("forbidden");
    expect(f.reads).toBe(0);
    expect(f.calls).toEqual(["context.read", "read"]);
  });
  test("rechecks revocation during async host read", async () => {
    const f = fixture();
    const read = f.host.transcript;
    f.host.transcript = async () => {
      const result = await read();
      f.deny("context.read");
      return result;
    };
    await expect(
      f.service.export({ source, mode: "native-transcript" }),
    ).rejects.toThrow("forbidden");
  });
  test("projects only selected text and hashes the complete canonical payload", async () => {
    const f = fixture();
    const result = await f.service.export({
      source,
      mode: "selected-context",
      messageIDs: ["m1"],
    });
    expect(result.payload.projection.messages).toEqual([
      { id: "m1", role: "user", text: "explicit user content" },
    ]);
    expect(JSON.stringify(result)).not.toContain("excluded");
    expect(result.sha256).toBe(hashExportPayload(result.payload));
    expect(
      hashExportPayload({ ...result.payload, createdAt: "changed" }),
    ).not.toBe(result.sha256);
    expect(result.payload.loss.filesystem).toBe(true);
  });
  test("unknown selected IDs fail without silently broadening selection", async () => {
    await expect(
      fixture().service.export({
        source,
        mode: "selected-context",
        messageIDs: ["missing"],
      }),
    ).rejects.toThrow("invalid_input");
  });
});
