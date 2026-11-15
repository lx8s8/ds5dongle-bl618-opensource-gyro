import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32 } from '../web/zip-reader.mjs';
import {
  DATA_ADDRESS, DATA_LENGTH, FLASH_SIZE, PT_ADDRESS, RECORD_ADDRESS, ROOT_LIMIT,
  ROOT_MARKER, SECTOR_SIZE, SLOT_ADDRESS, SLOT_CAPACITY,
  buildInstallImage, buildRestoreImage, buildCleanRestoreImage, buildSlotUpdate, diffPlan,
  encodePartitionTable, encodeRecord, expectedStock, inspectDualState,
  normalizeSlotVersion, parseRecord, parseStrictPartitionTable, readActiveRecord,
  validateAppImage, validateManagerImage,
} from '../web/dual-firmware.mjs';

const text = s => new TextEncoder().encode(s);
const sha = b => new Uint8Array(createHash('sha256').update(b).digest());

function makeBfnp({ size, offset, flags = 0x72cc0100, markerText = '', rootMarker = false, seed = 1 }) {
  const out = new Uint8Array(size);
  for (let i = offset; i < size; i++) out[i] = (i * 13 + seed) & 255;
  out.set(text('BFNP'), 0);
  const v = new DataView(out.buffer);
  v.setUint32(120, flags >>> 0, true);
  v.setUint32(124, offset >>> 0, true);
  v.setUint32(132, (size - offset) >>> 0, true);
  if (rootMarker) out.set(text(ROOT_MARKER), 0xFE0);
  if (markerText) out.set(text(markerText + '\0'), offset + 64);
  if (!(flags & 0x20000)) out.set(sha(out.subarray(offset)), 136);
  v.setUint32(252, crc32(out.subarray(0, 252)), true);
  return out;
}

function makeStockFlash({ gyroApp, blankPt1 = false, withMfg = true }) {
  const flash = new Uint8Array(FLASH_SIZE).fill(255);
  const boot2 = makeBfnp({ size: 0x2800, offset: 0x2000, seed: 3 });
  flash.set(boot2, 0);
  const pt = encodePartitionTable({
    version: 0, age: 0,
    entries: [
      { type: 16, device: 0, active: 0, name: 'Boot2', address: [0, 0], maxLength: [0xE000, 0] },
      { type: 0, device: 0, active: 0, name: 'FW', address: [0x10000, 0x210000], maxLength: [0x200000, 0x168000] },
      { type: 10, device: 0, active: 0, name: 'mfg', address: [0x210000, 0], maxLength: [0x168000, 0] },
      { type: 2, device: 0, active: 0, name: 'media', address: [0x378000, 0], maxLength: [0x71000, 0] },
      { type: 3, device: 0, active: 0, name: 'PSM', address: [0x3E9000, 0], maxLength: [0x8000, 0] },
      { type: 4, device: 0, active: 0, name: 'KEY', address: [0x3F1000, 0], maxLength: [0x2000, 0] },
      { type: 5, device: 0, active: 0, name: 'DATA', address: [0x3F3000, 0], maxLength: [0x5000, 0] },
      { type: 6, device: 0, active: 0, name: 'factory', address: [0x3F8000, 0], maxLength: [0x8000, 0] },
    ],
  }, SECTOR_SIZE);
  flash.set(pt, PT_ADDRESS[0]);
  if (!blankPt1) flash.set(pt, PT_ADDRESS[1]);
  flash.set(gyroApp, 0x10000);
  if (withMfg) flash.set(text('MFG-CAL-KEEP'), 0x210000);
  flash.set(text('STOCK-PSM'), 0x3E9000);
  flash.set(text('STOCK-KEY'), 0x3F1000);
  flash.set(text('STOCK-DAT'), 0x3F3000);
  flash.set(text('STOCK-MED'), 0x378000);
  flash.set(text('FACTORY-ID'), 0x3F8000);
  return flash;
}

const manager = makeBfnp({ size: 0xD000, offset: 0x2000, flags: 0x72cc0100, rootMarker: true, seed: 5 });
const gyroV1 = makeBfnp({ size: 0x9000, offset: 0x1000, flags: 0x72cf0100, markerText: 'LCT616-DS5 3.18G2.4RC4', seed: 11 });
const gyroHs = makeBfnp({ size: 0x7000, offset: 0x1000, flags: 0x72cf0100, markerText: 'LCT616-DS5 3.18G2.5H', seed: 29 });
const upstreamV1 = makeBfnp({ size: 0xA000, offset: 0x1000, flags: 0x72cf0100, markerText: 'LCT616-DS5 3.24', seed: 17 });
const upstreamV2 = makeBfnp({ size: 0x8000, offset: 0x1000, flags: 0x72cf0100, markerText: 'LCT616-DS5 3.25H', seed: 31 });

