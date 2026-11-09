import { expect, test } from "bun:test";
import type { ReconciliationHostPort } from "../../src/sessions/reconcile";

test("compile-time reconciliation port has get but no delete; fixture keys are not native host proof", async () => {
  const host: ReconciliationHostPort = { get: async () => null };
  expect(Object.keys(host)).toEqual(["get"]);
  // Compile-time contract; no native DELETE or live host is invoked here.
  type HasDelete = "delete" extends keyof ReconciliationHostPort ? true : false;
  const hasDelete: HasDelete = false;
  expect(hasDelete).toBe(false);
});
