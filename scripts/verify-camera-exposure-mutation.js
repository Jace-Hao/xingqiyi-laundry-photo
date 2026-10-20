'use strict';
/* =============================================================================
 * verify-camera-exposure-mutation.js —— 曝光辅助的负向对照（变异测试）
 *
 * 目的：证明「verify-camera-exposure.js 真的抓得住缺陷」，而不是一堆恒真断言。
 * 做法：把 renderer/camera-controller.js 复制一份，逐条注入人为缺陷，
 *       重跑主检套件，检查预期断言确实由绿转红。
 *
 *   node scripts/verify-camera-exposure-mutation.js
 *
 * 判定：每条变异都必须产出「基线之外的」新增失败；锚点命中次数不为 1 视为变异体作废。
 * 设计文档：docs/exposure-assist-design.md §12 T02/T03
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'renderer', 'camera-controller.js');
const MUT = path.join(ROOT, 'scripts', '.qa-mutant-exposure-controller.js');
const SUITE = path.join(ROOT, 'scripts', 'verify-camera-exposure.js');

const srcRaw = fs.readFileSync(SRC, 'utf8');
// 统一成 LF：仓库文件在 Windows 下是 CRLF，多行锚点若不做归一化会永远命中 0 次，
// 那会让「锚点未命中」被误当成「缺陷测不出来」而掩盖真实覆盖缺口
const src = srcRaw.replace(/\r\n/g, '\n');
const suiteMod = require(SUITE);

/* 每条变异：注入什么缺陷 → 哪些断言必须变红（按断言前缀匹配） */
const MUTATIONS = [
  /* ---------------- 纯函数层：场景判定闸门 ---------------- */
  {
    id: 'M01',
    name: '场景均值下限作废（昏暗店面 / 挡镜头会被误判成黑衣物）',
    from: 'expSceneMeanMin: 45,',
    to: 'expSceneMeanMin: 0,',
    expect: ['B6', 'B9']
  },
  {
    id: 'M02',
    name: '高亮参照下限作废（没有亮垫板也敢负补偿）',
    from: 'expHiAreaMin: 0.06,',
    to: 'expHiAreaMin: 0,',
    expect: ['B19']
  },
  {
    id: 'M03',
    name: '主体面积下限作废（零星暗物：电线 / 桌沿阴影也会触发）',
    from: 'expSubjectAreaMin: 0.08,',
    to: 'expSubjectAreaMin: 0,',
    expect: ['B10', 'B11', 'B15']
  },
  {
    id: 'M04',
    name: '主体面积上限作废（整体昏暗场景被当成黑衣物）',
    from: 'expSubjectAreaMax: 0.75,',
    to: 'expSubjectAreaMax: 1.01,',
    expect: ['B8']
  },
  {
    id: 'M05',
    name: '中心加权作废（画面边缘的暗物也能触发）',
    from: 'expCenterSubjectMin: 0.15,',
    to: 'expCenterSubjectMin: 0,',
    expect: ['B12']
  },
  {
    id: 'M06',
    name: '饱和度闸门作废（深蓝 / 深棕衣物被当成过曝的黑）',
    from: 'expSubjectSatMax: 0.28,',
    to: 'expSubjectSatMax: 0.99,',
    expect: ['B15']
  },

  /* ---------------- 纯函数层：滞回 ---------------- */
  {
    id: 'M07',
    name: '滞回 engage 门槛拆除（单帧命中就介入 → 画面反复横跳）',
    from: 'if (s.state === \'IDLE\' && s.hit >= c.expEngageHits &&',
    to: 'if (s.state === \'IDLE\' && s.hit >= 1 &&',
    expect: ['C1']
  },
  {
    id: 'M08',
    name: 'release 后冷却拆除（半出画 → 再入画会反复 engage/release）',
    from: 'nowMs - (st.releasedAt || 0) >= c.expReEngageCooldownMs',
    to: 'true /* MUTANT: 冷却被拆除 */',
    expect: ['C10']
  },
  {
    id: 'M09',
    name: 'engage 后最短保持拆除（衣物半出画就急着恢复）',
    from: 'nowMs - (st.engagedAt || 0) >= c.expMinHoldMs',
    to: 'true /* MUTANT: 最短保持被拆除 */',
    expect: ['C7']
  },
  {
    id: 'M10',
    name: '滞回 release 门槛拆除（单帧未命中就恢复）',
    from: 'if (s.state === \'ACTIVE\' && s.miss >= c.expReleaseMisses &&',
    to: 'if (s.state === \'ACTIVE\' && s.miss >= 1 &&',
    expect: ['C6']
  },

  /* ---------------- 纯函数层：EV 闭环 ---------------- */
  {
    id: 'M11',
    name: 'EV 死区拆除（AE 自身波动也当成误差去调 → 呼吸感 / 日志爆炸）',
    from: 'if (Math.abs(err) < c.expDeadzone) return { ev: curEv, step: 0, err: err };',
    to: '/* MUTANT: 死区被拆除 */',
    expect: ['D1']
  },
  {
    id: 'M12',
    name: 'EV 累计下限钳位拆除（会把画面压到逼近黑帧闸门）',
    from: 'if (next < c.expEvMin) next = c.expEvMin; // 下限保护：再暗就逼近黑帧闸门',
    to: '/* MUTANT: 累积下限被拆除 */',
    expect: ['D6']
  },
  {
    id: 'M13',
    name: '单步上限拆除（一步跨太大 EV，画面会闪）',
    from: 'if (step > c.expMaxStepEv) step = c.expMaxStepEv;',
    to: '/* MUTANT: 单步上限被拆除 */',
    expect: ['D5']
  },
  {
    id: 'M14',
    name: 'LUT 退化成线性恒等（黑色衣物暗部被压成死黑，层次全丢）',
    from: 'var g = Math.pow(2, -ev);',
    to: 'var g = 1; /* MUTANT: 退化 */',
    expect: ['E26', 'E27', 'E29']
  },

  /* ---------------- 纯函数层：能力探测与约束构造 ---------------- */
  {
    id: 'M15',
    name: '能力探测跳过 tier1（有补偿能力的设备被降级成 tier0）',
    from: 'if (cap.exposureCompensation && typeof cap.exposureCompensation.min === \'number\') {',
    to: 'if (false) {',
    expect: ['E1', 'E10', 'F4']
  },
  {
    id: 'M16',
    name: '补偿值不按设备步长取整（部分 UVC 直接拒绝非步长整数倍的补偿）',
    from: 'if (plan.step > 0 && isFinite(plan.step)) v = Math.round(ev / plan.step) * plan.step;',
    to: '/* MUTANT: 不按步长取整 */',
    expect: ['E13']
  },
  {
    id: 'M17',
    name: '★红线变异★ 曝光约束夹带 width（破坏 applyMaxResolution 的分辨率锁定）',
    from: 'return { advanced: [{ exposureMode: \'continuous\', exposureCompensation: v }] };',
    to: 'return { advanced: [{ exposureMode: \'continuous\', exposureCompensation: v }], width: { exact: 1920 } };',
    expect: ['E16', 'F9']
  },
  {
    id: 'M18',
    name: '恢复约束变成 null（衣物移出后设备停在降曝态，画面莫名偏暗）',
    from: 'if (plan.tier === 1) return { advanced: [{ exposureCompensation: 0 }] };',
    to: 'if (plan.tier === 1) return null; /* MUTANT */',
    expect: ['E21', 'F15']
  },

  /* ---------------- 编排层 ---------------- */
  {
    id: 'M19',
    name: '黑帧门控被拆除（被正确压暗的黑衣物会被误判成全黑而拒拍）',
    from: 'if (r.black && expGateSuppress()) {',
    to: 'if (false) {',
    expect: ['K2', 'K3']
  },
  {
    id: 'M20',
    name: 'release 不做恢复（衣物移出后设备一直停在降曝态）',
    from: '      restoreExposure(reason);\n      expAssist.state = \'IDLE\';',
    to: '      /* MUTANT: release 不恢复 */\n      expAssist.state = \'IDLE\';',
    expect: ['F15', 'F16']
  },
  {
    id: 'M21',
    name: '去掉对焦脉冲避让（脉冲期间帧统计是噪声，且约束交叠有回弹风险）',
    from: 'if (focusBusy && focusBusy()) {',
    to: 'if (false) {',
    expect: ['I1', 'I2']
  },
  {
    id: 'M22',
    name: '去掉页面隐藏避让（后台还在每 250ms 采帧做统计）',
    from: 'if (pageVisible && !pageVisible()) {',
    to: 'if (false) {',
    expect: ['I5', 'I6']
  },
  {
    id: 'M23',
    name: '去掉 applyConstraints 竞速超时（UVC 悬挂会把曝光周期永久卡死）',
    from: 'expW.promise.then(function (v) { return v === false ? \'aborted\' : \'timeout\'; })',
    to: 'new Promise(function () {})',
    expect: ['G1', 'G2']
  },
  {
    id: 'M24',
    name: 'releaseActive 不做恢复（sleep / 卸载后自定义曝光残留在设备上）',
    from: 'if (expAssist.state === \'ACTIVE\' && expAssist.dirty) restoreExposure(\'release\');',
    to: '/* MUTANT: 释放路径不恢复 */',
    expect: ['L8']
  },
  {
    id: 'M25',
    name: '总开关失效（window.__xqyExposureAssist=false 也拦不住）',
    from: 'try { return exposureAssistEnabled() !== false; } catch (e) { return false; }',
    to: 'try { return true; } catch (e) { return false; }',
    expect: ['J1', 'J2', 'J3']
  },
  {
    id: 'M26',
    // 这条变异体还原的正是设计文档 §8.2 的原始写法：状态对象只复制 state/hit/miss，
    // engagedAt / releasedAt 在多帧之间丢失 → 最短保持与冷却闸门双双永久失效
    name: '滞回状态丢失时间戳（最短保持与冷却闸门永久失效）',
    from2: '      hit: st.hit,\n      miss: st.miss,\n      engagedAt: st.engagedAt || 0,\n      releasedAt: st.releasedAt || 0\n    };',
    to2: '      hit: st.hit,\n      miss: st.miss\n    };',
    expect: ['C7', 'C10']
  },
  {
    id: 'M27',
    // 收尾修复项 1：设备把 step 报成 Infinity 时，Math.round(ev/∞)×∞ === NaN
    // 会一路送进 applyConstraints，负补偿等于没发
    name: '步长取整不校验 isFinite（step=Infinity 的设备收到 NaN 约束）',
    from: 'if (plan.step > 0 && isFinite(plan.step)) v = Math.round(ev / plan.step) * plan.step;',
    to: 'if (plan.step > 0) v = Math.round(ev / plan.step) * plan.step;',
    expect: ['E33', 'E34', 'E35']
  },
  {
    id: 'M28',
    // 收尾修复项 2：能力残缺设备退化成「切了 manual 却不发曝光值」，
    // 画面不会被压暗，但徽标仍显示「曝光补偿 xEV」——用户可见的撒谎
    name: 'tier2 不校验 min 可用性（徽标说在压暗，画面其实没压）',
    from: 'if (timeMin == null && isoMin == null) return { tier: 0, reason: \'manual-without-min\' };',
    to: '/* MUTANT: 不校验 min 可用性 */',
    // 只预期 E36/E37：E38（不再发无曝光值的 manual）现在由构造函数末尾的
    // 不变式（见 M29）兜底，删掉上游判定后它仍然绿 —— 这是防御加深的结果，
    // 不是覆盖缺口。把 E38 留在 expect 里会产生一条误导性的「未变红」警告
    expect: ['E36', 'E37']
  },
  {
    id: 'M29',
    // 收尾修复项 3：构造函数末尾的「产不出曝光值就不发 manual」不变式。
    // 上游只守「能力没有 min」，守不住「能力有 min 但 getSettings() 不给基线」，
    // 这条组合只能靠构造函数末尾的下沉不变式封死
    name: '构造函数不守「无曝光值的 manual」不变式（基线缺失仍切手动）',
    from: 'if (adv2.exposureTime === undefined && adv2.iso === undefined) return null;',
    to: '/* MUTANT: 不守无曝光值不变式 */',
    expect: ['E43', 'E44']
  }
];

