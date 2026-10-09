// Optional live acceptance: two gateway clients in a task-owned protected room.
// Browser -> TURN -> native TS -> reflector -> native TS -> TURN -> browser.
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { OpusEncoder } from '../../src/server/opus-codec.ts';
import { isVoiceRelayMessage } from '../../src/shared/voice-relay.ts';

export async function liveBridge(local) {
 const gateway=new URL(process.env.NETWORK_CHECK_GATEWAY);
 const room=JSON.parse(fs.readFileSync(process.env.NETWORK_CHECK_ROOM,'utf8'));
 if(gateway.protocol!=='https:'||!room.ownedByThisTask||!room.channelPassword)throw Error('Protected test configuration required');
 let closed=false,ready=false,pending=null;
 const peers=[],decoders=new Map(),counts={mono:0,stereo:0};
 const deadline=setTimeout(close,120000);
 function close(){if(closed)return;closed=true;clearTimeout(deadline);for(const p of peers)p.close();for(const d of decoders.values())d.dispose();local.close();}
 local.on('close',close);
 local.on('message',raw=>{try{const m=JSON.parse(raw.toString());if(isVoiceRelayMessage(m)){if(ready)peers[0].send(JSON.stringify(m));else pending=m;}}catch{}});
 async function join(index){
  const response=await fetch(new URL('/api/join-ticket',gateway),{method:'POST',headers:{'content-type':'application/json',origin:gateway.origin},body:JSON.stringify({nickname:`Voice-Test-${index}-${randomBytes(4).toString('hex')}`}),signal:AbortSignal.timeout(15000)});
  if(response.status!==201||closed)throw Error('Live ticket unavailable');
  const ticket=await response.json(),url=new URL('/ws/voice',gateway);url.protocol='wss:';url.searchParams.set('ticket',ticket.ticket);
  const ws=new WebSocket(url,{origin:gateway.origin,handshakeTimeout:15000});peers.push(ws);
  const joined=await new Promise((resolve,reject)=>{
   let clientId=0;
   const timer=setTimeout(()=>reject(Error('Live room deadline')),20000);
   ws.on('error',()=>{clearTimeout(timer);reject(Error('Live socket failed'));close();});
   ws.on('close',()=>{clearTimeout(timer);reject(Error('Live socket closed'));close();});
   ws.on('message',(raw,binary)=>{
    if(closed)return;
    if(binary){
     if(index!==1||!ready||raw.length<4||raw.readUInt16BE(1)!==peers[0].testClientId)return;
     const codec=raw[0]&127;if(codec!==4&&codec!==5)return;
     try{
      let decoder=decoders.get(codec);if(!decoder){decoder=new OpusEncoder(48000,codec===5?2:1);decoders.set(codec,decoder);}
      const pcm=decoder.decode(raw.subarray(3));if(pcm.length!==(codec===5?3840:1920))throw Error('Frame size');
      counts[codec===5?'stereo':'mono']++;ws.send(pcm);
      local.send(JSON.stringify({type:'acceptance',scope:'Live production gateway and native TeamSpeak in protected synthetic room',upstreamCounts:counts}));
     }catch{close();}return;
    }
    const m=JSON.parse(raw.toString());
    if(m.type==='connected'){
     clientId=m.tsClientId;ws.testClientId=clientId;
     if(index===0&&!m.voiceRelayAvailable){clearTimeout(timer);reject(Error('Live TURN voice not available'));return;}
     ws.send(JSON.stringify({type:'switchChannel',requestId:'voice-test-room',payload:{channelId:String(room.channelId),password:room.channelPassword}}));
    }
    if(m.type==='channelSwitched'&&String(m.channelId)===String(room.channelId)){clearTimeout(timer);resolve(clientId);}
    if(index===0&&isVoiceRelayMessage(m))local.send(JSON.stringify(m));
   });
  });
  return joined;
 }
 try{
  await join(0);await join(1);if(closed)return;
  peers[0].send(JSON.stringify({type:'setVoiceQuality',payload:{mode:'manual',bitrateKbps:192,policy:'quality',compressedUplink:true}}));
  ready=true;if(pending)peers[0].send(JSON.stringify(pending));
 }catch{if(local.readyState===1)local.send(JSON.stringify({type:'voiceRelay',id:pending?.id??'live',action:'error'}));close();}
}
