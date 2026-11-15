export function decodeBootStatus(bytes){
 if(bytes.length!==64||bytes[0]!==0x70)throw new Error('启动管理器报告长度不正确');
 const p=bytes.slice(1),text=new TextDecoder();
 if(text.decode(p.slice(0,4))!=='DBMR'||p[4]!==1||p[11]!==1||p[5]>1||p[7]>3||p[60]!==1||
    (p[5]&&p[6]>1))throw new Error('不支持的启动管理器');
 return{installed:!!p[5],selected:p[6],valid:p[7],command:p[8],result:p[9],sequence:p[10],
  versions:[16,36].map(o=>text.decode(p.slice(o,o+20)).replace(/\0.*$/s,'')),
  generation:new DataView(p.buffer).getUint32(56,true),experimental:true};
}
export class BootManager {
 constructor(device){this.device=device;this.sequence=0;}
 async read(){const v=await this.device.receiveFeatureReport(0x70);return decodeBootStatus(new Uint8Array(v.buffer,v.byteOffset,v.byteLength));}
 async boot(slot){
  if(![0,1].includes(slot))throw new Error('固件槽无效');
  const status=await this.read();if(!status.installed||!(status.valid&(1<<slot)))throw new Error('所选镜像缺失或校验失败');
  const seq=this.sequence=this.sequence%255+1,p=new Uint8Array(63);p.set([1,seq,slot]);
  await this.device.sendFeatureReport(0x70,p);
  const until=performance.now()+2500;
  while(performance.now()<until){
   await new Promise(resolve=>setTimeout(resolve,10));const r=await this.read();
   if(r.command!==1||r.sequence!==seq)continue;
   if(r.result)throw new Error('切换失败，启动管理器仍可用于恢复');
   return;
  }
  throw new Error('没有收到切换成功回执，请重新连接检查');
 }
}
export async function requestBootManager(hid){
 const match=d=>d.vendorId===0x1209&&d.productId===1&&d.collections.some(c=>c.usagePage===0xFF00&&(c.featureReports||[]).some(r=>r.reportId===0x70));
 const granted=(hid.getDevices?await hid.getDevices():[]).filter(match);
 const candidate=granted.length===1?granted[0]:(await hid.requestDevice({filters:[{vendorId:0x1209,productId:1,usagePage:0xFF00}]}))[0];
 if(candidate&&!match(candidate))throw new Error('请选择 DS5 Boot Manager，日常手柄接口不能用于切槽');
 return candidate;
}
export function initBootManager({enterManager}){
 const $=id=>document.getElementById(id);let device,manager,busy=false,status;
 function controls(){
  $('bootConnect').disabled=busy||!!device||!navigator.hid;$('bootDisconnect').disabled=busy||!device;
  for(let i=0;i<2;i++)$('bootSlot'+i).disabled=busy||!device||!status?.installed||!(status.valid&(1<<i));
  $('bootEnter').disabled=busy||!!device;
 }
 function render(){
  $('bootState').textContent=status?status.installed?`默认：${status.selected===0?'体感固件':'上游原版'} · 两份镜像${status.valid===3?'均通过校验':'有缺失或校验失败'}`:'尚未安装有效双固件数据':'未连接启动管理器';
  for(let i=0;i<2;i++)$('bootVersion'+i).textContent=status?.versions[i]||'—';controls();
 }
 async function close(){if(device?.opened)await device.close();device=manager=status=undefined;render();}
 async function run(fn){if(busy)return;busy=true;controls();try{await fn();}catch(e){$('bootState').textContent=e.message||String(e);}finally{busy=false;controls();}}
 $('bootConnect').onclick=()=>run(async()=>{let candidate;try{candidate=await requestBootManager(navigator.hid);}catch(e){if(e.name==='NotFoundError')throw new Error('未选择或未找到启动管理器设备：若当前运行日常手柄固件，请先点“从体感固件进入管理器”（或上电快闪窗口内按住 BOOT 约 1 秒），等待进入管理器后再点此连接。');throw e;}if(!candidate)throw new Error('未选择启动管理器。请先进入管理器，待设备重新枚举后再连接；按住 BOOT 插入 USB 进入的是烧录模式。');await candidate.open();
  try{const m=new BootManager(candidate),s=await m.read();device=candidate;manager=m;status=s;render();}catch(e){await candidate.close();throw e;}
 });
 $('bootDisconnect').onclick=()=>run(close);
 $('bootEnter').onclick=()=>run(async()=>{await enterManager();$('bootState').textContent='已请求重启进入管理器；设备重新枚举后点“连接启动管理器”。';});
 for(let i=0;i<2;i++)$('bootSlot'+i).onclick=()=>run(async()=>{await manager.boot(i);await close();$('bootState').textContent='管理器已确认切换请求，请等待'+(i?'上游原版':'体感固件')+'重新枚举；回执不代表固件已成功启动。';});
 navigator.hid?.addEventListener('disconnect',e=>{if(e.device===device){device=manager=status=undefined;render();}});
 // Validation may still be running when the manager first enumerates.
 setInterval(()=>{if(!device||busy)return;run(async()=>{status=await manager.read();render();});},1000);
 render();
}
