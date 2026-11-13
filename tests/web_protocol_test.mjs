import assert from 'node:assert/strict';
import { defaults, encodeConfig, decodeConfig, featureBytes, decodeStatus } from '../web/protocol.mjs';

const c = defaults();
assert.deepEqual(decodeConfig(encodeConfig(c)), c);
assert.equal(encodeConfig(c).length, 40);
for (const changes of [
  { threshold: 0 }, { sx: NaN }, { sy: Infinity }, { sx: .001 }, { sx: '2' },
  { activation: 1, trigger: 0, buttons: 0 }, { accelStart: 180, accelEnd: 180 },
  { buttons: 0x1000000 }, { flags: 16 }, { profileSource: 1, profiles: 0 },
  { profileSource: 2, profiles: 4 },
]) assert.throws(() => encodeConfig({ ...c, ...changes }));
for (const changes of [
  { output: 1, activation: 2, trigger: 0, buttons: 1 << 21 },
  { output: 2, activation: 0, profileSource: 1, profiles: 2 },
  { output: 1, activation: 0, profileSource: 2, profiles: 2 },
]) {
  const config = { ...c, ...changes };
  assert.deepEqual(decodeConfig(encodeConfig(config)), config);
}
const wire = new Uint8Array(64); wire[0] = 0xFC; wire.set(encodeConfig(c), 1);
assert.deepEqual(decodeConfig(featureBytes(new DataView(wire.buffer), 0xFC)), c);
assert.throws(() => featureBytes(new DataView(wire.buffer, 1), 0xFC));
assert.throws(() => featureBytes(new DataView(wire.buffer), 0xFD));
const status = new Uint8Array(63), v = new DataView(status.buffer);
status[0] = 1; status[1] = 27; v.setInt16(8, -300, true);
v.setInt32(24, 200050, true); status[62] = 0x12;
const s = decodeStatus(status);
assert.equal(s.raw[0], -300); assert.equal(s.rates[1], 2000.5);
assert.equal(s.edgeProfile, 2); assert.equal(s.dongleProfile, 1);
console.log('web protocol: round trips, ranges, profile masks, HID framing and telemetry passed');
