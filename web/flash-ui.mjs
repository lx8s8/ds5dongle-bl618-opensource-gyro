import { SECTOR_SIZE, hasRootMarker } from './dual-firmware.mjs';
import { loadFirmwarePackage } from './firmware-package.mjs';
import { Flasher, USB_FILTERS, WebSerialLink } from './isp-flasher.mjs';

const MAX_PACKAGE = 8 * 1024 * 1024;

export function initFlasher() {
  const $ = id => document.getElementById(id);
  const root = $('webFlash');
  if (!root) return { load: async () => { throw new Error('页面缺少刷写面板'); } };
  let pkg = null, running = false, rawName = '', rawBytes = null;
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

  async function load(name, bytes, { confirmed = false, variant } = {}) {
    pkg = null; $('flashSummary').textContent = ''; $('flashConfirm').checked = false;
    if ($('flashVariantField')) $('flashVariantField').hidden = true;
    update();
    if (bytes.length > MAX_PACKAGE) throw new Error('文件过大，不是 DS5 固件包');
    rawName = name; rawBytes = bytes;
    pkg = await loadFirmwarePackage(bytes, { variant });
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
    ].join('\n');
    $('flashConfirm').checked = confirmed;
    say(confirmed ? '固件包已就绪。按住 BOOT 插入接收器，然后点击“开始刷写”。' : '固件包已读取。确认板型' + (pkg.variants.length > 1 ? '和 USB 变体' : '') + '无误后勾选确认，再按住 BOOT 插入接收器并点击开始。');
    update();
    if (confirmed) $('webFlash').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  $('flashPackage').onchange = async event => {
    const file = event.target.files[0];
    pkg = null; rawName = ''; rawBytes = null; $('flashSummary').textContent = ''; $('flashConfirm').checked = false;
    if ($('flashVariantField')) $('flashVariantField').hidden = true;
    update();
    if (!file) return;
    try { await load(file.name, new Uint8Array(await file.arrayBuffer())); }
    catch (e) { event.target.value = ''; say(e.message, true); update(); }
  };
  if ($('flashVariant')) {
    $('flashVariant').onchange = async () => {
      if (!rawBytes) return;
      try { await load(rawName, rawBytes, { variant: $('flashVariant').value }); }
      catch (e) { say(e.message, true); update(); }
    };
  }
  $('flashConfirm').onchange = update;

  $('flashStart').onclick = async () => {
    if (running || !pkg) return;
    const full = $('flashMode').value === 'full';
    if (full && !confirm('完整刷写会重写 Boot2 和分区表。已安装双固件启动管理器的设备不要使用完整刷写。确定继续？')) return;
    let port;
    try { port = await navigator.serial.requestPort({ filters: USB_FILTERS }); } catch { say('未选择串口'); return; }
    running = true; update(); $('flashLog').textContent = ''; say('正在刷写，请勿拔出接收器或关闭页面…');
    const bar = $('flashProgress'); bar.hidden = false; bar.value = 0;
    const link = new WebSerialLink(port);
    try {
      await link.open();
      const flasher = new Flasher(link, { log, progress: (fraction, text) => { bar.value = fraction; $('flashStage').textContent = text; } });
      await flasher.connect();
      const head = await flasher.readFlash(0, SECTOR_SIZE, { label: '检查布局', verify: false, base: 0.05, span: 0.04 });
      if (hasRootMarker(head)) throw new Error('检测到已安装双固件启动管理器！请使用上方“双固件切换与维护 -> 分槽更新镜像”或先卸载恢复单固件，避免破坏数据或失去同步。');
      const images = full ? [pkg.images.boot2, pkg.images.partition, pkg.images.firmware] : [pkg.images.firmware];
      await flasher.program(images, { base: 0.1, span: 0.88 });
      say('刷写完成并已通过读回校验。接收器正在重启；请重新插拔 USB，再回到“连接接收器”。');
    } catch (e) {
      log('失败：' + e.message);
      say('刷写失败：' + e.message + '。接收器仍可再次按住 BOOT 插入并重试；Boot2 被打断时芯片自带下载模式不受影响。', true);
    } finally { await link.close(); running = false; update(); }
  };
  update();  return { load };
}
