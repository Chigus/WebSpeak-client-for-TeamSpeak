import { computed, onScopeDispose, ref, watch, type Ref } from "vue";
import type { MusicAction, MusicRequest, MusicResult, MusicSource, MusicTrack } from "../../../src/shared/music.js";
import { loadMusicPlaylists, parsePlaylistLink, parseShortPlaylistLink, MUSIC_PLAYLIST_STORAGE_KEY, type SavedMusicPlaylist } from "../services/music-playlists.js";
export interface MusicModelOptions {
  connected:Ref<boolean>;channelId:Ref<string>;
  request:(action:MusicAction,payload:MusicRequest["payload"],channelId:string,signal?:AbortSignal)=>Promise<MusicResult>;
  storage?:Pick<Storage,"getItem"|"setItem">;
}
export function useWebClientMusic(options:MusicModelOptions) {
  const source=ref<MusicSource>("netease"),keywords=ref(""),tab=ref<"search"|"queue"|"playlists">("search");
  const result=ref<MusicResult|null>(null),items=ref<MusicTrack[]>([]),playlistInput=ref(""),playlistName=ref(""),playlistTotal=ref(0);
  const saved=ref(loadMusicPlaylists(options.storage)),loading=ref(false),busy=ref(false),error=ref(""),notice=ref("");
  const page=ref(1),hasMore=ref(false),batch=ref({active:false,completed:0,failed:0,total:0});
  let playlistLink: SavedMusicPlaylist | null = null;
  let lifetime=new AbortController(),searchOperation:AbortController|null=null,poll:ReturnType<typeof setTimeout>|null=null,refreshActive=false,generation=0,batchStopped=false;
  const status=computed(()=>result.value?.status),queue=computed(()=>result.value?.items??[]),canControl=computed(()=>options.connected.value&&result.value?.enabled&&result.value.inChannel);
  const call=(action:MusicAction,payload:MusicRequest["payload"]={},signal=lifetime.signal)=>options.request(action,payload,options.channelId.value,signal);
  async function refresh():Promise<void> {
    if(refreshActive||!options.connected.value||!options.channelId.value)return;
    refreshActive=true;const owner=generation;
    try {const next=await call("status");if(owner===generation)result.value=next;}
    catch(e) {if(owner===generation&&!lifetime.signal.aborted)error.value=code(e);}
    finally{if(owner===generation)refreshActive=false;}
  }
  function schedule():void {
    poll=setTimeout(async()=>{poll=null;await refresh();if(!lifetime.signal.aborted)schedule();},6000);
  }
  watch([options.connected,options.channelId],()=>{
    lifetime.abort();searchOperation?.abort();if(poll)clearTimeout(poll);poll=null;generation++;
    lifetime=new AbortController();refreshActive=false;result.value=null;items.value=[];playlistName.value="";
    busy.value=false;loading.value=false;error.value="";notice.value="";batchStopped=true;batch.value={active:false,completed:0,failed:0,total:0};
    if(options.connected.value&&options.channelId.value){void refresh();schedule();}
  },{immediate:true,flush:"sync"});
  watch(source,()=>{searchOperation?.abort();loading.value=false;items.value=[];page.value=1;hasMore.value=false;playlistName.value="";playlistLink=null;},{flush:"sync"});
  function code(e:unknown):string{return e&&typeof e==="object"&&"code"in e?String(e.code):"MUSIC_UNAVAILABLE";}
  async function search(nextPage=1):Promise<void> {
    if(!canControl.value||!keywords.value.trim())return;
    searchOperation?.abort();const operation=new AbortController();searchOperation=operation;const owner=generation;
    loading.value=true;error.value="";playlistName.value="";
    try {const data=await call("search",{source:source.value,keywords:keywords.value,page:nextPage},AbortSignal.any([operation.signal,lifetime.signal]));
      if(operation.signal.aborted||owner!==generation)return;items.value=data.items??[];page.value=nextPage;hasMore.value=!!data.hasMore;}
    catch(e){if(!operation.signal.aborted&&owner===generation)error.value=code(e);}
    finally{if(searchOperation===operation)loading.value=false;}
  }
  async function loadPlaylist(input=playlistInput.value,provider=source.value,nextPage=1):Promise<void> {
    let link=parsePlaylistLink(input,provider);
    const shortLink=parseShortPlaylistLink(input);
    if(!link&&shortLink)link={source:"netease",id:"",name:""};
    if(!link){error.value="MUSIC_INVALID_PLAYLIST";return;}
    if(!canControl.value)return;
    source.value=link.source;
    searchOperation?.abort();const operation=new AbortController();searchOperation=operation;const owner=generation;
    loading.value=true;error.value="";tab.value="playlists";
    try{const data=await call("playlist",{source:link.source,...(shortLink?{link:shortLink}:{id:link.id}),page:nextPage},AbortSignal.any([operation.signal,lifetime.signal]));
      if(operation.signal.aborted||owner!==generation)return;
      if(shortLink){if(!data.playlistId)throw Object.assign(new Error("playlist"),{code:"MUSIC_INVALID_PLAYLIST"});link={...link,id:data.playlistId};}
      items.value=data.items??[];playlistName.value=data.name??link.id;playlistTotal.value=data.total??items.value.length;
      playlistLink=link;page.value=nextPage;hasMore.value=!!data.hasMore;
      const record={...link,name:playlistName.value};saved.value=[record,...saved.value.filter(i=>i.source!==record.source||i.id!==record.id)].slice(0,20);
      try{options.storage?.setItem(MUSIC_PLAYLIST_STORAGE_KEY,JSON.stringify(saved.value));}catch{notice.value="storageUnavailable";}
    }catch(e){if(!operation.signal.aborted&&owner===generation)error.value=code(e);}
    finally{if(searchOperation===operation)loading.value=false;}
  }
  function forgetPlaylist(record:SavedMusicPlaylist):void {
    saved.value=saved.value.filter(i=>i.source!==record.source||i.id!==record.id);
    try{options.storage?.setItem(MUSIC_PLAYLIST_STORAGE_KEY,JSON.stringify(saved.value));}catch{notice.value="storageUnavailable";}
  }
  async function perform(action:MusicAction,payload:MusicRequest["payload"]):Promise<void> {
    if(busy.value||!canControl.value)return;const owner=generation;busy.value=true;error.value="";notice.value="";
    try{const data=await call(action,payload);if(owner!==generation)return;
      notice.value=data.trial?"trial":action==="enqueue"?"queued":"";await refresh();}
    catch(e){if(owner===generation)error.value=code(e);}
    finally{if(owner===generation)busy.value=false;}
  }
  async function enqueueAll(playFirst=false):Promise<void> {
    if(busy.value||!canControl.value||!items.value.length)return;
    const tracks=items.value.slice(0,100),owner=generation,signal=lifetime.signal;
    batchStopped=false;busy.value=true;error.value="";notice.value="";batch.value={active:true,completed:0,failed:0,total:tracks.length};
    try{for(const track of tracks){
      if(signal.aborted||batchStopped||owner!==generation)break;
      try {const data=await call("enqueue",{source:track.source,id:track.id,playNow:playFirst&&batch.value.completed===0},signal);
        if(signal.aborted||owner!==generation)break;if(!data.queued)throw new Error("queue");batch.value.completed++;}
      catch(e){if(signal.aborted||owner!==generation)break;batch.value.failed++;
        if(["MUSIC_SESSION_CHANGED","MUSIC_OTHER_CHANNEL","MUSIC_UNAVAILABLE","MUSIC_SOURCE_AUTH"].includes(code(e))){error.value=code(e);break;}}
      await new Promise<void>(resolve=>{const timer=setTimeout(done,550);function done(){clearTimeout(timer);signal.removeEventListener("abort",done);resolve();}signal.addEventListener("abort",done,{once:true});});
    }}finally{if(owner===generation){batch.value.active=false;busy.value=false;notice.value="batchComplete";await refresh();}}
  }
  onScopeDispose(()=>{lifetime.abort();searchOperation?.abort();if(poll)clearTimeout(poll);});
  const cancelBrowse=()=>{searchOperation?.abort();loading.value=false;};
  const playlistPage=(next:number)=>playlistLink?loadPlaylist(playlistLink.id,playlistLink.source,next):Promise.resolve();
  return{source,keywords,tab,result,items,queue,status,canControl,saved,loading,busy,error,notice,page,hasMore,playlistInput,playlistName,playlistTotal,batch,playlistPage,
    refresh,search,loadPlaylist,forgetPlaylist,perform,enqueueAll,cancelBrowse,stopBatch:()=>{batchStopped=true;}};
}
