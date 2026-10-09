import { readFileSync } from "node:fs";
import { parseTeamSpeakTarget, teamSpeakTargetKey } from "../domain/teamspeak-target.js";
import { isRecord, isMusicSource, validMusicId, validNetEaseShareLink, type MusicRequest, type MusicResult, type MusicTrack, type MusicSource } from "../shared/music.js";
export interface MusicConfig { url: string; token: string; target: string; botUid: string; botName?: string; neteaseUrl?: string }
export function readMusicConfig(): MusicConfig | undefined {
  const file = process.env.WEBSPEAK_MUSIC_CONFIG_FILE;
  if (!file) return;
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(raw) || ["url", "token", "target", "botUid"].some(k => typeof raw[k] !== "string" || !raw[k])) throw new Error("Invalid music configuration");
  const url = new URL(String(raw.url));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid music endpoint");
  let neteaseUrl: string | undefined;
  if (typeof raw.neteaseUrl === "string" && raw.neteaseUrl) {
    const endpoint = new URL(raw.neteaseUrl);
    if (!["http:","https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Invalid NetEase endpoint");
    neteaseUrl = endpoint.href.replace(/\/$/, "");
  }
  parseTeamSpeakTarget(String(raw.target));
  return { url: url.href.replace(/\/$/, ""), token: String(raw.token), target: String(raw.target), botUid: String(raw.botUid), botName: typeof raw.botName === "string" ? raw.botName.slice(0,120) : "TSBot", ...(neteaseUrl ? {neteaseUrl} : {}) };
}
export class MusicFailure extends Error { constructor(readonly code: string) { super(code); } }
const text = (v: unknown, limit = 240) => typeof v === "string" ? v.replace(/[\u0000-\u001f]/g," ").slice(0,limit) : "";
const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? Math.max(0,v) : 0;
function artwork(value: unknown): string {
  try { const u = new URL(text(value,2048)); if (["http:","https:"].includes(u.protocol) && !u.username && !u.password) { u.protocol="https:"; return u.href; } } catch {}
  return "";
}
export function normalizeMusicTrack(raw: unknown, fallback?: MusicSource): MusicTrack | null {
  if (!isRecord(raw)) return null;
  const source = isMusicSource(raw.source) ? raw.source : fallback;
  if (!source) return null;
  const trackId = text(raw.track_id,80).split(":")[1];
  const id = text(source === "netease" ? String(raw.song_id ?? raw.id ?? trackId ?? "") : source === "qqmusic" ? raw.song_mid ?? raw.mid ?? raw.songmid ?? trackId : raw.video_id ?? trackId,40);
  if (!validMusicId(source,id)) return null;
  const singers = raw.ar ?? raw.artists ?? raw.singer;
  const artist = typeof raw.artist === "string" ? text(raw.artist) : Array.isArray(singers) ? singers.filter(isRecord).map(s => text(s.name,80)).join(", ").slice(0,240) : "";
  const albumObject = isRecord(raw.al) ? raw.al : isRecord(raw.album) ? raw.album : {};
  return { source, id, title: text(raw.title ?? raw.name ?? raw.songname) || id, artist, album: text(typeof raw.album === "string" ? raw.album : albumObject.name ?? raw.albumname),
    ...(source === "qqmusic" && validMusicId("qqmusic", raw.album_mid ?? albumObject.mid ?? raw.albummid) ? {albumMid:String(raw.album_mid ?? albumObject.mid ?? raw.albummid)} : {}),
    duration: number(raw.duration_ms ?? raw.dt) / 1000 || number(raw.duration ?? raw.interval),
    artwork: artwork(raw.artwork_url ?? raw.artwork ?? raw.cover_url ?? albumObject.picUrl),
    ...(typeof raw.id === "number" && typeof raw.track_id === "string" ? { queueId: raw.id } : {}) };
}
export interface MusicAccess { target: string; channelId: string; botChannelId?: string; current(): boolean; signal?: AbortSignal }
/** Only fixed TSBot routes; never proxy browser URLs, credentials or raw upstream errors. */
export class MusicService {
  private mutationActive = false;
  private readonly tracks = new Map<string, MusicTrack>();
  private remember(track: MusicTrack | null): MusicTrack | null {
    if (!track) return null;
    const key = `${track.source}:${track.id}`;
    this.tracks.delete(key); this.tracks.set(key, track);
    if (this.tracks.size > 2000) this.tracks.delete(this.tracks.keys().next().value!);
    return track;
  }
  constructor(readonly config?: MusicConfig, private readonly fetcher: typeof fetch = fetch) {}
  private async resolvePlaylist(link:string, access:MusicAccess):Promise<string> {
    const signal=AbortSignal.any([AbortSignal.timeout(10_000),...(access.signal?[access.signal]:[])]);
    for(let hop=0;hop<3;hop++) {
      if(!access.current())throw new MusicFailure("MUSIC_SESSION_CHANGED");
      if(!validNetEaseShareLink(link))throw new MusicFailure("MUSIC_INVALID_PLAYLIST");
      let response:Response;
      try{response=await this.fetcher(link,{redirect:"manual",signal});}catch{throw new MusicFailure("MUSIC_UNAVAILABLE");}
      await response.body?.cancel();
      const location=response.headers.get("location");
      if(response.status<300||response.status>399||!location)throw new MusicFailure("MUSIC_INVALID_PLAYLIST");
      let next:URL;try{next=new URL(location,link);}catch{throw new MusicFailure("MUSIC_INVALID_PLAYLIST");}
      if(next.protocol!=="https:"||next.username||next.password||next.port)throw new MusicFailure("MUSIC_INVALID_PLAYLIST");
      if(["music.163.com","y.music.163.com"].includes(next.hostname)) {
        const route=next.hash.startsWith("#/")?new URL(next.hash.slice(1),next.origin):next;
        const id=route.searchParams.get("id");
        if(/\/(?:m\/)?playlist\/?$/.test(route.pathname)&&validMusicId("netease",id))return id;
        throw new MusicFailure("MUSIC_INVALID_PLAYLIST");
      }
      link=next.href;
    }
    throw new MusicFailure("MUSIC_INVALID_PLAYLIST");
  }
  private base(access: MusicAccess): MusicResult {
    return { enabled: !!this.config && teamSpeakTargetKey(parseTeamSpeakTarget(access.target)) === teamSpeakTargetKey(parseTeamSpeakTarget(this.config.target)),
      inChannel: !!access.botChannelId && access.botChannelId === access.channelId,
      botName: this.config?.botName ?? "TSBot", ...(access.botChannelId ? { botChannelId: access.botChannelId } : {}) };
  }
  async handle(request: MusicRequest, access: MusicAccess): Promise<MusicResult> {
    const base = this.base(access);
    if (request.action === "status" && (!base.enabled || !base.inChannel)) return base;
    if (!base.enabled) throw new MusicFailure("MUSIC_DISABLED");
    if (!base.inChannel) throw new MusicFailure("MUSIC_OTHER_CHANNEL");
    const current = () => { if (!access.current()) throw new MusicFailure("MUSIC_SESSION_CHANGED"); };
    current();
    const mutation = !["status","search","playlist"].includes(request.action);
    if (mutation && this.mutationActive) throw new MusicFailure("MUSIC_BUSY");
    if (mutation) this.mutationActive = true;
    const call = async (route: string, method = "GET", body?: object, endpoint: "backend" | "netease" = "backend"): Promise<Record<string, unknown>> => {
      current();
      let response: Response;
      try { response = await this.fetcher(`${endpoint === "backend" ? this.config!.url : this.config!.neteaseUrl}${route}`, { method, redirect: "error",
        headers: { ...(endpoint === "backend" ? {Authorization: `Bearer ${this.config!.token}`} : {}), "Content-Type": "application/json" },
        ...(body ? {body:JSON.stringify(body)} : {}), signal: AbortSignal.any([AbortSignal.timeout(35_000), ...(access.signal ? [access.signal] : [])]) }); }
      catch { throw new MusicFailure("MUSIC_UNAVAILABLE"); }
      if (!response.ok) {
        await response.body?.cancel();
        throw new MusicFailure(response.status === 402 || response.status === 403 ? "MUSIC_SOURCE_AUTH" : response.status === 404 ? "MUSIC_NOT_FOUND" : "MUSIC_UPSTREAM_ERROR");
      }
      if (Number(response.headers.get("content-length")) > 2_000_000) { await response.body?.cancel(); throw new MusicFailure("MUSIC_INVALID_RESPONSE"); }
      const reader = response.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      if (reader) { try { while (true) { const {value,done}=await reader.read(); if (done) break; size+=value.byteLength; if (size>2_000_000) throw new MusicFailure("MUSIC_INVALID_RESPONSE"); chunks.push(value); } } finally { await reader.cancel(); } }
      current();
      try { const result:unknown=JSON.parse(Buffer.concat(chunks).toString("utf8")); if (isRecord(result)) return result; } catch {}
      throw new MusicFailure("MUSIC_INVALID_RESPONSE");
    };
    const p = request.payload;
    try {
      switch (request.action) {
        case "status": {
          const s = await call("/external/status"); const queue = await call("/external/queue");
          if (s.voice_connected === false) throw new MusicFailure("MUSIC_UNAVAILABLE");
          return { ...base, status: { state: text(s.state,30), title: text(s.now_playing_title), artist: text(s.now_playing_artist), artwork: artwork(s.artwork_url), elapsed:number(s.current_time), duration:number(s.duration),
            volume:number(s.volume_percent), shuffled:s.is_shuffled===true, repeat:s.repeat_mode==="all"||s.repeat_mode==="one"?s.repeat_mode:"none" },
            items:(Array.isArray(queue.items)?queue.items:[]).slice(0,200).map(i=>this.remember(normalizeMusicTrack(i))).filter(i=>i!==null), total:number(queue.count) };
        }
        case "search": {
          const data=await call(`/external/search?${new URLSearchParams({source:p.source!,keywords:p.keywords!.trim(),limit:"20",page:String(p.page??1)})}`);
          return { ...base, items:(Array.isArray(data.items)?data.items:[]).slice(0,50).map(i=>this.remember(normalizeMusicTrack(i,p.source))).filter(i=>i!==null), hasMore:data.has_more===true };
        }
        case "playlist": {
          const playlistId=p.link?await this.resolvePlaylist(p.link,access):p.id!;
          const data=await call(p.source==="netease"?`/netease/playlist/${playlistId}/detail`:`/qqmusic/playlist/${playlistId}`);
          const list = p.source === "netease" ? (isRecord(data.playlist)?data.playlist:{}) : (Array.isArray(data.cdlist)&&isRecord(data.cdlist[0])?data.cdlist[0]:{});
          let songs = list.tracks ?? list.songlist;
          if (!Array.isArray(songs)) throw new MusicFailure("MUSIC_PLAYLIST_UNAVAILABLE");
          const offset = ((p.page ?? 1) - 1) * 100;
          let available = songs.length;
          let pageSongs = songs.slice(offset, offset + 100);
          if (p.source === "netease" && this.config?.neteaseUrl && Array.isArray(list.trackIds)) {
            const ids = list.trackIds.filter(isRecord).map(item => String(item.id)).filter(id => validMusicId("netease", id));
            available = ids.length;
            const selected = ids.slice(offset, offset + 100);
            if (selected.length) {
              const detail = await call(`/song/detail?${new URLSearchParams({ids:selected.join(",")})}`, "GET", undefined, "netease");
              if (!Array.isArray(detail.songs)) throw new MusicFailure("MUSIC_PLAYLIST_UNAVAILABLE");
              pageSongs = detail.songs;
            } else pageSongs = [];
          }
          return { ...base, playlistId, name:text(list.name??list.dissname) || playlistId, items:pageSongs.map(i=>this.remember(normalizeMusicTrack(i,p.source))).filter(i=>i!==null),
            total:number(list.trackCount??list.total_song_num)||available, hasMore:offset+100<available };
        }
        case "enqueue": {
          const field=p.source==="netease"?"song_id":p.source==="qqmusic"?"song_mid":"video_id";
          const track = this.tracks.get(`${p.source}:${p.id}`);
          let data: Record<string, unknown>;
          try { data=await call("/external/queue","POST",{source:p.source,[field]:p.id,play_now:p.playNow===true,
            ...(track ? {title:track.title,artist:track.artist,album:track.album,duration_ms:Math.round(track.duration*1000),album_mid:track.albumMid ?? ""} : p.source === "qqmusic" ? {title:p.id} : {})}); }
          catch (error) {
            // TSBot v0.7.0 reports a missing QQ playback URL (including VIP or
            // region restrictions) as 404, before creating any queue item.
            if (p.source === "qqmusic" && error instanceof MusicFailure && error.code === "MUSIC_NOT_FOUND") throw new MusicFailure("MUSIC_SOURCE_AUTH");
            throw error;
          }
          if (data.ok !== true) throw new MusicFailure("MUSIC_UPSTREAM_ERROR");
          return {...base,queued:data.ok===true,trial:data.trial===true};
        }
        case "control": await call("/external/player/action","POST",{action:p.control}); break;
        case "remove": await call(`/external/queue/${p.queueId}`,"DELETE"); break;
        case "queuePlay": await call(`/external/queue/${p.queueId}/play`,"POST"); break;
        case "volume": await call("/external/player/volume","PUT",{volume_percent:p.volume}); break;
        case "shuffle": await call("/external/player/shuffle","POST",{enabled:p.enabled}); break;
        case "repeat": await call("/external/player/repeat","POST",{mode:p.mode}); break;
      }
      return base;
    } finally { if (mutation) this.mutationActive=false; }
  }
}
