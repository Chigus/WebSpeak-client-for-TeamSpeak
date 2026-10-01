import assert from "node:assert/strict";
import { before, after, beforeEach, afterEach, test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { effectScope, ref } from "vue";

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
  disconnects = 0;
  connect() {}
  disconnect() { this.disconnects++; }
}
class AudioSourceStub extends EventTarget {
  static failStart = false;
  stopped = 0;
  disconnects = 0;
  connect() {}
  disconnect() { this.disconnects++; }
  start(time) { if (AudioSourceStub.failStart) throw new Error("Source cannot start"); this.startedAt = time; }
  stop() { this.stopped++; }
}
class AudioDecoderStub {
  static instances = [];
  static failConfigure = false;
  decodeQueueSize = 0;
  closed = 0;
  constructor(callbacks) { this.callbacks = callbacks; AudioDecoderStub.instances.push(this); }
  configure() { if (AudioDecoderStub.failConfigure) throw new Error("Codec unavailable"); }
  decode(chunk) { this.lastChunk = chunk; }
  close() { this.closed++; }
}
class RecorderStub {
  static instances = [];
  static failStart = false;
  state = "inactive";
  mimeType = "audio/webm";
  stops = 0;
  constructor(stream) { this.stream = stream; RecorderStub.instances.push(this); }
  start() { if (RecorderStub.failStart) throw new Error("Recorder start failed"); this.state = "recording"; }
  stop() { this.stops++; this.state = "inactive"; }
  finish() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["audio"]) }); this.onstop?.(); }
}
function decodedChunk() {
  return { sampleRate: 48000, numberOfChannels: 1, numberOfFrames: 960, closed: 0, copyTo() {}, close() { this.closed++; } };
}
function receiveAudio(socket, clientId = 7) {
  socket.onmessage({ data: new Uint8Array([4, clientId >> 8, clientId & 255, 1, 2, 3]).buffer });
}
class AudioContextStub extends EventTarget {
  static instances = [];
  static processors = [];
  static sources = [];
  static gains = [];
  static mediaSources = [];
  static destinations = [];
  state = "running";
  currentTime = 0;
  sampleRate = 48000;
  destination = new AudioNodeStub();
  constructor() { super(); AudioContextStub.instances.push(this); }
  async setSinkId(id) { this.sinkId = id; }
  close() { this.state = "closed"; return Promise.resolve(); }
  createMediaStreamSource(stream) {
    if (this.state === "closed") throw new Error("Audio context closed");
    const node = Object.assign(new AudioNodeStub(), { stream });
    AudioContextStub.mediaSources.push(node);
    return node;
  }
  createMediaStreamDestination() {
    const node = Object.assign(new AudioNodeStub(), { stream: microphoneStream() });
    AudioContextStub.destinations.push(node);
    return node;
  }
  createGain() { const node = new AudioNodeStub(); AudioContextStub.gains.push(node); return node; }
  createBuffer(channels, frames, sampleRate) { return { duration: frames / sampleRate, copyToChannel() {} }; }
  createBufferSource() { const node = new AudioSourceStub(); AudioContextStub.sources.push(node); return node; }
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
let useWebClientAudioControls;
let webClientTranslations;
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
  ({ useWebClientAudioControls } = await vite.ssrLoadModule("/src/composables/useWebClientAudioControls.ts"));
  ({ webClientTranslations } = await vite.ssrLoadModule("/src/i18n/web-client.ts"));
});

beforeEach(() => {
  TestSocket.instances.length = 0;
  TestPeer.instances.length = 0;
  AudioContextStub.processors.length = 0;
  AudioContextStub.instances.length = 0;
  AudioContextStub.sources.length = 0;
  AudioContextStub.gains.length = 0;
  AudioContextStub.mediaSources.length = 0;
  AudioContextStub.destinations.length = 0;
  AudioDecoderStub.instances.length = 0;
  AudioDecoderStub.failConfigure = false;
  AudioSourceStub.failStart = false;
  RecorderStub.instances.length = 0;
  RecorderStub.failStart = false;
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
  replaceGlobal("AudioWorkletNode", class {});
  replaceGlobal("AudioDecoder", AudioDecoderStub);
  replaceGlobal("MediaRecorder", RecorderStub);
  const storage = new Map();
  replaceGlobal("localStorage", { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) });
  replaceGlobal("EncodedAudioChunk", class { constructor(init) { Object.assign(this, init); } });
  replaceGlobal("HTMLMediaElement", class {});
  replaceGlobal("navigator", { mediaDevices: {
    getDisplayMedia: async () => displayStream(),
    getUserMedia: async () => microphoneStream(),
    enumerateDevices: async () => [],
  } });
  voice = useVoiceWebSocket();
});

