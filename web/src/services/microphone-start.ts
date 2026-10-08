/** Start microphone permission synchronously before resuming a suspended context. */
export function requestMediaBeforeAudioResume<T>(
  requestMedia: () => Promise<T>,
  resumeAudio: () => Promise<unknown>,
): Promise<T> {
  let mediaRequest: Promise<T>;
  try {
    // Keep this call synchronous with the user action so browsers can show
    // their permission prompt before AudioContext.resume() waits on activation.
    mediaRequest = requestMedia();
  } catch (error) {
    return Promise.reject(error);
  }
  try {
    void Promise.resolve(resumeAudio()).catch(() => undefined);
  } catch {
    // Audio playback can resume on the next user gesture.
  }
  return mediaRequest;
}
