class History {
  constructor(capacity) { this.capacity = capacity; this.reset(); }
  reset() { this.items = new Array(this.capacity); this.count = this.next = 0; }
  push(value) { this.items[this.next] = value; this.next = (this.next + 1) % this.capacity; this.count = Math.min(this.capacity, this.count + 1); }
  recent(since) { return Array.from({length:this.count}, (_, i) => this.items[(this.next - this.count + i + this.capacity) % this.capacity]).filter(row => row[0] >= since); }
}

// Use the existing WebHID connection. No additional reader or polling traffic.
export class DiagnosticCapture {
  constructor({clock=()=>performance.now(), wallClock=()=>Date.now(), maxInputs=32768, maxFrames=4096}={}) {
    this.clock=clock; this.wallClock=wallClock;
    this.inputs=new History(maxInputs); this.frames=new History(maxFrames); this.reset();
  }
  reset() { this.startedAt=this.wallClock(); this.started=this.clock(); this.inputs.reset(); this.frames.reset(); this.latest=null; }
  input(bytes) {
    if(bytes.byteLength<63) return;
    const v=new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), at=this.clock()-this.started;
    const ticks=v.getUint32(27,true);
    const row=[at,ticks,...bytes.slice(0,6),...bytes.slice(7,10),...[15,17,19,21,23,25].map(o=>v.getInt16(o,true))];
    this.inputs.push(row); this.latest={at,ticks,rx:bytes[2],ry:bytes[3],l2:bytes[4]};
  }
  frame({sensorTicks,receivedAt,sticks}) {
    if(!this.latest) return;
    const now=this.clock();
    this.frames.push([now-this.started,sensorTicks,now-receivedAt,...sticks]);
  }
  snapshot() {
    const now=this.clock()-this.started, since=now-30000;
    return {
      startedAt:new Date(this.startedAt).toISOString(), durationMs:now, windowMs:30000,
      inputColumns:['host_ms','sensor_ticks','lx','ly','rx','ry','l2','r2','buttons0','buttons1','buttons2','gyro_x_raw','gyro_y_raw','gyro_z_raw','accel_x_raw','accel_y_raw','accel_z_raw'],
      inputs:this.inputs.recent(since),
      frameColumns:['host_ms','sensor_ticks','after_input_ms','lx_normalized','ly_normalized','rx_normalized','ry_normalized'],
      frames:this.frames.recent(since),
      notes:'host_ms is monotonic browser time; sensor_ticks is the 32-bit controller clock (3 ticks/us, wraps). Raw USB motion is before factory/manual calibration. Frames contain the actual solid-dot position; trail points are historical. Feature samples are asynchronous and are not USB reports. This capture cannot measure absolute end-to-end latency.'
    };
  }
}