afterEach(() => {
  voice?.stopMicrophoneTest();
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
  const stateAtStop = stream.track.readyState;
  constraints.resolve();
  await pending;
  assert.equal(stateAtStop, "ended", "cancellation must release capture before constraints settle");
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

test("accompaniment allocation failure preserves the live microphone sender", async t => {
  const { socket, peer } = await connectWebRtc();
  const originalTrack = peer.sender.track;
  const candidate = microphoneStream();
  navigator.mediaDevices.getDisplayMedia = async () => candidate;
  const context = AudioContextStub.instances.at(-1);
  const createSource = context.createMediaStreamSource.bind(context);
  t.mock.method(context, "createMediaStreamSource", stream => {
    if (stream === candidate) throw new Error("Cannot allocate accompaniment source");
    return createSource(stream);
  });
  await assert.rejects(voice.startAccompaniment(), /Cannot allocate/);
  assert.equal(originalTrack.readyState, "live");
  assert.equal(peer.sender.track, originalTrack);
  assert.equal(candidate.track.readyState, "ended");
  assert.equal(voice.accompanimentActive.value, false);
  assert.equal(socket.messages.some(message => message.type === "setAccompanimentActive" && message.payload.active), false);
});

test("failed accompaniment replacement keeps the previous capture and disconnects the candidate node", async t => {
  const { peer } = await connectWebRtc();
  const current = microphoneStream();
  navigator.mediaDevices.getDisplayMedia = async () => current;
  await voice.startAccompaniment();
  const originalTrack = peer.sender.track;
  const candidate = microphoneStream();
  const failedNode = new AudioNodeStub();
  failedNode.connect = () => { throw new Error("Cannot connect accompaniment source"); };
  navigator.mediaDevices.getDisplayMedia = async () => candidate;
  const context = AudioContextStub.instances.at(-1);
  const createSource = context.createMediaStreamSource.bind(context);
  t.mock.method(context, "createMediaStreamSource", stream => stream === candidate ? failedNode : createSource(stream));
  await assert.rejects(voice.startAccompaniment(), /Cannot connect/);
  assert.equal(current.track.readyState, "live");
  assert.equal(voice.accompanimentActive.value, true);
  assert.equal(originalTrack.readyState, "live");
  assert.equal(candidate.track.readyState, "ended");
  assert.equal(failedNode.disconnects, 1);
});

test("starting and stopping accompaniment never ends the microphone sender track", async () => {
  const { peer } = await connectWebRtc();
  const originalTrack = peer.sender.track;
  const stream = microphoneStream();
  navigator.mediaDevices.getDisplayMedia = async () => stream;
  await voice.startAccompaniment();
  assert.equal(originalTrack.readyState, "live");
  assert.equal(peer.sender.track, originalTrack);
  await voice.stopAccompaniment();
  assert.equal(originalTrack.readyState, "live");
  assert.equal(peer.sender.track, originalTrack);
  assert.equal(stream.track.readyState, "ended");
});

test("stopping accompaniment succeeds even when another output cannot be allocated", async t => {
  const { peer } = await connectWebRtc();
  const stream = microphoneStream();
  navigator.mediaDevices.getDisplayMedia = async () => stream;
  await voice.startAccompaniment();
  const originalTrack = peer.sender.track;
  t.mock.method(AudioContextStub.instances.at(-1), "createMediaStreamDestination", () => { throw new Error("No output available"); });
  await voice.stopAccompaniment();
  assert.equal(originalTrack.readyState, "live");
  assert.equal(peer.sender.track, originalTrack);
  assert.equal(stream.track.readyState, "ended");
});

test("disconnect releases pending accompaniment without waiting for constraints", async () => {
  await connectWebRtc();
  const constraints = deferred();
  const stream = microphoneStream();
  stream.track.applyConstraints = () => constraints.promise;
  navigator.mediaDevices.getDisplayMedia = async () => stream;
  const pending = voice.startAccompaniment();
  await nextTurn();
  voice.disconnect();
  const stateAtDisconnect = stream.track.readyState;
  constraints.resolve();
  await pending;
  assert.equal(stateAtDisconnect, "ended");
  assert.equal(voice.accompanimentActive.value, false);
});

test("a newer accompaniment request immediately releases an older pending candidate", async () => {
  await connectWebRtc();
  const constraints = deferred();
  const old = microphoneStream();
  old.track.applyConstraints = () => constraints.promise;
  navigator.mediaDevices.getDisplayMedia = async () => old;
  const pending = voice.startAccompaniment();
  await nextTurn();
  const current = microphoneStream();
  navigator.mediaDevices.getDisplayMedia = async () => current;
  await voice.startAccompaniment();
  const oldStateAtReplacement = old.track.readyState;
  constraints.resolve();
  await pending;
  assert.equal(oldStateAtReplacement, "ended");
  assert.equal(current.track.readyState, "live");
  assert.equal(voice.accompanimentActive.value, true);
});

test("capture ended during accompaniment preparation is never announced as active", async () => {
  const { socket } = await connectWebRtc();
  const constraints = deferred();
  const stream = microphoneStream();
  stream.track.applyConstraints = () => constraints.promise;
  navigator.mediaDevices.getDisplayMedia = async () => stream;
  const pending = voice.startAccompaniment();
  await nextTurn();
  stream.track.readyState = "ended";
  stream.track.dispatchEvent(new Event("ended"));
  constraints.resolve();
  await pending;
  assert.equal(voice.accompanimentActive.value, false);
  assert.equal(socket.messages.some(message => message.type === "setAccompanimentActive" && message.payload.active), false);
});

test("an optional content hint failure does not abandon or fail accompaniment capture", async () => {
  await connectWebRtc();
  const stream = microphoneStream();
  Object.defineProperty(stream.track, "contentHint", { set() { throw new Error("Hint unavailable"); } });
  navigator.mediaDevices.getDisplayMedia = async () => stream;
  await voice.startAccompaniment();
  assert.equal(voice.accompanimentActive.value, true);
  await voice.stopAccompaniment();
  assert.equal(stream.track.readyState, "ended");
});

test("failed initial WebRTC input allocation releases partial nodes before PCM fallback", async t => {
  const createGain = AudioContextStub.prototype.createGain;
  let gainCalls = 0;
  t.mock.method(AudioContextStub.prototype, "createGain", function () {
    if (++gainCalls === 3) throw new Error("Mixed input gain unavailable");
    return createGain.call(this);
  });
  const socket = await connect();
  socket.receive({ type: "connected", tsClientId: 1, webrtcAvailable: true });
  await nextTurn();
  assert.equal(TestPeer.instances[0].connectionState, "closed");
  assert.equal(AudioContextStub.destinations[1].stream.track.readyState, "ended");
  assert.ok(AudioContextStub.mediaSources[1].disconnects > 0);
  assert.equal(voice.state.microphoneErrorCode, "");
  assert.equal(voice.state.audioNoticeCode, "WEBRTC_FALLBACK");
});

test("a failing mix-node disconnect cannot prevent peer and microphone cleanup", async t => {
  const microphone = microphoneStream();
  navigator.mediaDevices.getUserMedia = async () => microphone;
  const { peer } = await connectWebRtc();
  const outputTrack = peer.sender.track;
  t.mock.method(AudioContextStub.mediaSources[1], "disconnect", () => { throw new Error("Node already unavailable"); }, { times: 1 });
  assert.doesNotThrow(() => voice.disconnect());
  assert.equal(peer.connectionState, "closed");
  assert.equal(outputTrack.readyState, "ended");
  assert.equal(microphone.track.readyState, "ended");
});

test("audio setup failure shows a distinct accompaniment message in every language", async t => {
  await connectWebRtc();
  navigator.mediaDevices.getDisplayMedia = async () => microphoneStream();
  t.mock.method(AudioContextStub.instances.at(-1), "createMediaStreamSource", () => { throw new Error("Source unavailable"); });
  const scope = effectScope();
  t.after(() => scope.stop());
  for (const language of ["zh", "en", "de", "ru", "ja"]) {
    const messages = [];
    const translations = webClientTranslations[language];
    const controls = scope.run(() => useWebClientAudioControls({ ...voice, settingsOpen: ref(false),
      localizedMessage: value => value, showToast: message => messages.push(message), t: key => translations[key] }));
    await controls.toggleAccompaniment();
    assert.equal(voice.accompanimentErrorCode.value, "audio");
    assert.equal(messages.at(-1), translations.accompanimentAudioFailed);
    assert.ok(messages.at(-1));
    assert.notEqual(messages.at(-1), translations.accompanimentPermissionDenied);
  }
});

test("accompaniment keeps display processing off and preserves microphone mute and gain", async () => {
  const { peer, socket } = await connectWebRtc();
  const originalTrack = peer.sender.track;
  const micGain = AudioContextStub.gains.at(-1);
  voice.setInputVolume(0.4);
  const audio = microphoneStream();
  const video = displayStream();
  audio.track.contentHint = "";
  let applied, requested;
  audio.track.applyConstraints = async value => { applied = value; throw new Error("Optional constraints unavailable"); };
  navigator.mediaDevices.getSupportedConstraints = () => ({ restrictOwnAudio: true });
  navigator.mediaDevices.getDisplayMedia = async options => {
    requested = options;
    return { getTracks: () => [audio.track, video.track], getAudioTracks: () => [audio.track], getVideoTracks: () => [video.track] };
  };
  await voice.startAccompaniment();
  assert.deepEqual(applied, { autoGainControl: false, echoCancellation: false, noiseSuppression: false });
  assert.deepEqual(requested.audio, { ...applied, restrictOwnAudio: true });
  assert.equal(requested.selfBrowserSurface, "exclude");
  assert.equal(requested.systemAudio, "include");
  assert.equal(requested.windowAudio, "window");
  assert.equal(audio.track.contentHint, "music");
  assert.equal(video.track.readyState, "ended");
  assert.equal(micGain.gain.value, 0.4);
  voice.setMicrophoneMuted(true);
  assert.equal(micGain.gain.value, 0);
  assert.equal(audio.track.readyState, "live");
  voice.setInputVolume(0.7);
  assert.equal(micGain.gain.value, 0);
  voice.setMicrophoneMuted(false);
  assert.equal(micGain.gain.value, 0.7);
  audio.track.readyState = "ended";
  audio.track.dispatchEvent(new Event("ended"));
  assert.equal(voice.accompanimentActive.value, false);
  assert.equal(peer.sender.track, originalTrack);
  assert.equal(originalTrack.readyState, "live");
  assert.deepEqual(socket.messages.filter(message => message.type === "setAccompanimentActive").map(message => message.payload.active), [true, false]);
});

test("an old accompaniment permission rejection cannot change a successful replacement", async () => {
  await connectWebRtc();
  const permission = deferred();
  navigator.mediaDevices.getDisplayMedia = () => permission.promise;
  const old = voice.startAccompaniment();
  const stream = microphoneStream();
  navigator.mediaDevices.getDisplayMedia = async () => stream;
  await voice.startAccompaniment();
  permission.reject(new DOMException("Old permission denied", "NotAllowedError"));
  await old;
  assert.equal(voice.accompanimentActive.value, true);
  assert.equal(voice.accompanimentErrorCode.value, "");
  assert.equal(stream.track.readyState, "live");
});

test("a failed source selection preserves active accompaniment and disconnect clears its error", async () => {
  const { peer } = await connectWebRtc();
  const stream = microphoneStream();
  navigator.mediaDevices.getDisplayMedia = async () => stream;
  await voice.startAccompaniment();
  const rejected = displayStream();
  navigator.mediaDevices.getDisplayMedia = async () => rejected;
  await assert.rejects(voice.startAccompaniment(), /no audio/);
  assert.equal(voice.accompanimentErrorCode.value, "noAudio");
  assert.equal(rejected.track.readyState, "ended");
  assert.equal(stream.track.readyState, "live");
  assert.equal(peer.sender.track.readyState, "live");
  assert.equal(voice.accompanimentActive.value, true);
  voice.disconnect();
  assert.equal(voice.accompanimentActive.value, false);
  assert.equal(voice.accompanimentErrorCode.value, "");
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


test("resetting an overloaded remote decoder disconnects its old gain", async () => {
  const socket = await connect();
  receiveAudio(socket);
  const gain = AudioContextStub.gains.at(-1);
  AudioDecoderStub.instances.at(-1).decodeQueueSize = 3;
  receiveAudio(socket);
  assert.equal(gain.disconnects, 1);
  assert.equal(AudioDecoderStub.instances.length, 2);
});

test("an old source ending cannot hide replacement playback from session cleanup", async () => {
  const socket = await connect();
  receiveAudio(socket);
  const first = AudioDecoderStub.instances.at(-1);
  first.callbacks.output(decodedChunk());
  const oldSource = AudioContextStub.sources.at(-1);
  first.decodeQueueSize = 3;
  receiveAudio(socket);
  AudioDecoderStub.instances.at(-1).callbacks.output(decodedChunk());
  const replacement = AudioContextStub.sources.at(-1);
  oldSource.dispatchEvent(new Event("ended"));
  voice.disconnect();
  assert.equal(replacement.stopped, 1);
});

test("decoder failure releases the speaker's queued sources and gain immediately", async () => {
  const socket = await connect();
  receiveAudio(socket);
  const decoder = AudioDecoderStub.instances.at(-1);
  decoder.callbacks.output(decodedChunk());
  const source = AudioContextStub.sources.at(-1);
  const gain = AudioContextStub.gains.at(-1);
  decoder.callbacks.error(new Error("Decode failed"));
  assert.equal(source.stopped, 1);
  assert.equal(gain.disconnects, 1);
});

test("codec configuration failure is contained and releases the partially created stream", async () => {
  const socket = await connect();
  AudioDecoderStub.failConfigure = true;
  assert.doesNotThrow(() => receiveAudio(socket));
  assert.equal(AudioDecoderStub.instances.at(-1).closed, 1);
  assert.equal(AudioContextStub.gains.at(-1).disconnects, 1);
  AudioDecoderStub.failConfigure = false;
  receiveAudio(socket);
  assert.equal(AudioDecoderStub.instances.length, 2);
});

test("a failed audio source start does not retain a connected playback node", async () => {
  const socket = await connect();
  receiveAudio(socket);
  AudioSourceStub.failStart = true;
  const chunk = decodedChunk();
  AudioDecoderStub.instances.at(-1).callbacks.output(chunk);
  assert.ok(AudioContextStub.sources.at(-1).disconnects > 0);
  assert.equal(chunk.closed, 1);
});

test("late decoded chunks after disconnect close without creating playback", async () => {
  const socket = await connect();
  receiveAudio(socket);
  const old = AudioDecoderStub.instances.at(-1);
  voice.disconnect();
  const chunk = decodedChunk();
  old.callbacks.output(chunk);
  assert.equal(chunk.closed, 1);
  assert.equal(AudioContextStub.sources.length, 0);
});

test("a departing speaker releases only its own playback", async () => {
  const socket = await connect();
  socket.receive({ type: "memberEnter", id: 7, nickname: "Leaving" });
  socket.receive({ type: "memberEnter", id: 8, nickname: "Staying" });
  receiveAudio(socket, 7);
  receiveAudio(socket, 8);
  const [leaving, staying] = AudioDecoderStub.instances;
  leaving.callbacks.output(decodedChunk());
  staying.callbacks.output(decodedChunk());
  const [oldSource, currentSource] = AudioContextStub.sources;
  socket.receive({ type: "memberLeave", id: 7 });
  assert.deepEqual(voice.members.map(member => member.id), [8]);
  assert.equal(leaving.closed, 1);
  assert.equal(oldSource.stopped, 1);
  assert.equal(staying.closed, 0);
  assert.equal(currentSource.stopped, 0);
});

test("remote playback preserves member volume through output mute and decoder reset", async () => {
  const socket = await connect();
  voice.setVolume(7, 0.4);
  voice.setOutputVolume(0.5);
  receiveAudio(socket, 7);
  receiveAudio(socket, 8);
  assert.deepEqual(AudioContextStub.gains.map(node => node.gain.value), [0.2, 0.5]);
  voice.toggleOutputMute();
  assert.deepEqual(AudioContextStub.gains.map(node => node.gain.value), [0, 0]);
  const old = AudioDecoderStub.instances[0];
  old.decodeQueueSize = 3;
  receiveAudio(socket, 7);
  const replacement = AudioDecoderStub.instances.at(-1);
  old.callbacks.error(new Error("stale decoder error"));
  assert.equal(replacement.closed, 0);
  assert.equal(AudioContextStub.gains.at(-1).gain.value, 0);
  voice.toggleOutputMute();
  assert.equal(AudioContextStub.gains.at(-1).gain.value, 0.2);
  assert.equal(AudioContextStub.gains[1].gain.value, 0.5);
});

test("decoded audio stays within the 80 ms playback window and recovers after overflow", async () => {
  const socket = await connect();
  receiveAudio(socket);
  const decoder = AudioDecoderStub.instances[0];
  const chunks = Array.from({ length: 5 }, decodedChunk);
  for (const chunk of chunks) decoder.callbacks.output(chunk);
  assert.deepEqual(AudioContextStub.sources.map(source => source.startedAt), [0, 0.02, 0.04, 0.06]);
  assert.equal(decoder.closed, 1);
  assert.ok(AudioContextStub.sources.every(source => source.stopped === 1));
  assert.ok(chunks.every(chunk => chunk.closed === 1));
  receiveAudio(socket);
  const replacement = AudioDecoderStub.instances.at(-1);
  replacement.callbacks.output(decodedChunk());
  assert.notEqual(replacement, decoder);
  assert.equal(AudioContextStub.sources.at(-1).startedAt, 0);
});

test("old socket audio cannot create a decoder in a replacement session", async () => {
  const old = await connect();
  const current = await connect();
  receiveAudio(old);
  assert.equal(AudioDecoderStub.instances.length, 0);
  receiveAudio(current);
  assert.equal(AudioDecoderStub.instances.length, 1);
});

test("disconnect stops a microphone test and discards its late recording", async () => {
  await voice.startMicrophoneTest();
  const recorder = RecorderStub.instances.at(-1);
  voice.disconnect();
  assert.equal(recorder.stops, 1);
  assert.equal(voice.microphoneTestActive.value, false);
  recorder.finish();
  assert.equal(voice.testAudioUrl.value, "");
});

test("a replacement microphone test stops the old recorder and ignores its late result", async t => {
  const created = [];
  t.mock.method(URL, "createObjectURL", blob => { created.push(blob); return `blob:test-${created.length}`; });
  t.mock.method(URL, "revokeObjectURL", () => {});
  await voice.startMicrophoneTest();
  const old = RecorderStub.instances.at(-1);
  await voice.startMicrophoneTest();
  const current = RecorderStub.instances.at(-1);
  assert.equal(old.stops, 1);
  current.finish();
  const currentUrl = voice.testAudioUrl.value;
  old.finish();
  assert.equal(voice.testAudioUrl.value, currentUrl);
  assert.equal(created.length, 1);
});

test("an old microphone test permission failure cannot stop a new recording", async () => {
  const oldPermission = deferred();
  let requests = 0;
  navigator.mediaDevices.getUserMedia = () => ++requests === 1 ? oldPermission.promise : Promise.resolve(microphoneStream());
  const old = voice.startMicrophoneTest().catch(() => {});
  voice.stopMicrophoneTest();
  await voice.startMicrophoneTest();
  oldPermission.reject(new Error("Old permission failed"));
  await old;
  assert.equal(voice.microphoneTestActive.value, true);
  assert.equal(RecorderStub.instances.at(-1).state, "recording");
});

test("stopping a microphone test while devices refresh prevents recorder creation", async () => {
  const socket = await connect();
  socket.receive({ type: "connected", tsClientId: 1 });
  await nextTurn();
  const refresh = deferred();
  navigator.mediaDevices.enumerateDevices = () => refresh.promise;
  const pending = voice.startMicrophoneTest();
  voice.stopMicrophoneTest();
  refresh.resolve([]);
  await pending;
  assert.equal(RecorderStub.instances.length, 0);
  assert.equal(voice.microphoneTestActive.value, false);
});

test("a naturally finished microphone recording clears active state and standalone capture", async t => {
  const revoked = [];
  t.mock.method(URL, "createObjectURL", () => "blob:finished");
  t.mock.method(URL, "revokeObjectURL", url => revoked.push(url));
  await voice.startMicrophoneTest();
  const recorder = RecorderStub.instances.at(-1);
  recorder.finish();
  assert.equal(voice.microphoneTestActive.value, false);
  assert.equal(recorder.stream.track.readyState, "ended");
  assert.equal(voice.testAudioUrl.value, "blob:finished");
  voice.disconnect();
  assert.deepEqual(revoked, ["blob:finished"]);
  assert.equal(voice.testAudioUrl.value, "");
});

test("recorder startup failure releases standalone microphone capture", async () => {
  RecorderStub.failStart = true;
  await assert.rejects(voice.startMicrophoneTest(), /Recorder start failed/);
  assert.equal(voice.microphoneTestActive.value, false);
  assert.equal(RecorderStub.instances.at(-1).stream.track.readyState, "ended");
});

test("stopping a connected microphone test publishes its recording without stopping room capture", async t => {
  t.mock.method(URL, "createObjectURL", () => "blob:connected");
  t.mock.method(URL, "revokeObjectURL", () => {});
  const socket = await connect();
  socket.receive({ type: "connected", tsClientId: 1 });
  await nextTurn();
  await voice.startMicrophoneTest();
  const recorder = RecorderStub.instances.at(-1);
  voice.stopMicrophoneTest();
  recorder.finish();
  assert.equal(voice.testAudioUrl.value, "blob:connected");
  assert.equal(recorder.stream.track.readyState, "live");
  assert.equal(voice.state.connected, true);
});

test("the microphone test deadline stops recording and is removed on completion", async t => {
  let deadline;
  const cleared = [];
  t.mock.method(window, "setTimeout", (callback, delay) => { assert.equal(delay, 5_000); deadline = callback; return 123; });
  t.mock.method(window, "clearTimeout", timer => cleared.push(timer));
  await voice.startMicrophoneTest();
  const recorder = RecorderStub.instances.at(-1);
  deadline();
  assert.equal(recorder.stops, 1);
  assert.equal(voice.microphoneTestActive.value, false);
  assert.deepEqual(cleared, [123]);
});

test("an asynchronous recorder failure stops capture and reports a microphone error", async () => {
  await voice.startMicrophoneTest();
  const recorder = RecorderStub.instances.at(-1);
  recorder.onerror({ error: new Error("Recorder failed") });
  assert.equal(recorder.stops, 1);
  assert.equal(recorder.stream.track.readyState, "ended");
  assert.equal(voice.microphoneTestActive.value, false);
  assert.notEqual(voice.state.microphoneErrorCode, "");
  recorder.finish();
  assert.equal(voice.testAudioUrl.value, "");
});

const availableDevices = [
  ...["mic-a", "mic-b"].map(deviceId => ({ deviceId, kind: "audioinput", label: deviceId, groupId: "" })),
  ...["speaker-a", "speaker-b"].map(deviceId => ({ deviceId, kind: "audiooutput", label: deviceId, groupId: "" })),
];

test("an old input switch failure cannot roll back a newer microphone selection", async () => {
  navigator.mediaDevices.enumerateDevices = async () => availableDevices;
  await voice.ensureMicrophone();
  const permission = deferred();
  const current = microphoneStream();
  navigator.mediaDevices.getUserMedia = ({ audio }) => audio.deviceId.exact === "mic-a" ? permission.promise : Promise.resolve(current);
  const old = voice.setInputDevice("mic-a").catch(() => {});
  await voice.setInputDevice("mic-b");
  permission.reject(new Error("Old microphone unavailable"));
  await old;
  assert.equal(voice.selectedInputDeviceId.value, "mic-b");
  assert.equal(localStorage.getItem("webspeak:input-device"), "mic-b");
  assert.equal(current.track.readyState, "live");
});

test("a failed microphone switch leaves an existing WebRTC peer and capture alive", async () => {
  navigator.mediaDevices.enumerateDevices = async () => availableDevices;
  const stream = microphoneStream();
  navigator.mediaDevices.getUserMedia = async () => stream;
  const { peer, socket } = await connectWebRtc();
  navigator.mediaDevices.getUserMedia = async () => { throw new Error("New device unavailable"); };
  await assert.rejects(voice.setInputDevice("mic-a"), /New device unavailable/);
  assert.notEqual(peer.connectionState, "closed");
  receiveAudio(socket);
  assert.equal(AudioDecoderStub.instances.length, 0, "WebRTC still owns playback");
  assert.equal(stream.track.readyState, "live");
  assert.equal(voice.selectedInputDeviceId.value, "");
});

test("an old output switch rejection cannot roll back the latest selection", async t => {
  navigator.mediaDevices.enumerateDevices = async () => availableDevices;
  await voice.ensureMicrophone();
  const ctx = AudioContextStub.instances.at(-1);
  const oldSink = deferred();
  t.mock.method(ctx, "setSinkId", id => id === "speaker-a" ? oldSink.promise : Promise.resolve());
  const old = voice.setOutputDevice("speaker-a").catch(() => {});
  await nextTurn();
  const current = voice.setOutputDevice("speaker-b");
  oldSink.reject(new Error("Old output unavailable"));
  await Promise.all([old, current]);
  assert.equal(voice.selectedOutputDeviceId.value, "speaker-b");
  assert.equal(localStorage.getItem("webspeak:output-device"), "speaker-b");
});

test("overlapping output switches leave the actual sink on the latest device", async t => {
  navigator.mediaDevices.enumerateDevices = async () => availableDevices;
  await voice.ensureMicrophone();
  const ctx = AudioContextStub.instances.at(-1);
  const oldSink = deferred();
  t.mock.method(ctx, "setSinkId", async id => { if (id === "speaker-a") await oldSink.promise; ctx.sinkId = id; });
  const old = voice.setOutputDevice("speaker-a");
  await nextTurn();
  const current = voice.setOutputDevice("speaker-b");
  oldSink.resolve();
  await Promise.all([old, current]);
  assert.equal(ctx.sinkId, "speaker-b");
  assert.equal(voice.selectedOutputDeviceId.value, "speaker-b");
});

test("an older device enumeration cannot replace a newer device list", async () => {
  const oldDevices = deferred();
  let calls = 0;
  navigator.mediaDevices.enumerateDevices = () => ++calls === 1 ? oldDevices.promise : Promise.resolve(availableDevices);
  const old = voice.refreshAudioDevices();
  await voice.refreshAudioDevices();
  oldDevices.resolve([]);
  await old;
  assert.deepEqual(voice.inputDevices.map(device => device.deviceId), ["mic-a", "mic-b"]);
});

test("device enumeration rejected after disconnect cannot restore an audio notice", async () => {
  const devices = deferred();
  navigator.mediaDevices.enumerateDevices = () => devices.promise;
  const pending = voice.refreshAudioDevices();
  voice.disconnect();
  devices.reject(new Error("Old device query rejected"));
  await pending;
  assert.equal(voice.state.audioNoticeCode, "");
});

test("a successful microphone switch replaces the WebRTC peer and persists the new device", async () => {
  navigator.mediaDevices.enumerateDevices = async () => availableDevices;
  const initial = microphoneStream();
  navigator.mediaDevices.getUserMedia = async () => initial;
  const { peer: old, socket } = await connectWebRtc();
  const replacement = microphoneStream();
  navigator.mediaDevices.getUserMedia = async () => replacement;
  await voice.setInputDevice("mic-b");
  assert.equal(old.connectionState, "closed");
  assert.notEqual(TestPeer.instances.at(-1), old);
  assert.equal(initial.track.readyState, "ended");
  assert.equal(replacement.track.readyState, "live");
  assert.equal(socket.messages.filter(message => message.type === "webrtcOffer").length, 2);
  assert.equal(localStorage.getItem("webspeak:input-device"), "mic-b");
});

test("a failed replacement input restores the last working device instead of another pending choice", async () => {
  navigator.mediaDevices.enumerateDevices = async () => availableDevices;
  await voice.ensureMicrophone();
  const permission = deferred();
  navigator.mediaDevices.getUserMedia = ({ audio }) => audio.deviceId.exact === "mic-a"
    ? permission.promise : Promise.reject(new Error("Replacement failed"));
  const old = voice.setInputDevice("mic-a");
  await assert.rejects(voice.setInputDevice("mic-b"), /Replacement failed/);
  const late = microphoneStream();
  permission.resolve(late);
  await old;
  assert.equal(voice.selectedInputDeviceId.value, "");
  assert.equal(localStorage.getItem("webspeak:input-device"), "");
  assert.equal(late.track.readyState, "ended");
});

test("disconnect skips queued output changes and keeps only the last committed device", async t => {
  navigator.mediaDevices.enumerateDevices = async () => availableDevices;
  await voice.ensureMicrophone();
  const ctx = AudioContextStub.instances.at(-1);
  const oldSink = deferred();
  const applied = [];
  t.mock.method(ctx, "setSinkId", async id => { applied.push(id); await oldSink.promise; });
  const first = voice.setOutputDevice("speaker-a");
  await nextTurn();
  const second = voice.setOutputDevice("speaker-b");
  voice.disconnect();
  oldSink.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(applied, ["speaker-a"]);
  assert.equal(voice.selectedOutputDeviceId.value, "");
  assert.equal(localStorage.getItem("webspeak:output-device"), null);
});

test("failure on the WebRTC output restores the previously committed context sink", async t => {
  navigator.mediaDevices.enumerateDevices = async () => availableDevices;
  const { peer } = await connectWebRtc();
  peer.ontrack({ streams: [microphoneStream()] });
  const output = [...audioElements][0];
  output.setSinkId = async id => { if (id === "speaker-a") throw new Error("Output denied"); output.sinkId = id; };
  const ctx = AudioContextStub.instances.at(-1);
  await assert.rejects(voice.setOutputDevice("speaker-a"), /Output denied/);
  assert.equal(ctx.sinkId, "default");
  assert.equal(output.sinkId, "default");
  assert.equal(voice.selectedOutputDeviceId.value, "");
});

test("a failed noise suppression change restores its setting and preserves WebRTC capture", async () => {
  navigator.mediaDevices.enumerateDevices = async () => availableDevices;
  const initial = microphoneStream();
  navigator.mediaDevices.getUserMedia = async () => initial;
  const { peer } = await connectWebRtc();
  navigator.mediaDevices.getUserMedia = async () => { throw new Error("Capture reconfiguration failed"); };
  await voice.setNoiseSuppressionEnabled(false);
  assert.notEqual(peer.connectionState, "closed");
  assert.equal(voice.noiseSuppressionEnabled.value, true);
  assert.equal(initial.track.readyState, "live");
  assert.notEqual(voice.state.microphoneErrorCode, "");
});

test("changing processing during an input switch commits the device actually acquired", async () => {
  navigator.mediaDevices.enumerateDevices = async () => availableDevices;
  await voice.ensureMicrophone();
  const permission = deferred();
  let calls = 0;
  navigator.mediaDevices.getUserMedia = () => ++calls === 1 ? permission.promise : Promise.resolve(microphoneStream());
  const input = voice.setInputDevice("mic-a");
  await voice.setNoiseSuppressionEnabled(false);
  const late = microphoneStream();
  permission.resolve(late);
  await input;
  assert.equal(localStorage.getItem("webspeak:input-device"), "mic-a");
  assert.equal(late.track.readyState, "ended");
  voice.disconnect();
  assert.equal(voice.selectedInputDeviceId.value, "mic-a");
});

test("closing audio settings releases standalone capture even without a recording test", async () => {
  const stream = microphoneStream();
  navigator.mediaDevices.getUserMedia = async () => stream;
  await voice.prepareInputDevices();
  voice.stopMicrophoneTest();
  assert.equal(stream.track.readyState, "ended");
});

test("compatibility capture keeps sending while a replacement permission is pending or fails", async () => {
  navigator.mediaDevices.enumerateDevices = async () => availableDevices;
  const socket = await connect();
  socket.receive({ type: "connected", tsClientId: 1 });
  await nextTurn();
  const capture = AudioContextStub.processors.at(-1);
  const permission = deferred();
  navigator.mediaDevices.getUserMedia = () => permission.promise;
  const pending = voice.setInputDevice("mic-a");
  const rejected = assert.rejects(pending, /Device denied/);
  const samples = new Float32Array(960).fill(0.25);
  capture.onaudioprocess({ inputBuffer: { getChannelData: () => samples } });
  const beforeFailure = socket.messages.filter(message => message instanceof ArrayBuffer).length;
  permission.reject(new Error("Device denied"));
  await rejected;
  capture.onaudioprocess({ inputBuffer: { getChannelData: () => samples } });
  assert.equal(beforeFailure, 1);
  assert.equal(socket.messages.filter(message => message instanceof ArrayBuffer).length, 2);
});

test("replacing compatibility capture prevents the old graph from sending into the new session", async () => {
  navigator.mediaDevices.enumerateDevices = async () => availableDevices;
  const socket = await connect();
  socket.receive({ type: "connected", tsClientId: 1 });
  await nextTurn();
  const old = AudioContextStub.processors.at(-1);
  await voice.setInputDevice("mic-b");
  const current = AudioContextStub.processors.at(-1);
  const event = { inputBuffer: { getChannelData: () => new Float32Array(960).fill(0.25) } };
  old.onaudioprocess(event);
  current.onaudioprocess(event);
  assert.equal(socket.messages.filter(message => message instanceof ArrayBuffer).length, 1);
  voice.disconnect();
  current.onaudioprocess(event);
  assert.equal(socket.messages.filter(message => message instanceof ArrayBuffer).length, 1);
});

test("a failed replacement processing graph preserves the live microphone and PCM path", async t => {
  navigator.mediaDevices.enumerateDevices = async () => availableDevices;
  const initial = microphoneStream();
  navigator.mediaDevices.getUserMedia = async () => initial;
  const socket = await connect();
  socket.receive({ type: "connected", tsClientId: 1 });
  await nextTurn();
  const capture = AudioContextStub.processors.at(-1);
  const replacement = microphoneStream();
  navigator.mediaDevices.getUserMedia = async () => replacement;
  const ctx = AudioContextStub.instances.at(-1);
  const processing = { ...voice.microphoneProcessing };
  t.mock.method(ctx, "createGain", () => { throw new Error("Gain allocation failed"); });
  await assert.rejects(voice.setInputDevice("mic-b"), /Gain allocation failed/);
  assert.equal(initial.track.readyState, "live");
  assert.equal(replacement.track.readyState, "ended");
  capture.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(960).fill(0.25) } });
  assert.equal(socket.messages.filter(message => message instanceof ArrayBuffer).length, 1);
  assert.deepEqual({ ...voice.microphoneProcessing }, processing);
  assert.equal(voice.selectedInputDeviceId.value, "");
  assert.notEqual(voice.state.microphoneErrorCode, "");
});

test("waiting for a replacement worklet keeps the current graph sending", async t => {
  navigator.mediaDevices.enumerateDevices = async () => availableDevices;
  const socket = await connect();
  socket.receive({ type: "connected", tsClientId: 1 });
  await nextTurn();
  const capture = AudioContextStub.processors.at(-1);
  const module = deferred();
  AudioContextStub.instances.at(-1).audioWorklet = { addModule: url => url === "/mic-capture-worklet.js" ? module.promise : Promise.resolve() };
  // A missing worklet constructor must still permit the ScriptProcessor fallback.
  replaceGlobal("AudioWorkletNode", class { constructor() { throw new Error("Worklet unavailable"); } });
  t.after(() => module.resolve());
  const pending = voice.setInputDevice("mic-a");
  await nextTurn();
  capture.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(960).fill(0.25) } });
  const framesWhilePreparing = socket.messages.filter(message => message instanceof ArrayBuffer).length;
  module.resolve();
  await pending;
  assert.equal(framesWhilePreparing, 1);
  AudioContextStub.processors.at(-1).onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(960).fill(0.25) } });
  assert.equal(socket.messages.filter(message => message instanceof ArrayBuffer).length, 2);
});

