import { createApp } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHistory } from "vue-router";
import { Capacitor } from "@capacitor/core";
import { Nodejs } from "@capawesome/capacitor-nodejs";
import App from "./App.vue";
import WebClient from "./views/WebClient.vue";
import AdminView from "./views/AdminView.vue";
import DemoView from "./views/DemoView.vue";
import "./services/theme.js";

const BASELINE_WIDTH = 1920;
const BASELINE_HEIGHT = 1080;
const MAX_UI_SCALE = 1.5;

function applyUiScale(): void {
  // Keep the current 1080p layout as the reference. Only enlarge the UI when
  // both viewport dimensions provide more space; smaller windows keep the
  // existing responsive rules instead of shrinking text until it becomes hard
  // to read.
  const scale = Math.min(
    MAX_UI_SCALE,
    Math.max(1, Math.min(window.innerWidth / BASELINE_WIDTH, window.innerHeight / BASELINE_HEIGHT)),
  );
  document.documentElement.style.setProperty("--ui-scale", scale.toFixed(4));
}

applyUiScale();
window.addEventListener("resize", applyUiScale, { passive: true });

const routes = [
  { path: "/", name: "webclient", component: WebClient },
  { path: "/join", name: "join", component: WebClient },
  { path: "/demo", name: "demo", component: DemoView },
  { path: "/admin/:pathMatch(.*)*", name: "admin", component: AdminView },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

if (Capacitor.isNativePlatform() && !(location.hostname === "127.0.0.1" && location.port === "3040")) {
  void startAndroidGateway();
} else {
  mountApp();
}

function mountApp(): void {
  const app = createApp(App);
  app.use(createPinia());
  app.use(router);
  app.mount("#app");
}

async function startAndroidGateway(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) return;
  root.innerHTML = '<main style="min-height:100dvh;display:grid;place-items:center;background:#e9fbfb;color:#0b5960;font:16px system-ui;text-align:center;padding:24px"><div><h1 style="font-size:26px">WebSpeak</h1><p id="mobile-gateway-status">正在启动本地语音服务…</p></div></main>';
  const status = document.getElementById("mobile-gateway-status");
  let complete = false;
  let pollTimer = 0;
  let timeoutTimer = 0;

  try {
    const listener = await Nodejs.addListener("message", (event) => {
      if (complete) return;
      if (event.eventName === "webspeak-error") {
        complete = true;
        window.clearInterval(pollTimer);
        window.clearTimeout(timeoutTimer);
        if (status) status.textContent = "本地语音服务启动失败，请重新打开应用。";
        return;
      }
      if (event.eventName !== "webspeak-health") return;
      const health = event.args[0];
      if (!health || typeof health !== "object" || Array.isArray(health) || health.ready !== true) return;
      complete = true;
      window.clearInterval(pollTimer);
      window.clearTimeout(timeoutTimer);
      void listener.remove();
      window.location.replace("http://127.0.0.1:3040/");
    });
    const poll = async () => {
      if (complete) return;
      const { ready } = await Nodejs.isReady();
      if (ready) await Nodejs.send({ eventName: "webspeak-health", args: [] });
    };
    pollTimer = window.setInterval(() => { void poll().catch(() => {}); }, 500);
    timeoutTimer = window.setTimeout(() => {
      if (complete) return;
      complete = true;
      window.clearInterval(pollTimer);
      if (status) status.textContent = "本地语音服务启动超时，请重新打开应用。";
    }, 45_000);
    await poll();
  } catch {
    complete = true;
    window.clearInterval(pollTimer);
    window.clearTimeout(timeoutTimer);
    if (status) status.textContent = "本地语音服务启动失败，请重新打开应用。";
  }
}
