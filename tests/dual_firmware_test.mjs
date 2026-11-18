import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32 } from '../web/zip-reader.mjs';
import { prepareFirmwareUpdate } from '../web/flash-ui.mjs';
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

// A stock upstream receiver can be installed directly through serial without
// a gyro-config connection. Its current pairing/settings bank stays in the
// upstream slot and is copied into the initial gyro bank.
const fromUpstream = await buildInstallImage({
  snapshot: upSnap, manager, gyro: gyroV1, upstream: upstreamV1,
  gyroVersion: '3.18G2.4RC4', upstreamVersion: '3.24',
});
assert.deepEqual(fromUpstream.after.subarray(0x330000, 0x338000), upSnap.subarray(0x3E9000, 0x3F1000));
assert.deepEqual(fromUpstream.after.subarray(0x3E9000, 0x3F1000), upSnap.subarray(0x3E9000, 0x3F1000));
assert.equal(fromUpstream.segments.at(-1).address, 0);

const inst = await buildInstallImage({
  snapshot: stock, manager, gyro: gyroV1, upstream: upstreamV1,
  gyroVersion: 'LCT616-DS5 3.18G2.4RC4', upstreamVersion: '3.24',
  upstreamSnapshot: upSnap,
});
// Downloaded release updates must never overwrite the manager or the other slot.
const fakeFlasher = flash => ({ flashSize: FLASH_SIZE, readFlash: async (address, size) => flash.slice(address, address + size) });
const downloadedPkg = { images: { boot2: { name: 'boot2' }, partition: { name: 'partition' }, firmware: { data: gyroHs } }, embedded: { version: '3.18G2.5H' } };
const stockUpdate = await prepareFirmwareUpdate(fakeFlasher(stock), downloadedPkg, { mode: 'app', dualSlot: 0 });
assert.equal(stockUpdate.mode, 'stock');
assert.deepEqual(stockUpdate.segments, [downloadedPkg.images.firmware]);
assert.equal((await prepareFirmwareUpdate(fakeFlasher(stock), downloadedPkg, { mode: 'full', dualSlot: 0 })).segments.length, 3);
for (const slot of [0, 1]) {
  const pkg = slot === 0 ? downloadedPkg : { images: { firmware: { data: upstreamV2 } }, embedded: { version: '3.25H' } };
  const update = await prepareFirmwareUpdate(fakeFlasher(inst.after), pkg, { mode: 'full', dualSlot: slot });
  assert.equal(update.mode, 'dual');
  assert.equal(update.segments[0].address, SLOT_ADDRESS[slot]);
  assert.ok(RECORD_ADDRESS.includes(update.segments[1].address));
  const next = parseRecord(update.segments[1].data);
  assert.equal(next.selected, inst.record.selected);
  assert.deepEqual(next.images[1 - slot], inst.record.images[1 - slot]);
}
await assert.rejects(prepareFirmwareUpdate(fakeFlasher(inst.after), downloadedPkg, { mode: 'full' }), /无法确定/);
const partial = inst.after.slice(); partial.fill(255, RECORD_ADDRESS[0], RECORD_ADDRESS[1] + SECTOR_SIZE);
await assert.rejects(prepareFirmwareUpdate(fakeFlasher(partial), downloadedPkg, { mode: 'full', dualSlot: 0 }), /不完整/);
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