test("disconnect during worklet preparation releases every candidate node and track", async t => {
  navigator.mediaDevices.enumerateDevices = async () => availableDevices;
  await voice.ensureMicrophone();
  const module = deferred();
  const ctx = AudioContextStub.instances.at(-1);
  ctx.audioWorklet = { addModule: url => url === "/mic-capture-worklet.js" ? module.promise : Promise.resolve() };
  const source = new AudioNodeStub();
  const destination = Object.assign(new AudioNodeStub(), { stream: microphoneStream() });
  t.mock.method(ctx, "createMediaStreamSource", () => source);
  t.mock.method(ctx, "createMediaStreamDestination", () => destination);
  const stream = microphoneStream();
  navigator.mediaDevices.getUserMedia = async () => stream;
  const pending = voice.setInputDevice("mic-a");
  t.after(() => module.resolve());
  await nextTurn();
  voice.disconnect();
  assert.equal(stream.track.readyState, "ended");
  assert.equal(destination.stream.track.readyState, "ended");
  assert.ok(source.disconnects > 0);
  module.resolve();
  await pending;
  assert.equal(voice.ws.value, null);
});

test("a failed first capture graph reports an error and releases its stream", async t => {
  const stream = microphoneStream();
  navigator.mediaDevices.getUserMedia = async () => stream;
  t.mock.method(AudioContextStub.prototype, "createScriptProcessor", () => { throw new Error("Capture node unavailable"); });
  await assert.rejects(voice.ensureMicrophone(), /Capture node unavailable/);
  assert.equal(stream.track.readyState, "ended");
  assert.notEqual(voice.state.microphoneErrorCode, "");
});

