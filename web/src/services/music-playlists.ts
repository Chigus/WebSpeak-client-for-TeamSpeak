import { validNetEaseShareLink, type MusicSource } from "../../../src/shared/music.js";
export interface SavedMusicPlaylist { source: "netease" | "qqmusic"; id: string; name: string }
export const MUSIC_PLAYLIST_STORAGE_KEY="webspeak:music-playlists:v1";
function shareUrl(value:string):string { return value.trim().match(/https?:\/\/[^\s<>()（），]+/)?.[0] ?? value.trim(); }
export function parseShortPlaylistLink(value:string):string|null {
  const input=shareUrl(value);return validNetEaseShareLink(input)?input:null;
}
export function parsePlaylistLink(value:string, source:MusicSource):SavedMusicPlaylist|null {
  const input=shareUrl(value);
  if(/^\d{1,20}$/.test(input) && source!=="bilibili")return{source,id:input,name:input};
  try {
    const url=new URL(input);
    if(!["http:","https:"].includes(url.protocol)||url.username||url.password)return null;
    let provider:"netease"|"qqmusic";
    if(["music.163.com","y.music.163.com"].includes(url.hostname))provider="netease";
    else if(["y.qq.com","i.y.qq.com","c.y.qq.com"].includes(url.hostname))provider="qqmusic";
    else return null;
    const route=url.hash.startsWith("#/")?new URL(url.hash.slice(1),url.origin):url;
    if(!/playlist|taoge|songlist|playsquare/i.test(route.pathname))return null;
    const id=route.searchParams.get("id")??route.searchParams.get("disstid")??route.pathname.match(/(?:playlist|songlist|playsquare)\/(\d+)/)?.[1];
    return id&&/^\d{1,20}$/.test(id)?{source:provider,id,name:id}:null;
  }catch{return null;}
}
export function loadMusicPlaylists(storage?:Pick<Storage,"getItem">):SavedMusicPlaylist[] {
  try {const items:unknown=JSON.parse(storage?.getItem(MUSIC_PLAYLIST_STORAGE_KEY)??"[]");return Array.isArray(items)?items.filter((i):i is SavedMusicPlaylist=>
    !!i&&typeof i==="object"&&(i.source==="netease"||i.source==="qqmusic")&&typeof i.id==="string"&&/^\d{1,20}$/.test(i.id)&&typeof i.name==="string"&&i.name.length<=240).slice(0,20):[];}catch{return[];}
}
