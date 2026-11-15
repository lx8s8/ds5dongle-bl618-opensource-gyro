import { buttonNames, defaults, fields } from './protocol.mjs';

export const MODIFIER_BITS = [
  { bit: 1, label: 'Ctrl' },
  { bit: 2, label: 'Shift' },
  { bit: 4, label: 'Alt' },
  { bit: 8, label: 'Win' },
];

export const TRIGGER_NAMES = ['无扳机', 'L2', 'R2'];
export const AXIS_NAMES = ['Yaw', 'Roll', '玩家空间'];
export const OUTPUT_NAMES = ['已关闭', '鼠标', '右摇杆'];
export const ACTIVATION_NAMES = ['始终开启', '按住开启', '按键切换', '按住暂停'];
export const GYRO_FLAG_BITS = [
  { bit: 1, id: 'invertX', label: '水平反转' },
  { bit: 2, id: 'invertY', label: '垂直反转' },
  { bit: 4, id: 'suppress', label: '屏蔽原始按键' },
  { bit: 8, id: 'allButtons', label: '组合键同时按住' },
  { bit: 16, id: 'autoBias', label: '自动静止温漂校准' },
  { bit: 32, id: 'adaptiveSmooth', label: '自适应微瞄滤波' },
];

export const GYRO_PRESETS = [
  {
    id: 'off',
    label: '关闭此档',
    hint: '停用当前配置档的体感输出',
    build: () => ({ ...defaults(), output: 0 }),
  },
  {
    id: 'fpsAdsMouse',
    label: 'FPS 开镜鼠标',
    hint: '按住 L2 激活鼠标微瞄，适合 PC 射击游戏开镜跟枪',
    build: () => ({
      ...defaults(),
      output: 1,
      activation: 1,
      trigger: 1,
      threshold: 64,
      releaseThreshold: 56,
      adsMultiplier: 1,
      sx: 2.2,
      sy: 2.2,
      mouseCpd: 12,
      noise: 0.5,
      smooth: 6,
    }),
  },
  {
    id: 'alwaysMouse',
    label: '全程鼠标 · L1 暂停',
    hint: '持续输出鼠标视角，按住 L1 键时暂停以便调整手腕位置',
    build: () => ({
      ...defaults(),
      output: 1,
      activation: 3,
      trigger: 0,
      threshold: 64,
      releaseThreshold: 64,
      buttons: 1 << 4,
      sx: 2,
      sy: 2,
      mouseCpd: 12,
      noise: 0.6,
      smooth: 8,
    }),
  },
  {
    id: 'consoleStick',
    label: '模拟右摇杆',
    hint: '按住 L2 将陀螺仪合入右摇杆，适合不支持鼠键混用的主机/手柄游戏',
    build: () => ({
      ...defaults(),
      output: 2,
      activation: 1,
      trigger: 1,
      threshold: 64,
      releaseThreshold: 56,
      sx: 2,
      sy: 2,
      maxTurn: 360,
      stickDeadzone: 12,
      stickPower: 1,
      blend: 0,
      noise: 0.6,
      smooth: 8,
    }),
  },
  {
    id: 'precisionMouse',
    label: '精确微瞄 + 高速加速',
    hint: '开镜微调更稳，快速甩动自动触发 1.6x 加速转身',
    build: () => ({
      ...defaults(),
      output: 1,
      activation: 1,
      trigger: 1,
      threshold: 80,
      releaseThreshold: 64,
      adsMultiplier: 0.8,
      sx: 1.6,
      sy: 1.6,
      mouseCpd: 12,
      noise: 0.35,
      smooth: 10,
      accel: 1.6,
      accelStart: 35,
      accelEnd: 180,
    }),
  },
  {
    id: 'playerSpacePro',
    label: '玩家空间 · 自适应防抖',
    hint: '重力融合消除斜握串轴，自动跟踪温漂 + 微瞄滤波 / 甩枪直通',
    build: () => ({
      ...defaults(),
      output: 1,
      activation: 1,
      trigger: 1,
      threshold: 64,
      releaseThreshold: 56,
      horizontal: 2,
      flags: 16 | 32,
      adsMultiplier: 0.85,
      sx: 2.2,
      sy: 2.2,
      mouseCpd: 12,
      noise: 0.4,
      smooth: 10,
      accel: 1.4,
      accelStart: 35,
      accelEnd: 180,
    }),
  },
];

