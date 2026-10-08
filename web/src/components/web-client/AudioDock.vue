<template>
  <div
    class="desktop-audio-dock"
    data-ws-part="voice.audio-dock"
    role="toolbar"
    :aria-label="t('desktopAudioControls')"
  >
    <div class="desktop-audio-dock-copy"
      ><strong>{{ t("desktopAudioControls") }}</strong
      ><span>{{
        accompanimentActive ? t("accompanimentActive") : t("desktopAudioHint")
      }}</span></div
    >
    <div class="desktop-audio-dock-actions">
      <div
        class="dock-hover-control"
        data-ws-part="voice.audio-dock.microphone"
      >
        <button
          type="button"
          class="dock-audio-button microphone-header-toggle"
          :class="{ muted: microphoneMuted }"
          :title="microphoneMuted ? t('unmuteMic') : t('muteMic')"
          :aria-label="microphoneMuted ? t('microphoneMuted') : t('microphoneActive')"
          :aria-pressed="!microphoneMuted"
          aria-haspopup="dialog"
          @click="toggleMicrophone"
          ><Icon
            :name="microphoneMuted ? 'mic-off' : 'mic'"
            :size="18"
        /></button>
        <div
          class="dock-hover-panel dock-microphone-panel"
          data-ws-part="voice.audio-dock.microphone-panel"
          role="dialog"
          :aria-label="t('microphone')"
        >
          <div class="dock-slider-heading"
            ><span>{{ t("inputVolume") }}</span
            ><strong>{{ Math.round(inputVolume * 100) }}%</strong></div
          >
          <input
            class="dock-slider"
            type="range"
            min="0"
            max="100"
            :value="inputVolume * 100"
            :style="rangeStyle(inputVolume, 1)"
            :aria-label="t('inputVolume')"
            @input="onInputVolume"
          />
          <div class="dock-panel-divider"></div>
          <label class="dock-switch-row"
            ><span
              ><strong>{{ t("inputNoiseSuppression") }}</strong></span
            ><input
              type="checkbox"
              :checked="!stereoInputEnabled && noiseSuppressionEnabled"
              :disabled="stereoInputEnabled"
              :title="stereoInputEnabled ? t('stereoInputHint') : ''"
              :aria-label="t('inputNoiseSuppression')"
              aria-describedby="dock-input-noise-status"
              @change="onNoiseSuppressionToggle"
          /></label>
          <label class="dock-noise-label" for="dock-input-noise-level">{{ t("noiseSuppressionLevel") }}</label>
          <select
            id="dock-input-noise-level"
            class="dock-noise-select"
            :value="noiseSuppressionLevel"
            :disabled="stereoInputEnabled || !noiseSuppressionEnabled"
            :aria-label="t('inputNoiseSuppressionLevel')"
            @change="onNoiseSuppressionLevelChange"
          >
            <option value="light">{{ t("noiseSuppressionLight") }}</option>
            <option value="medium">{{ t("noiseSuppressionMedium") }}</option>
            <option value="heavy">{{ t("noiseSuppressionHeavy") }}</option>
          </select>
          <p id="dock-input-noise-status" class="dock-noise-status" role="status">{{ t(inputNoiseSuppressionStatusKey) }}</p>
        </div>
      </div>
      <div
        class="dock-hover-control"
        data-ws-part="voice.audio-dock.output"
      >
        <button
          type="button"
          class="dock-audio-button"
          :class="{ muted: outputMuted }"
          :title="outputMuted ? t('unmuteOutput') : t('muteOutput')"
          :aria-label="outputMuted ? t('unmuteOutput') : t('muteOutput')"
          :aria-pressed="!outputMuted"
          aria-haspopup="dialog"
          @click="emit('outputMute')"
          ><Icon
            :name="outputMuted ? 'volume-off' : 'volume'"
            :size="18"
        /></button>
        <div
          class="dock-hover-panel dock-output-panel"
          data-ws-part="voice.audio-dock.output-panel"
          role="dialog"
          :aria-label="t('overallVolume')"
        >
          <div class="dock-slider-heading"
            ><span>{{ t("overallVolume") }}</span
            ><strong>{{ Math.round(outputVolume * 100) }}%</strong></div
          >
          <input
            class="dock-slider"
            type="range"
            min="0"
            max="100"
            :value="outputVolume * 100"
            :style="rangeStyle(outputVolume, 1)"
            :aria-label="t('overallVolume')"
            @input="onOutputVolume"
          />
          <div class="dock-panel-divider"></div>
          <label class="dock-switch-row">
            <span><strong>{{ t("receiveNoiseSuppression") }}</strong></span>
            <input
              type="checkbox"
              :checked="receiveNoiseSuppressionEnabled"
              :aria-label="t('receiveNoiseSuppression')"
              aria-describedby="dock-receive-noise-status"
              @change="onReceiveNoiseSuppressionToggle"
            />
          </label>
          <label class="dock-noise-label" for="dock-receive-noise-level">{{ t("noiseSuppressionLevel") }}</label>
          <select
            id="dock-receive-noise-level"
            class="dock-noise-select"
            :value="receiveNoiseSuppressionLevel"
            :disabled="!receiveNoiseSuppressionEnabled"
            :aria-label="t('receiveNoiseSuppressionLevel')"
            @change="onReceiveNoiseSuppressionLevelChange"
          >
            <option value="light">{{ t("noiseSuppressionLight") }}</option>
            <option value="medium">{{ t("noiseSuppressionMedium") }}</option>
            <option value="heavy">{{ t("noiseSuppressionHeavy") }}</option>
          </select>
          <p id="dock-receive-noise-status" class="dock-noise-status" role="status">{{ t(receiveNoiseSuppressionStatusKey) }}</p>
        </div>
      </div>
      <button
        type="button"
        class="dock-audio-button"
        :title="t('audioSettings')"
        :aria-label="t('audioSettings')"
        @click="emit('settings')"
        ><Icon
          name="settings"
          :size="18"
      /></button>
      <button
        type="button"
        class="dock-audio-button accompaniment-toggle"
        :class="{ active: accompanimentActive }"
        :title="accompanimentActive ? t('stopAccompaniment') : t('startAccompaniment')"
        :aria-label="accompanimentActive ? t('stopAccompaniment') : t('startAccompaniment')"
        :aria-pressed="accompanimentActive"
        @click="toggleAccompaniment"
        ><Icon
          name="music"
          :size="18"
      /></button>
    </div>
  </div>
