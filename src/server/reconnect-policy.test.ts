import assert from "node:assert/strict";
import test from "node:test";
import { WebSpeakError } from "../errors.js";
import { isRecoverable, reconnectDelayMs, reconnectWindowOpen, RECONNECT_WINDOW_MS } from "./reconnect-policy.js";

test("reconnect backoff has bounded jitter and stops growing for repeated failures", () => {
  assert.equal(reconnectDelayMs(1, () => 0), 900);
  assert.equal(reconnectDelayMs(1, () => 1), 1_100);
  assert.equal(reconnectDelayMs(2, () => 0.5), 2_000);
  assert.equal(reconnectDelayMs(100, () => 0), 27_000);
  assert.equal(reconnectDelayMs(100, () => 1), 33_000);
  assert.equal(reconnectDelayMs(0, () => 0.5), 1_000);
});

test("reconnect attempts stop exactly at the recovery window deadline", () => {
  const interruptedAt = 1_000;
  assert.equal(reconnectWindowOpen(interruptedAt, interruptedAt), true);
  assert.equal(reconnectWindowOpen(interruptedAt, interruptedAt + RECONNECT_WINDOW_MS - 1), true);
  assert.equal(reconnectWindowOpen(interruptedAt, interruptedAt + RECONNECT_WINDOW_MS), false);
  assert.equal(reconnectWindowOpen(interruptedAt, interruptedAt + RECONNECT_WINDOW_MS + 1), false);
});

test("retry policy respects terminal errors while allowing transient and unclassified disconnects", () => {
  assert.equal(isRecoverable(new WebSpeakError("timeout", "timed out", true)), true);
  assert.equal(isRecoverable(new WebSpeakError("authentication_failed", "wrong password", false)), false);
  assert.equal(isRecoverable(new WebSpeakError("banned", "banned", false)), false);
  assert.equal(isRecoverable(null), true);
});
