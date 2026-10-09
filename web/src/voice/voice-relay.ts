import { ref } from "vue";
import { isVoiceRelayMessage, preferVoiceRelay, type VoiceRelayMessage, type VoiceRelayRoute } from "../../../src/shared/voice-relay.js";
import type { ScreenShareRelayId } from "../../../src/shared/screen-share.js";
interface Candidate {
  id: string; route: VoiceRelayRoute; pc: RTCPeerConnection | null; channel: RTCDataChannel | null;
  deadline: ReturnType<typeof setTimeout>; lastPong: number; sent: Map<number, number>; samples: number[];
  sequence: number; pingCount: number; selected: boolean; scoring: boolean;
}
export function createVoiceRelay(options: {
  send(message: VoiceRelayMessage): void; audio(frame: Uint8Array): void;
  baseline(): Promise<number | null>; ready(): boolean;
}) {
  const route = ref<VoiceRelayRoute | "wss">("wss");
  const candidates = new Map<string, Candidate>();
  let active: Candidate | null = null, generation = 0, serial = 0, sequence = 0, ping = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let available: VoiceRelayRoute[] = [], nextRoute = 0, nextProbe = 0, enabled = false;
  let checkingWss = false;
  const current = (c: Candidate) => enabled && options.ready() && candidates.get(c.id) === c;
  function send(m: VoiceRelayMessage) { if (enabled && options.ready()) options.send(m); }
  function retire(c: Candidate, notify = true) {
    candidates.delete(c.id); clearTimeout(c.deadline);
    if (active === c) { active = null; route.value = "wss"; }
    if (notify) send({ type: "voiceRelay", action: "stop", id: c.id });
    try { c.channel?.close(); } catch {}
    try { c.pc?.close(); } catch {}
  }
  function probe() {
    if (!enabled || !options.ready() || candidates.size > (active ? 1 : 0) || !available.length) return;
    const target = available[nextRoute++ % available.length]!;
    if (target === active?.route) return;
    const id = `voice-${generation}-${++serial}`;
    const c: Candidate = { id, route: target, pc: null, channel: null, lastPong: 0, sent: new Map(), samples: [],
      sequence: -1, pingCount: 0, selected: false, scoring: false, deadline: setTimeout(() => retire(c), 20000) };
    candidates.set(id, c); send({ type: "voiceRelay", action: "request", id, route: target });
  }
  async function score(c: Candidate) {
    if (c.scoring || c.selected || c.samples.length < 5) return;
    c.scoring = true;
    const baseline = active && active.samples.length ? Math.max(...active.samples.slice(-5)) : await options.baseline();
    if (!current(c)) return;
    const rttMs = Math.max(...c.samples.slice(-5));
    if (baseline !== null) send({ type: "voiceRelay", action: "select", id: c.id, rttMs,
      baselineMs: Math.min(60000, baseline), loss: Math.max(0, (c.pingCount - c.samples.length - c.sent.size) / Math.max(1, c.pingCount)) });
  }
  function metrics() {
    const c = active;
    if (!c || !current(c) || c.channel?.readyState !== "open" || performance.now() - c.lastPong > 2500) return null;
    return { bufferedAmount: c.channel.bufferedAmount, rttMs: c.samples.length ? Math.max(...c.samples.slice(-5)) : null };
  }
  async function checkWss() {
    const c = active;
    if (!c || checkingWss) return;
    checkingWss = true;
    try {
      // Require three good control-path samples before abandoning a healthy relay.
      for (let n = 0; n < 3; n++) {
        const rtt = await options.baseline();
        if (active !== c || !current(c) || rtt === null || !c.samples.length
          || !preferVoiceRelay(rtt, Math.max(...c.samples.slice(-5)), 0)) return;
      }
      retire(c);
    } catch { /* Keep the working audio route when control-path measurement fails. */ }
    finally { checkingWss = false; }
  }
  function tick() {
    const now = performance.now();
    for (const c of candidates.values()) {
      if (c.channel?.readyState !== "open") continue;
      if (c.selected && now - c.lastPong > 2500) { retire(c); nextProbe = now + 1000; continue; }
      for (const [id, at] of c.sent) if (now - at > 2000) c.sent.delete(id);
      const id = ++ping; c.sent.set(id, now); c.pingCount++;
      try { c.channel.send(`ping:${id}`); } catch { retire(c); }
    }
    if (now >= nextProbe) { nextProbe = now + 25000; void checkWss(); probe(); }
  }
  async function offer(c: Candidate, message: VoiceRelayMessage) {
    if (c.pc) return;
    try {
      // Both ends need TURN: a remote relay alone cannot help a UDP-blocked browser.
      const pc = c.pc = new RTCPeerConnection({ iceServers: message.relay?.iceServers ?? [{ urls: "stun:stun.cloudflare.com:3478" }],
        iceTransportPolicy: message.relay ? "relay" : "all" });
      pc.ondatachannel = event => {
        if (!current(c) || event.channel.label !== "webspeak-voice-v1" || c.channel) { event.channel.close(); return; }
        const channel = c.channel = event.channel; channel.binaryType = "arraybuffer";
        channel.onopen = () => { if (current(c)) c.lastPong = performance.now(); };
        channel.onclose = () => { if (current(c)) retire(c); };
        channel.onmessage = event => {
          if (!current(c)) return;
          if (typeof event.data === "string") {
            const id = Number(event.data.slice(5)), at = c.sent.get(id);
            if (!event.data.startsWith("ping:") || at === undefined) return;
            c.sent.delete(id); c.lastPong = performance.now(); c.samples.push(c.lastPong - at);
            if (c.samples.length > 10) c.samples.shift();
            void score(c); return;
          }
          if (!c.selected || !(event.data instanceof ArrayBuffer) || event.data.byteLength < 8 || event.data.byteLength > 8192) return;
          const bytes = new Uint8Array(event.data), sequence = new DataView(event.data).getUint32(0);
          if (sequence === c.sequence || c.sequence >= 0 && ((sequence - c.sequence) >>> 0) > 0x7fffffff) return;
          c.sequence = sequence; options.audio(bytes.subarray(4));
        };
      };
      pc.onconnectionstatechange = () => { if (current(c) && ["failed", "closed"].includes(pc.connectionState)) retire(c); };
      await pc.setRemoteDescription({ type: "offer", sdp: message.sdp });
      if (!current(c)) return;
      await pc.setLocalDescription(await pc.createAnswer());
      if (pc.iceGatheringState !== "complete") await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(deadline); pc.removeEventListener("icegatheringstatechange", change); resolve(); };
        const change = () => { if (pc.iceGatheringState === "complete") finish(); };
        const deadline = setTimeout(finish, 3500); pc.addEventListener("icegatheringstatechange", change);
      });
      if (current(c)) send({ type: "voiceRelay", action: "answer", id: c.id, sdp: pc.localDescription!.sdp });
    } catch { if (current(c)) retire(c); }
  }
  function stop() {
    generation++; clearInterval(timer);
    for (const c of candidates.values()) retire(c);
    enabled = false; active = null; route.value = "wss";
  }
  return {
    route, metrics,
    start(relays: ScreenShareRelayId[], supported: boolean) {
      stop(); enabled = supported && typeof RTCPeerConnection !== "undefined";
      if (!enabled) return;
      available = ["direct", ...relays]; nextRoute = 0; nextProbe = 0;
      timer = setInterval(tick, 750); tick();
    },
    receive(raw: unknown): boolean {
      if (!isVoiceRelayMessage(raw)) return false;
      const c = candidates.get(raw.id); if (!c) return true;
      if (raw.action === "offer") void offer(c, raw);
      if (raw.action === "error") retire(c, false);
      if (raw.action === "selected" && current(c) && c.channel?.readyState === "open") {
        if (active && active !== c) retire(active);
        c.selected = true; active = c; route.value = c.route; clearTimeout(c.deadline);
      }
      return true;
    },
    sendAudio(bytes: Uint8Array): boolean {
      const c = active;
      if (!c || !current(c) || c.channel?.readyState !== "open" || performance.now() - c.lastPong > 2500) return false;
      if (c.channel.bufferedAmount > 4096) return true;
      const packet = new Uint8Array(bytes.length + 4); new DataView(packet.buffer).setUint32(0, sequence++ >>> 0); packet.set(bytes, 4);
      try { c.channel.send(packet); return true; } catch { retire(c); return false; }
    },
    stop,
  };
}
