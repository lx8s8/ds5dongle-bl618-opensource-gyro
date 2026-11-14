export const receiverFields = [
 {id:'controller_mode',label:'手柄身份',group:'device',offset:12,options:['DualSense','DualSense Edge','自动识别'],default:2},
 {id:'polling_rate_mode',label:'USB 报告频率',group:'device',offset:10,options:['250 Hz','500 Hz','跟随蓝牙输入'],default:2},
 {id:'enable_usb_sn',label:'启用独立 USB 序列号',group:'device',offset:13,bool:true,default:0},
 {id:'usb_stealth',label:'连接手柄后才显示 USB',group:'device',offset:21,bool:true,default:0},
 {id:'enable_wake',label:'允许手柄唤醒电脑',group:'device',offset:17,bool:true,default:1},
 {id:'ps_shortcut_enabled',label:'PS 键桌面快捷键',group:'device',offset:14,bool:true,default:0},
 {id:'inactive_time',label:'空闲断连 · 分钟（0 为关闭）',group:'power',offset:8,min:0,max:60,default:30},
 {id:'disable_led',label:'板载灯 1 分钟后自动熄灭',group:'power',offset:9,bool:true,default:1},
 {id:'haptics_gain',label:'触觉强度倍率',group:'audio',offset:1,float:true,min:1,max:2,step:.05,default:1},
 {id:'speaker_volume',label:'扬声器音量',group:'audio',offset:5,min:0,max:127,default:100},
 {id:'headset_volume',label:'耳机音量',group:'audio',offset:6,min:0,max:127,default:100},
 {id:'speaker_gain',label:'扬声器增益',group:'audio',offset:7,min:0,max:7,default:2},
 {id:'audio_buffer_length',label:'音频缓冲深度',group:'audio',offset:11,min:16,max:128,default:64},
 {id:'audio_haptic',label:'音频转触觉',group:'audio',offset:28,options:['关闭','自动 · 游戏优先','强制'],default:0},
 {id:'trigger_reduce',label:'扳机马达降功率',group:'audio',offset:18,min:0,max:10,default:0},
 {id:'lock_volume',label:'锁定音量',group:'audio',offset:19,bool:true,default:0},
 {id:'disable_mic',label:'禁用麦克风透传',group:'audio',offset:15,bool:true,default:0},
 {id:'disable_speaker',label:'禁用扬声器编码',group:'audio',offset:16,bool:true,default:0},
 {id:'tp_mode',label:'触摸板模式',group:'touch',offset:25,options:['关闭','方向键','左鼠标 / 右方向键','左方向键 / 右鼠标','左右分区'],default:0},
 {id:'tp_mouse_sensitivity',label:'触摸板鼠标灵敏度',group:'touch',offset:27,min:1,max:32,default:8},
];
export function receiverDefaults() { return {...Object.fromEntries(receiverFields.map(f=>[f.id,f.default])),led_r:255,led_g:255,led_b:255,tp_mode_enabled_mask:1,dse_detected:0}; }
export function encodeReceiver(c) {
 const a=new Uint8Array(29),v=new DataView(a.buffer);a[0]=2;
 for(const f of receiverFields){const n=c[f.id],lo=f.options||f.bool?0:f.min,hi=f.options?f.options.length-1:f.bool?1:f.max;
  if(!Number.isFinite(n)||n<lo||n>hi||(!f.float&&!Number.isInteger(n)))throw new Error(f.label+'超出范围');
  if(f.float)v.setFloat32(f.offset,n,true);else a[f.offset]=n;
 }
 for(const [k,o] of [['led_r',22],['led_g',23],['led_b',24],['dse_detected',20]]){if(!Number.isInteger(c[k])||c[k]<0||c[k]>(k==='dse_detected'?1:255))throw new Error('颜色或检测状态无效');a[o]=c[k];}
 if(!Number.isInteger(c.tp_mode_enabled_mask)||c.tp_mode_enabled_mask<1||c.tp_mode_enabled_mask>31)throw new Error('至少保留一种触摸板模式');a[26]=c.tp_mode_enabled_mask;return a;
}
export function decodeReceiver(a){if(a.length<29||a[0]!==2)throw new Error('接收器配置版本不支持');const v=new DataView(a.buffer,a.byteOffset,a.byteLength),c={};for(const f of receiverFields)c[f.id]=f.float?v.getFloat32(f.offset,true):a[f.offset];Object.assign(c,{led_r:a[22],led_g:a[23],led_b:a[24],dse_detected:a[20],tp_mode_enabled_mask:a[26]});encodeReceiver(c);return c;}
export const remapNames=['□','×','○','△','L1','R1','L2','R2','Create','Options','L3','R3','PS','触摸板点击','Mute','↑','↓','←','→','左区触摸','左区↑','左区↓','左区←','左区→','左区点击','右区触摸','右区↑','右区↓','右区←','右区→','右区点击'];
export function remapDefaults(){return remapNames.map((_,i)=>({type:0,value:i,modifier:0,flags:1}));}
export function encodeRemap(rows){if(!Array.isArray(rows)||rows.length!==31)throw new Error('映射表需要 31 项');const a=new Uint8Array(124);rows.forEach((r,i)=>{if(![0,1,2].includes(r.type)||![r.value,r.modifier,r.flags].every(n=>Number.isInteger(n)&&n>=0&&n<=255)||r.flags>3||(r.type===0&&r.value>30)||(r.type===2&&r.value>2))throw new Error('按键映射无效：'+remapNames[i]);a.set([r.type,r.value,r.modifier,r.flags],i*4);});return a;}
export function decodeRemap(a){if(a.length!==127)throw new Error('映射报告长度不匹配');const rows=Array.from({length:31},(_,i)=>({type:a[2+i*4],value:a[3+i*4],modifier:a[4+i*4],flags:a[5+i*4]}));encodeRemap(rows);return{active:a[0],edit:a[1],rows};}
