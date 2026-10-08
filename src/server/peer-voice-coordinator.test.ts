import { test } from "node:test";
import assert from "node:assert/strict";
import { PeerVoiceCoordinator } from "./peer-voice-coordinator.js";
import { parsePeerVoiceClientMessage, isPeerVoiceServerMessage } from "../shared/peer-voice.js";

function setup() {
  let clock = 1000;
  const entries = new Map();
  const messages: { id: string; message: any }[] = [];
  const coordinator = new PeerVoiceCoordinator(entries, (id, message) => messages.push({ id, message }), () => clock);
  function join(id: string, clientId: number, host = "voice.example", channelId = 1n) {
    const entry = { id, target: { host, port: 9987 }, channelId, connected: true, whisperActive: false,
      tsClient: { getClientId: () => clientId, getChannelId: () => entry.channelId, isConnected: () => entry.connected } };
    entries.set(id, entry);
    coordinator.handle(entry, { type: "peerVoiceJoin", enabled: true });
    return entry;
  }
  const roster = (id: string) => messages.filter(item => item.id === id && item.message.type === "peerVoiceRoster").at(-1)!.message;
  return { entries, messages, coordinator, join, roster, advance: (ms: number) => { clock += ms; } };
}

test("voice signaling requires opt-in on the same server and channel", () => {
  const h = setup();
  const a = h.join("a", 1), b = h.join("b", 2);
  h.join("c", 2, "other.example"); h.join("d", 3, "voice.example", 2n);
  assert.deepEqual(h.roster("a").peers.map((peer: any) => peer.clientId), [2]);
  const peerId = h.roster("b").selfPeerId;
  h.coordinator.handle(a, { type: "peerVoiceSignal", targetPeerId: peerId, connectionId: "connection", signal: { kind: "offer", sdp: "v=0" } });
  assert.equal(h.messages.at(-1)!.id, "b");
  assert.equal(h.messages.at(-1)!.message.fromPeerId, h.roster("a").selfPeerId);
  const count = h.messages.length;
  b.channelId = 2n;
  h.coordinator.handle(a, { type: "peerVoiceSignal", targetPeerId: peerId, connectionId: "connection", signal: { kind: "offer", sdp: "v=0" } });
  assert.equal(h.messages.length, count);
  assert.equal(h.coordinator.route("a", 2), "normal");
});

test("duplicate suppression expires, honors whispers and resumes after opt-out", () => {
  const h = setup(); const a = h.join("a", 1), b = h.join("b", 2);
  assert.equal(h.coordinator.route("a", 2), "fallback");
  h.coordinator.handle(a, { type: "peerVoiceReceiving", peerIds: [h.roster("b").selfPeerId] });
  assert.equal(h.coordinator.route("a", 2), "suppress");
  b.whisperActive = true;
  assert.equal(h.coordinator.route("a", 2), "normal");
  b.whisperActive = false; h.advance(501);
  assert.equal(h.coordinator.route("a", 2), "fallback");
  h.coordinator.handle(b, { type: "peerVoiceJoin", enabled: false });
  assert.equal(h.coordinator.route("a", 2), "normal");
  assert.deepEqual(h.roster("a").peers, []);
});

test("over five opted-in participants use the server path without forming a mesh", () => {
  const h = setup();
  for (let id = 1; id <= 6; id++) h.join(String(id), id);
  assert.equal(h.roster("1").limited, true);
  assert.deepEqual(h.roster("1").peers, []);
  assert.equal(h.coordinator.route("1", 2), "normal");
  h.coordinator.remove("6");
  assert.equal(h.roster("1").limited, false);
  assert.equal(h.roster("1").peers.length, 4);
});

test("retired session ids cannot signal or route their replacements", () => {
  const h = setup(); const a = h.join("a", 1); h.join("b", 2);
  h.coordinator.remove("a"); const replacement = h.join("a", 3);
  const count = h.messages.length;
  h.coordinator.handle(a, { type: "peerVoiceSignal", targetPeerId: h.roster("b").selfPeerId, connectionId: "old", signal: { kind: "close" } });
  assert.equal(h.messages.length, count);
  replacement.connected = false; h.coordinator.refresh();
  assert.deepEqual(h.roster("b").peers, []);
});

test("wire parsers reject oversized rosters, invalid peers, ICE and fields", () => {
  assert.equal(parsePeerVoiceClientMessage(JSON.stringify({ type: "peerVoiceReceiving", peerIds: Array(5).fill("peer") })), null);
  assert.equal(parsePeerVoiceClientMessage(JSON.stringify({ type: "peerVoiceSignal", targetPeerId: "peer", connectionId: "x", signal: { kind: "iceCandidate", candidate: "x".repeat(9000) } })), null);
  assert.equal(isPeerVoiceServerMessage({ type: "peerVoiceRoster", selfPeerId: "self", limited: false, peers: [{ peerId: "p", clientId: -1 }] }), false);
  assert.equal(isPeerVoiceServerMessage({ type: "peerVoiceSignal", fromPeerId: "p", connectionId: "c", signal: { kind: "close" } }), true);
});
