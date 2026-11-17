/* Experimental only. A backup must be downloaded before executing this plan.
 * Power loss during root replacement may require BOOT ROM recovery. */
import { FLASH_SIZE, ROOT_LIMIT, SECTOR_SIZE, PT_ADDRESS, RECORD_ADDRESS,
  inspectDualState, parseStrictPartitionTable, parseRecord, RECORD_SIZE, diffPlan, sha256, validateManagerImage, buildInstallImage, expectedStock, validateStockBoot2Backup } from './dual-firmware.mjs';
export const BOND_ADDRESS = 0x342000, BOND_LENGTH = 0x4000;
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const meta = (flash) => ({ rootHead: flash.subarray(0, ROOT_LIMIT),
  pt0: flash.subarray(PT_ADDRESS[0], PT_ADDRESS[0] + SECTOR_SIZE),
  pt1: flash.subarray(PT_ADDRESS[1], PT_ADDRESS[1] + SECTOR_SIZE),
  rec0: flash.subarray(RECORD_ADDRESS[0], RECORD_ADDRESS[0] + SECTOR_SIZE),
  rec1: flash.subarray(RECORD_ADDRESS[1], RECORD_ADDRESS[1] + SECTOR_SIZE) });
async function validateBackupManager(snapshot){
  // Never create or restore a recovery baseline from a damaged manager.
  const hdr=new DataView(snapshot.buffer,snapshot.byteOffset,ROOT_LIMIT);
  const offset=hdr.getUint32(124,true),payload=hdr.getUint32(132,true),rootSize=offset+payload;
  if(offset!==0x2000||rootSize>ROOT_LIMIT||rootSize<offset)throw Error('当前启动管理器长度无效');
  await validateManagerImage(snapshot.subarray(0,rootSize));
}
export async function buildBondUpgrade({ snapshot, manager, extension, digest }) {
  if (!(snapshot instanceof Uint8Array) || snapshot.length !== FLASH_SIZE) throw Error('需要完整 4 MiB 备份');
  if (!(extension instanceof Uint8Array) || extension.length < 1 || extension.length > BOND_LENGTH) throw Error('配对扩展大小无效');
  if (!(digest instanceof Uint8Array) || digest.length !== 32 || !equal(await sha256(extension), digest)) throw Error('配对扩展校验失败');
  await validateManagerImage(manager);
  // The experimental builder verifies that this digest is the one pinned by
  // the root and that its guard symbol addresses match; still fail closed on
  // a mismatched root/extension pair before creating any write plan.
  let matches = 0;
  for (let i=0x2000;i<=manager.length-digest.length;i++) if (equal(manager.subarray(i,i+32),digest)) matches++;
  if (matches!==1) throw Error('管理器与配对扩展不匹配');
  const m=meta(snapshot),state=inspectDualState(m);
  if(state.mode!=='dual')throw Error('当前设备不是完整双固件布局');
  await validateBackupManager(snapshot);
  const r0=parseRecord(m.rec0),r1=parseRecord(m.rec1);
  if(r0&&r1&&r0.gen===r1.gen&&!equal(m.rec0.subarray(0,RECORD_SIZE),m.rec1.subarray(0,RECORD_SIZE)))throw Error('同代管理记录冲突');
  const rawRecord=(state.activeCopy===0?m.rec0:m.rec1);
  for(let i=0;i<2;i++){
    const entry=rawRecord.subarray(16+i*64,16+(i+1)*64),v=new DataView(entry.buffer,entry.byteOffset,entry.byteLength);
    if(v.getUint32(8,true)<0x1004 || !entry.subarray(44,64).includes(0))throw Error('管理记录镜像字段无效');
  }
  const tables=[];
  for(const p of [m.pt0,m.pt1]) { try { tables.push({ table:parseStrictPartitionTable(p), bytes:p }); } catch {} }
  if(!tables.length)throw Error('分区表无效');
  if(tables.length===2 && tables[0].table.age===tables[1].table.age && !equal(tables[0].bytes,tables[1].bytes))throw Error('同代分区表冲突');
  tables.sort((a,b)=>b.table.age-a.table.age);
  const entries=tables[0].table.entries;
  const selected=['FW','PSM','KEY','DATA','media'].map(name=>entries.filter(e=>e.name===name));
  if(selected.some(e=>e.length!==1) || selected.some(e=>e[0].device!==0||e[0].active>1||e[0].active!==selected[0][0].active))throw Error('活动分区不一致');
  const managed=selected.map(group=>group[0]);
  for(const entry of entries) if(!managed.includes(entry)) for(let i=0;i<2;i++){
    const a=entry.address[i],n=entry.maxLength[i];if(!n)continue;
    if(a>FLASH_SIZE||n>FLASH_SIZE-a)throw Error('分区地址无效');
    for(const item of managed)for(let j=0;j<2;j++) if(a<item.address[j]+item.maxLength[j]&&item.address[j]<a+n)throw Error('设备分区重叠');
  }
  if(selected[0][0].active!==state.record.selected)throw Error('切槽尚未完成，请先恢复后再升级');
  for(const e of entries) for(let i=0;i<2;i++) {
    const a=e.address[i],n=e.maxLength[i];
    if(n && (a>FLASH_SIZE || n>FLASH_SIZE-a || (a<BOND_ADDRESS+BOND_LENGTH && BOND_ADDRESS<a+n)))throw Error('配对扩展区域与分区重叠');
  }
  if(!snapshot.subarray(BOND_ADDRESS,BOND_ADDRESS+BOND_LENGTH).every(b=>b===255))throw Error('配对扩展区域非空，已停止');

  const after=snapshot.slice();after.fill(255,0,ROOT_LIMIT);after.set(manager,0);after.set(extension,BOND_ADDRESS);
  const segments=diffPlan(snapshot,after);
  if(segments.some(s=>!(s.address===BOND_ADDRESS||s.address===0||s.address>=0x1000&&s.address+s.data.length<=ROOT_LIMIT)))throw Error('升级范围异常');
  if(!segments.length || segments[0].address!==BOND_ADDRESS || segments.at(-1).address!==0)throw Error('升级写入顺序异常');
  return {after,segments};
}

