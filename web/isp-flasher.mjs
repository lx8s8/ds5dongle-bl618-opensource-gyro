// BL616 boot ROM ISP flashing over Web Serial.
// Command set and framing follow Bouffalo's open-source bflb-mcu-tool (Apache-2.0).
export const CMD = {
  getBootInfo: 0x10, reset: 0x21, clkSet: 0x22, setTimeout: 0x23,
  flashErase: 0x30, flashWrite: 0x31, flashRead: 0x32, flashReadJid: 0x36, flashWriteCheck: 0x3a,
  flashSetPara: 0x3b, flashChipErase: 0x3c, flashXipReadSha: 0x3e, memoryWrite: 0x50,
  flashXipReadStart: 0x60, flashXipReadFinish: 0x61,
};
export const CHUNK = 2048;
export const BAUD = 115200;
export const USB_FILTERS = [
  { usbVendorId: 0x349b }, // Bouffalo ROM ISP (CDC)
  { usbVendorId: 0x1a86 }, { usbVendorId: 0x10c4 }, { usbVendorId: 0x0403 }, // common USB-UART bridges
];
const ERRORS = { '0103': '校验和错误', '000c': '写失败或地址未对齐', '0a0a': '芯片已被保护', '0006': '超时' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const le32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

export function packCommand(id, payload = [], checksum = true) {
  const length = payload.length;
  let sum = 0;
  if (checksum) { sum = (length & 255) + (length >> 8); for (const b of payload) sum += b; }
  const out = new Uint8Array(4 + length);
  out.set([id, sum & 255, length & 255, length >> 8]);
  out.set(payload, 4);
  return out;
}

export class WebSerialLink {
  constructor(port) { this.port = port; this.onData = () => {}; this.onDisconnect = () => {}; }
  async open(baudRate = BAUD) {
    await this.port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 1 << 20 });
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this.pump = (async () => {
      try { for (;;) { const { value, done } = await this.reader.read(); if (done) break; if (value && value.length) this.onData(value); } }
      catch { this.onDisconnect(); }
    })();
  }
  async write(bytes, timeout = 4000) {
    let timer;
    const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('串口写入超时，接收器已停止取数')), timeout); });
    try { await Promise.race([this.writer.write(bytes), guard]); } finally { clearTimeout(timer); }
  }
  async close() {
    try { await this.reader?.cancel(); } catch {}
    try { await Promise.race([this.pump, sleep(300)]); } catch {}
    try { this.reader?.releaseLock(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port.close(); } catch {}
  }
}

export class IspClient {
  constructor(link, log = () => {}) {
    this.link = link; this.log = log; this.rx = new Uint8Array(0); this.waiters = [];
    link.onData = chunk => {
      const next = new Uint8Array(this.rx.length + chunk.length);
      next.set(this.rx); next.set(chunk, this.rx.length); this.rx = next;
      this.waiters.splice(0).forEach(wake => wake());
    };
  }
  drop() { this.rx = new Uint8Array(0); }
  async more(timeout) { await Promise.race([new Promise(resolve => this.waiters.push(resolve)), sleep(timeout)]); }
  async need(count, deadline, what) {
    while (this.rx.length < count) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('等待超时：' + what);
      await this.more(Math.min(left, 100));
    }
  }
  take(count) { const out = this.rx.slice(0, count); this.rx = this.rx.slice(count); return out; }
  // Reads "OK" (plus optional length-prefixed data) while tolerating "PD" pending notices.
  async response(timeout, what, { data = false, pending = false } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      await this.need(2, deadline, what);
      const [a, b] = this.rx;
      if (a === 0x4f && b === 0x4b) {
        this.take(2);
        if (!data) return null;
        await this.need(2, deadline, what + ' 长度');
        const length = this.rx[0] | (this.rx[1] << 8);
        await this.need(2 + length, deadline, what + ' 数据');
        return this.take(2 + length).slice(2);
      }
      if (a === 0x50 && b === 0x44) { this.take(2); if (!pending) throw new Error(what + '：设备繁忙'); continue; }
      if (a === 0x46 && b === 0x4c) {
        await this.need(4, deadline, what + ' 错误码');
        const code = this.take(4); const key = code[3].toString(16).padStart(2, '0') + code[2].toString(16).padStart(2, '0');
        throw new Error(what + ' 失败：FL' + key + (ERRORS[key] ? '（' + ERRORS[key] + '）' : ''));
      }
      this.take(1); // discard noise ahead of a response
    }
  }
  async call(id, payload, { checksum = true, timeout = 2000, what = '命令 0x' + id.toString(16), data = false, pending = false } = {}) {
    this.drop();
    await this.link.write(packCommand(id, payload, checksum));
    return this.response(timeout, what, { data, pending });
  }
}

