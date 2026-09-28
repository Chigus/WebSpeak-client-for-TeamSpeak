import assert from "node:assert/strict";
import test from "node:test";
import { parseClientCommand } from "./voice-protocol.js";

test("accepts a bounded audio stats snapshot request", () => {
  assert.deepEqual(parseClientCommand(JSON.stringify({
    type: "audioStatsProbe",
    payload: { sequence: "audio-sample-1" },
  })), {
    type: "audioStatsProbe",
    payload: { sequence: "audio-sample-1" },
  });
});

test("continues accepting the legacy control-path probe for cached clients", () => {
  assert.deepEqual(parseClientCommand(JSON.stringify({
    type: "latencyProbe",
    payload: { sequence: "latency-old-client" },
  })), {
    type: "latencyProbe",
    payload: { sequence: "latency-old-client" },
  });
});

test("rejects audio stats requests without a short sequence id", () => {
  const result = parseClientCommand(JSON.stringify({
    type: "audioStatsProbe",
    payload: { sequence: "x".repeat(65) },
  }));
  assert.deepEqual(result, {
    error: { code: "INVALID_AUDIO_STATS_PROBE", message: "音频状态采样标识无效" },
  });
});