test("removing the selected microphone restarts WebRTC with the default input", async () => {
  navigator.mediaDevices.enumerateDevices = async () => availableDevices;
  await voice.setInputDevice("mic-a");
  const { peer, socket } = await connectWebRtc();
  navigator.mediaDevices.enumerateDevices = async () => availableDevices.filter(device => device.deviceId !== "mic-a");
  const replacement = microphoneStream();
  navigator.mediaDevices.getUserMedia = async () => replacement;
  await voice.refreshAudioDevices();
  await nextTurn();
  assert.equal(peer.connectionState, "closed");
  assert.equal(socket.messages.filter(message => message.type === "webrtcOffer").length, 2);
  assert.equal(voice.selectedInputDeviceId.value, "");
  assert.equal(localStorage.getItem("webspeak:input-device"), "");
  assert.equal(replacement.track.readyState, "live");
});

test("a failed default input fallback does not overwrite the last successful preference", async () => {
  navigator.mediaDevices.enumerateDevices = async () => availableDevices;
  await voice.setInputDevice("mic-a");
  await voice.ensureMicrophone();
  navigator.mediaDevices.enumerateDevices = async () => availableDevices.filter(device => device.deviceId !== "mic-a");
  navigator.mediaDevices.getUserMedia = async () => { throw new Error("Default microphone unavailable"); };
  await voice.refreshAudioDevices();
  await nextTurn();
  assert.equal(voice.selectedInputDeviceId.value, "mic-a");
  assert.equal(localStorage.getItem("webspeak:input-device"), "mic-a");
  assert.notEqual(voice.state.microphoneErrorCode, "");
});

