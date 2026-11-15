export const MACRO_REPORT=0xF3, HEADER=36, MAX_STEPS=640, SLOTS=16, RULES=16;
export const padOutputs=[...['□','×','○','△','L1','R1','L2','R2','Create','Options','L3','R3','PS','触摸板点击','Mute','↑','↓','←','→'].map((name,key)=>({name,key})),...['左 Fn','右 Fn','左背键','右背键'].map((name,i)=>({name,key:31+i}))];
export function crc16(a){let c=65535;for(const x of a){c^=x<<8;for(let k=0;k<8;k++)c=((c<<1)^((c&32768)?0x1021:0))&65535;}return c;}
const integer=(n,min,max)=>Number.isInteger(n)&&n>=min&&n<=max;
export function encodeMacro(m){
 if(typeof m.name!=='string'||!integer(m.mode,0,2)||!integer(m.repeat,1,255)||!integer(m.pauseMs,0,65535)||!Array.isArray(m.steps)||m.steps.length>MAX_STEPS)throw new Error('宏参数无效');
 const a=new Uint8Array(HEADER+m.steps.length*6+2),v=new DataView(a.buffer);v.setUint32(0,0x4D414331,true);a[4]=1;a[5]=m.mode;a[6]=m.repeat;v.setUint16(8,m.pauseMs,true);v.setUint16(10,m.steps.length,true);
 const name=new TextEncoder().encode(m.name);if(name.length>23)throw new Error('宏名称最多 23 个 UTF-8 字节');a.set(name,12);
 m.steps.forEach((s,i)=>{if(!integer(s.act,0,3)||!integer(s.key,0,255)||!integer(s.edge,0,1)||!integer(s.delayMs,0,65535)||(s.act===1&&!s.key)||(s.act===2&&s.key>4)||(s.act===3&&s.key>18&&(s.key<31||s.key>34)))throw new Error('第 '+(i+1)+' 步无效');const p=HEADER+i*6;a.set([s.act,s.key,s.edge,0],p);v.setUint16(p+4,s.delayMs,true);});v.setUint16(a.length-2,crc16(a.subarray(0,-2)),true);return a;
}
export function decodeMacro(a){
 if(a.length<HEADER+2||a.length>4096)throw new Error('宏文件长度无效');const v=new DataView(a.buffer,a.byteOffset,a.byteLength),n=v.getUint16(10,true);
 if(v.getUint32(0,true)!==0x4D414331||a[4]!==1||a[7]||n>MAX_STEPS||a.length!==HEADER+n*6+2||crc16(a.subarray(0,-2))!==v.getUint16(a.length-2,true))throw new Error('宏版本、长度或 CRC 无效');
 const nameBytes=a.slice(12,36),zero=nameBytes.indexOf(0),m={name:new TextDecoder().decode(zero<0?nameBytes:nameBytes.slice(0,zero)),mode:a[5],repeat:a[6]||1,pauseMs:v.getUint16(8,true),steps:Array.from({length:n},(_,i)=>{const p=HEADER+i*6;if(a[p+3])throw new Error('宏步骤保留位无效');return {act:a[p],key:a[p+1],edge:a[p+2],delayMs:v.getUint16(p+4,true)};})};encodeMacro(m);return m;
}
export const emptyRules=()=>Array.from({length:RULES},()=>({buttons:0,slot:0,gesture:0,profiles:0,enabled:false,suppress:false,holdMs:300,tapMs:250}));
export function encodeRules(rows){
 if(!Array.isArray(rows)||rows.length!==RULES)throw new Error('需要 16 条绑定');const a=new Uint8Array(RULES*12),v=new DataView(a.buffer);
 rows.forEach((r,i)=>{if(!integer(r.buttons,0,0xFFFFFF)||!integer(r.slot,0,15)||!integer(r.gesture,0,4)||!integer(r.profiles,0,15)||!integer(r.holdMs,0,3000)||!integer(r.tapMs,0,1000)||(r.enabled&&(!r.buttons||(r.gesture===2&&!r.holdMs)||(r.gesture>=3&&!r.tapMs))))throw new Error('绑定 '+(i+1)+' 无效');const p=i*12;v.setUint32(p,r.buttons,true);a[p+4]=r.slot;a[p+5]=r.gesture;a[p+6]=r.profiles;a[p+7]=Number(!!r.enabled)|Number(!!r.suppress)<<1;v.setUint16(p+8,r.holdMs,true);v.setUint16(p+10,r.tapMs,true);});return a;
}
export function decodeRules(a){if(a.length!==RULES*12)throw new Error('绑定长度无效');const v=new DataView(a.buffer,a.byteOffset,a.byteLength);const rows=Array.from({length:RULES},(_,i)=>{const p=i*12;if(a[p+7]>3)throw new Error('绑定保留位无效');return{buttons:v.getUint32(p,true),slot:a[p+4],gesture:a[p+5],profiles:a[p+6],enabled:!!(a[p+7]&1),suppress:!!(a[p+7]&2),holdMs:v.getUint16(p+8,true),tapMs:v.getUint16(p+10,true)};});encodeRules(rows);return rows;}
export class MacroClient {
 constructor(transport){this.transport=transport;}
 async request(command,slot=0,offset=0,data=new Uint8Array()){
  if(!integer(command,0,255)||!integer(slot,0,255)||!integer(offset,0,65535)||data.length>57)throw new Error('宏命令无效');
  const t=this.transport;return t.run(async()=>{const seq=t.next(),p=new Uint8Array(63);p.set([command,seq,slot,offset&255,offset>>8,data.length]);p.set(data,6);await t.device.sendFeatureReport(MACRO_REPORT,p);
   const until=performance.now()+3500;while(performance.now()<until){await new Promise(r=>setTimeout(r,15));const r=await t.get(MACRO_REPORT);if(r[0]!==1)throw new Error('宏协议版本不支持');if(r[1]!==command||r[2]!==seq)continue;if(r[3])throw new Error(['','宏数据或步骤无效','保存或读取失败，旧文件仍保留','宏忙碌，或手柄尚未连接；先停止播放'][r[3]]||'宏命令失败');this.lastStatus=r.slice();if(r[7]>51)throw new Error('宏响应长度无效');return r;}throw new Error('宏操作超时');});
 }
 async read(command,slot=0){let result=null,offset=0;do{const r=await this.request(command,slot,offset),v=new DataView(r.buffer),total=v.getUint16(10,true);if(total>4096||v.getUint16(8,true)!==offset||(result&&total!==result.length)||r[7]>total-offset||(!r[7]&&total!==offset))throw new Error('宏分块响应无效');if(!result)result=new Uint8Array(total);result.set(r.slice(12,12+r[7]),offset);offset+=r[7];}while(offset<result.length);return result;}
 async upload(slot,bytes){decodeMacro(bytes);await this.request(2,slot,bytes.length);for(let i=0;i<bytes.length;i+=57)await this.request(3,slot,i,bytes.slice(i,i+57));await this.request(4,slot);}
 async saveRules(rows){const a=encodeRules(rows);await this.request(8,0,a.length);for(let i=0;i<a.length;i+=57)await this.request(9,0,i,a.slice(i,i+57));await this.request(10);}
}
/* Recording consumes actual USB input. The UI temporarily inhibits device
 * macro playback so a running macro cannot record itself recursively. */
