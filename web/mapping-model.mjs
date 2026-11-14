export function mappingSpeed(c, degreesPerSecond, axis='x', ads=false) {
 const speed=Math.max(0,Math.abs(degreesPerSecond)-c.noise);
 const t=Math.max(0,Math.min(1,(Math.abs(degreesPerSecond)-c.accelStart)/(c.accelEnd-c.accelStart)));
 return speed*(axis==='x'?c.sx:c.sy)*(1+(c.accel-1)*t)*(ads?c.adsMultiplier:1);
}
export function mouseSpeed(c,dps,axis='x',ads=false){return mappingSpeed(c,dps,axis,ads)*c.mouseCpd;}
export function stickPosition(c,dps,axis='x',ads=false){const normalized=Math.min(1,mappingSpeed(c,dps,axis,ads)/c.maxTurn);return normalized>0?c.stickDeadzone/100+(1-c.stickDeadzone/100)*normalized**(1/c.stickPower):0;}
export function stickVelocity(c,x,y){
 const radius=Math.hypot(x,y),deadzone=c.stickDeadzone/100;
 if(!Number.isFinite(radius)||radius<=deadzone)return[0,0];
 const speed=c.maxTurn*Math.min(1,(radius-deadzone)/(1-deadzone))**c.stickPower;
 return[x/radius*speed,y/radius*speed];
}
export function decodeInput(p){if(p.length<63)throw new Error('USB 输入报告不完整');const v=new DataView(p.buffer,p.byteOffset,p.byteLength);let buttons=(p[7]>>4)|(p[8]<<4)|((p[9]&7)<<12)|((p[9]>>4)<<19);const hat=p[7]&15;for(const [bit,values] of [[15,[0,1,7]],[16,[3,4,5]],[17,[5,6,7]],[18,[1,2,3]]])if(values.includes(hat))buttons|=1<<bit;const touches=[32,36].map(o=>({active:!(p[o]&128),id:p[o]&127,x:p[o+1]|((p[o+2]&15)<<8),y:(p[o+2]>>4)|(p[o+3]<<4)}));if(touches.some(t=>t.active))buttons|=1<<23;return{sensorTicks:v.getUint32(27,true),sticks:[...p.slice(0,4)].map(n=>(n-127.5)/127.5),triggers:[p[4]/255,p[5]/255],buttons,touches,gyro:[15,17,19].map(o=>v.getInt16(o,true)),accel:[21,23,25].map(o=>v.getInt16(o,true)/8192*9.80665),battery:Math.min(100,(p[52]&15)*10),charging:(p[52]>>4)===1,headset:!!(p[53]&1)};}