// Experimental manager upgrade: staged extension, guarded root and full backup.
{
  const { buildBondUpgrade, buildBondFirstInstall, buildBondFirstRecovery, buildBondUpgradeRecovery, BOND_ADDRESS, BOND_LENGTH } = await import('../experimental/bond_sync/upgrade_plan.mjs');
  const ext = new Uint8Array(16000).fill(0x35), digest = sha(ext);
  const guarded = manager.slice();guarded.set(digest,0x2100);guarded.set(sha(guarded.subarray(0x2000)),136);
  new DataView(guarded.buffer).setUint32(252,crc32(guarded.subarray(0,252)),true);
  const {makeBondPackage,parseBondPackage}=await import('../experimental/bond_sync/package.mjs');
  const bundle=await makeBondPackage(guarded,ext),parsed=await parseBondPackage(bundle);
  assert.deepEqual(parsed.manager,guarded);assert.deepEqual(parsed.extension,ext);
  const corrupt=bundle.slice();corrupt[ROOT_LIMIT+10]^=1;await assert.rejects(parseBondPackage(corrupt),/校验/);
  const invalidPadding=bundle.slice();invalidPadding[ROOT_LIMIT+ext.length]=0;await assert.rejects(parseBondPackage(invalidPadding),/填充/);
  const initial=await buildBondFirstInstall({snapshot:stock,...parsed,gyro:gyroV1,upstream:upstreamV1,gyroVersion:'3.18G2.4RC4',upstreamVersion:'3.24'});
  assert.deepEqual(initial.after.subarray(BOND_ADDRESS,BOND_ADDRESS+ext.length),ext);
  assert.equal(initial.segments.at(-1).address,0);
  // Recover a torn first-install plan using the original stock image.
  const interruptedStock=stock.slice();for(const segment of initial.segments.slice(0,2))interruptedStock.set(segment.data,segment.address);
  const stockRecovery=await buildBondFirstRecovery({current:interruptedStock,backup:stock});assert.deepEqual(stockRecovery.after,stock);
  const badBoot2=stock.slice();badBoot2[0x2100]^=1;
  await assert.rejects(buildBondFirstRecovery({current:interruptedStock,backup:badBoot2}),/SHA256/);
  const wrongFactory=interruptedStock.slice();wrongFactory[0x3f8000]^=1;
  await assert.rejects(buildBondFirstRecovery({current:wrongFactory,backup:stock}),/factory/);
  const occupiedStock=stock.slice();occupiedStock[BOND_ADDRESS]=0;
  await assert.rejects(buildBondFirstInstall({snapshot:occupiedStock,...parsed,gyro:gyroV1,upstream:upstreamV1,gyroVersion:'3.18G2.4RC4',upstreamVersion:'3.24'}),/非空/);
  // The rendered controls keep programming disabled until a verified backup
  // has been selected and the user explicitly confirms the operation.
  const {readFile}=await import('node:fs/promises');const html=await readFile(new URL('../web/index.html',import.meta.url),'utf8');
  const elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],{id:m[1],value:'',files:[],checked:false,hidden:false,disabled:false,textContent:'',classList:{toggle(){}},replaceChildren(){},scrollIntoView(){}}]));
  elements.get('dualOp').value='bond';elements.get('dualSlotTarget').value='0';
  globalThis.document={getElementById:id=>elements.get(id)||null};
  Object.defineProperty(globalThis,'navigator',{value:{serial:{}},configurable:true});
  const {initDualFirmware}=await import('../web/dual-ui.mjs');const ui=initDualFirmware();
  assert.equal(elements.get('bondPrepare').disabled,true);assert.equal(elements.get('bondInstall').disabled,true);
  await ui.loadManagerSource('bundle.bin',bundle);assert.match(elements.get('dualMgrSummary').textContent,/支持配对同步/);
  assert.equal(elements.get('bondPrepare').disabled,false);assert.equal(elements.get('bondInstall').disabled,true);
  const file={name:'manager.bin',size:bundle.length,arrayBuffer:async()=>bundle.buffer.slice(bundle.byteOffset,bundle.byteOffset+bundle.byteLength)};
  const input=elements.get('bondPackageFile');input.files=[file];await input.onchange({target:input});
  assert.equal(elements.get('bondPrepare').disabled,false);assert.equal(elements.get('bondInstall').disabled,true);
  assert.equal(elements.get('bondRecover').disabled,true);
  const backupInput=elements.get('bondBackupFile'),dummyBackup=new Uint8Array(FLASH_SIZE+64);
  backupInput.files=[{name:'recovery.ds5backup',size:dummyBackup.length,arrayBuffer:async()=>dummyBackup.buffer}];
  await backupInput.onchange({target:backupInput});assert.equal(elements.get('bondRecover').disabled,true);
  elements.get('bondConfirm').checked=true;elements.get('bondConfirm').onchange();
  assert.equal(elements.get('bondRecover').disabled,false);assert.equal(elements.get('bondInstall').disabled,true);
  const plan = await buildBondUpgrade({snapshot:inst.after,...parsed});
  assert.equal(plan.segments[0].address,BOND_ADDRESS);assert.equal(plan.segments.at(-1).address,0);
  assert.deepEqual(plan.after.subarray(BOND_ADDRESS,BOND_ADDRESS+ext.length),ext);
  assert.deepEqual(plan.after.subarray(0x330000,0x340000),inst.after.subarray(0x330000,0x340000));
  const {prepareBondUpgrade,confirmBondUpgrade,recoverBondUpgrade,prepareBondFirstInstall,confirmBondFirstInstall}=await import('../web/bond-transaction.mjs');
  let freshFlash=stock.slice(),freshWrites=0;
  const freshDevice={flashSize:FLASH_SIZE,info:{chipId:'001122AABBCC'},readFlash:async()=>freshFlash.slice(),program:async segs=>{freshWrites++;for(const seg of segs)freshFlash.set(seg.data,seg.address);}};
  const firstPrepared=await prepareBondFirstInstall(freshDevice,bundle,{gyro:gyroV1,upstream:upstreamV1,gyroVersion:'3.18G2.4RC4',upstreamVersion:'3.24'});
  await assert.rejects(confirmBondFirstInstall(freshDevice,firstPrepared,firstPrepared.backup.slice(0,-1)),/刚下载/);assert.equal(freshWrites,0);
  await confirmBondFirstInstall(freshDevice,firstPrepared,firstPrepared.backup);assert.deepEqual(freshFlash,initial.after);
  await recoverBondUpgrade(freshDevice,firstPrepared.backup);assert.deepEqual(freshFlash,stock);
  let emulated=inst.after.slice(),writes=0;
  const device={flashSize:FLASH_SIZE,info:{chipId:'001122AABBCC'},
    readFlash:async()=>emulated.slice(),program:async segments=>{writes++;for(const segment of segments)emulated.set(segment.data,segment.address);}};
  const prepared=await prepareBondUpgrade(device,bundle);
  await assert.rejects(confirmBondUpgrade(device,prepared,prepared.backup.slice(0,-1)),/刚下载/);assert.equal(writes,0);
  emulated[0x330000]^=1;await assert.rejects(confirmBondUpgrade(device,prepared,prepared.backup),/已变化/);assert.equal(writes,0);emulated[0x330000]^=1;
  await confirmBondUpgrade(device,prepared,prepared.backup);assert.equal(writes,1);assert.deepEqual(emulated,plan.after);
  device.info.chipId='001122AABBCD';await assert.rejects(recoverBondUpgrade(device,prepared.backup),/不属于/);assert.equal(writes,1);
  device.info.chipId='001122AABBCC';await recoverBondUpgrade(device,prepared.backup);assert.equal(writes,2);assert.deepEqual(emulated,inst.after);
  const damagedRoot=inst.after.slice();damagedRoot[0x2100]^=1;
  await assert.rejects(buildBondUpgrade({snapshot:damagedRoot,manager:guarded,extension:ext,digest}),/SHA256/);
  const occupied=inst.after.slice();occupied[BOND_ADDRESS]=0;
  await assert.rejects(buildBondUpgrade({snapshot:occupied,manager:guarded,extension:ext,digest}),/非空/);
  const ambiguous=inst.after.slice(),second=parseRecord(ambiguous.subarray(RECORD_ADDRESS[1],RECORD_ADDRESS[1]+256));
  second.manage=1;ambiguous.set(encodeRecord(second),RECORD_ADDRESS[1]);
  await assert.rejects(buildBondUpgrade({snapshot:ambiguous,manager:guarded,extension:ext,digest}),/管理记录冲突/);
  const shortRecord=inst.after.slice();for(const address of RECORD_ADDRESS){const r=parseRecord(shortRecord.subarray(address,address+256));r.images[0].len=1;shortRecord.set(encodeRecord(r),address);}
  await assert.rejects(buildBondUpgrade({snapshot:shortRecord,manager:guarded,extension:ext,digest}),/镜像字段/);
  const badDevice=inst.after.slice(),devicePt=parseStrictPartitionTable(badDevice.subarray(0xe000,0xf000));devicePt.entries.find(e=>e.name==='FW').device=1;
  const badDeviceBytes=encodePartitionTable(devicePt,SECTOR_SIZE);badDevice.set(badDeviceBytes,0xe000);badDevice.set(badDeviceBytes,0xf000);
  await assert.rejects(buildBondUpgrade({snapshot:badDevice,manager:guarded,extension:ext,digest}),/活动分区/);
  const wrong=ext.slice();wrong[1]^=1;
  await assert.rejects(buildBondUpgrade({snapshot:inst.after,manager:guarded,extension:wrong,digest}),/校验/);
  const overlap=inst.after.slice(),pt=parseStrictPartitionTable(overlap.subarray(0xe000,0xf000));
  pt.entries.find(e=>e.name==='factory').address[0]=BOND_ADDRESS;
  const badPt=encodePartitionTable(pt,SECTOR_SIZE);overlap.set(badPt,0xe000);overlap.set(badPt,0xf000);
  await assert.rejects(buildBondUpgrade({snapshot:overlap,manager:guarded,extension:ext,digest}),/重叠/);
  const torn=inst.after.slice();torn.set(guarded.subarray(0x2000,0x3000),0x2000);
  await assert.rejects(validateManagerImage(torn.subarray(0,guarded.length)),/SHA256/);
  const {makeBondBackup,parseBondBackup}=await import('../web/bond-backup.mjs');
  const recoveryFile=await makeBondBackup(inst.after,'001122AABBCC');
  assert.deepEqual(await parseBondBackup(recoveryFile,'001122aabbcc'),inst.after);
  await assert.rejects(parseBondBackup(recoveryFile,'001122AABBCD'),/不属于/);
  const damagedBackup=recoveryFile.slice();damagedBackup[64+0x330000]^=1;
  await assert.rejects(parseBondBackup(damagedBackup,'001122AABBCC'),/校验/);
  // Interruption at each sector boundary is recoverable from the full backup;
  // refuse to overwrite any unrelated flash mutation.
  for(const segment of plan.segments) for(let cut=0;cut<=segment.data.length;cut+=SECTOR_SIZE){
    const interrupted=inst.after.slice();
    for(const prior of plan.segments){if(prior===segment)break;interrupted.set(prior.data,prior.address);}
    interrupted.set(segment.data.subarray(0,cut),segment.address);
    const recovery=await buildBondUpgradeRecovery({current:interrupted,backup:inst.after});
    assert.deepEqual(recovery.after,inst.after);
    if(recovery.segments.some(s=>s.address===0))assert.equal(recovery.segments.at(-1).address,0);
  }
  const corruptBackup=inst.after.slice();corruptBackup[0x2100]^=1;
  await assert.rejects(buildBondUpgradeRecovery({current:plan.after,backup:corruptBackup}),/SHA256/);
  const altered=plan.after.slice();altered[0x330000]^=1;
  await assert.rejects(buildBondUpgradeRecovery({current:altered,backup:inst.after}),/以外的数据已变化/);
  assert.equal(BOND_LENGTH,0x4000);
  console.log('experimental bond upgrade: staging, layout, integrity and torn-root recovery detection passed');
}
