import { CONFIG_REPORT, STATUS_REPORT, REPORT_SIZE, buttonNames, fields, defaults, encodeConfig, decodeConfig, featureBytes, decodeStatus } from './protocol.mjs';

const $ = id => document.getElementById(id);
let device, busy = false, sequence = 0, live, samples = [], usbStick;
const deviceButtons = ['apply', 'save', 'read', 'defaults', 'calibrate', 'clearCalibration', 'disconnect'];

for (const f of fields) {
  const row = document.createElement('div'); row.className = 'field';
  const label = document.createElement('label'); label.htmlFor = f.id; label.textContent = f.label;
  const input = document.createElement(f.options ? 'select' : 'input'); input.id = f.id;
  if (f.options) f.options.forEach((name, value) => input.add(new Option(name, value)));
  else { input.type = 'number'; input.min = f.min; input.max = f.max; input.step = f.step || 1; input.required = true; }
  row.append(label, input); $(f.group + 'Fields').append(row);
}
buttonNames.forEach((name, i) => {
  const label = document.createElement('label'); label.className = 'button-choice';
  const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.bit = i;
  label.append(input, document.createTextNode(name)); $('buttons').append(label);
  const indicator = document.createElement('span'); indicator.textContent = name; indicator.dataset.bit = i;
  $('liveButtons').append(indicator);
});

function profileChoices(mask = 0) {
  const source = Number($('profileSource').value), box = $('profiles');
  box.replaceChildren(); box.hidden = !source;
  const names = source === 1 ? ['Fn + △ · 默认', 'Fn + □', 'Fn + ×', 'Fn + ○'] : ['接收器档 1 · Create + ←', '接收器档 2 · Create + →'];
  names.forEach((name, i) => {
    const label = document.createElement('label'); label.className = 'button-choice';
    const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.profile = i; input.checked = !!(mask & (1 << i));
    label.append(input, document.createTextNode(name)); box.append(label);
  });
}
$('profileSource').onchange = () => profileChoices();

