import test from "node:test";
import assert from "node:assert/strict";
import { scoreGateway, selectGateway, setGatewayOrigins, markGatewayFailed } from "../src/voice/gateway-routes.js";
test("gateway scoring penalizes jitter and failed probes",()=>{
 assert.ok(scoreGateway([60,61,60]) < scoreGateway([20,130,30]));
 assert.ok(scoreGateway([60,61,60]) < scoreGateway([1]));
 assert.equal(scoreGateway([]),Infinity);
});
test("only configured HTTPS origins are probed and a failed entry falls back",async t=>{
 const old=Object.getOwnPropertyDescriptor(globalThis,'location');
 Object.defineProperty(globalThis,'location',{configurable:true,value:{origin:'https://entry.example',protocol:'https:',host:'entry.example'}});
 t.after(()=>{setGatewayOrigins([]);if(old)Object.defineProperty(globalThis,'location',old);else Reflect.deleteProperty(globalThis,'location');});
 const calls:string[]=[];
 t.mock.method(globalThis,'fetch',async input=>{const url=String(input);calls.push(url);if(url.startsWith('https://entry.example'))throw Error('offline');return new Response('{"status":"ok"}');});
 setGatewayOrigins(['https://entry.example','https://relay.example','http://untrusted.example']);
 assert.equal(await selectGateway(new AbortController().signal),'https://relay.example');
 assert.ok(calls.some(url=>url.startsWith('https://relay.example')));
 assert.ok(!calls.some(url=>url.startsWith('http://')));
 markGatewayFailed('https://relay.example');calls.length=0;
 await selectGateway(new AbortController().signal);
 assert.ok(!calls.some(url=>url.startsWith('https://relay.example')));
});
test("an aborted route selection cannot cache a destination",async t=>{
 const old=Object.getOwnPropertyDescriptor(globalThis,'location');
 Object.defineProperty(globalThis,'location',{configurable:true,value:{origin:'https://abort.example'}});
 t.after(()=>{setGatewayOrigins([]);if(old)Object.defineProperty(globalThis,'location',old);else Reflect.deleteProperty(globalThis,'location');});
 setGatewayOrigins(['https://abort.example','https://alternate.example']);
 const controller=new AbortController();controller.abort();
 t.mock.method(globalThis,'fetch',async()=>{throw Error('must not fetch');});
 assert.equal(await selectGateway(controller.signal),'https://abort.example');
});
