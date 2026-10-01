export interface MicrophoneMeter {
  dispose(): void;
}

// The meter is optional and owns only its nodes and timer, never the capture
// stream. A null sample clears presentation when metering stops or fails.
export function createMicrophoneMeter(context: AudioContext, stream: MediaStream,
  onLevel: (rms: number | null) => void): MicrophoneMeter {
  let source: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let silent: GainNode | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  const clean = (operation: () => void): void => { try { operation(); } catch { /* release remaining resources */ } };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (source) clean(() => source!.disconnect());
    if (analyser) clean(() => analyser!.disconnect());
    if (silent) clean(() => silent!.disconnect());
    source = null;
    analyser = null;
    silent = null;
    onLevel(null);
  }

  try {
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 512;
    silent = context.createGain();
    silent.gain.value = 0;
    source.connect(analyser);
    analyser.connect(silent);
    silent.connect(context.destination);
    const samples = new Float32Array(analyser.fftSize);
    timer = setInterval(() => {
      if (disposed) return;
      try { analyser!.getFloatTimeDomainData(samples); }
      catch { dispose(); return; }
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      onLevel(Math.sqrt(sum / samples.length));
    }, 50);
  } catch {
    dispose();
  }
  return { dispose };
}
