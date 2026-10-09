import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createScreenShareController } from "../src/voice/screen-share.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

class Track extends EventTarget {
  kind = "video";
  readyState = "live";
  stop() { this.readyState = "ended"; }
  getSettings() { return { width: 1920, height: 1080, frameRate: 60 }; }
}
function stream() {
  const track = new Track();
  return { track, getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] };
}

class Peer {
  static instances: Peer[] = [];
  static offer = () => Promise.resolve({ type: "offer", sdp: "offer" });
  static stats = () => Promise.resolve(new Map());
  connectionState = "new";
  iceConnectionState = "new";
  localDescription: unknown;
  parameters: RTCRtpSendParameters | null = null;
  closed = false;
  constructor(public configuration: RTCConfiguration) { Peer.instances.push(this); }
  createOffer() { return Peer.offer(); }
  createAnswer() { return Promise.resolve({ type: "answer", sdp: "answer" }); }
  setLocalDescription(description: unknown) { this.localDescription = description; return Promise.resolve(); }
  setRemoteDescription() { return Promise.resolve(); }
  addIceCandidate() { return Promise.resolve(); }
  addTransceiver() {}
  addTrack() { return { getParameters: () => ({ encodings: [] }), setParameters: async (parameters: RTCRtpSendParameters) => { this.parameters = parameters; } }; }
  getTransceivers() { return []; }
  getStats() { return Peer.stats(); }
  close() { this.closed = true; this.connectionState = "closed"; }
}

