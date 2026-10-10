'use strict';
/* =============================================================================
 * verify-camera-res-mutation.js —— 负向对照（变异测试）
 *
 * 目的：证明「上一层的测试用例真的抓得住缺陷」，而不是假阳性。
 * 做法：把 renderer/camera-controller.js 复制一份，注入一处人为缺陷，
 *       再跑一遍 scripts/verify-camera-res-qa2.js，检查预期断言确实变红。
 *
 *   node scripts/verify-camera-res-mutation.js
 *
 * 判定：每条变异必须让「预期变红的断言」至少命中一条；
 *       第 12 条是「补上预算闸门」的正向探针，注入修复后 D2/D2b 必须转绿。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'renderer', 'camera-controller.js');
const MUT = path.join(ROOT, 'scripts', '.qa-mutant-camera-controller.js');
const SUITE = path.join(ROOT, 'scripts', 'verify-camera-res-qa2.js');

const src = fs.readFileSync(SRC, 'utf8');
const suiteMod = require(SUITE);

/* 每条变异：注入什么缺陷 → 哪些断言必须变红 */
const MUTATIONS = [
  {
    id: 'M1',
    name: 'gUM 约束：记忆档位的 exact 换成 ideal（buildResolutionConstraints）',
    from: '      video.width = { exact: r.width };',
    to: '      video.width = { ideal: r.width };',
    expect: ['F1 重启后第一次 gUM 就带上 width/height exact', 'F4 指定设备重启']
  },
  {
    id: 'M2',
    name: '逐档锁定：applyConstraints 的 exact 换成 ideal（tryApplyRung）',
    from: '      var cst = { width: { exact: rung.width }, height: { exact: rung.height } };',
    to: '      var cst = { width: { ideal: rung.width }, height: { ideal: rung.height } };',
    expect: ['B1 锁定第四档', 'B2 三档失败原因']
  },
  {
    id: 'M3',
    name: '逐档校验：sameRung 恒真（等于不做校验）',
    from: '      return a.width === b.width && a.height === b.height;',
    to: '      return true;',
    expect: ['B1 锁定第四档', 'B2 三档失败原因']
  },
  {
    id: 'M4',
    name: '悬挂定时器：去掉 tryApplyRung 里的 acw.cancel()',
    from: '      acw.cancel();',
    to: '      /* MUTANT: 定时器未回收 */',
    expect: ['B5 结束后无悬挂定时器', 'G2 流程结束后 pending 定时器', 'D4 无悬挂定时器']
  },
  {
    id: 'M5',
    name: '开流前不读记忆档位（buildConstraints 跳过 loadPref）',
    from: '      if (!fallbackNoExact && !resPrefMissed && loadPref) {',
    to: '      if (false && !fallbackNoExact && !resPrefMissed && loadPref) {',
    expect: ['F1 重启后第一次 gUM 就带上 width/height exact', 'E2 记为 miss', 'E4 默认设备（空串键）存档命中']
  },
  {
    id: 'M6',
    name: '逐档校验结果被忽略（sameRung(got, rung) 恒真 → 假切档也算成功）',
    from: '        if (sameRung(got, rung)) {',
    to: '        if (true) {',
    expect: ['B1 锁定第四档', 'B3 失败档位不得出现在最终 resolution']
  },
  {
    id: 'M7',
    name: '阶梯构造去掉区间合法性校验（会拼出设备不支持的档位）',
    from: '      if (!(pw >= wMin && pw <= w.max && ph >= hMin && ph <= h.max)) return;',
    to: '      if (false) return;',
    expect: ['A1 每一档都落在 [min,max] 内']
  },
  {
    id: 'M8',
    name: '存档键恒为默认键（切换摄像头串档）',
    from: "      return deviceId ? deviceId : '';",
    to: "      return ''; /* MUTANT: 串档 */",
    expect: ['E6 再次打开 B → 命中它自己的存档', 'E6 首次打开 B 后按设备 id 落档']
  },
  {
    id: 'M9',
    name: '存档不校验版本号（脏存档会被当成有效记忆）',
    from: '    if (raw.v != null && Number(raw.v) !== RES_PREF_VERSION) return null;',
    to: '    if (false) return null;',
    expect: ['E2 版本不认']
  },
  {
    id: 'M10',
    name: '出画校验不以画面真实尺寸为准（状态显示撒谎）',
    from: '      resolution = { width: vw, height: vh };',
    to: '      /* MUTANT: 不采纳画面尺寸 */',
    expect: ['I1 以画面真实尺寸为准']
  },
  {
    id: 'M11',
    name: '存档不带来源设备 dev（默认设备换过后沿用旧档位）',
    from: "      dev: typeof dev === 'string' ? dev : ''",
    to: "      dev: '' /* MUTANT: 丢失来源设备 */",
    expect: ['E1b 记下 device-changed 证据']
  },
  {
    id: 'M12',
    // 原为「正向探针」（源码缺失闸门时注入修复必须转绿）；闸门补上后改成负向变异：
    // 拆掉循环头部的复查点，D2/D2b 必须重新变红，否则说明这条闸门没人守
    name: '拆除 resBudgetMs 总预算闸门（恒挂设备会把出画拖到十几秒）',
    from: '        if (budgetHit || now() >= deadline) { budgetHit = true; break; }',
    to: '        /* MUTANT: 总预算闸门被拆除 */',
    expect: ['D2 总耗时被 resBudgetMs 卡住', 'D2b 探测档数被预算截断']
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
  console.log('=== verify-camera-res-mutation：负向对照（变异测试）===\n');

  // 基线：未变异源码
  const base = await run(null);
  console.log('· 基线（未变异源码）：' + base.pass + ' 通过 / ' + base.fail + ' 失败');
  base.failures.forEach(function (m) { console.log('    - ' + m); });
  console.log('');

  let mPass = 0;
  let mFail = 0;
  for (const m of MUTATIONS) {
    const n = src.split(m.from).length - 1;
    if (n !== 1) {
      console.log('✗ ' + m.id + ' 锚点在源码中命中 ' + n + ' 次（应为 1），跳过');
      mFail++;
      continue;
    }
    fs.writeFileSync(MUT, src.split(m.from).join(m.to), 'utf8');
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
    // 判定标准：变异必须产生「基线之外的」新增失败 —— 有新红才算抓得住
    const isNew = function (f) { return !base.failures.some(function (b) { return b === f; }); };
    const newFails = r.failures.filter(isNew);

    if (m.expectFix) {
      // 正向探针：注入「修复」后这些断言必须由红转绿；
      // 若源码本身已经修好（基线就是绿的），只要保持绿也算通过
      const gone = [];
      const alreadyGreen = [];
      m.expectFix.forEach(function (k) {
        const inBase = base.failures.some(function (f) { return f.indexOf(k) === 0; });
        const inNow = r.failures.some(function (f) { return f.indexOf(k) === 0; });
        if (inBase && !inNow) gone.push(k);
        else if (!inBase && !inNow) alreadyGreen.push(k);
      });
      if (gone.length + alreadyGreen.length === m.expectFix.length && r.fail !== -1) {
        console.log('✓ ' + m.id + '（正向探针）注入修复后 ' + gone.length + ' 条由红转绿、' +
          alreadyGreen.length + ' 条本来就是绿，共 ' + m.expectFix.length + '/' + m.expectFix.length);
        gone.forEach(function (g) { console.log('      ↳ 转绿：' + g); });
        mPass++;
      } else {
        console.log('✗ ' + m.id + '（正向探针）未通过：转绿 ' + gone.length + '/' + m.expectFix.length +
          '，剩余失败 ' + JSON.stringify(r.failures));
        mFail++;
      }
      continue;
    }

    const hit = m.expect.filter(function (k) {
      return newFails.some(function (f) { return f.indexOf(k) === 0; });
    });
    if (newFails.length > 0) {
      console.log('✓ ' + m.id + ' 注入「' + m.name + '」→ 新增 ' + newFails.length + ' 条断言变红' +
        '（预期命中 ' + hit.length + '/' + m.expect.length + '）');
      newFails.forEach(function (f) { console.log('      ↳ ' + f); });
      mPass++;
    } else {
      console.log('✗ ' + m.id + ' 注入「' + m.name + '」→ 没有产生任何新增失败（该缺陷测不出来！）');
      console.log('      实际失败与基线完全相同：' + JSON.stringify(r.failures));
      mFail++;
    }
  }

  try { fs.unlinkSync(MUT); } catch (e) {}

  console.log('\n结果：' + mPass + ' 条变异被抓住，' + mFail + ' 条未抓住');
  if (mFail) process.exitCode = 1;
}

main();
