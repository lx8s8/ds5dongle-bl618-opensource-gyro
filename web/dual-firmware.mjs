import { crc32 } from './zip-reader.mjs';
import { extractAppVersion } from './firmware-package.mjs';

export const FLASH_SIZE = 0x400000;
export const SECTOR_SIZE = 0x1000;
export const ROOT_LIMIT = 0xE000;
export const ROOT_MARKER = 'DS5-DBM1-ROOT\0\0\0';
export const PT_ADDRESS = [0xE000, 0xF000];
export const SLOT_ADDRESS = [0x10000, 0x210000];
export const SLOT_CAPACITY = [0x140000, 0x120000];
export const DATA_NAMES = ['PSM', 'KEY', 'DATA', 'media'];
export const DATA_TYPES = [3, 4, 5, 2];
export const DATA_LENGTH = [0x8000, 0x2000, 0x5000, 0x71000];
export const DATA_ADDRESS = [
  [0x330000, 0x338000, 0x33A000, 0x150000],
  [0x3E9000, 0x3F1000, 0x3F3000, 0x378000],
];
export const RECORD_ADDRESS = [0x340000, 0x341000];
export const RECORD_SIZE = 256;
export const DBM1_BOARD_LCTECH616 = 1;

const textDec = new TextDecoder('latin1');
const textEnc = new TextEncoder();
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const w16le = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; };
const w32le = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const isBlank = b => b.every(v => v === 255);
const cstr = b => { const z = b.indexOf(0); return textDec.decode(z < 0 ? b : b.subarray(0, z)); };

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export function normalizeSlotVersion(raw, label = '版本号') {
  let s = String(raw || '').trim().replace(/\0.*$/, '');
  if (/^(LCT616|BL618|M0S)-DS5 /.test(s)) s = s.replace(/^(LCT616|BL618|M0S)-DS5 /, '');
  if (!s || s.length > 19 || !/^[\x20-\x7e]+$/.test(s)) {
    throw new Error(label + '无效（需要 1–19 个 ASCII 字符）');
  }
  return s;
}

export function hasRootMarker(bytes) {
  return bytes.length >= 0xFF0 && textDec.decode(bytes.subarray(0xFE0, 0xFF0)) === ROOT_MARKER;
}

async function checkBfnpCommon(bytes, label) {
  if (bytes.length < 256) throw new Error(label + '长度不足 256 字节');
  if (textDec.decode(bytes.subarray(0, 4)) !== 'BFNP') throw new Error(label + '缺少 BFNP 启动头');
  if (crc32(bytes.subarray(0, 252)) !== u32le(bytes, 252)) throw new Error(label + '启动头 CRC32 校验失败');
  const flags = u32le(bytes, 120), offset = u32le(bytes, 124), payloadLength = u32le(bytes, 132);
  if ((flags & 0x0f) !== 0) throw new Error(label + '启用了加密或签名，当前双固件模式不支持');
  if (!payloadLength || offset + payloadLength > bytes.length) throw new Error(label + '启动头偏移或长度与文件不符');
  const hashIgnored = (flags & 0x20000) !== 0;
  if (!hashIgnored) {
    const digest = await sha256(bytes.subarray(offset, offset + payloadLength));
    if (!same(digest, bytes.subarray(136, 168))) throw new Error(label + '载荷 SHA256 与启动头不一致');
  }
  return { flags, offset, payloadLength, hashIgnored };
}

export async function validateManagerImage(bytes) {
  if (bytes.length > ROOT_LIMIT) throw new Error('启动管理器镜像超出 0xE000 保留区上限');
  if (!hasRootMarker(bytes)) throw new Error('所选文件不是 DS5 实验性双固件启动管理器（缺少 DS5-DBM1-ROOT 标记）');
  const hdr = await checkBfnpCommon(bytes, '启动管理器');
  if (hdr.offset !== 0x2000 || hdr.offset + hdr.payloadLength !== bytes.length) {
    throw new Error('启动管理器载荷偏移或长度不符合 0x2000 根布局');
  }
  if ((hdr.flags & 0x30000) !== 0 || hdr.hashIgnored) {
    throw new Error('启动管理器必须启用 BootROM SHA256 校验');
  }
  return hdr;
}

