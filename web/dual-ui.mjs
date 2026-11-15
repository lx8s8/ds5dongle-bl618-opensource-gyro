import {
  FLASH_SIZE, PT_ADDRESS, RECORD_ADDRESS, ROOT_LIMIT, SECTOR_SIZE, SLOT_CAPACITY,
  buildInstallImage, buildRestoreImage, buildSlotUpdate, inspectDualState,
  normalizeSlotVersion, sha256, validateManagerImage, validateAppImage, expectedStock,
} from './dual-firmware.mjs';
import { extractAppVersion, loadFirmwarePackage } from './firmware-package.mjs';
import { Flasher, USB_FILTERS, WebSerialLink } from './isp-flasher.mjs';

const MAX_FILE = 8 * 1024 * 1024;
const hexPrefix = b => Array.from(b.subarray(0, 4), v => v.toString(16).padStart(2, '0')).join('');

function downloadBlob(name, bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.style.display = 'none';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

async function resolveAppSource(fileName, bytes, { maxLength, label, variant }) {
  if (bytes.length > MAX_FILE) throw new Error(fileName + ' 文件过大');
  if (/\.zip$/i.test(fileName)) {
    const pkg = await loadFirmwarePackage(bytes, { variant });
    const fw = pkg.images.firmware.data;
    const info = await validateAppImage(fw, { maxLength, label });
    const ver = (info.embedded && info.embedded.version) || (extractAppVersion(fw)?.version) || '';
    return {
      rawName: fileName, rawBytes: bytes, firmware: fw, variants: pkg.variants, variant: pkg.variant,
      version: ver, summary: `${pkg.images.firmware.name} · ${fw.length} B` + (info.embedded ? ` · ${info.embedded.raw}` : ''),
    };
  }
  const info = await validateAppImage(bytes, { maxLength, label });
  return {
    rawName: fileName, rawBytes: bytes, firmware: bytes, variants: [], variant: info.embedded?.usb || 'fs',
    version: info.embedded?.version || '',
    summary: `${fileName} · ${bytes.length} B` + (info.embedded ? ` · ${info.embedded.raw}` : ''),
  };
}

export function initDualFirmware() {
  const $ = id => document.getElementById(id);
  const root = $('dualTools');
  if (!root) return {};
  const supported = 'serial' in navigator;
  let running = false;
  $('dualSupport').hidden = supported;

  const state = {
    slot: null, manager: null, gyro: null, upstream: null, upstreamSnap: null, original: null,
  };

  const say = (text, error = false) => {
    const el = $('dualMessage'); el.textContent = text; el.classList.toggle('error', error);
  };
  const log = text => {
    const el = $('dualLog'); el.hidden = false; el.textContent += text + '\n'; el.scrollTop = el.scrollHeight;
  };
  const progress = (fraction, label) => {
    $('dualProgress').hidden = false; $('dualProgress').value = fraction; $('dualStage').textContent = label || '';
  };

  function bindAppPicker({ fileId, variantFieldId, variantId, versionId, summaryId, getMaxLength, label, key, onChange }) {
    const pick = async (fileName, rawBytes, variant) => {
      state[key] = null;
      $(summaryId).textContent = '';
      if (variantFieldId) $(variantFieldId).hidden = true;
      if (!rawBytes) { onChange(); return; }
      const src = await resolveAppSource(fileName, rawBytes, { maxLength: getMaxLength(), label, variant });
      state[key] = src;
      $(summaryId).textContent = src.summary;
      if (src.version && $(versionId)) $(versionId).value = src.version;
      if (variantFieldId && variantId) {
        $(variantId).replaceChildren(...src.variants.map(v => {
          const opt = document.createElement('option');
          opt.value = v.id; opt.textContent = v.label + ' (' + v.name + ')'; opt.selected = v.id === src.variant;
          return opt;
        }));
        $(variantFieldId).hidden = src.variants.length <= 1;
      }
      onChange();
    };
    $(fileId).onchange = async e => {
      const f = e.target.files[0];
      try { await pick(f ? f.name : '', f ? new Uint8Array(await f.arrayBuffer()) : null); }
      catch (err) { e.target.value = ''; state[key] = null; $(summaryId).textContent = ''; say(err.message, true); onChange(); }
    };
    if (variantId) {
      $(variantId).onchange = async () => {
        const prev = state[key]; if (!prev) return;
        try { await pick(prev.rawName, prev.rawBytes, $(variantId).value); }
        catch (err) { say(err.message, true); onChange(); }
      };
    }
    if (versionId) $(versionId).oninput = onChange;
    return { reload: () => state[key] && pick(state[key].rawName, state[key].rawBytes, state[key].variant) };
  }

  function updateButtons() {
    const op = $('dualOp').value;
    for (const name of ['slot', 'install', 'restore']) $('dualPane_' + name).hidden = op !== name;
    for (const id of ['dualInspect', 'dualBackup', 'dualOp', 'dualSlotTarget', 'dualSlotFile', 'dualSlotVersion',
      'dualMgrFile', 'dualGyroFile', 'dualGyroVer', 'dualUpFile', 'dualUpVer', 'dualUpSnapFile',
      'dualOrigFile', 'dualRestoreSlot', 'dualInstallConfirm', 'dualRestoreConfirm']) {
      if ($(id)) $(id).disabled = running;
    }
    if ($('dualSlotVariant')) $('dualSlotVariant').disabled = running || !state.slot || state.slot.variants.length <= 1;
    if ($('dualGyroVariant')) $('dualGyroVariant').disabled = running || !state.gyro || state.gyro.variants.length <= 1;
    if ($('dualUpVariant')) $('dualUpVariant').disabled = running || !state.upstream || state.upstream.variants.length <= 1;

    $('dualSlotRun').disabled = running || !supported || !state.slot || !$('dualSlotVersion').value.trim();
    $('dualInstallRun').disabled = running || !supported || !state.manager || !state.gyro || !state.upstream ||
      !$('dualGyroVer').value.trim() || !$('dualUpVer').value.trim() || !$('dualInstallConfirm').checked;
    $('dualRestoreRun').disabled = running || !supported || !state.original || !$('dualRestoreConfirm').checked;
  }

  const slotPicker = bindAppPicker({
    fileId: 'dualSlotFile', variantFieldId: 'dualSlotVariantField', variantId: 'dualSlotVariant',
    versionId: 'dualSlotVersion', summaryId: 'dualSlotSummary',
    getMaxLength: () => SLOT_CAPACITY[Number($('dualSlotTarget').value)],
    label: '待刷入固件', key: 'slot', onChange: updateButtons,
  });
  $('dualSlotTarget').onchange = () => {
    slotPicker.reload()?.catch(err => { state.slot = null; $('dualSlotFile').value = ''; $('dualSlotSummary').textContent = ''; say(err.message, true); updateButtons(); });
    updateButtons();
  };
  bindAppPicker({
    fileId: 'dualGyroFile', variantFieldId: 'dualGyroVariantField', variantId: 'dualGyroVariant',
    versionId: 'dualGyroVer', summaryId: 'dualGyroSummary',
    getMaxLength: () => SLOT_CAPACITY[0], label: '体感固件', key: 'gyro', onChange: updateButtons,
  });
  bindAppPicker({
    fileId: 'dualUpFile', variantFieldId: 'dualUpVariantField', variantId: 'dualUpVariant',
    versionId: 'dualUpVer', summaryId: 'dualUpSummary',
    getMaxLength: () => SLOT_CAPACITY[1], label: '上游固件', key: 'upstream', onChange: updateButtons,
  });

  $('dualMgrFile').onchange = async e => {
    state.manager = null; $('dualMgrSummary').textContent = '';
    const f = e.target.files[0]; if (!f) { updateButtons(); return; }
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      await validateManagerImage(bytes);
      state.manager = bytes;
      $('dualMgrSummary').textContent = `${f.name} · ${bytes.length} B · SHA256 验证通过`;
    } catch (err) { e.target.value = ''; say(err.message, true); }
    updateButtons();
  };
  $('dualUpSnapFile').onchange = async e => {
    state.upstreamSnap = null; $('dualUpSnapSummary').textContent = '';
    const f = e.target.files[0]; if (!f) { updateButtons(); return; }
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      expectedStock(bytes);
      state.upstreamSnap = bytes;
      $('dualUpSnapSummary').textContent = `已验证上游 4 MiB 快照（${f.name}）`;
    } catch (err) { e.target.value = ''; say(err.message, true); }
    updateButtons();
  };
  $('dualOrigFile').onchange = async e => {
    state.original = null; $('dualOrigSummary').textContent = '';
    const f = e.target.files[0]; if (!f) { updateButtons(); return; }
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      expectedStock(bytes);
      state.original = bytes;
      $('dualOrigSummary').textContent = `已验证原始单固件 4 MiB 备份（${f.name}）`;
    } catch (err) { e.target.value = ''; say(err.message, true); }
    updateButtons();
  };

  $('dualOp').onchange = updateButtons;
  $('dualInstallConfirm').onchange = updateButtons;
  $('dualRestoreConfirm').onchange = updateButtons;

  async function withIsp(task) {
    let port;
    try { port = await navigator.serial.requestPort({ filters: USB_FILTERS }); } catch { say('未选择串口'); return; }
    running = true; updateButtons(); $('dualLog').textContent = ''; say('正在连接 BootROM…'); progress(0.02, '等待串口响应');
    const link = new WebSerialLink(port);
    try {
      await link.open();
      const flasher = new Flasher(link, { log, progress });
      await flasher.connect();
      await task(flasher);
    } catch (err) {
      log('失败：' + err.message);
      say('操作失败：' + err.message + '（可按住 BOOT 重新插拔再试；除非最后写入步骤中途掉电，否则原有数据未受破坏）', true);
    } finally { await link.close(); running = false; updateButtons(); }
  }

  async function readMetadata(flasher, base = 0.05, span = 0.1) {
    const rootHead = await flasher.readFlash(0, SECTOR_SIZE, { label: '读取启动头', verify: false, base, span: span * 0.25 });
    const pt = await flasher.readFlash(PT_ADDRESS[0], SECTOR_SIZE * 2, { label: '读取分区表', verify: false, base: base + span * 0.25, span: span * 0.35 });
    const rec = await flasher.readFlash(RECORD_ADDRESS[0], SECTOR_SIZE * 2, { label: '读取 DBM1 记录', verify: false, base: base + span * 0.6, span: span * 0.4 });
    return {
      rootHead,
      pt0: pt.subarray(0, SECTOR_SIZE), pt1: pt.subarray(SECTOR_SIZE, SECTOR_SIZE * 2),
      rec0: rec.subarray(0, SECTOR_SIZE), rec1: rec.subarray(SECTOR_SIZE, SECTOR_SIZE * 2),
    };
  }

  function formatDualState(st) {
    if (st.mode === 'dual') {
      const r = st.record;
      return `已安装双固件（第 ${r.gen} 代 · 下次启动槽位 ${r.selected}）\n槽位 0（体感）：${r.images[0].version} · ${r.images[0].len} B\n槽位 1（上游）：${r.images[1].version} · ${r.images[1].len} B`;
    }
    if (st.mode === 'stock') return '当前为单固件原版布局（未安装双固件启动管理器）';
    return '检测到不完整的双固件元数据（建议先读取 4 MiB 备份检查，或使用原始备份恢复）';
  }

  $('dualInspect').onclick = () => withIsp(async flasher => {
    const meta = await readMetadata(flasher, 0.05, 0.9);
    const st = inspectDualState(meta);
    $('dualDeviceInfo').textContent = formatDualState(st);
    progress(1, '读取完成');
    say('布局检查完成。芯片在重新上电前仍停留在下载模式。');
  });

  $('dualBackup').onclick = () => withIsp(async flasher => {
    const dump = await flasher.readFlash(0, FLASH_SIZE, { label: '读取整片 4 MiB 备份', verify: true, base: 0.05, span: 0.93 });
    const digest = await sha256(dump);
    const name = `ds5-flash-${flasher.info?.chipId || 'bl616'}-${stamp()}.bin`;
    downloadBlob(name, dump);
    const st = inspectDualState({
      rootHead: dump.subarray(0, ROOT_LIMIT),
      pt0: dump.subarray(PT_ADDRESS[0], PT_ADDRESS[0] + SECTOR_SIZE), pt1: dump.subarray(PT_ADDRESS[1], PT_ADDRESS[1] + SECTOR_SIZE),
      rec0: dump.subarray(RECORD_ADDRESS[0], RECORD_ADDRESS[0] + 256), rec1: dump.subarray(RECORD_ADDRESS[1], RECORD_ADDRESS[1] + 256),
    });
    $('dualDeviceInfo').textContent = formatDualState(st) + `\n备份校验 sha256:${hexPrefix(digest)}… 已触发保存：${name}`;
    progress(1, '备份完成');
    say('4 MiB 备份已下载并校验一致。妥善保存此文件（含蓝牙配对与校准数据），请勿公开发布。');
  });

  $('dualSlotRun').onclick = () => withIsp(async flasher => {
    const slot = Number($('dualSlotTarget').value);
    const version = normalizeSlotVersion($('dualSlotVersion').value, '槽位版本号');
    const meta = await readMetadata(flasher, 0.05, 0.12);
    const st = inspectDualState(meta);
    $('dualDeviceInfo').textContent = formatDualState(st);
    const plan = await buildSlotUpdate({ ...meta, slot, firmware: state.slot.firmware, version });
    log(`分槽更新槽位 ${slot} → ${version}，切换至 DBM1 副本 ${plan.targetCopy}（第 ${plan.record.gen} 代）`);
    await flasher.program(plan.segments, { reset: true, base: 0.18, span: 0.8 });
    say(`槽位 ${slot} 已更新为 ${version} 并校验通过，接收器正在重启。重新插拔 USB 后即可使用。`);
  });

  $('dualInstallRun').onclick = () => withIsp(async flasher => {
    const gyroVersion = normalizeSlotVersion($('dualGyroVer').value, '体感版本号');
    const upstreamVersion = normalizeSlotVersion($('dualUpVer').value, '上游版本号');
    const current = await flasher.readFlash(0, FLASH_SIZE, { label: '读取当前 4 MiB 用于备份', verify: true, base: 0.05, span: 0.34 });
    const plan = await buildInstallImage({
      snapshot: current, manager: state.manager,
      gyro: state.gyro.firmware, upstream: state.upstream.firmware,
      gyroVersion, upstreamVersion, upstreamSnapshot: state.upstreamSnap,
    });
    if (!plan.segments.length) throw new Error('目标镜像与当前闪存完全一致，无需写入');
    const backupName = `ds5-stock-backup-${flasher.info?.chipId || 'bl616'}-${stamp()}.bin`;
    downloadBlob(backupName, current);
    log(`已保存安装前原始备份 ${backupName}，准备按安全顺序写入 ${plan.segments.length} 个变更区段`);
    await flasher.program(plan.segments, { reset: true, base: 0.4, span: 0.58 });
    say('双固件已写入并通过读回校验，原始 4 MiB 备份已保存到下载目录。请重新插拔 USB 验证启动。');
  });

  $('dualRestoreRun').onclick = () => withIsp(async flasher => {
    const slot = Number($('dualRestoreSlot').value);
    const current = await flasher.readFlash(0, FLASH_SIZE, { label: '读取当前双固件 4 MiB', verify: true, base: 0.05, span: 0.34 });
    const plan = await buildRestoreImage({ current, original: state.original, slot });
    if (!plan.segments.length) throw new Error('当前闪存已经与恢复目标一致');
    const backupName = `ds5-dual-backup-${flasher.info?.chipId || 'bl616'}-${stamp()}.bin`;
    downloadBlob(backupName, current);
    log(`已保存卸载前双固件备份 ${backupName}，准备保留槽位 ${slot} 恢复单固件（${plan.segments.length} 个变更区段）`);
    await flasher.program(plan.segments, { reset: true, base: 0.4, span: 0.58 });
    say(`已恢复单固件并迁回槽位 ${slot} 的设置与配对数据，请重新插拔 USB。`);
  });

  updateButtons();
  return {};
}
