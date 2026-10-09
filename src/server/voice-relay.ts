import { RTCPeerConnection, type RTCDataChannel } from "werift";
import { ScreenShareRelays } from "./screen-share-relays.js";
import { preferVoiceRelay, type VoiceRelayMessage, type VoiceRelayRoute } from "../shared/voice-relay.js";

interface Candidate {
  id: string; route: VoiceRelayRoute; pc: RTCPeerConnection | null; channel: RTCDataChannel | null;
  lastPing: number; sequence: number; received: number; windowAt: number;
  deadline: ReturnType<typeof setTimeout>;
}
/** Unordered, non-retransmitted audio packets preserve the original speaker,
 * codec and stereo bytes. This does not enable the optional mono RTP mixer. */
export class VoiceRelaySession {
  private candidates = new Map<string, Candidate>();
  private active: string | null = null;
  private closed = false;
  private lastRequest = -Infinity;
  private sequence = 0;
  constructor(private readonly options: {
    relays: ScreenShareRelays; current(): boolean;
    send(message: VoiceRelayMessage): void; audio(frame: Buffer): void;
  }) {}
  private current(c: Candidate) { return !this.closed && this.options.current() && this.candidates.get(c.id) === c; }
  private send(message: VoiceRelayMessage) { if (!this.closed && this.options.current()) this.options.send(message); }
  handle(message: VoiceRelayMessage): void {
    if (this.closed || !this.options.current()) return;
    const c = this.candidates.get(message.id);
    if (message.action === "stop") { this.retire(message.id); return; }
    if (message.action === "request") {
      if (Date.now() - this.lastRequest < 1000 || this.candidates.size >= 2 || c) return;
      this.lastRequest = Date.now(); void this.prepare(message.id, message.route!); return;
    }
    if (!c) return;
    if (message.action === "answer" && c.pc && c.pc.signalingState === "have-local-offer") {
      void c.pc.setRemoteDescription({ type: "answer", sdp: message.sdp! }).catch(() => this.retire(c.id));
    }
    if (message.action === "select" && c.channel?.readyState === "open" && Date.now() - c.lastPing < 2500
      && preferVoiceRelay(message.rttMs!, message.baselineMs!, message.loss!)) {
      const old = this.active; this.active = c.id;
      clearTimeout(c.deadline);
      this.send({ type: "voiceRelay", action: "selected", id: c.id, route: c.route });
      if (old && old !== c.id) this.retire(old);
    }
  }
  private async prepare(id: string, route: VoiceRelayRoute) {
    const c: Candidate = { id, route, pc: null, channel: null, lastPing: 0, sequence: -1, received: 0, windowAt: 0,
      deadline: setTimeout(() => { this.send({ type: "voiceRelay", action: "error", id }); this.retire(id); }, 20000) };
    this.candidates.set(id, c);
    try {
      const lease = route === "direct" ? null : await this.options.relays.issueAsync(route);
      if (!this.current(c)) return;
      if (route !== "direct" && !lease) throw Error("Relay unavailable");
      const pc = c.pc = new RTCPeerConnection({ iceServers: lease ? this.options.relays.gatewayIceServers(lease) : [{ urls: "stun:stun.cloudflare.com:3478" }],
        iceTransportPolicy: route === "direct" ? "all" : "relay", maxMessageSize: 8192 });
      const channel = c.channel = pc.createDataChannel("webspeak-voice-v1", { ordered: false, maxRetransmits: 0 });
      channel.onMessage.subscribe(data => {
        if (!this.current(c)) return;
        const now = Date.now();
        if (now - c.windowAt >= 1000) { c.windowAt = now; c.received = 0; }
        if (++c.received > 90) return;
        if (typeof data === "string") {
          if (/^ping:[0-9]{1,12}$/.test(data)) { c.lastPing = now; channel.send(data); }
          return;
        }
        if (this.active !== id || data.length < 10 || data.length > 3844) return;
        const sequence = data.readUInt32BE(0);
        if (c.sequence >= 0 && ((sequence - c.sequence) >>> 0) > 0x7fffffff || sequence === c.sequence) return;
        c.sequence = sequence; this.options.audio(data.subarray(4));
      });
      pc.connectionStateChange.subscribe(state => {
        if (this.current(c) && (state === "failed" || state === "closed")) {
          this.send({ type: "voiceRelay", action: "error", id }); this.retire(id);
        }
      });
      await pc.setLocalDescription(await pc.createOffer());
      if (this.current(c)) this.send({ type: "voiceRelay", action: "offer", id, route, sdp: pc.localDescription!.sdp, ...(lease ? { relay: lease } : {}) });
    } catch { if (this.current(c)) { this.send({ type: "voiceRelay", action: "error", id }); this.retire(id); } }
  }
  sendAudio(packet: Buffer): "sent" | "dropped" | false {
    const c = this.active ? this.candidates.get(this.active) : undefined;
    if (!c || !this.current(c) || c.channel?.readyState !== "open" || Date.now() - c.lastPing > 2500) return false;
    // A congested datagram queue drops stale audio rather than moving it to TCP.
    if (c.channel.bufferedAmount > 4096) return "dropped";
    const envelope = Buffer.allocUnsafe(packet.length + 4); envelope.writeUInt32BE(this.sequence++ >>> 0); packet.copy(envelope, 4);
    try { c.channel.send(envelope); return "sent"; } catch { return false; }
  }
  bufferedAmount(): number | null {
    const c = this.active ? this.candidates.get(this.active) : undefined;
    return c && this.current(c) && c.channel?.readyState === "open" && Date.now() - c.lastPing < 2500
      ? c.channel.bufferedAmount : null;
  }
  private retire(id: string) {
    const c = this.candidates.get(id); this.candidates.delete(id);
    if (this.active === id) this.active = null;
    if (!c) return;
    clearTimeout(c.deadline);
    try { c.channel?.close(); } catch {}
    void c.pc?.close().catch(() => undefined);
  }
  reset() { for (const id of this.candidates.keys()) this.retire(id); }
  close() { this.closed = true; this.reset(); }
}