// 静默跑一遍套件：屏蔽 stdout，只取结构化结果
async function run(mod) {
  const w = console.log;
  console.log = function () {};
  try {
    return await suiteMod.runAll(mod);
  } catch (e) {
    return { pass: 0, fail: -1, failures: ['脚本异常：' + ((e && e.message) || e)] };
  } finally {
    console.log = w;
  }
}

async function main() {
  console.log('=== verify-camera-exposure-mutation：负向对照（变异测试）===\n');

  // 基线：未变异源码
  const base = await run(null);
  console.log('· 基线（未变异源码）：' + base.pass + ' 通过 / ' + base.fail + ' 失败');
  base.failures.forEach(function (m) { console.log('    - ' + m); });
  if (base.fail !== 0) {
    console.log('✗ 基线本身不绿，变异测试无意义');
    process.exitCode = 1;
    return;
  }
  console.log('');

  let mPass = 0;
  let mFail = 0;
  for (const m of MUTATIONS) {
    // M26 这类需要多行锚点的变异，允许用 from2/to2 覆盖
    const from = m.from2 != null ? m.from2 : m.from;
    const to = m.to2 != null ? m.to2 : m.to;
    const n = src.split(from).length - 1;
    if (n !== 1 || !from || !to) {
      console.log('✗ ' + m.id + ' 锚点在源码中命中 ' + n + ' 次（应为 1），跳过');
      mFail++;
      continue;
    }
    fs.writeFileSync(MUT, src.split(from).join(to), 'utf8');
    delete require.cache[require.resolve(MUT)];
    let mutant;
    try {
      mutant = require(MUT);
    } catch (e) {
      console.log('✗ ' + m.id + ' 变异体无法加载：' + (e && e.message));
      mFail++;
      continue;
    }
    const r = await run(mutant);
    const isNew = function (f) { return base.failures.indexOf(f) < 0; };
    const newFails = r.failures.filter(isNew);

    const hit = m.expect.filter(function (k) {
      return newFails.some(function (f) { return f.indexOf(k) === 0; });
    });

    if (newFails.length > 0) {
      console.log('✓ ' + m.id + ' 注入「' + m.name + '」→ 新增 ' + newFails.length + ' 条断言变红' +
        '（预期命中 ' + hit.length + '/' + m.expect.length + '）');
      newFails.slice(0, 4).forEach(function (f) { console.log('      ↳ ' + f); });
      if (hit.length < m.expect.length) {
        const miss = m.expect.filter(function (k) { return hit.indexOf(k) < 0; });
        console.log('      ! 注意：这些预期断言未变红 → ' + miss.join(','));
      }
      mPass++;
    } else {
      console.log('✗ ' + m.id + ' 注入「' + m.name + '」→ 没有产生任何新增失败（该缺陷测不出来！）');
      console.log('      实际失败与基线完全相同：' + JSON.stringify(r.failures));
      mFail++;
    }
  }

  try { fs.unlinkSync(MUT); } catch (e) {}

  console.log('\n结果：' + mPass + ' 条变异被抓住，' + mFail + ' 条未被抓住');
  if (mFail) process.exitCode = 1;
}

main().catch(function (e) {
  console.error('脚本异常：', (e && e.stack) || e);
  process.exitCode = 1;
});
