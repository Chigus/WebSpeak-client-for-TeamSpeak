import assert from "node:assert/strict";
import test from "node:test";
import { createAudioFlowStats, snapshotAudioStats, snapshotAudioStatus } from "./audio-stats.js";
import type { WebRtcAudioStats } from "./webrtc-audio.js";

test("diagnostic snapshots remain stable while new traffic changes live counters", () => {
  const audio = createAudioFlowStats();
  audio.egressFramesByClient[2] = 3;
  const snapshot = snapshotAudioStats({ audio, webrtc: null });
  audio.egressFramesByClient[2]++;
  assert.equal(snapshot.egressFramesByClient[2], 3);
  snapshot.egressFramesByClient[2] = 10;
  assert.equal(audio.egressFramesByClient[2], 4);
});

test("public audio status includes live WebRTC counters without losing gateway counters", () => {
  const audio = createAudioFlowStats();
  audio.ingressFrames = 12;
  const rtc: WebRtcAudioStats = {
    webrtcIngressRtpFrames: 7, webrtcIngressRtpFirstAt: 100, webrtcIngressRtpLastAt: 220, webrtcIngressRtpMaxGapMs: 20,
    webrtcEgressRtpFrames: 3, webrtcEgressRtpFirstAt: 100, webrtcEgressRtpLastAt: 140, webrtcEgressRtpMaxGapMs: 20,
    webrtcQueuePeakFrames: 2, webrtcQueueDroppedFrames: 1, webrtcQueueUnderrunTicks: 0, webrtcPacerLateTicks: 0,
    webrtcQueueCurrentFrames: 1, webrtcIngressQuietFrames: 0, webrtcIngressDecodeErrors: 0,
    webrtcDownlinkDecodedFrames: 3, webrtcDownlinkDecodeErrors: 0, webrtcDownlinkShortFrames: 0,
  };
  const source = { audio, webrtc: { getStats: () => rtc } };
  const status = snapshotAudioStatus(source);
  assert.equal(status.transport, "webrtc");
  assert.equal(status.ingressFrames, 12);
  assert.equal(status.webrtcIngressRtpFrames, 7);
  assert.equal(snapshotAudioStatus({ audio, webrtc: null }).transport, "websocket");
});
