import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceRelay } from "../src/voice/voice-relay.js";

test("selected datagram carries audio independently of WSS and returns after sustained WSS recovery", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let now = 1, baseline = 400;
  t.mock.method(performance, "now", () => now);
  const peers: any[] = [], sent: any[] = [], packets: any[] = [];
  const channel: any = { label: "webspeak-voice-v1", readyState: "open", bufferedAmount: 0, close() {},
    send(data: any) {
      if (typeof data === "string") { now += 60; channel.onmessage({ data }); }
      else packets.push(data);
    } };
  class Peer {
    iceGatheringState = "complete"; localDescription = { sdp: "answer" }; ondatachannel: any;
    constructor() { peers.push(this); }
    async setRemoteDescription() { this.ondatachannel({ channel }); }
    async createAnswer() { return { type: "answer", sdp: "answer" }; }
    async setLocalDescription() {} close() {}
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
  Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: Peer });
  t.after(() => { if (original) Object.defineProperty(globalThis, "RTCPeerConnection", original); else Reflect.deleteProperty(globalThis, "RTCPeerConnection"); });
  const relay = createVoiceRelay({ ready: () => true, baseline: async () => baseline, send: m => sent.push(m), audio() {} });
  t.after(() => relay.stop());
  relay.start([], true);
  const id = sent[0].id;
  relay.receive({ type: "voiceRelay", action: "offer", id, sdp: "v=0\r\nfixture-offer" });
  for (let n = 0; n < 6; n++) { now += 750; t.mock.timers.tick(750); await Promise.resolve(); }
  assert.ok(sent.some(m => m.action === "select"));
  relay.receive({ type: "voiceRelay", action: "selected", id, route: "direct" });
  assert.equal(relay.metrics()?.rttMs, 60);
  assert.equal(relay.sendAudio(new Uint8Array(1920)), true);
  assert.equal(packets.length, 1);
  channel.bufferedAmount = 8192;
  assert.equal(relay.metrics()?.bufferedAmount, 8192);
  assert.equal(relay.sendAudio(new Uint8Array(1920)), true);
  assert.equal(packets.length, 1, "congested datagram discards stale audio without TCP duplication");
  channel.bufferedAmount = 0;
  baseline = 1;
  for (let n = 0; n < 32; n++) { now += 750; t.mock.timers.tick(750); await Promise.resolve(); }
  for (let n = 0; n < 5; n++) await Promise.resolve();
  assert.equal(relay.route.value, "wss");
  assert.equal(relay.metrics(), null);
  assert.equal(relay.sendAudio(new Uint8Array(1920)), false);
});
