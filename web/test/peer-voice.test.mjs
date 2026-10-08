import assert from "node:assert/strict";
import { test } from "node:test";
import { createPeerVoice } from "../src/voice/peer-voice.ts";

const settle = () => new Promise(resolve => setImmediate(resolve));
class Channel {
  label = "webspeak-pcm-v1"; ordered = false; maxRetransmits = 0;
  readyState = "open"; bufferedAmount = 0; sent = []; closed = 0;
  send(packet) { this.sent.push(packet.slice(0)); }
  close() { this.closed++; this.readyState = "closed"; }
}
class Peer {
  connectionState = "new"; channels = []; ice = []; closed = 0;
  createDataChannel(label, options) { const channel = Object.assign(new Channel(), { label, ...options }); this.channels.push(channel); return channel; }
  async createOffer() { return { type: "offer", sdp: "v=0 offer" }; }
  async createAnswer() { return { type: "answer", sdp: "v=0 answer" }; }
  async setLocalDescription(value) {
    this.localDescription = value;
    this.onicecandidate?.({ candidate: { candidate: "candidate", toJSON: () => ({ candidate: "candidate", sdpMid: "0" }) } });
  }
  async setRemoteDescription(value) { this.remoteDescription = value; }
  async addIceCandidate(value) { this.ice.push(value); }
  close() { this.closed++; }
}
function harness(t) {
  let clock = 1000;
  const pcs = [], sent = [], received = [], retired = [];
  const voice = createPeerVoice({ send: message => sent.push(message),
    onPcm: (...args) => { received.push(args); return true; }, onRetired: id => retired.push(id) },
    { createPeer: () => { const pc = new Peer(); pcs.push(pc); return pc; }, now: () => clock });
  t.after(() => voice.disconnect());
  voice.connect(true, []); voice.setEnabled(true);
  voice.handleMessage({ type: "peerVoiceRoster", selfPeerId: "a", peers: [{ peerId: "b", clientId: 2 }], limited: false });
  return { voice, pcs, sent, received, retired, advance: ms => { clock += ms; } };
}
test("one offerer sends SDP before trickle ICE and bounds PCM buffering", async t => {
  const h = harness(t); await settle();
  assert.deepEqual(h.sent.filter(m => m.type === "peerVoiceSignal").map(m => m.signal.kind), ["offer", "iceCandidate"]);
  const channel = h.pcs[0].channels[0];
  h.voice.sendPcm(new Int16Array(1920).fill(-100), 2);
  assert.equal(channel.sent[0].byteLength, 3848);
  assert.equal(new DataView(channel.sent[0]).getInt16(8, true), -100);
  channel.bufferedAmount = 20000;
  h.voice.sendPcm(new Int16Array(1920), 2);
  assert.equal(channel.sent.length, 1);
});
test("direct stereo retains separate ears and rejects repeats, late and malformed datagrams", async t => {
  const h = harness(t); await settle(); const channel = h.pcs[0].channels[0];
  const pcm = Int16Array.from({ length: 1920 }, (_, index) => index % 2 ? -8192 : 16384);
  h.voice.sendPcm(pcm, 2); const packet = channel.sent[0];
  channel.onmessage({ data: packet });
  assert.deepEqual(h.received[0], [2, pcm, 2]); assert.equal(h.voice.receiving(2), true);
  channel.onmessage({ data: packet }); channel.onmessage({ data: new ArrayBuffer(14) });
  assert.equal(h.received.length, 1);
  h.advance(251); assert.equal(h.voice.receiving(2), false);
});
test("channel departure retires old audio and ignores captured callbacks", async t => {
  const h = harness(t); await settle(); const pc = h.pcs[0], channel = pc.channels[0];
  h.voice.sendPcm(new Int16Array(960), 1); const message = channel.onmessage;
  h.voice.handleMessage({ type: "peerVoiceRoster", selfPeerId: "a", peers: [], limited: false });
  assert.equal(pc.closed, 1); assert.deepEqual(h.retired, [2]);
  message({ data: channel.sent[0] }); assert.equal(h.received.length, 0);
});
test("failed connection returns to fallback and opt-out retires pending offers", async t => {
  const h = harness(t); await settle(); const pc = h.pcs[0];
  pc.connectionState = "failed"; pc.onconnectionstatechange();
  assert.equal(h.voice.status.value, "fallback"); assert.equal(pc.closed, 1);
  h.voice.setEnabled(false); assert.equal(h.voice.status.value, "off");
  assert.equal(h.sent.at(-1).enabled, false);
});
test("stale negotiation cannot answer after disconnect or touch its successor", async t => {
  const h = harness(t); await settle();
  h.voice.handleMessage({ type: "peerVoiceRoster", selfPeerId: "z", peers: [{ peerId: "b", clientId: 2 }], limited: false });
  h.voice.handleMessage({ type: "peerVoiceSignal", fromPeerId: "b", connectionId: "offer", signal: { kind: "offer", sdp: "v=0" } });
  h.voice.disconnect(); await settle();
  assert.equal(h.sent.some(m => m.type === "peerVoiceSignal" && m.signal.kind === "answer"), false);
});
test("incompatible or unsupported gateways never receive P2P signaling", t => {
  const sent = []; const voice = createPeerVoice({ send: m => sent.push(m), onPcm: () => true, onRetired() {} });
  t.after(() => voice.disconnect()); voice.connect(false); voice.setEnabled(true);
  assert.deepEqual(sent, []);
});
