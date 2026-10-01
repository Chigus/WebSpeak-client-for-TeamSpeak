import type { MessageEvent as NodeMessage, SendOptions } from "@capawesome/capacitor-nodejs";

export interface AndroidGatewayBridge {
  addListener(name: "message", callback: (message: NodeMessage) => void): Promise<{ remove(): Promise<void> }>;
  isReady(): Promise<{ ready: boolean }>;
  send(options: SendOptions): Promise<void>;
}

export class GatewayStartupError extends Error {
  constructor(public readonly code: "failed" | "timeout" | "cancelled") {
    super(`Android gateway startup ${code}`);
  }
}

/** One startup attempt owns its listener, polling timer and deadline. */
export function waitForAndroidGateway(
  bridge: AndroidGatewayBridge,
  options: { signal?: AbortSignal; timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    let complete = false;
    let polling = false;
    let listener: { remove(): Promise<void> } | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const remove = (handle: { remove(): Promise<void> }): void => {
      try { void handle.remove().catch(() => undefined); } catch { /* plugin may already be disposed */ }
    };
    const finish = (error?: GatewayStartupError): void => {
      if (complete) return;
      complete = true;
      if (pollTimer !== null) clearInterval(pollTimer);
      if (deadline !== null) clearTimeout(deadline);
      options.signal?.removeEventListener("abort", cancel);
      if (listener) { remove(listener); listener = null; }
      if (error) reject(error);
      else resolve();
    };
    const cancel = (): void => finish(new GatewayStartupError("cancelled"));
    if (options.signal?.aborted) { cancel(); return; }
    options.signal?.addEventListener("abort", cancel, { once: true });
    // Include listener registration in the deadline: a missing plugin must not
    // leave the initial app screen waiting indefinitely.
    deadline = setTimeout(() => finish(new GatewayStartupError("timeout")), options.timeoutMs ?? 45_000);

    const poll = async (): Promise<void> => {
      if (complete || polling) return;
      polling = true;
      try {
        const { ready } = await bridge.isReady();
        if (!complete && ready) await bridge.send({ eventName: "webspeak-health", args: [] });
      } catch {
        finish(new GatewayStartupError("failed"));
      } finally { polling = false; }
    };

    void Promise.resolve().then(() => bridge.addListener("message", event => {
      if (complete) return;
      if (event.eventName === "webspeak-error") { finish(new GatewayStartupError("failed")); return; }
      if (event.eventName !== "webspeak-health") return;
      const health = event.args[0];
      if (health && typeof health === "object" && !Array.isArray(health) && health.ready === true) finish();
    })).then(handle => {
      // Some plugins deliver the first message before addListener resolves.
      // A timeout/cancellation can also win this race; release the late handle.
      if (complete) { remove(handle); return; }
      listener = handle;
      pollTimer = setInterval(() => { void poll(); }, options.pollIntervalMs ?? 500);
      void poll();
    }, () => finish(new GatewayStartupError("failed")));
  });
}

export async function startAndroidGateway(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) return;
  root.innerHTML = '<main style="min-height:100dvh;display:grid;place-items:center;background:#e9fbfb;color:#0b5960;font:16px system-ui;text-align:center;padding:24px"><div><h1 style="font-size:26px">WebSpeak</h1><p id="mobile-gateway-status">正在启动本地语音服务…</p><button id="mobile-gateway-retry" type="button" hidden>重试</button></div></main>';
  const status = root.querySelector("#mobile-gateway-status");
  const retry = root.querySelector<HTMLButtonElement>("#mobile-gateway-retry");
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  window.addEventListener("pagehide", cancel, { once: true });
  try {
    const { Nodejs } = await import("@capawesome/capacitor-nodejs");
    await waitForAndroidGateway(Nodejs, { signal: controller.signal });
    if (!controller.signal.aborted) window.location.replace("http://127.0.0.1:3040/");
  } catch (error) {
    if (controller.signal.aborted) return;
    if (status) status.textContent = error instanceof GatewayStartupError && error.code === "timeout"
      ? "本地语音服务启动超时，请重试或重新打开应用。"
      : "本地语音服务启动失败，请重试或重新打开应用。";
    if (retry) {
      retry.hidden = false;
      // This retries the readiness handshake; the embedded runtime itself can
      // only be started once per app launch.
      retry.addEventListener("click", () => { void startAndroidGateway(); }, { once: true });
    }
  } finally {
    window.removeEventListener("pagehide", cancel);
  }
}