export class MacroRecorder {
 constructor(){this.reset();}
 reset(){this.steps=[];this.mask=0;this.last=null;this.active=false;}
 start(){this.reset();this.active=true;}
 input(p,at){if(!this.active||p.length<63)return;let mask=(p[7]>>4)|(p[8]<<4)|((p[9]&7)<<12)|((p[9]>>4)<<19);const h=p[7]&15;if([0,1,7].includes(h))mask|=1<<15;if([3,4,5].includes(h))mask|=1<<16;if([5,6,7].includes(h))mask|=1<<17;if([1,2,3].includes(h))mask|=1<<18;
  if(this.last===null){this.mask=mask;this.last=at;return;}for(let key=0;key<=22;key++)if((mask^this.mask)&(1<<key)){if(this.steps.length>=MAX_STEPS-23){this.stop(at);return;}if(this.steps.length)this.steps.at(-1).delayMs=Math.min(65535,Math.max(1,Math.round(at-this.last)));this.steps.push({act:3,key:key>=19?key+12:key,edge:Number(!!(mask&(1<<key))),delayMs:30});this.last=at;}this.mask=mask;
 }
 stop(at=0){if(!this.active)return this.steps;for(let key=0;key<=22;key++)if(this.mask&(1<<key)){if(this.steps.length)this.steps.at(-1).delayMs=Math.min(65535,Math.max(1,Math.round(at-this.last)));this.steps.push({act:3,key:key>=19?key+12:key,edge:0,delayMs:30});this.last=at;}this.active=false;this.mask=0;return this.steps;}
}
