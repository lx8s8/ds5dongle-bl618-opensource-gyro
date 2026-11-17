import { FLASH_SIZE, PT_ADDRESS, RECORD_ADDRESS, SECTOR_SIZE, hasRootMarker, inspectDualState, buildSlotUpdate } from './dual-firmware.mjs';
import { loadFirmwarePackage } from './firmware-package.mjs';
import { Flasher, USB_FILTERS, WebSerialLink } from './isp-flasher.mjs';

const MAX_PACKAGE = 8 * 1024 * 1024;

export async function prepareFirmwareUpdate(flasher, pkg, { mode, dualSlot = null } = {}) {
  const rootHead = await flasher.readFlash(0, SECTOR_SIZE, { label: '检查启动头', verify: false, base: 0.05, span: 0.03 });
  if (flasher.flashSize && flasher.flashSize < FLASH_SIZE) {
    if (hasRootMarker(rootHead)) throw new Error('闪存容量不符合双固件布局，已停止');
    return { mode: 'stock', segments: mode === 'full' ? [pkg.images.boot2, pkg.images.partition, pkg.images.firmware] : [pkg.images.firmware] };
  }
  const pt = await flasher.readFlash(PT_ADDRESS[0], SECTOR_SIZE * 2, { label: '检查分区表', verify: false, base: 0.08, span: 0.03 });
  const rec = await flasher.readFlash(RECORD_ADDRESS[0], SECTOR_SIZE * 2, { label: '检查双固件记录', verify: false, base: 0.11, span: 0.03 });
  const meta = { rootHead, pt0: pt.subarray(0, SECTOR_SIZE), pt1: pt.subarray(SECTOR_SIZE), rec0: rec.subarray(0, SECTOR_SIZE), rec1: rec.subarray(SECTOR_SIZE) };
  const state = inspectDualState(meta);
  if (state.mode === 'partial') throw new Error('检测到不完整的双固件布局，已停止写入；请先在双固件维护中检查设备');
  if (state.mode === 'stock') return { mode: 'stock', segments: mode === 'full' ? [pkg.images.boot2, pkg.images.partition, pkg.images.firmware] : [pkg.images.firmware] };
  if (dualSlot !== 0 && dualSlot !== 1) throw new Error('检测到双固件，但无法确定此固件包的来源。请通过版本列表下载，或在双固件维护中手动选择槽位更新');
  const version = pkg.embedded?.version;
  if (!version) throw new Error('无法识别固件版本，不能自动更新双固件槽位；请使用双固件维护中的分槽更新');
  const plan = await buildSlotUpdate({ ...meta, slot: dualSlot, firmware: pkg.images.firmware.data, version });
  return { mode: 'dual', slot: dualSlot, version, segments: plan.segments };
}

