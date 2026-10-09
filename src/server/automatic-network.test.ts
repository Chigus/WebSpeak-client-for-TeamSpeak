import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VOICE_QUALITY, adaptVoiceQuality, initialVoiceAdaptation, isVoiceNetworkFeedback, validVoiceOpusPacket, VOICE_OPUS_HEADER } from "../shared/voice-quality.js";
import { preferVoiceRelay, isVoiceRelayMessage } from "../shared/voice-relay.js";
import { SessionVoiceQuality } from "./voice-quality.js";
import { OpusEncoder } from "./opus-codec.js";
import { ScreenShareRelays } from "./screen-share-relays.js";
import { parseScreenShareRelayCredentials } from "../shared/screen-share.js";
import { readGatewayOrigins } from "./gateway-routes.js";
const sample = { sequence: 1, rttMs: 30, uplinkBufferedMs: 0, playbackFrames: 100, playbackDropPercent: 0 };
test("weak networks downshift promptly but silence cannot inflate bandwidth", () => {
  let state = initialVoiceAdaptation(DEFAULT_VOICE_QUALITY);
  state = adaptVoiceQuality(state, DEFAULT_VOICE_QUALITY, { ...sample, uplinkBufferedMs: 500 }, 1000, 0);
  assert.ok(state.uplink < 48 && state.downlink < 96);
  const reduced = state.uplink;
  for (let n=2;n<30;n++) state = adaptVoiceQuality(state, DEFAULT_VOICE_QUALITY, { ...sample, playbackFrames: 0 }, n*2000, 0);
  assert.equal(state.uplink, reduced);
  for (let n=30;n<40;n++) state = adaptVoiceQuality(state, DEFAULT_VOICE_QUALITY, sample, n*2000, 0);
  assert.ok(state.uplink > reduced);
});
test("manual quality is stable and malformed feedback is rejected", () => {
  const settings = { ...DEFAULT_VOICE_QUALITY, mode: "manual" as const, bitrateKbps: 24 };
  const state = initialVoiceAdaptation(settings);
  assert.equal(adaptVoiceQuality(state, settings, { ...sample, uplinkBufferedMs: 900 }, 2000, 900), state);
  assert.equal(isVoiceNetworkFeedback({ ...sample, rttMs: NaN }), false);
  assert.equal(isVoiceNetworkFeedback({ ...sample, sequence: .1 }), false);
});
test("route switches require a material improvement and low probe loss", () => {
  assert.equal(preferVoiceRelay(80, 85, 0), false);
  assert.equal(preferVoiceRelay(80, 300, 0), true);
  assert.equal(preferVoiceRelay(80, 300, .1), false);
  assert.equal(isVoiceRelayMessage({ type: "voiceRelay", action: "request", id: "test", route: "evil" }), false);
  assert.equal(isVoiceRelayMessage({ type: "voiceRelay", action: "select", id: "test", rttMs: -1, baselineMs: 30, loss: 0 }), false);
});
test("personal downlink transcoding retains stereo and leaves the original 192 kbps source untouched", t => {
  const old = process.env.WEBSPEAK_MOBILE; delete process.env.WEBSPEAK_MOBILE;
  t.after(() => { if (old === undefined) delete process.env.WEBSPEAK_MOBILE; else process.env.WEBSPEAK_MOBILE = old; });
  const source = new OpusEncoder(48000, 2, { bitrate: 192000, forceChannels: 2, vbr: false });
  const listener = new SessionVoiceQuality(), unchanged = new SessionVoiceQuality();
  listener.configure({ ...DEFAULT_VOICE_QUALITY, mode: "manual", bitrateKbps: 32 }, true);
  try {
    const pcm = Buffer.alloc(3840);
    for (let i=0;i<960;i++) { pcm.writeInt16LE(Math.sin(i*2*Math.PI*600/48000)*10000,i*4); pcm.writeInt16LE(Math.sin(i*2*Math.PI*1200/48000)*10000,i*4+2); }
    for (let n=0;n<30;n++) {
      const packet = source.encode(pcm), copy = Buffer.from(packet);
      const reduced = listener.encodeForListener(2, packet, 5, n*20);
      assert.equal(packet.length, 480); assert.deepEqual(packet, copy);
      assert.equal(reduced.length, 80); assert.ok(reduced[0]! & 4);
      assert.equal(unchanged.encodeForListener(2, packet, 5, n*20), packet);
    }
  } finally { source.dispose(); listener.close(); unchanged.close(); }
});
test("mono Opus packets at every offered bitrate pass the envelope validator", t => {
  const old = process.env.WEBSPEAK_MOBILE; delete process.env.WEBSPEAK_MOBILE;
  t.after(() => { if (old === undefined) delete process.env.WEBSPEAK_MOBILE; else process.env.WEBSPEAK_MOBILE = old; });
  for (const rate of [16,24,32,48,64,96,128,192]) {
    const codec = new OpusEncoder(48000,1,{bitrate:rate*1000,forceChannels:1,vbr:false});
    try { const packet=Buffer.concat([Buffer.from(VOICE_OPUS_HEADER),codec.encode(Buffer.alloc(1920))]); assert.equal(validVoiceOpusPacket(packet),true); }
    finally { codec.dispose(); }
  }
  assert.equal(validVoiceOpusPacket(new Uint8Array(1920)),false);
});
test("Cloudflare API response is bounded, split for browser validation and never exposes its API token", async t => {
  t.mock.method(globalThis,"fetch",async () => new Response(JSON.stringify({iceServers:[{urls:["stun:stun.cloudflare.com:3478"]},{urls:Array.from({length:6},(_,i)=>`turn:turn.cloudflare.com:${3478+i}?transport=udp`),username:"lease-user",credential:"lease-password"}]}),{status:201}));
  const relays=new ScreenShareRelays([{id:"cloudflare",provider:"cloudflare",keyId:"id",apiToken:"private-token",urls:[],secret:""}]);
  const lease=await relays.issueAsync("cloudflare");
  assert.ok(parseScreenShareRelayCredentials(lease)); assert.equal(lease!.iceServers.length,2);
  assert.ok(!JSON.stringify(lease).includes("private-token"));
});
test("automatic screen credentials survive one unavailable provider", async t => {
  t.mock.method(globalThis,"fetch",async () => new Response("",{status:503}));
  const relays=new ScreenShareRelays([{id:"cloudflare",provider:"cloudflare",keyId:"id",apiToken:"token",urls:[],secret:""},{id:"macau",urls:["turn:relay.example:3478"],secret:"s".repeat(32)}]);
  const lease=await relays.issueAsync("auto"); assert.ok(parseScreenShareRelayCredentials(lease)); assert.equal(lease!.iceServers.length,1);
});
test("gateway destinations must be explicit HTTPS origins", () => {
  assert.deepEqual(readGatewayOrigins('["https://a.example:5555","https://b.example:5555"]'),["https://a.example:5555","https://b.example:5555"]);
  for (const url of ["http://a.example","https://user:pass@a.example","https://a.example/path","https://a.example/#secret"]) assert.throws(()=>readGatewayOrigins(JSON.stringify([url])));
});
