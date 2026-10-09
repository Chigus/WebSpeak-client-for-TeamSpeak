import assert from "node:assert/strict";
import test from "node:test";
import { MusicService, normalizeMusicTrack, type MusicAccess } from "./music-service.js";
import { parseMusicRequest, type MusicRequest } from "../shared/music.js";

const config = { url: "http://bot.invalid", token: "server-secret", target: "voice.example:9987", botUid: "bot-uid" };
const access = (): MusicAccess => ({ target: config.target, channelId: "1", botChannelId: "1", current: () => true });
const request = (action: MusicRequest["action"], payload: MusicRequest["payload"] = {}): MusicRequest => ({type:"musicRequest",requestId:"test",channelId:"1",action,payload});
const json = (data: object, status = 200) => new Response(JSON.stringify(data), {status,headers:{"Content-Type":"application/json"}});

test("music protocol rejects arbitrary proxy routes, malformed media IDs and excessive volume", () => {
  for (const message of [request("enqueue",{source:"netease",id:"../../admin"}),request("volume",{volume:200}),
    request("playlist",{source:"bilibili",id:"123"}),request("control",{control:"shutdown"}),
    {...request("status"),action:"http",url:"http://metadata.invalid"}]) assert.equal(parseMusicRequest(message),null);
  assert.ok(parseMusicRequest(request("enqueue",{source:"qqmusic",id:"003ABcd123",playNow:true})));
});

test("disabled targets and other channels cannot make upstream calls", async () => {
  let calls = 0;
  const service = new MusicService(config, async () => { calls++; return json({}); });
  assert.equal((await service.handle(request("status"), {...access(),target:"other.example:9987"})).enabled,false);
  await assert.rejects(service.handle(request("control",{control:"play"}),{...access(),botChannelId:"2"}),{code:"MUSIC_OTHER_CHANNEL"});
  await assert.rejects(service.handle(request("search",{source:"netease",keywords:"song"}),{...access(),target:"other.example:9987"}),{code:"MUSIC_DISABLED"});
  assert.equal(calls,0);
});

test("search uses an encoded fixed route and never returns cookies or playable URLs", async () => {
  let seenUrl = "", seenHeaders: HeadersInit | undefined;
  const service = new MusicService(config, async (url, options) => {
    seenUrl=String(url);seenHeaders=options?.headers;
    return json({has_more:true,items:[{source:"netease",song_id:"123",title:"曲目",artist:"歌手",duration_ms:123000,
      artwork_url:"http://images.example/cover.jpg",source_url:"https://audio.example/?secret=private",cookie:"private"}]});
  });
  const result = await service.handle(request("search",{source:"netease",keywords:"a&source=bilibili"}),access());
  assert.equal(new URL(seenUrl).searchParams.get("keywords"),"a&source=bilibili");
  assert.equal(new Headers(seenHeaders).get("Authorization"),"Bearer server-secret");
  assert.equal(result.items?.[0]?.duration,123);
  assert.equal(result.items?.[0]?.artwork,"https://images.example/cover.jpg");
  assert.equal(JSON.stringify(result).includes("private"),false);
});

test("both playlist formats retain media identity and display metadata", async () => {
  const service=new MusicService(config,async url=>String(url).includes("qqmusic")
    ?json({cdlist:[{dissname:"QQ 歌单",total_song_num:1,songlist:[{songmid:"abc123",songname:"曲目",singer:[{name:"歌手"}],interval:180}]}]})
    :json({playlist:{name:"网易歌单",trackCount:1,tracks:[{id:123,name:"曲目",ar:[{name:"歌手"}],al:{name:"专辑"},dt:180000}]}}));
  for (const source of ["netease","qqmusic"] as const) {
    const result=await service.handle(request("playlist",{source,id:"99"}),access());
    assert.equal(result.items?.[0]?.source,source);assert.equal(result.items?.[0]?.artist,"歌手");assert.equal(result.items?.[0]?.duration,180);
  }
});