export async function validateAppImage(bytes, { maxLength = SLOT_CAPACITY[0], label = '固件', requireLctech = true } = {}) {
  if (bytes.length > maxLength) throw new Error(label + '（' + bytes.length + ' B）超出目标槽位上限 ' + maxLength + ' B');
  const hdr = await checkBfnpCommon(bytes, label);
  if (hdr.offset !== 0x1000) throw new Error(label + '启动偏移必须是 0x1000');
  const embedded = extractAppVersion(bytes);
  if (embedded && embedded.board !== 'lctech616') {
    throw new Error(label + '为 ' + embedded.board + ' 板型，双固件当前仅支持 lctech616');
  }
  if (requireLctech && !embedded) throw new Error(label + '未检测到 LCT616-DS5 版本标识');
  return { ...hdr, embedded };
}

export function parseStrictPartitionTable(bytes) {
  if (bytes.length < 20 || textDec.decode(bytes.subarray(0, 4)) !== 'BFPT') throw new Error('分区表缺少 BFPT 头');
  const version = u16le(bytes, 4), count = u16le(bytes, 6), age = u32le(bytes, 8), hcrc = u32le(bytes, 12);
  if (version !== 0 || count < 1 || count > 16 || 16 + count * 36 + 4 > bytes.length) {
    throw new Error('分区表条目数量或版本异常');
  }
  if (crc32(bytes.subarray(0, 12)) !== hcrc) throw new Error('分区表头 CRC32 校验失败');
  const entriesLen = count * 36;
  if (crc32(bytes.subarray(16, 16 + entriesLen)) !== u32le(bytes, 16 + entriesLen)) {
    throw new Error('分区表内容 CRC32 校验失败');
  }
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = 16 + i * 36;
    entries.push({
      type: bytes[o],
      device: bytes[o + 1],
      active: bytes[o + 2],
      name: cstr(bytes.subarray(o + 3, o + 12)),
      address: [u32le(bytes, o + 12), u32le(bytes, o + 16)],
      maxLength: [u32le(bytes, o + 20), u32le(bytes, o + 24)],
      length: u32le(bytes, o + 28),
      age: u32le(bytes, o + 32),
    });
  }
  return { version, age, entries };
}

export function encodePartitionTable({ version = 0, age = 0, entries }, padTo = 0) {
  const rawLen = 16 + entries.length * 36 + 4;
  const out = new Uint8Array(Math.max(rawLen, padTo)).fill(255);
  out.set(textEnc.encode('BFPT'), 0);
  w16le(out, 4, version);
  w16le(out, 6, entries.length);
  w32le(out, 8, age);
  w32le(out, 12, crc32(out.subarray(0, 12)));
  entries.forEach((e, i) => {
    const o = 16 + i * 36;
    out.fill(0, o, o + 36);
    out[o] = e.type & 255;
    out[o + 1] = (e.device || 0) & 255;
    out[o + 2] = (e.active || 0) & 255;
    out.set(textEnc.encode(e.name).subarray(0, 8), o + 3);
    w32le(out, o + 12, e.address[0] >>> 0);
    w32le(out, o + 16, (e.address[1] || 0) >>> 0);
    w32le(out, o + 20, e.maxLength[0] >>> 0);
    w32le(out, o + 24, (e.maxLength[1] || 0) >>> 0);
    w32le(out, o + 28, (e.length || 0) >>> 0);
    w32le(out, o + 32, (e.age || 0) >>> 0);
  });
  w32le(out, 16 + entries.length * 36, crc32(out.subarray(16, 16 + entries.length * 36)));
  return out;
}

export function parseRecord(bytes) {
  if (bytes.length < RECORD_SIZE || textDec.decode(bytes.subarray(0, 4)) !== 'DBM1') return null;
  if (u16le(bytes, 4) !== 1 || u16le(bytes, 6) !== RECORD_SIZE) return null;
  if (crc32(bytes.subarray(0, 252)) !== u32le(bytes, 252)) return null;
  const gen = u32le(bytes, 8), selected = bytes[12], board = bytes[13], manage = bytes[14];
  if (selected > 1 || board !== DBM1_BOARD_LCTECH616 || manage > 1 || bytes[15] !== 0) return null;
  for (let i = 144; i < 252; i++) if (bytes[i] !== 0) return null;
  const images = [];
  for (let i = 0; i < 2; i++) {
    const o = 16 + i * 64;
    const addr = u32le(bytes, o), cap = u32le(bytes, o + 4), len = u32le(bytes, o + 8);
    if (addr !== SLOT_ADDRESS[i] || cap !== SLOT_CAPACITY[i] || !len || len > cap) return null;
    const sha = bytes.slice(o + 12, o + 44);
    const version = cstr(bytes.subarray(o + 44, o + 64));
    if (!version) return null;
    images.push({ addr, cap, len, sha256: sha, version });
  }
  return { gen, selected, board, manage, images };
}