test("a rejected default output fallback preserves the last preference and reports the failure", async t => {
  navigator.mediaDevices.enumerateDevices = async () => availableDevices;
  await voice.prepareInputDevices();
  await voice.setOutputDevice("speaker-a");
  navigator.mediaDevices.enumerateDevices = async () => availableDevices.filter(device => device.deviceId !== "speaker-a");
  const ctx = AudioContextStub.instances.at(-1);
  t.mock.method(ctx, "setSinkId", async id => { if (id === "default") throw new Error("Default output unavailable"); ctx.sinkId = id; });
  await voice.refreshAudioDevices();
  await nextTurn();
  assert.equal(voice.selectedOutputDeviceId.value, "speaker-a");
  assert.equal(localStorage.getItem("webspeak:output-device"), "speaker-a");
  assert.equal(voice.state.audioNoticeCode, "OUTPUT_DEVICE_UNAVAILABLE");
});

test("an AudioWorklet capture sends PCM and ignores late port messages after teardown", async () => {
  navigator.mediaDevices.enumerateDevices = async () => availableDevices;
  const socket = await connect();
  socket.receive({ type: "connected", tsClientId: 1 });
  await nextTurn();
  const worklets = [];
  replaceGlobal("AudioWorkletNode", class extends AudioNodeStub {
    port = { onmessage: null, closed: false, close() { this.closed = true; } };
    constructor() { super(); worklets.push(this); }
  });
  AudioContextStub.instances.at(-1).audioWorklet = { addModule: async () => {} };
  await voice.setInputDevice("mic-b");
  const capture = worklets.at(-1);
  const onmessage = capture.port.onmessage;
  onmessage({ data: { samples: new Float32Array(960).fill(0.25) } });
  assert.equal(socket.messages.filter(message => message instanceof ArrayBuffer).length, 1);
  voice.disconnect();
  assert.equal(capture.port.closed, true);
  assert.ok(capture.disconnects > 0);
  onmessage({ data: { samples: new Float32Array(960).fill(0.25) } });
  assert.equal(socket.messages.filter(message => message instanceof ArrayBuffer).length, 1);
});

