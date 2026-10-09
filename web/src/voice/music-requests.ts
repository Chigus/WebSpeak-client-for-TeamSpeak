import { isMusicResponse, type MusicAction, type MusicRequest, type MusicResponse, type MusicResult } from "../../../src/shared/music.js";
export function createMusicRequests(socket: () => WebSocket | null) {
  let sequence=0;
  const pending=new Map<string,{channelId:string;owner:WebSocket;finish:(error?:Error,result?:MusicResult)=>void}>();
  return {
    request(action:MusicAction,payload:MusicRequest["payload"],channelId:string,signal?:AbortSignal):Promise<MusicResult> {
      const owner=socket();
      if (!owner || owner.readyState!==1 || signal?.aborted) return Promise.reject(Object.assign(new Error("MUSIC_SESSION_CHANGED"),{code:"MUSIC_SESSION_CHANGED"}));
      if (pending.size>=3) return Promise.reject(Object.assign(new Error("MUSIC_BUSY"),{code:"MUSIC_BUSY"}));
      const requestId=`music-${Date.now().toString(36)}-${sequence++}`;
      return new Promise((resolve,reject)=>{
        let settled=false;
        const abort=()=>finish(Object.assign(new Error("MUSIC_SESSION_CHANGED"),{code:"MUSIC_SESSION_CHANGED"}));
        const timer=setTimeout(()=>finish(Object.assign(new Error("MUSIC_TIMEOUT"),{code:"MUSIC_TIMEOUT"})),40_000);
        const finish=(error?:Error,result?:MusicResult)=>{
          if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener("abort",abort);pending.delete(requestId);
          if(error)reject(error);else if(result)resolve(result);else reject(new Error("MUSIC_INVALID_RESPONSE"));
        };
        pending.set(requestId,{channelId,owner,finish}); signal?.addEventListener("abort",abort,{once:true});
        try {owner.send(JSON.stringify({type:"musicRequest",requestId,channelId,action,payload}));} catch {abort();}
      });
    },
    receive(message:MusicResponse):void {
      if(!isMusicResponse(message))return;
      const operation=pending.get(message.requestId);
      if(!operation||operation.owner!==socket()||operation.channelId!==message.channelId)return;
      operation.finish(message.code?Object.assign(new Error(message.code),{code:message.code}):undefined,message.result);
    },
    clear():void {for(const operation of pending.values())operation.finish(Object.assign(new Error("MUSIC_SESSION_CHANGED"),{code:"MUSIC_SESSION_CHANGED"}));},
  };
}
