<template>
  <div class="whisper-strip" data-ws-part="voice.whisper-strip">
    <div class="whisper-strip-copy"><strong><Icon name="users" :size="15" /> {{ t('whisperTargets') }}</strong><span>{{ targets.map((member) => member.nickname).join('、') }}</span></div>
    <button type="button" class="text-button" @click="emit('clear')">{{ t('clearWhisperTargets') }}</button>
    <button type="button" class="whisper-ptt-button" :class="{ active: whisperPttActive || active }" :aria-pressed="whisperPttActive || active" @pointerdown.prevent="onWhisperPttDown" @pointerup.prevent="onWhisperPttUp" @pointercancel.prevent="onWhisperPttUp" @lostpointercapture="onWhisperPttUp" @keydown="onWhisperPttKeyDown" @keyup="onWhisperPttKeyUp" @blur="stopWhisperTalk"><Icon name="mic" :size="18" /> {{ whisperPttActive || active ? t('releaseWhisper') : t('whisperHoldToTalk') }}</button>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch } from "vue";
import Icon from "../Icon.vue";
import type { useWebClientAudioControls } from "../../composables/useWebClientAudioControls.js";

const props = defineProps<{
  targets: ReadonlyArray<{ nickname: string }>;
  active: boolean;
  enabled: boolean;
  controls: Pick<ReturnType<typeof useWebClientAudioControls>, "whisperPttActive" | "onWhisperPttDown" | "onWhisperPttUp" | "onWhisperPttKeyDown" | "onWhisperPttKeyUp" | "stopWhisperTalk">;
  t: (key: string) => string;
}>();
const { whisperPttActive, onWhisperPttDown, onWhisperPttUp, onWhisperPttKeyDown, onWhisperPttKeyUp, stopWhisperTalk } = props.controls;
const emit = defineEmits<{ clear: [] }>();
function onVisibilityChange() { if (document.hidden) stopWhisperTalk(); }
watch(() => props.enabled, enabled => { if (!enabled) stopWhisperTalk(); }, { flush: "sync" });
onMounted(() => {
  window.addEventListener("blur", stopWhisperTalk);
  document.addEventListener("visibilitychange", onVisibilityChange);
});
onBeforeUnmount(() => {
  stopWhisperTalk();
  window.removeEventListener("blur", stopWhisperTalk);
  document.removeEventListener("visibilitychange", onVisibilityChange);
});
</script>
