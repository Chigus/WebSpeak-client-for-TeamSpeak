import assert from "node:assert/strict";
import test from "node:test";
import { isSafeOpenTargetForPrefill } from "./open-target-policy.js";

test("open-mode target prefill follows the same allow/deny result as the join policy", async () => {
  assert.equal(await isSafeOpenTargetForPrefill({ host: "198.51.100.24", port: 9987 }, {
    resolveTarget: async (target) => target,
  }), true);
  assert.equal(await isSafeOpenTargetForPrefill({ host: "teamspeak", port: 9987 }, {
    resolveTarget: async () => { throw new Error("private or unresolved target"); },
  }), false);
});

test("open-mode target prefill fails closed when DNS validation stalls", async () => {
  const result = await isSafeOpenTargetForPrefill({ host: "internal.example", port: 9987 }, {
    timeoutMs: 10,
    resolveTarget: async () => new Promise(() => undefined),
  });
  assert.equal(result, false);
});
