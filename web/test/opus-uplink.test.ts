import test from "node:test";
import assert from "node:assert/strict";
import { createOpusUplink } from "../src/voice/opus-uplink.js";
function setup(t: Parameters<Parameters<typeof test>[1]>[0] | any) {
  const instances: any[] = []; let resolve: ((v:any)=>void) | null = null;
  class Encoder {
    static isConfigSupported = async () => ({supported:true});
    encodeQueueSize = 0; closed = false;
    constructor(public callbacks:any) { instances.push(this); }
    configure() {} encode() {} close() { this.closed=true; }
  }
  class Data { close() {} }
  for (const [key,value] of Object.entries({AudioEncoder:Encoder,AudioData:Data})) {
    const old=Object.getOwnPropertyDescriptor(globalThis,key);
    Object.defineProperty(globalThis,key,{configurable:true,value});
    t.after(()=>{if(old)Object.defineProperty(globalThis,key,old);else Reflect.deleteProperty(globalThis,key);});
  }
  return {instances,Encoder,delay:()=>{Encoder.isConfigSupported=()=>new Promise(done=>{resolve=done;});},resolve:()=>resolve?.({supported:true})};
}
test("an encoder retired by disconnect cannot publish delayed output or failure", async t=>{
 const f=setup(t),sent:Uint8Array[]=[],errors:string[]=[];
 const encoder=createOpusUplink({send:p=>sent.push(p),canSend:()=>true,onFailure:()=>errors.push('failed')});
 assert.equal(await encoder.prepare(48),true); const old=f.instances[0];encoder.close();
 old.callbacks.output({byteLength:2,copyTo:(out:Uint8Array)=>out.set([0xf8,0])});old.callbacks.error(new Error());
 assert.equal(sent.length,0);assert.equal(errors.length,0);
});
test("silence while capability probing does not disable compressed uplink",async t=>{
 const f=setup(t);f.delay();
 const encoder=createOpusUplink({send:()=>{},canSend:()=>true,onFailure:()=>{}});
 const pending=encoder.prepare(48);encoder.invalidate();f.resolve();assert.equal(await pending,true);encoder.close();
});
test("pending capability probing is retired on disconnect",async t=>{
 const f=setup(t);f.delay();const encoder=createOpusUplink({send:()=>{},canSend:()=>true,onFailure:()=>{}});
 const pending=encoder.prepare(48);encoder.close();f.resolve();assert.equal(await pending,false);assert.equal(f.instances.length,0);
});
test("encoder failure restores fallback and queued frames stay bounded",async t=>{
 const f=setup(t);let failed=0;const encoder=createOpusUplink({send:()=>{},canSend:()=>true,onFailure:()=>{failed++;}});
 await encoder.prepare(48);f.instances[0].encodeQueueSize=6;assert.equal(encoder.push(new Int16Array(960)),true);
 f.instances[0].callbacks.error(new Error());assert.equal(failed,1);assert.equal(encoder.push(new Int16Array(960)),false);encoder.close();
});