export const STICK_GAME_TEMPLATES = [
  {
    id: 'apexClassic',
    label: 'Apex 英雄 · 经典曲线',
    hint: '小死区 12% · 经典指数 1.45 · 满杆约 240°/s',
    maxTurn: 240,
    stickDeadzone: 12,
    stickPower: 1.45,
    blend: 0,
  },
  {
    id: 'apexLinear',
    label: 'Apex 英雄 · 线性 ALC',
    hint: '极小死区 2% · 线性 1.0 · 满杆约 300°/s',
    maxTurn: 300,
    stickDeadzone: 2,
    stickPower: 1,
    blend: 0,
  },
  {
    id: 'codDynamic',
    label: '使命召唤 CoD · 动态',
    hint: '死区 7% · 动态折算 0.9 · 满杆约 420°/s',
    maxTurn: 420,
    stickDeadzone: 7,
    stickPower: 0.9,
    blend: 0,
  },
  {
    id: 'ow2Dual',
    label: '守望先锋 2 · 主机视角',
    hint: '死区 10% · 指数 1.15 · 满杆约 300°/s',
    maxTurn: 300,
    stickDeadzone: 10,
    stickPower: 1.15,
    blend: 0,
  },
  {
    id: 'bfStandard',
    label: '战地 / 通用主机射击',
    hint: '标准死区 15% · 指数 1.25 · 满杆约 360°/s',
    maxTurn: 360,
    stickDeadzone: 15,
    stickPower: 1.25,
    blend: 0,
  },
];

const CURVE_POWERS = {
  linear: 1.0,
  classic: 1.4,
  precision: 1.8,
  dynamic: 0.88,
};

export function computeStickWizard({ gameDeadzonePct = 10, turn360Seconds = 1.0, curveType = 'linear' } = {}) {
  const dzNum = Math.max(0, Math.min(50, Number(gameDeadzonePct) || 0));
  const stickDeadzone = Math.round(Math.max(0, dzNum * 0.95) * 10) / 10;
  const sec = Math.max(0.12, Math.min(10, Number(turn360Seconds) || 1));
  const maxTurn = Math.max(1, Math.min(3000, Math.round(360 / sec)));
  const stickPower = CURVE_POWERS[curveType] ?? 1.0;
  return { maxTurn, stickDeadzone, stickPower };
}

export function selectedButtonLabels(mask, limit = 3) {
  const list = [];
  for (let i = 0; i < buttonNames.length; i++) {
    if (mask & (1 << i)) list.push(buttonNames[i]);
  }
  if (!list.length) return [];
  if (list.length <= limit) return list;
  return [...list.slice(0, limit), `+${list.length - limit}`];
}

export function getConfigVisibility(c) {
  const active = Number(c.output) !== 0;
  const isMouse = Number(c.output) === 1;
  const isStick = Number(c.output) === 2;
  const usesGate = active && Number(c.activation) !== 0;
  const usesHold = usesGate;
  const usesTriggerGate = usesGate && Number(c.trigger) > 0;
  const usesAdsThreshold = active && Math.abs(Number(c.adsMultiplier) - 1) > 1e-4;
  const usesThreshold = usesTriggerGate || usesAdsThreshold;
  const usesAccelRange = active && Number(c.accel) > 1.0001;
  const usesProfileLimit = active && Number(c.profileSource) !== 0;
  const selectedButtonCount = buttonNames.reduce((n, _, i) => n + ((c.buttons & (1 << i)) ? 1 : 0), 0);
  const usesAllButtons = usesGate && (selectedButtonCount > 1 || (selectedButtonCount === 1 && Number(c.trigger) > 0));
  return {
    active,
    isMouse,
    isStick,
    usesGate,
    usesHold,
    usesTriggerGate,
    usesAdsThreshold,
    usesThreshold,
    usesAccelRange,
    usesProfileLimit,
    usesAllButtons,
    selectedButtonCount,
  };
}

