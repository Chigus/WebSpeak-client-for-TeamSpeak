import { computed, nextTick, onScopeDispose, ref, watch, type Ref } from "vue";
import type { ChannelInfo, ChannelMember, ChatMessage } from "./useVoiceWebSocket.js";

export type WebClientChatTab = "channel" | "server" | "private" | "events";

interface PrivateConversation {
  id: number;
  key: string;
  name: string;
  lastMessage: number;
}

interface UseWebClientChatOptions {
  messages: ChatMessage[];
  members: ChannelMember[];
  currentChannel: Readonly<Ref<ChannelInfo | undefined>>;
  currentChannelName: Readonly<Ref<string>>;
  selectedChannelId: Ref<string>;
  clientId: Readonly<Ref<number>>;
  connected: Readonly<Ref<boolean>>;
  sessionEpoch: Readonly<Ref<number>>;
  memberConversationKey: (id: number) => string | undefined;
  isMobileViewport: Readonly<Ref<boolean>>;
  mobileSection: Ref<"channels" | "chat" | "voice" | "more">;
  closeMemberMenu: () => void;
  sendTextMessage: (text: string, targetId?: string) => Promise<void>;
  sendServerMessage: (text: string) => Promise<void>;
  sendPrivateMessage: (clientId: number, text: string, conversationId?: string, expectedKey?: string) => Promise<void>;
  notifyPrivateMessage: () => void;
  t: (key: string, variables?: Record<string, string | number>) => string;
}

