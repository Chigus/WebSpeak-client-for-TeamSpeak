import { reactive, ref } from "vue";
import type { ServerMessage } from "../../../src/shared/server-messages.js";
import type { ChannelInfo, ChannelMember, ChatMessage, ServerEvent } from "../../../src/shared/voice-models.js";

interface SessionStateOptions {
  selfId(): number;
  onMemberRemoved(id: number): void;
  onMembersChanged(): void;
}

export function createVoiceSessionState(options: SessionStateOptions) {
  const epoch = ref(0);
  const members = reactive<ChannelMember[]>([]);
  const channels = reactive<ChannelInfo[]>([]);
  const chatMessages = reactive<ChatMessage[]>([]);
  const serverEvents = reactive<ServerEvent[]>([]);
  const pokeNotifications = reactive<{ id: string; invokerId: number; invokerUid: string; invokerName: string; message: string; timestamp: number }[]>([]);
  let sequence = 0;
  const memberKeys = reactive(new Map<number, string>());
  const unknownSenders = new Map<number, string>();
  const nextId = (kind: string) => `${kind}-${epoch.value}-${sequence++}`;
  const normalize = (member: ChannelMember): ChannelMember => ({ ...member, isSelf: member.id === options.selfId() });
  function conversationKey(id: number, uid?: string): string {
    if (uid) return `uid:${uid}`;
    const key = memberKeys.get(id) ?? nextId("member");
    memberKeys.set(id, key);
    return key;
  }
  function incomingConversationKey(id: number, uid?: string): string {
    if (uid) return `uid:${uid}`;
    const known = memberKeys.get(id);
    if (known) return known;
    const key = unknownSenders.get(id) ?? nextId("unknown-member");
    unknownSenders.set(id, key);
    return key;
  }

  function replaceMembers(next: ChannelMember[]): void {
    const byId = new Map(next.map(member => [member.id, normalize(member)]));
    for (const member of members) {
      const replacement = byId.get(member.id);
      if (!replacement || replacement.uid !== member.uid) {
        options.onMemberRemoved(member.id);
        memberKeys.delete(member.id);
      }
    }
    for (const member of byId.values()) memberKeys.set(member.id, conversationKey(member.id, member.uid));
    members.splice(0, members.length, ...byId.values());
    options.onMembersChanged();
  }

  function applyChannels(snapshot: ChannelInfo[]): void {
    // Current gateways send complete directories. Older gateways may omit a
    // channel's members; absence is unknown, not an authoritative empty list.
    const complete = snapshot.every(channel => Array.isArray(channel.members));
    const next = new Map((complete ? [] : members).map(member => [member.id, member]));
    for (const channel of snapshot) {
      for (const member of channel.members ?? []) next.set(member.id, member);
    }
    const previous = new Map(channels.map(channel => [channel.id, channel]));
    replaceMembers([...next.values()]);
    const canonical = new Map(members.map(member => [member.id, member]));
    const nextChannels = snapshot.map(channel => {
      const known = channel.members ?? previous.get(channel.id)?.members;
      return { ...channel, ...(known ? { members: known.flatMap(member => {
        const current = canonical.get(member.id);
        return current ? [current] : [];
      }) } : {}) };
    });
    channels.splice(0, channels.length, ...nextChannels);
  }

  function enter(member: ChannelMember): void {
    const index = members.findIndex(candidate => candidate.id === member.id);
    const previous = members[index];
    const sameIdentity = previous && previous.uid === member.uid;
    const current = normalize(sameIdentity ? { ...previous, ...member } : member);
    if (previous && !sameIdentity) {
      options.onMemberRemoved(member.id);
      memberKeys.delete(member.id);
    }
    memberKeys.set(member.id, conversationKey(member.id, member.uid));
    if (index < 0) members.push(current);
    else members.splice(index, 1, current);
    const canonical = members[index < 0 ? members.length - 1 : index];
    for (const channel of channels) {
      const position = channel.members?.findIndex(candidate => candidate.id === member.id) ?? -1;
      if (position >= 0) channel.members!.splice(position, 1, canonical);
    }
    options.onMembersChanged();
  }

  function leave(id: number): void {
    options.onMemberRemoved(id);
    memberKeys.delete(id);
    unknownSenders.delete(id);
    const index = members.findIndex(member => member.id === id);
    if (index >= 0) members.splice(index, 1);
    for (const channel of channels) {
      if (channel.members) channel.members.splice(0, channel.members.length, ...channel.members.filter(member => member.id !== id));
    }
    options.onMembersChanged();
  }

  function connected(message: Extract<ServerMessage, { type: "connected" }>): void {
    // A new TeamSpeak connection invalidates its old directory, even when a
    // legacy connected message omits members. Same-socket chat history remains.
    channels.length = 0;
    memberKeys.clear();
    unknownSenders.clear();
    replaceMembers(message.members ?? []);
    serverEvents.splice(0, serverEvents.length, ...(message.serverEventLog ?? []));
    pokeNotifications.length = 0;
  }

  function receive(message: ServerMessage): boolean {
    switch (message.type) {
      case "memberEnter": {
        const { type: _type, ...member } = message;
        enter(member);
        break;
      }
      case "memberLeave": leave(message.id); break;
      case "channelList": applyChannels(message.channels); break;
      case "memberAvatar": {
        const member = members.find(candidate => candidate.id === message.id && (!message.uid || candidate.uid === message.uid));
        if (member) member.avatar = message.avatar || undefined;
        break;
      }
      case "chatMessage": {
        if (message.invokerId === options.selfId()) break;
        const scope = message.scope === "channel" || message.scope === "server" || message.scope === "private" ? message.scope : "system";
        const targetId = message.targetId === undefined ? "" : String(message.targetId);
        chatMessages.push({ id: nextId("remote"), scope,
          ...(targetId && targetId !== "0" ? { targetId } : {}),
          ...(scope === "private" ? { conversationId: String(message.invokerId || 0),
            conversationKey: incomingConversationKey(message.invokerId || 0, message.senderUid),
            conversationName: message.invokerName || "Unknown" } : {}),
          senderId: message.invokerId, senderUid: message.senderUid, invokerName: message.invokerName || "Unknown",
          message: message.message, timestamp: message.timestamp ?? Date.now(),
        });
        break;
      }
      case "serverEvent": serverEvents.push(message.event); break;
      case "pokeReceived":
        pokeNotifications.push({ id: nextId("poke"), invokerId: message.invokerId || 0,
          invokerUid: message.invokerUid || "", invokerName: message.invokerName || "Unknown",
          message: message.message, timestamp: message.timestamp ?? Date.now() });
        break;
      default: return false;
    }
    return true;
  }

  function appendLocal(message: Omit<ChatMessage, "id" | "timestamp" | "isSelf">): void {
    chatMessages.push({ ...message, id: nextId("self"), timestamp: Date.now(), isSelf: true });
  }

  function reset(): void {
    epoch.value++;
    replaceMembers([]);
    memberKeys.clear();
    unknownSenders.clear();
    channels.length = 0;
    chatMessages.length = 0;
    serverEvents.length = 0;
    pokeNotifications.length = 0;
  }

  return { epoch, members, channels, chatMessages, serverEvents, pokeNotifications, connected, receive, appendLocal, reset,
    memberConversationKey: (id: number) => memberKeys.get(id) };
}