test("a failed newer switch restores the device whose graph is already live during enumeration", async () => {
  navigator.mediaDevices.enumerateDevices = async () => availableDevices;
  await voice.ensureMicrophone();
  const enumeration = deferred();
  let reads = 0;
  navigator.mediaDevices.enumerateDevices = () => ++reads === 1 ? enumeration.promise : Promise.resolve(availableDevices);
  const replacement = microphoneStream();
  navigator.mediaDevices.getUserMedia = ({ audio }) => audio.deviceId.exact === "mic-a"
    ? Promise.resolve(replacement) : Promise.reject(new Error("Newer input failed"));
  const first = voice.setInputDevice("mic-a");
  await nextTurn();
  await assert.rejects(voice.setInputDevice("mic-b"), /Newer input failed/);
  enumeration.resolve(availableDevices);
  await first;
  assert.equal(replacement.track.readyState, "live");
  assert.equal(voice.selectedInputDeviceId.value, "mic-a");
  assert.equal(localStorage.getItem("webspeak:input-device"), "mic-a");
});

test("disconnect while initial device labels load still cancels microphone readiness", async () => {
  const enumeration = deferred();
  navigator.mediaDevices.enumerateDevices = () => enumeration.promise;
  const readiness = voice.ensureMicrophone();
  await nextTurn();
  voice.disconnect();
  enumeration.resolve(availableDevices);
  await assert.rejects(readiness, error => error.name === "AbortError");
  assert.equal(voice.state.microphoneErrorCode, "");
});
