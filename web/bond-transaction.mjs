/* Two-step experimental installation. The caller downloads the prepared
 * backup, then asks the user to select that file before allowing writes. */
import { FLASH_SIZE, expectedStock } from './dual-firmware.mjs';
import { makeBondBackup, parseBondBackup } from './bond-backup.mjs';
import { parseBondPackage } from './bond-package.mjs';
import { buildBondUpgrade, buildBondUpgradeRecovery, buildBondFirstRecovery } from './bond-upgrade.mjs';
const equal=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
async function snapshot(flasher,label){
 if(flasher.flashSize!==FLASH_SIZE)throw Error('只支持 4 MiB 设备');
 return flasher.readFlash(0,FLASH_SIZE,{label,verify:true});
}
export async function prepareBondUpgrade(flasher,packageBytes){
 const pkg=await parseBondPackage(packageBytes),current=await snapshot(flasher,'读取升级前备份');
 const plan=await buildBondUpgrade({snapshot:current,...pkg});
 const backup=await makeBondBackup(current,flasher.info?.chipId);
 return {backup,chipId:String(flasher.info.chipId).toUpperCase(),pkg,plan};
}
export async function confirmBondUpgrade(flasher,prepared,backupBytes){
 if(!prepared||String(flasher.info?.chipId||'').toUpperCase()!==prepared.chipId)throw Error('接收器已经变化，请重新准备');
 if(!(backupBytes instanceof Uint8Array)||!equal(backupBytes,prepared.backup))throw Error('请选择本次刚下载的恢复备份');
 const backup=await parseBondBackup(backupBytes,flasher.info.chipId);
 const current=await snapshot(flasher,'确认备份后检查闪存');
 if(!equal(backup,current))throw Error('闪存自备份后已变化，请重新准备升级');
 // Rebuild from the verified backup instead of trusting a stale mutable plan.
 const plan=await buildBondUpgrade({snapshot:backup,...prepared.pkg});
 if(!plan.segments.length)throw Error('无需升级');
 await flasher.program(plan.segments,{reset:true});
 return plan;
}
export async function recoverBondUpgrade(flasher,backupBytes){
 const backup=await parseBondBackup(backupBytes,flasher.info?.chipId);
 const current=await snapshot(flasher,'读取当前闪存用于恢复');
 let stock=false;try {expectedStock(backup);stock=true;}catch {}
 const plan=stock?await buildBondFirstRecovery({current,backup}):await buildBondUpgradeRecovery({current,backup});
 if(plan.segments.length)await flasher.program(plan.segments,{reset:true});
 return plan;
}

/* First install uses the same saved-backup handshake as an upgrade. */
export async function prepareBondFirstInstall(flasher,packageBytes,options){
 const {buildBondFirstInstall}=await import('./bond-upgrade.mjs');
 const pkg=await parseBondPackage(packageBytes),current=await snapshot(flasher,'读取安装前备份');
 const plan=await buildBondFirstInstall({snapshot:current,...options,...pkg});
 return {backup:await makeBondBackup(current,flasher.info?.chipId),chipId:String(flasher.info.chipId).toUpperCase(),pkg,options,plan};
}
export async function confirmBondFirstInstall(flasher,prepared,backupBytes){
 if(!prepared||String(flasher.info?.chipId||'').toUpperCase()!==prepared.chipId)throw Error('接收器已经变化，请重新准备');
 if(!(backupBytes instanceof Uint8Array)||!equal(backupBytes,prepared.backup))throw Error('请选择本次刚下载的恢复备份');
 const backup=await parseBondBackup(backupBytes,flasher.info.chipId);
 const current=await snapshot(flasher,'确认备份后检查闪存');
 if(!equal(backup,current))throw Error('闪存自备份后已变化，请重新准备安装');
 const {buildBondFirstInstall}=await import('./bond-upgrade.mjs');
 const plan=await buildBondFirstInstall({snapshot:backup,...prepared.options,...prepared.pkg});
 if(!plan.segments.length)throw Error('无需安装');
 await flasher.program(plan.segments,{reset:true});return plan;
}
