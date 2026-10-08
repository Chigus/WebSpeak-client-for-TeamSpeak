// Run on stdin with the release image's Node.js and /app as its working directory.
// Synthetic input only: no microphone, playback device or network traffic.
import assert from "node:assert/strict";
import { OpusEncoder } from "./dist/server/opus-codec.js";

const encoder = new OpusEncoder(48000, 2, { bitrate: 192000, forceChannels: 2, vbr: false });
const decoder = new OpusEncoder(48000, 2);
const left = [];
const right = [];
let stereoPackets = 0;
const packetBytes = [];

function energy(samples, frequency) {
  let real = 0;
  let imaginary = 0;
  for (let i = 0; i < samples.length; i++) {
    const phase = 2 * Math.PI * frequency * i / 48000;
    real += samples[i] * Math.cos(phase);
    imaginary += samples[i] * Math.sin(phase);
  }
  return Math.hypot(real, imaginary) / samples.length;
}

try {
  for (let packet = 0; packet < 40; packet++) {
    const pcm = Buffer.alloc(3840);
    for (let frame = 0; frame < 960; frame++) {
      const time = (packet * 960 + frame) / 48000;
      pcm.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * 600 * time)), frame * 4);
      pcm.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * 1200 * time)), frame * 4 + 2);
    }
    const encoded = encoder.encode(pcm);
    packetBytes.push(encoded.length);
    assert.equal(encoded.length, 480, `Packet ${packet}: CBR must stay within the 484-byte TeamSpeak voice payload budget`);
    if (encoded[0] & 4) stereoPackets++;
    const decoded = decoder.decode(encoded);
    assert.equal(decoded.length, 3840, "Decoded frame must contain independent stereo samples");
    if (packet >= 5) {
      for (let frame = 0; frame < 960; frame++) {
        left.push(decoded.readInt16LE(frame * 4) / 32768);
        right.push(decoded.readInt16LE(frame * 4 + 2) / 32768);
      }
    }
  }
  const leftSeparationDb = 20 * Math.log10(energy(left, 600) / Math.max(energy(left, 1200), 1e-12));
  const rightSeparationDb = 20 * Math.log10(energy(right, 1200) / Math.max(energy(right, 600), 1e-12));
  assert.equal(stereoPackets, 40, "Every Opus packet must retain the stereo flag");
  assert.ok(energy(left, 600) > 0.05 && energy(right, 1200) > 0.05, "Both intended channels must carry audio");
  assert.ok(leftSeparationDb > 25 && rightSeparationDb > 25, "Left/right separation must exceed 25 dB");
  console.log(JSON.stringify({
    passed: true, node: process.version, packets: 40, stereoPackets,
    channels: 2, sampleRate: 48000, bitrate: 192000, vbr: false,
    packetBytes: { min: Math.min(...packetBytes), max: Math.max(...packetBytes) },
    leftSeparationDb, rightSeparationDb, microphoneCaptured: false, networkUsed: false,
  }));
} finally {
  encoder.dispose();
  decoder.dispose();
}
