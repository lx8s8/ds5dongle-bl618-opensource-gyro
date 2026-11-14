export const CONFIG_REPORT = 0xFC, STATUS_REPORT = 0xFD, PROFILE_REPORT = 0xFA, DIAGNOSTIC_REPORT = 0xFE, REPORT_SIZE = 63;
export const buttonNames = ['□', '×', '○', '△', 'L1', 'R1', 'L2', 'R2', 'Create', 'Options', 'L3', 'R3', 'PS', '触摸板按下', 'Mute', '↑', '↓', '←', '→', 'Fn 左', 'Fn 右', '背键左 L4', '背键右 R4', '触摸接触'];
export const fields = [
  { id: 'output', label: '输出方式', group: 'activation', offset: 1, options: ['关闭体感', '鼠标', '右摇杆'], default: 0 },
  { id: 'activation', label: '启用方式', group: 'activation', offset: 2, options: ['始终启用', '按住启用', '按一下开启 / 再按关闭', '按住暂停'], default: 1 },
  { id: 'trigger', label: '扳机条件', group: 'activation', offset: 3, options: ['无', 'L2 / LT', 'R2 / RT'], default: 1 },
  { id: 'threshold', label: '扳机阈值 · 1–255', group: 'activation', offset: 4, min: 1, max: 255, default: 64 },
  { id: 'releaseThreshold', label: '释放阈值 · 1–255', group: 'activation', offset: 37, min: 1, max: 255, default: 64 },
  { id: 'adsMultiplier', label: 'L2 瞄准倍率', group: 'motion', offset: 38, size: 2, scale: 100, min: .01, max: 4, step: .01, default: 1 },
  { id: 'hold', label: '长按延时 · ms', group: 'activation', offset: 8, size: 2, min: 0, max: 3000, default: 0 },
  { id: 'horizontal', label: '水平转动轴', group: 'activation', offset: 6, options: ['Yaw · 左右转动', 'Roll · 左右侧倾'], default: 0 },
  { id: 'profileSource', label: '配置档绑定', group: 'profile', offset: 35, options: ['不限制档位', 'Edge 原生 Fn 配置档', '接收器映射档（通用）'], default: 0 },
  { id: 'sx', label: '水平灵敏度 · 倍', group: 'motion', offset: 10, size: 2, scale: 100, min: .01, max: 100, step: .01, default: 2 },
  { id: 'sy', label: '垂直灵敏度 · 倍', group: 'motion', offset: 12, size: 2, scale: 100, min: .01, max: 100, step: .01, default: 2 },
  { id: 'mouseCpd', label: '鼠标基准 · counts/°', group: 'motion', offset: 14, size: 2, scale: 100, min: .01, max: 100, step: .01, default: 12 },
  { id: 'noise', label: '微动死区 · °/s', group: 'motion', offset: 16, size: 2, scale: 100, min: 0, max: 10, step: .01, default: .5 },
  { id: 'smooth', label: '平滑时间 · ms', group: 'motion', offset: 7, min: 0, max: 100, default: 8 },
  { id: 'accel', label: '高速加速倍率', group: 'motion', offset: 24, size: 2, scale: 100, min: 1, max: 10, step: .01, default: 1 },
  { id: 'accelStart', label: '加速开始 · °/s', group: 'motion', offset: 26, size: 2, min: 0, max: 1999, default: 30 },
  { id: 'accelEnd', label: '加速到顶 · °/s', group: 'motion', offset: 28, size: 2, min: 1, max: 2000, default: 180 },
  { id: 'maxTurn', label: '游戏满杆转速 · °/s', group: 'stick', offset: 18, size: 2, min: 1, max: 3000, default: 360 },
  { id: 'stickDeadzone', label: '游戏死区补偿 · %', group: 'stick', offset: 20, size: 2, scale: 10, min: 0, max: 50, step: .1, default: 10 },
  { id: 'stickPower', label: '游戏响应曲线 · 指数', group: 'stick', offset: 22, size: 2, scale: 100, min: .25, max: 4, step: .01, default: 1 },
  { id: 'blend', label: '物理右摇杆', group: 'stick', offset: 34, options: ['与体感叠加', '体感启用时替代'], default: 0 },
];

export function defaults() {
  return { ...Object.fromEntries(fields.map(f => [f.id, f.default])), flags: 0, buttons: 0, profiles: 0 };
}

