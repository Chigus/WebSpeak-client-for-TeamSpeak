import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import { WebSocket, type WebSocketServer } from "ws";
import pino from "pino";
import { VoiceBridge } from "./voice-bridge.js";
import { JoinTicketStore } from "./join-ticket.js";
import { OpusEncoder } from "./opus-codec.js";
import type { TSClient } from "./ts-client.js";
import type { AudioFlowStats } from "./audio-stats.js";
import type { WebRtcAudioSession } from "./webrtc-audio.js";

// Real loopback HTTP/WebSocket and native codec, with only the external SDK
// replaced. This validates gateway wiring, not a connection to TeamSpeak.
class TeamSpeakStub extends EventEmitter {
  disconnected = false;
  sent: Buffer[] = [];
  async connect() { this.emit("directorySnapshot", { channels: [], clients: [] }); }
  async disconnect() { this.disconnected = true; }
  getClientId() { return 1; }
  getChannelId() { return 1n; }
  isConnected() { return !this.disconnected; }
  async sendProtocolCommand() {}
  sendVoice(data: Buffer) { this.sent.push(data); this.emit("sent", data); }
  sendWhisper(data: Buffer) { this.sent.push(data); }
}

async function fixture(t: TestContext, overrides: {
  createTeamSpeakClient?: () => TSClient;
  createEncoder?: () => Pick<OpusEncoder, "encode" | "dispose">;
} = {}) {
  const sdk = new TeamSpeakStub();
  const tickets = new JoinTicketStore();
  const bridge = new VoiceBridge({ joinTickets: tickets }, pino({ enabled: false }), undefined, {
    createTeamSpeakClient: overrides.createTeamSpeakClient ?? (() => sdk as unknown as TSClient),
    ...(overrides.createEncoder ? { createEncoder: overrides.createEncoder } : {}),
  });
  const server = createServer();
  bridge.attach(server);
  const wss = (bridge as unknown as { wss: WebSocketServer }).wss;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const ticket = tickets.create({ target: { host: "voice.example.invalid", port: 9987 }, nickname: "Test", serverPassword: "" });
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/voice?ticket=${ticket}`);
  const messages: Array<{ data: Buffer; binary: boolean }> = [];
  socket.on("message", (data, binary) => messages.push({ data: data as Buffer, binary }));
  const first = once(socket, "message");
  t.after(async () => {
    socket.terminate();
    // Clean fixtures even when a regression removes the WebSocketServer's own
    // close listener. The membership assertion below tests that behavior first.
    for (const peer of wss.clients) peer.terminate();
    wss.clients.clear();
    await bridge.shutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await first;
  const entries = (bridge as unknown as { entries: Map<string, { id: string; ws: WebSocket; audio: AudioFlowStats; webrtc: WebRtcAudioSession | null }> }).entries;
  return { bridge, sdk, socket, messages, entries, wss };
}

test("a TeamSpeak constructor failure releases the admitted gateway slot", { timeout: 5_000 }, async t => {
  const f = await fixture(t, { createTeamSpeakClient() { throw new Error("Identity initialization failed"); } });
  if (f.socket.readyState !== WebSocket.CLOSED) await once(f.socket, "close");
  await nextTurn();
  assert.equal(JSON.parse(f.messages[0]!.data.toString()).code, "TEAM_SPEAK_CLIENT_UNAVAILABLE");
  assert.equal(f.bridge.getActiveCount(), 0);
});

test("a codec disposal failure cannot abandon TeamSpeak or the browser socket", { timeout: 5_000 }, async t => {
  const encoder = new OpusEncoder(48000, 1);
  t.mock.method(encoder, "dispose", () => { throw new Error("Codec already disposed"); });
  const f = await fixture(t, { createEncoder: () => encoder });
  const entry = [...f.entries.values()][0]!;
  await f.bridge.terminateSession(entry.id);
  assert.equal(f.sdk.disconnected, true);
  assert.notEqual(entry.ws.readyState, WebSocket.OPEN);
  assert.equal(f.bridge.getActiveCount(), 0);
});

test("late SDK audio during peer closure cannot write after the session is removed", { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const entry = [...f.entries.values()][0]!;
  const onVoice = f.sdk.listeners("voiceData")[0]!;
  let release!: () => void;
  const closing = new Promise<void>(resolve => { release = resolve; });
  entry.webrtc = { close: () => closing, getStats: () => ({}) } as unknown as WebRtcAudioSession;
  const writes: unknown[] = [];
  t.mock.method(entry.ws, "send", (data: unknown) => { writes.push(data); });
  const stopped = f.bridge.terminateSession(entry.id);
  try {
    onVoice({ clientId: 2, codec: 4, data: Buffer.from([1, 2, 3]) });
    assert.equal(writes.length, 0);
    assert.equal(entry.audio.tsReceiveFrames, 0);
  } finally {
    release();
    await stopped;
  }
});

test("normal session teardown retains the WebSocketServer close bookkeeping", { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const entry = [...f.entries.values()][0]!;
  const closed = once(entry.ws, "close");
  await f.bridge.terminateSession(entry.id);
  // Do not await our close listener: a broken removeAllListeners erases it too.
  await once(f.socket, "close");
  await nextTurn();
  assert.equal(f.wss.clients.size, 0);
  await closed;
});

test("loopback PCM reaches the SDK as native Opus and malformed PCM is rejected", { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const sent = once(f.sdk, "sent");
  f.socket.send(Buffer.alloc(1_920));
  await sent;
  const encoded = f.sdk.sent[0]!;
  assert.ok(encoded.length > 0 && encoded.length < 1_920, "must encode Opus, not pass through PCM");
  const decoder = new OpusEncoder(48_000, 1);
  try { assert.equal(decoder.decode(encoded).length, 1_920); }
  finally { decoder.dispose(); }
  const error = once(f.socket, "message");
  f.socket.send(Buffer.alloc(1_919));
  const [raw] = await error;
  assert.equal(JSON.parse(raw.toString()).error.code, "INVALID_AUDIO_FRAME");
  assert.equal(f.sdk.sent.length, 1);
});

test("failed final peer statistics do not interrupt session cleanup", { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const entry = [...f.entries.values()][0]!;
  entry.webrtc = { close: async () => {}, getStats() { throw new Error("Closed peer"); } } as unknown as WebRtcAudioSession;
  await f.bridge.terminateSession(entry.id);
  assert.equal(f.sdk.disconnected, true);
  assert.notEqual(entry.ws.readyState, WebSocket.OPEN);
  assert.equal(f.bridge.getActiveCount(), 0);
});
