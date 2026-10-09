<template>
  <section
    :ref="setPlayerElement"
    class="screen-share-player"
    data-ws-part="voice.screen-player"
    role="region"
    :aria-label="t('screenShare')"
  >
    <div
      class="screen-share-player-stage"
      data-ws-part="voice.screen-player.stage"
    >
      <video
        v-if="screenShareRemoteStream"
        :ref="setScreenVideoElement"
        class="screen-share-player-video"
        data-ws-part="voice.screen-player.video"
        autoplay
        playsinline
        :muted="screenShareRemoteVolume === 0"
      ></video>
      <div
        v-else
        class="screen-share-player-placeholder"
        data-ws-part="voice.screen-player.placeholder"
        ><span class="screen-share-player-placeholder-icon"
          ><Icon
            name="monitor"
            :size="28" /></span
        ><strong>{{ t("screenShareConnecting") }}</strong
        ><span>{{ screenShareError ? screenShareErrorText : routeLabel }}</span></div
      >
      <button
        type="button"
        class="screen-share-player-exit"
        data-ws-part="voice.screen-player.exit"
        :aria-label="t('screenShareExit')"
        :title="t('screenShareExit')"
        @click="leaveScreenShare"
        ><Icon
          name="close"
          :size="22"
      /></button>
      <div
        class="screen-share-player-viewers"
        data-ws-part="voice.screen-player.viewers"
        :aria-label="t('screenShareViewers')"
      >
        <span class="screen-share-player-viewer-label"
          ><Icon
            name="users"
            :size="14"
          />
          {{ screenSharePlayerViewerCount }}</span
        >
        <span class="screen-share-player-viewer-avatars"
          ><span
            v-for="viewer in screenSharePlayerViewers"
            :key="viewer.peerId"
            class="screen-share-player-viewer-avatar"
            data-ws-part="voice.screen-player.viewer-avatar"
            :style="screenShareViewerStyle(viewer)"
            :title="viewer.nickname"
            >{{ viewer.avatar ? "" : avatarInitial(viewer.nickname) }}</span
          ></span
        >
      </div>
      <span
        class="screen-share-player-live"
        data-ws-part="voice.screen-player.live"
        ><i></i>{{ t("watchingScreenShare") }}</span
      >
      <span
        class="screen-share-player-source"
        data-ws-part="voice.screen-player.source"
        >{{ screenSharePlayerOwnerName }} · {{ routeLabel }}</span
      >
      <div
        class="screen-share-player-controls"
        data-ws-part="voice.screen-player.controls"
      >
        <label
          data-ws-part="voice.screen-player.volume"
          :title="t('screenShareVolume')"
          ><Icon
            :name="screenShareRemoteVolume === 0 ? 'volume-off' : 'volume'"
            :size="18" /><input
            type="range"
            min="0"
            max="100"
            :value="screenShareRemoteVolume * 100"
            :aria-label="t('screenShareVolume')"
            @input="onScreenShareVolume"
        /></label>
        <button
          type="button"
          data-ws-part="voice.screen-player.fullscreen"
          :aria-label="
            screenShareFullscreen ? t('screenShareExitFullscreen') : t('screenShareFullscreen')
          "
          :title="
            screenShareFullscreen ? t('screenShareExitFullscreen') : t('screenShareFullscreen')
          "
          @click="toggleScreenShareFullscreen"
          ><Icon
            :name="screenShareFullscreen ? 'fullscreen-exit' : 'fullscreen'"
            :size="19"
        /></button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import Icon from "../Icon.vue";
import type { useWebClientScreenShare } from "../../composables/useWebClientScreenShare.js";
const props = defineProps<{
  model: Pick<ReturnType<typeof useWebClientScreenShare>, "fullscreen" | "viewers" | "viewerCount" | "ownerName" | "errorText" | "setPlayerElement" | "setVideoElement" | "viewerStyle" | "setVolume" | "toggleFullscreen" | "routeLabel">;
  screenShareRemoteStream: MediaStream | null; screenShareRemoteVolume: number; screenShareError: string;
  leaveScreenShare: () => void; avatarInitial: (name: string) => string; t: (key: string) => string;
}>();
const { routeLabel } = props.model;
const { fullscreen: screenShareFullscreen, viewers: screenSharePlayerViewers, viewerCount: screenSharePlayerViewerCount, ownerName: screenSharePlayerOwnerName, errorText: screenShareErrorText, setPlayerElement, setVideoElement: setScreenVideoElement, viewerStyle: screenShareViewerStyle, setVolume: onScreenShareVolume, toggleFullscreen: toggleScreenShareFullscreen } = props.model;
</script>
