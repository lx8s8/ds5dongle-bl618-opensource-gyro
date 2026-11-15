import { CONFIG_REPORT, STATUS_REPORT, PROFILE_REPORT, DIAGNOSTIC_REPORT, REPORT_SIZE, buttonNames, fields, defaults, encodeConfig, decodeConfig, featureBytes, decodeStatus, globalDefaults, encodeGlobal, decodeProfiles, decodeDiagnostics, importBundle } from './protocol.mjs';
import { initLocalApp } from './local-app.mjs';
import { HidTransport, requestReceiver } from './transport.mjs';
import { initReceiverUI } from './receiver-ui.mjs';
import { initTester } from './tester.mjs';
import {initMacroUI} from './macro-ui.mjs';
import {initBootManager} from './boot-manager.mjs';
import {initDualFirmware} from './dual-ui.mjs';
import { initReleases } from './releases.mjs';
import { initFlasher } from './flash-ui.mjs';
import { mouseSpeed, stickPosition } from './mapping-model.mjs';
import { initMouseTest } from './mouse-test.mjs?v=20261114-mouse2';
import { DiagnosticCapture } from './diagnostic-capture.mjs';
import { GYRO_PRESETS, OUTPUT_NAMES, STICK_GAME_TEMPLATES, computeStickWizard, configsMatch, diffConfigBundles, evaluateCompatibilityMode, formatSlotTitle, getConfigVisibility, globalsMatch, normalizeSlotNames, summarizeGyroConfig } from './ui-helpers.mjs';

