import http from 'node:http';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import { createServer } from '../../web/node_modules/vite/dist/node/index.js';
import { VoiceRelaySession } from '../../src/server/voice-relay.ts';
import { ScreenShareRelays, readScreenShareRelays } from '../../src/server/screen-share-relays.ts';
import { OpusEncoder } from '../../src/server/opus-codec.ts';
import { validVoiceOpusPacket } from '../../src/shared/voice-quality.ts';
import { liveBridge } from './live-bridge.mjs';
const port=Number(process.env.NETWORK_CHECK_PORT??8852);
const vite=await createServer({root:new URL('../../web',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),server:{middlewareMode:true,hmr:false,ws:false,fs:{allow:[new URL('../..',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')]}},appType:'custom'});
const server=http.createServer((req,res)=>{
  if(req.url==='/network-check'){res.setHeader('content-type','text/html;charset=utf-8');res.end('<meta name="viewport" content="width=device-width"><h1>Automatic network acceptance</h1><button id="direct">Test direct voice</button><button id="cloudflare">Test Cloudflare voice</button><button id="codec">Test browser Opus</button><pre id="result">Ready</pre><script type="module" src="/@fs/'+new URL('./browser-check.ts',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')+'"></script>');return;}
  if(req.url==='/network-result'&&req.method==='POST'){let body='';req.on('data',d=>{body+=d;if(body.length>100000)req.destroy();});req.on('end',()=>{try{const data=JSON.parse(body);if(process.env.NETWORK_CHECK_REPORT)fs.writeFileSync(process.env.NETWORK_CHECK_REPORT,JSON.stringify(data,null,2));console.log(JSON.stringify(data));res.end('ok');}catch{res.writeHead(400).end();}});return;}
  vite.middlewares(req,res,()=>res.writeHead(404).end());
});
const sockets=new WebSocketServer({server,path:'/network-voice'});
sockets.on('connection',socket=>{
 if(process.env.NETWORK_CHECK_GATEWAY){void liveBridge(socket).catch(()=>socket.close());return;}
 let current=true;
 const stereo=new OpusEncoder(48000,2,{bitrate:192000,forceChannels:2,vbr:false});
 const mono=new OpusEncoder(48000,1,{bitrate:48000,forceChannels:1,vbr:false});
 const session=new VoiceRelaySession({relays:new ScreenShareRelays(readScreenShareRelays()),current:()=>current,
  send:m=>socket.send(JSON.stringify(m)),audio:frame=>{
    const codec=frame.length===3840?5:4;
    const packet=validVoiceOpusPacket(frame)?frame.subarray(5):(codec===5?stereo:mono).encode(frame);
    const wire=Buffer.alloc(packet.length+3);wire[0]=codec;wire.writeUInt16BE(2,1);packet.copy(wire,3);session.sendAudio(wire);
  }});
 socket.on('message',data=>{try{session.handle(JSON.parse(data.toString()));}catch{}});
 socket.on('close',()=>{current=false;session.close();stereo.dispose();mono.dispose();});
});
server.listen(port,'127.0.0.1',()=>console.log(`Browser network acceptance: http://127.0.0.1:${port}/network-check`));
