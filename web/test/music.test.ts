import assert from "node:assert/strict";
import test from "node:test";
import { effectScope, nextTick, ref } from "vue";
import { useWebClientMusic } from "../src/composables/useWebClientMusic.js";
import { createMusicRequests } from "../src/voice/music-requests.js";
import { parsePlaylistLink, parseShortPlaylistLink, loadMusicPlaylists } from "../src/services/music-playlists.js";
import type { MusicResult } from "../../src/shared/music.js";
const base:MusicResult={enabled:true,inChannel:true,botName:"bot"};
const track={source:"netease" as const,id:"123",title:"曲目",artist:"歌手",album:"",duration:180,artwork:""};

test("playlist links accept both official platforms and reject lookalike hosts and non-playlist links",()=>{
  assert.equal(parsePlaylistLink("https://music.163.com/#/playlist?id=123","qqmusic")?.source,"netease");
  assert.equal(parsePlaylistLink("https://y.qq.com/n/ryqq/playlist/456","netease")?.id,"456");
  assert.equal(parsePlaylistLink("https://y.qq.com/n/yqq/playsquare/456.html","netease")?.id,"456");
  for(const link of ["https://music.163.com.evil.test/playlist?id=123","https://music.163.com/song?id=123","file:///playlist?id=123"])
    assert.equal(parsePlaylistLink(link,"netease"),null);
  assert.deepEqual(loadMusicPlaylists({getItem(){throw Error("blocked");}}),[]);
  assert.equal(parseShortPlaylistLink("分享歌单: 我的音乐 https://163cn.tv/bid9Yfo6 (@网易云音乐)"),"https://163cn.tv/bid9Yfo6");
  assert.equal(parseShortPlaylistLink("https://163cn.tv.evil.test/bid9Yfo6"),null);
  assert.equal(parsePlaylistLink("分享歌单 https://music.163.com/m/playlist?id=123 (@网易云音乐)","qqmusic")?.id,"123");
});

test("short shares resolve to an ID before being saved or paginated",async t=>{
  const scope=effectScope();t.after(()=>scope.stop());const calls:any[]=[];
  const model=scope.run(()=>useWebClientMusic({connected:ref(true),channelId:ref("1"),request:async(action,payload)=>{
    if(action==="playlist"){calls.push(payload);return{...base,playlistId:"123",name:"我的歌单",items:[track],hasMore:true};}return base;
  }}))!;
  await nextTick();await model.loadPlaylist("分享歌单 https://163cn.tv/bid9Yfo6 (@网易云音乐)");
  assert.equal(calls[0].link,"https://163cn.tv/bid9Yfo6");assert.equal(model.saved.value[0]?.id,"123");
  await model.playlistPage(2);assert.equal(calls[1].id,"123");assert.equal(calls[1].link,undefined);
});

test("music RPC ignores responses from a replaced socket and cancels retired requests",async()=>{
  const sent:any[]=[];let socket:any={readyState:1,send:(text:string)=>sent.push(JSON.parse(text))};
  const rpc=createMusicRequests(()=>socket),abort=new AbortController();
  const pending=rpc.request("status",{},"1",abort.signal);
  socket={readyState:1,send(){}};
  rpc.receive({type:"musicResult",requestId:sent[0].requestId,channelId:"1",result:base});
  abort.abort();await assert.rejects(pending,{code:"MUSIC_SESSION_CHANGED"});
  const next=rpc.request("status",{},"1");rpc.clear();await assert.rejects(next,{code:"MUSIC_SESSION_CHANGED"});
});

test("late search results cannot overwrite the new channel",async t=>{
  const scope=effectScope();t.after(()=>scope.stop());const channel=ref("1");
  let finish!: (result:MusicResult)=>void;
  const model=scope.run(()=>useWebClientMusic({connected:ref(true),channelId:channel,
    request:async action=>action==="search"?new Promise(resolve=>{finish=resolve;}):base}))!;
  await nextTick();model.keywords.value="song";const pending=model.search();
  channel.value="2";finish({...base,items:[track]});await pending;await nextTick();
  assert.equal(model.items.value.length,0);assert.equal(model.loading.value,false);
});

test("playlist records save only source, ID and name; blocked storage leaves playback usable",async t=>{
  const scope=effectScope();t.after(()=>scope.stop());let saved="";
  const model=scope.run(()=>useWebClientMusic({connected:ref(true),channelId:ref("1"),
    storage:{getItem:()=>null,setItem:(_key,value)=>{saved=value;throw Error("blocked");}},
    request:async action=>action==="playlist"?{...base,items:[track],name:"我的歌单",total:1}:base}))!;
  await nextTick();await model.loadPlaylist("https://music.163.com/#/playlist?id=123&cookie=secret");
  assert.equal(saved.includes("secret"),false);assert.equal(model.notice.value,"storageUnavailable");
  assert.equal(model.canControl.value,true);assert.equal(model.items.value.length,1);
});

test("batch playback stops after a platform authorization failure and records partial progress",async t=>{
  const scope=effectScope();t.after(()=>scope.stop());let attempts=0;
  const model=scope.run(()=>useWebClientMusic({connected:ref(true),channelId:ref("1"),request:async action=>{
    if(action==="enqueue"){attempts++;throw Object.assign(Error("auth"),{code:"MUSIC_SOURCE_AUTH"});}return base;
  }}))!;
  await nextTick();model.items.value=[track,{...track,id:"456"}];await model.enqueueAll(true);
  assert.equal(attempts,1);assert.equal(model.batch.value.failed,1);assert.equal(model.batch.value.active,false);
  assert.equal(model.error.value,"MUSIC_SOURCE_AUTH");assert.equal(model.busy.value,false);
});