export function encodeConfig(c) {
  const bytes = new Uint8Array(40), v = new DataView(bytes.buffer);
  bytes[0] = 2;
  for (const f of fields) {
    const n = c[f.id], scale = f.scale || 1;
    const min = f.options ? 0 : f.min, max = f.options ? f.options.length - 1 : f.max;
    if (!Number.isFinite(n) || n < min || n > max || Math.abs(n * scale - Math.round(n * scale)) > .00001)
      throw new Error(`${f.label}超出范围或精度`);
    if (f.size === 2) v.setUint16(f.offset, Math.round(n * scale), true);
    else v.setUint8(f.offset, Math.round(n));
  }
  if (!Number.isInteger(c.buttons) || c.buttons < 0 || c.buttons > 0xFFFFFF ||
      !Number.isInteger(c.flags) || c.flags < 0 || c.flags > 15 ||
      !Number.isInteger(c.profiles) || c.profiles < 0 || c.profiles > 15)
    throw new Error('按键或配置档掩码无效');
  if (c.activation !== 0 && !c.trigger && !c.buttons) throw new Error('请选择扳机或至少一个启用键');
  if (c.accelStart >= c.accelEnd) throw new Error('加速到顶速度必须大于开始速度');
  if (c.profileSource && !c.profiles) throw new Error('请至少选择一个启用体感的配置档');
  if (c.profileSource === 2 && c.profiles > 3) throw new Error('接收器只有两套映射档');
  if (c.releaseThreshold > c.threshold) throw new Error('释放阈值不能大于启用阈值');
  bytes[5] = c.flags; v.setUint32(30, c.buttons, true); bytes[36] = c.profiles;
  return bytes;
}

export function decodeConfig(bytes) {
  if (bytes.length < 40 || ![1, 2].includes(bytes[0])) throw new Error('不支持的体感配置版本');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), c = {};
  for (const f of fields) c[f.id] = (f.size === 2 ? v.getUint16(f.offset, true) : v.getUint8(f.offset)) / (f.scale || 1);
  c.flags = bytes[5]; c.buttons = v.getUint32(30, true); c.profiles = bytes[36];
  if (bytes[0] === 1) {
    if (bytes[37] || bytes[38] || bytes[39]) throw new Error('配置格式错误');
    c.releaseThreshold = c.threshold; c.adsMultiplier = 1;
  }
  encodeConfig(c);
  return c;
}

export function featureBytes(report, id) {
  const a = new Uint8Array(report.buffer, report.byteOffset, report.byteLength);
  // WebHID receiveFeatureReport includes its report ID. Length matters: a
  // version byte can equal a report ID in other protocols, so never guess.
  if (a.length !== 64 || a[0] !== id) throw new Error(`报告 0x${id.toString(16)} 格式不匹配，请更新固件`);
  return a.slice(1);
}

export function decodeStatus(bytes) {
  if (bytes.length !== REPORT_SIZE || ![1, 2].includes(bytes[0])) throw new Error('不支持的调试报告');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    flags: bytes[1], output: bytes[2], progress: bytes[3], dt: v.getUint32(4, true),
    raw: [8, 10, 12].map(o => v.getInt16(o, true)), accel: [14, 16, 18].map(o => v.getInt16(o, true)),
    rates: [20, 24, 28].map(o => v.getInt32(o, true) / 100),
    filtered: [32, 36].map(o => v.getInt32(o, true) / 100),
    stick: [bytes[40], bytes[41]], pending: [42, 44].map(o => v.getInt16(o, true)),
    buttons: v.getUint32(46, true), samples: v.getUint16(50, true),
    bias: [52, 54, 56].map(o => v.getInt16(o, true) / 100), packets: v.getUint32(58, true),
    edgeProfile: bytes[62] & 15, dongleProfile: (bytes[62] >> 4) & 3,
  };
}