const $ = id => document.getElementById(id);
let transport, receiverUI, tester, macroUI;
let device, busy = false, sequence = 0, live, samples = [], usbStick, metrics, diagnosticAt = 0, editSlot = 0, manualTouched = false;
let drafts = Array.from({ length: 4 }, defaults);
let cleanDrafts = Array.from({ length: 4 }, defaults);
let cleanGlobal = globalDefaults();
let reportedProfiles = [];
let slotNames = ['', '', '', ''];
let undoSnapshot = null, pendingImportBundle = null, replayTimer = null;
try {
  const savedNames = JSON.parse(localStorage.getItem('ds5-slot-names-v1') || '[]');
  slotNames = normalizeSlotNames(savedNames);
} catch {}
function saveSlotNames() {
  slotNames = normalizeSlotNames(slotNames);
  try { localStorage.setItem('ds5-slot-names-v1', JSON.stringify(slotNames)); } catch {}
}
function pushUndoSnapshot() {
  try {
    drafts[editSlot] = readDraftConfig();
    undoSnapshot = {
      drafts: drafts.map(d => ({ ...d })),
      settings: globalConfig(),
      slotNames: [...slotNames],
    };
    if ($('undoProfileBtn')) $('undoProfileBtn').disabled = false;
  } catch {}
}
const capture = new DiagnosticCapture();
const deviceButtons = ['apply', 'save', 'read', 'defaults', 'calibrate', 'clearCalibration', 'disconnect', 'activateSlot', 'configCalibrate'];
const actionNames = ['未设置', '下一配置', '上一配置', '指定配置', '体感开关', '静止校准', '按住精瞄'];
const sliderIds = new Set(['sx', 'sy', 'mouseCpd', 'adsMultiplier', 'threshold', 'releaseThreshold', 'noise', 'smooth', 'accel', 'maxTurn', 'stickDeadzone', 'stickPower', 'hold']);
const segmentedIds = new Set(['output', 'activation', 'trigger', 'horizontal']);
const fieldContainer = { hold: 'advanced', releaseThreshold: 'advanced', noise: 'advanced', smooth: 'advanced', accel: 'advanced', accelStart: 'advanced', accelEnd: 'advanced', profileSource: 'profile' };
const fieldWrappers = {}, fieldLabels = {}, syncHooks = [];
function select(options) { const el = document.createElement('select'); options.forEach(([value, text]) => el.add(new Option(text, value))); return el; }
function field(label, input, f) {
  const row = document.createElement('div'); row.className = 'field';
  if (f?.id) row.dataset.fieldId = f.id;
  const text = document.createElement('label'); text.htmlFor = input.id; text.textContent = label;
  if (f?.id) { fieldWrappers[f.id] = row; fieldLabels[f.id] = text; }
  row.append(text);
  if (f && segmentedIds.has(f.id)) {
    const group = document.createElement('div'); group.className = 'segmented'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
    const pills = f.options.map((name, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = name; b.dataset.value = String(i);
      b.onclick = () => { input.value = String(i); sync(); input.dispatchEvent(new Event('change', { bubbles: true })); };
      return b;
    });
    const sync = () => { const cur = String(input.value); pills.forEach(b => { const on = b.dataset.value === cur; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); }); };
    input.hidden = true;
    input.addEventListener('change', sync);
    syncHooks.push(sync);
    group.append(...pills);
    row.append(group, input);
    return row;
  }
  if (f && sliderIds.has(f.id)) {
    const wrap = document.createElement('div'); wrap.className = 'slider-pair';
    const range = document.createElement('input'); range.type = 'range'; range.min = f.min; range.max = f.max; range.step = f.step || 1;
    range.setAttribute('aria-label', label + ' 滑块');
    const sync = () => { range.value = input.value; };
    range.oninput = () => { input.value = range.value; input.dispatchEvent(new Event('input', { bubbles: true })); };
    input.addEventListener('input', sync);
    input.addEventListener('change', sync);
    syncHooks.push(sync);
    wrap.append(range, input);
    row.append(wrap);
    return row;
  }
  row.append(input);
  return row;
}
function syncFieldControls() { syncHooks.forEach(fn => fn()); }
function choices(box, mask = 0) {
  buttonNames.forEach((name, bit) => {
    const label = document.createElement('label'); label.className = 'button-choice';
    const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.bit = bit; input.checked = !!(mask & (1 << bit));
    label.append(input, document.createTextNode(name)); box.append(label);
  });
}
function readMask(box) { return [...box.querySelectorAll('input:checked')].reduce((m, e) => m | (1 << e.dataset.bit), 0); }
function setMask(box, mask) { for (const e of box.querySelectorAll('input')) e.checked = !!(mask & (1 << e.dataset.bit)); }
for (const f of fields) {
  const input = f.options ? select(f.options.map((name, i) => [i, name])) : document.createElement('input'); input.id = f.id;
  if (!f.options) { input.type = 'number'; input.min = f.min; input.max = f.max; input.step = f.step || 1; input.required = true; }
  const group = fieldContainer[f.id] || f.group;
  $(group + 'Fields').append(field(f.label, input, f));
}
if ($('gyroPresets')) {
  for (const preset of GYRO_PRESETS) {
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'preset-chip'; btn.dataset.preset = preset.id;
    const title = document.createElement('strong'); title.textContent = preset.label;
    const hint = document.createElement('span'); hint.textContent = preset.hint;
    btn.append(title, hint);
    btn.onclick = () => {
      pushUndoSnapshot();
      drafts[editSlot] = preset.build();
      render(drafts[editSlot]);
      refreshConfiguration();
      message(`已套用预设“${preset.label}”到${formatSlotTitle(editSlot, slotNames[editSlot])}，请点击“应用”或“保存”`);
    };
    $('gyroPresets').append(btn);
  }
}
if ($('stickGamePresets')) {
  for (const tpl of STICK_GAME_TEMPLATES) {
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'preset-chip'; btn.dataset.stickTpl = tpl.id;
    const title = document.createElement('strong'); title.textContent = tpl.label;
    const hint = document.createElement('span'); hint.textContent = tpl.hint;
    btn.append(title, hint);
    btn.onclick = () => {
      pushUndoSnapshot();
      $('maxTurn').value = tpl.maxTurn;
      $('stickDeadzone').value = tpl.stickDeadzone;
      $('stickPower').value = tpl.stickPower;
      $('blend').value = tpl.blend;
      syncFieldControls();
      refreshConfiguration();
      message(`已填入“${tpl.label}”右摇杆曲线参数`);
    };
    $('stickGamePresets').append(btn);
  }
}
function updateStickWizardPreview() {
  if (!$('wizStickPreview')) return;
  const res = computeStickWizard({
    gameDeadzonePct: $('wizGameDeadzone')?.value,
    turn360Seconds: $('wizTurn360Sec')?.value,
    curveType: $('wizCurveType')?.value,
  });
  $('wizStickPreview').textContent = `推荐：满杆 ${res.maxTurn}°/s · 死区补偿 ${res.stickDeadzone}% · 指数 ${res.stickPower}`;
  return res;
}
if ($('wizApplyStick')) {
  ['wizGameDeadzone', 'wizTurn360Sec', 'wizCurveType'].forEach(id => {
    if ($(id)) $(id).addEventListener('input', updateStickWizardPreview);
    if ($(id)) $(id).addEventListener('change', updateStickWizardPreview);
  });
  updateStickWizardPreview();
  $('wizApplyStick').onclick = () => {
    pushUndoSnapshot();
    const res = updateStickWizardPreview();
    if (!res) return;
    $('maxTurn').value = res.maxTurn;
    $('stickDeadzone').value = res.stickDeadzone;
    $('stickPower').value = res.stickPower;
    syncFieldControls();
    refreshConfiguration();
    message(`已按向导填入：满杆 ${res.maxTurn}°/s、死区补偿 ${res.stickDeadzone}%、响应指数 ${res.stickPower}`);
  };
}
choices($('buttons'));
buttonNames.forEach((name, bit) => { const el = document.createElement('span'); el.textContent = name; el.dataset.bit = bit; $('liveButtons').append(el); });
for (const [group, labels] of [['native', ['Fn + △', 'Fn + □', 'Fn + ×', 'Fn + ○']], ['dongle', ['接收器档 1', '接收器档 2']]]) {
  labels.forEach((label, i) => {
    const input = select([[255, '关闭'], ...[0, 1, 2, 3].map(n => [n, `配置 ${n + 1}`])]); input.id = `${group}${i}`;
    $(`${group}Bindings`).append(field(label, input));
  });
}
const shortcutRows = [];
for (let i = 0; i < 4; i++) {
  const details = document.createElement('details'); details.className = 'shortcut';
  const summary = document.createElement('summary'), grid = document.createElement('div'); grid.className = 'grid';
  const inputs = {
    action: select(actionNames.map((name, value) => [value, name])),
    gesture: select([[0, '按下'], [1, '长按'], [2, '双击']]), target: select([0, 1, 2, 3].map(n => [n, `配置 ${n + 1}`])),
    hold: document.createElement('input'), fine: document.createElement('input'), suppress: select([[0, '保留'], [1, '组合成立时屏蔽'], [3, '始终屏蔽所选按键']]),
  };
  inputs.hold.type = inputs.fine.type = 'number'; inputs.hold.min = 1; inputs.hold.max = 3000; inputs.hold.value = 300;
  inputs.fine.min = .01; inputs.fine.max = 1; inputs.fine.step = .01; inputs.fine.value = .5;
  const labels = { action: '动作', gesture: '触发方式', target: '目标配置', hold: '长按时间 · ms', fine: '精瞄倍率', suppress: '原始按键' }, wrappers = {};
  for (const [key, input] of Object.entries(inputs)) { input.id = `shortcut${i}-${key}`; wrappers[key] = field(labels[key], input); grid.append(wrappers[key]); }
  const mask = document.createElement('fieldset'); choices(mask);
  const learn = document.createElement('button'); learn.type = 'button'; learn.textContent = '读取按键'; learn.className = 'learn-shortcut';
  learn.onclick = () => { if (!live || !(live.flags & 1) || !live.buttons) return message('请按住需要设置的按键', true); setMask(mask, live.buttons); update(); refreshConfiguration(); };
  function update() {
    const action = Number(inputs.action.value), gesture = Number(inputs.gesture.value);
    if (action === 6 && gesture === 2) inputs.gesture.value = 0;
    inputs.gesture.options[2].disabled = action === 6;
    wrappers.gesture.hidden = wrappers.suppress.hidden = mask.hidden = learn.hidden = !action;
    wrappers.target.hidden = action !== 3; wrappers.fine.hidden = action !== 6;
    wrappers.hold.hidden = Number(inputs.gesture.value) !== 1 || !action;
    const names = buttonNames.filter((_, bit) => readMask(mask) & (1 << bit));
    summary.textContent = `快捷键 ${i + 1} · ${actionNames[action]}${action && names.length ? ` · ${names.join(' + ')}` : ''}`;
  }
  details.append(summary, grid, learn, mask); $('shortcuts').append(details);
  details.addEventListener('change', update); shortcutRows.push({ inputs, mask, update });
}
function profileChoices(mask = 0) {
  const source = Number($('profileSource').value), box = $('profiles'); box.replaceChildren(); box.hidden = !source;
  const names = source === 1 ? ['Fn + △', 'Fn + □', 'Fn + ×', 'Fn + ○'] : ['接收器档 1', '接收器档 2'];
  names.forEach((name, i) => { const label = document.createElement('label'); label.className = 'button-choice'; const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.profile = i; input.checked = !!(mask & (1 << i)); label.append(input, document.createTextNode(name)); box.append(label); });
}
$('profileSource').onchange = () => profileChoices();
const flagCheckIds = ['invertX', 'invertY', 'suppress', 'allButtons', 'autoBias', 'adaptiveSmooth'];
function render(c) {
  fields.forEach(f => { $(f.id).value = c[f.id]; }); setMask($('buttons'), c.buttons);
  flagCheckIds.forEach((id, bit) => { if ($(id)) $(id).checked = !!(c.flags & (1 << bit)); }); profileChoices(c.profiles);
  if ($('syncXY')) $('syncXY').checked = Math.abs(Number(c.sx) - Number(c.sy)) < 0.005;
  if ($('slotCustomName')) $('slotCustomName').value = slotNames[editSlot] || '';
  syncFieldControls();
}
function readDraftConfig() {
  if ($('syncXY')?.checked) { $('sy').value = $('sx').value; syncFieldControls(); }
  const c = Object.fromEntries(fields.map(f => [f.id, Number($(f.id).value)]));
  c.flags = flagCheckIds.reduce((m, id, bit) => m | ($(id)?.checked ? 1 << bit : 0), 0);
  c.buttons = readMask($('buttons')); c.profiles = c.profileSource ? [...$('profiles').querySelectorAll('input:checked')].reduce((m, e) => m | (1 << e.dataset.profile), 0) : 0;
  return c;
}
function formConfig() {
  const c = readDraftConfig();
  encodeConfig(c); return c;
}
function renderGlobal(g) {
  manualTouched = false;
  $('switchSource').value = g.source; $('manualSlot').value = g.manual; $('feedback').checked = !!g.feedback;
  g.edge.forEach((n, i) => { $(`native${i}`).value = n; }); g.dongle.forEach((n, i) => { $(`dongle${i}`).value = n; });
  g.actions.forEach((a, i) => { const r = shortcutRows[i]; for (const key of Object.keys(r.inputs)) r.inputs[key].value = key === 'hold' && !a.hold ? 300 : key === 'fine' && !a.fine ? .5 : a[key]; setMask(r.mask, a.buttons); r.update(); }); updateSource();
}
function globalConfig() {
  const g = { source: Number($('switchSource').value), manual: Number($('manualSlot').value), feedback: Number($('feedback').checked), edge: [0, 1, 2, 3].map(i => Number($(`native${i}`).value)), dongle: [0, 1].map(i => Number($(`dongle${i}`).value)),
    actions: shortcutRows.map(r => ({ ...Object.fromEntries(Object.entries(r.inputs).map(([key, input]) => [key, Number(input.value)])), buttons: readMask(r.mask) })) };
  encodeGlobal(g); return g;
}
function updateSource() {
  const n = Number($('switchSource').value);
  if ($('manualSlotField')) $('manualSlotField').hidden = n !== 0;
  $('nativeBindings').hidden = n !== 1; $('dongleBindings').hidden = n !== 2; $('manualSlot').disabled = n !== 0;
  if ($('switchSourceTag')) $('switchSourceTag').textContent = ['手动 / 快捷键', 'Edge Fn 自动跟随', '接收器映射档跟随'][n] || '';
  controls();
}
$('switchSource').onchange = updateSource;
$('manualSlot').onchange = () => { manualTouched = true; };
let releaseUI;
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
function controls() {
  for (const el of $('settings').querySelectorAll('input, select, button')) el.disabled = busy;
  deviceButtons.forEach(id => { if ($(id)) $(id).disabled = !device || busy; });
  $('connect').disabled = !!device || busy || !navigator.hid;
  $('activateSlot').disabled ||= Number($('switchSource').value) !== 0;
  $('manualSlot').disabled = busy || Number($('switchSource').value) !== 0;
  $('export').disabled = $('import').disabled = busy;
  receiverUI?.controls(!!device, busy);
  macroUI?.controls(!!device,busy);
}
async function action(fn) { if (busy) return; busy = true; controls(); try { await fn(); } catch (e) { message(e.message || String(e), true); } finally { busy = false; controls(); refreshConfiguration(); } }
async function receive(id) { if (!device?.opened) throw new Error('请先连接接收器'); return transport.read(id); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let activeSlot = 255;
function currentSlot(n) { activeSlot = n; $('currentSlot').textContent = n < 4 ? `当前配置：${n + 1}${slotNames[n] ? ` · ${slotNames[n]}` : ''}` : '当前配置：关闭'; refreshProfiles(); }
if ($('slotCustomName')) {
  $('slotCustomName').addEventListener('input', () => {
    slotNames[editSlot] = String($('slotCustomName').value || '').trim().slice(0, 16);
    saveSlotNames();
    refreshProfiles();
  });
}
async function command(cmd, value) {
  if (!device?.opened) throw new Error('请先连接接收器');
  const result = await transport.gyro(cmd, value ? cmd === 1 ? encodeConfig(value) : value : []);
  currentSlot(result[45]); const config=decodeConfig(result);
  reportedProfiles[result[44]]=config; return config;
}
async function readAll(followActive = false) {
  const info = decodeProfiles(await receive(PROFILE_REPORT)); renderGlobal(info.settings);
  editSlot = followActive && info.active < 4 ? info.active : info.edit;
  for (let i = 0; i < 4; i++) drafts[i] = await command(6, [i]);
  cleanDrafts = drafts.map(d => ({ ...d })); cleanGlobal = structuredClone(info.settings);
  await command(6, [editSlot]); $('editSlot').value = editSlot; render(drafts[editSlot]); currentSlot(info.active);
}
function onInput(e) { if (e.reportId === 1 && e.data.byteLength >= 63) { usbStick = [e.data.getUint8(2), e.data.getUint8(3)]; const bytes=new Uint8Array(e.data.buffer,e.data.byteOffset,e.data.byteLength); capture.input(bytes); tester.updateInput(bytes); macroUI?.input(bytes); } }
$('connect').onclick = () => action(async () => {
  const candidate=await requestReceiver(navigator.hid);
  if (!candidate) return;
  const reports = candidate.collections.flatMap(c => c.featureReports || []);
  if (![CONFIG_REPORT, STATUS_REPORT, PROFILE_REPORT, DIAGNOSTIC_REPORT].every(id => reports.some(r => r.reportId === id))) throw new Error('请选择接收器，并更新至支持体感配置的固件');
  await candidate.open(); device = candidate; transport = new HidTransport(candidate);
  try {
    reportedProfiles = []; const config = await receive(CONFIG_REPORT); sequence = config[42]; transport.sequence = config[42]; await readAll(true); await receiverUI.load(); await macroUI.load().catch(e=>message(e.message,true)); device.addEventListener('inputreport', onInput);
    $('device').textContent = candidate.productName; $('connectionDot').classList.add('on'); samples = []; usbStick = metrics = null; diagnosticAt = 0; capture.reset();
    $('identityWarning').hidden = candidate.vendorId !== 0x1209 || candidate.productId !== 0x0001;
    try { const version = await transport.read(0xF8, null); $('firmware').textContent = new TextDecoder().decode(version).replace(/\0.*$/s, ''); }
    catch { $('firmware').textContent = '读取失败'; }
    releaseUI.setCurrent($('firmware').textContent);
    $('controllerModel').textContent = candidate.productName; message('连接成功');
  } catch (e) { await close(); throw e; }
});
async function close() {
  await macroUI?.reset();
  await tester?.stop().catch(() => {});
  const previous = device, previousTransport = transport; device = null; transport = null; live = usbStick = metrics = null;
  if (previous) { previous.removeEventListener('inputreport', onInput); if (previousTransport) await previousTransport.close(); else if (previous.opened) await previous.close(); }
  tester?.reset();
  releaseUI?.clearCurrent();
  $('device').textContent = $('firmware').textContent = '未连接'; $('connectionDot').classList.remove('on'); $('active').textContent = '等待输入'; $('currentSlot').textContent = '当前配置：—';
  $('identityWarning').hidden = true;
  $('testProfile').textContent = '配置 — · Edge —';
  ['interval', 'factory', 'calibration', 'stillness', 'stick'].forEach(id => { if ($(id)) $(id).textContent = '—'; }); for (const el of $('liveButtons').children) el.classList.remove('on'); controls();
}
$('disconnect').onclick = () => action(async () => { await close(); message('已断开连接'); });
if (navigator.hid) navigator.hid.addEventListener('disconnect', e => { if (e.device === device) close().then(()=>message('接收器已断开')).catch(err=>message(err.message,true)); });
$('editSlot').onchange = () => action(async () => {
  const next = Number($('editSlot').value);
  try { drafts[editSlot] = formConfig(); if (device) await command(6, [next]); editSlot = next; render(drafts[editSlot]); }
  catch (e) { $('editSlot').value = editSlot; throw e; }
});
$('activateSlot').onclick = () => action(async () => { await command(7, [editSlot]); $('manualSlot').value = editSlot; message(`已切换到配置 ${editSlot + 1}`); });
async function apply(save) {
  drafts[editSlot] = formConfig(); const g = globalConfig(); drafts.forEach(encodeConfig);
  if (save) { for (let i = 0; i < 4; i++) { await command(6, [i]); await command(1, drafts[i]); } await command(6, [editSlot]); }
  else { await command(6, [editSlot]); await command(1, drafts[editSlot]); }
  await command(8, encodeGlobal(g)); if (save) await command(2);
  if (save) cleanDrafts = drafts.map(d => ({ ...d })); else cleanDrafts[editSlot] = { ...drafts[editSlot] };
  cleanGlobal = structuredClone(g);
  manualTouched = false; message(save ? '保存成功' : '已应用');
}
$('settings').onsubmit = e => { e.preventDefault(); action(() => apply(false)); };
$('save').onclick = () => action(() => apply(true));
$('read').onclick = () => action(async () => { await readAll(); message('已读取配置'); });
$('defaults').onclick = () => action(async () => { await command(6, [editSlot]); drafts[editSlot] = await command(4); render(drafts[editSlot]); message('已恢复默认，请保存'); });
$('calibrate').onclick = () => action(async () => { await command(3); message('校准中，请保持手柄静止'); });
if ($('configCalibrate')) $('configCalibrate').onclick = () => $('calibrate').click();
$('clearCalibration').onclick = () => action(async () => { await command(5); message('已清除校准'); });
if ($('copyProfile')) {
  $('copyProfile').onclick = () => {
    const raw = $('copyTarget').value;
    if (raw === '') return message('请先选择要复制到的目标配置档', true);
    const target = Number(raw);
    if (target === editSlot) return message('目标配置与当前编辑配置相同', true);
    try {
      drafts[editSlot] = formConfig();
      drafts[target] = { ...drafts[editSlot] };
      $('copyTarget').value = '';
      refreshConfiguration();
      message(`已将配置 ${editSlot + 1} 复制到配置 ${target + 1}，点击“保存到设备”持久写入`);
    } catch (e) { message(e.message, true); }
  };
}
function preset(ms) { $('output').value = Number($('output').value) || 1; $('activation').value = 1; $('trigger').value = 1; $('hold').value = ms; setMask($('buttons'), 0); syncFieldControls(); refreshConfiguration(); message('已选择预设，请应用'); }
$('presetL2').onclick = () => preset(0); $('presetLong').onclick = () => preset(300);
$('learn').onclick = () => { if (!live || !(live.flags & 1) || !live.buttons) return message('请连接接收器并按住需要设置的按键', true); $('trigger').value = 0; setMask($('buttons'), live.buttons); if ($('buttonPickerDetails')) $('buttonPickerDetails').open = true; syncFieldControls(); refreshConfiguration(); message('已读取按键'); };
function download(name, text, type) { const url = URL.createObjectURL(new Blob([text], { type })), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
$('export').onclick = () => action(async () => { drafts[editSlot] = formConfig(); download('ds5-gyro-config.json', JSON.stringify({ version: 2, profiles: drafts, settings: globalConfig(), slotNames }, null, 2), 'application/json'); });
function renderImportDiff(bundle) {
  pendingImportBundle = bundle;
  drafts[editSlot] = readDraftConfig();
  const diff = diffConfigBundles({ profiles: drafts, settings: globalConfig(), slotNames }, bundle);
  applyImportedBundle(bundle, true);
  if (!$('importDiffCard') || !$('importDiffList')) return;
  const box = $('importDiffList');
  box.replaceChildren();
  for (const s of diff.slotDiffs) {
    const row = document.createElement('div');
    row.className = 'diff-item';
    const title = document.createElement('strong');
    title.textContent = s.name;
    const detail = document.createElement('span');
    detail.textContent = s.changes.length
      ? s.changes.map(c => c.text).join('；')
      : `无参数改动（${s.summaryAfter}）`;
    row.append(title, detail);
    box.append(row);
  }
  if (diff.globalChanged) {
    const row = document.createElement('div');
    row.className = 'diff-item';
    const title = document.createElement('strong');
    title.textContent = '全局切档与快捷键';
    const detail = document.createElement('span');
    detail.textContent = '包含切档来源、默认档位或快捷键组合更新';
    row.append(title, detail);
    box.append(row);
  }
  if ($('importDiffSummaryTag')) $('importDiffSummaryTag').textContent = diff.hasChanges ? `共 ${diff.totalChanges} 处变更` : '与当前草稿一致';
  $('importDiffCard').hidden = false;
}
function applyImportedBundle(bundle, keepDiffOpen = false) {
  if (!bundle) return;
  pushUndoSnapshot();
  drafts = bundle.profiles.map(p => ({ ...p }));
  if (Array.isArray(bundle.slotNames)) {
    slotNames = normalizeSlotNames(bundle.slotNames);
    saveSlotNames();
  }
  renderGlobal(bundle.settings);
  manualTouched = true;
  render(drafts[editSlot]);
  if (!keepDiffOpen && $('importDiffCard')) $('importDiffCard').hidden = true;
  pendingImportBundle = null;
  refreshConfiguration();
  message('已导入配置并展示变更对比，请点击“应用”或“保存到设备”');
}
if ($('importConfirm')) $('importConfirm').onclick = () => { if ($('importDiffCard')) $('importDiffCard').hidden = true; message('已确认保留导入草稿，请点击“应用”或“保存到设备”'); };
if ($('importCancel')) $('importCancel').onclick = () => { if ($('importDiffCard')) $('importDiffCard').hidden = true; if ($('undoProfileBtn') && !$('undoProfileBtn').disabled) $('undoProfileBtn').click(); else message('已关闭导入预览'); };
$('import').onchange = e => action(async () => {
  const file = e.target.files[0]; if (!file) return; if (file.size > 65536) throw new Error('配置文件过大');
  const bundle = importBundle(JSON.parse(await file.text()));
  e.target.value = '';
  renderImportDiff(bundle);
});
if ($('undoProfileBtn')) {
  $('undoProfileBtn').onclick = () => {
    if (!undoSnapshot) return;
    drafts = undoSnapshot.drafts.map(d => ({ ...d }));
    slotNames = normalizeSlotNames(undoSnapshot.slotNames);
    saveSlotNames();
    renderGlobal(undoSnapshot.settings);
    render(drafts[editSlot]);
    undoSnapshot = null;
    $('undoProfileBtn').disabled = true;
    refreshConfiguration();
    message('已恢复到上次套用/导入前的草稿');
  };
}
function initProfileLibrary() {
  if (!$('librarySelect')) return;
  const STORAGE_KEY = 'ds5-gyro-library-v1';
  const defaultLibrary = () => [
    {
      name: 'PC 射击全能（玩家空间 + 精瞄）',
      slotNames: ['常规关闭', '开镜玩家空间', '全程体感 L1暂停', '主机右摇杆'],
      profiles: [
        GYRO_PRESETS[0].build(),
        GYRO_PRESETS.find(p => p.id === 'playerSpacePro').build(),
        GYRO_PRESETS.find(p => p.id === 'alwaysMouse').build(),
        GYRO_PRESETS.find(p => p.id === 'consoleStick').build(),
      ],
      settings: globalDefaults(),
    },
    {
      name: '主机右摇杆多游戏包（Apex / CoD）',
      slotNames: ['Apex 经典', 'Apex 线性', 'CoD 动态', '战地通用'],
      profiles: [0, 1, 2, 4].map(idx => {
        const tpl = STICK_GAME_TEMPLATES[idx];
        return { ...GYRO_PRESETS.find(p => p.id === 'consoleStick').build(), maxTurn: tpl.maxTurn, stickDeadzone: tpl.stickDeadzone, stickPower: tpl.stickPower, blend: tpl.blend, flags: 16 | 32, horizontal: 2 };
      }),
      settings: globalDefaults(),
    },
  ];
  let items = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    items = Array.isArray(parsed) && parsed.length ? parsed : defaultLibrary();
  } catch { items = defaultLibrary(); }
  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch {}
    renderOptions();
  }
  function renderOptions() {
    const sel = $('librarySelect');
    const prev = sel.value;
    sel.replaceChildren(...items.map((item, idx) => new Option(`${item.name}（${(item.slotNames || []).filter(Boolean).join('/') || '4 档'}）`, String(idx))));
    if (prev && Number(prev) < items.length) sel.value = prev;
    if ($('libraryCountTag')) $('libraryCountTag').textContent = `方案库 ${items.length} 套`;
    if ($('libraryDelete')) $('libraryDelete').disabled = items.length <= 1;
  }
  renderOptions();
  if ($('librarySave')) {
    $('librarySave').onclick = () => {
      try {
        drafts[editSlot] = formConfig();
        const name = String($('libraryName')?.value || '').trim() || `自定义方案 ${items.length + 1}`;
        const entry = { name, slotNames: [...slotNames], profiles: drafts.map(d => ({ ...d })), settings: globalConfig() };
        const existingIdx = items.findIndex(x => x.name === name);
        if (existingIdx >= 0) items[existingIdx] = entry;
        else items.push(entry);
        if ($('libraryName')) $('libraryName').value = '';
        persist();
        $('librarySelect').value = String(existingIdx >= 0 ? existingIdx : items.length - 1);
        message(`已将当前 4 档保存为方案“${name}”`);
      } catch (e) { message(e.message, true); }
    };
  }
  if ($('libraryApplySlot')) {
    $('libraryApplySlot').onclick = () => {
      const item = items[Number($('librarySelect').value)];
      if (!item?.profiles?.[editSlot]) return;
      pushUndoSnapshot();
      drafts[editSlot] = { ...item.profiles[editSlot] };
      if (item.slotNames?.[editSlot]) { slotNames[editSlot] = item.slotNames[editSlot]; saveSlotNames(); }
      render(drafts[editSlot]);
      refreshConfiguration();
      message(`已将方案“${item.name}”的第 ${editSlot + 1} 档载入到当前编辑档`);
    };
  }
  if ($('libraryApplyAll')) {
    $('libraryApplyAll').onclick = () => {
      const item = items[Number($('librarySelect').value)];
      if (!item?.profiles) return;
      pushUndoSnapshot();
      drafts = item.profiles.map(p => ({ ...p }));
      if (Array.isArray(item.slotNames)) { slotNames = normalizeSlotNames(item.slotNames); saveSlotNames(); }
      if (item.settings) renderGlobal(item.settings);
      render(drafts[editSlot]);
      refreshConfiguration();
      message(`已载入整套方案“${item.name}”`);
    };
  }
  if ($('libraryDelete')) {
    $('libraryDelete').onclick = () => {
      if (items.length <= 1) return;
      const idx = Number($('librarySelect').value);
      const removed = items.splice(idx, 1)[0];
      persist();
      message(`已删除方案“${removed?.name || ''}”`);
    };
  }
}
initProfileLibrary();
$('csv').onclick = () => { const rows = ['time_ms,dt_us,flags,pitch_dps,yaw_dps,roll_dps,filtered_x_dps,filtered_y_dps,stick_x,stick_y,buttons,edge_profile,dongle_profile', ...samples.map(s => [s.time, s.dt, s.flags, ...s.rates, ...s.filtered, ...s.stick, s.buttons, s.edgeProfile, s.dongleProfile].join(','))]; download('ds5-gyro-debug.csv', rows.join('\n'), 'text/csv'); };
$('exportDiagnostics').onclick = () => { if (!metrics) return message('暂无诊断数据', true); download('ds5-gyro-diagnostics.json', JSON.stringify({ version: 3, firmware: $('firmware').textContent, time: new Date().toISOString(), metrics, reportedProfiles, featureSamples:samples, receiverTrace:macroUI?.snapshot(), capture:capture.snapshot() }), 'application/json'); };
function draw() {
  const canvas = $('chart'), ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h); const history = samples.slice(-180), scale = Math.max(30, ...history.flatMap(s => s.rates.map(Math.abs)));
  ctx.strokeStyle = '#e1e1e6'; ctx.lineWidth = 1; for (let y = 25; y < h; y += 45) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  ctx.fillStyle = '#6e6e73'; ctx.font = '12px system-ui'; ctx.fillText(`±${Math.ceil(scale)} °/s`, 10, 17);
  ['#2671d9', '#258354', '#ae6418'].forEach((color, axis) => { ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); history.forEach((s, i) => { const x = i / 179 * w, y = h / 2 - s.rates[axis] / scale * (h / 2 - 25); if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke(); });
}
function renderLive(s) {
  $('testProfile').textContent = `配置 ${metrics ? metrics.active < 4 ? formatSlotTitle(metrics.active, slotNames[metrics.active]) : '关闭' : '—'} · Edge ${s.edgeProfile || '—'}`;
  $('active').textContent = !(s.flags & 1) ? '等待输入' : s.flags & 4 ? '校准中' : s.flags & 2 ? '体感已开启' : '体感已关闭';
  $('interval').textContent = s.dt ? `${(s.dt / 1000).toFixed(2)} ms` : '—'; $('factory').textContent = s.flags & 16 ? '已应用' : '标称值';
  $('calibration').textContent = s.flags & 4 ? `${s.progress}%` : s.flags & 32 ? '校准超时' : s.flags & 8 ? '已校准' : s.flags & 128 ? '自动已收敛' : '未校准';
  if ($('stillness')) $('stillness').textContent = !(s.flags & 1) ? '—' : (s.flags & 64) ? ((s.flags & 128) ? '静止 · 自动跟踪' : '静止锁定') : '运动中';
  $('stick').textContent = usbStick ? usbStick.join(' / ') : '等待输入'; $('rates').textContent = s.rates.map(n => n.toFixed(2)).join(' / ');
  for (const el of $('liveButtons').children) el.classList.toggle('on', !!(s.buttons & (1 << el.dataset.bit)));
  $('raw').textContent = `陀螺仪: ${s.raw.join(', ')}\n加速度: ${s.accel.join(', ')}\n零偏 °/s: ${s.bias.join(', ')}\n映射 °/s: ${s.filtered.join(', ')}\n鼠标待发: ${s.pending.join(', ')}\nEdge 档位: ${s.edgeProfile || '—'}\n接收器档位: ${s.dongleProfile + 1}\n报告: ${s.packets} · 校准样本: ${s.samples}`;
  if (s.flags & 1) { samples.push({ ...s, time: Date.now() }); if (samples.length > 600) samples.shift(); } draw();
}
function stopReplay() {
  if (replayTimer) { clearInterval(replayTimer); replayTimer = null; }
  if ($('replayStop')) $('replayStop').hidden = true;
  if ($('replayStatus')) $('replayStatus').textContent = '待命';
}
if ($('replayStop')) $('replayStop').onclick = () => { stopReplay(); message('已停止诊断回放'); };
if ($('replayFile')) {
  $('replayFile').onchange = e => action(async () => {
    const file = e.target.files[0]; if (!file) return;
    stopReplay();
    const doc = JSON.parse(await file.text());
    e.target.value = '';
    const frames = Array.isArray(doc?.featureSamples) && doc.featureSamples.length ? doc.featureSamples : null;
    if (!frames) throw new Error('该诊断文件不包含可回放的传感器采样记录');
    samples = [];
    let idx = 0;
    if ($('replayStop')) $('replayStop').hidden = false;
    if ($('replayStatus')) $('replayStatus').textContent = `回放中 1/${frames.length}`;
    message(`开始离线回放诊断记录（共 ${frames.length} 帧）`);
    replayTimer = setInterval(() => {
      if (idx >= frames.length) {
        stopReplay();
        if ($('replayStatus')) $('replayStatus').textContent = `回放完成 (${frames.length} 帧)`;
        return;
      }
      const f = frames[idx++];
      if (f && Array.isArray(f.rates)) {
        usbStick = Array.isArray(f.stick) ? f.stick : [128, 128];
        renderLive({
          flags: f.flags ?? 1,
          progress: f.progress ?? 0,
          dt: f.dt ?? 2000,
          raw: f.raw || [0, 0, 0],
          accel: f.accel || [0, 8192, 0],
          rates: f.rates,
          filtered: f.filtered || [0, 0],
          stick: usbStick,
          pending: f.pending || [0, 0],
          buttons: f.buttons ?? 0,
          samples: f.samples ?? 0,
          bias: f.bias || [0, 0, 0],
          packets: f.packets ?? idx,
          edgeProfile: f.edgeProfile ?? 0,
          dongleProfile: f.dongleProfile ?? 0,
        });
      }
      if ($('replayStatus')) $('replayStatus').textContent = `回放中 ${idx}/${frames.length}`;
    }, 50);
  });
}
function renderMetrics(m) {
  currentSlot(m.active);
  if (!manualTouched && Number($('switchSource').value) === 0 && m.active < 4) $('manualSlot').value = m.active;
  $('diagnostics').textContent = `接收报告: ${m.inputs}\n接收间隔 min / avg / max: ${m.intervalMin} / ${m.intervalMean} / ${m.intervalMax} µs\n间隔分布 <2 / <5 / <10 / <20 / ≥20 ms: ${m.buckets.join(' / ')}\n体感处理 当前 / 最大: ${m.processLast} / ${m.processMax} µs\n超过 50ms 的间隔: ${m.gaps}\n鼠标发送忙: ${m.usbBusy}\n配置队列峰值 / 丢弃: ${m.queuePeak} / ${m.queueDrops}\n保存次数: ${m.saves}\nFlash 当前 / 最大: ${m.flashLast} / ${m.flashMax} µs\n最近保存: ${['—', '成功', '失败'][m.saveResult] || '—'}`;
}
async function poll() {
  if (device && !busy) {
    const current = device;
    try {
      const data = await receive(STATUS_REPORT); if (device === current) { live = decodeStatus(data); renderLive(live); }
      if (device === current && !busy && performance.now() - diagnosticAt >= 1000) { diagnosticAt = performance.now(); const data = await receive(DIAGNOSTIC_REPORT); if (device === current) { metrics = decodeDiagnostics(data); renderMetrics(metrics); } }
    } catch (e) { if (device === current) message(`读取失败：${e.message}`, true); }
  }
  await macroUI?.poll();
  setTimeout(poll, 100);
}
const routes = ['receiver', 'remap', 'macros', 'config', 'tester', 'update'];
function route() {
  const target=location.hash.slice(1);
  const active=routes.includes(target)?target:'tester';
  if(active!=='macros')macroUI?.leave().catch(e=>message(e.message,true));
  for(const name of routes) $(name).hidden=name!==active;
  for(const link of document.querySelectorAll('.site-nav a')){if(link.hash===`#${active}`)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}
  $(active==='tester'?'testConnection':'connectionHome').append($('connectionPanel'));
  const legacy={stickTests:'input',sensorTests:'sense',outputTests:'rumble',rateTests:'device'};
  if(legacy[target])tester.selectTab(legacy[target]);
  window.scrollTo(0,0);
}
function enforceBoundCoherence(changedId) {
  if (changedId === 'sx' && $('syncXY')?.checked) $('sy').value = $('sx').value;
  if (changedId === 'syncXY' && $('syncXY')?.checked) $('sy').value = $('sx').value;
  if (changedId === 'threshold' && Number($('releaseThreshold').value) > Number($('threshold').value)) {
    $('releaseThreshold').value = $('threshold').value;
  } else if (changedId === 'releaseThreshold' && Number($('releaseThreshold').value) > Number($('threshold').value)) {
    $('threshold').value = $('releaseThreshold').value;
  } else if (changedId === 'accelStart' && Number($('accelStart').value) >= Number($('accelEnd').value)) {
    $('accelEnd').value = Math.min(2000, Number($('accelStart').value) + 1);
  } else if (changedId === 'accelEnd' && Number($('accelEnd').value) <= Number($('accelStart').value)) {
    $('accelStart').value = Math.max(0, Number($('accelEnd').value) - 1);
  }
  syncFieldControls();
}
function refreshProfiles(){
 if(!$('profileStrip'))return;
 const inactive=!!device&&activeSlot<4&&editSlot!==activeSlot;
 $('editNotice').hidden=!inactive;
 $('editNotice').textContent=inactive?`正在编辑 ${formatSlotTitle(editSlot, slotNames[editSlot])}，当前生效为 ${formatSlotTitle(activeSlot, slotNames[activeSlot])}；此处修改作用于编辑档。`:'';
 const chips=$('profileStrip').children;
 const curDraft=readDraftConfig();
 for(let i=0;i<4;i++){
  const label=formatSlotTitle(i,slotNames[i]);
  if($('editSlot')?.options[i])$('editSlot').options[i].textContent=label;
  if($('manualSlot')?.options[i])$('manualSlot').options[i].textContent=label;
  if($('copyTarget')?.options[i+1])$('copyTarget').options[i+1].textContent=label;
  const chip=chips[i];if(!chip)continue;
  const titleEl=chip.querySelector('strong');if(titleEl)titleEl.textContent=label;
  const cfg=i===editSlot?curDraft:drafts[i];
  const dirty=!configsMatch(cfg,cleanDrafts[i]);
  chip.classList.toggle('active',i===activeSlot);chip.classList.toggle('editing',i===editSlot);chip.classList.toggle('dirty',dirty);chip.disabled=busy;
  const gate=cfg.activation===0?'始终':cfg.trigger===1?'L2':cfg.trigger===2?'R2':'按键';
  chip.querySelector('span').textContent=cfg.output===0?'已关闭':`${OUTPUT_NAMES[cfg.output]} · ${gate} · ${Number(cfg.sx).toFixed(1).replace(/\.0$/,'')}x${dirty?' *':''}`;
 }
}
function updateConfigVisibility(c){
 const vis=getConfigVisibility(c);
 fieldWrappers.horizontal.hidden=!vis.active;
 fieldWrappers.activation.hidden=!vis.active;
 fieldWrappers.trigger.hidden=!vis.usesGate;
 fieldWrappers.threshold.hidden=!vis.usesThreshold;
 fieldWrappers.releaseThreshold.hidden=!vis.usesThreshold;
 fieldWrappers.hold.hidden=!vis.usesHold;
 fieldWrappers.mouseCpd.hidden=!vis.isMouse;
 fieldWrappers.adsMultiplier.hidden=!vis.active;
 fieldWrappers.sy.hidden=!vis.active||!!$('syncXY')?.checked;
 if(fieldLabels.sx)fieldLabels.sx.textContent=$('syncXY')?.checked?'灵敏度 · 倍（X = Y）':'水平灵敏度 · 倍';
 if(fieldLabels.threshold)fieldLabels.threshold.textContent=vis.usesTriggerGate?'扳机阈值 · 1–255':'L2 瞄准触发阈值 · 1–255';
 fieldWrappers.noise.hidden=!vis.active;
 fieldWrappers.smooth.hidden=!vis.active;
 fieldWrappers.accel.hidden=!vis.active;
 fieldWrappers.accelStart.hidden=!vis.usesAccelRange;
 fieldWrappers.accelEnd.hidden=!vis.usesAccelRange;
 $('axisHelp').hidden=!vis.active;
 $('gyroGateBlock').hidden=!vis.usesGate;
 $('gyroFlagChecks').hidden=!vis.active;
 if($('suppressWrap'))$('suppressWrap').hidden=!vis.usesGate||!vis.selectedButtonCount;
 if($('allButtonsWrap'))$('allButtonsWrap').hidden=!vis.usesAllButtons;
 $('gyroSensitivityCard').hidden=!vis.active;
 $('gyroStickCard').hidden=!vis.isStick;
 $('gyroAdvancedDetails').hidden=!vis.active;
 $('gyroCurveDetails').hidden=!vis.active;
 if($('selectedButtonsTag')){
  const picked=buttonNames.filter((_,bit)=>c.buttons&(1<<bit));
  $('selectedButtonsTag').textContent=picked.length?'已选：'+picked.join(' + '):'未选附加按键';
 }
 if($('advancedSummaryTag'))$('advancedSummaryTag').textContent=vis.active?`死区 ${c.noise}°/s · 平滑 ${c.smooth}ms${vis.usesAccelRange?` · 加速 ${c.accel}x`:''}`:'已停用';
 if($('shortcutCountTag'))$('shortcutCountTag').textContent=`已启用 ${shortcutRows.filter(r=>Number(r.inputs.action.value)!==0).length}/4`;
 if($('gyroPresets'))for(const btn of $('gyroPresets').children){const p=GYRO_PRESETS.find(x=>x.id===btn.dataset.preset);btn.classList.toggle('active',!!p&&configsMatch(c,p.build()));}
 if($('configDirty')){
  let dirty=false;
  for(let i=0;i<4;i++)if(!configsMatch(i===editSlot?c:drafts[i],cleanDrafts[i]))dirty=true;
  try{if(!globalsMatch(globalConfig(),cleanGlobal))dirty=true;}catch{dirty=true;}
  $('configDirty').hidden=!dirty;
 }
}
function refreshConfiguration(event){
 enforceBoundCoherence(event?.target?.id);
 const cur=readDraftConfig();
 updateConfigVisibility(cur);
 refreshProfiles();
 if($('configRuleSummary')){
  try{
   encodeConfig(cur);
   $('configRuleSummary').textContent=`当前规则：${summarizeGyroConfig(cur)}`;
   $('configRuleSummary').classList.remove('warn');
  }catch(e){
   $('configRuleSummary').textContent=`参数待完善：${e.message}`;
   $('configRuleSummary').classList.add('warn');
  }
 }
 if($('compatResult')){
  const compat=evaluateCompatibilityMode({
   outputMode:cur.output,
   gameNativeGyro:Number($('compatGameGyro')?.value||0)===1,
   hostMapper:$('compatHostMapper')?.value||'none',
  });
  $('compatResult').textContent=`${compat.title}：${compat.detail} ${compat.recommendation}`;
  $('compatResult').classList.toggle('warn',compat.status!=='ok');
  if($('compatStatusTag'))$('compatStatusTag').textContent=compat.status==='ok'?'无冲突':compat.status==='warn'?'需注意':'存在叠加冲突';
 }
 if(!$('mappingCurve'))return;
 const hMode=Number($('horizontal').value);
 $('axisHelp').textContent=hMode===2
  ?'玩家空间（推荐）：结合三轴加速度计实时估计重力方向，无论握持俯仰角如何倾斜，水平转手腕都严格对应屏幕水平转向，彻底消除斜握串轴。'
  :hMode===0
   ?'Yaw：手柄平放时像转盘一样左右平转；左右侧倾主要落在 Roll。'
   :'Roll：像方向盘一样左右侧倾，两侧一高一低；方向相反时使用“水平反转”。';
 try{
  const c=formConfig(),canvas=$('mappingCurve'),ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height,pad=48,max=Number($('curveMax').value),fn=c.output===2?stickPosition:mouseSpeed;
  const yMax=c.output===2?1:Math.max(1,fn(c,max,'x'),fn(c,max,'y'),fn(c,max,'x',true),fn(c,max,'y',true));
  ctx.clearRect(0,0,w,h);ctx.font='12px system-ui';ctx.lineWidth=1;ctx.strokeStyle='#cddce3';ctx.fillStyle='#82919a';
  for(let i=0;i<=4;i++){const y=h-pad-(h-pad*2)*i/4;ctx.beginPath();ctx.moveTo(pad,y);ctx.lineTo(w-18,y);ctx.stroke();ctx.fillText((yMax*i/4).toFixed(c.output===2?2:0),4,y+4);const x=pad+(w-pad-18)*i/4;ctx.fillText(String(max*i/4),x-10,h-15);}
  for(const [axis,color] of [['x','#087f70'],['y','#d29a43']])for(const ads of [false,true]){ctx.strokeStyle=color;ctx.lineWidth=ads?1.5:2.5;ctx.setLineDash(ads?[5,5]:[]);ctx.beginPath();for(let i=0;i<=150;i++){const x=pad+i/150*(w-pad-18),y=h-pad-fn(c,max*i/150,axis,ads)/yMax*(h-pad*2);i?ctx.lineTo(x,y):ctx.moveTo(x,y);}ctx.stroke();}ctx.setLineDash([]);
  $('curveUnits').textContent=c.output===2?'右摇杆归一化幅度':'鼠标 counts/s';
  const speed=Number($('curveSpeed').value);$('curveSpeedLabel').textContent=speed+' °/s';$('curveOutput').textContent=c.output===2?(fn(c,speed)*100).toFixed(1)+'% 满杆':fn(c,speed).toFixed(0)+' counts/s';
 }catch(e){$('curveOutput').textContent='请检查参数';}
}
macroUI=initMacroUI({transport:()=>transport,action,message,download,getLive:()=>live});
receiverUI=initReceiverUI({transport:()=>transport,action,message,download});
tester=initTester({getDevice:()=>device,sendOutput:p=>transport.run(()=>device.sendReport(2,p)),message,onRender:frame=>{if(device?.opened)capture.frame(frame);},getStickConfig:()=>reportedProfiles[activeSlot]||defaults()});
const flasher=initFlasher();
releaseUI=initReleases({loadPackage:flasher.load,notify:text=>message(text)});
initBootManager({enterManager:async()=>{
 if(!device?.opened)throw new Error('请先连接体感接收器；运行上游原版时请用上电按键进入管理器');
 try{await transport.legacy(0xF6,4);}catch{throw new Error('当前固件或设备未提供软件进入入口；请使用上电按键。单固件设备无需此操作。');}
}});
initDualFirmware();
for(let i=0;i<4;i++){const button=document.createElement('button');button.className='profile-chip';button.type='button';const title=document.createElement('strong');title.textContent='配置 '+(i+1);button.append(title,document.createElement('span'));button.onclick=()=>{ $('editSlot').value=i;$('editSlot').dispatchEvent(new Event('change'));};$('profileStrip').append(button);}
$('settings').addEventListener('input',refreshConfiguration);$('settings').addEventListener('change',refreshConfiguration);$('curveSpeed').oninput=$('curveMax').onchange=refreshConfiguration;
$('curveExport').onclick=()=>{try{const c=formConfig(),rows=['hand_dps,mouse_x_counts_s,mouse_y_counts_s,stick_x,stick_y,mouse_x_ads,stick_x_ads'];for(let s=0;s<=Number($('curveMax').value);s++)rows.push([s,mouseSpeed(c,s,'x'),mouseSpeed(c,s,'y'),stickPosition(c,s,'x'),stickPosition(c,s,'y'),mouseSpeed(c,s,'x',true),stickPosition(c,s,'x',true)].join(','));download('ds5-mapping-curve.csv',rows.join('\n'),'text/csv');}catch(e){message(e.message,true);}};
window.addEventListener('controller-button-picked',e=>{const bit=e.detail;if(bit<=18){const all=$('remapFilter')?.querySelector('[data-filter="all"]');if(all)all.click();location.hash='#remap';$('remapRows').children[bit]?.querySelector('select')?.focus();}else{location.hash='#config';if($('buttonPickerDetails'))$('buttonPickerDetails').open=true;$('buttons').querySelector(`[data-bit="${bit}"]`)?.focus();}});
function themeLabel(){const dark=document.documentElement.dataset.theme==='dark';$('themeToggle').textContent=dark?'浅色':'深色';$('themeToggle').setAttribute('aria-label',dark?'切换浅色外观':'切换深色外观');}
try{if(localStorage.getItem('ds5-theme')==='dark')document.documentElement.dataset.theme='dark';}catch{}
themeLabel();
$('themeToggle').onclick=()=>{const dark=document.documentElement.dataset.theme!=='dark';document.documentElement.dataset.theme=dark?'dark':'light';themeLabel();try{localStorage.setItem('ds5-theme',dark?'dark':'light');}catch{}};
window.addEventListener('hashchange',route);
for(const link of document.querySelectorAll('.site-nav a, a.brand')){
 link.addEventListener('click',()=>{setTimeout(route,0);});
}
cleanDrafts=drafts.map(d=>({...d}));cleanGlobal=globalDefaults();
render(defaults()); renderGlobal(globalDefaults()); controls(); draw(); poll(); route(); initMouseTest(); refreshConfiguration();

initLocalApp({beforeQuit:async()=>{await close();},message});

if (!navigator.hid) message(location.protocol==='file:'?'请通过双击启动器打开网页，不能直接打开 HTML 文件。':'当前浏览器不支持 WebHID，请使用桌面 Chrome / Edge。',true);

window.addEventListener('load',()=>{if(routes.includes(location.hash.slice(1)))window.scrollTo(0,0);});
