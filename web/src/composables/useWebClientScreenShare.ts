import { computed, onMounted, onBeforeUnmount, ref, watch, type Ref } from "vue";
import { isScreenShareRoute, type ScreenShareRelayId, type ScreenShareRoute } from "../../../src/shared/screen-share.js";
import type { ChannelMember, ScreenShareOutputSettings, ScreenShareStream } from "./useVoiceWebSocket.js";
import { normalizeScreenShareBitrate, SCREEN_SHARE_BITRATE_OPTIONS, type ScreenShareBitrateSettings } from "../voice/screen-share-bitrate.js";

export type ScreenShareResolutionPreset = "source" | "720p" | "1080p";

interface ScreenShareResolutionOption {
  value: ScreenShareResolutionPreset;
  width?: number;
  height?: number;
  label: string;
}

interface UseWebClientScreenShareOptions {
  relays?: Ref<ScreenShareRelayId[]>;
  sharing?: Ref<boolean>;
  updateBitrate?: (settings: ScreenShareBitrateSettings) => Promise<boolean>;
  streams: ScreenShareStream[];
  viewing: Ref<boolean>;
  viewingStreamId: Ref<string>;
  remoteStream: Ref<MediaStream | null>;
  remoteVolume: Ref<number>;
  error: Ref<string>;
  errorCode: Ref<string>;
  startScreenShare: (audio?: boolean, settings?: ScreenShareOutputSettings) => Promise<void>;
  joinScreenShare: (streamId: string) => void;
  leaveScreenShare: () => void;
  nickname: Ref<string>;
  avatarStyle: (name: string, isSelf?: boolean, avatar?: string) => Record<string, string>;
  t: (key: string) => string;
}

