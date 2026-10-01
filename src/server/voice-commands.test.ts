import assert from "node:assert/strict";
import test from "node:test";
import { parseClientCommand, type ClientCommand } from "../shared/client-commands.js";
import { parseServerMessage, type ServerMessage } from "../shared/server-messages.js";
import { createAudioFlowStats } from "./audio-stats.js";
import { handleCommand, type VoiceCommandContext } from "./voice-commands.js";

function fixture() {
  const calls: Array<[string, ...unknown[]]> = [];
  const messages: ServerMessage[] = [];
  const context: VoiceCommandContext = {
    tsClient: {
      execCommandWithResponse: async request => { calls.push(["exec", request]); return []; },
      switchChannel: async (...args) => { calls.push(["switch", ...args]); },
      getClientId: () => 1, getChannelId: () => 5n,
      moveClient: async (...args) => { calls.push(["move", ...args]); },
      sendTextMessage: async (...args) => { calls.push(["text", ...args]); },
      poke: async (...args) => { calls.push(["poke", ...args]); },
      setAway: async (...args) => { calls.push(["away", ...args]); },
      setInputMuted: async (...args) => { calls.push(["mute", ...args]); },
    },
    channelTree: [{ id: "18446744073709551615", parentID: "0", name: "Large ID" }],
    members: new Map([[1, {}], [2, {}]]),
    whisperTargetIds: new Set(), whisperActive: false,
    lastAudioStatsProbeAt: 0, lastLatencyProbeAt: 0,
    audio: createAudioFlowStats(), webrtc: null,
  };
  async function run(command: ClientCommand, now = 10_000) {
    // The same parsers used at both ends must accept the command and reply.
    const parsed = parseClientCommand(JSON.stringify(command));
    assert.ok(!("error" in parsed));
    await handleCommand(context, parsed, message => {
      assert.ok(parseServerMessage(JSON.parse(JSON.stringify(message))), `invalid response: ${message.type}`);
      messages.push(message);
    }, () => now);
  }
  return { context, calls, messages, run };
}

test("moving a visible member preserves bigint channel IDs and request correlation", async () => {
  const f = fixture();
  await f.run({ type: "moveClient", payload: { clientId: 2, channelId: "18446744073709551615", password: "ignored-for-admin-move" }, requestId: "move-1" });
  assert.deepEqual(f.calls, [["move", 2, 18446744073709551615n]]);
  assert.deepEqual(f.messages, [{ type: "commandCompleted", requestId: "move-1" }]);
});

test("invalid move targets are rejected before invoking the SDK", async () => {
  const f = fixture();
  for (const [clientId, channelId, code] of [[1, "18446744073709551615", "CANNOT_MOVE_SELF"], [3, "18446744073709551615", "CLIENT_NOT_FOUND"], [2, "9", "CHANNEL_NOT_FOUND"]] as const) {
    await f.run({ type: "moveClient", payload: { clientId, channelId }, requestId: code });
    const reply = f.messages.at(-1);
    assert.ok(reply?.type === "error");
    assert.equal(reply.error?.code, code);
    assert.equal(reply.requestId, code);
  }
  assert.deepEqual(f.calls, []);
});

test("channel switching preserves already-member success and authoritative password errors", async () => {
  const f = fixture();
  f.context.tsClient.switchChannel = async () => { throw new Error("already member"); };
  await f.run({ type: "switchChannel", payload: { channelId: "2" }, requestId: "same" });
  assert.deepEqual(f.messages, [{ type: "channelSwitched", requestId: "same", channelId: "2" }]);
  f.context.tsClient.switchChannel = async () => { throw Object.assign(new Error("generic failure"), { id: 781 }); };
  await f.run({ type: "switchChannel", payload: { channelId: "3" }, requestId: "password" });
  const failure = f.messages.at(-1);
  assert.ok(failure?.type === "error");
  assert.equal(failure.error?.code, "CHANNEL_PASSWORD_REQUIRED");
  assert.equal(failure.requestId, "password");
});

test("whisper transitions reject unavailable targets and deactivate when targets are cleared", async () => {
  const f = fixture();
  await f.run({ type: "setWhisperActive", payload: { active: true } });
  assert.equal(f.context.whisperActive, false);
  await f.run({ type: "setWhisperTargets", payload: { targetIds: [1] } });
  assert.equal(f.context.whisperTargetIds.size, 0);
  await f.run({ type: "setWhisperTargets", payload: { targetIds: [2] } });
  await f.run({ type: "setWhisperActive", payload: { active: true } });
  assert.equal(f.context.whisperActive, true);
  await f.run({ type: "setWhisperTargets", payload: { targetIds: [] } });
  assert.equal(f.context.whisperActive, false);
  assert.deepEqual(f.messages.at(-1), { type: "whisperTargets", targetIds: [], active: false });
});

test("mute state reaches the mixer only after TeamSpeak accepts the change", async () => {
  const f = fixture();
  f.context.webrtc = {
    getStats: createAudioFlowStats,
    setMicrophoneMuted: value => { f.calls.push(["mixer-mute", value]); },
    setAccompanimentActive() {}, setMemberVolume() {},
  };
  await f.run({ type: "setMicrophoneMuted", payload: { muted: true }, requestId: "mute" });
  assert.deepEqual(f.calls, [["mute", true], ["mixer-mute", true]]);
  f.context.tsClient.setInputMuted = async () => { throw Object.assign(new Error("denied"), { id: 2568 }); };
  await f.run({ type: "setMicrophoneMuted", payload: { muted: false }, requestId: "unmute" });
  assert.equal(f.calls.length, 2);
  const reply = f.messages.at(-1);
  assert.ok(reply?.type === "error");
  assert.equal(reply.error?.code, "PERMISSION_DENIED");
});

test("chat routing uses the current channel, server scope, and private target independently", async () => {
  const f = fixture();
  await f.run({ type: "sendTextMessage", payload: { message: " channel " } });
  await f.run({ type: "sendServerMessage", payload: { message: " server " } });
  await f.run({ type: "sendPrivateMessage", payload: { clientId: 2, message: " private " } });
  await f.run({ type: "sendTextMessage", payload: { message: "   " }, requestId: "empty" });
  assert.deepEqual(f.calls, [["text", "channel", "channel", 5n], ["text", "server", "server"], ["text", "private", "private", 2n]]);
  assert.deepEqual(f.messages.at(-1), { type: "commandCompleted", requestId: "empty" });
});

test("audio probing is bounded per session and accepts the next request at the interval boundary", async () => {
  const f = fixture();
  f.context.audio.ingressFrames = 8;
  const request = (sequence: string): ClientCommand => ({ type: "audioStatsProbe", payload: { sequence } });
  await f.run(request("first"), 1000);
  await f.run(request("early"), 1749);
  await f.run(request("next"), 1750);
  assert.equal(f.messages.length, 2);
  assert.ok(f.messages[1]?.type === "audioStats");
  assert.equal(f.messages[1].sequence, "next");
  assert.equal(f.messages[1].stats.ingressFrames, 8);
});
