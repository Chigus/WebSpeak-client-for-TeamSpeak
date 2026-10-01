import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import { VoiceBridge } from "./voice-bridge.js";
import { JoinTicketStore } from "./join-ticket.js";
import { createAudioFlowStats } from "./audio-stats.js";
import { SessionAudioTransport } from "./session-audio.js";
import type { WebRtcAudioSession, WebRtcAudioSessionOptions, WebRtcSessionDescription } from "./webrtc-audio.js";
import type { ServerMessage } from "../shared/server-messages.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

class PeerStub {
  closed = false;
  closeResult = Promise.resolve();
  answerResult = Promise.resolve();
  constructor(readonly options: WebRtcAudioSessionOptions) {}
  async close() { this.closed = true; await this.closeResult; }
  getStats() { return { webrtcIngressRtpFrames: 10 }; }
  pushTeamSpeakVoice() {}
  async createAnswer(offer: WebRtcSessionDescription): Promise<WebRtcSessionDescription> {
    await this.answerResult;
    return { type: "answer", sdp: offer.sdp };
  }
}

function fixture() {
  const peers: PeerStub[] = [];
  const messages: ServerMessage[] = [];
  const entry = {
    id: "session", session: { state: "connected" }, ws: { readyState: 1 as 0 | 1 | 2 | 3, bufferedAmount: 0, send() {} },
    webrtc: null as PeerStub | null, webrtcGeneration: 0,
    tsClient: { setInputMuted: async (_muted: boolean) => {}, sendVoice: () => { forwarded++; }, sendWhisper: () => { forwarded++; } },
    whisperActive: false, whisperTargetIds: new Set<number>(), audio: createAudioFlowStats(),
    audioTransport: null as SessionAudioTransport | null,
  };
  let forwarded = 0;
  let configurePeer = (_peer: PeerStub): void => {};
  const instance = new VoiceBridge({ joinTickets: new JoinTicketStore(), webRtc: { enabled: true } }, pino({ enabled: false }), options => {
    const peer = new PeerStub(options);
    peers.push(peer);
    configurePeer(peer);
    return peer as unknown as WebRtcAudioSession;
  });
  // Exercise the bridge's orchestration itself, replacing only SDK/WebRTC I/O.
  type Entry = typeof entry;
  const bridge = instance as unknown as {
    entries: Map<string, Entry>;
    handleWebRtcOffer(entry: Entry, offer: WebRtcSessionDescription, send: (message: ServerMessage) => void): Promise<void>;
    stopWebRtc(entry: Entry): Promise<void>;
  };
  bridge.entries.set(entry.id, entry);
  entry.audioTransport = new SessionAudioTransport({
    audio: entry.audio, socket: entry.ws, client: entry.tsClient,
    isCurrent: () => bridge.entries.get(entry.id) === entry,
    isReady: () => entry.session.state === "connected", selfId: () => 1,
    peer: () => entry.webrtc, whisperTargets: () => null, sendJson: message => messages.push(message),
  }, { encode: frame => frame, dispose() {} });
  const offer = (sdp: string) => bridge.handleWebRtcOffer(entry, { type: "offer", sdp }, message => messages.push(message));
  return { bridge, entry, peers, messages, offer, forwarded: () => forwarded, configure: (callback: typeof configurePeer) => { configurePeer = callback; } };
}

test("an offer waiting on the SDK cannot create a peer after its session is removed", async () => {
  const f = fixture();
  const mute = deferred();
  f.entry.tsClient.setInputMuted = () => mute.promise;
  const pending = f.offer("old");
  // Allow the operation to reach the SDK boundary before teardown wins.
  await Promise.resolve();
  f.bridge.entries.delete(f.entry.id);
  f.entry.session.state = "disconnecting";
  f.entry.ws.readyState = 3;
  mute.resolve();
  await pending;
  assert.equal(f.peers.length, 0);
});

