import {MacroClient,MacroRecorder,encodeMacro,decodeMacro,emptyRules,encodeRules,decodeRules,padOutputs,SLOTS,MAX_STEPS} from './macros.mjs';
import {buttonNames} from './protocol.mjs';
import {getMacroRuleVisibility} from './ui-helpers.mjs';
const $=id=>document.getElementById(id);
const option=(v,t)=>new Option(t,v);
const keyboard=[...Array.from({length:26},(_,i)=>[i+4,String.fromCharCode(65+i)]),...Array.from({length:10},(_,i)=>[30+i,String((i+1)%10)]),...Array.from({length:24},(_,i)=>[i<12?58+i:104+i-12,'F'+(i+1)]),[79,'→'],[80,'←'],[81,'↓'],[82,'↑'],[40,'Enter'],[41,'Esc'],[43,'Tab'],[44,'Space'],[224,'左 Ctrl'],[225,'左 Shift'],[226,'左 Alt'],[227,'左 Win / Command'],[228,'右 Ctrl'],[229,'右 Shift'],[230,'右 Alt'],[231,'右 Win / Command']];
const targets=act=>act===3?padOutputs.map(x=>[x.key,x.name]):act===2?[[0,'鼠标左键'],[1,'鼠标右键'],[2,'鼠标中键'],[3,'滚轮向上'],[4,'滚轮向下']]:act===1?keyboard:[[0,'等待']];
const blank=()=>({name:'新宏',mode:0,repeat:1,pauseMs:100,steps:[]});
const btn=(text,fn)=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=fn;return b;};
export function initMacroUI({transport,action,message,download,getLive}){
 let available=false,busy=false,slot=0,model=blank(),rules=emptyRules(),recording=false,loading=false,lastCaptureAt=0,lastTraceAt=0,lastLogAt=0,linkEvents=[],session=0;
 const recorder=new MacroRecorder(),traces=[];let physical=null;
 const client=()=>{const t=transport();if(!t)throw new Error('请先连接接收器');return new MacroClient(t);};
 for(let i=0;i<SLOTS;i++)$('macroSlot').add(option(i,'宏 '+(i+1)));
 function updatePlaybackFields(){
  const m=Number($('macroMode').value),rep=Number($('macroRepeat').value)||1;
  if($('macroRepeat').parentElement)$('macroRepeat').parentElement.hidden=m!==0;
  if($('macroPause').parentElement)$('macroPause').parentElement.hidden=m===0&&rep<=1;
 }
 function controls(connected,b=false){busy=b;for(const e of $('macros').querySelectorAll('.requires-macro'))e.disabled=!connected||!available||busy;for(const e of [$('macroName'),$('macroMode'),$('macroRepeat'),$('macroPause'),...$('macroSteps').querySelectorAll('input,select,button'),...$('macroBindings').querySelectorAll('input,select,button')])e.disabled=busy||recording;$('macroStop').disabled=!connected||!available;$('macroRecordStop').disabled=!recording;for(const id of ['macroSlot','macroAddDown','macroAddUp','macroAddWait','macroClear','macroExport','macroBinary','macroImport'])$(id).disabled=busy||recording;$('macroRecord').disabled||=recording;$('macroTest').disabled||=model.mode!==0||recording;updatePlaybackFields();}
 function summary(){ $('macroStepCount').textContent=`${model.steps.length} / ${MAX_STEPS} 步 · ${model.steps.reduce((n,s)=>n+(s.delayMs||1),0)} ms`;$('macroEmpty').hidden=!!model.steps.length;updatePlaybackFields(); }
 function renderSteps(){const body=$('macroSteps');body.replaceChildren();model.steps.forEach((step,i)=>{
  const tr=document.createElement('tr');const add=el=>{const td=document.createElement('td');td.append(el);tr.append(td);};const num=document.createElement('span');num.textContent=i+1;add(num);
  const type=document.createElement('select');[[3,'手柄'],[1,'键盘'],[2,'鼠标'],[0,'等待']].forEach(([v,t])=>type.add(option(v,t)));type.value=step.act;type.setAttribute('aria-label','第 '+(i+1)+' 步类型');
  const key=document.createElement('select');key.setAttribute('aria-label','第 '+(i+1)+' 步按键');
  const edge=document.createElement('select');edge.add(option(1,'按下'));edge.add(option(0,'松开'));edge.value=step.edge;edge.setAttribute('aria-label','第 '+(i+1)+' 步动作');
  function choices(){key.replaceChildren(...targets(step.act).map(([v,t])=>option(v,t)));if(![...key.options].some(o=>+o.value===step.key))key.add(option(step.key,'HID '+step.key));key.value=step.key;const wait=step.act===0;key.hidden=wait;edge.hidden=wait;}
  type.onchange=()=>{step.act=+type.value;step.key=targets(step.act)[0][0];choices();};choices();key.onchange=()=>step.key=+key.value;add(type);add(key);
  edge.onchange=()=>step.edge=+edge.value;add(edge);
  const delay=document.createElement('input');delay.type='number';delay.min=0;delay.max=65535;delay.value=step.delayMs;delay.setAttribute('aria-label','第 '+(i+1)+' 步后等待毫秒');delay.oninput=()=>{step.delayMs=Number(delay.value);summary();};add(delay);
  const ops=document.createElement('div');ops.className='step-actions';
  const up=btn('↑',()=>{if(i>0){[model.steps[i-1],model.steps[i]]=[model.steps[i],model.steps[i-1]];renderSteps();}});up.title='上移';if(i===0)up.hidden=true;
  const dn=btn('↓',()=>{if(i+1<model.steps.length){[model.steps[i+1],model.steps[i]]=[model.steps[i],model.steps[i+1]];renderSteps();}});dn.title='下移';if(i+1===model.steps.length)dn.hidden=true;
  const dup=btn('复制',()=>{if(model.steps.length>=MAX_STEPS)return message('已达到 640 步',true);model.steps.splice(i+1,0,{...step});renderSteps();});
  const del=btn('删除',()=>{model.steps.splice(i,1);renderSteps();});
  ops.append(up,dn,dup,del);add(ops);body.append(tr);
 });summary();controls(!!transport(),busy);}
 function render(){ $('macroName').value=model.name;$('macroMode').value=model.mode;$('macroRepeat').value=model.repeat;$('macroPause').value=model.pauseMs;renderSteps(); }
 function form(){model.name=$('macroName').value;model.mode=+$('macroMode').value;model.repeat=+$('macroRepeat').value;model.pauseMs=+$('macroPause').value;encodeMacro(model);return model;}
 const ruleRows=[],gestureNames=['按下','松开','长按','双击','三击'];
 function refreshBindingFilter(){
  const activeOnly=!!$('macroShowActiveOnly')?.checked;
  let activeCount=0;
  ruleRows.forEach(r=>{
   const cur=r.read();if(cur.enabled)activeCount++;
   r.details.hidden=activeOnly&&!cur.enabled;
  });
  if($('macroRulesSummary'))$('macroRulesSummary').textContent=`已启用 ${activeCount} / 16 条绑定`;
 }
 for(let i=0;i<16;i++){
  const details=document.createElement('details'),title=document.createElement('summary'),grid=document.createElement('div');grid.className='grid';details.append(title,grid);
  const field=(label,el)=>{const row=document.createElement('label');row.className='field';row.append(document.createTextNode(label),el);grid.append(row);return el;};
  const enabled=field('启用此绑定',document.createElement('input'));enabled.type='checkbox';const target=field('播放宏',document.createElement('select'));for(let j=0;j<16;j++)target.add(option(j,'宏 '+(j+1)));
  const gesture=field('触发条件',document.createElement('select'));gestureNames.forEach((t,j)=>gesture.add(option(j,t)));
  const hold=field('长按时间 · ms',document.createElement('input'));hold.type='number';hold.min=1;hold.max=3000;
  const tap=field('连续点击间隔 · ms',document.createElement('input'));tap.type='number';tap.min=1;tap.max=1000;
  const suppress=field('屏蔽原始按键',document.createElement('input'));suppress.type='checkbox';
  const learnRow=document.createElement('div');learnRow.className='actions';
  const box=document.createElement('fieldset');box.className='macro-source-buttons';buttonNames.forEach((name,bit)=>{const label=document.createElement('label');label.className='button-choice';const input=document.createElement('input');input.type='checkbox';input.dataset.bit=bit;label.append(input,document.createTextNode(name));box.append(label);});
  const learn=btn('按住手柄按键读取',()=>{const cur=getLive?.();if(!cur||!(cur.flags&1)||!cur.buttons)return message('请先连接接收器并按住需要绑定的按键',true);for(const e of box.querySelectorAll('input'))e.checked=!!(cur.buttons&(1<<e.dataset.bit));update();message('已读取当前按住的手柄按键');});
  learnRow.append(learn);details.append(learnRow,box);
  const profiles=document.createElement('div');profiles.className='checks';const hint=document.createElement('span');hint.textContent='限定体感配置（不选为全部）：';profiles.append(hint);for(let j=0;j<4;j++){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.dataset.profile=j;label.append(input,document.createTextNode('配置 '+(j+1)));profiles.append(label);}details.append(profiles);
  const read=()=>({buttons:[...box.querySelectorAll('input:checked')].reduce((v,e)=>v|1<<e.dataset.bit,0),slot:+target.value,gesture:+gesture.value,profiles:[...profiles.querySelectorAll('input:checked')].reduce((v,e)=>v|1<<e.dataset.profile,0),enabled:enabled.checked,suppress:suppress.checked,holdMs:+hold.value,tapMs:+tap.value});
  const update=()=>{const r=read();const vis=getMacroRuleVisibility(r);const names=buttonNames.filter((_,bit)=>r.buttons&(1<<bit));const keyText=names.length?' · '+names.join(' + '):'';title.textContent=`绑定 ${i+1} · ${r.enabled?`宏 ${r.slot+1}（${gestureNames[r.gesture]}${keyText}）`:'关闭'}`;details.classList.toggle('is-active',r.enabled);hold.parentElement.hidden=!vis.usesHoldMs;tap.parentElement.hidden=!vis.usesTapMs;refreshBindingFilter();};
  details.onchange=update;ruleRows.push({details,read,render(r){enabled.checked=r.enabled;target.value=r.slot;gesture.value=r.gesture;hold.value=r.holdMs||300;tap.value=r.tapMs||250;suppress.checked=r.suppress;for(const e of box.querySelectorAll('input'))e.checked=!!(r.buttons&(1<<e.dataset.bit));for(const e of profiles.querySelectorAll('input'))e.checked=!!(r.profiles&(1<<e.dataset.profile));update();}});$('macroBindings').append(details);
 }
 if($('macroShowActiveOnly'))$('macroShowActiveOnly').onchange=refreshBindingFilter;
 function renderRules(){ruleRows.forEach((r,i)=>r.render(rules[i]));refreshBindingFilter();}
 async function readSlot(){const bytes=await client().read(1,slot);model=bytes.length?decodeMacro(bytes):blank();render();}
 async function load(){session++;available=!!transport()?.device.collections.some(c=>(c.featureReports||[]).some(r=>r.reportId===0xF3));$('macroSupport').textContent=available?'宏协议已就绪':'需要包含宏模块的 G2.4 或更新固件';controls(!!transport(),busy);if(!available)return;const r=await client().request(0);$('macroSpace').textContent=(new DataView(r.buffer).getUint32(12,true)/1024).toFixed(0)+' KiB 可用';await readSlot();rules=decodeRules(await client().read(6));renderRules();}
 $('macroSlot').onchange=()=>action(async()=>{slot=+$('macroSlot').value;if(available)await readSlot();else{model=blank();render();}});
 $('macroRead').onclick=()=>action(readSlot);
 $('macroSave').onclick=()=>action(async()=>{await client().upload(slot,encodeMacro(form()));await readSlot();message('宏已保存到接收器');});
 $('macroDelete').onclick=()=>action(async()=>{await client().request(5,slot);await readSlot();message('已删除此宏');});
 $('macroTest').onclick=()=>action(async()=>{await client().request(11,slot);message('已开始播放接收器中保存的宏');});
 $('macroStop').onclick=()=>client().request(12).then(()=>message('已停止宏并释放按键')).catch(e=>message(e.message,true));
 $('macroRulesRead').onclick=()=>action(async()=>{rules=decodeRules(await client().read(6));renderRules();});
 $('macroRulesSave').onclick=()=>action(async()=>{const next=ruleRows.map(r=>r.read());encodeRules(next);await client().saveRules(next);rules=decodeRules(await client().read(6));renderRules();message('宏绑定已保存');});
 const append=edge=>{if(model.steps.length>=MAX_STEPS)return message('已达到 640 步',true);const last=model.steps.at(-1)||{act:3,key:1};model.steps.push({act:last.act,key:last.key,edge,delayMs:50});renderSteps();};
 $('macroAddDown').onclick=()=>append(1);$('macroAddUp').onclick=()=>append(0);$('macroAddWait').onclick=()=>{if(model.steps.length>=MAX_STEPS)return;model.steps.push({act:0,key:0,edge:0,delayMs:100});renderSteps();};
 $('macroClear').onclick=()=>{model.steps=[];renderSteps();};$('macroMode').onchange=()=>{model.mode=+$('macroMode').value;controls(!!transport(),busy);};$('macroRepeat').oninput=()=>{model.repeat=+$('macroRepeat').value;updatePlaybackFields();};
 $('macroExport').onclick=()=>{try{download(`ds5-macro-${slot+1}.json`,JSON.stringify({version:1,macro:form(),bindings:ruleRows.map(r=>r.read())},null,2),'application/json');}catch(e){message(e.message,true);}};
 $('macroBinary').onclick=()=>{try{download(`ds5-macro-${slot+1}.mac`,encodeMacro(form()),'application/octet-stream');}catch(e){message(e.message,true);}};
 $('macroImport').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;if(file.size>1000000)throw new Error('文件过大');const a=new Uint8Array(await file.arrayBuffer());let m,newRules;if(a[0]===123){const x=JSON.parse(new TextDecoder().decode(a));m=x.macro||x;if(x.bindings){encodeRules(x.bindings);newRules=x.bindings;}encodeMacro(m);}else m=decodeMacro(a);model=m;if(newRules){rules=newRules;renderRules();}render();message('已导入草稿；保存后写入接收器');}catch(err){message(err.message,true);}finally{e.target.value='';}};
 async function finishRecord(){if(!recording)return;recording=false;model.steps=recorder.stop(performance.now());await client().request(15,0,0).catch(()=>{});render();message('录制已停止，检查步骤后保存');}
 $('macroRecord').onclick=()=>action(async()=>{form();await client().request(15,0,1);recorder.start();recording=true;$('macroSupport').textContent='正在录制手柄按键；设备宏暂时暂停';controls(true);});
 $('macroRecordStop').onclick=()=>finishRecord().catch(e=>message(e.message,true));
 async function poll(){if(!available||busy||loading||!transport())return;loading=true;const generation=session,current=transport();try{
  const t=performance.now();if(t-lastTraceAt>500){lastTraceAt=t;const c=client(),a=await c.read(20);if(generation!==session||transport()!==current)return;if(!recording)$('macroSupport').textContent=c.lastStatus?.[5]<16?'正在播放宏 '+(c.lastStatus[5]+1):'宏已就绪';physical=a.slice(0,63);traces.push({at:new Date().toISOString(),raw:Array.from(physical),output:Array.from(a.slice(63))});if(traces.length>120)traces.shift();}
  if(t-lastLogAt>5000){lastLogAt=t;const a=await client().read(21);const v=new DataView(a.buffer);if(new TextDecoder().decode(a.slice(0,4))==='BTL1'){const count=v.getUint32(8,true);if(count>24)throw new Error('链路日志长度无效');linkEvents=Array.from({length:count},(_,i)=>{const p=16+i*16;return{deviceMs:v.getUint32(p,true),event:v.getUint32(p+4,true),value:v.getUint32(p+8,true),detail:v.getUint32(p+12,true)};});}}
  if(recording&&t-lastCaptureAt>500){lastCaptureAt=t;await client().request(15,0,1);$('macroSupport').textContent='正在录制 · '+recorder.steps.length+' 步';if(!recorder.active)await finishRecord();}
 }catch(e){if(generation===session&&transport()===current)$('macroSupport').textContent=e.message;}finally{loading=false;}}
 render();renderRules();controls(false);
 document.addEventListener('visibilitychange',()=>{if(document.hidden&&recording)finishRecord().catch(e=>message(e.message,true));});
 return {load,controls,poll,leave:()=>recording?finishRecord():Promise.resolve(),input(bytes){if(recording)recorder.input(bytes,performance.now());},snapshot(){return {physicalAndOutput:traces.slice(),linkEvents:linkEvents.slice(),recording};},async reset(){session++;if(recording)await finishRecord();available=false;$('macroSupport').textContent='未连接';$('macroSpace').textContent='';physical=null;traces.length=0;linkEvents=[];controls(false);}};
}
