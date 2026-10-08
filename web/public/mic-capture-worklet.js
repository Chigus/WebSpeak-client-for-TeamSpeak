const FRAME_SAMPLES = 960;

class WebSpeakMicCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = options?.processorOptions?.channels === 2 ? 2 : 1;
    this.frame = new Float32Array(FRAME_SAMPLES * this.channels);
    this.offset = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const right = inputs[0]?.[1];
    for (const output of outputs[0] ?? []) output.fill(0);
    if (!input) return true;

    let inputOffset = 0;
    while (inputOffset < input.length) {
      const count = Math.min(input.length - inputOffset, FRAME_SAMPLES - this.offset);
      if (this.channels === 1) {
        this.frame.set(input.subarray(inputOffset, inputOffset + count), this.offset);
      } else {
        // The offset counts frames, not interleaved samples. Never downmix the
        // two ears, including opposite-phase or one-sided input.
        for (let index = 0; index < count; index++) {
          const outputIndex = (this.offset + index) * 2;
          this.frame[outputIndex] = input[inputOffset + index];
          this.frame[outputIndex + 1] = right?.[inputOffset + index] ?? 0;
        }
      }
      this.offset += count;
      inputOffset += count;
      if (this.offset !== FRAME_SAMPLES) continue;

      const energy = new Array(this.channels).fill(0);
      for (let index = 0; index < this.frame.length; index++) {
        energy[index % this.channels] += this.frame[index] * this.frame[index];
      }
      const levels = energy.map(sum => Math.sqrt(sum / FRAME_SAMPLES));
      const rms = Math.sqrt(energy.reduce((sum, value) => sum + value, 0) / this.frame.length);
      const frame = this.frame;
      this.frame = new Float32Array(FRAME_SAMPLES * this.channels);
      this.offset = 0;
      this.port.postMessage({ samples: frame, rms, levels }, [frame.buffer]);
    }
    return true;
  }
}

registerProcessor("webspeak-mic-capture", WebSpeakMicCaptureProcessor);