export function useWebClientScreenShare({
  relays = ref<ScreenShareRelayId[]>([]),
  sharing = ref(false),
  updateBitrate,
  streams,
  viewing,
  viewingStreamId,
  remoteStream,
  remoteVolume,
  error,
  errorCode,
  startScreenShare,
  joinScreenShare,
  leaveScreenShare,
  nickname,
  avatarStyle,
  t,
}: UseWebClientScreenShareOptions) {
  const videoElement = ref<HTMLVideoElement | null>(null);
  const playerElement = ref<HTMLElement | null>(null);
  const fullscreen = ref(false);
  const resolutionOptions: ScreenShareResolutionOption[] = [
    { value: "source", label: "screenShareResolutionSource" },
    { value: "720p", width: 1280, height: 720, label: "screenShareResolution720p" },
    { value: "1080p", width: 1920, height: 1080, label: "screenShareResolution1080p" },
  ];
  const frameRateOptions = [5, 10, 15, 24, 30, 60];
  const storedResolution = localStorage.getItem("webspeak:screen-share-resolution") as ScreenShareResolutionPreset | null;
  const resolutionPreset = ref<ScreenShareResolutionPreset>(resolutionOptions.some((option) => option.value === storedResolution) ? storedResolution! : "1080p");
  const storedFrameRate = Number(localStorage.getItem("webspeak:screen-share-framerate"));
  const frameRate = ref(frameRateOptions.includes(storedFrameRate) ? storedFrameRate : 15);
  const settingsOpen = ref(false);
  const storedBitrate = normalizeScreenShareBitrate({
    bitrateMode: localStorage.getItem("webspeak:screen-share-bitrate-mode") as ScreenShareBitrateSettings["bitrateMode"],
    bitrateMbps: Number(localStorage.getItem("webspeak:screen-share-bitrate-mbps")) || 12,
    bitratePolicy: localStorage.getItem("webspeak:screen-share-bitrate-policy") as ScreenShareBitrateSettings["bitratePolicy"],
  });
  const bitrateMode = ref(storedBitrate.bitrateMode), bitrateMbps = ref(storedBitrate.bitrateMbps), bitratePolicy = ref(storedBitrate.bitratePolicy);
  const bitrateOptions = SCREEN_SHARE_BITRATE_OPTIONS;
  const bitratePolicies = ["quality", "smooth", "balanced"] as const;
  const applying = ref(false), bitrateApplyError = ref(false);
  let applyGeneration = 0;
  const bitrateSettings = () => normalizeScreenShareBitrate({ bitrateMode: bitrateMode.value, bitrateMbps: bitrateMbps.value, bitratePolicy: bitratePolicy.value });
  function saveBitrate() {
    localStorage.setItem("webspeak:screen-share-bitrate-mode", bitrateMode.value);
    localStorage.setItem("webspeak:screen-share-bitrate-mbps", String(bitrateMbps.value));
    localStorage.setItem("webspeak:screen-share-bitrate-policy", bitratePolicy.value);
  }
  async function applyBitrate(): Promise<void> {
    if (applying.value || !sharing.value || !updateBitrate) return;
    const generation = ++applyGeneration;
    applying.value = true; bitrateApplyError.value = false;
    const submitted = bitrateSettings();
    try {
      const applied = await updateBitrate(submitted);
      if (generation !== applyGeneration) return;
      bitrateApplyError.value = !applied;
      if (applied) { saveBitrate(); settingsOpen.value = false; }
    } catch { if (generation === applyGeneration) bitrateApplyError.value = true; }
    finally { if (generation === applyGeneration) applying.value = false; }
  }
  watch(settingsOpen, () => { applyGeneration++; applying.value = false; bitrateApplyError.value = false; });
  watch(sharing, () => { applyGeneration++; applying.value = false; bitrateApplyError.value = false; });
  const storedRoute = localStorage.getItem("webspeak:screen-share-route");
  const route = ref<ScreenShareRoute>(isScreenShareRoute(storedRoute) ? storedRoute : "p2p");
  const routeOptions = computed(() => (["p2p", "macau", "shenzhen"] as const).map(id => ({
    value: id, label: `screenShareRoute_${id}`, available: id === "p2p" || relays.value.includes(id),
  })));
  const routeAvailable = computed(() => route.value === "p2p" || relays.value.includes(route.value));
  const activeStream = computed<ScreenShareStream | null>(() => streams.find((stream) => stream.streamId === viewingStreamId.value) ?? null);
  const viewers = computed(() => activeStream.value?.viewers.slice(-5) ?? []);
  const viewerCount = computed(() => activeStream.value?.viewerCount ?? activeStream.value?.viewers.length ?? 0);
  const ownerName = computed(() => activeStream.value?.ownerNickname ?? t("screenShare"));
  const routeLabel = computed(() => t(`screenShareRoute_${activeStream.value?.route ?? "p2p"}`));
  const errorText = computed(() => errorCode.value === "SCREEN_SHARE_NATIVE_BRIDGE_REQUIRED" ? t("screenShareNativeUnavailable")
    : errorCode.value === "SCREEN_SHARE_RELAY_UNAVAILABLE" ? t("screenShareRelayUnavailable")
    : errorCode.value === "SCREEN_SHARE_RELAY_FAILED" ? t("screenShareRelayFailed") : error.value);

  function setVideoElement(element: unknown): void {
    if (videoElement.value && videoElement.value !== element) videoElement.value.srcObject = null;
    videoElement.value = element instanceof HTMLVideoElement ? element : null;
  }

  function setPlayerElement(element: unknown): void {
    const previous = playerElement.value;
    if (previous && previous !== element && document.fullscreenElement === previous) {
      void document.exitFullscreen().catch(() => undefined);
    }
    playerElement.value = element instanceof HTMLElement ? element : null;
    syncFullscreen();
  }

  function streamForMember(member: ChannelMember): ScreenShareStream | null {
    return streams.find((stream) => {
      if (typeof stream.ownerClientId === "number") return stream.ownerClientId === member.id;
      if (stream.source === "teamspeak" && /^ts-\d+$/.test(stream.ownerPeerId)) return stream.ownerPeerId === `ts-${member.id}`;
      return stream.ownerNickname === member.nickname;
    }) ?? null;
  }

  function toggleForMember(member: ChannelMember): void {
    const stream = streamForMember(member);
    if (!stream) return;
    if (viewingStreamId.value === stream.streamId) leaveScreenShare();
    else joinScreenShare(stream.streamId);
  }

  function viewerStyle(viewer: { nickname: string; avatar?: string }) {
    return avatarStyle(viewer.nickname, viewer.nickname === nickname.value, viewer.avatar ?? "");
  }

  function setVolume(event: Event): void {
    remoteVolume.value = Math.max(0, Math.min(1, Number((event.target as HTMLInputElement).value) / 100));
  }

  function syncFullscreen(): void {
    fullscreen.value = Boolean(playerElement.value && document.fullscreenElement === playerElement.value);
  }

  async function toggleFullscreen(): Promise<void> {
    const player = playerElement.value;
    if (!player) return;
    try {
      if (document.fullscreenElement === player) await document.exitFullscreen();
      else if (player.requestFullscreen) await player.requestFullscreen();
    } catch {
      syncFullscreen();
    }
  }

  async function startWithSettings(): Promise<void> {
    if (!routeAvailable.value) return;
    const preset = resolutionOptions.find((option) => option.value === resolutionPreset.value);
    const settings: ScreenShareOutputSettings = {
      ...(preset?.width && preset.height ? { maxWidth: preset.width, maxHeight: preset.height } : {}),
      maxFrameRate: frameRate.value,
      ...(route.value !== "p2p" ? { route: route.value } : {}),
      ...bitrateSettings(),
    };
    localStorage.setItem("webspeak:screen-share-resolution", resolutionPreset.value);
    localStorage.setItem("webspeak:screen-share-framerate", String(frameRate.value));
    localStorage.setItem("webspeak:screen-share-route", route.value);
    saveBitrate();
    settingsOpen.value = false;
    await startScreenShare(true, settings);
  }

  watch([videoElement, remoteStream, remoteVolume], ([video, stream, volume]) => {
    if (!video) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    video.volume = Math.max(0, Math.min(1, volume ?? 1));
    if (stream) void video.play().catch(() => undefined);
  }, { flush: "post", immediate: true });
  watch(viewing, (isViewing) => {
    if (!isViewing && playerElement.value && document.fullscreenElement === playerElement.value) void document.exitFullscreen().catch(() => undefined);
  });

  onMounted(() => document.addEventListener("fullscreenchange", syncFullscreen));
  onBeforeUnmount(() => {
    applyGeneration++;
    document.removeEventListener("fullscreenchange", syncFullscreen);
    setVideoElement(null);
    setPlayerElement(null);
  });

  return {
    videoElement,
    playerElement,
    fullscreen,
    resolutionOptions,
    frameRateOptions,
    resolutionPreset,
    route,
    routeOptions,
    routeAvailable,
    routeLabel,
    frameRate,
    settingsOpen,
    sharing,
    bitrateMode,
    bitrateMbps,
    bitratePolicy,
    bitrateOptions,
    bitratePolicies,
    applying,
    bitrateApplyError,
    applyBitrate,
    activeStream,
    viewers,
    viewerCount,
    ownerName,
    errorText,
    setVideoElement,
    setPlayerElement,
    streamForMember,
    toggleForMember,
    viewerStyle,
    setVolume,
    syncFullscreen,
    toggleFullscreen,
    startWithSettings,
  };
}
