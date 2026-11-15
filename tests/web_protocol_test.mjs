import assert from 'node:assert/strict';
import { defaults, encodeConfig, decodeConfig, featureBytes, decodeStatus, globalDefaults, encodeGlobal, decodeGlobal, decodeProfiles, decodeDiagnostics, importBundle } from '../web/protocol.mjs';

const c = defaults();
assert.deepEqual(decodeConfig(encodeConfig(c)), c);
assert.equal(encodeConfig(c).length, 40);
for (const changes of [
  { threshold: 0 }, { sx: NaN }, { sy: Infinity }, { sx: .001 }, { sx: '2' },
  { activation: 1, trigger: 0, buttons: 0 }, { accelStart: 180, accelEnd: 180 },
  { buttons: 0x1000000 }, { flags: 128 }, { horizontal: 3 }, { profileSource: 1, profiles: 0 },
  { profileSource: 2, profiles: 4 }, { fireBiasDps: 64 }, { fireBiasDps: .25 }, { fireRampMs: 3200 }, { fireRampMs: 25 },
]) assert.throws(() => encodeConfig({ ...c, ...changes }));
for (const changes of [
  { output: 1, activation: 2, trigger: 0, buttons: 1 << 21 },
  { output: 2, activation: 0, profileSource: 1, profiles: 2 },
  { output: 1, activation: 0, profileSource: 2, profiles: 2 },
  { output: 1, horizontal: 2, flags: 16 | 32 },
  { output: 1, flags: 64, fireBiasDps: 12.5, fireRampMs: 300 },
  { output: 2, blend: 1, profileSource: 2, profiles: 1, flags: 64, fireBiasDps: 63.5, fireRampMs: 3150 },
]) {
  const config = { ...c, ...changes };
  assert.deepEqual(decodeConfig(encodeConfig(config)), config);
}
{
  // Fire bias shares bytes 34/35 with blend/profile source without disturbing them.
  const packed = encodeConfig({ ...c, output: 2, blend: 1, profileSource: 2, profiles: 1, flags: 64, fireBiasDps: 10, fireRampMs: 1000 });
  assert.equal(packed[34], 1 | (20 << 1)); assert.equal(packed[35], 2 | (20 << 2)); assert.equal(packed[5], 64);
  // Old exports without the new fields still import with the bias disabled.
  const legacy = { ...c }; delete legacy.fireBiasDps; delete legacy.fireRampMs;
  const bundle = importBundle({ version: 2, profiles: [legacy, legacy, legacy, legacy], settings: globalDefaults() });
  assert.equal(bundle.profiles[0].fireBiasDps, 0); assert.equal(bundle.profiles[0].fireRampMs, 0);
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

const g = globalDefaults();
g.actions[0] = { action: 1, gesture: 1, target: 0, suppress: 1, hold: 300, fine: .5, buttons: (1 << 12) | (1 << 11) };
assert.equal(encodeConfig(c)[0], 2);
assert.deepEqual(decodeGlobal(encodeGlobal(g)), g);
const gp = new Uint8Array(63); gp.set([2, 4, 1, 2]); gp.set(encodeGlobal(g).slice(0, 9), 4); gp.set(encodeGlobal(g).slice(9), 15);
assert.deepEqual(decodeProfiles(gp), { edit: 1, active: 2, settings: g });
for (const changes of [{ source: 3 }, { manual: 4 }, { edge: [0, 1] }, { dongle: [0, 4] }, { feedback: 2 }]) assert.throws(() => encodeGlobal({ ...g, ...changes }));
for (const changes of [{ buttons: 0 }, { gesture: 3 }, { action: 6, gesture: 2 }, { action: 6, fine: 1.01 }, { suppress: 2 }, { fine: NaN }]) {
  const changed = structuredClone(g); Object.assign(changed.actions[0], changes); assert.throws(() => encodeGlobal(changed));
}
const duplicate = structuredClone(g); duplicate.actions[1] = { ...duplicate.actions[0] }; assert.throws(() => encodeGlobal(duplicate));
assert.throws(() => encodeConfig({ ...c, threshold: 50, releaseThreshold: 60 }));
const legacy = encodeConfig(c); legacy[0] = 1; legacy.fill(0, 37); assert.deepEqual(decodeConfig(legacy), c);
const old = { ...c, profileSource: 1, profiles: 2 }; delete old.releaseThreshold; delete old.adsMultiplier;
const migrated = importBundle({ version: 1, config: old });
assert.deepEqual(migrated.settings.edge, [255, 0, 255, 255]); assert.equal(migrated.profiles[0].profileSource, 0);
assert.deepEqual(importBundle({ version: 2, profiles: [c, c, c, c], settings: g }), { profiles: [c, c, c, c], settings: g });
assert.throws(() => importBundle({ version: 2, profiles: [c], settings: g }));
const perf = new Uint8Array(63); perf[0] = 2; new DataView(perf.buffer).setUint32(34, 17, true);
assert.equal(decodeDiagnostics(perf).queueDrops, 17);
console.log('web protocol: v2 bank, actions, hysteresis, legacy migration, import and diagnostics passed');
