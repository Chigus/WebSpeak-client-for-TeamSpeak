import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { ScreenShareCoordinator, type ScreenShareParticipant } from "./screen-share-coordinator.js";
import { parseServerMessage, type ServerMessage } from "../shared/server-messages.js";
import type { ScreenShareClientMessage } from "../shared/screen-share.js";

function fixture() {
  const entries = new Map<string, ScreenShareParticipant>();
  const messages: Array<{ to: string; message: ServerMessage }> = [];
  const commands: Array<{ from: string; command: string }> = [];
  const send = (to: string, message: ServerMessage) => {
    assert.ok(parseServerMessage(JSON.parse(JSON.stringify(message))), `invalid message: ${message.type}`);
    messages.push({ to, message });
  };
  const coordinator = new ScreenShareCoordinator(entries, send, { debug() {}, warn() {} });
  function participant(id: string, clientId: number, channel = 1n, host = "first.example") {
    const entry: ScreenShareParticipant = {
      id, nickname: id, screenPeerId: `peer-${id}`, target: { host, port: 9987 }, members: new Map([[clientId, {}]]),
      channelTree: [{ id: String(channel), parentID: "0", name: "Room", members: [{ id: clientId, nickname: id }] }],
      tsClient: {
        getClientId: () => clientId, getChannelId: () => channel, isConnected: () => true,
        sendProtocolCommand: async command => { commands.push({ from: id, command }); },
      },
    };
    entries.set(id, entry);
    return entry;
  }
  function handle(entry: ScreenShareParticipant, command: ScreenShareClientMessage) {
    coordinator.handleMessage(entry, command, message => send(entry.id, message));
  }
  function list(entry: ScreenShareParticipant) {
    handle(entry, { type: "screenShareList" });
    const message = messages.at(-1)?.message;
    assert.ok(message?.type === "screenShareList");
    return message.streams;
  }
  function start(entry: ScreenShareParticipant) {
    handle(entry, { type: "screenShareStart", requestId: "start", name: "Screen", audio: false });
    const share = list(entry)[0];
    assert.ok(share);
    return share.streamId;
  }
  return { entries, messages, commands, coordinator, participant, handle, list, start };
}

test("sharing is isolated by server and channel, and only its owner can stop it", () => {
  const f = fixture();
  const owner = f.participant("owner", 1);
  const viewer = f.participant("viewer", 2);
  const otherChannel = f.participant("other-channel", 3, 2n);
  const otherServer = f.participant("other-server", 1, 1n, "second.example");
  const streamId = f.start(owner);
  assert.equal(f.messages.some(({ to }) => to === otherChannel.id || to === otherServer.id), false);
  for (const [entry, code] of [[otherServer, "SCREEN_SHARE_NOT_FOUND"], [otherChannel, "SCREEN_SHARE_TARGET_MISMATCH"]] as const) {
    f.handle(entry, { type: "screenShareJoin", streamId });
    const reply = f.messages.at(-1)?.message;
    assert.ok(reply?.type === "screenShareError");
    assert.equal(reply.code, code);
  }
  f.handle(viewer, { type: "screenShareStop", streamId });
  assert.equal(f.list(owner).length, 1);
  f.handle(owner, { type: "screenShareStop", streamId });
  assert.equal(f.list(owner).length, 0);
});

test("signaling permits owner-viewer pairs but rejects viewer-to-viewer injection", () => {
  const f = fixture();
  const owner = f.participant("owner", 1);
  const left = f.participant("left", 2);
  const right = f.participant("right", 3);
  const streamId = f.start(owner);
  for (const viewer of [left, right]) f.handle(viewer, { type: "screenShareJoin", streamId });
  f.messages.length = 0;
  f.handle(left, { type: "screenShareSignal", streamId, targetPeerId: right.screenPeerId, signal: { kind: "offer", sdp: "invalid-peer" } });
  assert.equal(f.messages.some(({ to }) => to === right.id), false);
  assert.equal(f.messages[0]?.message.type, "screenShareError");
  f.handle(left, { type: "screenShareSignal", streamId, targetPeerId: owner.screenPeerId, signal: { kind: "offer", sdp: "offer" } });
  assert.equal(f.messages.at(-1)?.to, owner.id);
  assert.equal(f.messages.at(-1)?.message.type, "screenShareSignal");
});

