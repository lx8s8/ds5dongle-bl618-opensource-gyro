import assert from 'node:assert/strict';
import {BootManager,decodeBootStatus,requestBootManager} from '../web/boot-manager.mjs';
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
console.log('boot manager: feature framing, strict identity, corrupt slots, ACK and cancellation passed');
