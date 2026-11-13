import { CONFIG_REPORT, STATUS_REPORT, PROFILE_REPORT, DIAGNOSTIC_REPORT, REPORT_SIZE, buttonNames, fields, defaults, encodeConfig, decodeConfig, featureBytes, decodeStatus, globalDefaults, encodeGlobal, decodeProfiles, decodeDiagnostics, importBundle } from './protocol.mjs';

const $ = id => document.getElementById(id);
let device, busy = false, sequence = 0, live, samples = [], usbStick, metrics, diagnosticAt = 0, editSlot = 0, manualTouched = false;
let drafts = Array.from({ length: 4 }, defaults);
const deviceButtons = ['apply', 'save', 'read', 'defaults', 'calibrate', 'clearCalibration', 'disconnect', 'activateSlot'];
const actionNames = ['未设置', '下一配置', '上一配置', '指定配置', '体感开关', '静止校准', '按住精瞄'];
function select(options) { const el = document.createElement('select'); options.forEach(([value, text]) => el.add(new Option(text, value))); return el; }
function field(label, input) { const row = document.createElement('div'); row.className = 'field'; const text = document.createElement('label'); text.htmlFor = input.id; text.textContent = label; row.append(text, input); return row; }
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
  $(f.group + 'Fields').append(field(f.label, input));
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
  learn.onclick = () => { if (!live || !(live.flags & 1) || !live.buttons) return message('请按住需要设置的按键', true); setMask(mask, live.buttons); update(); };
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
function render(c) {
  fields.forEach(f => { $(f.id).value = c[f.id]; }); setMask($('buttons'), c.buttons);
  ['invertX', 'invertY', 'suppress', 'allButtons'].forEach((id, bit) => { $(id).checked = !!(c.flags & (1 << bit)); }); profileChoices(c.profiles);
}
function formConfig() {
  const c = Object.fromEntries(fields.map(f => [f.id, Number($(f.id).value)]));
  c.flags = ['invertX', 'invertY', 'suppress', 'allButtons'].reduce((m, id, bit) => m | ($(id).checked ? 1 << bit : 0), 0);
  c.buttons = readMask($('buttons')); c.profiles = c.profileSource ? [...$('profiles').querySelectorAll('input:checked')].reduce((m, e) => m | (1 << e.dataset.profile), 0) : 0;
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
function updateSource() { const n = Number($('switchSource').value); $('nativeBindings').hidden = n !== 1; $('dongleBindings').hidden = n !== 2; $('manualSlot').disabled = n !== 0; controls(); }
$('switchSource').onchange = updateSource;
$('manualSlot').onchange = () => { manualTouched = true; };
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
function controls() {
  for (const el of $('settings').querySelectorAll('input, select, button')) el.disabled = busy;
  deviceButtons.forEach(id => { $(id).disabled = !device || busy; });
  $('connect').disabled = !!device || busy || !navigator.hid;
  $('activateSlot').disabled ||= Number($('switchSource').value) !== 0;
  $('manualSlot').disabled = busy || Number($('switchSource').value) !== 0;
  $('export').disabled = $('import').disabled = busy;
}
async function action(fn) { if (busy) return; busy = true; controls(); try { await fn(); } catch (e) { message(e.message || String(e), true); } finally { busy = false; controls(); } }
async function receive(id) { if (!device?.opened) throw new Error('请先连接接收器'); return featureBytes(await device.receiveFeatureReport(id), id); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function currentSlot(n) { $('currentSlot').textContent = n < 4 ? `当前配置：${n + 1}` : '当前配置：关闭'; }
async function command(cmd, value) {
  if (!device?.opened) throw new Error('请先连接接收器');
  const payload = new Uint8Array(REPORT_SIZE); sequence = sequence % 255 + 1; payload[0] = cmd; payload[1] = sequence;
  if (value) payload.set(cmd === 1 ? encodeConfig(value) : value, 2);
  await device.sendFeatureReport(CONFIG_REPORT, payload);
  const deadline = performance.now() + 2500;
  while (performance.now() < deadline) {
    await delay(30); const result = await receive(CONFIG_REPORT);
    if (result[40] !== cmd || result[42] !== sequence) continue;
    if (result[41]) throw new Error(result[41] === 2 ? '保存失败，当前设置仍生效' : '设置无效，请检查参数');
    currentSlot(result[45]); return decodeConfig(result);
  }
  throw new Error('操作超时，请重新读取配置');
}
async function readAll() {
  const info = decodeProfiles(await receive(PROFILE_REPORT)); renderGlobal(info.settings); editSlot = info.edit;
  for (let i = 0; i < 4; i++) drafts[i] = await command(6, [i]);
  await command(6, [editSlot]); $('editSlot').value = editSlot; render(drafts[editSlot]); currentSlot(info.active);
}
function onInput(e) { if (e.reportId === 1 && e.data.byteLength >= 63) usbStick = [e.data.getUint8(2), e.data.getUint8(3)]; }
$('connect').onclick = () => action(async () => {
  const chosen = await navigator.hid.requestDevice({ filters: [{ vendorId: 0x054C, productId: 0x0CE6, usagePage: 1, usage: 5 }, { vendorId: 0x054C, productId: 0x0DF2, usagePage: 1, usage: 5 }] });
  if (!chosen.length) return;
  const candidate = chosen[0], reports = candidate.collections.flatMap(c => c.featureReports || []);
  if (![CONFIG_REPORT, STATUS_REPORT, PROFILE_REPORT, DIAGNOSTIC_REPORT].every(id => reports.some(r => r.reportId === id))) throw new Error('请选择接收器，并更新至支持体感配置的固件');
  await candidate.open(); device = candidate;
  try {
    const config = await receive(CONFIG_REPORT); sequence = config[42]; await readAll(); device.addEventListener('inputreport', onInput);
    $('device').textContent = candidate.productName; $('connectionDot').classList.add('on'); samples = []; usbStick = metrics = null; diagnosticAt = 0;
    try { const version = await device.receiveFeatureReport(0xF8); const bytes = new Uint8Array(version.buffer, version.byteOffset, version.byteLength); $('firmware').textContent = new TextDecoder().decode(bytes.subarray(bytes[0] === 0xF8 ? 1 : 0)).replace(/\0.*$/s, ''); }
    catch { $('firmware').textContent = '读取失败'; }
    message('连接成功');
  } catch (e) { await close(); throw e; }
});
async function close() {
  const previous = device; device = null; live = usbStick = metrics = null;
  if (previous) { previous.removeEventListener('inputreport', onInput); if (previous.opened) await previous.close(); }
  $('device').textContent = $('firmware').textContent = '未连接'; $('connectionDot').classList.remove('on'); $('active').textContent = '等待输入'; $('currentSlot').textContent = '当前配置：—';
  ['interval', 'factory', 'calibration', 'stick'].forEach(id => { $(id).textContent = '—'; }); for (const el of $('liveButtons').children) el.classList.remove('on'); controls();
}
$('disconnect').onclick = () => action(async () => { await close(); message('已断开连接'); });
if (navigator.hid) navigator.hid.addEventListener('disconnect', e => { if (e.device === device) action(async () => { await close(); message('接收器已断开'); }); });
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
  await command(8, encodeGlobal(g)); if (save) await command(2); manualTouched = false; message(save ? '保存成功' : '已应用');
}
$('settings').onsubmit = e => { e.preventDefault(); action(() => apply(false)); };
$('save').onclick = () => action(() => apply(true));
$('read').onclick = () => action(async () => { await readAll(); message('已读取配置'); });
$('defaults').onclick = () => action(async () => { await command(6, [editSlot]); drafts[editSlot] = await command(4); render(drafts[editSlot]); message('已恢复默认，请保存'); });
$('calibrate').onclick = () => action(async () => { await command(3); message('校准中，请保持手柄静止'); });
$('clearCalibration').onclick = () => action(async () => { await command(5); message('已清除校准'); });
function preset(ms) { $('output').value = Number($('output').value) || 1; $('activation').value = 1; $('trigger').value = 1; $('hold').value = ms; setMask($('buttons'), 0); message('已选择预设，请应用'); }
$('presetL2').onclick = () => preset(0); $('presetLong').onclick = () => preset(300);
$('learn').onclick = () => { if (!live || !(live.flags & 1) || !live.buttons) return message('请连接接收器并按住需要设置的按键', true); $('trigger').value = 0; setMask($('buttons'), live.buttons); message('已读取按键'); };
function download(name, text, type) { const url = URL.createObjectURL(new Blob([text], { type })), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
$('export').onclick = () => action(async () => { drafts[editSlot] = formConfig(); download('ds5-gyro-config.json', JSON.stringify({ version: 2, profiles: drafts, settings: globalConfig() }, null, 2), 'application/json'); });
$('import').onchange = e => action(async () => {
  const file = e.target.files[0]; if (!file) return; if (file.size > 65536) throw new Error('配置文件过大');
  const bundle = importBundle(JSON.parse(await file.text())); drafts = bundle.profiles; renderGlobal(bundle.settings); manualTouched = true; render(drafts[editSlot]); e.target.value = ''; message('已导入配置，请保存到设备');
});
$('csv').onclick = () => { const rows = ['time_ms,dt_us,flags,pitch_dps,yaw_dps,roll_dps,filtered_x_dps,filtered_y_dps,stick_x,stick_y,buttons,edge_profile,dongle_profile', ...samples.map(s => [s.time, s.dt, s.flags, ...s.rates, ...s.filtered, ...s.stick, s.buttons, s.edgeProfile, s.dongleProfile].join(','))]; download('ds5-gyro-debug.csv', rows.join('\n'), 'text/csv'); };
$('exportDiagnostics').onclick = () => { if (!metrics) return message('暂无诊断数据', true); download('ds5-gyro-diagnostics.json', JSON.stringify({ version: 2, firmware: $('firmware').textContent, time: new Date().toISOString(), metrics }, null, 2), 'application/json'); };
function draw() {
  const canvas = $('chart'), ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h); const history = samples.slice(-180), scale = Math.max(30, ...history.flatMap(s => s.rates.map(Math.abs)));
  ctx.strokeStyle = '#e1e1e6'; ctx.lineWidth = 1; for (let y = 25; y < h; y += 45) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  ctx.fillStyle = '#6e6e73'; ctx.font = '12px system-ui'; ctx.fillText(`±${Math.ceil(scale)} °/s`, 10, 17);
  ['#2671d9', '#258354', '#ae6418'].forEach((color, axis) => { ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); history.forEach((s, i) => { const x = i / 179 * w, y = h / 2 - s.rates[axis] / scale * (h / 2 - 25); if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke(); });
}
function renderLive(s) {
  $('active').textContent = !(s.flags & 1) ? '等待输入' : s.flags & 4 ? '校准中' : s.flags & 2 ? '体感已开启' : '体感已关闭';
  $('interval').textContent = s.dt ? `${(s.dt / 1000).toFixed(2)} ms` : '—'; $('factory').textContent = s.flags & 16 ? '已应用' : '标称值';
  $('calibration').textContent = s.flags & 4 ? `${s.progress}%` : s.flags & 32 ? '校准超时' : s.flags & 8 ? '已校准' : '未校准'; $('stick').textContent = usbStick ? usbStick.join(' / ') : '等待输入'; $('rates').textContent = s.rates.map(n => n.toFixed(2)).join(' / ');
  for (const el of $('liveButtons').children) el.classList.toggle('on', !!(s.buttons & (1 << el.dataset.bit)));
  $('raw').textContent = `陀螺仪: ${s.raw.join(', ')}\n加速度: ${s.accel.join(', ')}\n零偏 °/s: ${s.bias.join(', ')}\n映射 °/s: ${s.filtered.join(', ')}\n鼠标待发: ${s.pending.join(', ')}\nEdge 档位: ${s.edgeProfile || '—'}\n接收器档位: ${s.dongleProfile + 1}\n报告: ${s.packets} · 校准样本: ${s.samples}`;
  if (s.flags & 1) { samples.push({ ...s, time: Date.now() }); if (samples.length > 600) samples.shift(); } draw();
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
  setTimeout(poll, 100);
}
function route() { const active = ['config', 'tester', 'update'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'config'; for (const name of ['config', 'tester', 'update']) $(name).hidden = name !== active; for (const link of document.querySelectorAll('nav a')) { if (link.hash === `#${active}`) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); } }
window.addEventListener('hashchange', route);
render(defaults()); renderGlobal(globalDefaults()); controls(); draw(); poll(); route();
if (!navigator.hid) message('当前浏览器不支持，请使用 Chrome 或 Edge', true);