export function useWebClientChat({
  messages,
  members,
  currentChannel,
  currentChannelName,
  selectedChannelId,
  clientId,
  connected,
  sessionEpoch,
  memberConversationKey,
  isMobileViewport,
  mobileSection,
  closeMemberMenu,
  sendTextMessage,
  sendServerMessage,
  sendPrivateMessage,
  notifyPrivateMessage,
  t,
}: UseWebClientChatOptions) {
  const tab = ref<WebClientChatTab>("channel");
  const privateClientId = ref(0);
  const privateConversationKey = ref("");
  const messageDraft = ref("");
  const listElement = ref<HTMLElement | null>(null);
  const sending = ref(false);
  const sendError = ref("");
  const drafts = new Map<string, string>();
  const pending = new Map<string, object>();
  const errors = new Map<string, string>();
  let disposed = false;
  const recipient = computed(() => members.find(member => member.id === privateClientId.value && memberConversationKey(member.id) === privateConversationKey.value));
  const destination = computed(() => `${sessionEpoch.value}:${tab.value}:${tab.value === "private" ? privateConversationKey.value : tab.value === "channel" ? currentChannel.value?.id ?? selectedChannelId.value : ""}`);
  const canSend = computed(() => connected.value && !sending.value && tab.value !== "events" && (tab.value !== "private" || Boolean(recipient.value)));
  const status = computed(() => sendError.value ? t(sendError.value) : sending.value ? t("chatSending")
    : !connected.value ? t("chatNotConnected") : tab.value === "private" && !recipient.value ? t("chatTargetUnavailable") : "");
  const messageKey = (message: ChatMessage) => message.conversationKey ?? `legacy:${message.id}`;

  const conversations = computed<PrivateConversation[]>(() => {
    const byConversation = new Map<string, PrivateConversation>();
    for (const message of messages) {
      if (message.scope !== "private" || !message.conversationId) continue;
      const id = Number(message.conversationId);
      if (!id) continue;
      const key = messageKey(message);
      const member = members.find(candidate => memberConversationKey(candidate.id) === key);
      const existing = byConversation.get(key);
      byConversation.set(key, {
        id: member?.id ?? id, key,
        name: member?.nickname ?? message.conversationName ?? existing?.name ?? (message.isSelf ? t("privateMessage") : message.invokerName),
        lastMessage: Math.max(existing?.lastMessage ?? 0, message.timestamp),
      });
    }
    return [...byConversation.values()].sort((left, right) => right.lastMessage - left.lastMessage);
  });

  const visibleMessages = computed(() => {
    if (tab.value === "server") return messages.filter((message) => message.scope === "server");
    if (tab.value === "private") return messages.filter(message => message.scope === "private" && messageKey(message) === privateConversationKey.value);
    if (tab.value !== "channel") return [];
    const channelId = currentChannel.value?.id;
    return messages.filter((message) => message.scope === "channel" && (!message.targetId || message.targetId === "0" || !channelId || message.targetId === channelId));
  });

  const tabLabel = computed(() => tab.value === "channel" ? t("textChannel") : tab.value === "server" ? t("serverChat") : tab.value === "private" ? t("privateMessage") : t("eventLog"));
  const title = computed(() => tab.value === "channel"
    ? t("channelChat", { channel: currentChannelName.value })
    : tab.value === "server"
      ? t("serverChat")
      : tab.value === "events"
        ? t("eventLog")
        : recipient.value?.nickname ?? conversations.value.find(conversation => conversation.key === privateConversationKey.value)?.name ?? t("privateMessage"));
  const placeholder = computed(() => tab.value === "private" ? t("privateMessagePlaceholder") : tab.value === "server" ? t("serverMessagePlaceholder") : t("sendMessagePlaceholder"));

  function scrollToEnd(): void {
    const list = listElement.value;
    if (!disposed && list) list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
  }

  function openPrivateChat(targetClientId: number): void {
    const member = members.find(candidate => candidate.id === targetClientId);
    const key = memberConversationKey(targetClientId);
    if (!member || !key || targetClientId === clientId.value) return;
    openConversation({ id: targetClientId, key, name: member.nickname, lastMessage: 0 });
  }

  function openConversation(conversation: PrivateConversation): void {
    if (disposed) return;
    privateClientId.value = conversation.id;
    privateConversationKey.value = conversation.key;
    tab.value = "private";
    if (isMobileViewport.value) mobileSection.value = "chat";
    closeMemberMenu();
    void nextTick(scrollToEnd);
  }

  async function submitMessage(): Promise<void> {
    if (disposed || sending.value || !messageDraft.value.trim() || tab.value === "events") return;
    if (!connected.value) { sendError.value = "chatNotConnected"; return; }
    if (tab.value === "private" && !recipient.value) { sendError.value = "chatTargetUnavailable"; return; }
    const text = messageDraft.value;
    const key = destination.value;
    const operation = {};
    pending.set(key, operation);
    errors.delete(key);
    const isCurrent = () => !disposed && pending.get(key) === operation;
    sending.value = true;
    sendError.value = "";
    try {
      if (tab.value === "channel") await sendTextMessage(text, currentChannel.value?.id ?? selectedChannelId.value);
      else if (tab.value === "server") await sendServerMessage(text);
      else await sendPrivateMessage(privateClientId.value, text, String(privateClientId.value), privateConversationKey.value);
      if (isCurrent()) {
        if (destination.value === key && messageDraft.value === text) messageDraft.value = "";
        else if (drafts.get(key) === text) drafts.set(key, "");
      }
    } catch (error) {
      if (isCurrent()) {
        const code = (error as { code?: string } | null)?.code;
        const feedback = code === "CLIENT_NOT_FOUND" ? "chatTargetUnavailable" : code === "CHANNEL_CHANGED" ? "chatChannelChanged" : "chatSendFailed";
        errors.set(key, feedback);
        if (destination.value === key) sendError.value = feedback;
      }
    } finally {
      if (isCurrent()) {
        pending.delete(key);
        if (destination.value === key) sending.value = false;
      }
    }
  }

  watch(destination, (next, previous) => {
    drafts.set(previous, messageDraft.value);
    messageDraft.value = drafts.get(next) ?? "";
    sending.value = pending.has(next);
    sendError.value = errors.get(next) ?? "";
  }, { flush: "sync" });
  watch(sessionEpoch, () => {
    drafts.clear();
    pending.clear();
    errors.clear();
    privateClientId.value = 0;
    privateConversationKey.value = "";
    tab.value = "channel";
    messageDraft.value = "";
    drafts.clear();
    sending.value = false;
    sendError.value = "";
  }, { flush: "sync" });
  onScopeDispose(() => { disposed = true; drafts.clear(); pending.clear(); errors.clear(); sending.value = false; });

  watch([() => messages.length, tab, privateClientId], () => { void nextTick(scrollToEnd); });
  watch(() => messages.length, (length, previousLength) => {
    const latest = messages[length - 1];
    if (latest && length > previousLength && latest.scope === "private" && !latest.isSelf) notifyPrivateMessage();
  });

  return {
    tab,
    privateClientId,
    privateConversationKey,
    sending, sendError, canSend, status,
    messageDraft,
    listElement,
    conversations,
    visibleMessages,
    tabLabel,
    title,
    placeholder,
    openPrivateChat,
    openConversation,
    submitMessage,
    scrollToEnd,
  };
}