export function describeTriggerCondition(c) {
  if (Number(c.activation) === 0) return '始终启用';
  const parts = [];
  if (Number(c.trigger) > 0) parts.push(TRIGGER_NAMES[c.trigger] || '扳机');
  const btns = selectedButtonLabels(c.buttons || 0, 2);
  if (btns.length) parts.push(btns.join('+'));
  const condition = parts.length ? parts.join((c.flags & 8) ? ' 且 ' : ' / ') : '未设启用键';
  const verb = ACTIVATION_NAMES[c.activation] || '启用';
  const hold = Number(c.hold) > 0 ? ` · 长按 ${c.hold}ms` : '';
  return `${condition}（${verb}${hold}）`;
}

export function summarizeGyroConfig(c) {
  if (!c || Number(c.output) === 0) return '已关闭';
  const mode = OUTPUT_NAMES[c.output] || '未知';
  const sens = Math.abs(Number(c.sx) - Number(c.sy)) < 0.005
    ? `${Number(c.sx).toFixed(2).replace(/\.?0+$/, '')}x`
    : `X ${Number(c.sx).toFixed(2).replace(/\.?0+$/, '')} / Y ${Number(c.sy).toFixed(2).replace(/\.?0+$/, '')}`;
  const ads = Math.abs(Number(c.adsMultiplier) - 1) > 0.005 ? ` · L2 ${c.adsMultiplier}x` : '';
  const space = Number(c.horizontal) === 2 ? ' · 玩家空间' : Number(c.horizontal) === 1 ? ' · Roll' : '';
  const extras = [];
  if (c.flags & 16) extras.push('自动温漂');
  if (c.flags & 32) extras.push('自适应滤波');
  const suffix = extras.length ? ` · ${extras.join('+')}` : '';
  return `${describeTriggerCondition(c)} → ${mode} ${sens}${ads}${space}${suffix}`;
}

export function configsMatch(a, b) {
  if (!a || !b) return false;
  for (const f of fields) {
    const scale = f.scale || 1;
    if (Math.round(Number(a[f.id]) * scale) !== Math.round(Number(b[f.id]) * scale)) return false;
  }
  return (a.flags | 0) === (b.flags | 0) && (a.buttons | 0) === (b.buttons | 0) && (a.profiles | 0) === (b.profiles | 0);
}

export function globalsMatch(a, b) {
  if (!a || !b) return false;
  if (a.source !== b.source || a.manual !== b.manual || a.feedback !== b.feedback) return false;
  for (let i = 0; i < 4; i++) if ((a.edge?.[i] ?? 0) !== (b.edge?.[i] ?? 0)) return false;
  for (let i = 0; i < 2; i++) if ((a.dongle?.[i] ?? 0) !== (b.dongle?.[i] ?? 0)) return false;
  for (let i = 0; i < 4; i++) {
    const x = a.actions?.[i], y = b.actions?.[i];
    if (!x || !y) return false;
    if (x.action !== y.action || x.gesture !== y.gesture || x.target !== y.target ||
        x.suppress !== y.suppress || x.hold !== y.hold ||
        Math.round(Number(x.fine) * 100) !== Math.round(Number(y.fine) * 100) ||
        (x.buttons | 0) !== (y.buttons | 0)) return false;
  }
  return true;
}

export function toggleModifierBit(mask, bit, enabled) {
  const clean = Number(mask) & 15;
  return enabled ? (clean | bit) : (clean & ~bit);
}

export function formatModifierMask(mask) {
  const names = MODIFIER_BITS.filter(m => (Number(mask) & m.bit) !== 0).map(m => m.label);
  return names.length ? names.join(' + ') : '无修饰键';
}

export function isRemapRowModified(row, index) {
  if (!row) return false;
  // Controller-to-controller entries ignore modifier/flags in firmware remap_apply(),
  // while keyboard/mouse entries always remap away from the default controller button.
  if (Number(row.type) === 0) return Number(row.value) !== index;
  return true;
}

