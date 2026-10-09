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
import { MusicService } from "./music-service.js";
import { normalizeTeamSpeakKickedReason } from "../errors.js";
import type { TSClient, TSClientAvatar, TSDirectorySnapshot } from "./ts-client.js";
import type { AudioFlowStats } from "./audio-stats.js";
import type { WebRtcAudioSession } from "./webrtc-audio.js";

// Real loopback HTTP/WebSocket and native codec, with only the external SDK
// replaced. This validates gateway wiring, not a connection to TeamSpeak.
class TeamSpeakStub extends EventEmitter {
  disconnected = false;
  sent: Buffer[] = [];
  sentCodecs: number[] = [];
  directory: TSDirectorySnapshot = { channels: [], clients: [] };
  avatarRequest: (id: number, uid: string) => Promise<TSClientAvatar | null> = async () => null;
  async connect() { this.disconnected = false; this.emit("directorySnapshot", this.directory); }
  async disconnect() { this.disconnected = true; }
  getClientId() { return 1; }
  getIdentityString() { return "page-local-test-identity"; }
  getChannelId() { return 1n; }
  isConnected() { return !this.disconnected; }
  async sendProtocolCommand() {}
  async setAccompanimentActive() {}
  sendVoice(data: Buffer, codec = 4) { this.sent.push(data); this.sentCodecs.push(codec); this.emit("sent", data); }
  sendWhisper(data: Buffer, _clientIds: number[], codec = 4) { this.sent.push(data); this.sentCodecs.push(codec); }
  getClientAvatar(id: number, uid: string) { return this.avatarRequest(id, uid); }
}

async function fixture(t: TestContext, overrides: {
  musicService?: MusicService;
  createTeamSpeakClient?: () => TSClient;
  createEncoder?: () => Pick<OpusEncoder, "encode" | "dispose">;
  createStereoEncoder?: () => Pick<OpusEncoder, "encode" | "dispose">;
  configureSdk?: (sdk: TeamSpeakStub) => void;
} = {}) {
  const sdk = new TeamSpeakStub();
  overrides.configureSdk?.(sdk);
  const tickets = new JoinTicketStore();
  const bridge = new VoiceBridge({ joinTickets: tickets }, pino({ enabled: false }), undefined, {
    createTeamSpeakClient: overrides.createTeamSpeakClient ?? (() => sdk as unknown as TSClient),
    ...(overrides.musicService ? { musicService: overrides.musicService } : {}),
    ...(overrides.createEncoder ? { createEncoder: overrides.createEncoder } : {}),
    ...(overrides.createStereoEncoder ? { createStereoEncoder: overrides.createStereoEncoder } : {}),
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
  const entries = (bridge as unknown as { entries: Map<string, {
    id: string; ws: WebSocket; audio: AudioFlowStats; webrtc: WebRtcAudioSession | null;
    isAlive: boolean; avatarCache: Map<string, string | null>;
    members: Map<number, { id: number; uid: string }>; eventLog: unknown[];
  }> }).entries;
  return { bridge, sdk, socket, messages, entries, wss };
}

test("music RPC uses actual TeamSpeak membership and refuses a forged channel", { timeout: 5_000 }, async t => {
  let upstreamCalls = 0;
  const service = new MusicService({ url:"http://bot.invalid", token:"private", target:"voice.example.invalid:9987", botUid:"music-bot" },
    async () => { upstreamCalls++; return new Response(JSON.stringify({items:[]})); });
  const f = await fixture(t, { musicService:service });
  f.sdk.emit("directorySnapshot", { channels:[{id:1n,parentID:0n,name:"Room",codec:5,codecQuality:10}],
    clients:[{id:1,uid:"web-user",nickname:"Test",channelID:1n,type:0,serverGroups:[]},{id:9,uid:"music-bot",nickname:"Bot",channelID:1n,type:0,serverGroups:[]}] });
  await nextTurn();
  async function ask(channelId:string,id:string) {
    const answer = new Promise<any>(resolve => {
      function receive(data:Buffer,binary:boolean) {
        if(binary)return;const message=JSON.parse(data.toString());
        if(message.type==="musicResult"&&message.requestId===id){f.socket.off("message",receive);resolve(message);}
      }
      f.socket.on("message",receive);
    });
    f.socket.send(JSON.stringify({type:"musicRequest",requestId:id,channelId,action:"search",payload:{source:"netease",keywords:"song"}}));
    return answer;
  }
  assert.equal((await ask("2","forged")).code,"MUSIC_SESSION_CHANGED");
  assert.equal(upstreamCalls,0);
  assert.equal((await ask("1","allowed")).result.inChannel,true);
  assert.equal(upstreamCalls,1);
  f.sdk.emit("clientLeave",{id:9});
  await nextTurn();
  assert.equal((await ask("1","departed")).code,"MUSIC_OTHER_CHANNEL");
  assert.equal(upstreamCalls,1);
});

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
  assert.deepEqual(f.sdk.sentCodecs, [4]);
});

