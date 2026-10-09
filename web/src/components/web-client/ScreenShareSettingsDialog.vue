<template>
  <div
    class="modal-backdrop screen-share-settings-backdrop"
    @click.self="emit('close')"
  >
    <section
      ref="dialog"
      tabindex="-1"
      @keydown="onDialogKeydown"
      class="screen-share-settings-modal"
      data-ws-part="voice.screen-share-settings"
      role="dialog"
      aria-modal="true"
      aria-labelledby="screen-share-settings-title"
      @click.stop
    >
      <button
        type="button"
        class="screen-share-settings-close"
        :aria-label="t('close')"
        :title="t('close')"
        @click="emit('close')"
        ><Icon
          name="close"
          :size="17"
      /></button>
      <div
        class="screen-share-settings-heading"
        data-ws-part="voice.screen-share-settings.heading"
        ><span class="card-kicker">{{ t("screenShare") }}</span
        ><h2 id="screen-share-settings-title">{{ t("screenShareSettings") }}</h2
        ><p>{{ t("screenShareSettingsHint") }}</p></div
      >
      <p class="settings-hint">{{ t("screenShareRouteAutoHint") }}</p>
      <details :open="route !== 'auto' || bitrateMode === 'manual'">
        <summary>{{ t("networkAdvanced") }}</summary>
      <div
        class="screen-share-settings-fields"
        data-ws-part="voice.screen-share-settings.fields"
      >
        <label class="screen-share-route-field">
          <span>{{ t("screenShareRoute") }}</span>
          <select v-model="route" :disabled="sharing" :aria-label="t('screenShareRoute')" aria-describedby="screen-share-route-hint">
            <option v-for="option in routeOptions" :key="option.value" :value="option.value" :disabled="!option.available">
              {{ t(option.label) }}{{ option.available ? "" : ` · ${t("screenShareRouteUnconfigured")}` }}
            </option>
          </select>
          <small id="screen-share-route-hint">{{ t(route === "auto" ? "screenShareRouteAutoHint" : route === "p2p" ? "screenShareRouteP2PHint" : "screenShareRouteRelayHint") }}</small>
        </label>
        <label
          ><span>{{ t("screenShareResolution") }}</span
          ><select
            v-model="screenShareResolutionPreset"
            :disabled="sharing"
            :aria-label="t('screenShareResolution')"
            ><option
              v-for="option in screenShareResolutionOptions"
              :key="option.value"
              :value="option.value"
              >{{ t(option.label) }}</option
            ></select
          ></label
        >
        <label
          ><span>{{ t("screenShareFrameRate") }}</span
          ><select
            v-model.number="screenShareFrameRate"
            :disabled="sharing"
            :aria-label="t('screenShareFrameRate')"
            ><option
              v-for="fps in screenShareFrameRateOptions"
              :key="fps"
              :value="fps"
              >{{ fps }} FPS</option
            ></select
          ></label
        >
        <label class="screen-share-route-field">
          <span>{{ t("screenShareBitrateMode") }}</span>
          <select v-model="bitrateMode" :disabled="applying" :aria-label="t('screenShareBitrateMode')">
            <option value="auto">{{ t("screenShareBitrateAuto") }}</option>
            <option value="manual">{{ t("screenShareBitrateManual") }}</option>
          </select>
        </label>
        <label v-if="bitrateMode === 'manual'" class="screen-share-route-field">
          <span>{{ t("screenShareBitrateLimit") }}</span>
          <select v-model.number="bitrateMbps" :disabled="applying" :aria-label="t('screenShareBitrateLimit')" aria-describedby="screen-share-bitrate-hint">
            <option v-for="rate in bitrateOptions" :key="rate" :value="rate">{{ rate }} Mbps</option>
          </select>
          <small id="screen-share-bitrate-hint">{{ t("screenShareBitrateManualHint") }}</small>
        </label>
        <label v-else class="screen-share-route-field">
          <span>{{ t("screenShareBitratePolicy") }}</span>
          <select v-model="bitratePolicy" :disabled="applying" :aria-label="t('screenShareBitratePolicy')" aria-describedby="screen-share-bitrate-hint">
            <option v-for="policy in bitratePolicies" :key="policy" :value="policy">{{ t(`screenShareBitratePolicy_${policy}`) }}</option>
          </select>
          <small id="screen-share-bitrate-hint">{{ t(`screenShareBitrateHint_${bitratePolicy}`) }}</small>
        </label>
      </div>
      <p v-if="bitrateApplyError" class="screen-share-bitrate-error" role="alert">{{ t("screenShareBitrateApplyError") }}</p>
      <p
        class="screen-share-settings-note"
        data-ws-part="voice.screen-share-settings.note"
        >{{ t(sharing ? "screenShareBitrateLiveHint" : "screenShareSettingsNote") }}</p
      >
      </details>
      <footer
        class="screen-share-settings-footer"
        data-ws-part="voice.screen-share-settings.actions"
        ><button
          type="button"
          class="text-button"
          @click="emit('close')"
          >{{ t("cancel") }}</button
        ><button
          type="button"
          class="primary-button screen-share-settings-start"
          :disabled="applying || (!sharing && !routeAvailable)"
          @click="sharing ? applyBitrate() : startScreenShareWithSettings()"
          ><Icon
            name="monitor"
            :size="14"
          />
          {{ t(applying ? "screenShareBitrateApplying" : sharing ? "screenShareBitrateApply" : "startScreenShare") }}</button
        ></footer
      >
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import Icon from "../Icon.vue";
import { useDialogFocus } from "../../composables/useDialogFocus.js";
import type { useWebClientScreenShare } from "../../composables/useWebClientScreenShare.js";
const props = defineProps<{ model: Pick<ReturnType<typeof useWebClientScreenShare>, "resolutionOptions" | "frameRateOptions" | "resolutionPreset" | "frameRate" | "startWithSettings" | "route" | "routeOptions" | "routeAvailable" | "sharing" | "bitrateMode" | "bitrateMbps" | "bitratePolicy" | "bitrateOptions" | "bitratePolicies" | "applying" | "bitrateApplyError" | "applyBitrate">; t: (key: string) => string }>();
const { sharing, bitrateMode, bitrateMbps, bitratePolicy, bitrateOptions, bitratePolicies, applying, bitrateApplyError, applyBitrate } = props.model;
const { route, routeOptions, routeAvailable } = props.model;
const { resolutionOptions: screenShareResolutionOptions, frameRateOptions: screenShareFrameRateOptions, resolutionPreset: screenShareResolutionPreset, frameRate: screenShareFrameRate, startWithSettings: startScreenShareWithSettings } = props.model;
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLElement | null>(null);
const { onDialogKeydown } = useDialogFocus(dialog, () => emit("close"));
</script>

<style scoped>
.screen-share-route-field { grid-column: 1 / -1; }
.screen-share-route-field small { color: var(--text-muted); font-size: 12px; line-height: 1.6; }
.screen-share-settings-modal { max-height: calc(100dvh - 40px); overflow-y: auto; }
.screen-share-settings-modal .screen-share-settings-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.screen-share-settings-modal .screen-share-settings-fields label { font-size: 13px; }
.screen-share-settings-modal .screen-share-settings-fields select { min-height: 40px; font-size: 14px; }
.screen-share-settings-modal .screen-share-settings-heading p,
.screen-share-settings-modal .screen-share-settings-note { font-size: 12px; line-height: 1.6; }
.screen-share-settings-fields select:disabled { opacity: 0.65; cursor: not-allowed; }
.screen-share-bitrate-error { color: var(--danger, #a52c2c); font-size: 13px; line-height: 1.6; }
@media (max-width: 600px) {
  .screen-share-settings-modal .screen-share-settings-fields select { min-height: 44px; font-size: 16px; }
  .screen-share-route-field small { font-size: 14px; }
}
</style>
