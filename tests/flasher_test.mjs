import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { crc32, readZip } from '../web/zip-reader.mjs';
import { extractAppVersion, loadFirmwarePackage, parsePartitionTable } from '../web/firmware-package.mjs';
import { CMD, CHUNK, READ_CHUNK, Flasher, packCommand } from '../web/isp-flasher.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const text = s => new TextEncoder().encode(s);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, data, method = 8] of files) {
    const raw = typeof data === 'string' ? text(data) : data;
    const packed = method === 8 ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc32(raw), 16); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(raw.length, 24); entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, Buffer.from(packed)); central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, directory, end]));
}

// ---- ZIP reader ----
{
  const archive = zip([['dir/a.txt', 'hello hello hello hello'], ['dir/b.bin', Buffer.from([1, 2, 3]), 0], ['dir/', '', 0]]);
  const entries = readZip(archive);
  assert.deepEqual([...entries.keys()], ['dir/a.txt', 'dir/b.bin']);
  assert.equal(new TextDecoder().decode(await entries.get('dir/a.txt').data()), 'hello hello hello hello');
  assert.deepEqual([...await entries.get('dir/b.bin').data()], [1, 2, 3]);
  const bad = archive.slice(); bad[30 + 9 + 2] ^= 0x55; // corrupt compressed data of the first entry
  await assert.rejects(async () => { for (const e of readZip(bad).values()) await e.data(); });
  assert.throws(() => readZip(archive.slice(0, 40)), /ZIP/);
  assert.throws(() => readZip(text('not a zip file at all, definitely')), /ZIP/);
}

// ---- Firmware package ----
const image = (size, seed) => { const a = new Uint8Array(size); for (let i = 0; i < size; i++) a[i] = (i * 7 + seed) & 255; a.set(text('BFNP'), 0); return a; };
function partitionTable() {
  const entries = [['Boot2', 0x10, 0, 0xe000, 0], ['FW', 0, 0x10000, 0x200000, 0x210000]];
  const out = Buffer.alloc(16 + entries.length * 36 + 4); out.write('BFPT', 0); out.writeUInt16LE(entries.length, 6);
  entries.forEach(([name, type, address, size, address1], i) => { const o = 16 + i * 36; out[o] = type; out.write(name, o + 3); out.writeUInt32LE(address, o + 12); out.writeUInt32LE(address1, o + 16); out.writeUInt32LE(size, o + 20); });
  return new Uint8Array(out);
}
const boot2 = image(52576, 1), partition = partitionTable(), firmware = image(5000 + 3, 9);
const iniText = '[cfg]\nerase = 1\n\n[boot2]\nfiledir = ./boot2_bl616_isp_release_v8.1.8.bin\naddress = 0x000000\n\n[partition]\nfiledir = ./partition.bin\naddress = 0xE000\n\n[FW]\nfiledir = ./ds5dongle-aim61.bin\naddress = @partition\n';
function packageZip({ tamper } = {}) {
  const files = { 'boot2_bl616_isp_release_v8.1.8.bin': boot2, 'partition.bin': partition, 'ds5dongle-aim61.bin': firmware };
  const sums = Object.entries(files).map(([n, d]) => sha(d) + '  ' + n).join('\n') + '\n';
  const list = [['pkg/flash_prog_cfg.ini', iniText], ['pkg/SHA256SUMS', sums], ['pkg/build-info.json', '{"board":"aim61","usb_speed":"fs"}'], ...Object.entries(files).map(([n, d]) => ['pkg/' + n, tamper === n ? image(d.length, 99) : d])];
  return zip(list);
}
{
  assert.equal(parsePartitionTable(partition).find(e => e.name === 'FW').address[0], 0x10000);
  const pkg = await loadFirmwarePackage(packageZip());
  assert.equal(pkg.info.board, 'aim61');
  assert.deepEqual([pkg.images.boot2.address, pkg.images.partition.address, pkg.images.firmware.address], [0, 0xe000, 0x10000]);
  assert.equal(pkg.images.firmware.data.length, firmware.length);
  assert.equal(pkg.integrity, 'sha256sums');
  await assert.rejects(loadFirmwarePackage(packageZip({ tamper: 'ds5dongle-aim61.bin' })), /SHA256SUMS/);
  await assert.rejects(loadFirmwarePackage(zip([['DS5-Control-Center/DS5-Control-Center.exe', 'MZ']])), /固件包/);

  // upstream-style zip: wildcards in INI, no SHA256SUMS, dual FS/HS bins, embedded version string
  const stampVersion = (bin, marker) => { const out = bin.slice(); out.set(text(marker + '\0'), 512); return out; };
  const upstreamFs = stampVersion(image(5003, 12), 'LCT616-DS5 3.24');
  const upstreamHs = stampVersion(image(5005, 19), 'LCT616-DS5 3.24H');
  const upstreamIni = '[boot2]\nfiledir = ./boot2_*.bin\naddress = 0x000000\n\n[partition]\nfiledir = ./partition*.bin\naddress = 0xE000\n\n[FW]\nfiledir = ./ds5dongle-lctech616.bin\naddress = @partition\n';
  const upstreamZip = zip([
    ['up/flash_prog_cfg.ini', upstreamIni],
    ['up/boot2_bl616_isp_release_v8.1.8.bin', boot2],
    ['up/partition.bin', partition],
    ['up/ds5dongle-lctech616.bin', upstreamFs],
    ['up/ds5dongle-lctech616-hs.bin', upstreamHs],
  ]);
  const ufs = await loadFirmwarePackage(upstreamZip);
  assert.equal(ufs.integrity, 'none');
  assert.equal(ufs.variant, 'fs');
  assert.deepEqual(ufs.variants.map(v => v.id), ['fs', 'hs']);
  assert.equal(ufs.embedded.raw, 'LCT616-DS5 3.24');
  assert.equal(ufs.embedded.board, 'lctech616');
  assert.equal(ufs.embedded.usb, 'fs');
  const uhs = await loadFirmwarePackage(upstreamZip, { variant: 'hs' });
  assert.equal(uhs.variant, 'hs');
  assert.equal(uhs.images.firmware.name, 'ds5dongle-lctech616-hs.bin');
  assert.equal(uhs.embedded.usb, 'hs');
  assert.equal(uhs.embedded.version, '3.24H');
  assert.equal(extractAppVersion(image(1024, 1)), null);
  const dupZip = zip([
    ['up/flash_prog_cfg.ini', upstreamIni],
    ['up/boot2_a.bin', boot2], ['up/boot2_b.bin', boot2],
    ['up/partition.bin', partition],
    ['up/ds5dongle-lctech616.bin', upstreamFs],
  ]);
  await assert.rejects(loadFirmwarePackage(dupZip), /匹配到多个/);
}

