// Reuse an existing grant only after the user clicks Connect. Multiple valid
// receivers still require a choice; do not silently pick the first device.
export async function requestReceiver(hid) {
  const filters=[{vendorId:0x054C,productId:0x0CE6,usagePage:1,usage:5},
    {vendorId:0x054C,productId:0x0DF2,usagePage:1,usage:5},
    {vendorId:0x1209,productId:0x0001,usagePage:1,usage:5}];
  const authorized=hid.getDevices ? await hid.getDevices() : [];
  const receivers=authorized.filter(device=>filters.some(f=>device.vendorId===f.vendorId&&device.productId===f.productId)&&
    [0xFA,0xFC,0xFD,0xFE].every(id=>device.collections.some(c=>(c.featureReports||[]).some(r=>r.reportId===id))));
  if(receivers.length===1) return receivers[0];
  return (await hid.requestDevice({filters}))[0];
}

// One queue owns Feature traffic, including telemetry and legacy commands.
export class HidTransport {
  constructor(device) { this.device = device; this.sequence = 0; this.tail = Promise.resolve(); this.closed = false; }
  run(work) { const task = this.tail.then(() => { if (this.closed) throw new Error('接收器已断开'); return work(); }); this.tail = task.catch(() => {}); return task; }
  async get(id, length = 63) {
    const v = await this.device.receiveFeatureReport(id), a = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    if (a[0] !== id || (length !== null && a.length !== length + 1)) throw new Error(`报告 0x${id.toString(16)} 长度或 ID 不匹配，请更新固件`);
    return a.slice(1);
  }
  read(id, length = 63) { return this.run(() => this.get(id, length)); }
  next() { this.sequence = this.sequence % 255 + 1; return this.sequence; }
  gyro(command, value = []) {
    return this.run(async () => {
      const seq = this.next(), p = new Uint8Array(63); p.set([command, seq]); p.set(value, 2);
      await this.device.sendFeatureReport(0xFC, p);
      return this.ack(0xFC, command, seq);
    });
  }
  legacy(id, command, value = []) {
    return this.run(async () => {
      const seq = this.next(), p = new Uint8Array(id === 0xFB ? 127 : 63);
      p[0] = command; p.set(value, 1); p[p.length - 1] = seq;
      await this.device.sendFeatureReport(id, p);
      return this.ack(0xF7, command, seq, id);
    });
  }
  async ack(id, command, seq, source) {
    const until = performance.now() + 2500;
    while (performance.now() < until) {
      await new Promise(r => setTimeout(r, 25)); const b = await this.get(id);
      if (b[40] !== command || b[42] !== seq || (source && b[43] !== source)) continue;
      if (b[41]) throw new Error(b[41] === 2 ? '保存失败，当前 RAM 设置仍生效' : '设置无效，请检查参数');
      return b;
    }
    throw new Error('操作超时，请重新读取配置');
  }
  async close() { this.closed = true; await this.tail; if (this.device.opened) await this.device.close(); }
}
