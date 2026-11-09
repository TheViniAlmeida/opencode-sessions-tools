import { resolve } from "node:path";
import { Glob } from "bun";

const layer = process.argv[2];
const args = process.argv.slice(3);
if (args.length && (args.length !== 2 || args[0] !== "--root"))
  throw new Error("Usage: test-layer <layer> [--root <directory>]");
const root = resolve(args[1] ?? process.cwd());
if (
  !["unit", "integration", "contract", "e2e", "artifact"].includes(layer ?? "")
) {
  throw new Error("Unknown test layer");
}
const files = Array.from(
  new Glob(`tests/${layer}/**/*.test.ts`).scanSync({
    cwd: root,
    absolute: true,
  }),
).sort();
if (files.length === 0) {
  console.error(`NOT_IMPLEMENTED: ${layer} has no tests; gate cannot pass`);
  process.exit(2);
}
const child = Bun.spawn([process.execPath, "test", ...files], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);
