interface AudioSink {
  setSinkId?(deviceId: string): Promise<void>;
}

// Browser sink changes cannot be cancelled once started. Serialize each
// endpoint so an older completion cannot leave it on the wrong device.
export function createAudioSinkRouter() {
  const pending = new WeakMap<AudioSink, Promise<void>>();

  function set(sink: AudioSink, deviceId: string, isCurrent: () => boolean): Promise<void> {
    const previous = pending.get(sink) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      if (isCurrent()) await sink.setSinkId?.(deviceId || "default");
    });
    pending.set(sink, task);
    const cleanup = () => { if (pending.get(sink) === task) pending.delete(sink); };
    void task.then(cleanup, cleanup);
    return task;
  }

  return { set };
}