export function encodeRecord(rec) {
  if (rec.selected > 1 || rec.manage > 1 || rec.images.length !== 2) throw new Error('DBM1 记录无效');
  const out = new Uint8Array(RECORD_SIZE);
  out.set(textEnc.encode('DBM1'), 0);
  w16le(out, 4, 1);
  w16le(out, 6, RECORD_SIZE);
  w32le(out, 8, rec.gen >>> 0);
  out[12] = rec.selected & 1;
  out[13] = rec.board ?? DBM1_BOARD_LCTECH616;
  out[14] = rec.manage & 1;
  out[15] = 0;
  rec.images.forEach((img, i) => {
    const o = 16 + i * 64;
    const ver = normalizeSlotVersion(img.version, '槽位 ' + i + ' 版本');
    if (img.sha256.length !== 32) throw new Error('槽位 ' + i + ' SHA256 长度无效');
    w32le(out, o, SLOT_ADDRESS[i]);
    w32le(out, o + 4, SLOT_CAPACITY[i]);
    w32le(out, o + 8, img.len >>> 0);
    out.set(img.sha256, o + 12);
    out.set(textEnc.encode(ver), o + 44);
  });
  w32le(out, 252, crc32(out.subarray(0, 252)));
  return out;
}

export function readActiveRecord(copy0, copy1) {
  const r0 = parseRecord(copy0), r1 = parseRecord(copy1);
  if (!r0 && !r1) return null;
  if (r0 && !r1) return { record: r0, activeCopy: 0 };
  if (!r0 && r1) return { record: r1, activeCopy: 1 };
  return (r0.gen >>> 0) >= (r1.gen >>> 0) ? { record: r0, activeCopy: 0 } : { record: r1, activeCopy: 1 };
}

function checkEntries(entries, expected) {
  const byName = new Map(entries.map(e => [e.name, e]));
  for (const [name, type, a0, a1, s0, s1] of expected) {
    const e = byName.get(name);
    if (!e || e.type !== type || e.address[0] !== a0 || (a1 !== null && e.address[1] !== a1) || e.maxLength[0] !== s0 || (s1 !== null && e.maxLength[1] !== s1)) {
      throw new Error('分区表与期望的 4 MiB BL616 布局不匹配（' + name + '）');
    }
  }
  return byName;
}

export function expectedStock(flash) {
  if (flash.length !== FLASH_SIZE) throw new Error('镜像长度必须为 4 MiB（4194304 字节）');
  if (hasRootMarker(flash)) throw new Error('此闪存已安装双固件启动管理器');
  if (parseRecord(flash.subarray(RECORD_ADDRESS[0], RECORD_ADDRESS[0] + RECORD_SIZE)) ||
      parseRecord(flash.subarray(RECORD_ADDRESS[1], RECORD_ADDRESS[1] + RECORD_SIZE))) {
    throw new Error('此闪存已存在 DBM1 双固件记录，请先恢复单固件再重新安装');
  }
  const pt0 = parseStrictPartitionTable(flash.subarray(PT_ADDRESS[0], PT_ADDRESS[0] + SECTOR_SIZE));
  const pt1Raw = flash.subarray(PT_ADDRESS[1], PT_ADDRESS[1] + SECTOR_SIZE);
  const hasPt1 = !isBlank(pt1Raw);
  const pt1 = hasPt1 ? parseStrictPartitionTable(pt1Raw) : null;
  const activePt = pt1 && pt1.age > pt0.age ? pt1 : pt0;
  checkEntries(activePt.entries, [
    ['Boot2', 16, 0, 0, 0xE000, 0],
    ['FW', 0, 0x10000, null, 0x200000, null],
    ['media', 2, DATA_ADDRESS[1][3], 0, DATA_LENGTH[3], 0],
    ['PSM', 3, DATA_ADDRESS[1][0], 0, DATA_LENGTH[0], 0],
    ['KEY', 4, DATA_ADDRESS[1][1], 0, DATA_LENGTH[1], 0],
    ['DATA', 5, DATA_ADDRESS[1][2], 0, DATA_LENGTH[2], 0],
    ['factory', 6, 0x3F8000, 0, 0x8000, 0],
  ]);
  return { pt: activePt, pt0, hasPt1 };
}