function render(c) {
  fields.forEach(f => { $(f.id).value = c[f.id]; });
  for (const input of $('buttons').querySelectorAll('input')) input.checked = !!(c.buttons & (1 << input.dataset.bit));
  ['invertX', 'invertY', 'suppress', 'allButtons'].forEach((id, bit) => { $(id).checked = !!(c.flags & (1 << bit)); });
  profileChoices(c.profiles);
}
function formConfig() {
  const c = Object.fromEntries(fields.map(f => [f.id, Number($(f.id).value)]));
  c.flags = ['invertX', 'invertY', 'suppress', 'allButtons'].reduce((m, id, bit) => m | ($(id).checked ? 1 << bit : 0), 0);
  c.buttons = [...$('buttons').querySelectorAll('input:checked')].reduce((m, e) => m | (1 << e.dataset.bit), 0);
  c.profiles = c.profileSource ? [...$('profiles').querySelectorAll('input:checked')].reduce((m, e) => m | (1 << e.dataset.profile), 0) : 0;
  encodeConfig(c); return c;
}
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
function controls() {
  deviceButtons.forEach(id => { $(id).disabled = !device || busy; });
  $('connect').disabled = !!device || busy || !navigator.hid;
}
async function action(fn) {
  if (busy) return;
  busy = true; controls();
  try { await fn(); } catch (e) { message(e.message || String(e), true); }
  finally { busy = false; controls(); }
}
async function receive(id) {
  if (!device?.opened) throw new Error('请先连接接收器');
  return featureBytes(await device.receiveFeatureReport(id), id);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function command(cmd, config) {
  if (!device?.opened) throw new Error('请先连接接收器');
  const payload = new Uint8Array(REPORT_SIZE);
  sequence = sequence % 255 + 1; payload[0] = cmd; payload[1] = sequence;
  if (config) payload.set(encodeConfig(config), 2);
  await device.sendFeatureReport(CONFIG_REPORT, payload);
  const deadline = performance.now() + 2500;
  while (performance.now() < deadline) {
    await delay(30);
    const result = await receive(CONFIG_REPORT);
    if (result[40] !== cmd || result[42] !== sequence) continue;
    if (result[41]) throw new Error(result[41] === 2 ? '保存 Flash 失败；内存配置仍有效' : '固件拒绝参数，请检查配置范围');
    return decodeConfig(result);
  }
  throw new Error('固件未确认命令，请重新连接后读取配置；尚不能确认操作成功');
}

function onInput(e) {
  if (e.reportId === 1 && e.data.byteLength >= 63) {
    usbStick = [e.data.getUint8(2), e.data.getUint8(3)];
  }
}
$('connect').onclick = () => action(async () => {
  const chosen = await navigator.hid.requestDevice({ filters: [
    { vendorId: 0x054C, productId: 0x0CE6, usagePage: 1, usage: 5 },
    { vendorId: 0x054C, productId: 0x0DF2, usagePage: 1, usage: 5 },
  ] });
  if (!chosen.length) return;
  const candidate = chosen[0];
  const reports = candidate.collections.flatMap(c => c.featureReports || []);
  if (![CONFIG_REPORT, STATUS_REPORT].every(id => reports.some(r => r.reportId === id)))
    throw new Error('选择的设备没有体感扩展协议。请烧录本分支固件，并选择 USB 接收器。');
  await candidate.open(); device = candidate;
  try {
    const config = await receive(CONFIG_REPORT); render(decodeConfig(config));
    sequence = config[42];
    device.addEventListener('inputreport', onInput);
    $('device').textContent = `${device.productName} · ${device.productId === 0x0DF2 ? 'Edge' : 'DualSense'}`;
    $('connectionDot').classList.add('on'); samples = []; usbStick = null;
    try {
      const version = await device.receiveFeatureReport(0xF8);
      const bytes = new Uint8Array(version.buffer, version.byteOffset, version.byteLength);
      $('firmware').textContent = new TextDecoder().decode(bytes.subarray(bytes[0] === 0xF8 ? 1 : 0)).replace(/\0.*$/s, '');
    } catch { $('firmware').textContent = '版本读取失败（体感协议已连接）'; }
    message('已读取固件配置。调整后点击应用；需要断电保留时点击“应用并保存”。');
  } catch (e) { await close(); throw e; }
});
async function close() {
  const previous = device; device = null; live = null; usbStick = null;
  if (previous) { previous.removeEventListener('inputreport', onInput); if (previous.opened) await previous.close(); }
  $('device').textContent = '网页已断开 · 接收器继续按已应用的配置工作';
  $('connectionDot').classList.remove('on'); $('active').textContent = '网页未连接';
  controls();
}
$('disconnect').onclick = () => action(close);
if (navigator.hid) navigator.hid.addEventListener('disconnect', e => {
  if (e.device === device) action(async () => { await close(); message('USB 接收器已断开'); });
});
$('settings').onsubmit = e => { e.preventDefault(); action(async () => {
  const c = formConfig(); await command(1, c); message('配置已应用到内存。固件立即生效。');
}); };
$('save').onclick = () => action(async () => {
  const c = formConfig(); await command(1, c); await command(2); message('配置已应用并保存，断电后保留。');
});
$('read').onclick = () => action(async () => { render(decodeConfig(await receive(CONFIG_REPORT))); message('已重新读取当前固件配置'); });
$('defaults').onclick = () => action(async () => { render(await command(4)); message('固件已恢复默认并关闭体感（仅内存）；点击保存可永久保留。'); });
$('calibrate').onclick = () => action(async () => { await command(3); message('请放稳手柄，等待连续 2 秒静止校准；移动会重新计时。'); });
$('clearCalibration').onclick = () => action(async () => { await command(5); message('已清除当前零点偏移，保留工厂标定'); });
function preset(ms) {
  $('output').value = Number($('output').value) || 1; $('activation').value = 1; $('trigger').value = 1;
  $('hold').value = ms;
  for (const input of $('buttons').querySelectorAll('input')) input.checked = false;
  message(`已填入${ms ? '长按 300ms' : '按住'} L2 方案；点击应用到固件后生效。`);
}
$('presetL2').onclick = () => preset(0); $('presetLong').onclick = () => preset(300);
$('learn').onclick = () => {
  if (!live || !(live.flags & 1) || !live.buttons) return message('请先连接，并按住需要的按键后再读取', true);
  $('trigger').value = 0;
  for (const input of $('buttons').querySelectorAll('input')) input.checked = !!(live.buttons & (1 << input.dataset.bit));
  message('已读取原始按键，可取消多余选项，再点击应用。');
};
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type })), a = document.createElement('a');
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('export').onclick = () => action(async () => download('ds5-gyro-config.json', JSON.stringify({ version: 1, config: formConfig() }, null, 2), 'application/json'));
$('import').onchange = e => action(async () => {
  const file = e.target.files[0]; if (!file) return;
  if (file.size > 16384) throw new Error('配置文件超过 16 KB');
  const data = JSON.parse(await file.text());
  if (data.version !== 1 || !data.config) throw new Error('不支持的配置文件');
  encodeConfig(data.config); render(data.config); e.target.value = '';
  message('已导入表单，请点击应用到固件。');
});
$('csv').onclick = () => {
  const rows = ['time_ms,dt_us,flags,pitch_dps,yaw_dps,roll_dps,filtered_x_dps,filtered_y_dps,stick_x,stick_y,buttons,edge_profile,dongle_profile', ...samples.map(s => [s.time, s.dt, s.flags, ...s.rates, ...s.filtered, ...s.stick, s.buttons, s.edgeProfile, s.dongleProfile].join(','))];
  download('ds5-gyro-debug.csv', rows.join('\n'), 'text/csv');
};

