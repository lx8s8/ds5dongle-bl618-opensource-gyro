import { buttonNames, defaults, fields } from './protocol.mjs';

export const MODIFIER_BITS = [
  { bit: 1, label: 'Ctrl' },
  { bit: 2, label: 'Shift' },
  { bit: 4, label: 'Alt' },
  { bit: 8, label: 'Win' },
];

export const TRIGGER_NAMES = ['无扳机', 'L2', 'R2'];
export const AXIS_NAMES = ['Yaw', 'Roll'];
export const OUTPUT_NAMES = ['已关闭', '鼠标', '右摇杆'];
export const ACTIVATION_NAMES = ['始终开启', '按住开启', '按键切换', '按住暂停'];

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
];

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
  return `${describeTriggerCondition(c)} → ${mode} ${sens}${ads}`;
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
