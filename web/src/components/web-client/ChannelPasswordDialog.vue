<template>
  <div class="modal-backdrop channel-password-backdrop" @click.self="emit('cancel')">
    <section class="channel-password-modal" ref="dialog" tabindex="-1" @keydown="onDialogKeydown" role="dialog" aria-modal="true" :aria-labelledby="'channel-password-title'" @click.stop>
      <button type="button" class="qq-modal-close" :aria-label="t('close')" :title="t('close')" @click="emit('cancel')"><Icon name="close" :size="19" /></button>
      <div class="channel-password-icon"><Icon name="lock" :size="22" /></div>
      <span class="card-kicker">{{ t('channelPasswordPrompt') }}</span>
      <h2 id="channel-password-title">{{ t('channelPasswordTitle') }}</h2>
      <p>{{ t('channelPasswordLead') }}</p>
      <form class="channel-password-form" @submit.prevent="emit('submit')">
        <label class="field-label" for="channel-password-input">{{ t('channelPasswordPrompt') }}</label>
        <div class="field-wrap"><Icon name="lock" :size="17" /><input id="channel-password-input" v-model="password" type="password" autocomplete="current-password" :placeholder="t('channelPasswordPlaceholder')" :disabled="busy" autofocus /></div>
        <div v-if="error" class="notice error-notice channel-password-error"><span class="notice-symbol">!</span><span>{{ error }}</span></div>
        <div class="channel-password-actions"><button type="button" class="text-button" :disabled="busy" @click="emit('cancel')">{{ t('channelPasswordCancel') }}</button><button type="submit" class="primary-button channel-password-submit" :disabled="busy || !password"><span v-if="busy" class="button-spinner"></span><span>{{ t('channelPasswordSubmit') }}</span><Icon v-if="!busy" name="chevron-right" :size="17" /></button></div>
      </form>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import Icon from "../Icon.vue";
import { useDialogFocus } from "../../composables/useDialogFocus.js";

defineProps<{ busy: boolean; error: string; t: (key: string) => string }>();
const password = defineModel<string>({ required: true });
const emit = defineEmits<{ cancel: []; submit: [] }>();
const dialog = ref<HTMLElement | null>(null);
const { onDialogKeydown } = useDialogFocus(dialog, () => emit("cancel"));
</script>