export function globalDefaults() {
  return { source: 0, manual: 0, feedback: 1, edge: [0, 1, 2, 3], dongle: [0, 1],
    actions: Array.from({ length: 4 }, () => ({ action: 0, gesture: 0, target: 0, suppress: 0, hold: 300, fine: .5, buttons: 0 })) };
}
const integer = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
export function encodeGlobal(g) {
  if (!g || !integer(g.source, 0, 2) || !integer(g.manual, 0, 3) || !integer(g.feedback, 0, 1) ||
      !Array.isArray(g.edge) || g.edge.length !== 4 || !Array.isArray(g.dongle) || g.dongle.length !== 2 ||
      [...g.edge, ...g.dongle].some(n => !integer(n, 0, 3) && n !== 255) || !Array.isArray(g.actions) || g.actions.length !== 4)
    throw new Error('配置档设置无效');
  const bytes = new Uint8Array(57), v = new DataView(bytes.buffer), masks = new Set();
  bytes.set([g.source, g.manual, g.feedback, ...g.edge, ...g.dongle]);
  g.actions.forEach((a, i) => {
    if (!a || !integer(a.action, 0, 6) || !integer(a.gesture, 0, 2) || !integer(a.target, 0, 3) ||
        ![0, 1, 3].includes(a.suppress) || !integer(a.hold, 0, 3000) || !integer(a.buttons, 0, 0xFFFFFF) ||
        !Number.isFinite(a.fine) || !integer(Math.round(a.fine * 100), 0, 400) || Math.abs(a.fine * 100 - Math.round(a.fine * 100)) > .00001 ||
        (a.action && (!a.buttons || a.fine <= 0 || (a.gesture === 1 && !a.hold))) ||
        (a.action === 6 && (a.gesture === 2 || a.fine > 1))) throw new Error(`快捷键 ${i + 1} 设置无效`);
    if (a.action && masks.has(a.buttons)) throw new Error('快捷键组合重复');
    if (a.action) masks.add(a.buttons);
    const offset = 9 + i * 12;
    bytes.set([a.action, a.gesture, a.target, a.suppress], offset);
    v.setUint16(offset + 4, a.hold, true); v.setUint16(offset + 6, Math.round(a.fine * 100), true); v.setUint32(offset + 8, a.buttons, true);
  });
  return bytes;
}
export function decodeGlobal(bytes) {
  if (bytes.length !== 57) throw new Error('配置档格式错误');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const g = { source: bytes[0], manual: bytes[1], feedback: bytes[2], edge: [...bytes.slice(3, 7)], dongle: [...bytes.slice(7, 9)], actions: [] };
  for (let i = 0; i < 4; i++) {
    const o = 9 + i * 12;
    g.actions.push({ action: bytes[o], gesture: bytes[o + 1], target: bytes[o + 2], suppress: bytes[o + 3], hold: v.getUint16(o + 4, true), fine: v.getUint16(o + 6, true) / 100, buttons: v.getUint32(o + 8, true) });
  }
  encodeGlobal(g); return g;
}
export function decodeProfiles(bytes) {
  if (bytes.length !== 63 || bytes[0] !== 2 || bytes[1] !== 4 || bytes[2] > 3 || (bytes[3] > 3 && bytes[3] !== 255)) throw new Error('不支持的配置档版本');
  const data = new Uint8Array(57); data.set(bytes.slice(4, 13)); data.set(bytes.slice(15, 63), 9);
  return { edit: bytes[2], active: bytes[3], settings: decodeGlobal(data) };
}
export function decodeDiagnostics(bytes) {
  if (bytes.length !== 63 || bytes[0] !== 2) throw new Error('不支持的诊断报告');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { active: bytes[1], inputs: v.getUint32(2, true), intervalMin: v.getUint32(6, true), intervalMax: v.getUint32(10, true), intervalMean: v.getUint32(14, true),
    processMax: v.getUint32(18, true), processLast: v.getUint32(22, true), gaps: v.getUint32(26, true), usbBusy: v.getUint32(30, true), queueDrops: v.getUint32(34, true),
    queuePeak: bytes[38], saveResult: bytes[39], flashLast: v.getUint32(40, true), flashMax: v.getUint32(44, true), buckets: [48, 50, 52, 54, 56].map(o => v.getUint16(o, true)), saves: v.getUint32(58, true) };
}
export function importBundle(data) {
  if (data?.version === 2 && Array.isArray(data.profiles) && data.profiles.length === 4) {
    const profiles = data.profiles.map(c => decodeConfig(encodeConfig(c)));
    return { profiles, settings: decodeGlobal(encodeGlobal(data.settings)) };
  }
  if (data?.version === 1 && data.config) {
    const config = { ...data.config, releaseThreshold: data.config.threshold, adsMultiplier: 1 };
    const settings = globalDefaults();
    settings.source = config.profileSource;
    if (settings.source) {
      const mapping = settings.source === 1 ? settings.edge : settings.dongle;
      mapping.forEach((_, i) => { mapping[i] = config.profiles & (1 << i) ? 0 : 255; });
      config.profileSource = config.profiles = 0;
    }
    return { profiles: [decodeConfig(encodeConfig(config)), defaults(), defaults(), defaults()], settings };
  }
  throw new Error('不支持的配置文件');
}
