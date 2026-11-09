import { createHash } from "node:crypto";
import { createHarness } from "../harness";

type ObjectValue = Record<string, unknown>;
export type OpenAPI = {
  openapi: string;
  info: ObjectValue;
  paths: Record<string, Record<string, ObjectValue>>;
  components: { schemas: Record<string, ObjectValue> };
};
const methods = ["get", "post", "put", "patch", "delete"];
export const publishedURL = "https://opencode.ai/v2/openapi.json";
export const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export function capability(document: OpenAPI, path: string, method: string) {
  const operation = document.paths[path]?.[method];
  return typeof operation?.operationId === "string"
    ? {
        state: "present" as const,
        operationID: operation.operationId as string,
      }
    : { state: "unsupported" as const, code: "unsupported" as const };
}

/** Select public contracts only; never accept server info/config as schemas. */
export function subset(document: OpenAPI) {
  const paths = Object.fromEntries(
    Object.entries(document.paths).filter(([path]) =>
      /^\/api\/(info$|session(?:\/|$)|experimental\/(session|schedule)(?:\/|$)|permission(?:\/|$)|rpc\/|event$|form$|plugin$)/.test(
        path,
      ),
    ),
  );
  const schemas: Record<string, ObjectValue> = {};
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string") {
        const prefix = "#/components/schemas/";
        if (!child.startsWith(prefix))
          throw new Error("Unsupported schema reference");
        const name = child.slice(prefix.length);
        if (!schemas[name]) {
          const schema = document.components.schemas[name];
          if (!schema) throw new Error("Missing referenced public schema");
          schemas[name] = schema;
          visit(schema);
        }
      } else visit(child);
    }
  }
  visit(paths);
  return { paths, schemas: Object.fromEntries(Object.entries(schemas).sort()) };
}

export function compare(served: OpenAPI, published: OpenAPI) {
  const left = subset(served);
  const right = subset(published);
  const operations = [];
  for (const path of [
    ...new Set([...Object.keys(left.paths), ...Object.keys(right.paths)]),
  ].sort()) {
    for (const method of methods) {
      const runtime = left.paths[path]?.[method];
      const docs = right.paths[path]?.[method];
      if (!runtime && !docs) continue;
      operations.push({
        path,
        method,
        runtime: capability(served, path, method),
        published: capability(published, path, method),
        equal: JSON.stringify(runtime) === JSON.stringify(docs),
        differences: differences(runtime, docs),
      });
    }
  }
  const schemaDifferences = [
    ...new Set([...Object.keys(left.schemas), ...Object.keys(right.schemas)]),
  ]
    .sort()
    .filter(
      (name) =>
        JSON.stringify(left.schemas[name]) !==
        JSON.stringify(right.schemas[name]),
    );
  return { operations, schemaDifferences };
}

function differences(
  runtime: unknown,
  published: unknown,
  path = "",
): unknown[] {
  if (JSON.stringify(runtime) === JSON.stringify(published)) return [];
  if (
    runtime &&
    published &&
    typeof runtime === "object" &&
    typeof published === "object"
  ) {
    const left = runtime as ObjectValue;
    const right = published as ObjectValue;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])]
      .sort()
      .flatMap((key) => differences(left[key], right[key], `${path}/${key}`));
  }
  return [{ path, runtime: runtime ?? null, published: published ?? null }];
}

/** No writes by default. Caller owns artifact persistence and probe integration. */
export async function probeContracts() {
  const harness = await createHarness();
  try {
    const infoResponse = await harness.request("/api/info");
    const contractResponse = await harness.request("/openapi.json");
    if (!infoResponse.ok || !contractResponse.ok)
      throw new Error("Contract capture failed");
    const info = await infoResponse.json();
    if (
      typeof info.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(info.version)
    )
      throw new Error("Invalid server version");
    const raw = await contractResponse.text();
    const served: OpenAPI = JSON.parse(raw);
    const publishedResponse = await fetch(publishedURL, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!publishedResponse.ok)
      throw new Error("Published contract unavailable");
    const publishedRaw = await publishedResponse.text();
    const published: OpenAPI = JSON.parse(publishedRaw);
    return {
      capturedAt: new Date().toISOString(),
      candidateOnly: true,
      server: { version: info.version },
      cliVersion: harness.version,
      served: {
        sha256: sha256(raw),
        openapi: served.openapi,
        info: served.info,
        ...subset(served),
      },
      published: {
        url: publishedURL,
        sha256: sha256(publishedRaw),
        openapi: published.openapi,
        info: published.info,
      },
      comparison: compare(served, published),
      absent: {
        reset: capability(served, "/api/session/{sessionID}/reset", "post"),
        reparent: capability(
          served,
          "/api/session/{sessionID}/parent",
          "patch",
        ),
        deletePreview: capability(
          served,
          "/api/session/{sessionID}/delete-preview",
          "post",
        ),
      },
    };
  } finally {
    await harness.stop();
  }
}