export function initFlasher() {
  const $ = id => document.getElementById(id);
  const root = $('webFlash');
  if (!root) return { load: async () => { throw new Error('页面缺少刷写面板'); } };
  let pkg = null, running = false, rawName = '', rawBytes = null, rawDualSlot = null;
  const supported = 'serial' in navigator;
  const say = (text, error = false) => { const el = $('flashMessage'); el.textContent = text; el.classList.toggle('error', error); };
  const log = text => { const el = $('flashLog'); el.hidden = false; el.textContent += text + '\n'; el.scrollTop = el.scrollHeight; };
  const update = () => {
    $('flashStart').disabled = running || !pkg || !supported || !$('flashConfirm').checked;
    $('flashPackage').disabled = running;
    $('flashMode').disabled = running;
    if ($('flashVariant')) $('flashVariant').disabled = running || !pkg || pkg.variants.length <= 1;
  };
  $('flashSupport').hidden = supported;
  window.addEventListener('beforeunload', event => { if (running) { event.preventDefault(); event.returnValue = ''; } });

  async function load(name, bytes, { confirmed = false, variant, dualSlot = null } = {}) {
    pkg = null; $('flashSummary').textContent = ''; $('flashConfirm').checked = false;
    if ($('flashVariantField')) $('flashVariantField').hidden = true;
    update();
    if (bytes.length > MAX_PACKAGE) throw new Error('文件过大，不是 DS5 固件包');
    rawName = name; rawBytes = bytes; rawDualSlot = dualSlot;
    pkg = await loadFirmwarePackage(bytes, { variant });
    if (dualSlot === 0 || dualSlot === 1) $('flashMode').value = 'app';
    if ($('flashVariantField') && $('flashVariant')) {
      $('flashVariant').replaceChildren(...pkg.variants.map(v => {
        const opt = document.createElement('option');
        opt.value = v.id; opt.textContent = v.label + ' (' + v.name + ')'; opt.selected = v.id === pkg.variant;
        return opt;
      }));
      $('flashVariantField').hidden = pkg.variants.length <= 1;
    }
    const info = pkg.info, emb = pkg.embedded || {}, i = pkg.images;
    const board = info.board || emb.board || '未知';
    const usb = String(info.usb_speed || emb.usb || pkg.variant || '未知').toUpperCase();
    const build = info.source_commit ? '提交 ' + String(info.source_commit).slice(0, 8) : (emb.raw || '版本未知');
    const integrityNote = pkg.integrity === 'sha256sums'
      ? '包内 SHA256SUMS 校验通过'
      : '包内无 SHA256SUMS（已检查启动头与分区布局）';
    $('flashSummary').textContent = [
      name + (pkg.variants.length > 1 ? ' · 已选 ' + i.firmware.name : ''),
      '板型 ' + board + ' · USB ' + usb + ' · ' + build,
      'Boot2 ' + i.boot2.data.length + ' B · 分区表 ' + i.partition.data.length + ' B · 主固件 ' + i.firmware.data.length + ' B @0x' + i.firmware.address.toString(16),
      integrityNote + (info.hardware_validated === false ? ' · 自动编译产物，尚未经过真机验收' : ''),
      dualSlot === 0 || dualSlot === 1 ? `双固件设备将自动更新槽位 ${dualSlot}（${dualSlot === 0 ? '体感' : '上游'}）；单固件设备按所选模式写入` : '手动选包的双固件设备请在双固件维护中选择目标槽位',
    ].join('\n');
    $('flashConfirm').checked = confirmed;
    say(confirmed ? '固件包已就绪。按住 BOOT 插入接收器，然后点击“开始刷写”。' : '固件包已读取。确认板型' + (pkg.variants.length > 1 ? '和 USB 变体' : '') + '无误后勾选确认，再按住 BOOT 插入接收器并点击开始。');
    update();
    if (confirmed) $('webFlash').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  $('flashPackage').onchange = async event => {
    const file = event.target.files[0];
    pkg = null; rawName = ''; rawBytes = null; rawDualSlot = null; $('flashSummary').textContent = ''; $('flashConfirm').checked = false;
    if ($('flashVariantField')) $('flashVariantField').hidden = true;
    update();
    if (!file) return;
    try { await load(file.name, new Uint8Array(await file.arrayBuffer())); }
    catch (e) { event.target.value = ''; say(e.message, true); update(); }
  };
  if ($('flashVariant')) {
    $('flashVariant').onchange = async () => {
      if (!rawBytes) return;
      try { await load(rawName, rawBytes, { variant: $('flashVariant').value, dualSlot: rawDualSlot }); }
      catch (e) { say(e.message, true); update(); }
    };
  }
  $('flashConfirm').onchange = update;

  $('flashStart').onclick = async () => {
    if (running || !pkg) return;
    const full = $('flashMode').value === 'full';
    let port;
    try { port = await navigator.serial.requestPort({ filters: USB_FILTERS }); } catch { say('未选择串口'); return; }
    running = true; update(); $('flashLog').textContent = ''; say('正在刷写，请勿拔出接收器或关闭页面…');
    const bar = $('flashProgress'); bar.hidden = false; bar.value = 0;
    const link = new WebSerialLink(port);
    try {
      await link.open();
      const flasher = new Flasher(link, { log, progress: (fraction, text) => { bar.value = fraction; $('flashStage').textContent = text; } });
      await flasher.connect();
      const plan = await prepareFirmwareUpdate(flasher, pkg, { mode: full ? 'full' : 'app', dualSlot: rawDualSlot });
      if (plan.mode === 'stock' && full && !confirm('完整刷写会重写 Boot2 和分区表。确定继续？')) { say('已取消刷写，未写入数据。'); return; }
      if (plan.mode === 'dual') log(`检测到双固件，将更新槽位 ${plan.slot} 至 ${plan.version}，保留另一槽位和数据。`);
      await flasher.program(plan.segments, { base: 0.15, span: 0.83 });
      say((plan.mode === 'dual' ? `槽位 ${plan.slot} 已更新并通过读回校验。` : '刷写完成并已通过读回校验。') + '接收器正在重启；请重新插拔 USB，再回到“连接接收器”。');
    } catch (e) {
      log('失败：' + e.message);
      say('刷写失败：' + e.message + '。接收器仍可再次按住 BOOT 插入并重试；Boot2 被打断时芯片自带下载模式不受影响。', true);
    } finally { await link.close(); running = false; update(); }
  };
  update();  return { load };
}
