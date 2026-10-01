/** Ownership for one feature's in-flight work; reads with the same key replace
 * each other, while unrelated features can continue independently. */
export function createAdminRequests() {
  const pending = new Map<string, AbortController>();
  function cancel(key: string): void {
    pending.get(key)?.abort();
    pending.delete(key);
  }
  return {
    begin(key: string) {
      cancel(key);
      const controller = new AbortController();
      pending.set(key, controller);
      const isCurrent = () => pending.get(key) === controller && !controller.signal.aborted;
      return { signal: controller.signal, isCurrent, finish() { if (isCurrent()) pending.delete(key); } };
    },
    cancel,
    reset() { for (const key of pending.keys()) cancel(key); },
  };
}
