/// <reference types="@capawesome/capacitor-nodejs" />
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "io.webspeak.client",
  appName: "WebSpeak",
  webDir: "dist",
  server: {
    allowNavigation: ["127.0.0.1"],
  },
  plugins: {
    Nodejs: {
      nodeDir: "nodejs",
      startMode: "auto",
    },
  },
};

export default config;
