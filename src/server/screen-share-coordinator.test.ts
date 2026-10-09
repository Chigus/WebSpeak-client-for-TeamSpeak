import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { ScreenShareCoordinator, type ScreenShareParticipant } from "./screen-share-coordinator.js";
import { parseServerMessage, type ServerMessage } from "../shared/server-messages.js";
import type { ScreenShareClientMessage } from "../shared/screen-share.js";
import { ScreenShareRelays } from "./screen-share-relays.js";

function fixture(relays = new ScreenShareRelays()) {
  const entries = new Map<string, ScreenShareParticipant>();
  const messages: Array<{ to: string; message: ServerMessage }> = [];
  const commands: Array<{ from: string; command: string }> = [];
  const send = (to: string, message: ServerMessage) => {
    assert.ok(parseServerMessage(JSON.parse(JSON.stringify(message))), `invalid message: ${message.type}`);
    messages.push({ to, message });
  };
  const coordinator = new ScreenShareCoordinator(entries, send, { debug() {}, warn() {} }, relays);
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

test("late cloud relay credentials cannot publish a departed session", async t => {
  const relays=new ScreenShareRelays();let resolve!:(value:any)=>void;
  t.mock.method(relays,"issueAsync",()=>new Promise(done=>{resolve=done;}));
  const f=fixture(relays),owner=f.participant("owner",1);
  f.handle(owner,{type:"screenShareStart",requestId:"start",route:"cloudflare",audio:false});
  f.coordinator.removePeer(owner.id);f.entries.delete(owner.id);
  resolve({route:"cloudflare",expiresAt:Date.now()+60000,iceServers:[{urls:["turn:relay.example:3478"],username:"lease",credential:"lease"}]});
  await nextTurn();assert.equal(f.messages.filter(m=>m.message.type==="screenShareStarted").length,0);
});

for (const route of ["macau", "aliyun"] as const) test(`${route} relay authorization reaches only the publisher and joined viewers, never public listings`, () => {
  const secret = "s".repeat(48);
  const f = fixture(new ScreenShareRelays([{ id: route, urls: [`turn:${route}.example:3478`], secret }]));
  const owner = f.participant("owner", 1), viewer = f.participant("viewer", 2);
  f.handle(owner, { type: "screenShareStart", route: "shenzhen" });
  assert.equal(f.messages.at(-1)?.message.type, "screenShareError");
  assert.equal(f.list(owner).length, 0);
  f.messages.length = 0;
  f.handle(owner, { type: "screenShareStart", route, requestId: "start" });
  const reply = f.messages[0]!.message;
  assert.ok(reply.type === "screenShareStarted" && reply.owner && reply.relay);
  const credential = reply.relay.iceServers[0]!.credential!;
  f.handle(viewer, { type: "screenShareJoin", streamId: reply.stream.streamId });
  assert.equal(f.list(viewer)[0]?.route, route);
  assert.equal(JSON.stringify(f.messages).includes(secret), false);
  assert.equal(JSON.stringify(f.messages.filter(({ message }) => message.type !== "screenShareStarted" && message.type !== "screenShareJoined")).includes(credential), false);
  assert.equal(JSON.stringify(f.list(viewer)).includes(credential), false);
  assert.ok(f.messages.some(({ to, message }) => to === viewer.id && message.type === "screenShareJoined" && message.relay));
});

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

test("a later session rediscovers a previously queried source and announces it only once", async () => {
  const f = fixture();
  const first = f.participant("first", 1);
  first.members = new Map([[17, {}]]);
  first.channelTree[0]!.members!.push({ id: 17, nickname: "Native" });
  await f.coordinator.discoverExistingStreams(first);
  const later = f.participant("later", 2);
  later.members = first.members;
  later.channelTree = first.channelTree;
  let queries = 0;
  later.tsClient.sendProtocolCommand = async command => {
    assert.equal(command, "requeststreaminfo clid=17");
    queries++;
    f.coordinator.handleNotification(later, { name: "notifystreaminfo", params: { id: "native", clid: "17" } });
  };
  await f.coordinator.discoverExistingStreams(later);
  await f.coordinator.discoverExistingStreams(later);
  assert.equal(queries, 2);
  assert.equal(f.list(later)[0]?.streamId, "native");
  assert.equal(f.messages.filter(({ to, message }) => to === later.id && message.type === "screenShareStarted").length, 1);
});

test("overlapping discovery uses one trailing pass with the latest directory and does not block another server", async () => {
  const f = fixture();
  const first = f.participant("first", 1);
  first.members = new Map([[17, {}]]);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let firstQueries = 0;
  first.tsClient.sendProtocolCommand = async () => { firstQueries++; await blocked; };
  const running = f.coordinator.discoverExistingStreams(first);
  await nextTurn();
  const second = f.participant("second", 2);
  const latest = f.participant("latest", 3);
  latest.members = new Map([[17, {}], [18, {}]]);
  const pending = f.coordinator.discoverExistingStreams(second);
  const coalesced = f.coordinator.discoverExistingStreams(latest);
  const other = f.participant("other", 4, 1n, "second.example");
  await f.coordinator.discoverExistingStreams(other);
  assert.deepEqual(f.commands, [{ from: "other", command: "requeststreaminfo clid=4" }]);
  release();
  await Promise.all([running, pending, coalesced]);
  assert.equal(firstQueries, 1);
  assert.deepEqual(f.commands.slice(1), [
    { from: "latest", command: "requeststreaminfo clid=17" },
    { from: "latest", command: "requeststreaminfo clid=18" },
  ]);
});

test("discovery abandons a removed connection and falls back when its queued session also leaves", async () => {
  const f = fixture();
  const first = f.participant("first", 1);
  first.members = new Map([[17, {}], [18, {}]]);
  let release!: () => void;
  let firstQueries = 0;
  first.tsClient.sendProtocolCommand = async () => {
    firstQueries++;
    await new Promise<void>(resolve => { release = resolve; });
  };
  const running = f.coordinator.discoverExistingStreams(first);
  await nextTurn();
  const leaving = f.participant("leaving", 2);
  const pending = f.coordinator.discoverExistingStreams(leaving);
  f.participant("other-server", 3, 1n, "second.example");
  const survivor = f.participant("survivor", 4);
  survivor.members = first.members;
  f.entries.delete(first.id);
  f.entries.delete(leaving.id);
  release();
  await Promise.all([running, pending]);
  assert.equal(firstQueries, 1);
  assert.deepEqual(f.commands, [
    { from: "survivor", command: "requeststreaminfo clid=17" },
    { from: "survivor", command: "requeststreaminfo clid=18" },
  ]);
});

test("a failed native query does not suppress later clients or future discovery passes", async () => {
  const f = fixture();
  const entry = f.participant("viewer", 1);
  entry.members = new Map([[17, {}], [18, {}]]);
  const queries: string[] = [];
  entry.tsClient.sendProtocolCommand = async command => {
    queries.push(command);
    if (queries.length === 1) throw new Error("query failed");
  };
  await f.coordinator.discoverExistingStreams(entry);
  await f.coordinator.discoverExistingStreams(entry);
  assert.deepEqual(queries, [17, 18, 17, 18].map(id => `requeststreaminfo clid=${id}`));
});

test("native lookup can use a connected directory on the same server when the observer lacks the source", () => {
  const f = fixture();
  const collision = f.participant("collision", 3, 99n, "second.example");
  collision.channelTree[0]!.members!.push({ id: 17, nickname: "Collision" });
  const offline = f.participant("offline", 4, 88n);
  offline.channelTree[0]!.members!.push({ id: 17, nickname: "Stale" });
  offline.tsClient.isConnected = () => false;
  const observer = f.participant("observer", 1);
  const viewer = f.participant("viewer", 2, 2n);
  viewer.channelTree[0]!.members!.push({ id: 17, nickname: "Native" });
  f.coordinator.handleNotification(observer, { name: "notifystreaminfo", params: { id: "native", clid: "17" } });
  assert.deepEqual(f.messages.filter(({ message }) => message.type === "screenShareStarted").map(({ to }) => to), [viewer.id]);
  assert.equal(f.list(observer).length, 0);
  assert.equal(f.list(viewer)[0]?.streamId, "native");
});

test("an unknown native source never inherits the observer's channel", () => {
  const f = fixture();
  const viewer = f.participant("viewer", 1);
  const collision = f.participant("collision", 2, 1n, "second.example");
  collision.channelTree[0]!.members!.push({ id: 17, nickname: "Other source" });
  f.coordinator.handleNotification(viewer, { name: "notifystreaminfo", params: { id: "native", clid: "17" } });
  assert.equal(f.list(viewer).length, 0);
});

test("channel correction retires old viewers before announcing the native stream in its current channel", async () => {
  const f = fixture();
  const oldViewer = f.participant("old-viewer", 1);
  oldViewer.channelTree[0]!.members!.push({ id: 17, nickname: "Native" });
  const newViewer = f.participant("new-viewer", 2, 2n);
  f.coordinator.handleNotification(oldViewer, { name: "notifystreaminfo", params: { id: "native", clid: "17" } });
  f.handle(oldViewer, { type: "screenShareJoin", streamId: "native" });
  assert.equal(f.list(oldViewer)[0]?.viewerCount, 1);
  await nextTurn();
  f.messages.length = 0;
  // A fresh directory corrects the source channel without a clientMoved event.
  // The observer must take precedence over the first session's stale snapshot.
  newViewer.channelTree[0]!.members!.push({ id: 17, nickname: "Native" });
  f.coordinator.handleNotification(newViewer, { name: "notifystreaminfo", params: { id: "native", clid: "17" } });
  const stopped = f.messages.findIndex(({ to, message }) => to === oldViewer.id && message.type === "screenShareStopped");
  const started = f.messages.findIndex(({ to, message }) => to === newViewer.id && message.type === "screenShareStarted");
  assert.ok(stopped >= 0 && started > stopped);
  assert.ok(f.commands.some(({ from, command }) => from === oldViewer.id && command === "removeclientfromstream id=native clid=1 reason=1"));
  assert.equal(f.list(oldViewer).length, 0);
  assert.equal(f.list(newViewer)[0]?.viewerCount, 0);
  f.messages.length = 0;
  f.coordinator.handleNotification(oldViewer, { name: "notifyrespondjoinstreamrequest", params: { id: "native", offer: "late-offer" } });
  assert.equal(f.messages.some(({ message }) => message.type === "screenShareSignal"), false);
  f.handle(newViewer, { type: "screenShareJoin", streamId: "native" });
  assert.equal(f.list(newViewer)[0]?.viewerCount, 1);
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

test("leaving a native source includes the removal reason required by TS6", () => {
  const f = fixture();
  const viewer = f.participant("viewer", 2);
  viewer.channelTree[0]!.members!.push({ id: 17, nickname: "Native" });
  f.coordinator.handleNotification(viewer, { name: "notifystreamstarted", params: { id: "native", clid: "17" } });
  f.handle(viewer, { type: "screenShareJoin", streamId: "native" });
  f.handle(viewer, { type: "screenShareLeave", streamId: "native" });
  assert.ok(f.commands.some(({ command }) => command === "removeclientfromstream id=native clid=2 reason=1"));
});

test("a refused native viewer removal retains membership and reports failure until retry succeeds", async () => {
  const f = fixture();
  const owner = f.participant("owner", 1);
  const streamId = f.start(owner);
  f.coordinator.handleNotification(owner, { name: "notifystreamstarted", params: { id: "native", clid: "1" } });
  f.coordinator.handleNotification(owner, { name: "notifyjoinstreamrequest", params: { id: "native", clid: "17" } });
  let reject!: (error: Error) => void;
  const denied = new Promise<void>((_, no) => { reject = no; });
  owner.tsClient.sendProtocolCommand = command => {
    assert.equal(command, "removeclientfromstream id=native clid=17 reason=1");
    return denied;
  };
  const close: ScreenShareClientMessage = { type: "screenShareSignal", streamId, targetPeerId: "ts-viewer-17", signal: { kind: "close" } };
  f.handle(owner, close);
  assert.equal(f.list(owner)[0]?.viewerCount, 1);
  reject(new Error("denied"));
  await nextTurn();
  assert.equal(f.list(owner)[0]?.viewerCount, 1);
  assert.equal(f.messages.some(({ message }) => message.type === "screenShareViewerLeft"), false);
  assert.ok(f.messages.some(({ message }) => message.type === "screenShareError" && message.code === "SCREEN_SHARE_SIGNAL_FAILED"));
  owner.tsClient.sendProtocolCommand = async () => {};
  f.handle(owner, close);
  await nextTurn();
  assert.equal(f.list(owner)[0]?.viewerCount, 0);
  assert.equal(f.messages.filter(({ message }) => message.type === "screenShareViewerLeft").length, 1);
});

test("native removal notification and acknowledgement publish only one viewer-left event", async () => {
  const f = fixture();
  const owner = f.participant("owner", 1);
  const streamId = f.start(owner);
  f.coordinator.handleNotification(owner, { name: "notifystreamstarted", params: { id: "native", clid: "1" } });
  f.coordinator.handleNotification(owner, { name: "notifyjoinstreamrequest", params: { id: "native", clid: "17" } });
  let resolve!: () => void;
  owner.tsClient.sendProtocolCommand = () => new Promise<void>(yes => { resolve = yes; });
  f.handle(owner, { type: "screenShareSignal", streamId, targetPeerId: "ts-viewer-17", signal: { kind: "close" } });
  f.coordinator.handleNotification(owner, { name: "notifystreamclientleft", params: { id: "native", clid: "17" } });
  resolve();
  await nextTurn();
  assert.equal(f.list(owner)[0]?.viewerCount, 0);
  assert.equal(f.messages.filter(({ message }) => message.type === "screenShareViewerLeft").length, 1);
});
