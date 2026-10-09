import { createOpusUplink } from '../../web/src/voice/opus-uplink.js';
const result=document.querySelector('#result')!;
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean,ms=25000){const end=performance.now()+ms;while(!check()){if(performance.now()>end)throw Error('Deadline exceeded');await sleep(50);}}
const pcm=(channels:number,n:number)=>{const data=new Int16Array(960*channels);for(let i=0;i<960;i++)for(let c=0;c<channels;c++)data[i*channels+c]=Math.sin((i+n*960)*2*Math.PI*(c?1200:600)/48000)*10000;return data;};
async function report(value:unknown){result.textContent=JSON.stringify(value,null,2);await fetch('/network-result',{method:'POST',body:JSON.stringify(value)});}
async function codecs(){
 const packets:Uint8Array[]=[],failures:string[]=[];let expected=0;
 const encoder=createOpusUplink({canSend:()=>true,send:p=>packets.push(p),onFailure:()=>failures.push('encoder')});
 try{
  if(!await encoder.prepare(48))throw Error('Browser AudioEncoder unsupported');
  const rates=[];
  for(const rate of [16,24,32,48,64,96,128,192]){
   encoder.setBitrate(rate);const start=packets.length;
   for(let n=0;n<12;n++){encoder.push(pcm(1,n));await sleep(20);}
   await sleep(100);const payloads=packets.slice(start).map(p=>p.length-5);
   if(payloads.length<10||payloads.some(bytes=>Math.abs(bytes-rate*2.5)>4))throw Error(`Unexpected browser bitrate ${rate}`);
   expected+=payloads.length;rates.push({kbps:rate,frames:payloads.length,payloadBytes:payloads[0]});
  }
  const before=packets.length;encoder.close();await sleep(50);if(packets.length!==before)throw Error('Late encoder callback');
  await report({kind:'browser-opus',passed:!failures.length,frames:expected,rates});
 }finally{encoder.close();}
}
async function relay(route:string){
 const socket=new WebSocket(`ws://${location.host}/network-voice`);const id='check-'+route;
 let pc:RTCPeerConnection|null=null,channel:RTCDataChannel|null=null,selected=false,failure='',received=0,sequence=0;
 const counts={mono:0,stereo:0},sizes=new Set<number>(),rtts:number[]=[];
 let acceptance:any=null;
 let decoded=0, isolation=Infinity;
 const decoder=new AudioDecoder({output:chunk=>{
  try {
   if (++decoded > 10) {
    const planes=[new Float32Array(chunk.numberOfFrames),new Float32Array(chunk.numberOfFrames)];
    for(let c=0;c<2;c++)chunk.copyTo(planes[c],{planeIndex:c,format:'f32-planar'});
    const amplitude=(a:Float32Array,f:number)=>{let re=0,im=0;for(let i=0;i<a.length;i++){re+=a[i]*Math.cos(i*2*Math.PI*f/48000);im+=a[i]*Math.sin(i*2*Math.PI*f/48000);}return Math.hypot(re,im);};
    isolation=Math.min(isolation,20*Math.log10(amplitude(planes[0],600)/Math.max(1e-8,amplitude(planes[0],1200))),20*Math.log10(amplitude(planes[1],1200)/Math.max(1e-8,amplitude(planes[1],600))));
   }
  }finally{chunk.close();}
 },error:e=>{failure=String(e);}});
 decoder.configure({codec:'opus',sampleRate:48000,numberOfChannels:2});
 const pingAt=new Map<string,number>();let heartbeat:ReturnType<typeof setInterval>|undefined;
 const encoder=createOpusUplink({canSend:()=>channel?.readyState==='open',send:sendAudio,onFailure:()=>{failure='Encoder failed';}});
 function sendAudio(frame:Uint8Array){if(!channel)return;const packet=new Uint8Array(frame.length+4);new DataView(packet.buffer).setUint32(0,sequence++);packet.set(frame,4);channel.send(packet);}
 const send=(m:object)=>socket.send(JSON.stringify({type:'voiceRelay',id,...m}));
 try{
  socket.onmessage=async event=>{
   const m=JSON.parse(event.data);if(m.type==='acceptance'){acceptance=m;return;}if(m.action==='error'){failure='Gateway relay unavailable';return;}
   if(m.action==='selected'){selected=true;return;}
   if(m.action!=='offer')return;
   try{
    const transport=location.hash.slice(1);
    const servers=m.relay?.iceServers?.map((s:any)=>({...s,urls:(Array.isArray(s.urls)?s.urls:[s.urls]).filter((url:string)=>transport==='udp'||transport==='tcp'?url.startsWith('turn:')&&url.includes('transport='+transport):transport==='tls'?url.startsWith('turns:'):true)})).filter((s:any)=>s.urls.length);
    pc=new RTCPeerConnection({iceServers:servers??[{urls:'stun:stun.cloudflare.com:3478'}],iceTransportPolicy:servers?'relay':'all'});
    pc.ondatachannel=e=>{channel=e.channel;channel.binaryType='arraybuffer';channel.onmessage=e=>{
      if(typeof e.data==='string'){const at=pingAt.get(e.data);if(at!==undefined){rtts.push(performance.now()-at);pingAt.delete(e.data);}return;}
      const bytes=new Uint8Array(e.data);received++;if(bytes[4]===5){counts.stereo++;sizes.add(bytes.length-7);decoder.decode(new EncodedAudioChunk({type:"key",timestamp:counts.stereo*20000,data:bytes.subarray(7)}));}else counts.mono++;
    };};
    await pc.setRemoteDescription({type:'offer',sdp:m.sdp});await pc.setLocalDescription(await pc.createAnswer());
    await until(()=>pc!.iceGatheringState==='complete',7000);send({action:'answer',sdp:pc.localDescription!.sdp});
   }catch(e){failure=String(e);}
  };
  await until(()=>socket.readyState===WebSocket.OPEN);send({action:'request',route});
  await until(()=>Boolean(channel?.readyState==='open')||Boolean(failure));if(failure)throw Error(failure);
  let ping=0;heartbeat=setInterval(()=>{const value='ping:'+ ++ping;pingAt.set(value,performance.now());channel!.send(value);},200);
  await until(()=>rtts.length>=5);send({action:'select',rttMs:Math.max(...rtts),baselineMs:5000,loss:0});
  await until(()=>selected||Boolean(failure));if(failure)throw Error(failure);
  if(!await encoder.prepare(48))throw Error('Browser AudioEncoder unavailable');
  for(let n=0;n<50;n++){encoder.push(pcm(1,n));await sleep(20);}
  await sleep(100);
  for(let n=0;n<50;n++){sendAudio(new Uint8Array(pcm(2,n).buffer));await sleep(20);}
  await sleep(500);
  const stats=await pc!.getStats();let candidate:unknown;
  stats.forEach(s=>{if(s.type==='candidate-pair'&&s.nominated&&s.state==='succeeded'){const remote=stats.get(s.remoteCandidateId),local=stats.get(s.localCandidateId);candidate={local:local?.candidateType,remote:remote?.candidateType,protocol:remote?.protocol,relayProtocol:local?.relayProtocol,url:local?.url,localAddress:local?.address,remoteAddress:remote?.address,bytesSent:s.bytesSent,bytesReceived:s.bytesReceived,rtt:s.currentRoundTripTime};}});
  if(failure||decoded<40||isolation<25||counts.mono<40||counts.stereo<40||sizes.size!==1||!sizes.has(480))throw Error(`Incomplete real media ${JSON.stringify(counts)}`);
  if(route!=='direct'&&((candidate as any)?.remote!=='relay'||(candidate as any)?.local!=='relay'))throw Error('Test did not select both relay candidates');
  if(['udp','tcp','tls'].includes(location.hash.slice(1))&&(candidate as any)?.relayProtocol!==location.hash.slice(1))throw Error('Requested TURN transport was not selected');
  if(acceptance&&(acceptance.upstreamCounts.mono<40||acceptance.upstreamCounts.stereo<40))throw Error('Native TS did not receive browser uplink');
  await report({kind:'voice-relay',route,passed:true,received,counts,stereoPayloadBytes:[...sizes],decodedStereoFrames:decoded,minimumChannelSeparationDb:Math.round(isolation),rttMs:Math.round(rtts.reduce((a,b)=>a+b)/rtts.length),candidate,selection:'Simulated degraded WSS baseline; real TURN/media',scope:acceptance?.scope??'Local gateway transport and codec; synthetic audio',upstreamCounts:acceptance?.upstreamCounts});
 }finally{clearInterval(heartbeat);decoder.close();encoder.close();if(socket.readyState===WebSocket.OPEN)send({action:'stop'});socket.close();pc?.close();}
}
for(const route of ['direct','cloudflare','aliyun'])document.querySelector('#'+route)!.addEventListener('click',()=>{result.textContent='Running '+route;relay(route).catch(error=>report({kind:'voice-relay',route,passed:false,error:String(error)}));});
document.querySelector('#codec')!.addEventListener('click',()=>{result.textContent='Testing browser Opus';codecs().catch(error=>report({kind:'browser-opus',passed:false,error:String(error)}));});