function stereoToneAmplitude(pcm: Buffer, channel: 0 | 1, frequency: number): number {
  const frames = pcm.length / 4;
  let real = 0;
  let imaginary = 0;
  for (let index = 0; index < frames; index++) {
    const sample = pcm.readInt16LE(index * 4 + channel * 2);
    const phase = 2 * Math.PI * frequency * index / 48_000;
    real += sample * Math.cos(phase);
    imaginary += sample * Math.sin(phase);
  }
  return 2 * Math.hypot(real, imaginary) / frames;
}

function stereoStressFrame(frame: number): Buffer {
  const pcm = Buffer.alloc(3_840);
  let noise = (frame + 1) * 1_234_567;
  const randomSample = () => {
    noise = (Math.imul(noise, 1_664_525) + 1_013_904_223) >>> 0;
    return (noise / 0x1_0000_0000 * 2 - 1) * 24_000;
  };
  for (let sample = 0; sample < 960; sample++) {
    const time = (frame * 960 + sample) / 48_000;
    let left = 10_000 * Math.sin(2 * Math.PI * 600 * time);
    let right = 14_000 * Math.sin(2 * Math.PI * 1_200 * time);
    if (frame >= 10 && frame < 20) left = right = 0;
    else if (frame >= 20 && frame < 30) { left = randomSample(); right = randomSample(); }
    else if (frame >= 30 && frame < 40) right = left;
    else if (frame >= 40 && frame < 50) {
      left = sample % 32 === 0 ? 30_000 : 0;
      right = sample % 47 === 0 ? -30_000 : 0;
    }
    pcm.writeInt16LE(Math.round(left), sample * 4);
    pcm.writeInt16LE(Math.round(right), sample * 4 + 2);
  }
  return pcm;
}

function withOpusRuntime(runtime: "native" | "opusscript", run: () => void): void {
  const previous = process.env.WEBSPEAK_MOBILE;
  if (runtime === "opusscript") process.env.WEBSPEAK_MOBILE = "1";
  else delete process.env.WEBSPEAK_MOBILE;
  try { run(); }
  finally {
    if (previous === undefined) delete process.env.WEBSPEAK_MOBILE;
    else process.env.WEBSPEAK_MOBILE = previous;
  }
}

for (const runtime of ["native", "opusscript"] as const) {
  test(`${runtime} stereo CBR bounds startup and audio transients without collapsing either channel`, () => {
    withOpusRuntime(runtime, () => {
      const fixed = new OpusEncoder(48_000, 2, { bitrate: 192_000, forceChannels: 2, vbr: false });
      const variable = new OpusEncoder(48_000, 2, { bitrate: 192_000, forceChannels: 2, vbr: true });
      const decoder = new OpusEncoder(48_000, 2);
      const variableLengths: number[] = [];
      let separatedFrames = 0;
      try {
        for (let frame = 0; frame < 80; frame++) {
          const pcm = stereoStressFrame(frame);
          variableLengths.push(variable.encode(pcm).length);
          const packet = fixed.encode(pcm);
          assert.equal(packet.length, 480, `${runtime} frame ${frame}: CBR must fit the 484-byte TeamSpeak voice payload budget`);
          assert.equal(packet[0]! & 4, 4, `${runtime} frame ${frame}: even silence/correlated audio must remain stereo`);
          const decoded = decoder.decode(packet);
          assert.equal(decoded.length, 3_840, "20 ms must retain 960 independent samples per channel");
          if ((frame < 3 || frame >= 10) && frame < 55) continue;
          const left600 = stereoToneAmplitude(decoded, 0, 600);
          const left1200 = stereoToneAmplitude(decoded, 0, 1_200);
          const right600 = stereoToneAmplitude(decoded, 1, 600);
          const right1200 = stereoToneAmplitude(decoded, 1, 1_200);
          assert.ok(left600 > 2_000 && right1200 > 2_000, `${runtime} frame ${frame}: both channels must carry audio`);
          assert.ok(left600 > left1200 * 18 && right1200 > right600 * 18,
            `${runtime} frame ${frame}: left/right isolation must exceed 25 dB after codec warmup`);
          separatedFrames++;
        }
        assert.equal(separatedFrames, 32, "Check separated tones before and after the silence/noise/impulse transitions");
        assert.ok(variableLengths.some(bytes => bytes > 484), "The same stress signal must reproduce oversized VBR packets");
      } finally {
        fixed.dispose();
        variable.dispose();
        decoder.dispose();
      }
    });
  });

  test(`${runtime} ordinary mono preserves the default VBR encoder behavior`, () => {
    withOpusRuntime(runtime, () => {
      const unchanged = new OpusEncoder(48_000, 1);
      const explicitVbr = new OpusEncoder(48_000, 1, { vbr: true });
      const decoder = new OpusEncoder(48_000, 1);
      const lengths = new Set<number>();
      try {
        for (let frame = 0; frame < 30; frame++) {
          const stereo = stereoStressFrame(frame);
          const mono = Buffer.alloc(1_920);
          for (let sample = 0; sample < 960; sample++) mono.writeInt16LE(stereo.readInt16LE(sample * 4), sample * 2);
          const packet = unchanged.encode(mono);
          assert.deepEqual(packet, explicitVbr.encode(mono), "Omitting vbr must preserve the codec's default variable-rate output");
          lengths.add(packet.length);
          assert.equal(packet[0]! & 4, 0, "Ordinary voice must remain mono");
          assert.equal(decoder.decode(packet).length, 1_920);
        }
        assert.ok(lengths.size > 1, "Mono voice must keep variable-size output across signal changes");
      } finally {
        unchanged.dispose();
        explicitVbr.dispose();
        decoder.dispose();
      }
    });
  });
}

