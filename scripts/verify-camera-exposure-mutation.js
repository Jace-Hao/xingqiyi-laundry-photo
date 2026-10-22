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
    // 锚点随 §7.3 勘误（QA DEF-1）更新：LUT 由「码值域幂次曲线」改为与 §7.5 同源的
    // sRGB 模型 out = in × 2^(ev/gamma)，原来的 `var g = Math.pow(2, -ev);` 已不存在
    name: 'LUT 退化成恒等（黑色衣物一点没被压暗，过曝照旧）',
    from: 'var k = Math.pow(2, v / SRGB_GAMMA);',
    to: 'var k = 1; /* MUTANT: 退化 */',
    // E49（暗部 >0）在恒等 LUT 下照样绿是对的：完全不压暗当然也不会把暗部压成 0，
    // 那条断言针对的是「过压」而不是「不压」；抓「不压」的是 E26/E27/E29/E46/E47
    expect: ['E26', 'E27', 'E29', 'E46', 'E47']
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
  },

  /* ---------------- 幽灵能力：有效性验证与档位自动降级（§7.5）---------------- */
  {
    id: 'M30',
    // 现场 2026-10：设备报告有 exposureCompensation、applyConstraints 不报错，
    // 但画面亮度完全不受影响。删掉这段判定 = 幽灵能力永远不降级，闭环贴着
    // expEvMin 空转，用户看到「徽标显示 -2EV 但画面一点没暗」
    name: '★幽灵能力★ 无效检测被删掉（发了补偿但亮度不降也不降级）',
    from: 'if (v.verdict === \'ineffective\') {',
    to: 'if (false) { /* MUTANT: 无效检测被删除 */',
    expect: ['R6', 'R7', 'R9', 'R11', 'R13', 'R17', 'R19', 'R20']
  },
  {
    id: 'M31',
    // §10 待明确事项 6 已用现场数据结案：-2.0 不够，闭环贴住下限仍不达标
    name: 'EV 累计下限改回 -2.0（闭环贴住下限空转，永远不收敛）',
    from: 'expEvMin: -3.0,',
    to: 'expEvMin: -2.0,',
    // 只预期 D13/R3/R4：D15/D16 走的是「显式传入 expEvMin 的推演」，刻意不受
    // DEFAULTS 影响（它们证明的是下限值本身的必要性，不是默认值有没有改）
    expect: ['D13', 'R3', 'R4']
  },
  {
    id: 'M32',
    // 滞回是「防误伤」的核心：AE 收敛、衣物微动都会让单帧亮度偏高，
    // 单帧即判会把好设备直接降成软件兜底（预览不再变化，用户以为功能坏了）
    name: '有效性判定的滞回被删掉（单帧无响应就把好设备降级）',
    from: 'if (drop < need) streak++; else streak = 0;',
    to: 'if (drop < need) streak = e.hits; else streak = 0;',
    // 只预期 O11：O18（慢热设备中途恢复响应）在变异下仍然绿是对的——它的最后
    // 一个样本达标会把 streak 清零，本就不该被判无效。真正能抓住这条变异的是
    // 「只有 1 次无响应时必须 pending」这条
    expect: ['O11']
  },
  {
    id: 'M33',
    // 降级前必须先把旧档位的补偿还回去：否则两份曝光偏置叠在同一台设备上，
    // 用户看到的是「画面莫名偏暗」而不是「辅助没生效」
    name: '降级前不还原旧档位约束（补偿与手动档偏置叠加）',
    from: '      restoreExposure(reason);\n      var cap = null;',
    to: '      /* MUTANT: 降级前不还原 */\n      var cap = null;',
    expect: ['R11']
  },
  {
    id: 'M34',
    // ★QA DEF-1 的负向对照★：把 LUT 退回旧实现的「码值域幂次曲线」。
    // 那条曲线与 EV 的定义脱钩（线性光被取幂而不是被缩放），ev=-3 时黑衣物主体
    // 150 → 4（近全黑）、被裁剪的白色 255 → 255（永远救不回来）、暗部全抹成 0。
    // 这条变异必须转红，否则 E46~E50 的语义断言等于没写
    name: '★QA DEF-1★ LUT 退回码值域幂次曲线（压暗量与 EV 脱钩）',
    from: 'lut[i] = Math.round(i * k);',
    to: 'lut[i] = Math.round(255 * Math.pow(i / 255, Math.pow(2, -ev)));',
    expect: ['E46', 'E47', 'E49', 'E50', 'E57']
  },
  {
    id: 'M35',
    // ★QA DEF-2 的负向对照★：tier0 若继续用 nextEvStep 的闭环，因为只改存档图不改
    // 预览，误差恒为正 → EV 一路撞到 expEvMin（主体 100 会被过压 1.27 档）
    name: '★QA DEF-2★ tier0 退回闭环步进（存档被过压到下限）',
    from: 'var solved = solveTier0Ev(cl.subjectMean, cfg);',
    to: 'var solved = nextEvStep(expAssist.ev, cl.subjectMean, cfg).ev;',
    // S 组是控制器层对照：E51/E52 是纯函数断言，抓不到控制器这条路径的变异
    expect: ['S2', 'S3', 'S4']
  },
  {
    id: 'M36',
    // QA 观察项 U19：降级结论不跨 engage 持久 → 幽灵设备每放一件衣物都要重走
    // 约 4s 的「徽标显示 -xEV、画面其实没压暗」窗口，正是现场投诉的形态
    name: '★QA U19★ 幽灵记忆被删掉（换衣物又重走一次无效补偿窗口）',
    from: 'while (plan.tier > 0 && expGhostBlocked(plan.tier) && guard++ < 4) {',
    to: 'while (false) { /* MUTANT: 幽灵记忆被删除 */',
    expect: ['T2', 'T3', 'T4']
  },
  {
    id: 'M37',
    // 记忆按设备记：换了一台摄像头还沿用上一台的「这条路径无效」结论，会把好设备
    // 永久挡在硬件档之外（比误降级更难排查）
    name: '幽灵记忆不按设备区分（换摄像头后串档）',
    from: 'if (devId !== expGhost.dev) { expGhost.dev = devId; expGhost.tiers = {}; }',
    to: '/* MUTANT: 不按设备区分 */',
    expect: ['T10']
  },
  {
    id: 'M38',
    // QA DEF-3：双档都无效的设备，跳档只跳一次 → tier2 会被完整重走一遍，
    // 无效窗口只从 4.3s 降到 3.5s 而不是 0
    name: '★QA DEF-3★ 跳档只跳一次（不循环复查记忆，tier2 又被重走）',
    from: 'while (plan.tier > 0 && expGhostBlocked(plan.tier) && guard++ < 4) {',
    to: 'if (plan.tier > 0 && expGhostBlocked(plan.tier)) { /* MUTANT: 只跳一次 */',
    expect: ['T12']
  },
  {
    id: 'M39',
    // QA DEF-4 的一半：engage 侧若改回直接读 settings.deviceId，拿不到时是空串，
    // 与记忆侧的 track#N 永远不相等 → 记忆刚写下就被自己判成「换设备」清空
    name: '★QA DEF-4★ engage 侧身份与记忆侧不同源（记忆刚记下就被清空）',
    from: 'var devId = devIdOf();',
    to: "var devId = (settings && settings.deviceId) ? String(settings.deviceId) : ''; /* MUTANT: 不同源 */",
    expect: ['T15']
  },
  {
    id: 'M40',
    // QA DEF-4 的另一半：去掉 label 兜底 → 两台都不上报 deviceId 的设备落进同一个
    // track 实例槽 → 好设备被上一台幽灵设备的记录挡住
    name: '★QA DEF-4★ 去掉 label 兜底（无 deviceId 的两台设备串档）',
    from: "if (!id) { try { if (t.label) id = String(t.label); } catch (e2) { id = ''; } }",
    to: '/* MUTANT: 无 label 兜底 */',
    expect: ['T17']
  },
  {
    id: 'M41',
    // QA DEF-4 的原始形态：整条兜底链删掉，拿不到 deviceId 就返回 '' → 两台都不上报
    // deviceId 的设备共用同一个空串槽，好设备被上一台幽灵设备的记录挡住
    name: '★QA DEF-4★ 兜底链整条删掉（拿不到 deviceId 就返回空串，两台设备共槽）',
    from: "if (!id) { try { if (t.id) id = String(t.id); } catch (e1) { id = ''; } }\n      if (!id) { try { if (t.label) id = String(t.label); } catch (e2) { id = ''; } }\n      if (!id) {\n        try {\n          if (t.__expUid == null) t.__expUid = 'track#' + (++ghostUidSeq);\n          id = String(t.__expUid);\n        } catch (e3) { id = ''; }\n      }",
    to: '/* MUTANT: 兜底链被删掉，id 恒为 "" */',
    expect: ['T17', 'T21']
  },
  {
    id: 'M42',
    // QA DEF-5 方案① 的负向对照：记账门槛退回「判无效 1 次即记账」。
    // 环境光漂移（U4b：持续变亮 ≥6 码值/秒）造成的一次误判就会被固化成本会话的
    // 「永久失去硬件补偿」——正是 team-lead 拍板 2 次门槛要挡掉的风险
    name: '★QA DEF-5★ 记账门槛退回 1 次（一次漂移误判就永久降级）',
    from: 'var EXP_GHOST = { minStrikes: 2 };',
    to: 'var EXP_GHOST = { minStrikes: 1 }; /* MUTANT: 一次即记账 */',
    // T2/T2b 钉住「第 2 次 engage 仍要探测」，T12 钉住双档同样受门槛约束
    expect: ['T2', 'T12']
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
