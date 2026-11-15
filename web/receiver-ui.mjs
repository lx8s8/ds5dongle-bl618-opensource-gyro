import {receiverFields,receiverDefaults,encodeReceiver,decodeReceiver,remapNames,remapDefaults,encodeRemap,decodeRemap} from './receiver-protocol.mjs';
import {MODIFIER_BITS,isRemapRowModified,toggleModifierBit} from './ui-helpers.mjs';
const $=id=>document.getElementById(id);
const keys=[...Array.from({length:26},(_,i)=>[4+i,String.fromCharCode(65+i)]),...Array.from({length:9},(_,i)=>[30+i,String(i+1)]),[39,'0'],[40,'Enter'],[41,'Esc'],[42,'Backspace'],[43,'Tab'],[44,'Space'],[79,'→'],[80,'←'],[81,'↓'],[82,'↑'],...Array.from({length:12},(_,i)=>[58+i,'F'+(i+1)])];
const advancedReceiverIds=new Set(['enable_usb_sn','ps_shortcut_enabled','speaker_gain','audio_buffer_length','lock_volume','disable_speaker']);
const segmentedReceiverIds=new Set(['controller_mode','polling_rate_mode','audio_haptic','tp_mode']);
const sliderReceiverIds=new Set(['inactive_time','haptics_gain','speaker_volume','headset_volume','trigger_reduce','tp_mouse_sensitivity']);
function options(el,list){el.replaceChildren(...list.map(([v,t])=>new Option(t,v)));}
export function initReceiverUI({transport,action,message,download}){
 let config=receiverDefaults(),table=remapDefaults(),edit=0,remapFilter='all';
 const syncHooks=[];
 const syncAll=()=>syncHooks.forEach(fn=>fn());
 for(const f of receiverFields){
  const row=document.createElement(f.bool?'label':'div');row.className=f.bool?'toggle-field':'field';
  const text=document.createElement(f.bool?'span':'label');text.textContent=f.label;if(!f.bool)text.htmlFor='receiver-'+f.id;
  const input=document.createElement(f.options?'select':'input');input.id='receiver-'+f.id;
  if(f.options)options(input,f.options.map((s,i)=>[i,s]));
  else if(f.bool)input.type='checkbox';
  else{input.type='number';input.min=f.min;input.max=f.max;input.step=f.step||1;input.required=true;}
  row.append(text);
  if(f.options&&segmentedReceiverIds.has(f.id)){
   const group=document.createElement('div');group.className='segmented compact';group.setAttribute('role','group');group.setAttribute('aria-label',f.label);
   const pills=f.options.map((s,i)=>{
    const b=document.createElement('button');b.type='button';b.textContent=s;b.dataset.value=String(i);
    b.onclick=()=>{input.value=String(i);sync();input.dispatchEvent(new Event('change',{bubbles:true}));};
    return b;
   });
   const sync=()=>{const cur=String(input.value);pills.forEach(b=>{const on=b.dataset.value===cur;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));});};
   input.hidden=true;input.addEventListener('change',sync);syncHooks.push(sync);group.append(...pills);row.append(group,input);
  }else if(!f.bool&&!f.options&&sliderReceiverIds.has(f.id)){
   const wrap=document.createElement('div');wrap.className='slider-pair';
   const range=document.createElement('input');range.type='range';range.min=f.min;range.max=f.max;range.step=f.step||1;range.setAttribute('aria-label',f.label+' 滑块');
   const sync=()=>{range.value=input.value;};
   range.oninput=()=>{input.value=range.value;input.dispatchEvent(new Event('input',{bubbles:true}));};
   input.addEventListener('input',sync);input.addEventListener('change',sync);syncHooks.push(sync);
   wrap.append(range,input);row.append(wrap);
  }else row.append(input);
  const targetGroup=advancedReceiverIds.has(f.id)?'advanced':f.group;
  $('receiver-'+targetGroup).append(row);
 }
 for(let i=0;i<5;i++){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.dataset.mode=i;label.append(input,document.createTextNode(['关闭','方向键','左鼠标','右鼠标','左右分区'][i]));$('touchModes').append(label);}
 function updateRemapMeta(){
  let modCount=0,shown=0;
  const rows=$('remapRows').children;
  table.forEach((entry,i)=>{
   const modified=isRemapRowModified(entry,i);
   if(modified)modCount++;
   const tr=rows[i];if(!tr)return;
   tr.classList.toggle('is-modified',modified);
   const match=remapFilter==='all'||(remapFilter==='buttons'&&i<19)||(remapFilter==='touch'&&i>=19)||(remapFilter==='modified'&&modified);
   tr.hidden=!match;if(match)shown++;
  });
  if($('remapModifiedCount'))$('remapModifiedCount').textContent=String(modCount);
  if($('remapEmptyFilter'))$('remapEmptyFilter').hidden=shown>0;
  if($('remapTouchNotice')){
   const tp=Number(config.tp_mode||0);
   const showWarn=remapFilter==='touch'&&tp===0;
   $('remapTouchNotice').hidden=!showWarn;
   if(showWarn)$('remapTouchNotice').textContent='当前“触摸板模式”为关闭，触摸分区不会触发。请在“接收器配置 → 触摸板与鼠标”中选择方向键或左右分区。';
  }
 }
 function render(){for(const f of receiverFields){const e=$('receiver-'+f.id);if(f.bool)e.checked=!!config[f.id];else e.value=config[f.id];}$('receiverColor').value='#'+['led_r','led_g','led_b'].map(k=>config[k].toString(16).padStart(2,'0')).join('');for(const e of $('touchModes').querySelectorAll('input'))e.checked=!!(config.tp_mode_enabled_mask&(1<<e.dataset.mode));syncAll();updateRemapMeta();}
 function form(){const c={...config};for(const f of receiverFields)c[f.id]=f.bool?Number($('receiver-'+f.id).checked):Number($('receiver-'+f.id).value);['led_r','led_g','led_b'].forEach((k,i)=>c[k]=parseInt($('receiverColor').value.slice(1+2*i,3+2*i),16));c.tp_mode_enabled_mask=[...$('touchModes').querySelectorAll('input:checked')].reduce((a,e)=>a|(1<<e.dataset.mode),0);encodeReceiver(c);return c;}
 function renderTable(){const body=$('remapRows');body.replaceChildren();table.forEach((entry,i)=>{
  const tr=document.createElement('tr'),name=document.createElement('th');name.textContent=remapNames[i];name.scope='row';tr.append(name);
  const type=document.createElement('select');type.setAttribute('aria-label',remapNames[i]+' 输出类型');options(type,[[0,'手柄'],[1,'键盘'],[2,'鼠标']]);type.value=entry.type;
  const value=document.createElement('select');value.setAttribute('aria-label',remapNames[i]+' 目标按键');
  const modCell=document.createElement('div');modCell.className='mod-cell';
  const modPills=document.createElement('div');modPills.className='mod-pills';
  const modChecks=MODIFIER_BITS.map(m=>{
   const label=document.createElement('label');label.className='mod-chip';
   const cb=document.createElement('input');cb.type='checkbox';cb.dataset.bit=m.bit;
   cb.onchange=()=>{entry.modifier=toggleModifierBit(entry.modifier,m.bit,cb.checked);updateRemapMeta();};
   label.append(cb,document.createTextNode(m.label));modPills.append(label);return cb;
  });
  const secondKey=document.createElement('select');secondKey.setAttribute('aria-label',remapNames[i]+' 第二按键');
  const modNone=document.createElement('span');modNone.className='hint muted-dash';modNone.textContent='—';
  modCell.append(modPills,secondKey,modNone);
  const suppress=document.createElement('input');suppress.type='checkbox';suppress.checked=!!(entry.flags&1);suppress.setAttribute('aria-label',remapNames[i]+' 屏蔽原按键');
  const extra=document.createElement('input');extra.type='checkbox';extra.checked=!!(entry.flags&2);extra.setAttribute('aria-label',remapNames[i]+' 双键输出');
  function syncModifierCell(){
   const t=Number(type.value),dual=t===1&&extra.checked;
   modPills.hidden=!(t===1&&!dual);secondKey.hidden=!dual;modNone.hidden=t===1;
   if(t===1&&!dual){modChecks.forEach(cb=>{cb.checked=!!(entry.modifier&Number(cb.dataset.bit));});}
   if(dual){
    options(secondKey,[[0,'无第二键'],...keys]);
    if(entry.modifier&&![...secondKey.options].some(o=>Number(o.value)===entry.modifier))secondKey.add(new Option('HID '+entry.modifier,entry.modifier));
    secondKey.value=String(entry.modifier||0);
   }
  }
  function targets(){
   const t=Number(type.value);
   options(value,t===0?remapNames.map((n,j)=>[j,n]):t===2?[[0,'鼠标左键'],[1,'鼠标右键'],[2,'鼠标中键']]:keys);
   if(![...value.options].some(o=>Number(o.value)===entry.value)&&t===1)value.add(new Option('HID '+entry.value,entry.value));
   value.value=entry.value;if(!value.value)value.selectedIndex=0;
   suppress.disabled=t===0;extra.disabled=t!==1;
   syncModifierCell();
  }
  function update(){
   const t=Number(type.value);
   const mod=t===1?(extra.checked?Number(secondKey.value):entry.modifier&15):0;
   Object.assign(entry,{type:t,value:Number(value.value),modifier:mod,flags:Number(suppress.checked)|(Number(extra.checked)<<1)});
   updateRemapMeta();
  }
  type.onchange=()=>{entry.type=Number(type.value);entry.value=entry.type===0?i:entry.type===1?4:0;entry.modifier=0;entry.flags=entry.type===0?1:1;suppress.checked=!!(entry.flags&1);extra.checked=false;targets();update();};
  value.onchange=suppress.onchange=()=>{update();};
  extra.onchange=()=>{entry.modifier=0;syncModifierCell();update();};
  secondKey.onchange=()=>{entry.modifier=Number(secondKey.value);updateRemapMeta();};
  targets();
  for(const el of [type,value,modCell,suppress,extra]){const td=document.createElement('td');td.append(el);tr.append(td);}body.append(tr);
 });updateRemapMeta();}
 if($('remapFilter')){
  for(const btn of $('remapFilter').querySelectorAll('[data-filter]')){
   btn.onclick=()=>{
    remapFilter=btn.dataset.filter;
    for(const other of $('remapFilter').querySelectorAll('[data-filter]'))other.classList.toggle('active',other===btn);
    updateRemapMeta();
   };
  }
 }
 async function readConfig(){config=decodeReceiver(await transport().read(0xF7));render();}
 async function readRemap(){await transport().legacy(0xFB,3,[edit]);const r=decodeRemap(await transport().read(0xFB,127));table=r.rows;renderTable();$('remapActive').textContent='当前生效：'+(r.active+1);}
 $('receiverSettings').onsubmit=e=>{e.preventDefault();action(async()=>{config=form();config=decodeReceiver(await transport().legacy(0xF6,1,encodeReceiver(config)));render();message('接收器设置已应用到 RAM');});};
 $('receiverRead').onclick=()=>action(async()=>{await readConfig();message('已读取接收器设置');});
 $('receiverDefaults').onclick=()=>{config=receiverDefaults();render();message('默认值已填入，请应用或保存');};
 async function save(reboot){config=form();config=decodeReceiver(await transport().legacy(0xF6,1,encodeReceiver(config)));render();await transport().legacy(0xF6,2);if(reboot){message('已保存，接收器即将重新枚举，请重新连接');transport().legacy(0xF6,3).catch(()=>{});}else message('接收器设置已保存');}
 $('receiverSave').onclick=()=>action(()=>save(false));$('receiverRestart').onclick=()=>action(()=>save(true));
 if($('receiverRebootOnly'))$('receiverRebootOnly').onclick=()=>action(async()=>{message('接收器正在软重启，请稍候重新连接');transport().legacy(0xF6,5).catch(()=>{});});
 $('receiverExport').onclick=()=>{try{download('ds5-receiver-config.json',JSON.stringify({version:1,receiver:form()},null,2),'application/json');}catch(e){message(e.message,true);}};
 $('receiverImport').onchange=e=>action(async()=>{const file=e.target.files[0];if(!file)return;if(file.size>65536)throw new Error('配置文件过大');const x=JSON.parse(await file.text());if(x.version!==1)throw new Error('配置文件版本不支持');config=decodeReceiver(encodeReceiver(x.receiver));render();e.target.value='';message('已导入接收器草稿，请应用或保存');});
 $('remapSlot').onchange=()=>action(async()=>{edit=Number($('remapSlot').value);if(transport())await readRemap();else{table=remapDefaults();renderTable();}});
 $('remapRead').onclick=()=>action(readRemap);$('remapReset').onclick=()=>{table=remapDefaults();renderTable();message('当前映射草稿已恢复，请保存');};
 $('remapSave').onclick=()=>action(async()=>{await transport().legacy(0xFB,1,Uint8Array.of(edit,...encodeRemap(table)));message('按键映射已保存到档 '+(edit+1));});
 $('remapActivate').onclick=()=>action(async()=>{await transport().legacy(0xFB,5,[edit]);$('remapActive').textContent='当前生效：'+(edit+1);message('已切换接收器映射档');});
 $('remapExport').onclick=()=>download('ds5-remap.json',JSON.stringify({version:1,profile:edit,rows:table},null,2),'application/json');
 $('remapImport').onchange=e=>action(async()=>{const file=e.target.files[0];if(!file)return;if(file.size>65536)throw new Error('映射文件过大');const x=JSON.parse(await file.text());if(x.version!==1)throw new Error('映射文件版本不支持');encodeRemap(x.rows);table=x.rows;renderTable();e.target.value='';message('已导入当前档映射草稿，请保存');});
 $('receiverSettings').addEventListener('change',()=>{try{config={...config,tp_mode:Number($('receiver-tp_mode').value)};updateRemapMeta();}catch{}});
 render();renderTable();return{async load(){await readConfig();await readRemap();},controls(connected,busy){for(const el of document.querySelectorAll('#receiverSettings input,#receiverSettings select,#receiverSettings button,#remapRows input,#remapRows select'))el.disabled=busy;for(const el of document.querySelectorAll('.requires-device'))el.disabled=!connected||busy;},getConfig:()=>config};
}
