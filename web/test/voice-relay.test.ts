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

test("automatic voice probes reach a fourth relay and preserve stereo bytes through its selected channel", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let now = 1;
  t.mock.method(performance, "now", () => now);
  const sent: any[] = [], packets: Uint8Array[] = [], received: Uint8Array[] = [], configurations: RTCConfiguration[] = [];
  const channel: any = { label: "webspeak-voice-v1", readyState: "open", bufferedAmount: 0, close() {},
    send(data: string | Uint8Array) {
      if (typeof data === "string") { now += 40; channel.onmessage({ data }); }
      else packets.push(data);
    } };
  class Peer {
    iceGatheringState = "complete"; localDescription = { sdp: "v=0\r\nfixture-answer" }; ondatachannel: any;
    constructor(config: RTCConfiguration) { configurations.push(config); }
    async setRemoteDescription() { this.ondatachannel({ channel }); }
    async createAnswer() { return { type: "answer", sdp: "v=0\r\nfixture-answer" }; }
    async setLocalDescription() {} close() {}
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
  Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: Peer });
  t.after(() => { if (original) Object.defineProperty(globalThis, "RTCPeerConnection", original); else Reflect.deleteProperty(globalThis, "RTCPeerConnection"); });
  const relay = createVoiceRelay({ ready: () => true, baseline: async () => 400, send: message => sent.push(message), audio: frame => received.push(frame) });
  t.after(() => relay.stop());
  relay.start(["macau", "shenzhen", "cloudflare", "aliyun"], true);
  for (const expected of ["direct", "macau", "shenzhen", "cloudflare"]) {
    const request = sent.findLast(message => message.action === "request");
    assert.equal(request.route, expected);
    relay.receive({ type: "voiceRelay", action: "error", id: request.id });
    for (let n = 0; n < 34; n++) { now += 750; t.mock.timers.tick(750); await Promise.resolve(); }
  }
  const request = sent.findLast(message => message.action === "request");
  assert.equal(request.route, "aliyun");
  const lease = { route: "aliyun", expiresAt: Date.now() + 60_000,
    iceServers: [{ urls: ["turn:aliyun.example:3478?transport=udp", "turns:aliyun.example:5349?transport=tcp"], username: "lease-user", credential: "lease-password" }] };
  assert.ok(relay.receive({ type: "voiceRelay", action: "offer", id: request.id, route: "aliyun", sdp: "v=0\r\nfixture-offer", relay: lease }));
  assert.deepEqual(configurations, [{ iceServers: lease.iceServers, iceTransportPolicy: "relay" }]);
  for (let n = 0; n < 6; n++) { now += 750; t.mock.timers.tick(750); await Promise.resolve(); }
  const selection = sent.find(message => message.action === "select" && message.id === request.id);
  assert.ok(selection); assert.equal(selection.rttMs, 40); assert.equal(selection.baselineMs, 400);
  assert.equal(relay.route.value, "wss", "probing alone cannot move live audio");
  relay.receive({ type: "voiceRelay", action: "selected", id: request.id, route: "aliyun" });
  assert.equal(relay.route.value, "aliyun");
  const stereoPcm = Uint8Array.from({ length: 3840 }, (_, n) => n % 251);
  assert.equal(relay.sendAudio(stereoPcm), true);
  assert.deepEqual(packets[0]!.subarray(4), stereoPcm);
  const stereoOpus = Uint8Array.from({ length: 483 }, (_, n) => n === 0 ? 5 : n % 251);
  const envelope = new Uint8Array(stereoOpus.length + 4); envelope.set(stereoOpus, 4);
  channel.onmessage({ data: envelope.buffer });
  assert.deepEqual(received, [stereoOpus]);
  relay.stop();
  channel.onmessage({ data: envelope.buffer });
  assert.equal(received.length, 1, "retired relay callbacks cannot publish more audio");
  assert.equal(relay.sendAudio(stereoPcm), false);
});
