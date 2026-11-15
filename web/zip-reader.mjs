// Minimal in-memory ZIP reader for release packages (stored or deflate, no ZIP64, no encryption).
const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function decodeName(raw, utf8) {
  if (utf8) return new TextDecoder('utf-8', { fatal: false }).decode(raw);
  let s = '';
  for (const b of raw) s += String.fromCharCode(b);
  return s;
}

async function inflateRaw(data, expected) {
  if (typeof DecompressionStream !== 'function') throw new Error('当前浏览器不支持解压 ZIP');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const out = new Uint8Array(expected);
  let used = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (used + value.length > expected) { await reader.cancel(); throw new Error('ZIP 解压后大小超出声明'); }
    out.set(value, used);
    used += value.length;
  }
  if (used !== expected) throw new Error('ZIP 解压后大小与声明不一致');
  return out;
}

export function readZip(bytes, { maxEntrySize = 16 * 1024 * 1024, maxEntries = 512 } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('ZIP 数据必须是 Uint8Array');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
  const count = view.getUint16(eocd + 10, true), cdSize = view.getUint32(eocd + 12, true), cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('不支持 ZIP64 文件');
  if (count > maxEntries || cdOffset + cdSize > eocd) throw new Error('ZIP 目录无效');
  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== CENTRAL) throw new Error('ZIP 目录损坏');
    const flags = view.getUint16(p + 8, true), method = view.getUint16(p + 10, true), crc = view.getUint32(p + 16, true);
    const csize = view.getUint32(p + 20, true), usize = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true), extraLength = view.getUint16(p + 30, true), commentLength = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    if (p + 46 + nameLength > bytes.length) throw new Error('ZIP 目录损坏');
    const name = decodeName(bytes.subarray(p + 46, p + 46 + nameLength), !!(flags & 0x800));
    p += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (entries.has(name)) throw new Error('ZIP 含有重复文件名：' + name);
    if (flags & 1) throw new Error('不支持加密的 ZIP');
    if (method !== 0 && method !== 8) throw new Error('ZIP 压缩方式不受支持：' + name);
    if (csize === 0xffffffff || usize === 0xffffffff) throw new Error('不支持 ZIP64 文件');
    if (usize > maxEntrySize) throw new Error('ZIP 内文件过大：' + name);
    entries.set(name, {
      name, size: usize,
      async data() {
        if (local + 30 > bytes.length || view.getUint32(local, true) !== LOCAL) throw new Error('ZIP 文件头损坏：' + name);
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        if (start + csize > bytes.length) throw new Error('ZIP 数据被截断：' + name);
        const packed = bytes.subarray(start, start + csize);
        let out;
        if (method === 0) {
          if (csize !== usize) throw new Error('ZIP 文件大小不一致：' + name);
          out = packed.slice();
        } else out = await inflateRaw(packed, usize);
        if (crc32(out) !== crc) throw new Error('ZIP 文件校验失败：' + name);
        return out;
      },
    });
  }
  return entries;
}