test("loopback stereo retains separate left and right signals through native Opus music", { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const decoder = new OpusEncoder(48_000, 2);
  t.after(() => decoder.dispose());
  let lastPacket: Buffer = Buffer.alloc(0);
  for (let frame = 0; frame < 16; frame++) {
    const pcm = Buffer.alloc(3_840);
    for (let index = 0; index < 960; index++) {
      const time = (frame * 960 + index) / 48_000;
      const left = Math.round(10_000 * Math.sin(2 * Math.PI * 600 * time));
      // The final frames are correlated, exercising forced stereo as well.
      const right = frame < 12 ? Math.round(14_000 * Math.sin(2 * Math.PI * 1_200 * time)) : left;
      pcm.writeInt16LE(left, index * 4);
      pcm.writeInt16LE(right, index * 4 + 2);
    }
    const sent = once(f.sdk, "sent");
    f.socket.send(pcm);
    await sent;
    lastPacket = f.sdk.sent[frame]!;
    assert.equal(f.sdk.sentCodecs[frame], 5, "stereo must be marked as TeamSpeak Opus Music");
    assert.equal(lastPacket.length, 480, "The production bridge must use 192 kbps CBR from the very first stereo frame");
    assert.equal(lastPacket[0]! & 4, 4, "Opus TOC must retain its stereo flag");
    const decoded = decoder.decode(lastPacket);
    assert.equal(decoded.length, 3_840, "20 ms must contain 960 samples per channel");
    if (frame < 3 || frame >= 12) continue; // Skip codec startup delay and the correlated tail.
    const left600 = stereoToneAmplitude(decoded, 0, 600);
    const left1200 = stereoToneAmplitude(decoded, 0, 1_200);
    const right600 = stereoToneAmplitude(decoded, 1, 600);
    const right1200 = stereoToneAmplitude(decoded, 1, 1_200);
    assert.ok(left600 > 2_000 && right1200 > 2_000, `frame ${frame}: both channels must stay audible`);
    assert.ok(left600 > left1200 * 8, `frame ${frame}: right signal leaked into the left channel`);
    assert.ok(right1200 > right600 * 8, `frame ${frame}: left signal leaked into the right channel`);
  }
  const received = once(f.socket, "message");
  f.sdk.emit("voiceData", { clientId: 2, codec: 5, data: lastPacket });
  const [packet, binary] = await received;
  assert.equal(binary, true);
  assert.deepEqual(packet, Buffer.concat([Buffer.from([5, 0, 2]), lastPacket]));
});

