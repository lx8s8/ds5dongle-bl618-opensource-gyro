import assert from 'node:assert/strict';
import {BootManager,decodeBootStatus,requestBootManager,enterManagerFromUpstream,initBootManager} from '../web/boot-manager.mjs';
function report(){const a=new Uint8Array(64);a[0]=0x70;a.set(new TextEncoder().encode('DBMR'),1);a[5]=1;a[6]=1;a[7]=0;a[8]=3;a[12]=1;a[61]=1;return a;}
const p=report();assert.equal(decodeBootStatus(p).valid,3);assert.equal(decodeBootStatus(p).selected,0);
for(const offset of [0,1,5,12,61]){const b=p.slice();b[offset]^=128;assert.throws(()=>decodeBootStatus(b));}
assert.throws(()=>decodeBootStatus(p.slice(1)));
const fake={vendorId:0x1209,productId:1,collections:[{usagePage:0xFF00,featureReports:[{reportId:0x70}]}],
 async receiveFeatureReport(){return new DataView(p.buffer);},async sendFeatureReport(id,data){assert.equal(id,0x70);assert.equal(data.length,63);p[9]=data[0];p[10]=0;p[11]=data[1];p[7]=data[2];}};
assert.equal(await requestBootManager({getDevices:async()=>[fake]}),fake);
await new BootManager(fake).boot(1);assert.equal(decodeBootStatus(p).selected,1);
await assert.rejects(()=>new BootManager(fake).boot(2));
p[8]=1;await assert.rejects(()=>new BootManager(fake).boot(1),/校验/);
const gamepad={...fake,collections:[{usagePage:1,featureReports:[{reportId:0xFC}]}]};
await assert.rejects(()=>requestBootManager({getDevices:async()=>[gamepad],requestDevice:async()=>[gamepad]}),/日常手柄/);
assert.equal(await requestBootManager({requestDevice:async()=>[]}),undefined);
const holdReport=report();let resetSent=false,holdSent=false;
const upstream={opened:false,collections:[{featureReports:[{reportId:0xf6}]}],async open(){this.opened=true;},async close(){this.opened=false;},async sendFeatureReport(id,data){assert.equal(id,0xf6);assert.equal(data[0],3);resetSent=true;}};
const holdManager={...fake,opened:false,async open(){this.opened=true;},async close(){this.opened=false;},async sendFeatureReport(id,data){assert.equal(id,0x70);assert.equal(data[0],2);holdSent=true;holdReport[9]=2;holdReport[10]=0;holdReport[11]=data[1];},async receiveFeatureReport(){return new DataView(holdReport.buffer);}};
await enterManagerFromUpstream({requestDevice:async()=>[upstream],getDevices:async()=>[holdManager]});
assert.ok(resetSent&&holdSent);assert.equal(upstream.opened,false);assert.equal(holdManager.opened,false);
await assert.rejects(enterManagerFromUpstream({requestDevice:async()=>[{collections:[]}]}),/不支持/);
// Manager activity replaces stale gyro-connection notices without making the
// serial installer depend on a gyro HID connection.
const savedDocument=Object.getOwnPropertyDescriptor(globalThis,'document');
const savedNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
const savedInterval=globalThis.setInterval;
const elements=Object.fromEntries(['bootState','bootConnect','bootDisconnect','bootSlot0','bootSlot1','bootEnter','bootEnterUpstream','bootVersion0','bootVersion1'].map(id=>[id,{}]));
const statusReport=report();
const managerDevice={...fake,opened:false,async open(){this.opened=true;},async close(){this.opened=false;},
 async receiveFeatureReport(){return new DataView(statusReport.buffer);},
 async sendFeatureReport(id,data){statusReport[9]=data[0];statusReport[10]=0;statusReport[11]=data[1];}};
try{
 Object.defineProperty(globalThis,'document',{configurable:true,value:{getElementById:id=>elements[id]}});
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{hid:{getDevices:async()=>[managerDevice],addEventListener(){}}}});
 globalThis.setInterval=()=>0;
 const events=[];initBootManager({enterManager:async()=>{},onManagerActivity:state=>events.push(state)});
 await elements.bootConnect.onclick();assert.equal(events.at(-1),'connected');
 await elements.bootSlot1.onclick();assert.equal(events.at(-1),'upstream');
 await elements.bootEnter.onclick();assert.equal(events.at(-1),'entering');
} finally {
 if(savedDocument)Object.defineProperty(globalThis,'document',savedDocument);else delete globalThis.document;
 if(savedNavigator)Object.defineProperty(globalThis,'navigator',savedNavigator);else delete globalThis.navigator;
 globalThis.setInterval=savedInterval;
}
console.log('boot manager: feature framing, strict identity, corrupt slots, ACK and cancellation passed');
