import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { adaptScreenShareBitrate, createScreenShareEncoder, initialScreenShareAdaptation, normalizeScreenShareBitrate, screenShareEncodingPlan, type ScreenShareNetworkSample } from "../src/voice/screen-share-bitrate.js";

const capture = { width: 1920, height: 1080, frameRate: 60 };
const sample = (sampledAt: number, override: Partial<ScreenShareNetworkSample> = {}): ScreenShareNetworkSample => ({ sampledAt, bitrateKbps: 8000, intervalLossPercent: 0, roundTripTimeMs: 40, availableOutgoingBitrateKbps: 24000, qualityLimitationReason: "none", ...override });
test("1080p60 receives a useful explicit budget and strategies preserve different qualities", () => {
  const quality = screenShareEncodingPlan({ bitratePolicy: "quality" }, capture);
  const smooth = screenShareEncodingPlan({ bitratePolicy: "smooth" }, capture);
  const balanced = screenShareEncodingPlan({}, capture);
  assert.ok(quality.initial >= 12_000_000);
  assert.ok(quality.ceiling > balanced.ceiling && balanced.ceiling > smooth.ceiling);
  assert.equal(quality.degradation, "maintain-resolution");
  assert.equal(smooth.degradation, "maintain-framerate");
  assert.equal(balanced.degradation, "balanced");
  const manual = screenShareEncodingPlan({ bitrateMode: "manual", bitrateMbps: 16, maxWidth: 1280, maxHeight: 720 }, capture);
  assert.equal(manual.initial, 16_000_000); assert.equal(manual.scale, 1.5);
  assert.equal(manual.degradation, "maintain-resolution");
  assert.equal(normalizeScreenShareBitrate({ bitrateMbps: Infinity }).bitrateMbps, 12);
  assert.equal(normalizeScreenShareBitrate({ bitrateMbps: 999 }).bitrateMbps, 20);
});

test("congestion requires corroboration, falls quickly and recovers more cautiously", () => {
  let state = initialScreenShareAdaptation(10_000_000);
  state = adaptScreenShareBitrate(state, sample(1000, { intervalLossPercent: 8, availableOutgoingBitrateKbps: 6000 }), 16_000_000, "balanced");
  assert.equal(state.target, 10_000_000, "One sample must not flap the limit");
  state = adaptScreenShareBitrate(state, sample(2000, { intervalLossPercent: 8, availableOutgoingBitrateKbps: 6000 }), 16_000_000, "balanced");
  const reduced = state.target;
  assert.ok(reduced < 6_000_000); assert.equal(state.reason, "network");
  for (let time = 3000; time <= 5000; time += 1000) state = adaptScreenShareBitrate(state, sample(time), 16_000_000, "balanced");
  assert.equal(state.target, reduced, "Brief recovery must not immediately increase bitrate");
  for (let time = 6000; time <= 10000; time += 1000) state = adaptScreenShareBitrate(state, sample(time), 16_000_000, "balanced");
  assert.ok(state.target > reduced && state.target <= 16_000_000);
});

test("missing feedback, stale samples and static content cannot fabricate congestion or capacity", () => {
  let state = initialScreenShareAdaptation(8_000_000);
  for (let time = 1000; time <= 10000; time += 1000) state = adaptScreenShareBitrate(state, sample(time, { bitrateKbps: 10, intervalLossPercent: null, availableOutgoingBitrateKbps: null, roundTripTimeMs: null }), 16_000_000, "balanced");
  assert.equal(state.target, 8_000_000);
  assert.equal(adaptScreenShareBitrate(state, sample(9000, { intervalLossPercent: 90 }), 16_000_000, "balanced"), state);
  for (let time = 11000; time <= 20000; time += 1000) state = adaptScreenShareBitrate(state, sample(time, { qualityLimitationReason: "cpu" }), 16_000_000, "balanced");
  assert.equal(state.target, 8_000_000); assert.equal(state.reason, "cpu");
});

test("smoothness responds to moderate loss before quality priority", () => {
  let quality = initialScreenShareAdaptation(8_000_000), smooth = initialScreenShareAdaptation(8_000_000);
  for (const time of [1000, 2000]) {
    quality = adaptScreenShareBitrate(quality, sample(time, { intervalLossPercent: 4 }), 16_000_000, "quality");
    smooth = adaptScreenShareBitrate(smooth, sample(time, { intervalLossPercent: 4 }), 16_000_000, "smooth");
  }
  assert.equal(quality.target, 8_000_000); assert.ok(smooth.target < quality.target);
});

function fixture() {
  const writes: RTCRtpSendParameters[] = [];
  let action: (parameters: RTCRtpSendParameters) => Promise<void> = async () => {};
  const sender = { getParameters: () => ({ encodings: [{}] }), setParameters: async (parameters: RTCRtpSendParameters) => { writes.push(structuredClone(parameters)); await action(parameters); } } as unknown as RTCRtpSender;
  const track = { getSettings: () => capture } as MediaStreamTrack;
  let alive = true;
  const encoder = createScreenShareEncoder(sender, track, () => alive);
  return { encoder, writes, action: (fn: typeof action) => { action = fn; }, retire: () => { alive = false; encoder.dispose(); } };
}
test("manual changes serialize behind pending writes and remain stable under network feedback", async () => {
  const f = fixture(); let release!: () => void;
  f.action(() => new Promise<void>(resolve => { release = resolve; }));
  const first = f.encoder.configure({ bitratePolicy: "quality" });
  await nextTurn();
  const latest = f.encoder.configure({ bitrateMode: "manual", bitrateMbps: 16 });
  assert.equal(f.writes.length, 1);
  f.action(async () => {}); release();
  assert.equal(await first, true); assert.equal(await latest, true);
  assert.equal(f.writes.at(-1)?.encodings[0]?.maxBitrate, 16_000_000);
  const count = f.writes.length;
  f.encoder.sample(sample(5000, { intervalLossPercent: 30, availableOutgoingBitrateKbps: 1000 }));
  await nextTurn(); assert.equal(f.writes.length, count);
  assert.equal(f.encoder.snapshot().targetBitrateKbps, 16000);
  f.retire();
});
test("disposal retires pending writes and does not publish an applied limit", async () => {
  const f = fixture(); let release!: () => void;
  f.action(() => new Promise<void>(resolve => { release = resolve; }));
  const pending = f.encoder.configure({ bitrateMode: "manual", bitrateMbps: 20 });
  await nextTurn(); f.retire(); release();
  assert.equal(await pending, false);
  assert.equal(f.encoder.snapshot().targetBitrateKbps, null);
  f.encoder.sample(sample(2000)); await nextTurn(); assert.equal(f.writes.length, 1);
});
test("optional strategy rejection keeps bitrate control and complete rejection remains visible", async () => {
  const f = fixture();
  f.action(async p => { if (p.degradationPreference) throw new Error("Unsupported"); });
  assert.equal(await f.encoder.configure({ bitrateMode: "manual", bitrateMbps: 12 }), true);
  assert.equal(f.encoder.snapshot().bitrateStrategySupported, false);
  assert.equal(f.encoder.snapshot().targetBitrateKbps, 12000);
  f.action(async () => { throw new Error("Unsupported"); });
  assert.equal(await f.encoder.configure({ bitrateMode: "manual", bitrateMbps: 20 }), false);
  assert.equal(f.encoder.snapshot().bitrateControlSupported, false);
  assert.equal(f.encoder.snapshot().targetBitrateKbps, 12000, "Never claim an unaccepted bitrate");
  f.retire();
});
