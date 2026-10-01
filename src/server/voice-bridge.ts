import { ScreenShareCoordinator } from "./screen-share-coordinator.js";
import { handleCommand } from "./voice-commands.js";
import { createAudioFlowStats, snapshotAudioStats, type AudioFlowStats } from "./audio-stats.js";
export type { AudioFlowStats } from "./audio-stats.js";
import { mapChannelTree, normalizeDirectorySnapshot, avatarDataUrl } from "./directory-view.js";
import type { ServerMessage } from "../shared/server-messages.js";
import { parseWebRtcClientMessage } from "../shared/webrtc.js";
import type { ChannelInfo } from "../shared/voice-models.js";
import type { ChannelMember as SharedChannelMember, ServerEvent as SharedServerEvent } from "../shared/voice-models.js";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "node:http";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { identityFromString } from "@echosixhiya/teamspeak-client";
import { DirectorySynchronizer } from "./directory-sync.js";
import { TSClient, type TSDirectorySnapshot, type TSVoiceData, type TSRawNotification } from "./ts-client.js";
import type { Logger as LoggerType } from "../logger.js";
import { clientConnectionFailureCode, describeTeamSpeakError, normalizeTeamSpeakError, type WebSpeakError } from "../errors.js";
import { formatTeamSpeakTarget, teamSpeakTargetKey, type TeamSpeakTarget } from "../domain/teamspeak-target.js";
import { JoinTicketStore, type JoinTicketPayload } from "./join-ticket.js";
import { IdentityLeaseStore } from "./identity-lease.js";
import { SessionManager, type ManagedSession, type SessionTeardownReason } from "./session-manager.js";
import { parseClientCommand } from "./voice-protocol.js";
import { isRecoverable, reconnectDelayMs, reconnectWindowOpen } from "./reconnect-policy.js";
import { WebRtcAudioSession, type WebRtcAudioOptions, type WebRtcAudioSessionOptions, type WebRtcSessionDescription } from "./webrtc-audio.js";
import type { AccelerationRelayOptions, ConfiguredAccelerationRelay } from "./acceleration-relay.js";
import { normalizeScreenShareIceServers, parseScreenShareMessage, type ScreenShareIceServer } from "./screen-share.js";
import { OpusEncoder } from "./opus-codec.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const AUDIO_FRAME_BYTES = 1_920;
// A browser audio frame is 20 ms of mono 48 kHz PCM. Keep the server-side
// WebSocket egress queue small enough that a slow browser cannot turn old
// voice into seconds of latency. Opus frames are variable-sized, so this is
// deliberately a conservative byte backpressure guard for roughly 10–20
// small Opus frames; the browser also enforces a time-based playback limit
// before scheduling decoded audio.
const MAX_SERVER_AUDIO_BUFFERED_BYTES = 4_096;

function publicFailureDetail(error: ReturnType<typeof normalizeTeamSpeakError>): string | undefined {
  const serverMessage = error.diagnostics.serverMessage?.trim();
  const serverId = error.diagnostics.id?.trim();
  const detail = [serverMessage, serverId ? `server error id=${serverId}` : ""].filter(Boolean).join("; ");
  const safe = detail.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
  return safe || undefined;
}

export interface VoiceBridgeOptions {
  joinTickets: JoinTicketStore;
  webRtc?: WebRtcAudioOptions | (() => WebRtcAudioOptions);
  screenShareIceServers?: ScreenShareIceServer[] | (() => ScreenShareIceServer[]);
  acceleration?: ConfiguredAccelerationRelay[] | (() => ConfiguredAccelerationRelay[]);
  accelerationName?: string | (() => string | undefined);
}

export interface AdminSessionSummary {
  id: string;
  nickname: string;
  target: string;
  state: string;
  createdAt: string;
  ageSeconds: number;
  tsClientId: number | null;
  channelId: string | null;
  memberCount: number;
  audio: AudioFlowStats;
}

type ChannelMember = SharedChannelMember & { uid: string };
type ServerEvent = SharedServerEvent & { kind: "joined" | "left" | "moved" | "poke" | "connection" };

interface WebClientEntry {
  id: string;
  session: ManagedSession;
  tsClient: TSClient;
  ws: WebSocket;
  nickname: string;
  rememberIdentity: boolean;
  clientIp: string;
  target: TeamSpeakTarget;
  accelerationRelay?: { name: string; target: string };
  acceleration?: AccelerationRelayOptions;
  identityLeaseKey?: string;
  webrtcPublicHost?: string;
  channelTree: ChannelInfo[];
  members: Map<number, ChannelMember>;
  avatarCache: Map<string, string | null>;
  eventLog: ServerEvent[];
  opusEncoder: OpusEncoder | null;
  opusEncoderWarnedAt: number; // Opus 编码器不可用告警的时间戳，用于限流避免反复刷屏
  whisperTargetIds: Set<number>;
  whisperActive: boolean;
  isAlive: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  audio: AudioFlowStats;
  webrtc: WebRtcAudioSession | null;
  webrtcGeneration: number;
  lastLatencyProbeAt: number;
  lastAudioStatsProbeAt: number;
  connectionFailureCode?: string;
  screenPeerId: string;
}

export class VoiceBridge {
  private readonly sessionManager = new SessionManager();
  private readonly entries = new Map<string, WebClientEntry>();
  private readonly screenShares: ScreenShareCoordinator;
  private readonly identityLeases = new IdentityLeaseStore();
  private wss: WebSocketServer | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private logger: LoggerType;

  constructor(
    private options: VoiceBridgeOptions,
    logger: LoggerType,
    private readonly createWebRtcSession: (options: WebRtcAudioSessionOptions) => WebRtcAudioSession = options => new WebRtcAudioSession(options),
  ) {
    this.logger = logger.child({ component: "voice-bridge" });
    this.screenShares = new ScreenShareCoordinator(this.entries, (entryId, message) => {
      const entry = this.entries.get(entryId);
      if (entry?.ws.readyState === WebSocket.OPEN) entry.ws.send(JSON.stringify(message));
    }, this.logger);
  }