test("a stereo codec remains lazy and is released with its session", { timeout: 5_000 }, async t => {
  let created = 0;
  let disposed = 0;
  const f = await fixture(t, { createStereoEncoder() {
    created++;
    return { encode: () => Buffer.from([4, 0, 0]), dispose() { disposed++; } };
  } });
  const monoSent = once(f.sdk, "sent");
  f.socket.send(Buffer.alloc(1_920));
  await monoSent;
  assert.equal(created, 0);
  const stereoSent = once(f.sdk, "sent");
  f.socket.send(Buffer.alloc(3_840));
  await stereoSent;
  assert.equal(created, 1);
  const entry = [...f.entries.values()][0]!;
  await f.bridge.terminateSession(entry.id);
  assert.equal(disposed, 1);
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

async function avatarFixture(t: TestContext) {
  const calls: number[] = [];
  const avatar = { cacheKey: "sample", data: Buffer.from("GIF89a") };
  let release!: (value: TSClientAvatar) => void;
  let started!: () => void;
  const pending = new Promise<TSClientAvatar>(resolve => { release = resolve; });
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  t.after(() => release(avatar));
  const f = await fixture(t, { configureSdk(sdk) {
    sdk.directory.clients = [2, 3].map(id => ({ id, uid: `user-${id}`, nickname: `User ${id}`, channelID: 1n, type: 1, serverGroups: [] }));
    sdk.avatarRequest = async id => { calls.push(id); if (calls.length === 1) { started(); return pending; } return avatar; };
  } });
  await firstStarted;
  return { ...f, calls, release: () => release(avatar), entry: [...f.entries.values()][0]! };
}

test("avatar completion after teardown cannot refill the cache or start another SDK request", { timeout: 5_000 }, async t => {
  const f = await avatarFixture(t);
  await f.bridge.terminateSession(f.entry.id);
  f.release();
  await nextTurn();
  assert.equal(f.entry.avatarCache.size, 0);
  assert.deepEqual(f.calls, [2]);
});

test("pending heartbeat acknowledgement does not cancel a live avatar refresh", { timeout: 5_000 }, async t => {
  const f = await avatarFixture(t);
  f.entry.isAlive = false;
  f.release();
  await nextTurn();
  assert.deepEqual(f.calls, [2, 3]);
  assert.equal(f.entry.avatarCache.size, 2);
});

test("an interrupted SDK connection invalidates its pending avatar results", { timeout: 5_000 }, async t => {
  const f = await avatarFixture(t);
  f.sdk.emit("disconnected");
  f.release();
  await nextTurn();
  assert.equal(f.entry.avatarCache.size, 0);
  assert.deepEqual(f.calls, [2]);
});

test("late directory callbacks cannot refill a session while its peer is closing", { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const entry = [...f.entries.values()][0]!;
  const onEnter = f.sdk.listeners("clientEnter")[0]!;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  entry.webrtc = { close: () => pending, getStats: () => ({}) } as unknown as WebRtcAudioSession;
  const closing = f.bridge.terminateSession(entry.id);
  try {
    onEnter({ id: 9, uid: "", nickname: "Late", channelID: 1n, type: 1, serverGroups: [] });
    assert.equal(entry.members.has(9), false);
  } finally {
    release();
    await closing;
  }
});

test("directory snapshots during reconnect backoff cannot leak members into the next connection", { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const entry = [...f.entries.values()][0]!;
  const reconnected = new Promise<void>(resolve => {
    f.socket.on("message", (data, binary) => { if (!binary && JSON.parse(data.toString()).type === "reconnected") resolve(); });
  });
  f.sdk.emit("disconnected");
  f.sdk.emit("directorySnapshot", { channels: [], clients: [{ id: 9, uid: "", nickname: "Stale", channelID: 1n, type: 1, serverGroups: [] }] });
  await reconnected;
  assert.equal(entry.members.has(9), false);
});

test("commands arriving during recovery receive a correlated rejection", { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const rejected = new Promise<{ requestId?: string }>(resolve => {
    f.socket.on("message", (data, binary) => {
      if (binary) return;
      const message = JSON.parse(data.toString());
      if (message.type === "error" && message.error?.code === "SESSION_NOT_READY") resolve(message);
    });
  });
  f.sdk.emit("disconnected");
  f.socket.send(JSON.stringify({ type: "sendServerMessage", requestId: "chat-in-flight", payload: { message: "Hello" } }));
  assert.equal((await rejected).requestId, "chat-in-flight");
});

for (const order of ["kick-first", "disconnect-first"] as const) {
  test(`a kick remains terminal when notifications arrive ${order}`, { timeout: 5_000 }, async t => {
    const f = await fixture(t);
    const kick = normalizeTeamSpeakKickedReason("Removed by operator", 4);
    if (order === "disconnect-first") f.sdk.emit("disconnected");
    f.sdk.emit("kicked", kick);
    if (order === "kick-first") f.sdk.emit("disconnected");
    await nextTurn();
    assert.equal(f.bridge.getActiveCount(), 0);
    if (f.socket.readyState !== WebSocket.CLOSED) await once(f.socket, "close");
    const failures = f.messages.filter(message => !message.binary).map(message => JSON.parse(message.data.toString())).filter(message => message.type === "connectionFailed");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, "KICKED");
    assert.match(failures[0].detail, /Removed by operator/);
  });
}
