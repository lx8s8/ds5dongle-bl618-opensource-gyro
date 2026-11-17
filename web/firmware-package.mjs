import { readZip } from './zip-reader.mjs';

export const BOOT2_ADDRESS = 0x0, BOOT2_LIMIT = 0xe000, PARTITION_ADDRESS = 0xe000;
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const baseName = name => name.slice(name.lastIndexOf('/') + 1);
const magic = (bytes, text) => bytes.length >= 4 && text.split('').every((c, i) => bytes[i] === c.charCodeAt(0));

export function parseFlashConfig(text) {
  const sections = {};
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) { current = sections[header[1]] = {}; continue; }
    const pair = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (pair && current) current[pair[1]] = pair[2];
  }
  return sections;
}

// BFPT partition table: 16-byte header, 36-byte entries, trailing CRC32.
export function parsePartitionTable(bytes) {
  if (!magic(bytes, 'BFPT')) throw new Error('partition.bin 不是 BFPT 分区表');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(6, true);
  if (count === 0 || count > 32 || bytes.length !== 16 + count * 36 + 4) throw new Error('分区表长度异常');
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = 16 + i * 36;
    const nameBytes = bytes.subarray(o + 3, o + 12);
    const end = nameBytes.indexOf(0);
    entries.push({
      type: bytes[o], active: bytes[o + 2],
      name: new TextDecoder().decode(end < 0 ? nameBytes : nameBytes.subarray(0, end)),
      address: [view.getUint32(o + 12, true), view.getUint32(o + 16, true)],
      maxLength: [view.getUint32(o + 20, true), view.getUint32(o + 24, true)],
    });
  }
  return entries;
}

async function sha256(bytes) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))); }

export function extractAppVersion(bytes) {
  const limit = Math.min(bytes.length, 1024 * 1024);
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, limit));
  const m = /((LCT616|BL618|M0S)-DS5 ([0-9][0-9A-Za-z.]{0,18}))/.exec(text);
  if (!m) return null;
  const boardMap = { LCT616: 'lctech616', BL618: 'aim61', M0S: 'm0sdock' };
  const version = m[3];
  return { raw: m[1], board: boardMap[m[2]], version, usb: m[2] === 'LCT616' ? (version.endsWith('H') ? 'hs' : 'fs') : null };
}

export async function loadFirmwarePackage(zipBytes, { variant } = {}) {
  const files = readZip(zipBytes);
  const config = [...files.keys()].find(name => baseName(name) === 'flash_prog_cfg.ini');
  if (!config) throw new Error('这不是 DS5 接收器固件包（缺少 flash_prog_cfg.ini）。请选择 ds5dongle-*.zip，而不是控制中心程序。');
  const folder = config.slice(0, config.length - 'flash_prog_cfg.ini'.length);
  const folderFiles = [...files.keys()].filter(k => k.startsWith(folder) && !k.slice(folder.length).includes('/')).map(k => k.slice(folder.length));
  const entry = name => { const e = files.get(folder + name); if (!e) throw new Error('固件包缺少 ' + name); return e; };
  const cfg = parseFlashConfig(new TextDecoder().decode(await entry('flash_prog_cfg.ini').data()));
  const nameOf = section => {
    const value = cfg[section] && cfg[section].filedir;
    const raw = value && baseName(value.replace(/\\/g, '/'));
    if (!raw || /\$/.test(raw)) throw new Error('flash_prog_cfg.ini 的 ' + section + ' 配置不完整');
    if (!raw.includes('*')) return raw;
    const pattern = new RegExp('^' + raw.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    const hits = folderFiles.filter(n => pattern.test(n));
    if (!hits.length) throw new Error('flash_prog_cfg.ini 的 ' + section + ' 未匹配到文件');
    if (hits.length > 1) throw new Error('flash_prog_cfg.ini 的 ' + section + ' 匹配到多个文件');
    return hits[0];
  };
  const hasSums = files.has(folder + 'SHA256SUMS');
  const sums = new Map();
  if (hasSums) {
    for (const line of new TextDecoder().decode(await entry('SHA256SUMS').data()).split(/\r?\n/)) {
      const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
      if (m) sums.set(m[2], m[1].toLowerCase());
    }
  }
  let info = {};
  if (files.has(folder + 'build-info.json')) {
    try { info = JSON.parse(new TextDecoder().decode(await files.get(folder + 'build-info.json').data())); } catch { throw new Error('build-info.json 无法解析'); }
  }
  const load = async (name, kind) => {
    const data = await entry(name).data();
    if (!data.length) throw new Error(name + ' 为空');
    if (hasSums && sums.get(name) !== await sha256(data)) throw new Error(name + ' 与包内 SHA256SUMS 不一致，文件可能损坏或被修改');
    if (kind && !magic(data, kind)) throw new Error(name + ' 缺少 BL616 启动头');
    return data;
  };
  const bootName = nameOf('boot2'), partitionName = nameOf('partition'), defaultFw = nameOf('FW');
  const variants = [];
  if (/\.bin$/i.test(defaultFw)) {
    const base = /-hs\.bin$/i.test(defaultFw) ? defaultFw.slice(0, -7) : defaultFw.slice(0, -4);
    if (files.has(folder + base + '.bin')) variants.push({ id: 'fs', label: '全速 FS', name: base + '.bin' });
    if (files.has(folder + base + '-hs.bin')) variants.push({ id: 'hs', label: '高速 HS', name: base + '-hs.bin' });
  }
  if (variant && variants.length && !variants.some(v => v.id === variant)) throw new Error('固件包内没有所选的 ' + String(variant).toUpperCase() + ' 变体');
  const picked = (variant && variants.find(v => v.id === variant)) || variants.find(v => v.id === 'hs') || variants.find(v => v.name === defaultFw) || { id: /-hs\.bin$/i.test(defaultFw) ? 'hs' : 'fs', label: /-hs\.bin$/i.test(defaultFw) ? '高速 HS' : '全速 FS', name: defaultFw };
  const firmwareName = picked.name;
  if (parseInt(cfg.boot2.address, 16) !== BOOT2_ADDRESS || parseInt(cfg.partition.address, 16) !== PARTITION_ADDRESS)
    throw new Error('固件包的 Boot2 / 分区表地址与本工具支持的 4 MiB 布局不一致');
  const boot2 = await load(bootName, 'BFNP'), partition = await load(partitionName, 'BFPT'), firmware = await load(firmwareName, 'BFNP');
  const fw = parsePartitionTable(partition).find(e => e.type === 0 && e.name === 'FW');
  if (!fw) throw new Error('分区表中没有 FW 分区');
  const address = fw.address[fw.active ? 1 : 0], capacity = fw.maxLength[fw.active ? 1 : 0];
  if (boot2.length > BOOT2_LIMIT) throw new Error('Boot2 超出 0xE000 保留区');
  if (!capacity || firmware.length > capacity || address % 4096) throw new Error('主固件与分区表不匹配');
  const embedded = extractAppVersion(firmware);
  return {
    info, folder, integrity: hasSums ? 'sha256sums' : 'none', variant: picked.id, variants, embedded,
    images: {
      boot2: { name: bootName, address: BOOT2_ADDRESS, data: boot2 },
      partition: { name: partitionName, address: PARTITION_ADDRESS, data: partition },
      firmware: { name: firmwareName, address, data: firmware },
    },
  };
}
