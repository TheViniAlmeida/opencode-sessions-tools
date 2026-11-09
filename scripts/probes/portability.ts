/** T7 feasibility probe, not the plugin's portability service. */
import { createHash } from "node:crypto";
import { createHarness } from "../harness";

export const importPath = "/api/experimental/session/import";
export const maxPackageBytes = 10 * 1024 * 1024;
export type Transfer = {
  info: { id: string; parentID?: string } & Record<string, unknown>;
  messages: unknown[];
};
export type Request = (path: string, init?: RequestInit) => Promise<Response>;

export function fixture(id: string, parentID?: string): Transfer {
  return {
    info: {
      id,
      ...(parentID ? { parentID } : {}),
      projectID: "global",
      location: { directory: "/synthetic-portability" },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      time: { created: 1, updated: 1 },
      title: "T7 synthetic fixture",
    },
    messages: [
      {
        id: `msg_${id.slice(4)}`,
        type: "synthetic",
        time: { created: 1 },
        text: "T7 synthetic transcript",
      },
    ],
  };
}

/** Plugin-envelope experiment only. Native SessionTransfer.Data has no hash/version. */
export function envelope(content: Transfer) {
  const payload = JSON.stringify(content);
  return {
    version: 1,
    origin: "t7-synthetic",
    exportedAt: new Date(0).toISOString(),
    payload,
    sha256: createHash("sha256").update(payload).digest("hex"),
  };
}

export function validateEnvelope(raw: string): Transfer {
  if (Buffer.byteLength(raw, "utf8") > maxPackageBytes)
    throw new Error("package_too_large");
  const value = JSON.parse(raw);
  if (value.version !== 1) throw new Error("incompatible_version");
  if (
    typeof value.payload !== "string" ||
    createHash("sha256").update(value.payload).digest("hex") !== value.sha256
  )
    throw new Error("invalid_hash");
  const content = JSON.parse(value.payload);
  if (
    !content ||
    typeof content.info?.id !== "string" ||
    !Array.isArray(content.messages)
  )
    throw new Error("invalid_transfer");
  // This experiment only accepts the known synthetic fixture surface; it cannot
  // accidentally turn imported transcript content into permission grants.
  const allowed = new Set([
    "id",
    "parentID",
    "projectID",
    "location",
    "cost",
    "tokens",
    "time",
    "title",
  ]);
  if (Object.keys(content.info).some((key) => !allowed.has(key)))
    throw new Error("unsupported_info_field");
  return content;
}

export type ImportEvidence = {
  operationID: string;
  state: "complete" | "rejected" | "unknown_outcome";
  knownIDs: string[];
  uncertainIDs: string[];
  status?: number;
};

/** One attempt per key, including timeout/ambiguous responses. In-memory probe ledger only. */
export function importer(request: Request) {
  const ledger = new Map<string, Promise<ImportEvidence>>();
  return (operationID: string, raw: string): Promise<ImportEvidence> => {
    const previous = ledger.get(operationID);
    if (previous) return previous;
    const content = validateEnvelope(raw); // All local checks precede host effects.
    const attempt = (async (): Promise<ImportEvidence> => {
      const evidence: ImportEvidence = {
        operationID,
        state: "unknown_outcome",
        knownIDs: [],
        uncertainIDs: [content.info.id],
      };
      try {
        const response = await request(importPath, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(content),
        });
        evidence.status = response.status;
        if (response.ok) {
          const result = await response.json();
          if (result?.data?.id !== content.info.id) return evidence;
          return {
            ...evidence,
            state: "complete",
            knownIDs: [result.data.id],
            uncertainIDs: [],
          };
        }
        // A documented 4xx is a rejection, not proof that earlier bundle imports rolled back.
        if ([400, 401, 404, 409].includes(response.status))
          return { ...evidence, state: "rejected", uncertainIDs: [] };
      } catch {
        // Do not leak transport errors (which may carry headers), or retry mutations.
      }
      return evidence;
    })();
    ledger.set(operationID, attempt);
    return attempt;
  };
}

export function diffPaths(left: unknown, right: unknown, path = ""): string[] {
  if (JSON.stringify(left) === JSON.stringify(right)) return [];
  if (left && right && typeof left === "object" && typeof right === "object") {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .sort()
      .flatMap((key) => diffPaths(a[key], b[key], `${path}/${key}`));
  }
  return [path || "/"];
}