let controller: ReturnType<typeof createScreenShareController>;
let sent: Array<{ type: string; requestId?: string }>;
const globals = new Map<string, PropertyDescriptor | undefined>();
function replaceGlobal(name: string, value: unknown) {
  globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
beforeEach(() => {
  Peer.instances = [];
  Peer.offer = () => Promise.resolve({ type: "offer", sdp: "offer" });
  Peer.stats = () => Promise.resolve(new Map());
  replaceGlobal("RTCPeerConnection", Peer);
  replaceGlobal("navigator", { mediaDevices: { getDisplayMedia: async () => stream() } });
  sent = [];
  controller = createScreenShareController({ isOpen: () => true, send: message => sent.push(message) });
});
afterEach(() => {
  controller.stopTransport(false);
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  globals.clear();
});

const remote = { streamId: "remote-1", ownerPeerId: "owner", ownerNickname: "Owner", name: "Screen", source: "browser" as const, audio: false, createdAt: 1, viewerCount: 0 };
function confirmStart(streamId: string, requestId = sent.findLast(message => message.type === "screenShareStart")?.requestId) {
  controller.handleMessage({ type: "screenShareStarted", owner: true, requestId, stream: { ...remote, streamId } });
}

function relay(route: "macau" | "shenzhen") {
  return { route, expiresAt: Date.now() + 60_000, iceServers: [{ urls: [`turn:${route}.example:3478`], username: "temporary", credential: "signed" }] };
}
test("publisher forces the chosen TURN node while viewers keep ordinary ICE", async () => {
  controller.setRelays(["macau", "shenzhen"]);
  for (const route of ["macau", "shenzhen"] as const) {
    await controller.api.startScreenShare(true, { route });
    controller.handleMessage({ type: "screenShareStarted", owner: true, requestId: sent.at(-1)?.requestId, stream: { ...remote, route }, relay: relay(route) });
    controller.handleMessage({ type: "screenShareSignal", streamId: remote.streamId, fromPeerId: "viewer", signal: { kind: "offer", sdp: "offer" } });
    await nextTurn();
    assert.deepEqual(Peer.instances.at(-1)?.configuration, { iceServers: relay(route).iceServers, iceTransportPolicy: "relay" });
    controller.api.stopScreenShare();
  }
  controller.setIceServers([{ urls: "stun:ordinary.example" }]);
  controller.handleMessage({ type: "screenShareJoined", stream: { ...remote, route: "macau" } });
  await nextTurn();
  assert.deepEqual(Peer.instances.at(-1)?.configuration, { iceServers: [{ urls: "stun:ordinary.example" }] });
});
test("missing, expired or mismatched relay authorization releases capture without fallback", async () => {
  controller.setRelays(["macau"]);
  for (const lease of [undefined, relay("shenzhen"), { ...relay("macau"), expiresAt: 1 }]) {
    const capture = stream();
    Object.assign(navigator.mediaDevices, { getDisplayMedia: async () => capture });
    await controller.api.startScreenShare(true, { route: "macau" });
    controller.handleMessage({ type: "screenShareStarted", owner: true, requestId: sent.at(-1)?.requestId, stream: { ...remote, route: "macau" }, ...(lease ? { relay: lease } : {}) });
    assert.equal(capture.track.readyState, "ended");
    assert.equal(controller.api.screenShareActive.value, false);
    assert.equal(controller.api.screenShareErrorCode.value, "SCREEN_SHARE_RELAY_UNAVAILABLE");
  }
  assert.equal(Peer.instances.length, 0);
});
test("unconfigured relay fails before capture and stale route acknowledgement cannot replace a new start", async () => {
  let captures = 0;
  Object.assign(navigator.mediaDevices, { getDisplayMedia: async () => { captures++; return stream(); } });
  await controller.api.startScreenShare(true, { route: "macau" });
  assert.equal(captures, 0);
  controller.setRelays(["macau", "shenzhen"]);
  await controller.api.startScreenShare(true, { route: "macau" });
  const previous = sent.at(-1)?.requestId;
  controller.api.stopScreenShare();
  await controller.api.startScreenShare(true, { route: "shenzhen" });
  const current = sent.at(-1)?.requestId;
  controller.handleMessage({ type: "screenShareStarted", owner: true, requestId: previous, stream: { ...remote, streamId: "old", route: "macau" }, relay: relay("macau") });
  controller.handleMessage({ type: "screenShareStarted", owner: true, requestId: current, stream: { ...remote, route: "shenzhen" }, relay: relay("shenzhen") });
  assert.equal(controller.api.screenShareActive.value, true);
  controller.handleMessage({ type: "screenShareSignal", streamId: remote.streamId, fromPeerId: "viewer", signal: { kind: "offer", sdp: "offer" } });
  await nextTurn();
  assert.deepEqual(Peer.instances.at(-1)?.configuration.iceServers, relay("shenzhen").iceServers);
});

test("cancelling a pending offer cannot send signaling or restore diagnostics after exit", async () => {
  const offer = deferred<{ type: string; sdp: string }>();
  const stats = deferred<Map<string, unknown>>();
  Peer.offer = () => offer.promise;
  Peer.stats = () => stats.promise;
  controller.handleMessage({ type: "screenShareJoined", stream: remote });
  controller.stopTransport(false);
  offer.resolve({ type: "offer", sdp: "obsolete" });
  stats.resolve(new Map());
  await nextTurn();
  assert.equal(Peer.instances[0]?.closed, true);
  assert.deepEqual(sent, []);
  assert.equal(controller.api.screenShareWebRtcStats.updatedAt, null);
  assert.deepEqual(controller.api.screenShareWebRtcStats.peers, []);
});

test("a late start acknowledgement cannot cancel a newer capture", async () => {
  await controller.api.startScreenShare();
  const oldRequest = sent.at(-1)?.requestId;
  controller.api.stopScreenShare();
  await controller.api.startScreenShare();
  const newRequest = sent.at(-1)?.requestId;
  confirmStart("old", oldRequest);
  assert.equal(controller.api.screenShareStarting.value, true);
  confirmStart("new", newRequest);
  assert.equal(controller.api.screenShareActive.value, true);
  assert.equal(controller.api.screenShareActiveStreamId.value, "new");
});

test("a superseded permission result preserves the newer capture's output settings", async () => {
  const oldCapture = deferred<ReturnType<typeof stream>>();
  Object.assign(navigator.mediaDevices, { getDisplayMedia: () => oldCapture.promise });
  const oldStart = controller.api.startScreenShare(true, { maxWidth: 960 });
  controller.api.stopScreenShare();
  Object.assign(navigator.mediaDevices, { getDisplayMedia: async () => stream() });
  await controller.api.startScreenShare(true, { maxWidth: 640 });
  confirmStart("new");
  const oldStream = stream();
  oldCapture.resolve(oldStream);
  await oldStart;
  controller.handleMessage({ type: "screenShareSignal", streamId: "new", fromPeerId: "viewer", signal: { kind: "offer", sdp: "offer" } });
  await nextTurn();
  assert.equal(oldStream.track.readyState, "ended");
  assert.equal(Peer.instances[0]?.parameters?.encodings[0]?.scaleResolutionDownBy, 3);
});

test("invalid capture without a video track still releases every returned track", async () => {
  const capture = stream();
  Object.assign(navigator.mediaDevices, { getDisplayMedia: async () => ({ ...capture, getVideoTracks: () => [] }) });
  await controller.api.startScreenShare();
  assert.equal(capture.track.readyState, "ended");
  assert.equal(controller.api.screenShareStarting.value, false);
});

test("ICE configuration belongs to each controller independently", async () => {
  const second = createScreenShareController({ isOpen: () => true, send() {} });
  controller.setIceServers([{ urls: "stun:first.example" }]);
  second.setIceServers([{ urls: "stun:second.example" }]);
  try {
    controller.handleMessage({ type: "screenShareJoined", stream: remote });
    second.handleMessage({ type: "screenShareJoined", stream: remote });
    await nextTurn();
    assert.deepEqual(Peer.instances.map(peer => peer.configuration.iceServers), [
      [{ urls: "stun:first.example" }], [{ urls: "stun:second.example" }],
    ]);
  } finally { second.stopTransport(false); }
});