</template>

<script setup lang="ts">
import Icon from "../Icon.vue";
import type { useVoiceWebSocket } from "../../composables/useVoiceWebSocket.js";
import type { useWebClientAudioControls } from "../../composables/useWebClientAudioControls.js";

const props = defineProps<{
  model: Pick<ReturnType<typeof useVoiceWebSocket>, "microphoneMuted" | "inputVolume" | "outputVolume" | "outputMuted" | "noiseSuppressionEnabled" | "noiseSuppressionLevel" | "receiveNoiseSuppressionEnabled" | "receiveNoiseSuppressionLevel" | "stereoInputEnabled" | "accompanimentActive">;
  controls: Pick<ReturnType<typeof useWebClientAudioControls>, "toggleMicrophone" | "onInputVolume" | "onOutputVolume" | "onNoiseSuppressionToggle" | "onNoiseSuppressionLevelChange" | "onReceiveNoiseSuppressionToggle" | "onReceiveNoiseSuppressionLevelChange" | "inputNoiseSuppressionStatusKey" | "receiveNoiseSuppressionStatusKey" | "toggleAccompaniment">;
  t: (key: string) => string;
  rangeStyle: (value: number, max: number) => Record<string, string>;
}>();
const { microphoneMuted, inputVolume, outputVolume, outputMuted, noiseSuppressionEnabled, noiseSuppressionLevel, receiveNoiseSuppressionEnabled, receiveNoiseSuppressionLevel, stereoInputEnabled, accompanimentActive } = props.model;
const { toggleMicrophone, onInputVolume, onOutputVolume, onNoiseSuppressionToggle, onNoiseSuppressionLevelChange, onReceiveNoiseSuppressionToggle, onReceiveNoiseSuppressionLevelChange, inputNoiseSuppressionStatusKey, receiveNoiseSuppressionStatusKey, toggleAccompaniment } = props.controls;
const emit = defineEmits<{ settings: []; outputMute: [] }>();
</script>

<style scoped>
.dock-noise-label {
  display: block;
  margin: 12px 0 6px;
  color: var(--text-muted);
  font-size: 11px;
}

.dock-noise-select {
  width: 100%;
  min-width: 0;
  min-height: 36px;
  padding: 6px 8px;
  color: var(--text-primary);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  font: inherit;
  font-size: 12px;
}

.dock-noise-select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.dock-noise-select:disabled,
.dock-switch-row input:disabled {
  cursor: not-allowed;
  opacity: .55;
}

.dock-noise-status {
  margin: 8px 0 0;
  color: var(--text-secondary, var(--text-primary));
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
</style>
