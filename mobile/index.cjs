const path = require("node:path");
const os = require("node:os");
let app;
let channel;
try {
  ({ app, channel } = require("bridge"));
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
  app = { datadir: () => path.join(os.tmpdir(), "webspeak-android-gateway-dev") };
  channel = { on: () => {}, post: () => {} };
}

process.env.WEBSPEAK_MOBILE = "1";
process.env.WEBSPEAK_DATA_DIR = app.datadir();
process.env.WEBSPEAK_MOBILE_WWW = path.join(__dirname, "www");
process.env.WEBSPEAK_VERSION = require("./package.json").version;

let gatewayReady = false;
const gatewayPort = Number(process.env.WEBSPEAK_MOBILE_PORT || 3040);
channel.on("webspeak-health", () => {
  channel.post("webspeak-health", { ready: gatewayReady, port: gatewayPort });
});

import("./dist/mobile/index.js")
  .then(() => {
    gatewayReady = true;
    channel.post("webspeak-health", { ready: true, port: gatewayPort });
  })
  .catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error("WebSpeak mobile gateway failed:", message);
    channel.post("webspeak-error", { message });
  });
