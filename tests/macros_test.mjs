import assert from 'node:assert/strict';
import {encodeMacro,decodeMacro,encodeRules,decodeRules,emptyRules,MacroClient,MacroRecorder,crc16} from '../web/macros.mjs';
import {HidTransport} from '../web/transport.mjs';
const model={name:'test',mode:0,repeat:2,pauseMs:80,steps:[{act:1,key:224,edge:1,delayMs:20},{act:3,key:1,edge:1,delayMs:50},{act:3,key:1,edge:0,delayMs:20},{act:1,key:224,edge:0,delayMs:1}]};
const bytes=encodeMacro(model);assert.equal(bytes.length,62);assert.deepEqual(decodeMacro(bytes),model);assert.equal(crc16(new TextEncoder().encode('123456789')),0x29B1);
for(let i=0;i<bytes.length;i++){const b=bytes.slice();b[i]^=128;assert.throws(()=>decodeMacro(b));}
for(const changes of [{mode:3},{repeat:0},{pauseMs:65536},{name:'汉'.repeat(8)},{steps:Array.from({length:641},()=>model.steps[0])}])assert.throws(()=>encodeMacro({...model,...changes}));
assert.throws(()=>encodeMacro({...model,steps:[{act:3,key:19,edge:1,delayMs:20}]}));
const rules=emptyRules();rules[0]={buttons:1<<19,slot:15,gesture:4,profiles:5,enabled:true,suppress:true,holdMs:400,tapMs:100};assert.deepEqual(decodeRules(encodeRules(rules)),rules);assert.throws(()=>encodeRules([{...rules[0],buttons:0},...rules.slice(1)]));
let reply=new Uint8Array(63),stage,stored=new Uint8Array(),storedRules=encodeRules(emptyRules()),calls=[];
const device={async sendFeatureReport(id,p){assert.equal(id,0xF3);assert.equal(p.length,63);calls.push(p.slice());const cmd=p[0],offset=p[3]|p[4]<<8;reply=new Uint8Array(63);reply.set([1,cmd,p[1],0,p[2],255]);reply[8]=p[3];reply[9]=p[4];
 if(cmd===2||cmd===8)stage=new Uint8Array(offset);if(cmd===3||cmd===9)stage.set(p.slice(6,6+p[5]),offset);if(cmd===4)stored=stage.slice();if(cmd===10)storedRules=stage.slice();
 const data=cmd===1?stored:cmd===6?storedRules:null;if(data){const chunk=data.slice(offset,offset+51);reply[10]=data.length&255;reply[11]=data.length>>8;reply[7]=chunk.length;reply.set(chunk,12);}},async receiveFeatureReport(id){const a=new Uint8Array(64);a[0]=id;a.set(reply,1);return new DataView(a.buffer);}};
const client=new MacroClient(new HidTransport(device));await client.upload(2,bytes);assert.deepEqual(await client.read(1,2),bytes);await client.saveRules(rules);assert.deepEqual(decodeRules(await client.read(6)),rules);assert(calls.some(p=>p[0]===3&&p[5]===57));
reply[0]=2;assert.throws(()=>decodeMacro(new Uint8Array(37)));
const rec=new MacroRecorder(),p=new Uint8Array(63);p[7]=8;rec.start();rec.input(p,0);p[7]=0x28;rec.input(p,20);p[7]=8;rec.input(p,80);const steps=rec.stop(100);assert.deepEqual(steps,[{act:3,key:1,edge:1,delayMs:60},{act:3,key:1,edge:0,delayMs:30}]);
rec.start();p[7]=8;rec.input(p,0);p[7]=0x18;rec.input(p,30);const releases=rec.stop(100);assert.equal(releases.at(-1).edge,0);assert.equal(releases.at(-1).key,0);
console.log('macro web: MAC1/CRC/layout, ranges, bindings, chunked transport, recording and release passed');