  attach(server: Server): void {
    // Avatar data is delivered as a data URL in a memberAvatar message. Keep
    // the frame limit above the encoded avatar ceiling with room for JSON.
    this.wss = new WebSocketServer({ server, path: "/ws/voice", maxPayload: 512 * 1024 });
    this.startHeartbeat();

    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      const url = new URL(req.url ?? "/", `https://${req.headers.host ?? "localhost"}`);
      const connection = this.resolveConnection(url);
      if (!connection) {
        ws.close(4001, "Join ticket required");
        return;
      }

      const { target, serverPassword, nickname } = connection;
      const channelName = connection.channel;
      const acceleration = connection.accelerated ? this.getAccelerationOptions(connection.accelerationRelayId) : undefined;
      if (connection.accelerated && !acceleration) {
        ws.close(4006, "ACCELERATION_UNAVAILABLE");
        return;
      }
      const clientIp = resolveClientIp(req);
      const webrtcPublicHost = resolveWebRtcPublicHost(req);
      let identity;
      try {
        identity = connection.identity ? identityFromString(connection.identity) : undefined;
      } catch {
        // Send a structured failure before the close so the browser can tell
        // an invalid remembered identity apart from a real connection failure.
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "connectionFailed", code: "IDENTITY_INVALID", detail: "Invalid identity" }));
        ws.close(4003, "IDENTITY_INVALID");
        return;
      }
      const entryId = `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      let entry: WebClientEntry | null = null;
      const session = this.sessionManager.admit(entryId, async (reason) => {
        if (entry) await this.cleanupEntry(entry, reason);
      });
      if (!session) {
        this.logger.warn({ max: this.sessionManager.maxSessions }, "Max clients reached");
        ws.close(4004, "GATEWAY_FULL");
        return;
      }

      const identityLeaseKey = identity
        ? `${teamSpeakTargetKey(target)}:${identity.toString()}`
        : "";
      if (identityLeaseKey && !this.identityLeases.acquire(identityLeaseKey, entryId)) {
        this.logger.warn({ entryId, nickname, target: formatTeamSpeakTarget(target) }, "TeamSpeak identity already in use");
        void this.sessionManager.teardown(entryId, "teamSpeak-connect-failed");
        ws.close(4005, "IDENTITY_IN_USE");
        return;
      }

      this.logger.info({
        entryId,
        nickname,
        clientIp,
        channel: channelName,
        target: formatTeamSpeakTarget(target),
        ...(acceleration ? { relayName: acceleration.name, relayTarget: formatTeamSpeakTarget({ host: acceleration.relayHost, port: acceleration.relayPort }) } : {}),
      }, "WebClient connecting");
      let tsClient: TSClient;
      try {
        tsClient = new TSClient({ target, nickname, serverPassword, defaultChannel: channelName, identity, ...(acceleration ? { acceleration } : {}) }, this.logger);
      } catch (error: unknown) {
        if (identityLeaseKey) this.identityLeases.release(identityLeaseKey, entryId);
        this.logger.error({ err: error, entryId }, "Could not create TeamSpeak client");
        // A 4003 with a bare close used to be reported as "identity rejected".
        // Send a structured failure so the browser says the TeamSpeak client
        // could not be created (server down / unreachable) instead.
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "connectionFailed", code: "TEAM_SPEAK_CLIENT_UNAVAILABLE", detail: "TeamSpeak client unavailable" }));
        ws.close(4003, "TEAM_SPEAK_CLIENT_UNAVAILABLE");
        return;
      }
      entry = {
        id: entryId,
        session,
        tsClient,
        ws,
        nickname,
        rememberIdentity: connection.rememberIdentity === true,
        clientIp,
        target,
        ...(acceleration ? { accelerationRelay: { name: acceleration.name, target: formatTeamSpeakTarget({ host: acceleration.relayHost, port: acceleration.relayPort }) } } : {}),
        ...(acceleration ? { acceleration } : {}),
        ...(identityLeaseKey ? { identityLeaseKey } : {}),
        ...(webrtcPublicHost ? { webrtcPublicHost } : {}),
        channelTree: [],
        members: new Map(),
        avatarCache: new Map(),
        eventLog: [],
        opusEncoder: null,
        opusEncoderWarnedAt: 0,
        whisperTargetIds: new Set(),
        whisperActive: false,
        isAlive: true,
        reconnectTimer: null,
        audio: createAudioFlowStats(),
        webrtc: null,
        webrtcGeneration: 0,
        lastLatencyProbeAt: 0,
        lastAudioStatsProbeAt: 0,
        screenPeerId: entryId,
      };
      this.entries.set(entryId, entry!);
      try {
        entry!.opusEncoder = new OpusEncoder(48000, 1);
      } catch (error: unknown) {
        this.logger.error({ err: error, entryId }, "Could not create Opus encoder");
        void this.teardown(entryId, "teamSpeak-connect-failed");
        return;
      }

      let tsReady = false;
      let selfId = 0;
      let selfChannelId = 0n;
      let initialStateSent = false;
      let audioReady = true;
      let realtimeReady = false;
      let hasConnectedOnce = false;
      // Set when the server kicks or bans this client. The kick and the transport
      // drop can arrive in either order, so the reason is parked here and consumed
      // by whichever handler runs second.
      let pendingKickReason: WebSpeakError | null = null;
      let reconnectStartedAt = 0;
      let reconnectAttempt = 0;
      const directory = new DirectorySynchronizer();
      const avatarRequests = new Set<string>();
      let avatarRefreshTimer: ReturnType<typeof setTimeout> | null = null;
      let avatarRefreshRunning = false;

      const sendJson = (message: ServerMessage) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      };
      const addServerEvent = (kind: ServerEvent["kind"], message: string) => {
        const event: ServerEvent = {
          id: `event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          kind,
          message,
          timestamp: Date.now(),
        };
        entry!.eventLog.push(event);
        if (entry!.eventLog.length > 200) entry!.eventLog.splice(0, entry!.eventLog.length - 200);
        if (initialStateSent) sendJson({ type: "serverEvent", event });
      };
      const refreshDirectory = () => {
        const snapshot = directory.getSnapshot();
        if (!snapshot) return;
        const previousWhisperTargets = [...entry!.whisperTargetIds].sort((a, b) => a - b);
        const effectiveSelfId = selfId || tsClient.getClientId();
        const sdkChannelId = tsClient.getChannelId();
        if (selfChannelId === 0n && sdkChannelId !== 0n) selfChannelId = sdkChannelId;
        const normalizedSnapshot = normalizeDirectorySnapshot(snapshot, effectiveSelfId, selfChannelId, nickname, channelName);
        entry!.channelTree = mapChannelTree(normalizedSnapshot, entry!.avatarCache);
        entry!.members.clear();
        for (const client of normalizedSnapshot.clients) {
          const avatar = client.uid ? entry!.avatarCache.get(client.uid) : undefined;
          entry!.members.set(client.id, {
            id: client.id,
            nickname: client.nickname,
            uid: client.uid,
            ...(avatar ? { avatar } : {}),
            away: client.away,
            awayMessage: client.awayMessage,
            inputMuted: client.inputMuted,
            outputMuted: client.outputMuted,
            channelCommander: client.channelCommander,
          });
        }
        for (const clientId of entry!.whisperTargetIds) {
          if (!entry!.members.has(clientId) || clientId === effectiveSelfId) entry!.whisperTargetIds.delete(clientId);
        }
        if (!entry!.whisperTargetIds.size) entry!.whisperActive = false;
        const nextWhisperTargets = [...entry!.whisperTargetIds].sort((a, b) => a - b);
        if (initialStateSent && (previousWhisperTargets.length !== nextWhisperTargets.length || previousWhisperTargets.some((clientId, index) => clientId !== nextWhisperTargets[index]))) {
          sendJson({ type: "whisperTargets", targetIds: nextWhisperTargets, active: entry!.whisperActive });
        }
      };
      const scheduleMemberAvatarRefresh = (delayMs = 0): void => {
        if (!entry || !entry.isAlive || avatarRefreshTimer) return;
        avatarRefreshTimer = setTimeout(() => {
          avatarRefreshTimer = null;
          void refreshMemberAvatars();
        }, delayMs);
        avatarRefreshTimer.unref?.();
      };
      const refreshMemberAvatars = async (): Promise<void> => {
        if (!entry || !entry.isAlive || !tsReady || session.state !== "connected" || avatarRefreshRunning) return;
        avatarRefreshRunning = true;
        try {
          const candidates = [...entry.members.values()]
            .filter((member) => member.uid && !entry!.avatarCache.has(member.uid) && !avatarRequests.has(member.uid))
            .slice(0, 50);
          for (const member of candidates) {
            if (!entry || !entry.isAlive || !member.uid) return;
            avatarRequests.add(member.uid);
            try {
              const loaded = await tsClient.getClientAvatar(member.id, member.uid);
              const avatar = loaded ? avatarDataUrl(loaded.data) : null;
              entry.avatarCache.set(member.uid, avatar);
              const current = entry.members.get(member.id);
              if (current && current.uid === member.uid && avatar) {
                current.avatar = avatar;
                sendJson({ type: "memberAvatar", id: member.id, uid: member.uid, avatar });
              }
            } catch (error: unknown) {
              // Avatar access is optional. A permission or file-transfer failure
              // must never affect joining, directory updates, or voice traffic.
              entry.avatarCache.set(member.uid, null);
              this.logger.debug({
                entryId,
                clientId: member.id,
                uid: member.uid,
                err: error instanceof Error ? error.message : String(error),
              }, "TeamSpeak client avatar unavailable");
            } finally {
              avatarRequests.delete(member.uid);
            }
          }
        } finally {
          avatarRefreshRunning = false;
          if (entry?.isAlive && tsReady && session.state === "connected" && [...entry.members.values()].some((member) => member.uid && !entry!.avatarCache.has(member.uid))) {
            scheduleMemberAvatarRefresh(250);
          }
        }
      };
      const trackChannelEvents = (previous: unknown[], next: unknown[]) => {
        if (!initialStateSent) return;
        const before = new Map(previous.filter(isChannelRecord).map((channel) => [channel.id, channel]));
        const after = new Map(next.filter(isChannelRecord).map((channel) => [channel.id, channel]));
        for (const channel of after.values()) {
          if (!before.has(channel.id)) addServerEvent("joined", `频道「${channel.name}」已创建`);
          else if (before.get(channel.id)?.name !== channel.name) addServerEvent("moved", `频道已重命名为「${channel.name}」`);
        }
        for (const channel of before.values()) if (!after.has(channel.id)) addServerEvent("left", `频道「${channel.name}」已删除`);
      };
      const sendInitialState = () => {
        if (initialStateSent || !tsReady || !directory.ready || !realtimeReady || !audioReady || session.state !== "syncing") return;
        initialStateSent = true;
        const wasReconnecting = hasConnectedOnce;
        hasConnectedOnce = true;
        // A previous kick reason never applies to a fresh, successful session.
        pendingKickReason = null;
        reconnectAttempt = 0;
        reconnectStartedAt = 0;
        if (!wasReconnecting) {
          entry!.eventLog.push({ id: `event-${Date.now().toString(36)}-connected`, kind: "connection", message: "已连接到服务器", timestamp: Date.now() });
          this.logger.info({
            entryId: entry!.id,
            nickname: entry!.nickname,
            clientIp: entry!.clientIp,
            target: formatTeamSpeakTarget(entry!.target),
            ...(entry!.accelerationRelay ? { relayName: entry!.accelerationRelay.name, relayTarget: entry!.accelerationRelay.target } : {}),
          }, "Web client connected to TeamSpeak");
        }
        session.transition("connected");
        sendJson({
          type: "connected",
          tsClientId: selfId,
          members: Array.from(entry!.members.values()),
          serverEventLog: entry!.eventLog,
          whisperTargetIds: [...entry!.whisperTargetIds],
          whisperActive: entry!.whisperActive,
          webrtcAvailable: this.getWebRtcOptions()?.enabled === true,
          screenShareIceServers: this.getScreenShareIceServers(),
          accelerated: Boolean(entry!.acceleration),
          ...(entry!.rememberIdentity ? { identity: tsClient.getIdentityString() } : {}),
        });
        sendJson({ type: "channelList", channels: entry!.channelTree });
        if (wasReconnecting) sendJson({ type: "reconnected" });
        scheduleMemberAvatarRefresh();
      };

      const resetDirectoryForReconnect = () => {
        tsReady = false;
        void this.stopWebRtc(entry!);
        initialStateSent = false;
        selfId = 0;
        selfChannelId = 0n;
        directory.clear();
        entry!.channelTree = [];
        entry!.members.clear();
        entry!.whisperTargetIds.clear();
        entry!.whisperActive = false;
      };

      const failReconnect = (normalized: ReturnType<typeof normalizeTeamSpeakError>) => {
        if (entry!.reconnectTimer) {
          clearTimeout(entry!.reconnectTimer);
          entry!.reconnectTimer = null;
        }
        try {
          if (session.state !== "disconnecting" && session.state !== "idle") session.transition("failed");
        } catch { /* teardown below remains authoritative */ }
        const failureCode = clientConnectionFailureCode(normalized, serverPassword);
        const failureDetail = publicFailureDetail(normalized);
        entry!.connectionFailureCode = failureCode;
        sendJson({ type: "reconnectFailed", code: failureCode, ...(failureDetail ? { detail: failureDetail } : {}) });
        void this.teardown(entryId, "teamSpeak-connect-failed");
      };

      const scheduleReconnect = (normalized: ReturnType<typeof normalizeTeamSpeakError> | null) => {
        if (session.state === "disconnecting" || session.state === "idle" || session.state === "failed") return;
        if (!isRecoverable(normalized)) {
          failReconnect(normalized ?? normalizeTeamSpeakError(new Error("TeamSpeak connection failed")));
          return;
        }
        const now = Date.now();
        if (!reconnectStartedAt) reconnectStartedAt = now;
        reconnectAttempt += 1;
        if (!reconnectWindowOpen(reconnectStartedAt, now)) {
          failReconnect(normalized ?? normalizeTeamSpeakError(new Error("Reconnect window expired")));
          return;
        }
        if (session.state === "connected") session.transition("interrupted");
        if (session.state === "interrupted") session.transition("reconnecting");
        if (entry!.reconnectTimer) return;
        const delayMs = reconnectDelayMs(reconnectAttempt);
        sendJson({ type: "reconnecting", attempt: reconnectAttempt, delayMs });
        entry!.reconnectTimer = setTimeout(() => {
          entry!.reconnectTimer = null;
          if (session.state !== "reconnecting") return;
          try {
            session.transition("connecting");
            session.transition("authenticating");
          } catch {
            failReconnect(normalizeTeamSpeakError(new Error("Reconnect state initialization failed")));
            return;
          }
          void connectTeamSpeak(true);
        }, delayMs);
        entry!.reconnectTimer.unref?.();
      };

      const connectTeamSpeak = async (isReconnect: boolean): Promise<void> => {
        try {
          await tsClient.connect();
          if (session.state !== "authenticating") return;
          session.transition("syncing");
          tsReady = true;
          selfId = tsClient.getClientId();
          const sdkChannelId = tsClient.getChannelId();
          if (sdkChannelId !== 0n) selfChannelId = sdkChannelId;
          refreshDirectory();
          if (selfId > 0 && !entry!.members.has(selfId)) {
            directory.applyClientEnter({ id: selfId, nickname, channelID: selfChannelId, uid: "", type: 1, serverGroups: [] });
            refreshDirectory();
          }
          sendInitialState();
          void this.screenShares.discoverExistingStreams(entry!);
        } catch (error: unknown) {
          const normalized = normalizeTeamSpeakError(error);
          const failureCode = clientConnectionFailureCode(normalized, serverPassword);
          const failureDetail = publicFailureDetail(normalized);
          entry!.connectionFailureCode = failureCode;
          this.logger.warn({
            code: failureCode,
            normalizedCode: normalized.code,
            failureDetail: describeTeamSpeakError(normalized),
            ...(Object.keys(normalized.diagnostics).length ? { failureDiagnostics: normalized.diagnostics } : {}),
            entryId,
            reconnect: isReconnect,
            attempt: reconnectAttempt,
          }, "TS connect failed");
          if (!isReconnect) {
            try {
              if (session.state !== "disconnecting" && session.state !== "idle") session.transition("failed");
            } catch { /* teardown below remains authoritative */ }
            // Send the structured failure before closing. Some browsers and
            // reverse proxies do not preserve a WebSocket close reason, which
            // would otherwise collapse every failure into a generic message.
            sendJson({ type: "connectionFailed", code: failureCode, ...(failureDetail ? { detail: failureDetail } : {}) });
            if (ws.readyState === WebSocket.OPEN) ws.close(4003, failureCode);
            void this.teardown(entryId, "teamSpeak-connect-failed");
            return;
          }
          if (isReconnect && isRecoverable(normalized)) {
            try {
              if (session.state !== "disconnecting" && session.state !== "idle") session.transition("reconnecting");
            } catch { /* teardown below remains authoritative */ }
            scheduleReconnect(normalized);
            return;
          }
          failReconnect(normalized);
        }
      };

      // Register every directory listener before connect(). Events emitted by
      // the welcome flow are queued by DirectorySynchronizer until its
      // snapshot establishes the baseline.
      realtimeReady = true;
      tsClient.on("directorySnapshot", (snapshot: TSDirectorySnapshot) => {
        const previousChannels = entry!.channelTree;
        directory.applySnapshot(snapshot);
        refreshDirectory();
        trackChannelEvents(previousChannels, entry!.channelTree);
        sendInitialState();
        if (tsReady && initialStateSent) sendJson({ type: "channelList", channels: entry!.channelTree });
        scheduleMemberAvatarRefresh();
      });

      tsClient.on("clientEnter", (info) => {
        const candidateSelfId = tsClient.getClientId();
        if (candidateSelfId > 0 && info.id === candidateSelfId) {
          selfId = candidateSelfId;
          if (info.channelID !== undefined && info.channelID !== 0n) selfChannelId = info.channelID;
        }
        const wasKnown = entry!.members.has(info.id);
        directory.applyClientEnter(info);
        refreshDirectory();
        if (tsReady && initialStateSent) {
          sendJson({ type: "channelList", channels: entry!.channelTree });
          if (!wasKnown) sendJson({ type: "memberEnter", id: info.id, nickname: info.nickname, uid: info.uid, isSelf: info.id === selfId });
          if (!wasKnown && info.id !== selfId) addServerEvent("joined", `${info.nickname || "未知用户"} 加入了服务器`);
          scheduleMemberAvatarRefresh();
        }
      });

      tsClient.on("clientLeave", (info) => {
        this.screenShares.onClientLeave(entry!, info.id);
        const wasKnown = entry!.members.has(info.id);
        const leavingMember = entry!.members.get(info.id);
        entry!.webrtc?.setMemberVolume(info.id, 1);
        directory.applyClientLeave(info.id);
        refreshDirectory();
        if (tsReady && initialStateSent && wasKnown) {
          sendJson({ type: "memberLeave", id: info.id });
          sendJson({ type: "channelList", channels: entry!.channelTree });
          if (info.id !== selfId) addServerEvent("left", `${leavingMember?.nickname || "用户"} 离开了服务器`);
        }
      });

      tsClient.on("clientMoved", (info) => {
        if (info.targetChannelID === undefined || info.targetChannelID === 0n) return;
        this.screenShares.onClientMove(entry!, info.id, info.targetChannelID);
        const movedMember = entry!.members.get(info.id);
        if (info.id === selfId) selfChannelId = info.targetChannelID;
        directory.applyClientMoved(info.id, info.targetChannelID);
        refreshDirectory();
        if (tsReady && initialStateSent) {
          sendJson({ type: "channelList", channels: entry!.channelTree });
          if (info.id !== selfId) addServerEvent("moved", `${movedMember?.nickname || "用户"} 移动到了其他频道`);
        }
      });

      tsClient.on("clientUpdated", (info) => {
        directory.applyClientUpdated(info);
        refreshDirectory();
        if (tsReady && initialStateSent) sendJson({ type: "channelList", channels: entry!.channelTree });
      });

      tsClient.on("rawNotification", (notification: TSRawNotification) => {
        this.screenShares.handleNotification(entry!, notification);
      });

      tsClient.on("voiceData", (data: TSVoiceData) => {
        const receivedAt = Date.now();
        if (entry!.audio.tsReceiveLastAt !== null) entry!.audio.tsReceiveMaxGapMs = Math.max(entry!.audio.tsReceiveMaxGapMs, receivedAt - entry!.audio.tsReceiveLastAt);
        entry!.audio.tsReceiveFirstAt ??= receivedAt;
        entry!.audio.tsReceiveLastAt = receivedAt;
        entry!.audio.tsReceiveFrames++;
        if (ws.readyState !== WebSocket.OPEN || data.clientId === selfId) return;
        const webRtc = entry!.webrtc;
        webRtc?.pushTeamSpeakVoice(data);
        const now = receivedAt;
        if (entry!.audio.egressLastAt !== null) entry!.audio.egressMaxGapMs = Math.max(entry!.audio.egressMaxGapMs, now - entry!.audio.egressLastAt);
        entry!.audio.egressFirstAt ??= now;
        entry!.audio.egressLastAt = now;
        const sourceKey = String(data.clientId);
        entry!.audio.egressFramesByClient[sourceKey] = (entry!.audio.egressFramesByClient[sourceKey] ?? 0) + 1;
        // A negotiated WebRTC session owns the browser's realtime audio
        // egress. Do not also send the same TeamSpeak packet over the
        // reliable WebSocket, otherwise the browser plays two copies and
        // the TCP path can still accumulate stale audio behind the peer.
        if (webRtc) {
          entry!.audio.egressFrames++;
          return;
        }
        const packet = Buffer.allocUnsafe(3 + data.data.length);
        packet[0] = data.codec;
        packet.writeUInt16BE(data.clientId, 1);
        data.data.copy(packet, 3);
        const bufferedBytes = ws.bufferedAmount;
        entry!.audio.egressPeakBufferedBytes = Math.max(entry!.audio.egressPeakBufferedBytes, bufferedBytes);
        if (bufferedBytes > MAX_SERVER_AUDIO_BUFFERED_BYTES) {
          entry!.audio.egressDroppedFrames++;
          return;
        }
        try {
          ws.send(packet);
          entry!.audio.egressFrames++;
          const sentAt = Date.now();
          if (entry!.audio.egressSentLastAt !== null) entry!.audio.egressSentMaxGapMs = Math.max(entry!.audio.egressSentMaxGapMs, sentAt - entry!.audio.egressSentLastAt);
          entry!.audio.egressSentFirstAt ??= sentAt;
          entry!.audio.egressSentLastAt = sentAt;
        } catch {
          entry!.audio.egressDroppedFrames++;
        }
      });

      tsClient.on("textMessage", (message) => {
        const scope = message.targetMode === 1 ? "private" : message.targetMode === 3 ? "server" : message.targetMode === 2 ? "channel" : "server";
        const targetId = message.targetId ?? 0n;
        // TeamSpeak channel notifications omit `target`; the SDK represents
        // that as 0. Bind the broadcast to this session's current channel so
        // it remains visible now but cannot leak into another channel after a
        // later channel switch.
        const effectiveTargetId = scope === "channel" && targetId === 0n ? tsClient.getChannelId() : targetId;
        sendJson({
          type: "chatMessage",
          scope,
          ...(effectiveTargetId !== 0n ? { targetId: String(effectiveTargetId) } : {}),
          senderUid: message.invokerUid,
          timestamp: Date.now(),
          invokerName: message.invokerName,
          invokerId: message.invokerId,
          message: message.message,
        });
      });

      tsClient.on("poked", (event) => {
        sendJson({ type: "pokeReceived", invokerId: event.invokerID, invokerUid: event.invokerUID, invokerName: event.invokerName, message: event.message, timestamp: Date.now() });
        addServerEvent("poke", `${event.invokerName || "用户"} 戳了你一下`);
      });

      // 被踢/封禁对本会话是终态：把服务器给出的原因回放给浏览器并拆除会话，
      // 而不是像以前那样因原因被丢弃而反复重连、再次撞上同一踢出。
      // A kick or ban is terminal for this session: replay the reason the server
      // sent instead of reconnecting, which is what used to happen once the reason
      // message was dropped (the browser kept retrying straight into the kick).
      tsClient.on("kicked", (kick: WebSpeakError) => {
        if (!hasConnectedOnce || session.state !== "connected") return;
        pendingKickReason = kick;
        resetDirectoryForReconnect();
        const failureCode = clientConnectionFailureCode(kick, serverPassword);
        const failureDetail = publicFailureDetail(kick);
        entry!.connectionFailureCode = failureCode;
        this.logger.warn({ entryId, code: failureCode, normalizedCode: kick.code, failureDetail: describeTeamSpeakError(kick) }, "TeamSpeak session ended by kick/ban");
        sendJson({ type: "connectionFailed", code: failureCode, ...(failureDetail ? { detail: failureDetail } : {}) });
        void this.teardown(entryId, "teamSpeak-kicked");
      });

      tsClient.on("disconnected", (error?: Error) => {
        if (!hasConnectedOnce || session.state !== "connected") return;
        this.screenShares.removePeer(entryId);
        resetDirectoryForReconnect();
        // Prefer a kick reason over the generic transport error that follows it,
        // regardless of which of the two events arrives first.
        const normalized = pendingKickReason ?? (error ? normalizeTeamSpeakError(error) : null);
        pendingKickReason = null;
        sendJson({ type: "disconnected", recoverable: isRecoverable(normalized) });
        scheduleReconnect(normalized);
      });

      ws.on("pong", () => { if (entry) entry.isAlive = true; });
      ws.on("message", (data: Buffer | string, isBinary: boolean) => {
        if (isBinary) {
          const frame = typeof data === "string" ? Buffer.from(data) : data;
          if (!tsReady || frame.length !== AUDIO_FRAME_BYTES) {
            entry!.audio.ingressDroppedFrames++;
            sendProtocolError(sendJson, "INVALID_AUDIO_FRAME", "音频帧格式无效");
            return;
          }
          const now = Date.now();
          if (entry!.audio.ingressLastAt !== null) entry!.audio.ingressMaxGapMs = Math.max(entry!.audio.ingressMaxGapMs, now - entry!.audio.ingressLastAt);
          entry!.audio.ingressFirstAt ??= now;
          entry!.audio.ingressLastAt = now;
          entry!.audio.ingressFrames++;
          const encodeStartedAt = Date.now();
          try {
            if (entry!.opusEncoder) {
              const encoded = entry!.opusEncoder.encode(frame);
              const encodedAt = Date.now();
              entry!.audio.tsEncodeMaxMs = Math.max(entry!.audio.tsEncodeMaxMs, encodedAt - encodeStartedAt);
              if (entry!.whisperActive && entry!.whisperTargetIds.size) tsClient.sendWhisper(encoded, [...entry!.whisperTargetIds], 4);
              else tsClient.sendVoice(encoded, 4);
              const sentAt = Date.now();
              if (entry!.audio.tsSendLastAt !== null) entry!.audio.tsSendMaxGapMs = Math.max(entry!.audio.tsSendMaxGapMs, sentAt - entry!.audio.tsSendLastAt);
              entry!.audio.tsSendFirstAt ??= sentAt;
              entry!.audio.tsSendLastAt = sentAt;
              entry!.audio.tsSendFrames++;
            } else {
              // Opus 编码器不可用（初始化失败或销毁后仍有帧在途）：显式告知浏览器
              // 而不是静默丢帧，5 秒限流避免高频告警刷屏。
              // The Opus encoder is unavailable (init failed or torn down while
              // frames are still in flight): say it instead of dropping silently.
              const warnedAt = entry!.opusEncoderWarnedAt;
              if (Date.now() - warnedAt > 5_000) {
                entry!.opusEncoderWarnedAt = Date.now();
                sendJson({ type: "audioError", code: "AUDIO_ENCODER_UNAVAILABLE", detail: "Opus encoder unavailable" });
              }
            }
          } catch {
            // A frame arriving during shutdown is safe to discard.
            entry!.audio.tsSendErrors++;
          }
          return;
        }

        const rawMessage = typeof data === "string" ? data : data.toString("utf-8");
        const webRtcMessage = parseWebRtcClientMessage(rawMessage);
        if (webRtcMessage?.type === "webrtcOffer") {
          if (this.getWebRtcOptions()?.enabled !== true) {
            sendProtocolError(sendJson, "WEBRTC_DISABLED", "WebRTC 音频传输未启用");
            return;
          }
          if (!tsReady || session.state !== "connected") {
            sendProtocolError(sendJson, "SESSION_NOT_READY", "TeamSpeak 会话尚未就绪");
            return;
          }
          const { sdp, muted, accompanimentActive } = webRtcMessage.payload;
          void this.handleWebRtcOffer(entry!, { ...sdp, muted, accompanimentActive }, sendJson);
          return;
        }
        if (webRtcMessage?.type === "webrtcStop") {
          void this.stopWebRtc(entry!);
          return;
        }
        const screenShareMessage = parseScreenShareMessage(rawMessage);
        if (screenShareMessage) {
          if ("error" in screenShareMessage) {
            sendProtocolError(sendJson, screenShareMessage.error.code, screenShareMessage.error.message);
            return;
          }
          if (!tsReady || session.state !== "connected") {
            sendProtocolError(sendJson, "SESSION_NOT_READY", "TeamSpeak 会话尚未就绪");
            return;
          }
          this.screenShares.handleMessage(entry!, screenShareMessage, sendJson);
          return;
        }
        const command = parseClientCommand(rawMessage);
        if ("error" in command) {
          sendProtocolError(sendJson, command.error.code, command.error.message);
          return;
        }
        if (!tsReady || session.state !== "connected") {
          sendProtocolError(sendJson, "SESSION_NOT_READY", "TeamSpeak 会话尚未就绪");
          return;
        }
        void handleCommand(entry!, command, sendJson);
      });

      ws.on("close", () => {
        this.logger.info({ entryId }, "WebSocket closed");
        void this.teardown(entryId, "websocket-close");
      });

      ws.on("error", (error) => {
        this.logger.error({ err: error, entryId }, "WebSocket error");
        void this.teardown(entryId, "websocket-error");
      });

      try {
        session.transition("connecting");
        session.transition("authenticating");
      } catch (error: unknown) {
        this.logger.error({ err: error instanceof Error ? error.message : String(error), entryId }, "Session state initialization failed");
        void this.teardown(entryId, "protocol-error");
        return;
      }

      void connectTeamSpeak(false);
    });

    this.wss.on("error", (error) => {
      this.logger.error({ err: error }, "Voice WebSocket server error");
    });
    this.logger.info("Voice WebSocket endpoint ready at /ws/voice");
  }

  async shutdown(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    await this.sessionManager.shutdown("gateway-shutdown");
    const wss = this.wss;
    this.wss = null;
    if (!wss) return;
    await new Promise<void>((resolve) => {
      try { wss.close(() => resolve()); } catch { resolve(); }
    });
  }

  getActiveCount(): number {
    return this.sessionManager.activeCount;
  }

  getPeakCount(): number {
    return this.sessionManager.peakCount;
  }

  getCreatedCount(): number {
    return this.sessionManager.createdCount;
  }

  getSessionSummaries(): AdminSessionSummary[] {
    const now = Date.now();
    return [...this.entries.values()]
      .sort((left, right) => left.session.createdAt - right.session.createdAt)
      .map((entry) => {
        let tsClientId: number | null = null;
        let channelId: string | null = null;
        try { tsClientId = entry.tsClient.getClientId() || null; } catch { /* still connecting */ }
        try {
          const id = entry.tsClient.getChannelId();
          channelId = id === 0n ? null : id.toString();
        } catch { /* still connecting */ }
        return {
          id: entry.id,
          nickname: entry.nickname,
          target: formatTeamSpeakTarget(entry.target),
          state: entry.session.state,
          createdAt: new Date(entry.session.createdAt).toISOString(),
          ageSeconds: Math.max(0, Math.floor((now - entry.session.createdAt) / 1000)),
          tsClientId,
          channelId,
          memberCount: entry.members.size,
          audio: snapshotAudioStats(entry),
        };
      });
  }

  async terminateSession(entryId: string): Promise<boolean> {
    if (!this.entries.has(entryId)) return false;
    await this.sessionManager.teardown(entryId, "admin-terminated");
    return true;
  }

  private async teardown(entryId: string, reason: SessionTeardownReason): Promise<void> {
    await this.sessionManager.teardown(entryId, reason);
  }

  private async cleanupEntry(entry: WebClientEntry, reason: SessionTeardownReason): Promise<void> {
    this.screenShares.removePeer(entry.id);
    if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
    entry.opusEncoder?.dispose();
    entry.opusEncoder = null;
    await this.stopWebRtc(entry);
    entry.whisperTargetIds.clear();
    entry.whisperActive = false;
    entry.channelTree = [];
    entry.members.clear();
    entry.tsClient.removeAllListeners();
    try { await entry.tsClient.disconnect(); } catch { /* disconnect is intentionally idempotent */ }
    entry.ws.removeAllListeners();
    if (entry.ws.readyState === WebSocket.OPEN || entry.ws.readyState === WebSocket.CONNECTING) {
      if (reason === "heartbeat-timeout" || reason === "gateway-shutdown") entry.ws.terminate();
      else entry.ws.close(reason === "protocol-error" ? 1008 : 1000, reason);
    }
    if (entry.identityLeaseKey) this.identityLeases.release(entry.identityLeaseKey, entry.id);
    this.logger.info({
      entryId: entry.id,
      nickname: entry.nickname,
      clientIp: entry.clientIp,
      target: formatTeamSpeakTarget(entry.target),
      ...(entry.accelerationRelay ? { relayName: entry.accelerationRelay.name, relayTarget: entry.accelerationRelay.target } : {}),
      reason,
      ...(entry.connectionFailureCode ? { failureCode: entry.connectionFailureCode } : {}),
      durationSeconds: Math.max(0, Math.floor((Date.now() - entry.session.createdAt) / 1000)),
      audio: { ...entry.audio },
    }, "Client session torn down");
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      for (const entry of this.entries.values()) {
        if (entry.ws.readyState !== WebSocket.OPEN) continue;
        if (!entry.isAlive) {
          entry.ws.terminate();
          void this.teardown(entry.id, "heartbeat-timeout");
          continue;
        }
        entry.isAlive = false;
        entry.ws.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private resolveConnection(url: URL): JoinTicketPayload | null {
    const token = url.searchParams.get("ticket");
    return token ? this.options.joinTickets.consume(token) : null;
  }

  private getWebRtcOptions(): WebRtcAudioOptions | undefined {
    const configured = this.options.webRtc;
    return typeof configured === "function" ? configured() : configured;
  }

  private getScreenShareIceServers(): ScreenShareIceServer[] {
    const configured = this.options.screenShareIceServers;
    const servers = typeof configured === "function" ? configured() : configured;
    return normalizeScreenShareIceServers(servers);
  }

  private getAccelerationOptions(relayId = ""): ConfiguredAccelerationRelay | undefined {
    const configured = this.options.acceleration;
    const relays = typeof configured === "function" ? configured() : configured;
    if (!relays?.length) return undefined;
    const selected = relayId ? relays.find((relay) => relay.id === relayId) : relays[0];
    if (!selected) return undefined;
    return selected;
  }

  private async stopWebRtc(entry: WebClientEntry): Promise<void> {
    const generation = ++entry.webrtcGeneration;
    const peer = entry.webrtc;
    entry.webrtc = null;
    if (!peer) return;
    try { await peer.close(); } catch { /* peer teardown is idempotent */ }
    if (entry.webrtcGeneration === generation) Object.assign(entry.audio, peer.getStats());
  }

  private async handleWebRtcOffer(
    entry: WebClientEntry,
    offer: WebRtcSessionDescription,
    sendJson: (message: ServerMessage) => void,
  ): Promise<void> {
    const closing = this.stopWebRtc(entry);
    const generation = entry.webrtcGeneration;
    const isCurrent = (): boolean => entry.webrtcGeneration === generation
      && this.entries.get(entry.id) === entry && entry.session.state === "connected"
      && entry.ws.readyState === WebSocket.OPEN;
    await closing;
    if (!isCurrent()) return;
    const config = this.getWebRtcOptions();
    if (!config?.enabled) return;
    const muted = offer.muted === true;
    try {
      // The offer carries the browser's initial mute state. WebRTC can silence
      // the browser track locally, but TeamSpeak clients only see the state
      // after the gateway updates its own TS client as well.
      await entry.tsClient.setInputMuted(muted);
    } catch (error: unknown) {
      if (isCurrent()) this.logger.warn({ entryId: entry.id, muted, err: error instanceof Error ? error.message : String(error) }, "Could not synchronize initial microphone mute state");
    }
    if (!isCurrent()) return;
    let peer: WebRtcAudioSession | null = null;
    const isCurrentPeer = (): boolean => isCurrent() && peer !== null && entry.webrtc === peer;
    try {
      peer = this.createWebRtcSession({
        connectionId: entry.id,
        ...(entry.webrtcPublicHost ? { publicHost: entry.webrtcPublicHost } : {}),
        udpPortRange: config.udpPortRange,
        logger: this.logger,
        microphoneMuted: muted,
        accompanimentActive: offer.accompanimentActive === true,
        onVoiceFrame: (data, codec) => {
          if (!isCurrentPeer()) return;
          const now = Date.now();
          if (entry.audio.ingressLastAt !== null) entry.audio.ingressMaxGapMs = Math.max(entry.audio.ingressMaxGapMs, now - entry.audio.ingressLastAt);
          entry.audio.ingressFirstAt ??= now;
          entry.audio.ingressLastAt = now;
          entry.audio.ingressFrames++;
          try {
            if (entry.whisperActive && entry.whisperTargetIds.size) entry.tsClient.sendWhisper(data, [...entry.whisperTargetIds], codec);
            else entry.tsClient.sendVoice(data, codec);
            const sentAt = Date.now();
            if (entry.audio.tsSendLastAt !== null) entry.audio.tsSendMaxGapMs = Math.max(entry.audio.tsSendMaxGapMs, sentAt - entry.audio.tsSendLastAt);
            entry.audio.tsSendFirstAt ??= sentAt;
            entry.audio.tsSendLastAt = sentAt;
            entry.audio.tsSendFrames++;
          } catch {
            entry.audio.tsSendErrors++;
            // A packet arriving while the TeamSpeak session is being replaced
            // is discarded; the WebRTC peer remains independently closable.
          }
        },
        onVoiceActivity: (clientIds) => {
          if (isCurrentPeer()) sendJson({ type: "voiceActivity", clientIds });
        },
      });
      entry.webrtc = peer;
      const answer = await peer.createAnswer({ type: offer.type, sdp: offer.sdp });
      if (!isCurrentPeer()) {
        try { await peer.close(); } catch { /* a replaced peer may already be closed */ }
        return;
      }
      sendJson({ type: "webrtcAnswer", payload: { sdp: answer } });
      this.logger.info({ entryId: entry.id }, "WebRTC audio negotiation completed");
    } catch (error: unknown) {
      if (entry.webrtc === peer) entry.webrtc = null;
      try { await peer?.close(); } catch { /* best effort */ }
      if (isCurrent()) {
        this.logger.warn({ entryId: entry.id, err: error instanceof Error ? error.message : String(error) }, "WebRTC audio negotiation failed");
        sendJson({ type: "webrtcError", code: "WEBRTC_NEGOTIATION_FAILED" });
      }
    }
  }
}

function resolveWebRtcPublicHost(request: IncomingMessage): string | undefined {
  const origin = firstHeader(request.headers.origin);
  const forwardedHost = firstHeader(request.headers["x-forwarded-host"]);
  const directHost = firstHeader(request.headers.host);
  for (const candidate of [origin, forwardedHost, directHost]) {
    const host = normalizeWebRtcHost(candidate);
    if (host) return host;
  }
  return undefined;
}

function resolveClientIp(request: IncomingMessage): string {
  const candidates = [
    firstHeader(request.headers["x-forwarded-for"])?.split(",", 1)[0],
    firstHeader(request.headers["x-real-ip"]),
    request.socket.remoteAddress,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeClientIp(candidate);
    if (normalized) return normalized;
  }
  return "unknown";
}

function normalizeClientIp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) trimmed = trimmed.slice(1, -1);
  if (trimmed.toLowerCase().startsWith("::ffff:")) {
    const mapped = trimmed.slice("::ffff:".length);
    if (isIP(mapped) === 4) trimmed = mapped;
  }
  return isIP(trimmed) ? trimmed : undefined;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeWebRtcHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.split(",", 1)[0]?.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return undefined;
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return parsed.hostname || undefined;
  } catch {
    return undefined;
  }
}

function sendProtocolError(sendJson: (message: ServerMessage) => void, code: string, message: string): void {
  sendJson({ type: "error", error: { code, message, recoverable: false } });
}

function isChannelRecord(value: unknown): value is { id: string; name: string } {
  return Boolean(value) && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" && typeof (value as { name?: unknown }).name === "string";
}
