import { randomUUID } from "node:crypto";
import { teamSpeakTargetKey, type TeamSpeakTarget } from "../domain/teamspeak-target.js";
import { MAX_VOICE_PEERS, type PeerVoiceClientMessage, type PeerVoiceServerMessage } from "../shared/peer-voice.js";

interface Participant {
  id: string;
  target: TeamSpeakTarget;
  whisperActive: boolean;
  tsClient: { getClientId(): number; getChannelId(): bigint; isConnected(): boolean };
}
interface Membership {
  participant: Participant;
  peerId: string;
  receiving: Map<string, number>;
  windowAt: number;
  signals: number;
  rosterAt: number;
}

/** Opt-in, server/channel scoped signaling. Native audio remains the fallback. */
export class PeerVoiceCoordinator {
  private readonly memberships = new Map<string, Membership>();
  constructor(private readonly entries: ReadonlyMap<string, Participant>,
    private readonly send: (entryId: string, message: PeerVoiceServerMessage) => void,
    private readonly now: () => number = Date.now) {}
  private live(member: Membership): boolean {
    return this.entries.get(member.participant.id) === member.participant && member.participant.tsClient.isConnected();
  }
  private room(member: Membership): Membership[] {
    const entry = member.participant;
    return [...this.memberships.values()].filter(other => this.live(other)
      && teamSpeakTargetKey(other.participant.target) === teamSpeakTargetKey(entry.target)
      && other.participant.tsClient.getChannelId() === entry.tsClient.getChannelId());
  }
  refresh(): void {
    for (const [id, member] of this.memberships) {
      if (!this.live(member)) { this.memberships.delete(id); continue; }
      const room = this.room(member);
      const limited = room.length > MAX_VOICE_PEERS;
      this.send(id, { type: "peerVoiceRoster", selfPeerId: member.peerId, limited,
        peers: limited ? [] : room.filter(other => other !== member).map(other => ({ peerId: other.peerId, clientId: other.participant.tsClient.getClientId() })) });
    }
  }
  remove(entryId: string): void {
    this.memberships.delete(entryId);
    this.refresh();
  }
  handle(entry: Participant, message: PeerVoiceClientMessage): void {
    if (message.type === "peerVoiceJoin") {
      if (!message.enabled) {
        this.remove(entry.id);
        this.send(entry.id, { type: "peerVoiceRoster", selfPeerId: "", peers: [], limited: false });
        return;
      }
      if (this.entries.get(entry.id) !== entry || !entry.tsClient.isConnected()) return;
      const existing = this.memberships.get(entry.id);
      if (existing && this.now() - existing.rosterAt < 800) return;
      if (existing) existing.rosterAt = this.now();
      if (!this.memberships.has(entry.id)) this.memberships.set(entry.id, {
        participant: entry, peerId: randomUUID(), receiving: new Map(), windowAt: this.now(), signals: 0, rosterAt: this.now(),
      });
      this.refresh();
      return;
    }
    const member = this.memberships.get(entry.id);
    if (!member || member.participant !== entry || !this.live(member)) return;
    const room = this.room(member);
    if (room.length > MAX_VOICE_PEERS) { member.receiving.clear(); return; }
    if (message.type === "peerVoiceReceiving") {
      member.receiving.clear();
      for (const peerId of message.peerIds) {
        if (room.some(other => other !== member && other.peerId === peerId)) member.receiving.set(peerId, this.now() + 500);
      }
      return;
    }
    if (this.now() - member.windowAt >= 10_000) { member.windowAt = this.now(); member.signals = 0; }
    if (++member.signals > 128) return;
    const recipient = room.find(other => other !== member && other.peerId === message.targetPeerId);
    if (!recipient) return;
    this.send(recipient.participant.id, { type: "peerVoiceSignal", fromPeerId: member.peerId,
      connectionId: message.connectionId, signal: message.signal });
  }
  /** Only opted-in receivers understand the flagged fallback packet envelope. */
  route(receiverId: string, clientId: number): "normal" | "fallback" | "suppress" {
    const receiver = this.memberships.get(receiverId);
    if (!receiver || !this.live(receiver)) return "normal";
    const room = this.room(receiver);
    if (room.length > MAX_VOICE_PEERS) return "normal";
    const source = room.find(member => member !== receiver && member.participant.tsClient.getClientId() === clientId);
    // Whisper always travels through TeamSpeak's actual recipient policy.
    if (!source || source.participant.whisperActive) return "normal";
    return (receiver.receiving.get(source.peerId) ?? 0) > this.now() ? "suppress" : "fallback";
  }
}
