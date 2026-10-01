import assert from "node:assert/strict";
import test from "node:test";
import { isSessionDescription, MAX_VOICE_SDP_LENGTH, parseWebRtcClientMessage, type WebRtcClientMessage } from "./webrtc.js";
import { parseServerMessage } from "./server-messages.js";

test("voice offer flags survive JSON transport and legacy omissions retain their defaults", () => {
  const message: WebRtcClientMessage = { type: "webrtcOffer", payload: { sdp: { type: "offer", sdp: "v=0\r\n" }, muted: true, accompanimentActive: true } };
  assert.deepEqual(parseWebRtcClientMessage(JSON.stringify(message)), message);
  assert.deepEqual(parseWebRtcClientMessage(JSON.stringify({ type: "webrtcOffer", payload: { sdp: message.payload.sdp } })), {
    ...message, payload: { ...message.payload, muted: false, accompanimentActive: false },
  });
  assert.deepEqual(parseWebRtcClientMessage('{"type":"webrtcStop"}'), { type: "webrtcStop" });
  assert.deepEqual(parseWebRtcClientMessage('{"type":"webrtcStop","payload":17}'), { type: "webrtcStop" });
});

test("malformed voice controls remain unrecognized instead of bypassing ordinary error handling", () => {
  const sdp = { type: "offer", sdp: "v=0" };
  for (const value of [null, [], { type: "other" }, { type: "webrtcOffer" },
    { type: "webrtcOffer", payload: { sdp: { ...sdp, type: "answer" } } },
    { type: "webrtcOffer", payload: { sdp, muted: 1 } },
    { type: "webrtcOffer", payload: { sdp, accompanimentActive: "true" } },
    { type: "webrtcOffer", payload: { sdp: { ...sdp, sdp: null } } },
  ]) assert.equal(parseWebRtcClientMessage(JSON.stringify(value)), null);
  assert.equal(parseWebRtcClientMessage("{"), null);
});

test("offer and answer validation share the same SDP boundary without removing legacy empty strings", () => {
  for (const length of [0, MAX_VOICE_SDP_LENGTH, MAX_VOICE_SDP_LENGTH + 1]) {
    const sdp = "a".repeat(length);
    const accepted = length <= MAX_VOICE_SDP_LENGTH;
    assert.equal(Boolean(parseWebRtcClientMessage(JSON.stringify({ type: "webrtcOffer", payload: { sdp: { type: "offer", sdp } } }))), accepted);
    assert.equal(Boolean(parseServerMessage({ type: "webrtcAnswer", payload: { sdp: { type: "answer", sdp } } })), accepted);
    assert.equal(isSessionDescription({ type: "answer", sdp }, "answer"), accepted);
  }
  assert.equal(isSessionDescription({ type: "offer", sdp: "v=0" }, "answer"), false);
});
