import assert from "node:assert/strict";
import { before, after, beforeEach, afterEach, test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// Exercise the actual composable and shared wire parser. Only browser/network
// boundaries are simulated; these tests make no claim about real audio quality.
class TestSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];
  readyState = TestSocket.OPEN;
  bufferedAmount = 0;
  messages = [];
  constructor(url) { this.url = url; TestSocket.instances.push(this); }
  send(raw) { this.messages.push(typeof raw === "string" ? JSON.parse(raw) : raw); }
  close(code = 1000) { this.readyState = TestSocket.CLOSED; this.onclose?.({ code, reason: "" }); }
  receive(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

class TestTrack extends EventTarget {
  kind = "video";
  readyState = "live";
  stopped = 0;
  stop() { this.stopped++; this.readyState = "ended"; }
  getSettings() { return { displaySurface: "monitor", width: 1920, height: 1080, frameRate: 60 }; }
  async applyConstraints() {}
}

class AudioNodeStub {
  gain = { value: 1 };
  connect() {}
  disconnect() {}
}
class AudioContextStub extends EventTarget {
  static processors = [];
  state = "running";
  sampleRate = 48000;
  destination = new AudioNodeStub();
  close() { this.state = "closed"; return Promise.resolve(); }
  createMediaStreamSource() {
    if (this.state === "closed") throw new Error("Audio context closed");
    return new AudioNodeStub();
  }
  createMediaStreamDestination() { return Object.assign(new AudioNodeStub(), { stream: microphoneStream() }); }
  createGain() { return new AudioNodeStub(); }
  createScriptProcessor() { const node = new AudioNodeStub(); AudioContextStub.processors.push(node); return node; }
}
function microphoneStream() {
  const track = new TestTrack();
  track.kind = "audio";
  return { track, getTracks: () => [track], getVideoTracks: () => [], getAudioTracks: () => [track] };
}

function displayStream() {
  const track = new TestTrack();
  return { track, getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

class TestPeer extends EventTarget {
  static instances = [];
  iceGatheringState = "complete";
  connectionState = "new";
  localDescription = null;
  remoteDescription = null;
  sender = { track: null, replaceTrack: async track => { this.sender.track = track; } };
  constructor() { super(); TestPeer.instances.push(this); }
  addTrack(track) { this.sender.track = track; }
  getSenders() { return [this.sender]; }
  async createOffer() { return { type: "offer", sdp: "test-offer" }; }
  async setLocalDescription(description) { this.localDescription = description; }
  async setRemoteDescription(description) { this.remoteDescription = description; }
  close() { this.connectionState = "closed"; }
}

const browserTimers = new Set();
const audioElements = new Set();
class TestAudioElement extends EventTarget {
  style = {};
  async play() {}
  pause() {}
  setAttribute() {}
  remove() { audioElements.delete(this); }
}

let vite;
let useVoiceWebSocket;
let voice;
const savedGlobals = new Map();
function replaceGlobal(name, value) {
  if (!savedGlobals.has(name)) savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

before(async () => {
  // The noise-suppression library declares a worklet subclass at import time.
  replaceGlobal("AudioWorkletNode", class {});
  vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("../", import.meta.url)),
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  ({ useVoiceWebSocket } = await vite.ssrLoadModule("/src/composables/useVoiceWebSocket.ts"));
});

beforeEach(() => {
  TestSocket.instances.length = 0;
  TestPeer.instances.length = 0;
  AudioContextStub.processors.length = 0;
  audioElements.clear();
  replaceGlobal("RTCPeerConnection", TestPeer);
  replaceGlobal("window", Object.assign(new EventTarget(), {
    setTimeout(callback, ms) {
      const timer = setTimeout(() => { browserTimers.delete(timer); callback(); }, ms);
      browserTimers.add(timer);
      return timer;
    },
    clearTimeout(timer) { clearTimeout(timer); browserTimers.delete(timer); },
  }));
  replaceGlobal("document", Object.assign(new EventTarget(), {
    createElement: () => new TestAudioElement(),
    body: { append: element => audioElements.add(element) },
  }));
  replaceGlobal("WebSocket", TestSocket);
  replaceGlobal("location", { protocol: "https:", host: "gateway.example" });
  replaceGlobal("fetch", async () => ({ ok: true, json: async () => ({ ticket: "test-ticket" }) }));
  replaceGlobal("AudioContext", AudioContextStub);
  replaceGlobal("HTMLMediaElement", class {});
  replaceGlobal("navigator", { mediaDevices: {
    getDisplayMedia: async () => displayStream(),
    getUserMedia: async () => microphoneStream(),
    enumerateDevices: async () => [],
  } });
  voice = useVoiceWebSocket();
});

afterEach(() => {
  voice?.disconnect();
  for (const timer of browserTimers) clearTimeout(timer);
  browserTimers.clear();
});
after(async () => {
  await vite?.close();
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

async function connect() {
  voice.connect("voice.example:9987", "", "Visitor");
  await nextTurn();
  const socket = TestSocket.instances.at(-1);
  assert.ok(socket, "join ticket should open a voice socket");
  return socket;
}

async function connectWebRtc() {
  const socket = await connect();
  socket.receive({ type: "connected", tsClientId: 1, webrtcAvailable: true });
  await nextTurn();
  assert.ok(socket.messages.some(message => message.type === "webrtcOffer"));
  return { socket, peer: TestPeer.instances.at(-1) };
}

test("late control messages from a replaced socket cannot change the new session", async () => {
  const old = await connect();
  const lateMessage = old.onmessage;
  const current = await connect();
  current.receive({ type: "memberEnter", id: 2, nickname: "Current" });
  lateMessage({ data: JSON.stringify({ type: "memberEnter", id: 3, nickname: "Previous" }) });
  assert.deepEqual(voice.members.map(member => member.nickname), ["Current"]);
});

test("unexpected socket closure releases active screen capture and pending commands", async () => {
  const stream = displayStream();
  navigator.mediaDevices.getDisplayMedia = async () => stream;
  const socket = await connect();
  await voice.startScreenShare();
  const start = socket.messages.find(message => message.type === "screenShareStart");
  socket.receive({ type: "screenShareStarted", requestId: start.requestId, owner: true,
    stream: { streamId: "share-1", ownerPeerId: "owner" } });
  assert.equal(voice.screenShareActive.value, true);
  const command = assert.rejects(voice.moveClient(2, "1"), /语音连接已关闭/);
  socket.close(1006);
  await command;
  assert.equal(stream.track.readyState, "ended");
  assert.equal(voice.screenShareActive.value, false);
  assert.equal(voice.screenShareStreams.length, 0);
  assert.equal(voice.ws.value, null);
});

test("screen permission resolved after socket closure releases the late stream", async () => {
  const capture = deferred();
  const stream = displayStream();
  navigator.mediaDevices.getDisplayMedia = () => capture.promise;
  const socket = await connect();
  const pendingStart = voice.startScreenShare();
  socket.close(1006);
  capture.resolve(stream);
  await pendingStart;
  assert.equal(stream.track.readyState, "ended");
  assert.equal(voice.screenShareStarting.value, false);
  assert.equal(socket.messages.some(message => message.type === "screenShareStart"), false);
});

test("shared message validation rejects malformed directories without disturbing valid state", async () => {
  const socket = await connect();
  socket.receive({ type: "channelList", channels: [{ id: "1", parentID: "0", name: "Lobby" }] });
  socket.receive({ type: "channelList", channels: [{ id: "1", parentID: "0", name: { invalid: true } }] });
  assert.deepEqual(voice.channels.map(channel => channel.name), ["Lobby"]);
});

test("a microphone permission result after disconnect is cancelled and its track stopped", async () => {
  const permission = deferred();
  const stream = microphoneStream();
  navigator.mediaDevices.getUserMedia = () => permission.promise;
  const pending = voice.ensureMicrophone();
  const cancelled = assert.rejects(pending, { name: "AbortError" });
  voice.disconnect();
  permission.resolve(stream);
  await cancelled;
  assert.equal(stream.track.readyState, "ended");
  assert.equal(voice.state.microphoneErrorCode, "");
});

test("a new connection acquires its own microphone while old permission is still pending", async () => {
  const oldPermission = deferred();
  const oldStream = microphoneStream();
  let requests = 0;
  navigator.mediaDevices.getUserMedia = () => ++requests === 1 ? oldPermission.promise : Promise.resolve(microphoneStream());
  const first = await connect();
  first.receive({ type: "connected", tsClientId: 1 });
  await nextTurn();
  const second = await connect();
  second.receive({ type: "connected", tsClientId: 2 });
  await nextTurn();
  const observedRequests = requests;
  oldPermission.resolve(oldStream);
  await nextTurn();
  assert.equal(observedRequests, 2);
  assert.equal(oldStream.track.readyState, "ended");
  assert.equal(voice.state.microphoneErrorCode, "");
});

test("accompaniment permission arriving after disconnect releases every returned track", async () => {
  await connectWebRtc();
  const permission = deferred();
  const stream = microphoneStream();
  navigator.mediaDevices.getDisplayMedia = () => permission.promise;
  const pending = voice.startAccompaniment();
  voice.disconnect();
  permission.resolve(stream);
  await pending;
  assert.equal(stream.track.readyState, "ended");
  assert.equal(voice.accompanimentActive.value, false);
});

test("a superseded accompaniment capture cannot replace or stop its successor", async () => {
  await connectWebRtc();
  const firstPermission = deferred();
  const old = microphoneStream();
  const current = microphoneStream();
  navigator.mediaDevices.getDisplayMedia = () => firstPermission.promise;
  const first = voice.startAccompaniment();
  navigator.mediaDevices.getDisplayMedia = async () => current;
  await voice.startAccompaniment();
  firstPermission.resolve(old);
  await first;
  assert.equal(old.track.readyState, "ended");
  assert.equal(current.track.readyState, "live");
  assert.equal(voice.accompanimentActive.value, true);
});

test("stopping accompaniment while constraints are pending cancels the capture", async () => {
  await connectWebRtc();
  const constraints = deferred();
  const stream = microphoneStream();
  stream.track.applyConstraints = () => constraints.promise;
  navigator.mediaDevices.getDisplayMedia = async () => stream;
  const pending = voice.startAccompaniment();
  await nextTurn();
  await voice.stopAccompaniment();
  constraints.resolve();
  await pending;
  assert.equal(stream.track.readyState, "ended");
  assert.equal(voice.accompanimentActive.value, false);
});

test("an old accompaniment ended event cannot stop the replacement track", async () => {
  await connectWebRtc();
  const old = microphoneStream();
  const current = microphoneStream();
  navigator.mediaDevices.getDisplayMedia = async () => old;
  await voice.startAccompaniment();
  navigator.mediaDevices.getDisplayMedia = async () => current;
  await voice.startAccompaniment();
  old.track.dispatchEvent(new Event("ended"));
  await nextTurn();
  assert.equal(current.track.readyState, "live");
  assert.equal(voice.accompanimentActive.value, true);
});

test("a rejected old WebRTC answer cannot force the new peer into fallback", async () => {
  const first = await connectWebRtc();
  const answer = deferred();
  first.peer.setRemoteDescription = () => answer.promise;
  first.socket.receive({ type: "webrtcAnswer", payload: { sdp: { type: "answer", sdp: "old-answer" } } });
  const current = await connectWebRtc();
  answer.reject(new Error("old peer closed"));
  await nextTurn();
  assert.notEqual(current.peer.connectionState, "closed");
  assert.equal(current.socket.messages.some(message => message.type === "webrtcStop"), false);
  assert.equal(voice.state.audioNoticeCode, "");
});

test("a successful old WebRTC answer cannot activate WebRTC for a compatibility connection", async () => {
  const first = await connectWebRtc();
  const answer = deferred();
  first.peer.setRemoteDescription = () => answer.promise;
  first.socket.receive({ type: "webrtcAnswer", payload: { sdp: { type: "answer", sdp: "old-answer" } } });
  const current = await connect();
  current.receive({ type: "connected", tsClientId: 2 });
  await nextTurn();
  answer.resolve();
  await nextTurn();
  voice.setVolume(9, 0.4);
  assert.equal(current.messages.some(message => message.type === "setMemberVolume"), false);
});

test("a queued track event from a closed peer cannot replace current playback", async () => {
  const first = await connectWebRtc();
  const oldOnTrack = first.peer.ontrack;
  const current = await connectWebRtc();
  current.peer.ontrack({ streams: [microphoneStream()] });
  const output = [...audioElements][0];
  oldOnTrack({ streams: [microphoneStream()] });
  assert.deepEqual([...audioElements], [output]);
});

test("a late playback rejection does not restore notices or retry listeners after disconnect", async () => {
  const { peer } = await connectWebRtc();
  const playback = deferred();
  const output = new TestAudioElement();
  output.play = () => playback.promise;
  document.createElement = () => output;
  peer.ontrack({ streams: [microphoneStream()] });
  voice.disconnect();
  playback.reject(new Error("autoplay blocked"));
  await nextTurn();
  assert.equal(voice.state.audioNoticeCode, "");
  assert.equal(audioElements.size, 0);
});

test("disconnect clears the WebRTC answer deadline immediately", async () => {
  await connectWebRtc();
  assert.ok(browserTimers.size > 0);
  voice.disconnect();
  assert.equal(browserTimers.size, 0);
});

test("negotiation failure resumes bounded PCM capture without a false microphone error", async t => {
  t.mock.method(TestPeer.prototype, "createOffer", async () => { throw new Error("negotiation failed"); });
  const socket = await connect();
  socket.receive({ type: "connected", tsClientId: 1, webrtcAvailable: true });
  await nextTurn();
  assert.equal(TestPeer.instances[0].connectionState, "closed");
  assert.equal(voice.state.audioNoticeCode, "WEBRTC_FALLBACK");
  assert.equal(voice.state.microphoneErrorCode, "");
  const capture = AudioContextStub.processors.at(-1);
  capture.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(960).fill(0.2) } });
  assert.ok(socket.messages.some(message => message instanceof ArrayBuffer && message.byteLength === 1920));
  assert.equal(socket.messages.filter(message => message.type === "webrtcStop").length, 1);
});

test("track setup failure also releases the peer and restores compatibility capture", async t => {
  t.mock.method(TestPeer.prototype, "addTrack", () => { throw new Error("track rejected"); });
  const socket = await connect();
  socket.receive({ type: "connected", tsClientId: 1, webrtcAvailable: true });
  await nextTurn();
  assert.equal(TestPeer.instances[0].connectionState, "closed");
  assert.equal(voice.state.audioNoticeCode, "WEBRTC_FALLBACK");
  assert.equal(voice.state.microphoneErrorCode, "");
  AudioContextStub.processors.at(-1).onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(960).fill(0.2) } });
  assert.ok(socket.messages.some(message => message instanceof ArrayBuffer && message.byteLength === 1920));
});

