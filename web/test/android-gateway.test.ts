import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { waitForAndroidGateway, type AndroidGatewayBridge } from "../src/platform/android-gateway.js";
import { needsEmbeddedGateway } from "../src/platform/bootstrap.js";
import type { MessageEvent } from "@capawesome/capacitor-nodejs";

function fixture() {
  let callback: (event: MessageEvent) => void = () => {};
  let removed = 0;
  let polls = 0;
  let sent = 0;
  const handle = { async remove() { removed++; } };
  const bridge: AndroidGatewayBridge = {
    async addListener(_name, listener) { callback = listener; return handle; },
    async isReady() { polls++; return { ready: true }; },
    async send() { sent++; },
  };
  return { bridge, handle, emit: (event: MessageEvent) => callback(event), counts: () => ({ removed, polls, sent }) };
}

test("browser and already-redirected WebView mount without bootstrapping the embedded runtime", () => {
  assert.equal(needsEmbeddedGateway(false, { hostname: "public.example", port: "" }), false);
  assert.equal(needsEmbeddedGateway(true, { hostname: "127.0.0.1", port: "3040" }), false);
  assert.equal(needsEmbeddedGateway(true, { hostname: "localhost", port: "" }), true);
});

test("only gateway-ready health completes startup and releases polling and listeners", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = fixture();
  let completed = false;
  const pending = waitForAndroidGateway(f.bridge).then(() => { completed = true; });
  await nextTurn();
  assert.equal(f.counts().sent, 1);
  for (const args of [[null], [true], [{ ready: false }]]) f.emit({ eventName: "webspeak-health", args });
  await nextTurn();
  assert.equal(completed, false);
  f.emit({ eventName: "webspeak-health", args: [{ ready: true }] });
  await pending;
  const ended = f.counts();
  t.mock.timers.tick(60_000);
  await nextTurn();
  assert.equal(ended.removed, 1);
  assert.deepEqual(f.counts(), ended);
});

test("a gateway failure removes the listener before a clean retry", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = fixture();
  const first = assert.rejects(waitForAndroidGateway(f.bridge), { code: "failed" });
  await nextTurn();
  f.emit({ eventName: "webspeak-error", args: [{ message: "startup failed" }] });
  await first;
  assert.equal(f.counts().removed, 1);
  const retry = waitForAndroidGateway(f.bridge);
  await nextTurn();
  f.emit({ eventName: "webspeak-health", args: [{ ready: true }] });
  await retry;
  assert.equal(f.counts().removed, 2);
});

test("the deadline includes slow listener registration and releases a late handle", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = fixture();
  let register!: (handle: { remove(): Promise<void> }) => void;
  f.bridge.addListener = () => new Promise(resolve => { register = resolve; });
  const timeout = assert.rejects(waitForAndroidGateway(f.bridge, { timeoutMs: 1000 }), { code: "timeout" });
  await nextTurn();
  t.mock.timers.tick(1000);
  await timeout;
  register(f.handle);
  await nextTurn();
  assert.deepEqual(f.counts(), { removed: 1, polls: 0, sent: 0 });
});

test("a message delivered before listener registration returns still releases its handle", async () => {
  const f = fixture();
  f.bridge.addListener = async (_name, callback) => {
    callback({ eventName: "webspeak-health", args: [{ ready: true }] });
    return f.handle;
  };
  await waitForAndroidGateway(f.bridge);
  await nextTurn();
  assert.deepEqual(f.counts(), { removed: 1, polls: 0, sent: 0 });
});

test("readiness polls never overlap and cannot send after page cancellation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = fixture();
  let polls = 0;
  let ready!: (result: { ready: boolean }) => void;
  f.bridge.isReady = () => { polls++; return new Promise(resolve => { ready = resolve; }); };
  const controller = new AbortController();
  const pending = assert.rejects(waitForAndroidGateway(f.bridge, { signal: controller.signal }), { code: "cancelled" });
  await nextTurn();
  t.mock.timers.tick(5000);
  assert.equal(polls, 1);
  controller.abort();
  await pending;
  ready({ ready: true });
  await nextTurn();
  assert.equal(f.counts().removed, 1);
  assert.equal(f.counts().sent, 0);
});

test("a synchronous plugin registration error is normalized and leaves no startup work", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = fixture();
  f.bridge.addListener = () => { throw new Error("plugin unavailable"); };
  await assert.rejects(waitForAndroidGateway(f.bridge), { code: "failed" });
  t.mock.timers.tick(60_000);
  assert.deepEqual(f.counts(), { removed: 0, polls: 0, sent: 0 });
});