function makeDualPartitionTable(stockEntries, age = 0) {
  const byName = new Map(stockEntries.map(e => [e.name, e]));
  const factory = byName.get('factory') || { type: 6, device: 0, active: 0, name: 'factory', address: [0x3F8000, 0], maxLength: [0x8000, 0], length: 0, age: 0 };
  const boot2 = byName.get('Boot2') || { type: 16, device: 0, active: 0, name: 'Boot2', address: [0, 0], maxLength: [0xE000, 0], length: 0, age: 0 };
  const entries = [
    { ...boot2, active: 0 },
    { type: 0, device: 0, active: 0, name: 'FW', address: [...SLOT_ADDRESS], maxLength: [...SLOT_CAPACITY], length: 0, age: 0 },
    ...DATA_NAMES.slice().sort((a, b) => DATA_TYPES[DATA_NAMES.indexOf(a)] - DATA_TYPES[DATA_NAMES.indexOf(b)]).map(name => {
      const k = DATA_NAMES.indexOf(name);
      return {
        type: DATA_TYPES[k], device: 0, active: 0, name,
        address: [DATA_ADDRESS[0][k], DATA_ADDRESS[1][k]],
        maxLength: [DATA_LENGTH[k], DATA_LENGTH[k]],
        length: 0, age: 0,
      };
    }),
    { ...factory, active: 0 },
  ];
  return encodePartitionTable({ version: 0, age, entries }, SECTOR_SIZE);
}

export function inspectDualState({ rootHead, pt0, pt1, rec0, rec1 }) {
  const hasMarker = hasRootMarker(rootHead);
  let pt = null;
  for (const s of [pt0, pt1]) {
    if (!s || isBlank(s)) continue;
    try {
      const parsed = parseStrictPartitionTable(s);
      if (!pt || parsed.age >= pt.age) pt = parsed;
    } catch {}
  }
  const active = readActiveRecord(rec0, rec1);
  if (hasMarker && active && pt) {
    try {
      checkEntries(pt.entries, [
        ['Boot2', 16, 0, 0, 0xE000, 0],
        ['FW', 0, SLOT_ADDRESS[0], SLOT_ADDRESS[1], SLOT_CAPACITY[0], SLOT_CAPACITY[1]],
        ['PSM', DATA_TYPES[0], DATA_ADDRESS[0][0], DATA_ADDRESS[1][0], DATA_LENGTH[0], DATA_LENGTH[0]],
        ['KEY', DATA_TYPES[1], DATA_ADDRESS[0][1], DATA_ADDRESS[1][1], DATA_LENGTH[1], DATA_LENGTH[1]],
        ['DATA', DATA_TYPES[2], DATA_ADDRESS[0][2], DATA_ADDRESS[1][2], DATA_LENGTH[2], DATA_LENGTH[2]],
        ['media', DATA_TYPES[3], DATA_ADDRESS[0][3], DATA_ADDRESS[1][3], DATA_LENGTH[3], DATA_LENGTH[3]],
      ]);
      return { mode: 'dual', pt, ...active };
    } catch {}
  }
  return { mode: hasMarker || active ? 'partial' : 'stock', hasMarker, pt, ...(active || { record: null, activeCopy: -1 }) };
}

export function diffPlan(before, after) {
  if (before.length !== FLASH_SIZE || after.length !== FLASH_SIZE) throw new Error('diffPlan 需要两个 4 MiB 镜像');
  const ranges = [
    [0x10000, FLASH_SIZE, '双固件区'],
    [0xE000, 0x10000, '分区表'],
    [0x1000, ROOT_LIMIT, '启动管理器载荷'],
    [0x0000, 0x1000, '启动管理器头'],
  ];
  const segments = [];
  for (const [start, end, prefix] of ranges) {
    let segStart = -1;
    for (let addr = start; addr <= end; addr += SECTOR_SIZE) {
      const changed = addr < end && !same(before.subarray(addr, addr + SECTOR_SIZE), after.subarray(addr, addr + SECTOR_SIZE));
      if (changed && segStart < 0) segStart = addr;
      if (!changed && segStart >= 0) {
        segments.push({
          name: prefix + ' @0x' + segStart.toString(16),
          address: segStart,
          data: after.slice(segStart, addr),
        });
        segStart = -1;
      }
    }
  }
  return segments;
}

