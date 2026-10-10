import { createScreenShareController } from "../../web/src/voice/screen-share.js";
const output = document.querySelector("pre")!;
const canvas = document.querySelector("canvas")!;
canvas.width = 1920; canvas.height = 1080;
const context = canvas.getContext("2d")!;
let tick = 0;
const draw = () => {
  context.fillStyle = "#152238"; context.fillRect(0, 0, 1920, 1080);
  context.fillStyle = "white"; context.font = "64px sans-serif";
  context.fillText(`WebSpeak Piik synthetic frame ${tick++}`, 60, 140);
  context.fillStyle = "#65d7ae"; context.fillRect((tick * 23) % 1720, 300, 200, 500);
};
draw();
const source = canvas.captureStream(30);
const originalSettings = source.getVideoTracks()[0]!.getSettings.bind(source.getVideoTracks()[0]);
// Synthetic display stand-in: exercise the real raw-frame pipe without
// capturing a physical desktop or microphone.
source.getVideoTracks()[0]!.getSettings = () => ({ ...originalSettings(), displaySurface: "monitor" });
const controllers = new Map<string, ReturnType<typeof createScreenShareController>>();
const description = { streamId: "synthetic", ownerPeerId: "host", ownerNickname: "Synthetic", name: "Synthetic test", source: "browser" as const, audio: false, createdAt: Date.now(), viewerCount: 2, route: "p2p" as const };
for (const id of ["host", "viewer1", "viewer2"]) {
  const controller = createScreenShareController({ isOpen: () => true, send: message => {
    queueMicrotask(() => {
      if (message.type === "screenShareStart") controller.handleMessage({ type: "screenShareStarted", owner: true, requestId: message.requestId, stream: description });
      if (message.type === "screenShareJoin") controller.handleMessage({ type: "screenShareJoined", stream: description });
      if (message.type === "screenShareSignal") controllers.get(message.targetPeerId)?.handleMessage({ type: "screenShareSignal", streamId: description.streamId, fromPeerId: id, signal: message.signal });
    });
  } });
  controller.setIceServers([{ urls: ["stun:127.0.0.1:9"] }]);
  controllers.set(id, controller);
}
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
document.querySelector("button")!.addEventListener("click", async () => {
  document.querySelector("button")!.disabled = true;
  const timer = setInterval(draw, 1000 / 30);
  const previousCapture = navigator.mediaDevices.getDisplayMedia;
  navigator.mediaDevices.getDisplayMedia = async () => source;
  try {
    output.textContent = "Running synthetic WebSpeak controller + two real P2P receivers...";
    const host = controllers.get("host")!;
    await host.api.startScreenShare(false, { route: "p2p", maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30, bitratePolicy: "balanced" });
    await pause(30);
    for (const id of ["viewer1", "viewer2"]) controllers.get(id)!.api.joinScreenShare(description.streamId);
    for (let i = 0; i < 15; i++) {
      await pause(1000);
      for (const [index, id] of ["viewer1", "viewer2"].entries()) {
        const video = document.querySelectorAll("video")[index]!;
        const received = controllers.get(id)!.api.screenShareRemoteStream.value;
        if (received && video.srcObject !== received) { video.srcObject = received; await video.play(); }
      }
    }
    const before = structuredClone(host.api.screenShareWebRtcStats.peers.map(x => ({ ...x })));
    await host.api.updateScreenShareBitrateSettings({ bitrateMode: "manual", bitrateMbps: 4 });
    await pause(1500);
    const after = host.api.screenShareWebRtcStats.peers.map(x => ({ ...x }));
    controllers.get("viewer1")!.api.leaveScreenShare();
    await pause(1500);
    const survivor = controllers.get("viewer2")!.api.screenShareWebRtcStats.peers.map(x => ({ ...x }));
    const dimensions = [...document.querySelectorAll("video")].map(video => ({ width: video.videoWidth, height: video.videoHeight }));
    const passed = before.length === 2 && before.every(x => x.connectionState === "connected" && (x.frameRate ?? 0) > 0)
      && after.every(x => x.targetBitrateKbps === 4000 && x.bitrateControlSupported)
      && survivor.some(x => x.connectionState === "connected" && (x.frameRate ?? 0) > 0)
      && source.getVideoTracks()[0]!.readyState === "live";
    const report = { passed, browser: navigator.userAgent, scope: "Synthetic local two-viewer P2P, real browser encoding/decoding and raw-frame isolation; no physical capture or WAN proof", before, after, survivor, dimensions };
    output.textContent = JSON.stringify(report, null, 2);
  } catch (error) { output.textContent = JSON.stringify({ passed: false, error: String(error) }); }
  finally {
    clearInterval(timer); navigator.mediaDevices.getDisplayMedia = previousCapture;
    for (const c of controllers.values()) c.stopTransport(false);
    source.getTracks().forEach(t => t.stop());
    for (const video of document.querySelectorAll("video")) { video.pause(); video.srcObject = null; }
  }
}, { once: true });
