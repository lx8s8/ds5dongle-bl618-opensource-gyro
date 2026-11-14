import {stickVelocity} from './mapping-model.mjs';

export function advanceView(view,config,sticks,dt) {
 if(!Number.isFinite(dt)||dt<=0||dt>=.25)return view;
 const [x,y]=stickVelocity(config,sticks[2],sticks[3]);
 return {yaw:((view.yaw+x*dt)%360+360)%360,pitch:Math.max(-85,Math.min(85,view.pitch-y*dt))};
}

export function initFpsPreview({getConfig}) {
 const $=id=>document.getElementById(id),canvas=$('fpsView'),ctx=canvas.getContext('2d');
 let yaw=0,pitch=0,last=0,input,receivedAt=0;
 function draw(){
  const w=canvas.width,h=canvas.height,px=w/120;
  ctx.fillStyle='#f0f5f5';ctx.fillRect(0,0,w,h);ctx.lineWidth=1;
  for(let i=-6;i<=6;i++){
   const longitude=(Math.floor(yaw/15)+i)*15,x=w/2+(longitude-yaw)*px;
   ctx.strokeStyle='#c6d5d8';ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();
   ctx.fillStyle='#52666c';ctx.font='13px system-ui';ctx.fillText(`${((longitude%360)+360)%360}°`,x+4,18);
  }
  for(let i=-9;i<=9;i++){
   const y=h/2+(pitch-i*15)*px;
   ctx.strokeStyle=i===0?'#91adb3':'#d4dfe1';ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();
  }
  ctx.strokeStyle='#087f70';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(w/2-12,h/2);ctx.lineTo(w/2+12,h/2);ctx.moveTo(w/2,h/2-12);ctx.lineTo(w/2,h/2+12);ctx.stroke();
  $('fpsAngles').textContent=`水平 ${yaw.toFixed(1)}° · 俯仰 ${pitch.toFixed(1)}°`;
 }
 function reset(){yaw=pitch=last=0;draw();}
 function update(next,at){
  input=next;receivedAt=at;const now=performance.now(),dt=(now-last)/1000;last=now;
  if(!$('fpsPreview').checked)return;
  // Discard a suspended/background interval instead of integrating stale input.
  if(dt>0&&dt<.25&&now-receivedAt<250){
   ({yaw,pitch}=advanceView({yaw,pitch},getConfig(),input.sticks,dt));
  }
  draw();
 }
 $('fpsPreview').onchange=()=>{last=0;draw();};$('fpsReset').onclick=reset;
 document.addEventListener('visibilitychange',()=>{last=0;});
 reset();return{update,reset};
}