export async function buildInstallImage({
  snapshot, manager, gyro, upstream, gyroVersion, upstreamVersion, upstreamSnapshot = null, requireLctech = true,
}) {
  const stock = expectedStock(snapshot);
  await validateManagerImage(manager);
  await validateAppImage(gyro, { maxLength: SLOT_CAPACITY[0], label: '体感固件', requireLctech });
  await validateAppImage(upstream, { maxLength: SLOT_CAPACITY[1], label: '上游固件', requireLctech });
  if (upstreamSnapshot) expectedStock(upstreamSnapshot);

  const v0 = normalizeSlotVersion(gyroVersion, '体感版本号');
  const v1 = normalizeSlotVersion(upstreamVersion, '上游版本号');
  const [sha0, sha1] = await Promise.all([sha256(gyro), sha256(upstream)]);

  const after = snapshot.slice();
  after.fill(255, 0, ROOT_LIMIT);
  after.set(manager, 0);

  const dualPt = makeDualPartitionTable(stock.pt.entries, 0);
  after.set(dualPt, PT_ADDRESS[0]);
  after.set(dualPt, PT_ADDRESS[1]);

  after.fill(255, SLOT_ADDRESS[0], SLOT_ADDRESS[0] + SLOT_CAPACITY[0]);
  after.set(gyro, SLOT_ADDRESS[0]);
  after.fill(255, SLOT_ADDRESS[1], SLOT_ADDRESS[1] + SLOT_CAPACITY[1]);
  after.set(upstream, SLOT_ADDRESS[1]);

  for (let k = 0; k < DATA_NAMES.length; k++) {
    const src = snapshot.subarray(DATA_ADDRESS[1][k], DATA_ADDRESS[1][k] + DATA_LENGTH[k]);
    after.set(src, DATA_ADDRESS[0][k]);
    if (upstreamSnapshot) {
      after.set(upstreamSnapshot.subarray(DATA_ADDRESS[1][k], DATA_ADDRESS[1][k] + DATA_LENGTH[k]), DATA_ADDRESS[1][k]);
    }
  }

  const record = {
    gen: 1, selected: 0, board: DBM1_BOARD_LCTECH616, manage: 0,
    images: [
      { addr: SLOT_ADDRESS[0], cap: SLOT_CAPACITY[0], len: gyro.length, sha256: sha0, version: v0 },
      { addr: SLOT_ADDRESS[1], cap: SLOT_CAPACITY[1], len: upstream.length, sha256: sha1, version: v1 },
    ],
  };
  const recBytes = encodeRecord(record);
  for (const addr of RECORD_ADDRESS) {
    after.fill(255, addr, addr + SECTOR_SIZE);
    after.set(recBytes, addr);
  }
  return { after, record, segments: diffPlan(snapshot, after) };
}

export async function buildSlotUpdate({
  rootHead, pt0, pt1, rec0, rec1, slot, firmware, version, keepManage = false, requireLctech = true,
}) {
  if (slot !== 0 && slot !== 1) throw new Error('槽位必须是 0 或 1');
  const state = inspectDualState({ rootHead, pt0, pt1, rec0, rec1 });
  if (state.mode !== 'dual') throw new Error('设备未安装有效的双固件启动管理器，无法按槽更新');

  await validateAppImage(firmware, { maxLength: SLOT_CAPACITY[slot], label: slot === 0 ? '体感固件' : '上游固件', requireLctech });
  const ver = normalizeSlotVersion(version, '槽位版本号');
  const newSha = await sha256(firmware);

  const prevLen = state.record.images[slot].len;
  const span = Math.min(SLOT_CAPACITY[slot], Math.ceil(Math.max(firmware.length, prevLen) / SECTOR_SIZE) * SECTOR_SIZE);
  const slotData = new Uint8Array(span).fill(255);
  slotData.set(firmware, 0);

  const nextGen = state.record.gen === 0xFFFFFFFF ? 1 : state.record.gen + 1;
  const nextImages = state.record.images.map((img, i) => i === slot
    ? { addr: SLOT_ADDRESS[slot], cap: SLOT_CAPACITY[slot], len: firmware.length, sha256: newSha, version: ver }
    : { ...img, sha256: img.sha256.slice() });
  const nextRecord = {
    gen: nextGen,
    selected: state.record.selected,
    board: DBM1_BOARD_LCTECH616,
    manage: keepManage ? state.record.manage : 0,
    images: nextImages,
  };
  const targetCopy = state.activeCopy === 0 ? 1 : 0;
  const recSector = new Uint8Array(SECTOR_SIZE).fill(255);
  recSector.set(encodeRecord(nextRecord), 0);

  return {
    record: nextRecord,
    targetCopy,
    segments: [
      { name: (slot === 0 ? '槽位0(体感)' : '槽位1(上游)') + ' @0x' + SLOT_ADDRESS[slot].toString(16), address: SLOT_ADDRESS[slot], data: slotData },
      { name: 'DBM1元数据副本' + targetCopy + ' @0x' + RECORD_ADDRESS[targetCopy].toString(16), address: RECORD_ADDRESS[targetCopy], data: recSector },
    ],
  };
}

