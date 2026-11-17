/* Experimental transport only. The extension digest is also pinned in the
 * manager executable; the bundle metadata is not a cryptographic signature. */
import { ROOT_LIMIT, sha256, validateManagerImage } from './dual-firmware.mjs';
import { BOND_LENGTH } from './bond-upgrade.mjs';
const SIZE = ROOT_LIMIT + BOND_LENGTH + 80;
const MAGIC = new TextEncoder().encode('DS5BND01');
const eq=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
const pins=(manager,digest)=>{let n=0;for(let i=0x2000;i<=manager.length-32;i++)if(eq(manager.subarray(i,i+32),digest))n++;return n===1;};
export async function makeBondPackage(manager, extension) {
 await validateManagerImage(manager);
 if(!(extension instanceof Uint8Array)||!extension.length||extension.length>BOND_LENGTH)throw Error('扩展大小无效');
 const out=new Uint8Array(SIZE).fill(255),m=await sha256(manager),x=await sha256(extension);
 if(!pins(manager,x))throw Error('扩展与管理器不匹配');
 out.set(manager,0);out.set(extension,ROOT_LIMIT);const o=ROOT_LIMIT+BOND_LENGTH;out.set(MAGIC,o);
 const v=new DataView(out.buffer);v.setUint32(o+8,manager.length,true);v.setUint32(o+12,extension.length,true);out.set(m,o+16);out.set(x,o+48);
 return out;
}
export async function parseBondPackage(bytes) {
 if(!(bytes instanceof Uint8Array)||bytes.length!==SIZE)throw Error('配对扩展包长度错误');
 const o=ROOT_LIMIT+BOND_LENGTH;if(!eq(bytes.subarray(o,o+8),MAGIC))throw Error('配对扩展包标记错误');
 const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),ml=v.getUint32(o+8,true),el=v.getUint32(o+12,true);
 if(ml<0x2000||ml>ROOT_LIMIT||el<1||el>BOND_LENGTH)throw Error('配对扩展包尺寸错误');
 if(!bytes.subarray(ml,ROOT_LIMIT).every(x=>x===255)||!bytes.subarray(ROOT_LIMIT+el,o).every(x=>x===255))throw Error('配对扩展包填充异常');
 const manager=bytes.slice(0,ml),extension=bytes.slice(ROOT_LIMIT,ROOT_LIMIT+el),md=bytes.subarray(o+16,o+48),digest=bytes.slice(o+48,o+80);
 if(!eq(await sha256(manager),md)||!eq(await sha256(extension),digest))throw Error('配对扩展包校验失败');
 await validateManagerImage(manager);
 if(!pins(manager,digest))throw Error('扩展与管理器不匹配');
 return {manager,extension,digest};
}