export function getMacroRuleVisibility(rule) {
  const gesture = Number(rule?.gesture ?? 0);
  return {
    usesHoldMs: gesture === 2,
    usesTapMs: gesture >= 3,
  };
}

export function normalizeSlotNames(names) {
  const arr = Array.isArray(names) ? names : [];
  return [0, 1, 2, 3].map(i => String(arr[i] ?? '').trim().slice(0, 16));
}

export function formatSlotTitle(index, customName = '') {
  const clean = String(customName ?? '').trim().slice(0, 16);
  return clean ? `配置 ${index + 1} · ${clean}` : `配置 ${index + 1}`;
}

function formatFieldVal(f, val) {
  if (f.options) return f.options[Number(val)] ?? String(val);
  const scale = f.scale || 1;
  if (scale >= 100) return Number(val).toFixed(2).replace(/\.?0+$/, '');
  if (scale >= 10) return Number(val).toFixed(1).replace(/\.0$/, '');
  return String(Math.round(Number(val)));
}

export function diffGyroConfigs(before, after) {
  if (!before || !after) return [];
  const changes = [];
  for (const f of fields) {
    const scale = f.scale || 1;
    if (Math.round(Number(before[f.id]) * scale) !== Math.round(Number(after[f.id]) * scale)) {
      const from = formatFieldVal(f, before[f.id]);
      const to = formatFieldVal(f, after[f.id]);
      changes.push({ id: f.id, label: f.label.split(' · ')[0], from, to, text: `${f.label.split(' · ')[0]}: ${from} → ${to}` });
    }
  }
  for (const flag of GYRO_FLAG_BITS) {
    const wasOn = !!(before.flags & flag.bit);
    const isOn = !!(after.flags & flag.bit);
    if (wasOn !== isOn) {
      const from = wasOn ? '开启' : '关闭';
      const to = isOn ? '开启' : '关闭';
      changes.push({ id: flag.id, label: flag.label, from, to, text: `${flag.label}: ${from} → ${to}` });
    }
  }
  if ((before.buttons | 0) !== (after.buttons | 0)) {
    const from = selectedButtonLabels(before.buttons || 0, 4).join('+') || '无';
    const to = selectedButtonLabels(after.buttons || 0, 4).join('+') || '无';
    changes.push({ id: 'buttons', label: '启用按键', from, to, text: `启用按键: ${from} → ${to}` });
  }
  return changes;
}

export function diffConfigBundles(currentBundle, incomingBundle) {
  const curProfiles = currentBundle?.profiles || [];
  const incProfiles = incomingBundle?.profiles || [];
  const curNames = normalizeSlotNames(currentBundle?.slotNames);
  const incNames = normalizeSlotNames(incomingBundle?.slotNames || curNames);
  const slotDiffs = [];
  let totalChanges = 0;
  for (let i = 0; i < 4; i++) {
    const changes = diffGyroConfigs(curProfiles[i], incProfiles[i]);
    if (curNames[i] !== incNames[i]) {
      changes.unshift({ id: 'slotName', label: '配置备注', from: curNames[i] || '默认', to: incNames[i] || '默认', text: `备注名: ${curNames[i] || '无'} → ${incNames[i] || '无'}` });
    }
    totalChanges += changes.length;
    slotDiffs.push({
      slot: i,
      name: formatSlotTitle(i, incNames[i] || curNames[i]),
      summaryBefore: summarizeGyroConfig(curProfiles[i]),
      summaryAfter: summarizeGyroConfig(incProfiles[i]),
      changes,
    });
  }
  const globalChanged = currentBundle?.settings && incomingBundle?.settings
    ? !globalsMatch(currentBundle.settings, incomingBundle.settings)
    : false;
  if (globalChanged) totalChanges += 1;
  return {
    hasChanges: totalChanges > 0,
    slotDiffs,
    globalChanged,
    totalChanges,
  };
}

