import assert from "node:assert/strict";
import { test } from "node:test";
import { cloneSenderVideoTrack, stopSenderVideoTrack } from "../src/voice/screen-share-track.js";
import { normalizeVideoOfferSdp, applyVideoCodecPreference } from "../src/voice/screen-share-codec.js";
import { h264ProbeSustainsTarget, preferredVideoCodecForTrack, type H264ProbeSample } from "../src/voice/screen-share-codec-probe.js";

test("sender clone retirement leaves capture and other viewers alive", () => {
  const make = (): any => ({ kind: "video", readyState: "live", enabled: true, contentHint: "detail", clone: make,
    getSettings: () => ({}), stop() { this.readyState = "ended"; } });
  const source = make();
  const first = cloneSenderVideoTrack(source, () => assert.fail("Ordinary retirement is not a media failure"));
  const second = cloneSenderVideoTrack(source, () => {});
  assert.notEqual(first, source);
  assert.notEqual(first, second);
  stopSenderVideoTrack(first);
  assert.equal(first.readyState, "ended");
  assert.equal(source.readyState, "live");
  assert.equal(second.readyState, "live");
  stopSenderVideoTrack(second);
});
test("H264 proof requires actual sustaining source/encoder progress and rejects CPU pressure", async () => {
  const baseline: H264ProbeSample = { outboundId: "a", sourceId: "s", timestamp: 1000, codec: "video/H264",
    framesEncoded: 100, sourceFrames: 100, encodedFramesPerSecond: 60, sourceFramesPerSecond: 60, qualityLimitationReason: "none" };
  const good = { ...baseline, timestamp: 2000, framesEncoded: 160, sourceFrames: 160 };
  assert.equal(h264ProbeSustainsTarget(baseline, good, 60), true);
  assert.equal(h264ProbeSustainsTarget(baseline, { ...good, framesEncoded: 120 }, 60), false);
  assert.equal(h264ProbeSustainsTarget(baseline, { ...good, qualityLimitationReason: "cpu" }, 60), false);
  assert.equal(h264ProbeSustainsTarget(baseline, { ...good, sourceId: "replacement" }, 60), false);
  assert.equal(h264ProbeSustainsTarget(baseline, { ...good, timestamp: 1200 }, 60), null);
  const abort = new AbortController(); abort.abort();
  assert.equal(await preferredVideoCodecForTrack({ kind: "video", readyState: "live" } as MediaStreamTrack,
    { width: 1920, height: 1080, maxFramerate: 60, maxBitrate: 8000000 }, abort.signal), "vp8");
});
test("codec ordering retains VP8/repair fallback and filters incompatible H264 packetization", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "RTCRtpSender");
  const codec = (mimeType: string, sdpFmtpLine?: string) => ({ mimeType, clockRate: 90000, sdpFmtpLine });
  Object.defineProperty(globalThis, "RTCRtpSender", { configurable: true, value: { getCapabilities: () => ({ codecs: [codec("video/VP8"), codec("video/H264", "packetization-mode=0"), codec("video/H264", "packetization-mode=1"), codec("video/rtx")] }) } });
  try {
    let chosen: RTCRtpCodec[] = [];
    const transceiver = { setCodecPreferences: (codecs: RTCRtpCodec[]) => { chosen = codecs; } } as RTCRtpTransceiver;
    assert.equal(applyVideoCodecPreference(transceiver, { primary: "h264", vp8Fallback: true }), true);
    assert.deepEqual(chosen.map(c => c.mimeType), ["video/H264", "video/VP8", "video/rtx"]);
    assert.equal(chosen[0]?.sdpFmtpLine, "packetization-mode=1");
  } finally {
    if (previous) Object.defineProperty(globalThis, "RTCRtpSender", previous); else Reflect.deleteProperty(globalThis, "RTCRtpSender");
  }
});
test("Firefox SDP repair removes only orphan codec attributes", () => {
  const sdp = "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\na=fmtp:102 packetization-mode=1\r\na=rtcp-fb:102 nack\r\na=rtcp-fb:96 nack\r\na=rtcp-fb:* transport-cc\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=fmtp:111 stereo=1\r\n";
  const fixed = normalizeVideoOfferSdp(sdp);
  assert.ok(!fixed.includes("a=fmtp:102"));
  assert.ok(!fixed.includes("a=rtcp-fb:102"));
  assert.ok(fixed.includes("a=rtcp-fb:96 nack"));
  assert.ok(fixed.includes("a=rtcp-fb:* transport-cc"));
  assert.ok(fixed.includes("a=fmtp:111 stereo=1"));
});
