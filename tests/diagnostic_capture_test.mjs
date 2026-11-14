import assert from 'node:assert/strict';
import {DiagnosticCapture} from '../web/diagnostic-capture.mjs';
import {decodeInput} from '../web/mapping-model.mjs';

let now=100;
const capture=new DiagnosticCapture({clock:()=>now,wallClock:()=>0,maxInputs:3,maxFrames:2});
capture.frame({sensorTicks:0,receivedAt:99,sticks:[0,0,0,0]});
assert.equal(capture.snapshot().frames.length,0);
// A DataView/Uint8Array may point into a larger WebHID backing buffer.
const bytes=new Uint8Array(new ArrayBuffer(80),9,63), view=new DataView(bytes.buffer,9,63);
bytes.set([128,128,200,100,255,0]); bytes[7]=8;
view.setInt16(15,-1234,true); view.setInt16(25,-8192,true);
view.setUint32(27,0xfffffffe,true);
now=105; capture.input(bytes);
assert.equal(decodeInput(bytes).sensorTicks,0xfffffffe);
now=107; capture.frame({sensorTicks:0xfffffffe,receivedAt:105,sticks:[0,0,.5,-.25]});
let data=capture.snapshot();
assert.deepEqual(data.inputs[0],[5,0xfffffffe,128,128,200,100,255,0,8,0,0,-1234,0,0,0,0,-8192]);
assert.deepEqual(data.frames[0],[7,0xfffffffe,2,0,0,.5,-.25]);
bytes[2]=0; // Recorded values must not alias the reused input buffer.
assert.equal(data.inputs[0][4],200);
for(let i=0;i<5;i++) { now++; view.setUint32(27,i,true); capture.input(bytes); capture.frame({sensorTicks:i,receivedAt:now,sticks:[0,0,0,0]}); }
data=capture.snapshot();
assert.deepEqual(data.inputs.map(row=>row[1]),[2,3,4]);
assert.deepEqual(data.frames.map(row=>row[1]),[3,4]);
assert.equal(data.inputs[0].length,data.inputColumns.length);
assert.equal(data.frames[0].length,data.frameColumns.length);
now+=30001; assert.equal(capture.snapshot().inputs.length,0);
assert.equal(capture.snapshot().frames.length,0);
capture.reset(); assert.equal(capture.latest,null); assert.equal(capture.snapshot().durationMs,0);
capture.input(new Uint8Array(20)); assert.equal(capture.latest,null);
console.log('diagnostic capture: USB offsets, sensor wrap, render timing, bounds and session reset passed');