function draw() {
  const canvas = $('chart'), ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const history = samples.slice(-180), scale = Math.max(30, ...history.flatMap(s => s.rates.map(Math.abs)));
  ctx.strokeStyle = '#263647'; ctx.lineWidth = 1;
  for (let y = 25; y < h; y += 45) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  ctx.fillStyle = '#91a4b6'; ctx.font = '12px system-ui'; ctx.fillText(`±${Math.ceil(scale)} °/s`, 10, 17);
  ['#69aaff', '#70e6bc', '#f5b66d'].forEach((color, axis) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    history.forEach((s, i) => { const x = i / 179 * w, y = h / 2 - s.rates[axis] / scale * (h / 2 - 25); if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.stroke();
  });
}
function renderLive(s) {
  $('active').textContent = !(s.flags & 1) ? '等待手柄输入' : s.flags & 4 ? '静止校准中' : s.flags & 2 ? '体感已启用' : '体感未启用';
  $('interval').textContent = s.dt ? `${(s.dt / 1000).toFixed(2)} ms` : '—';
  $('factory').textContent = s.flags & 16 ? '已应用' : '标称值';
  $('calibration').textContent = s.flags & 4 ? `${s.progress}%` : s.flags & 8 ? '已校准' : '未校准';
  $('stick').textContent = usbStick ? usbStick.join(' / ') : '等待 USB 输入';
  $('rates').textContent = s.rates.map(n => n.toFixed(2)).join(' / ');
  for (const el of $('liveButtons').children) el.classList.toggle('on', !!(s.buttons & (1 << el.dataset.bit)));
  $('raw').textContent = `GYRO RAW: ${s.raw.join(', ')}\nACC RAW: ${s.accel.join(', ')}\n零点 °/s: ${s.bias.join(', ')}\n目标 °/s: ${s.filtered.join(', ')}\n鼠标待发送 counts: ${s.pending.join(', ')}\nEdge 原生档: ${s.edgeProfile || '未知/普通版'}（1=△ 2=□ 3=× 4=○）\n接收器映射档: ${s.dongleProfile + 1}\n样本: ${s.packets} · 校准样本: ${s.samples}`;
  if (s.flags & 1) { samples.push({ ...s, time: Date.now() }); if (samples.length > 600) samples.shift(); }
  draw();
}
async function poll() {
  if (device && !busy) {
    const current = device;
    try { const data = await receive(STATUS_REPORT); if (device === current) { live = decodeStatus(data); renderLive(live); } }
    catch (e) { if (device === current) message(`调试读取失败：${e.message}`, true); }
  }
  setTimeout(poll, 100);
}
render(defaults()); controls(); draw(); poll();
if (!navigator.hid) message('当前浏览器不支持 WebHID，请使用桌面 Chrome / Edge，并通过 localhost 或 HTTPS 打开。', true);