export async function buildRestoreImage({ current, original, slot = 0, requireLctech = true }) {
  if (current.length !== FLASH_SIZE || original.length !== FLASH_SIZE) throw new Error('当前与原始备份都必须是 4 MiB 镜像');
  if (slot !== 0 && slot !== 1) throw new Error('恢复槽位必须是 0 或 1');
  expectedStock(original);
  const state = inspectDualState({
    rootHead: current.subarray(0, ROOT_LIMIT),
    pt0: current.subarray(PT_ADDRESS[0], PT_ADDRESS[0] + SECTOR_SIZE),
    pt1: current.subarray(PT_ADDRESS[1], PT_ADDRESS[1] + SECTOR_SIZE),
    rec0: current.subarray(RECORD_ADDRESS[0], RECORD_ADDRESS[0] + RECORD_SIZE),
    rec1: current.subarray(RECORD_ADDRESS[1], RECORD_ADDRESS[1] + RECORD_SIZE),
  });
  if (state.mode !== 'dual') throw new Error('当前 4 MiB 镜像不是有效双固件布局');

  const imgMeta = state.record.images[slot];
  const app = current.slice(SLOT_ADDRESS[slot], SLOT_ADDRESS[slot] + imgMeta.len);
  const appSha = await sha256(app);
  if (!same(appSha, imgMeta.sha256)) throw new Error('槽位 ' + slot + ' 镜像 SHA256 与 DBM1 记录不一致，无法安全恢复');
  await validateAppImage(app, { maxLength: 0x200000, label: '待保留主固件', requireLctech });

  const after = original.slice();
  after.fill(255, 0x10000, 0x210000);
  after.set(app, 0x10000);
  for (let k = 0; k < DATA_NAMES.length; k++) {
    after.set(current.subarray(DATA_ADDRESS[slot][k], DATA_ADDRESS[slot][k] + DATA_LENGTH[k]), DATA_ADDRESS[1][k]);
  }
  for (const addr of RECORD_ADDRESS) after.fill(255, addr, addr + SECTOR_SIZE);
  return { after, record: state.record, appLength: app.length, segments: diffPlan(current, after) };
}

// Rebuild a stock layout from a complete firmware package while retaining the
// device-specific factory partition. User settings and pairing are erased.
export async function buildCleanRestoreImage({ current, boot2, partition, firmware }) {
  if (current.length !== FLASH_SIZE) throw new Error('当前闪存必须为 4 MiB');
  if (hasRootMarker(boot2) || boot2.length > ROOT_LIMIT) throw new Error('Boot2 镜像无效');
  await checkBfnpCommon(boot2, 'Boot2');
  await validateAppImage(firmware, { maxLength: 0x200000, label: '单固件' });
  const after = new Uint8Array(FLASH_SIZE).fill(255);
  after.set(current.subarray(0x3F8000), 0x3F8000);
  after.set(boot2, 0);
  if (partition.length > SECTOR_SIZE) throw new Error('分区表过大');
  after.set(partition, PT_ADDRESS[0]);
  after.set(partition, PT_ADDRESS[1]);
  after.set(firmware, 0x10000);
  expectedStock(after);
  return { after, segments: diffPlan(current, after) };
}