// ---- Version normalization & image validation ----
assert.equal(normalizeSlotVersion('LCT616-DS5 3.18G2.4RC4H'), '3.18G2.4RC4H');
assert.equal(normalizeSlotVersion('3.24'), '3.24');
assert.throws(() => normalizeSlotVersion('x'.repeat(20)), /无效/);
await validateManagerImage(manager);
await assert.rejects(validateManagerImage(makeBfnp({ size: 0xE100, offset: 0x2000, rootMarker: true })), /上限/);
await assert.rejects(validateManagerImage(makeBfnp({ size: 0x6000, offset: 0x2000, flags: 0x72cf0100, rootMarker: true })), /SHA256/);
{
  const badSha = manager.slice(); badSha[0x2500] ^= 1;
  await assert.rejects(validateManagerImage(badSha), /SHA256/);
}
await validateAppImage(gyroV1, { maxLength: SLOT_CAPACITY[0] });
await assert.rejects(validateAppImage(makeBfnp({ size: 0x5000, offset: 0x1000, markerText: 'BL618-DS5 3.5G2.4RC4' })), /aim61/);
await assert.rejects(validateAppImage(upstreamV1, { maxLength: 0x5000 }), /上限/);

// ---- Install plan + atomic diff order ----
const stock = makeStockFlash({ gyroApp: gyroV1, blankPt1: true, withMfg: true });
assert.equal(inspectDualState({
  rootHead: stock.subarray(0, ROOT_LIMIT),
  pt0: stock.subarray(0xE000, 0xF000), pt1: stock.subarray(0xF000, 0x10000),
  rec0: stock.subarray(0x340000, 0x341000), rec1: stock.subarray(0x341000, 0x342000),
}).mode, 'stock');

const upSnap = makeStockFlash({ gyroApp: upstreamV1 });
upSnap.set(text('UPST-HIST-PSM'), 0x3E9000);

const inst = await buildInstallImage({
  snapshot: stock, manager, gyro: gyroV1, upstream: upstreamV1,
  gyroVersion: 'LCT616-DS5 3.18G2.4RC4', upstreamVersion: '3.24',
  upstreamSnapshot: upSnap,
});
assert.equal(inst.after.length, FLASH_SIZE);
assert.deepEqual([...inst.after.subarray(0, manager.length)], [...manager]);
assert.deepEqual([...inst.after.subarray(SLOT_ADDRESS[0], SLOT_ADDRESS[0] + gyroV1.length)], [...gyroV1]);
assert.deepEqual([...inst.after.subarray(SLOT_ADDRESS[1], SLOT_ADDRESS[1] + upstreamV1.length)], [...upstreamV1]);
assert.equal(new TextDecoder().decode(inst.after.subarray(0x330000, 0x330009)), 'STOCK-PSM');
assert.equal(new TextDecoder().decode(inst.after.subarray(0x3E9000, 0x3E900D)), 'UPST-HIST-PSM');
assert.equal(new TextDecoder().decode(inst.after.subarray(0x3F8000, 0x3F800A)), 'FACTORY-ID');
const dualPt = parseStrictPartitionTable(inst.after.subarray(0xE000, 0xF000));
assert.equal(dualPt.entries.find(e => e.name === 'FW').maxLength[0], SLOT_CAPACITY[0]);
assert.equal(dualPt.entries.find(e => e.name === 'mfg'), undefined);
assert.equal(parseRecord(inst.after.subarray(0x340000, 0x341000)).images[0].version, '3.18G2.4RC4');
assert.equal(inst.segments.at(-1).address, 0, 'root BFNP header must be programmed LAST');
assert.ok(inst.segments.findIndex(s => s.address === 0xE000) < inst.segments.findIndex(s => s.address === 0));
assert.throws(() => expectedStock(inst.after), /已安装/);

