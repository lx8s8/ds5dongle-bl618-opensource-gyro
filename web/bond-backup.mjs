/* Local recovery container: chip identity + hash + full flash. Contains secrets. */
import { FLASH_SIZE, sha256 } from './dual-firmware.mjs';
const MAGIC=new TextEncoder().encode('DS5BKUP1'), HEADER=64;
const eq=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
function chipId(value){
 const id=String(value||'').toUpperCase();if(!/^[0-9A-F]{12}$/.test(id))throw Error('无法确认接收器芯片 ID');return id;
}
export async function makeBondBackup(flash,id){
 if(!(flash instanceof Uint8Array)||flash.length!==FLASH_SIZE)throw Error('需要完整 4 MiB 备份');
 const chip=chipId(id),out=new Uint8Array(HEADER+FLASH_SIZE);
 out.set(MAGIC,0);out.set(new TextEncoder().encode(chip),8);out.set(await sha256(flash),20);out.set(flash,HEADER);return out;
}
export async function parseBondBackup(bytes,id){
 if(!(bytes instanceof Uint8Array)||bytes.length!==HEADER+FLASH_SIZE||!eq(bytes.subarray(0,8),MAGIC))throw Error('备份文件格式无效');
 const saved=new TextDecoder().decode(bytes.subarray(8,20));if(chipId(saved)!==chipId(id))throw Error('备份不属于当前接收器');
 if(!bytes.subarray(52,HEADER).every(v=>v===0))throw Error('备份头无效');
 const flash=bytes.slice(HEADER);if(!eq(await sha256(flash),bytes.subarray(20,52)))throw Error('备份校验失败');
 return flash;
}