// ---- ISP protocol against a simulated boot ROM ----
class FakeRom {
  constructor(options = {}) { this.flash = new Uint8Array(4 << 20).fill(255); this.options = options; this.log = []; this.buffer = []; this.erased = []; this.resets = 0; this.flaky = options.flaky || 0; this.awake = !options.needSync; this.xip = false; this.timeout = 0; }
  onData() {}
  onDisconnect() {}
  reply(bytes) { setTimeout(() => this.onData(Uint8Array.from(bytes)), 0); }
  ok(data) { return data ? [0x4f, 0x4b, data.length & 255, data.length >> 8, ...data] : [0x4f, 0x4b]; }
  fail(code) { return [0x46, 0x4c, code & 255, code >> 8]; }
  async write(bytes) {
    this.buffer.push(...bytes);
    if (!this.awake) {
      if (this.buffer.length && this.buffer.every(b => b === 0x55)) { this.buffer = []; this.awake = true; this.reply(this.ok()); }
      else this.buffer = [];
      return;
    }
    while (this.buffer.length >= 4) {
      const [id, ck, lo, hi] = this.buffer, length = lo | (hi << 8);
      if (this.buffer.length < 4 + length) return;
      const payload = Uint8Array.from(this.buffer.slice(4, 4 + length)); this.buffer = this.buffer.slice(4 + length);
      const plain = [CMD.getBootInfo, CMD.setTimeout, CMD.memoryWrite].includes(id);
      const expected = plain ? 0 : (length & 255) + (length >> 8) + payload.reduce((a, b) => a + b, 0) & 255;
      if (ck !== expected) { this.reply(this.fail(0x0103)); continue; }
      this.handle(id, payload);
    }
  }
  handle(id, p) {
    const view = new DataView(p.buffer);
    this.log.push(id);
    switch (id) {
      case CMD.getBootInfo: { const d = new Uint8Array(24); d[0] = 0; d.set([0x11, 0x22, 0x33, 0x44, 0x55, 0x66], 12); this.reply(this.ok(d)); break; }
      case CMD.setTimeout: this.timeout = view.getUint32(0, true); this.reply(this.ok()); break;
      case CMD.clkSet: case CMD.flashSetPara: case CMD.flashWriteCheck: this.reply(this.ok()); break;
      case CMD.flashReadJid: this.reply(this.ok([0xef, 0x40, 0x16, 0x80])); break;
      case CMD.flashErase: {
        const start = view.getUint32(0, true), end = view.getUint32(4, true); this.erased.push([start, end]);
        this.flash.fill(255, start & ~4095, (end | 4095) + 1); this.reply([0x50, 0x44, 0x50, 0x44]); setTimeout(() => this.onData(Uint8Array.from(this.ok())), 5); break;
      }
      case CMD.flashWrite: {
        if (this.flaky > 0) { this.flaky--; this.reply(this.fail(0x000c)); break; }
        const address = view.getUint32(0, true), data = p.subarray(4);
        assert.ok(data.length <= CHUNK); this.flash.set(data, address); this.reply(this.ok()); break;
      }
      case CMD.flashRead: {
        if (this.flaky > 0) { this.flaky--; this.reply(this.fail(0x000c)); break; }
        const address = view.getUint32(0, true), length = view.getUint32(4, true);
        assert.ok(length <= READ_CHUNK);
        this.reply(this.ok(this.flash.subarray(address, address + length))); break;
      }
      case CMD.flashXipReadStart: this.xip = true; this.reply(this.ok()); break;
      case CMD.flashXipReadFinish: this.xip = false; this.reply(this.ok()); break;
      case CMD.flashXipReadSha: {
        assert.ok(this.xip);
        const address = view.getUint32(0, true), length = view.getUint32(4, true);
        const digest = createHash('sha256').update(this.flash.subarray(address, address + length)).digest();
        if (this.options.corrupt) digest[0] ^= 1;
        this.reply(this.ok(digest)); break;
      }
      case CMD.memoryWrite: this.reply(this.ok()); break;
      case CMD.reset: this.resets++; this.reply(this.ok()); break;
      default: this.reply(this.fail(0x0101));
    }
  }
}
const run = async (rom, images) => {
  const progress = [], logs = [];
  const flasher = new Flasher(rom, { log: m => logs.push(m), progress: (f, t) => progress.push(f) });
  await flasher.connect();
  await flasher.program(images);
  return { flasher, progress, logs };
};
const images = [{ name: 'boot2', address: 0, data: boot2 }, { name: 'partition', address: 0xe000, data: partition }, { name: 'fw', address: 0x10000, data: firmware }];
{
  assert.deepEqual([...packCommand(CMD.getBootInfo, [], false)], [0x10, 0, 0, 0]);
  assert.deepEqual([...packCommand(CMD.clkSet, [1, 0, 0, 0, 0, 0xc2, 1, 0])], [0x22, 8 + 1 + 0xc2 + 1, 8, 0, 1, 0, 0, 0, 0, 0xc2, 1, 0]);
  const rom = new FakeRom();
  const { progress } = await run(rom, images);
  assert.deepEqual([...rom.flash.subarray(0, boot2.length)], [...boot2]);
  assert.deepEqual([...rom.flash.subarray(0xe000, 0xe000 + partition.length)], [...partition]);
  assert.deepEqual([...rom.flash.subarray(0x10000, 0x10000 + firmware.length)], [...firmware]);
  assert.equal(rom.resets, 1);
  assert.deepEqual(rom.erased[2], [0x10000, 0x10000 + firmware.length - 1]);
  assert.ok(progress.every((v, i) => i === 0 || v >= progress[i - 1] - 1e-9) && progress.at(-1) === 1);
}
{ // device that only answers after 0x55 synchronisation
  const rom = new FakeRom({ needSync: true });
  await run(rom, images.slice(2));
  assert.equal(rom.resets, 1);
}
{ // transient write failures are retried; persistent ones stop before reboot
  const rom = new FakeRom({ flaky: 2 });
  const { logs } = await run(rom, images.slice(2));
  assert.ok(logs.some(m => m.includes('重试')));
  const hard = new FakeRom({ flaky: 99 });
  await assert.rejects(run(hard, images.slice(2)), /写入 0x10000 失败/);
  assert.equal(hard.resets, 0);
}
{ // read-back mismatch must never reboot into a bad image
  const rom = new FakeRom({ corrupt: true });
  await assert.rejects(run(rom, images.slice(2)), /读回校验失败/);
  assert.equal(rom.resets, 0);
}
{ // readFlash across multiple chunks, SHA verification, and reset: false programming
  const rom = new FakeRom({ flaky: 1 });
  const flasher = new Flasher(rom);
  await flasher.connect();
  await flasher.program([{ name: 'fw', address: 0x10000, data: firmware }], { reset: false });
  assert.equal(rom.resets, 0);
  rom.flaky = 1;
  const readBack = await flasher.readFlash(0x10000, firmware.length);
  assert.deepEqual([...readBack], [...firmware]);
  rom.options.corrupt = true;
  await assert.rejects(flasher.readFlash(0x10000, firmware.length), /校验失败/);
  await flasher.resetDevice();
  assert.equal(rom.resets, 1);
}
{ // refuse images beyond flash size or unaligned
  await assert.rejects(run(new FakeRom(), [{ name: 'big', address: 0x3f0000, data: new Uint8Array(0x20000) }]), /超出 Flash 容量/);
  await assert.rejects(run(new FakeRom(), [{ name: 'odd', address: 0x10001, data: firmware }]), /对齐/);
}
await sleep(10);
console.log('flasher: zip parsing, package integrity, ISP framing, sync fallback, retries and read-back verification passed');