test("a current answer completes negotiation and removes its timeout", async () => {
  const { socket, peer } = await connectWebRtc();
  socket.receive({ type: "webrtcAnswer", payload: { sdp: { type: "answer", sdp: "current-answer" } } });
  await nextTurn();
  assert.equal(peer.remoteDescription.sdp, "current-answer");
  assert.equal(browserTimers.size, 0);
  assert.equal(socket.messages.some(message => message.type === "webrtcStop"), false);
});

test("disconnect cancels an ICE gathering wait without sending an offer", async t => {
  t.mock.method(TestPeer.prototype, "setLocalDescription", async function(description) {
    this.localDescription = description;
    this.iceGatheringState = "gathering";
  });
  const socket = await connect();
  socket.receive({ type: "connected", tsClientId: 1, webrtcAvailable: true });
  await nextTurn();
  assert.ok(browserTimers.size > 0);
  voice.disconnect();
  await nextTurn();
  assert.equal(browserTimers.size, 0);
  assert.equal(socket.messages.some(message => message.type === "webrtcOffer"), false);
  assert.equal(voice.state.microphoneErrorCode, "");
});

test("an offer rejected after a new connection opens cannot report a microphone error", async t => {
  const oldOffer = deferred();
  let calls = 0;
  t.mock.method(TestPeer.prototype, "createOffer", () => ++calls === 1 ? oldOffer.promise : Promise.resolve({ type: "offer", sdp: "new-offer" }));
  const old = await connect();
  old.receive({ type: "connected", tsClientId: 1, webrtcAvailable: true });
  await nextTurn();
  const current = await connectWebRtc();
  oldOffer.reject(new Error("old peer closed"));
  await nextTurn();
  assert.notEqual(current.peer.connectionState, "closed");
  assert.equal(voice.state.microphoneErrorCode, "");
  assert.equal(voice.state.audioNoticeCode, "");
});
