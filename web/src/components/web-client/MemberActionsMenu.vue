<template>
  <div v-if="memberMenu && isMobileViewport" class="member-menu-backdrop" data-ws-part="voice.context-menu-backdrop" @click="memberMenu = null"></div>
  <div v-if="memberMenu" ref="menuElement" class="member-context-menu" data-ws-part="voice.context-menu" :style="menuStyle" @click.stop>
    <div class="member-menu-header" data-ws-part="voice.context-menu.header"><strong>{{ memberMenu.member.nickname }}</strong><button type="button" class="member-menu-close" :aria-label="t('close')" @click="memberMenu = null"><Icon name="close" :size="17" /></button></div>
    <label class="menu-volume"><span>{{ t('memberVolume') }}</span><input type="range" min="0" max="400" :value="(volumes[memberMenu.member.id] ?? 1) * 100" :style="rangeStyle((volumes[memberMenu.member.id] ?? 1) / 4, 1)" :aria-label="t('memberVolume')" @input="emit('volumeInput', memberMenu.member.id, $event)" /></label>
    <button type="button" @click="emit('privateChat', memberMenu.member.id); memberMenu = null"><Icon name="message" :size="15" /> {{ t('privateMessage') }}</button>
    <button type="button" @click="pokeMember(memberMenu.member); memberMenu = null"><Icon name="bell" :size="15" /> {{ t('poke') }}</button>
    <button type="button" @click="toggleWhisperTarget(memberMenu.member); memberMenu = null"><Icon name="mic" :size="15" /> {{ whisperTargetIds.has(memberMenu.member.id) ? t('removeWhisperTarget') : t('setWhisperTarget') }}</button>
    <button type="button" @click="copyMemberName(memberMenu.member); memberMenu = null"><Icon name="copy" :size="15" /> {{ t('copyNickname') }}</button>
    <div class="member-menu-submenu" @mouseenter="!isMobileViewport && (memberMoveMenuOpen = true)">
      <button type="button" class="member-menu-submenu-trigger" :aria-expanded="memberMoveMenuOpen" @click="toggleMemberMoveMenu"><Icon name="chevron-right" :size="15" /> <span>{{ t('moveMemberMenu') }}</span><Icon name="chevron-right" :size="13" class="member-menu-submenu-arrow" /></button>
      <div v-if="memberMoveMenuOpen" ref="submenuElement" :style="submenuStyle" class="member-submenu-panel" data-ws-part="voice.context-menu.move-submenu" @click.stop>
        <button v-if="memberMoveMenuCurrentChannel" type="button" :disabled="memberMoveMenuCurrentSameChannel" @click="moveMemberDirect(memberMenu.member, memberMoveMenuCurrentChannel.id)"><Icon name="users" :size="15" /><span>{{ t('moveMemberMyChannel') }}</span><small>{{ memberMoveMenuCurrentChannel.name }}</small></button>
        <button v-for="targetChannel in memberMoveMenuOtherChannels" :key="targetChannel.id" type="button" @click="moveMemberDirect(memberMenu.member, targetChannel.id)"><Icon name="volume" :size="15" /><span>{{ targetChannel.name }}</span></button>
        <span v-if="!memberMoveMenuCurrentChannel && !memberMoveMenuOtherChannels.length" class="member-submenu-empty">{{ t('moveMemberNoChannels') }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef, watch, type CSSProperties } from "vue";
import { placeMemberMenu, placeMemberSubmenu } from "../../services/member-menu-placement.js";
import Icon from "../Icon.vue";
import type { useWebClientMembers } from "../../composables/useWebClientMembers.js";

type MemberMenuModel = Pick<ReturnType<typeof useWebClientMembers>,
  | "memberMenu"
  | "memberMoveMenuOpen"
  | "memberMoveMenuCurrentChannel"
  | "memberMoveMenuCurrentSameChannel"
  | "memberMoveMenuOtherChannels"
  | "toggleMemberMoveMenu"
  | "moveMemberDirect"
  | "pokeMember"
  | "toggleWhisperTarget"
  | "copyMemberName"
>;
const props = defineProps<{
  model: MemberMenuModel;
  isMobileViewport: boolean;
  volumes: Record<number, number>;
  whisperTargetIds: ReadonlySet<number>;
  rangeStyle: (value: number, max: number) => CSSProperties;
  t: (key: string, variables?: Record<string, string | number>) => string;
}>();
const emit = defineEmits<{
  privateChat: [clientId: number];
  volumeInput: [clientId: number, event: Event];
}>();

// Reuse the page's controller; opening chat can also close this same menu ref.
const {
  memberMenu,
  memberMoveMenuOpen,
  memberMoveMenuCurrentChannel,
  memberMoveMenuCurrentSameChannel,
  memberMoveMenuOtherChannels,
  toggleMemberMoveMenu,
  moveMemberDirect,
  pokeMember,
  toggleWhisperTarget,
  copyMemberName,
} = props.model;

const menuElement = ref<HTMLElement | null>(null);
const submenuElement = ref<HTMLElement | null>(null);
const menuStyle = shallowRef<CSSProperties>({});
const submenuStyle = shallowRef<CSSProperties>({});
let observer: ResizeObserver | undefined;

function updatePlacement(): void {
  const menu = menuElement.value;
  if (!menu || !memberMenu.value || props.isMobileViewport) {
    menuStyle.value = {};
    submenuStyle.value = {};
    return;
  }
  const scale = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")) || 1;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const bounds = menu.getBoundingClientRect();
  const point = placeMemberMenu(memberMenu.value, bounds, viewport);
  const limits: CSSProperties = {
    maxHeight: `${Math.max(0, viewport.height - 24) / scale}px`,
    maxWidth: `${Math.max(0, viewport.width - 24) / scale}px`,
    overflowY: "auto",
  };
  menuStyle.value = { ...limits, left: `${point.x / scale}px`, top: `${point.y / scale}px` };
  const submenu = submenuElement.value;
  const trigger = menu.querySelector(".member-menu-submenu-trigger");
  if (!submenu || !trigger) return;
  const anchor = trigger.getBoundingClientRect();
  // Account for the main menu position being committed in this same Vue tick.
  const submenuPoint = placeMemberSubmenu({
    left: anchor.left + point.x - bounds.left,
    right: anchor.right + point.x - bounds.left,
    top: anchor.top + point.y - bounds.top,
  }, submenu.getBoundingClientRect(), viewport, 6 * scale);
  submenuStyle.value = { ...limits, position: "fixed", right: "auto",
    left: `${submenuPoint.x / scale}px`, top: `${submenuPoint.y / scale}px` };
}

function observeElements(): void {
  observer?.disconnect();
  if (menuElement.value) observer?.observe(menuElement.value);
  if (submenuElement.value) observer?.observe(submenuElement.value);
  updatePlacement();
}
watch([menuElement, submenuElement], observeElements, { flush: "post" });
watch([memberMenu, memberMoveMenuOpen, () => props.isMobileViewport], updatePlacement, { flush: "post" });
onMounted(() => {
  observer = new ResizeObserver(updatePlacement);
  observeElements();
  window.addEventListener("resize", updatePlacement);
});
onUnmounted(() => {
  observer?.disconnect();
  window.removeEventListener("resize", updatePlacement);
});
</script>
