export {};

const result = await Bun.build({
  entrypoints: ["scripts/harness.ts"],
  outdir: "dist",
  target: "bun",
});
if (!result.success)
  throw new AggregateError(result.logs, "Harness build failed");
console.log("Built feasibility harness only; no production plugin.");