test("another member moving channels cannot stop the owner's share or evict its viewer", () => {
  const f = fixture();
  const owner = f.participant("owner", 1);
  const viewer = f.participant("viewer", 2);
  const streamId = f.start(owner);
  f.handle(viewer, { type: "screenShareJoin", streamId });
  f.coordinator.onClientMove(owner, 99, 2n);
  f.coordinator.onClientMove(viewer, 99, 2n);
  assert.equal(f.list(owner)[0]?.viewerCount, 1);
  f.coordinator.onClientMove(viewer, 2, 2n);
  assert.equal(f.list(owner)[0]?.viewerCount, 0);
  f.coordinator.onClientMove(owner, 1, 2n);
  assert.equal(f.list(owner).length, 0);
});

test("native source lookup cannot use another server's colliding client ID", () => {
  const f = fixture();
  f.participant("collision", 17, 99n, "second.example");
  const observer = f.participant("observer", 1);
  const viewer = f.participant("viewer", 2, 3n);
  observer.channelTree.push({ id: "3", parentID: "0", name: "Source", members: [{ id: 17, nickname: "Native" }] });
  f.coordinator.handleNotification(observer, { name: "notifystreamstarted", params: { id: "native", clid: "17", name: "Native" } });
  assert.equal(f.list(observer).length, 0);
  assert.equal(f.list(viewer)[0]?.streamId, "native");
});

test("a gateway publisher's repeated native notification cannot create a duplicate stream", () => {
  const f = fixture();
  const owner = f.participant("owner", 1);
  const streamId = f.start(owner);
  f.coordinator.handleNotification(owner, { name: "notifystreamstarted", params: { id: "native-copy", clid: "1" } });
  f.coordinator.handleNotification(owner, { name: "notifystreaminfo", params: { id: "native-copy", clid: "1" } });
  assert.deepEqual(f.list(owner).map(stream => stream.streamId), [streamId]);
  f.handle(owner, { type: "screenShareStop", streamId });
  f.coordinator.handleNotification(owner, { name: "notifystreamstarted", params: { id: "late-copy", clid: "1" } });
  assert.equal(f.list(owner).length, 0);
  assert.ok(f.commands.some(({ command }) => command.startsWith("stopstream id=late-copy ")));
});

test("native discovery runs again when the last session on a target has left", async () => {
  const f = fixture();
  const first = f.participant("first", 1);
  await f.coordinator.discoverExistingStreams(first);
  f.coordinator.removePeer(first.id);
  f.entries.delete(first.id);
  const second = f.participant("second", 2);
  await f.coordinator.discoverExistingStreams(second);
  assert.ok(f.commands.some(({ from, command }) => from === second.id && command === "requeststreaminfo clid=2"));
});

test("owner removal is idempotent and clears the stream from remaining viewers", async () => {
  const f = fixture();
  const owner = f.participant("owner", 1);
  const viewer = f.participant("viewer", 2);
  const streamId = f.start(owner);
  f.handle(viewer, { type: "screenShareJoin", streamId });
  f.messages.length = 0;
  f.coordinator.removePeer(owner.id);
  f.coordinator.removePeer(owner.id);
  await nextTurn();
  assert.equal(f.messages.filter(({ to, message }) => to === viewer.id && message.type === "screenShareStopped").length, 1);
  assert.equal(f.list(viewer).length, 0);
});

test("a failed old native join cannot remove a newer membership", async () => {
  const f = fixture();
  const viewer = f.participant("viewer", 2);
  viewer.channelTree[0]!.members!.push({ id: 17, nickname: "Native" });
  f.coordinator.handleNotification(viewer, { name: "notifystreamstarted", params: { id: "native", clid: "17" } });
  let rejectOld!: (error: Error) => void;
  const old = new Promise<void>((_, reject) => { rejectOld = reject; });
  let joins = 0;
  viewer.tsClient.sendProtocolCommand = command => command.startsWith("joinstreamrequest") && ++joins === 1 ? old : Promise.resolve();
  f.handle(viewer, { type: "screenShareJoin", streamId: "native", requestId: "old" });
  f.handle(viewer, { type: "screenShareLeave", streamId: "native" });
  f.handle(viewer, { type: "screenShareJoin", streamId: "native", requestId: "new" });
  rejectOld(new Error("old request failed"));
  await nextTurn();
  assert.equal(f.list(viewer)[0]?.viewerCount, 1);
  assert.equal(f.messages.some(({ message }) => message.type === "screenShareError" && message.requestId === "old"), false);
});