export function computeCircularityMetrics(bins) {
  if (!Array.isArray(bins) || !bins.length) return { covered: 0, total: 0, meanRadius: 0, rmsErrorPct: null };
  const active = bins.filter(r => Number.isFinite(r) && r >= 0.35);
  const covered = active.length;
  const total = bins.length;
  if (covered < 8) return { covered, total, meanRadius: 0, rmsErrorPct: null };
  const meanRadius = active.reduce((s, r) => s + r, 0) / covered;
  const mse = active.reduce((s, r) => s + (r - 1) * (r - 1), 0) / covered;
  const rmsErrorPct = Math.round(Math.sqrt(mse) * 1000) / 10;
  return { covered, total, meanRadius, rmsErrorPct };
}

export function computePollingStats(intervalsMs) {
  const valid = (Array.isArray(intervalsMs) ? intervalsMs : []).filter(n => Number.isFinite(n) && n > 0 && n < 250);
  if (!valid.length) return { count: 0, avgMs: 0, minMs: 0, maxMs: 0, jitterMs: 0, hz: 0 };
  let sum = 0, minMs = Infinity, maxMs = 0;
  for (const dt of valid) {
    sum += dt;
    if (dt < minMs) minMs = dt;
    if (dt > maxMs) maxMs = dt;
  }
  const avgMs = sum / valid.length;
  const variance = valid.reduce((acc, dt) => acc + (dt - avgMs) * (dt - avgMs), 0) / valid.length;
  const jitterMs = Math.sqrt(variance);
  const hz = avgMs > 0 ? 1000 / avgMs : 0;
  return { count: valid.length, avgMs, minMs, maxMs, jitterMs, hz };
}

export function evaluateCompatibilityMode({ outputMode = 0, gameNativeGyro = false, hostMapper = 'none' } = {}) {
  const out = Number(outputMode) || 0;
  const hasHostGyro = hostMapper === 'steam' || hostMapper === 'ds4windows' || hostMapper === 'jsm';
  if (out !== 0 && (gameNativeGyro || hasHostGyro)) {
    return {
      status: 'conflict',
      title: '检测到双重体感叠加风险',
      detail: '接收器始终向电脑透传原始陀螺仪（Report 0x01）。若同时开启“接收器鼠标/右摇杆体感”与“游戏原生体感 / Steam 输入体感”，视角会被重复驱动并出现剧烈抖动或回弹。',
      recommendation: gameNativeGyro
        ? '建议将当前档位设为“关闭体感”（完全交由游戏原生体感处理），或在游戏内关闭原生体感、仅保留接收器固件映射。'
        : '建议在 Steam 输入 / DS4Windows 中关闭陀螺仪映射，避免与接收器硬件级输出叠加。',
    };
  }
  if (out === 1 && hostMapper === 'consoleOnlyGame') {
    return {
      status: 'warn',
      title: '部分游戏不支持手柄+鼠标混合输入',
      detail: '当前档位输出“鼠标”，在锁死单一输入源的游戏（如部分主机移植或使命召唤手柄模式）中可能出现按键提示闪烁或视角拒收。',
      recommendation: '若游戏内转动手柄无反应或 UI 闪烁，请将输出方式切换为“右摇杆”，并使用下方“右摇杆校准向导”匹配游戏死区。',
    };
  }
  return {
    status: 'ok',
    title: out === 0 ? '纯原生直通模式（无冲突）' : out === 1 ? '硬件级鼠标体感模式（推荐 PC 射击）' : '硬件级右摇杆体感模式（兼容全部手柄游戏）',
    detail: out === 0
      ? '接收器不改写鼠标或右摇杆，原始 IMU 与按键完整透传给游戏或 Steam。'
      : out === 1
        ? '接收器通过独立 USB 鼠标接口输出 1:1 视角，零死区、延迟最低；请确保游戏内原生体感与 Steam 体感保持关闭。'
        : '体感直接合入 USB 手柄右摇杆报告，脱离后台软件即可在所有支持手柄的游戏中使用。',
    recommendation: '当前组合工作正常，无需额外调整。',
  };
}
