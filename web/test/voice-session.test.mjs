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
}

class AudioNodeStub {
  gain = { value: 1 };
  connect() {}
  disconnect() {}
}
class AudioContextStub extends EventTarget {
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
  createScriptProcessor() { return new AudioNodeStub(); }
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
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
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

afterEach(() => { voice?.disconnect(); });
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