// ---- Slot updates (shorter image wipes stale tail & increments gen on inactive copy) ----
const dual = inst.after.slice();
const clean = await buildCleanRestoreImage({ current: dual, boot2: stock.slice(0, 0x2800), partition: stock.slice(0xE000, 0xF000), firmware: gyroV1 });
expectedStock(clean.after);
assert.equal(new TextDecoder().decode(clean.after.subarray(0x3F8000, 0x3F800A)), 'FACTORY-ID');
assert.ok(clean.after.subarray(0x3F1000, 0x3F3000).every(v => v === 255));
assert.equal(clean.segments.at(-1).address, 0);
await assert.rejects(buildCleanRestoreImage({ current: dual, boot2: manager, partition: stock.slice(0xE000, 0xF000), firmware: gyroV1 }), /Boot2/);
dual.set(text('DUAL-GYRO-PSM-V2'), 0x330000);
const upd0 = await buildSlotUpdate({
  rootHead: dual.subarray(0, ROOT_LIMIT),
  pt0: dual.subarray(0xE000, 0xF000), pt1: dual.subarray(0xF000, 0x10000),
  rec0: dual.subarray(0x340000, 0x341000), rec1: dual.subarray(0x341000, 0x342000),
  slot: 0, firmware: gyroHs, version: '3.18G2.5H',
});
assert.equal(upd0.record.gen, 2);
assert.equal(upd0.targetCopy, 1);
assert.equal(upd0.segments[0].address, SLOT_ADDRESS[0]);
assert.equal(upd0.segments[0].data.length, gyroV1.length); // >= prevLen (9 sectors) so tail is wiped 0xFF
assert.equal(upd0.segments[1].address, RECORD_ADDRESS[1]);
for (const seg of upd0.segments) dual.set(seg.data, seg.address);
assert.equal(readActiveRecord(dual.subarray(0x340000, 0x341000), dual.subarray(0x341000, 0x342000)).activeCopy, 1);

const upd1 = await buildSlotUpdate({
  rootHead: dual.subarray(0, ROOT_LIMIT),
  pt0: dual.subarray(0xE000, 0xF000), pt1: dual.subarray(0xF000, 0x10000),
  rec0: dual.subarray(0x340000, 0x341000), rec1: dual.subarray(0x341000, 0x342000),
  slot: 1, firmware: upstreamV2, version: '3.25H',
});
assert.equal(upd1.record.gen, 3);
assert.equal(upd1.targetCopy, 0);
for (const seg of upd1.segments) dual.set(seg.data, seg.address);
assert.deepEqual([...dual.subarray(SLOT_ADDRESS[0], SLOT_ADDRESS[0] + gyroHs.length)], [...gyroHs]);
assert.deepEqual([...dual.subarray(SLOT_ADDRESS[1], SLOT_ADDRESS[1] + upstreamV2.length)], [...upstreamV2]);
assert.equal(new TextDecoder().decode(dual.subarray(0x330000, 0x330010)), 'DUAL-GYRO-PSM-V2');

// ---- Restore single firmware (slot 0 preserves gyro data & slot 1 preserves upstream data) ----
const res0 = await buildRestoreImage({ current: dual, original: stock, slot: 0 });
assert.deepEqual([...res0.after.subarray(0, 0xE000)], [...stock.subarray(0, 0xE000)]);
assert.deepEqual([...res0.after.subarray(0x10000, 0x10000 + gyroHs.length)], [...gyroHs]);
assert.equal(new TextDecoder().decode(res0.after.subarray(0x3E9000, 0x3E9010)), 'DUAL-GYRO-PSM-V2');
assert.equal(new TextDecoder().decode(res0.after.subarray(0x210000, 0x21000C)), 'MFG-CAL-KEEP');
assert.equal(parseRecord(res0.after.subarray(0x340000, 0x341000)), null);
assert.equal(res0.segments.at(-1).address, 0);

const res1 = await buildRestoreImage({ current: dual, original: stock, slot: 1 });
assert.deepEqual([...res1.after.subarray(0x10000, 0x10000 + upstreamV2.length)], [...upstreamV2]);
assert.equal(new TextDecoder().decode(res1.after.subarray(0x3E9000, 0x3E900D)), 'UPST-HIST-PSM');

// ---- Reject tampered slot on restore ----
const brokenDual = dual.slice(); brokenDual[SLOT_ADDRESS[0] + 0x1200] ^= 0xff;
await assert.rejects(buildRestoreImage({ current: brokenDual, original: stock, slot: 0 }), /SHA256 与 DBM1 记录不一致/);

// ---- Diff sanity when identical ----
assert.deepEqual(diffPlan(stock, stock), []);
console.log('dual firmware: validation, install plan, bank preservation, slot updates and restore passed');