export class Flasher {
  constructor(link, { log = () => {}, progress = () => {} } = {}) {
    this.isp = new IspClient(link, log); this.log = log; this.progress = progress; this.link = link; this.ready = false;
    this.disconnected = false; link.onDisconnect = () => { this.disconnected = true; };
  }
  async synchronize() {
    for (let i = 0; i < 3; i++) { try { return await this.readBootInfo(400); } catch {} }
    this.log('设备没有回应，改用 0x55 同步…');
    const sync = new Uint8Array(Math.max(16, Math.floor(0.006 * BAUD / 10))).fill(0x55);
    let synced = false;
    for (let i = 0; i < 4 && !synced; i++) {
      this.isp.drop(); await this.link.write(sync);
      try { await this.isp.response(300, '握手'); synced = true; } catch { await sleep(200); }
    }
    if (!synced) throw new Error('同步失败：接收器没有进入 ISP 模式。请按住 BOOT 键重新插入 USB 后再试。');
    await sleep(500);
    return this.readBootInfo(2000);
  }
  async readBootInfo(timeout) {
    const d = await this.isp.call(CMD.getBootInfo, [], { checksum: false, timeout, data: true, what: '读取启动信息' });
    if (d.length < 18) throw new Error('启动信息长度异常：' + d.length);
    if (d[0] === 255 && d[1] === 255 && d[2] === 255 && d[3] === 255) throw new Error('设备状态异常，请断电后重新进入 ISP 模式');
    const switches = (d[8] | (d[9] << 8) | (d[10] << 16) | (d[11] << 24)) >>> 0;
    this.info = {
      a0: d[0] === 1, sign: d[4], encrypt: d[5], flashPin: (switches >>> 14) & 0x3f,
      chipId: hex(Array.from(d.slice(12, 18)).reverse()).toUpperCase(),
    };
    return this.info;
  }
  async setWait(ms) {
    if (this.info.a0) await this.isp.call(CMD.memoryWrite, [...le32(0x6102df04), ...le32(((ms & 0xffff) << 12) | 0x1200)], { checksum: false, what: '设置超时' });
    else await this.isp.call(CMD.setTimeout, le32(ms), { checksum: false, what: '设置超时' });
  }
  async connect() {
    this.progress(0.03, '读取启动信息');
    const info = await this.synchronize();
    this.log('芯片 ID ' + info.chipId + '，签名 ' + info.sign + '，加密 ' + info.encrypt);
    if (info.sign || info.encrypt) throw new Error('这颗芯片启用了签名或加密，网页刷写的未签名固件无法启动，已停止');
    await this.setWait(10000);
    await this.isp.call(CMD.clkSet, [1, 0, 0, 0, ...le32(BAUD)], { what: '设置时钟' });
    await this.isp.call(CMD.flashSetPara, le32(((info.flashPin & 255) | (0x41 << 8) | (1 << 16) | (1 << 24)) >>> 0), { what: '设置 Flash 参数' });
    const jid = await this.isp.call(CMD.flashReadJid, [], { what: '读取 Flash ID', data: true });
    if (jid.length < 4) throw new Error('Flash ID 长度异常');
    const same = v => jid[0] === v && jid[1] === v && jid[2] === v;
    if (same(0) || same(255)) throw new Error('Flash 识别失败：' + hex(jid));
    const level = (jid[2] & 0x1f) - 0x13;
    this.flashSize = level >= 0 && level <= 8 ? (1 << level) * 512 * 1024 : 0;
    this.log('Flash ' + hex(jid.slice(0, 3)) + (this.flashSize ? '（' + this.flashSize / 1048576 + ' MiB）' : ''));
    this.ready = true;
  }
  async erase(start, end, whole = false) {
    this.isp.drop();
    await this.link.write(packCommand(whole ? CMD.flashChipErase : CMD.flashErase, whole ? [] : [...le32(start), ...le32(end)]));
    await this.isp.response(100000, '擦除 Flash', { pending: true });
  }
  async writeChunk(address, data) {
    const payload = new Uint8Array(4 + data.length); payload.set(le32(address)); payload.set(data, 4);
    for (let attempt = 1; ; attempt++) {
      try { return await this.isp.call(CMD.flashWrite, payload, { timeout: 4000, what: '写入 0x' + address.toString(16) }); }
      catch (e) {
        if (attempt === 3 || this.disconnected) throw new Error('写入 0x' + address.toString(16) + ' 失败，已停止：' + e.message);
        this.log('写入 0x' + address.toString(16) + ' 失败，重试（' + e.message + '）'); await sleep(50);
      }
    }
  }
  async deviceSha(address, length) {
    await this.isp.call(CMD.flashXipReadStart, [], { what: '开始读回' });
    try {
      const d = await this.isp.call(CMD.flashXipReadSha, [...le32(address), ...le32(length)], { timeout: Math.max(5000, 4000 * (length / 2097152 + 1)), what: '读取 SHA256', data: true });
      if (d.length !== 32) throw new Error('SHA256 应答长度异常');
      return hex(d);
    } finally { try { await this.isp.call(CMD.flashXipReadFinish, [], { what: '结束读回' }); } catch {} }
  }
  async readChunk(address, length) {
    for (let attempt = 1; ; attempt++) {
      try {
        const d = await this.isp.call(CMD.flashRead, [...le32(address), ...le32(length)], { timeout: 4000, what: '读取 0x' + address.toString(16), data: true });
        if (d.length !== length) throw new Error('读取长度异常：' + d.length + '/' + length);
        return d;
      } catch (e) {
        if (attempt === 3 || this.disconnected) throw new Error('读取 0x' + address.toString(16) + ' 失败，已停止：' + e.message);
        this.log('读取 0x' + address.toString(16) + ' 失败，重试（' + e.message + '）'); await sleep(50);
      }
    }
  }
  async verifyDeviceSha(address, data, what) {
    const local = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
    let remote = await this.deviceSha(address, data.length);
    if (remote !== local) { this.log('SHA256 不一致，复读一次'); remote = await this.deviceSha(address, data.length); }
    if (remote !== local) throw new Error(what + ' 校验失败');
  }
  async readFlash(address, length, { label = '读取 Flash', verify = true, base = 0, span = 1 } = {}) {
    if (!length || address < 0) throw new Error('读取参数无效');
    if (this.flashSize && address + length > this.flashSize) throw new Error('读取范围超出 Flash 容量');
    const out = new Uint8Array(length);
    await this.setWait(4000);
    for (let offset = 0; offset < length; offset += CHUNK) {
      if (this.disconnected) throw new Error('接收器已断开');
      const size = Math.min(CHUNK, length - offset);
      const chunk = await this.readChunk(address + offset, size);
      out.set(chunk, offset);
      this.progress(base + span * 0.9 * (offset + size) / length, label + ' ' + Math.round(100 * (offset + size) / length) + '%');
    }
    if (verify) {
      this.progress(base + span * 0.95, '校验 ' + label);
      await this.verifyDeviceSha(address, out, label + ' 读回');
    }
    this.progress(base + span, label + ' 完成');
    return out;
  }
  async resetDevice() {
    this.progress(0.99, '重启接收器');
    await this.isp.call(CMD.memoryWrite, [...le32(0x2000f108), ...le32(0)], { checksum: false, what: '清除启动标记' });
    try { await this.isp.call(CMD.reset, [], { timeout: 500, what: '复位' }); } catch {}
    this.progress(1, '完成');
  }
  async program(images, { reset = true, base = 0.1, span = 0.88 } = {}) {
    const total = images.reduce((sum, image) => sum + image.data.length, 0);
    if (!total) throw new Error('没有可写入的文件');
    for (const image of images) {
      if (this.flashSize && image.address + image.data.length > this.flashSize) throw new Error(image.name + ' 超出 Flash 容量');
      if (image.address % 4096) throw new Error(image.name + ' 起始地址未按 4 KiB 对齐');
    }
    const started = Date.now(); let done = 0;
    for (const image of images) {
      const start = base + span * done / total, width = span * image.data.length / total;
      this.log('写入 ' + image.name + ' → 0x' + image.address.toString(16).padStart(6, '0') + '（' + image.data.length + ' 字节）');
      this.progress(start, '擦除 ' + image.name);
      await this.erase(image.address, image.address + image.data.length - 1);
      await this.setWait(4000);
      for (let offset = 0; offset < image.data.length; offset += CHUNK) {
        if (this.disconnected) throw new Error('接收器已断开');
        const chunk = image.data.subarray(offset, Math.min(offset + CHUNK, image.data.length));
        await this.writeChunk(image.address + offset, chunk);
        this.progress(start + width * 0.9 * (offset + chunk.length) / image.data.length, '写入 ' + image.name + ' ' + Math.round(100 * (offset + chunk.length) / image.data.length) + '%');
      }
      await this.isp.call(CMD.flashWriteCheck, [], { timeout: 4000, what: '确认写入' });
      this.progress(start + width * 0.95, '校验 ' + image.name);
      try { await this.verifyDeviceSha(image.address, image.data, image.name + ' 读回'); }
      catch { throw new Error(image.name + ' 读回校验失败，请重新刷写；未重启设备'); }
      this.log(image.name + ' 校验一致');
      done += image.data.length;
    }
    if (reset) await this.resetDevice();
    this.log('刷写完成，用时 ' + ((Date.now() - started) / 1000).toFixed(1) + ' 秒');
  }
}
