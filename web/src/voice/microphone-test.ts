interface MicrophoneTestOptions {
  prepare(): Promise<MediaStream | null>;
  onActive(active: boolean): void;
  onUrl(url: string): void;
  onStopped(): void;
  onError(error: unknown): void;
}

interface Recording {
  recorder: MediaRecorder | null;
  timer: number | null;
  chunks: Blob[];
  stopped: boolean;
}

// Capture belongs to the caller. This controller owns only the test operation,
// recorder, deadline and playback URL, including results queued after stop().
export function createMicrophoneTest(options: MicrophoneTestOptions) {
  let current: Recording | null = null;
  let url = "";

  function clearUrl(): void {
    if (url) URL.revokeObjectURL(url);
    url = "";
    options.onUrl("");
  }

  function finishCapture(recording: Recording): void {
    if (recording.timer !== null) window.clearTimeout(recording.timer);
    recording.timer = null;
    if (recording.stopped) return;
    recording.stopped = true;
    options.onActive(false);
    options.onStopped();
  }

  function dispose(): void {
    const recording = current;
    current = null;
    if (recording) {
      finishCapture(recording);
      if (recording.recorder?.state !== "inactive") {
        try { recording.recorder?.stop(); } catch { /* already ended */ }
      }
      recording.chunks.length = 0;
    }
    clearUrl();
  }

  function stop(): void {
    const recording = current;
    if (!recording) return;
    // A pending permission or device enumeration must not create a recorder.
    if (!recording.recorder) current = null;
    finishCapture(recording);
    if (recording.recorder?.state !== "inactive") {
      try { recording.recorder?.stop(); }
      catch (error) { dispose(); options.onError(error); }
    }
  }

  async function start(): Promise<void> {
    dispose();
    const recording: Recording = { recorder: null, timer: null, chunks: [], stopped: false };
    current = recording;
    options.onActive(true);
    try {
      const stream = await options.prepare();
      if (current !== recording) return;
      // Keep the existing level-meter-only test on browsers without recording.
      if (typeof MediaRecorder === "undefined" || !stream) return;
      const recorder = new MediaRecorder(stream);
      recording.recorder = recorder;
      recorder.ondataavailable = event => {
        if (current === recording && event.data.size) recording.chunks.push(event.data);
      };
      recorder.onstop = () => {
        if (current !== recording) return;
        current = null;
        finishCapture(recording);
        try {
          if (recording.chunks.length) {
            clearUrl();
            url = URL.createObjectURL(new Blob(recording.chunks, { type: recorder.mimeType || "audio/webm" }));
            options.onUrl(url);
          }
        } catch (error) { options.onError(error); }
        recording.chunks.length = 0;
      };
      recorder.onerror = event => {
        if (current !== recording) return;
        dispose();
        options.onError("error" in event ? event.error : new Error("Microphone recording failed"));
      };
      recorder.start();
      recording.timer = window.setTimeout(() => {
        if (current === recording) stop();
      }, 5_000);
    } catch (error) {
      if (current !== recording) return;
      dispose();
      throw error;
    }
  }

  return { start, stop, dispose };
}
