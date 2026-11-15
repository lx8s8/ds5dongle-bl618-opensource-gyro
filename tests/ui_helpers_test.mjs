import assert from 'node:assert/strict';
import { decodeConfig, defaults, encodeConfig, globalDefaults } from '../web/protocol.mjs';
import {
  GYRO_PRESETS,
  STICK_GAME_TEMPLATES,
  computeCircularityMetrics,
  computePollingStats,
  computeStickWizard,
  configsMatch,
  describeTriggerCondition,
  diffConfigBundles,
  diffGyroConfigs,
  evaluateCompatibilityMode,
  formatModifierMask,
  formatSlotTitle,
  getConfigVisibility,
  getMacroRuleVisibility,
  globalsMatch,
  isRemapRowModified,
  normalizeSlotNames,
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

{
  // Stick calibration wizard & templates (Roadmap 10)
  assert.equal(STICK_GAME_TEMPLATES.length >= 5, true);
  for (const tpl of STICK_GAME_TEMPLATES) {
    const cfg = { ...defaults(), output: 2, maxTurn: tpl.maxTurn, stickDeadzone: tpl.stickDeadzone, stickPower: tpl.stickPower, blend: tpl.blend };
    assert.equal(configsMatch(cfg, decodeConfig(encodeConfig(cfg))), true);
  }
  const wiz = computeStickWizard({ gameDeadzonePct: 12, turn360Seconds: 1.5, curveType: 'classic' });
  assert.equal(wiz.maxTurn, 240);
  assert.equal(wiz.stickDeadzone, 11.4);
  assert.equal(wiz.stickPower, 1.4);
}

{
  // Custom slot names & bundle diffing (Roadmap 13)
  assert.deepEqual(normalizeSlotNames([' Apex 步枪 ', '', null, '超长名称截断测试1234567890']), ['Apex 步枪', '', '', '超长名称截断测试12345678']);
  assert.equal(formatSlotTitle(0, 'Apex 步枪'), '配置 1 · Apex 步枪');
  assert.equal(formatSlotTitle(2, ''), '配置 3');

  const base = defaults();
  const next = { ...defaults(), output: 1, horizontal: 2, flags: 16 | 32, sx: 2.5 };
  const changes = diffGyroConfigs(base, next);
  assert.equal(changes.some(c => c.id === 'output'), true);
  assert.equal(changes.some(c => c.id === 'horizontal'), true);
  assert.equal(changes.some(c => c.id === 'autoBias'), true);
  assert.equal(changes.some(c => c.id === 'adaptiveSmooth'), true);

  const bundleDiff = diffConfigBundles(
    { profiles: [base, base, base, base], settings: globalDefaults(), slotNames: ['', '', '', ''] },
    { profiles: [next, base, base, base], settings: globalDefaults(), slotNames: ['主力步枪', '', '', ''] },
  );
  assert.equal(bundleDiff.hasChanges, true);
  assert.equal(bundleDiff.slotDiffs[0].changes.length >= 5, true);
  assert.equal(bundleDiff.slotDiffs[1].changes.length, 0);
}

{
  // Stick circularity & polling rate stats (dstester enhancements)
  const emptyCirc = computeCircularityMetrics(Array(36).fill(0));
  assert.equal(emptyCirc.rmsErrorPct, null);
  const idealCirc = computeCircularityMetrics(Array(36).fill(1.0));
  assert.equal(idealCirc.covered, 36);
  assert.equal(idealCirc.rmsErrorPct, 0);
  const squareIsh = computeCircularityMetrics(Array(36).fill(1.08));
  assert.equal(squareIsh.rmsErrorPct, 8);

  const poll = computePollingStats([2, 2, 2, 2]);
  assert.equal(poll.hz, 500);
  assert.equal(poll.avgMs, 2);
  assert.equal(poll.jitterMs, 0);
}

{
  // Compatibility advisor (Roadmap 15)
  assert.equal(evaluateCompatibilityMode({ outputMode: 1, gameNativeGyro: true, hostMapper: 'none' }).status, 'conflict');
  assert.equal(evaluateCompatibilityMode({ outputMode: 2, gameNativeGyro: false, hostMapper: 'steam' }).status, 'conflict');
  assert.equal(evaluateCompatibilityMode({ outputMode: 1, gameNativeGyro: false, hostMapper: 'consoleOnlyGame' }).status, 'warn');
  assert.equal(evaluateCompatibilityMode({ outputMode: 1, gameNativeGyro: false, hostMapper: 'none' }).status, 'ok');
}

console.log('ui helpers assertions passed');