test("a newer offer wins while the old offer waits for its mute update", async () => {
  const f = fixture();
  const mute = deferred();
  f.entry.tsClient.setInputMuted = () => mute.promise;
  const old = f.offer("old");
  await Promise.resolve();
  f.entry.tsClient.setInputMuted = async () => {};
  await f.offer("new");
  const current = f.entry.webrtc;
  mute.resolve();
  await old;
  assert.equal(f.entry.webrtc, current);
  assert.equal(f.peers.length, 1);
  assert.deepEqual(f.messages.filter(message => message.type === "webrtcAnswer").map(message => message.payload.sdp.sdp), ["new"]);
});

test("closing an older peer cannot clear or overwrite a newer offer", async () => {
  const f = fixture();
  await f.offer("initial");
  const closing = deferred();
  f.peers[0]!.closeResult = closing.promise;
  const old = f.offer("old");
  await Promise.resolve();
  const newer = f.offer("new");
  closing.resolve();
  await Promise.all([old, newer]);
  assert.equal(f.peers.length, 2);
  assert.equal(f.entry.webrtc, f.peers[1]);
  assert.deepEqual(f.messages.filter(message => message.type === "webrtcAnswer").map(message => message.payload.sdp.sdp), ["initial", "new"]);
});

test("a superseded answer failure cannot send an error for the current offer", async () => {
  const f = fixture();
  const answer = deferred();
  f.configure(peer => { if (f.peers.length === 1) peer.answerResult = answer.promise; });
  const old = f.offer("old");
  await Promise.resolve();
  await Promise.resolve();
  await f.offer("new");
  const current = f.entry.webrtc;
  answer.reject(new Error("old peer closed"));
  await old;
  assert.equal(f.entry.webrtc, current);
  assert.equal(current?.closed, false);
  assert.equal(f.messages.some(message => message.type === "webrtcError"), false);
});

test("a replaced peer cannot forward late audio or activity into the current session", async () => {
  const f = fixture();
  await f.offer("old");
  const old = f.peers[0]!;
  await f.offer("new");
  old.options.onVoiceFrame(Buffer.from([1, 2, 3]), 4);
  old.options.onVoiceActivity([7]);
  assert.equal(f.forwarded(), 0);
  assert.equal(f.entry.audio.ingressFrames, 0);
  assert.equal(f.messages.some(message => message.type === "voiceActivity"), false);
  f.peers[1]!.options.onVoiceFrame(Buffer.from([4, 5, 6]), 4);
  assert.equal(f.forwarded(), 1);
});

test("stop invalidates an offer before the first peer has been created", async () => {
  const f = fixture();
  const mute = deferred();
  f.entry.tsClient.setInputMuted = () => mute.promise;
  const pending = f.offer("pending");
  await Promise.resolve();
  await f.bridge.stopWebRtc(f.entry);
  mute.resolve();
  await pending;
  assert.equal(f.entry.webrtc, null);
  assert.equal(f.peers.length, 0);
  assert.deepEqual(f.messages, []);
});

test("a current peer construction failure reports a recoverable negotiation error", async () => {
  const f = fixture();
  f.configure(() => { throw new Error("codec unavailable"); });
  await f.offer("current");
  assert.equal(f.entry.webrtc, null);
  assert.deepEqual(f.messages, [{ type: "webrtcError", code: "WEBRTC_NEGOTIATION_FAILED" }]);
});

test("old close statistics cannot overwrite a new peer's live snapshot", async () => {
  const f = fixture();
  await f.offer("old");
  const closing = deferred();
  f.peers[0]!.closeResult = closing.promise;
  const stopped = f.bridge.stopWebRtc(f.entry);
  await f.offer("new");
  f.entry.audio.webrtcIngressRtpFrames = 27;
  closing.resolve();
  await stopped;
  assert.equal(f.entry.audio.webrtcIngressRtpFrames, 27);
  assert.equal(f.entry.webrtc, f.peers[1]);
});
