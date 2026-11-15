import {
  FLASH_SIZE, PT_ADDRESS, RECORD_ADDRESS, ROOT_LIMIT, SECTOR_SIZE, SLOT_CAPACITY,
  buildInstallImage, buildRestoreImage, buildSlotUpdate, inspectDualState,
  normalizeSlotVersion, sha256, validateManagerImage, validateAppImage, expectedStock,
} from './dual-firmware.mjs';
import { extractAppVersion, loadFirmwarePackage } from './firmware-package.mjs';
import { Flasher, USB_FILTERS, WebSerialLink } from './isp-flasher.mjs';
import {
  bootManagerAssets, fetchVerifiedAsset, findLatestReleaseAsset,
  getCachedReleases, releaseAssets, repositories, safeAssetURL,
} from './releases.mjs';
import { createLocalDownloader } from './updates.mjs';

const MAX_FILE = 8 * 1024 * 1024;
const hexPrefix = b => Array.from(b.subarray(0, 4), v => v.toString(16).padStart(2, '0')).join('');
const fallbackTagVersion = tag => String(tag || '').replace(/^v/i, '').replace(/[^\x20-\x7e]/g, '').slice(0, 19);

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
  let running = false, downloading = false, cachedDownloader = null;
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
    const load = async (fileName, rawBytes, { preferredVariant, fallbackVersion } = {}) => {
      await pick(fileName, rawBytes);
      if (preferredVariant && state[key]?.variant !== preferredVariant && state[key]?.variants.some(v => v.id === preferredVariant)) {
        await pick(fileName, rawBytes, preferredVariant);
      }
      if (!state[key]?.version && fallbackVersion && $(versionId)) {
        $(versionId).value = fallbackVersion;
        onChange();
      }
    };
    return {
      reload: () => state[key] && pick(state[key].rawName, state[key].rawBytes, state[key].variant),
      load,
    };
  }

  function updateButtons() {
    const busy = running || downloading;
    const op = $('dualOp').value;
    for (const name of ['slot', 'install', 'restore']) $('dualPane_' + name).hidden = op !== name;
    for (const id of ['dualInspect', 'dualBackup', 'dualOp', 'dualSlotTarget', 'dualSlotUsb', 'dualSlotFile',
      'dualSlotVersion', 'dualAutoSlot', 'dualInstallUsb', 'dualAutoMgr', 'dualAutoGyro', 'dualAutoUp', 'dualAutoAll',
      'dualMgrFile', 'dualGyroFile', 'dualGyroVer', 'dualUpFile', 'dualUpVer', 'dualUpSnapFile',
      'dualOrigFile', 'dualRestoreSlot', 'dualInstallConfirm', 'dualRestoreConfirm']) {
      if ($(id)) $(id).disabled = busy;
    }
    if ($('dualSlotVariant')) $('dualSlotVariant').disabled = busy || !state.slot || state.slot.variants.length <= 1;
    if ($('dualGyroVariant')) $('dualGyroVariant').disabled = busy || !state.gyro || state.gyro.variants.length <= 1;
    if ($('dualUpVariant')) $('dualUpVariant').disabled = busy || !state.upstream || state.upstream.variants.length <= 1;

    $('dualSlotRun').disabled = busy || !supported || !state.slot || !$('dualSlotVersion').value.trim();
    $('dualInstallRun').disabled = busy || !supported || !state.manager || !state.gyro || !state.upstream ||
      !$('dualGyroVer').value.trim() || !$('dualUpVer').value.trim() || !$('dualInstallConfirm').checked;
    $('dualRestoreRun').disabled = busy || !supported || !state.original || !$('dualRestoreConfirm').checked;
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
  const gyroPicker = bindAppPicker({
    fileId: 'dualGyroFile', variantFieldId: 'dualGyroVariantField', variantId: 'dualGyroVariant',
    versionId: 'dualGyroVer', summaryId: 'dualGyroSummary',
    getMaxLength: () => SLOT_CAPACITY[0], label: '体感固件', key: 'gyro', onChange: updateButtons,
  });
  const upPicker = bindAppPicker({
    fileId: 'dualUpFile', variantFieldId: 'dualUpVariantField', variantId: 'dualUpVariant',
    versionId: 'dualUpVer', summaryId: 'dualUpSummary',
    getMaxLength: () => SLOT_CAPACITY[1], label: '上游固件', key: 'upstream', onChange: updateButtons,
  });

  async function loadManagerBytes(name, bytes, extra = '', { scroll = false } = {}) {
    await validateManagerImage(bytes);
    state.manager = bytes;
    if ($('dualMgrFile')) $('dualMgrFile').value = '';
    $('dualMgrSummary').textContent = `${name} · ${bytes.length} B · SHA256 验证通过${extra}`;
    if (scroll) {
      if ($('dualToolsDetails')) $('dualToolsDetails').open = true;
      $('dualOp').value = 'install';
      $('dualMgrSummary').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    updateButtons();
  }

  async function probeDownloader() {
    if (!cachedDownloader) cachedDownloader = await createLocalDownloader();
    return cachedDownloader;
  }

  async function withDownload(label, task) {
    if (running || downloading) return;
    downloading = true;
    updateButtons();
    say(`正在准备${label}…`);
    try {
      await task();
    } catch (err) {
      say(err.message, true);
    } finally {
      downloading = false;
      updateButtons();
    }
  }

  async function fetchMatchedAsset({ repo, includePrerelease, allowPrereleaseFallback, pickAssets, emptyError, dl, manualHint }) {
    const releases = await getCachedReleases(repo);
    const match = findLatestReleaseAsset(releases, { includePrerelease, allowPrereleaseFallback, pickAssets });
    if (!match) throw new Error(emptyError);
    say(`正在下载 ${match.asset.name}（${match.release.tag_name}）…`);
    const { bytes, verified } = await fetchVerifiedAsset({
      repo, release: match.release, asset: match.asset, downloader: dl, manualHint,
    });
    return { ...match, bytes, verified };
  }

  async function downloadManagerAsset(dl) {
    const includePre = $('includePrerelease')?.checked ?? true;
    const hit = await fetchMatchedAsset({
      repo: repositories.gyro, includePrerelease: includePre, allowPrereleaseFallback: true,
      pickAssets: r => bootManagerAssets(r, 'lctech616', 'fs').filter(a => safeAssetURL(a.browser_download_url, repositories.gyro)),
      emptyError: '没有找到可下载的 LCTech 616 启动管理器镜像', dl,
      manualHint: '请在下方“启动管理器 .bin”选择该文件',
    });
    await loadManagerBytes(hit.asset.name, hit.bytes, hit.prereleaseFallback ? ' · 来自预发布版本' : '');
    return hit;
  }

  async function downloadAppAsset({ repo, upstream, usb, picker, fileInputId, emptyError, manualHint, dl }) {
    const includePre = upstream ? false : ($('includePrerelease')?.checked ?? true);
    const hit = await fetchMatchedAsset({
      repo, includePrerelease: includePre, allowPrereleaseFallback: true,
      pickAssets: r => releaseAssets(r, 'lctech616', usb, upstream).filter(a => safeAssetURL(a.browser_download_url, repo)),
      emptyError, dl, manualHint,
    });
    await picker.load(hit.asset.name, hit.bytes, {
      preferredVariant: usb, fallbackVersion: fallbackTagVersion(hit.release.tag_name),
    });
    if ($(fileInputId)) $(fileInputId).value = '';
    return hit;
  }

  const installUsb = () => ($('dualInstallUsb')?.value === 'hs' ? 'hs' : 'fs');
  const fetchGyroForInstall = dl => downloadAppAsset({
    repo: repositories.gyro, upstream: false, usb: installUsb(), picker: gyroPicker, fileInputId: 'dualGyroFile',
    emptyError: `没有找到匹配 LCTech 616 ${installUsb().toUpperCase()} 的体感固件发布`, dl,
    manualHint: '请在下方“体感固件”选择该文件',
  });
  const fetchUpForInstall = dl => downloadAppAsset({
    repo: repositories.upstream, upstream: true, usb: installUsb(), picker: upPicker, fileInputId: 'dualUpFile',
    emptyError: '没有找到可下载的上游原版 LCTech 616 发布包', dl,
    manualHint: '请在下方“上游原版固件”选择该文件',
  });

  if ($('dualAutoMgr')) $('dualAutoMgr').onclick = () => withDownload('启动管理器', async () => {
    const hit = await downloadManagerAsset(await probeDownloader());
    say(`已下载并验证启动管理器 ${hit.asset.name}（${hit.release.tag_name}${hit.verified ? ' · SHA256 一致' : ''}）。`);
  });
  if ($('dualAutoGyro')) $('dualAutoGyro').onclick = () => withDownload('最新体感固件', async () => {
    const hit = await fetchGyroForInstall(await probeDownloader());
    say(`已下载并验证体感固件 ${hit.asset.name}（${hit.release.tag_name}${hit.verified ? ' · SHA256 一致' : ''}）。`);
  });
  if ($('dualAutoUp')) $('dualAutoUp').onclick = () => withDownload('最新上游原版固件', async () => {
    const hit = await fetchUpForInstall(await probeDownloader());
    say(`已下载并验证上游原版 ${hit.asset.name}（${hit.release.tag_name}${hit.verified ? ' · SHA256 一致' : ''}）。`);
  });
  if ($('dualAutoAll')) $('dualAutoAll').onclick = () => withDownload('全套双固件资源', async () => {
    const dl = await probeDownloader();
    if (!dl) throw new Error('当前不是桌面控制中心，浏览器无法直接读取 GitHub 附件。请运行桌面版控制中心后点“一键下载全套”，或分别点击单个下载按钮。');
    say('正在下载 (1/3) 启动管理器…');
    const mgr = await downloadManagerAsset(dl);
    say('正在下载 (2/3) 最新体感固件…');
    const gyro = await fetchGyroForInstall(dl);
    say('正在下载 (3/3) 最新上游原版固件…');
    const up = await fetchUpForInstall(dl);
    say(`全套文件已下载并校验就绪：管理器 ${mgr.release.tag_name} · 体感 ${gyro.release.tag_name} · 上游 ${up.release.tag_name}。核对版本号并勾选确认后即可安装。`);
  });
  if ($('dualAutoSlot')) $('dualAutoSlot').onclick = () => withDownload('匹配槽位固件', async () => {
    const slot = Number($('dualSlotTarget').value);
    const usb = $('dualSlotUsb')?.value === 'hs' ? 'hs' : 'fs';
    const isUp = slot === 1;
    const hit = await downloadAppAsset({
      repo: isUp ? repositories.upstream : repositories.gyro, upstream: isUp, usb, picker: slotPicker,
      fileInputId: 'dualSlotFile',
      emptyError: isUp ? '没有找到可下载的上游原版 LCTech 616 发布包' : `没有找到匹配 LCTech 616 ${usb.toUpperCase()} 的体感固件发布`,
      dl: await probeDownloader(),
      manualHint: '请在下方“固件包 ZIP 或 .bin”选择该文件',
    });
    say(`已下载并验证槽位 ${slot}（${isUp ? '上游原版' : '体感固件'}）${hit.asset.name}（${hit.release.tag_name}${hit.verified ? ' · SHA256 一致' : ''}）。`);
  });

  $('dualMgrFile').onchange = async e => {
    state.manager = null; $('dualMgrSummary').textContent = '';
    const f = e.target.files[0]; if (!f) { updateButtons(); return; }
    try {
      await loadManagerBytes(f.name, new Uint8Array(await f.arrayBuffer()));
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
  return { loadManagerSource: (name, bytes, opts) => loadManagerBytes(name, bytes, '', opts) };
}