test("NetEase short shares follow only the official redirect and never send credentials",async()=>{
  const urls:string[]=[];
  const service=new MusicService(config,async(url,options)=>{
    urls.push(String(url));
    if(String(url).startsWith("https://163cn.tv/")){
      assert.equal(new Headers(options?.headers).has("Authorization"),false);
      assert.equal(options?.redirect,"manual");
      return new Response(null,{status:302,headers:{location:"https://music.163.com/m/playlist?id=123&userid=private"}});
    }
    return json({playlist:{name:"我的歌单",tracks:[]}});
  });
  const result=await service.handle(request("playlist",{source:"netease",link:"https://163cn.tv/bid9Yfo6"}),access());
  assert.equal(result.playlistId,"123");assert.equal(urls[1],"http://bot.invalid/netease/playlist/123/detail");
  for(const location of ["http://127.0.0.1/admin","https://music.163.com.evil.test/playlist?id=123","https://music.163.com/song?id=123"]){
    let count=0;const blocked=new MusicService(config,async()=>{count++;return new Response(null,{status:302,headers:{location}});});
    await assert.rejects(blocked.handle(request("playlist",{source:"netease",link:"https://163cn.tv/bid9Yfo6"}),access()),{code:"MUSIC_INVALID_PLAYLIST"});
    assert.equal(count,1);
  }
  assert.equal(parseMusicRequest(request("playlist",{source:"netease",link:"http://127.0.0.1/admin"})),null);
});

test("QQ enqueue includes metadata required by TSBot and labels missing licensed URLs", async () => {
  let body:Record<string,unknown>={};
  const service=new MusicService(config,async(url,options)=>{
    if(String(url).includes("/external/search"))return json({items:[{song_mid:"abc123",title:"曲目",artist:"歌手",album_mid:"album123",duration_ms:180000}]});
    body=JSON.parse(String(options?.body));return json({ok:true});
  });
  await service.handle(request("search",{source:"qqmusic",keywords:"曲目"}),access());
  await service.handle(request("enqueue",{source:"qqmusic",id:"abc123"}),access());
  assert.equal(body.title,"曲目");assert.equal(body.artist,"歌手");assert.equal(body.album_mid,"album123");assert.equal(body.duration_ms,180000);
  const restricted=new MusicService(config,async()=>json({},404));
  await assert.rejects(restricted.handle(request("enqueue",{source:"qqmusic",id:"abc123"}),access()),{code:"MUSIC_SOURCE_AUTH"});
});

test("retiring the voice session discards an upstream result", async () => {
  let valid=true;
  const service=new MusicService(config,async()=>{valid=false;return json({items:[]});});
  await assert.rejects(service.handle(request("search",{source:"netease",keywords:"song"}),{...access(),current:()=>valid}),{code:"MUSIC_SESSION_CHANGED"});
});

test("a large NetEase playlist resolves later track IDs without sending the bot token to the catalog API", async () => {
  let detailIds="";
  const service=new MusicService({...config,neteaseUrl:"http://catalog.invalid"},async(url,options)=>{
    if(String(url).startsWith("http://catalog.invalid")) {
      assert.equal(new Headers(options?.headers).has("Authorization"),false);
      detailIds=new URL(String(url)).searchParams.get("ids")??"";
      return json({songs:[{id:101,name:"第二页",ar:[],dt:1000}]});
    }
    return json({playlist:{name:"完整歌单",trackCount:205,tracks:[{id:1,name:"首曲"}],trackIds:Array.from({length:205},(_,i)=>({id:i+1}))}});
  });
  const result=await service.handle(request("playlist",{source:"netease",id:"99",page:2}),access());
  assert.equal(detailIds.split(",")[0],"101");assert.equal(detailIds.split(",").length,100);
  assert.equal(result.items?.[0]?.id,"101");assert.equal(result.total,205);assert.equal(result.hasMore,true);
});

test("concurrent mutations are refused and a failed request releases the lock", async () => {
  let finish!: (response:Response)=>void;
  const service=new MusicService(config,()=>new Promise(resolve=>{finish=resolve;}));
  const pending=service.handle(request("enqueue",{source:"netease",id:"123"}),access());
  await assert.rejects(service.handle(request("control",{control:"pause"}),access()),{code:"MUSIC_BUSY"});
  finish(json({},403));await assert.rejects(pending,{code:"MUSIC_SOURCE_AUTH"});
  const second=service.handle(request("enqueue",{source:"netease",id:"123"}),access());
  finish(json({ok:false}));await assert.rejects(second,{code:"MUSIC_UPSTREAM_ERROR"});
});

test("invalid and oversized responses do not become successful empty queues", async () => {
  for (const response of [new Response("not JSON"),new Response("{}",{headers:{"content-length":"3000000"}})]) {
    const service=new MusicService(config,async()=>response);
    await assert.rejects(service.handle(request("status"),access()),{code:"MUSIC_INVALID_RESPONSE"});
  }
  assert.equal(normalizeMusicTrack({source:"netease",song_id:"../"}),null);
});