export async function runPortabilityProbe() {
  const host = await createHarness();
  try {
    const prefix = `ses_t7${crypto.randomUUID().replaceAll("-", "")}`;
    const parent = fixture(`${prefix}parent`);
    const child = fixture(`${prefix}child`, parent.info.id);
    parent.info.location = child.info.location = { directory: host.root };
    const run = importer(host.request);
    const send = (key: string, data: Transfer) =>
      run(key, JSON.stringify(envelope(data)));
    const exportData = async (id: string, sanitize: boolean) => {
      const response = await host.request(
        `/api/experimental/session/${id}/export?sanitize=${sanitize}`,
      );
      return {
        status: response.status,
        data: response.ok ? (await response.json()).data : null,
      };
    };
    const parentResult = await send("parent", parent);
    const childResult = await send("child", child);
    const exported = await exportData(parent.info.id, false);
    const sanitized = await exportData(parent.info.id, true);
    const childExport = await exportData(child.info.id, false);
    const collision = await send("collision", parent);
    const afterCollision = await exportData(parent.info.id, false);
    const clone = structuredClone(exported.data) as Transfer;
    clone.info.id = `${prefix}roundtrip`;
    clone.messages = (clone.messages as Record<string, unknown>[]).map(
      (message) => ({ ...message, id: `msg_${prefix.slice(4)}roundtrip` }),
    );
    const nativeRoundTrip = await send("native-roundtrip", clone);
    const cloneExport = await exportData(clone.info.id, false);
    const orphan = fixture(`${prefix}orphan`, `${prefix}absent`);
    orphan.info.location = { directory: host.root };
    const missingParent = await send("orphan", orphan);
    const orphanLookup = await exportData(orphan.info.id, false);
    const malformed = fixture(`${prefix}malformed`);
    malformed.info.location = { directory: host.root };
    malformed.messages = [{ type: "synthetic", text: "missing id/time" }];
    const malformedResult = await send("malformed", malformed);
    const malformedLookup = await exportData(malformed.info.id, false);
    const uncertain = fixture(`${prefix}uncertain`);
    uncertain.info.parentID = parent.info.id;
    uncertain.info.location = { directory: host.root };
    let attempts = 0;
    const injected = importer(async (path, init) => {
      attempts++;
      const response = await host.request(path, init);
      if (!response.ok) return response;
      await response.arrayBuffer();
      throw new Error("injected response loss after real successful import");
    });
    const uncertainRaw = JSON.stringify(envelope(uncertain));
    const partial = await injected("partial-child", uncertainRaw);
    await injected("partial-child", uncertainRaw);
    const reconciled = await exportData(uncertain.info.id, false);
    return {
      state:
        parentResult.state === "complete" && childResult.state === "complete"
          ? "observed"
          : "failed",
      baseline: host.version,
      liveMutationExecuted: true,
      parent: parentResult,
      child: childResult,
      collision,
      missingParent,
      collisionDiffPaths: diffPaths(exported.data, afterCollision.data),
      orphanLookupStatus: orphanLookup.status,
      nativeRoundTrip: {
        result: nativeRoundTrip,
        exportStatus: cloneExport.status,
        diffPaths: diffPaths(clone, cloneExport.data),
      },
      exportStatus: exported.status,
      exportDiffPaths: diffPaths(parent, exported.data),
      sanitizeStatus: sanitized.status,
      sanitizeDiffPaths: diffPaths(exported.data, sanitized.data),
      exportedProjection: exported.data,
      sanitizedProjection: sanitized.data,
      childExportStatus: childExport.status,
      childDiffPaths: diffPaths(child, childExport.data),
      malformed: {
        result: malformedResult,
        lookupStatus: malformedLookup.status,
      },
      partial: {
        kind: "injected_response_loss_after_success",
        evidence: partial,
        attempts,
        reconciledStatus: reconciled.status,
        confirmedID: reconciled.data?.info?.id ?? null,
        previouslyKnownIDs: parentResult.knownIDs,
      },
      atomicityProven: false,
    };
  } finally {
    await host.stop();
  }
}

if (import.meta.main)
  console.log(JSON.stringify(await runPortabilityProbe(), null, 2));