/* First dual-firmware installation, with extension staged before root.
 * A pre-install 4 MiB backup must be saved before programming. */
export async function buildBondFirstInstall({snapshot,manager,extension,digest,...options}) {
  if (!(snapshot instanceof Uint8Array) || snapshot.length !== FLASH_SIZE) throw Error('需要完整 4 MiB 备份');
  if (!(extension instanceof Uint8Array) || !extension.length || extension.length>BOND_LENGTH ||
      !(digest instanceof Uint8Array) || digest.length!==32 || !equal(await sha256(extension),digest)) throw Error('配对扩展校验失败');
  if(!snapshot.subarray(BOND_ADDRESS,BOND_ADDRESS+BOND_LENGTH).every(b=>b===255))throw Error('配对扩展区域非空，已停止');
  await validateStockBoot2Backup(snapshot);
  const base=await buildInstallImage({snapshot,manager,...options});
  let matches=0;for(let i=0x2000;i<=manager.length-32;i++)if(equal(manager.subarray(i,i+32),digest))matches++;
  if(matches!==1)throw Error('管理器与配对扩展不匹配');
  const pt=parseStrictPartitionTable(base.after.subarray(PT_ADDRESS[0],PT_ADDRESS[0]+SECTOR_SIZE));
  for(const e of pt.entries)for(let i=0;i<2;i++){
    const a=e.address[i],n=e.maxLength[i];
    if(n&&(a>FLASH_SIZE||n>FLASH_SIZE-a||(a<BOND_ADDRESS+BOND_LENGTH&&BOND_ADDRESS<a+n)))throw Error('配对扩展区域与分区重叠');
  }
  base.after.set(extension,BOND_ADDRESS);base.segments=diffPlan(snapshot,base.after);
  const extIdx=base.segments.findIndex(s=>s.address<=BOND_ADDRESS&&s.address+s.data.length>=BOND_ADDRESS+extension.length);
  if(extIdx<0||extIdx>=base.segments.length-1||base.segments.at(-1).address!==0)throw Error('安装写入顺序异常');
  return base;
}

/* Recover an interrupted first upgrade using the same full pre-upgrade backup.
 * The caller must independently verify the physical chip identity before use.
 * Never overwrite unrelated changes made after the backup was captured. */
export async function buildBondUpgradeRecovery({ current, backup }) {
  if (!(current instanceof Uint8Array) || current.length !== FLASH_SIZE ||
      !(backup instanceof Uint8Array) || backup.length !== FLASH_SIZE) throw Error('恢复需要当前闪存和原始 4 MiB 备份');
  if(meta(backup).rootHead.every(b=>b===255) || inspectDualState(meta(backup)).mode!=='dual')throw Error('原始备份不是完整双固件状态');
  await validateBackupManager(backup);
  const unchanged=[[ROOT_LIMIT,BOND_ADDRESS],[BOND_ADDRESS+BOND_LENGTH,FLASH_SIZE]];
  if(unchanged.some(([a,b])=>!equal(current.subarray(a,b),backup.subarray(a,b))))throw Error('扩展或管理器以外的数据已变化，停止恢复');
  const after=current.slice();after.set(backup.subarray(0,ROOT_LIMIT),0);
  after.set(backup.subarray(BOND_ADDRESS,BOND_ADDRESS+BOND_LENGTH),BOND_ADDRESS);
  const segments=diffPlan(current,after);
  if(segments.some(s=>!(s.address===BOND_ADDRESS||s.address===0||s.address>=0x1000&&s.address+s.data.length<=ROOT_LIMIT)))throw Error('恢复范围异常');
  if(segments.some(s=>s.address===0)&&segments.at(-1).address!==0)throw Error('恢复顺序异常');
  return {after,segments};
}

/* Recovery of a first dual-firmware installation: restore the complete
 * verified pre-install flash. This intentionally reverts its user data. */
export async function buildBondFirstRecovery({current,backup}) {
 if(!(current instanceof Uint8Array)||current.length!==FLASH_SIZE||!(backup instanceof Uint8Array)||backup.length!==FLASH_SIZE)throw Error('恢复需要完整 4 MiB 备份');
 expectedStock(backup);await validateStockBoot2Backup(backup);
 // The factory sector is not written by the installer. A mismatch indicates
 // a different device or unexpected changes; never blindly restore.
 if(!equal(current.subarray(0x3f8000,FLASH_SIZE),backup.subarray(0x3f8000,FLASH_SIZE)))throw Error('设备 factory 数据与备份不一致');
 const after=backup.slice(),segments=diffPlan(current,after);
 if(segments.some(s=>s.address===0)&&segments.at(-1).address!==0)throw Error('恢复顺序异常');
 return {after,segments};
}
