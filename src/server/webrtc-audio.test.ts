import assert from "node:assert/strict";
import test from "node:test";
import { WebRtcAudioSession } from "./webrtc-audio.js";

function fixture() {
  const released: string[] = [];
  // Exercise the real close path with failures at codec/track/peer boundaries.
  const resources = {
    closed: false, closePromise: null, audioTimer: null, activityTimer: undefined,
    pendingFrames: new Map([[1, []]]), memberVolumes: new Map([[1, 1]]),
    partialPcmByClient: new Map([[1, Buffer.alloc(2)]]), activeSpeakerIds: new Set([1]),
    decoderByClient: new Map([
      [1, { dispose() { released.push("decoder-1"); throw new Error("Decoder failed"); } }],
      [2, { dispose() { released.push("decoder-2"); } }],
    ]),
    encoder: { dispose(): void { released.push("encoder"); throw new Error("Encoder failed"); } },
    outgoingTrack: { stop(): void { released.push("track"); throw new Error("Track failed"); } },
    peer: { async close() { released.push("peer"); } },
  };
  const session = Object.assign(Object.create(WebRtcAudioSession.prototype), resources) as WebRtcAudioSession;
  return { session, resources, released };
}

test("WebRTC close releases remaining codecs, track and peer after disposal failures", async () => {
  const f = fixture();
  await f.session.close();
  await f.session.close();
  assert.deepEqual(f.released, ["decoder-1", "decoder-2", "encoder", "track", "peer"]);
  assert.equal(f.resources.decoderByClient.size, 0);
  assert.equal(f.resources.pendingFrames.size, 0);
  assert.equal(f.resources.memberVolumes.size, 0);
  assert.equal(f.resources.partialPcmByClient.size, 0);
  assert.equal(f.resources.activeSpeakerIds.size, 0);
});

test("concurrent WebRTC close callers await the same pending peer shutdown", async () => {
  const f = fixture();
  f.resources.decoderByClient.clear();
  f.resources.encoder.dispose = () => {};
  f.resources.outgoingTrack.stop = () => {};
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let closes = 0;
  f.resources.peer.close = async () => { closes++; await pending; };
  const first = f.session.close();
  let secondCompleted = false;
  const second = f.session.close().then(() => { secondCompleted = true; });
  await Promise.resolve();
  const completedEarly = secondCompleted;
  release();
  await Promise.all([first, second]);
  assert.equal(completedEarly, false);
  assert.equal(closes, 1);
});

test("a rejected peer shutdown is shared without repeating partial cleanup", async () => {
  const f = fixture();
  const failure = new Error("Peer shutdown failed");
  f.resources.peer.close = async () => { f.released.push("peer"); throw failure; };
  const first = f.session.close();
  const second = f.session.close();
  assert.equal(first, second);
  await assert.rejects(first, error => error === failure);
  await assert.rejects(second, error => error === failure);
  await assert.rejects(f.session.close(), error => error === failure);
  assert.deepEqual(f.released, ["decoder-1", "decoder-2", "encoder", "track", "peer"]);
  assert.equal(f.resources.decoderByClient.size, 0);
});
