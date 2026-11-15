import assert from 'node:assert/strict';
import { decodeConfig, defaults, encodeConfig, globalDefaults } from '../web/protocol.mjs';
import {
  GYRO_PRESETS,
  configsMatch,
  describeTriggerCondition,
  formatModifierMask,
  getConfigVisibility,
  getMacroRuleVisibility,
  globalsMatch,
  isRemapRowModified,
  summarizeGyroConfig,
  toggleModifierBit,
} from '../web/ui-helpers.mjs';

for (const preset of GYRO_PRESETS) {
  const built = preset.build();
  const decoded = decodeConfig(encodeConfig(built));
  assert.equal(configsMatch(built, decoded), true, `Preset ${preset.id} must round-trip cleanly`);
}

{
  const off = { ...defaults(), output: 0 };
  const visOff = getConfigVisibility(off);
  assert.equal(visOff.active, false);
  assert.equal(visOff.isMouse, false);
  assert.equal(visOff.isStick, false);
  assert.equal(visOff.usesGate, false);
  assert.equal(visOff.usesThreshold, false);
  assert.equal(summarizeGyroConfig(off), '已关闭');
}

{
  // Even with activation=always(0), adsMultiplier!=1 uses L2 threshold/releaseThreshold in src/gyro.c.
  const alwaysAds = { ...defaults(), output: 1, activation: 0, trigger: 0, adsMultiplier: 0.75 };
  const vis = getConfigVisibility(alwaysAds);
  assert.equal(vis.active, true);
  assert.equal(vis.isMouse, true);
  assert.equal(vis.usesGate, false);
  assert.equal(vis.usesThreshold, true);
  assert.equal(vis.usesAdsThreshold, true);
  assert.match(summarizeGyroConfig(alwaysAds), /始终启用.*鼠标 2x.*L2 0\.75x/);
}

{
  const stick = { ...defaults(), output: 2, activation: 1, trigger: 1, accel: 1.5 };
  const vis = getConfigVisibility(stick);
  assert.equal(vis.isStick, true);
  assert.equal(vis.isMouse, false);
  assert.equal(vis.usesAccelRange, true);
  assert.equal(describeTriggerCondition(stick), 'L2（按住开启）');
}

{
  const a = defaults();
  const b = { ...defaults(), sx: 2.00001 };
  assert.equal(configsMatch(a, b), true);
  const c = { ...defaults(), sx: 2.05 };
  assert.equal(configsMatch(a, c), false);

  const g1 = globalDefaults();
  const g2 = globalDefaults();
  assert.equal(globalsMatch(g1, g2), true);
  g2.actions[0].fine = 0.75;
  assert.equal(globalsMatch(g1, g2), false);
}

{
  let m = 0;
  m = toggleModifierBit(m, 1, true);
  m = toggleModifierBit(m, 4, true);
  assert.equal(m, 5);
  assert.equal(formatModifierMask(m), 'Ctrl + Alt');
  m = toggleModifierBit(m, 1, false);
  assert.equal(m, 4);
  assert.equal(formatModifierMask(0), '无修饰键');

  assert.equal(isRemapRowModified({ type: 0, value: 3, modifier: 0, flags: 0 }, 3), false);
  assert.equal(isRemapRowModified({ type: 0, value: 3, modifier: 0, flags: 1 }, 3), false);
  assert.equal(isRemapRowModified({ type: 0, value: 4, modifier: 0, flags: 0 }, 3), true);
  assert.equal(isRemapRowModified({ type: 1, value: 4, modifier: 0, flags: 0 }, 4), true);

  assert.deepEqual(getMacroRuleVisibility({ gesture: 0 }), { usesHoldMs: false, usesTapMs: false });
  assert.deepEqual(getMacroRuleVisibility({ gesture: 2 }), { usesHoldMs: true, usesTapMs: false });
  assert.deepEqual(getMacroRuleVisibility({ gesture: 3 }), { usesHoldMs: false, usesTapMs: true });
}

console.log('ui helpers assertions passed');
