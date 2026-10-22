'use strict';
/* =============================================================================
 * verify-camera-exposure-qa3.js —— 曝光「幽灵能力」修复的 QA 独立复核（第二轮套件）
 *
 *   node scripts/verify-camera-exposure-qa3.js
 *
 * 与主检（verify-camera-exposure.js）的差异：**刻意不缩小时钟**。
 * 主检的 CFG 把秒级参数压到毫秒级，导致默认 2000ms 的收敛窗口在每条用例里
 * 都跑不完 —— 判定路径在旧用例中根本不触发。本套件用 DEFAULTS 的真实时序
 * （cycle 250ms / stepGap 500ms / engageDelay 800ms / releaseMisses 10 …）
 * 配合虚拟时钟推进到十几秒，覆盖「默认配置下的真实行为」。
 *
 * 覆盖：
 *   W. sRGB 降幅模型的独立数值验算（不引用被测代码的模型实现）
 *   S. 默认收敛窗口 × 真实时序：覆盖缺口复核 / 好设备与幽灵设备全链
 *   T. 降级链：还原顺序 / 换量纲 / 幽灵 manual / 能力残缺 / 下发失败
 *   U. 误伤与逃逸攻击：慢热 / 抖动 / 环境光漂移 / 钳位豁免 / 持久降级 / 降级中 release
 *   V. 现场闭环：端到端耗时、最终档位、软件兜底 LUT 与 EV 语义的一致性
 *
 * 只依赖 Node 内置模块与 renderer/camera-controller.js（UMD）。
 * 设计文档：docs/exposure-assist-design.md §7.3 / §7.5
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

const C = require(process.env.CAM_CTRL_PATH || '../renderer/camera-controller.js');

const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
const failures = [];
const notes = [];

function ok(m) { pass++; console.log('  ✓ ' + m); }
function bad(m) { fail++; failures.push(m); console.log('  ✗ ' + m); }
function assert(cond, m) { cond ? ok(m) : bad(m); }
function near(a, b, tol, m) {
  const d = Math.abs(Number(a) - Number(b));
  assert(isFinite(d) && d <= tol, m + '（实际 ' + a + '，期望 ' + b + '±' + tol + '）');
}
function note(m) { notes.push(m); }

/* ========================================================================== *
 * 一、虚拟时钟与假环境（真实时序）
 * ======================================================================== */
function makeClock(start) {
  let t = start == null ? 100000 : start;
  let nextId = 1;
  const pending = new Map();
  return {
    now() { return t; },
    setTimeout(fn, ms) { const id = nextId++; pending.set(id, { at: t + (Number(ms) || 0), fn: fn }); return id; },
    clearTimeout(id) { pending.delete(id); return undefined; },
    count() { return pending.size; },
    t() { return t; },
    advance(ms) {
      const target = t + ms;
      for (;;) {
        let sid = null, sat = Infinity;
        pending.forEach(function (v, k) { if (v.at <= target && v.at < sat) { sat = v.at; sid = k; } });
        if (sid === null) break;
        const job = pending.get(sid);
        pending.delete(sid);
        t = Math.max(t, job.at);
        job.fn();
      }
      t = target;
      return t;
    }
  };
}
async function flush(n) { const k = n == null ? 80 : n; for (let i = 0; i < k; i++) await Promise.resolve(); }
async function pump(clock, ms, step) {
  const st = step || 10;
  const target = clock.t() + ms;
  while (clock.t() < target) { clock.advance(st); await flush(24); }
  await flush(80);
}
async function drain(p, n) {
  let done = false, value;
  Promise.resolve(p).then(function (v) { done = true; value = v; }, function (e) { done = true; value = e; });
  for (let i = 0; i < (n || 800) && !done; i++) await Promise.resolve();
  return { done: done, value: value };
}

const PAL = { pad: [255, 230, 80], grey: [150, 150, 150], white: [245, 245, 245] };
function makeImage(pickColor, grid, side) {
  const g = grid || 8, s = side || 64;
  const cw = Math.floor(s / g);
  const data = new Uint8ClampedArray(s * s * 4);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const p = pickColor(Math.floor(x / cw), Math.floor(y / cw));
      const i = (y * s + x) * 4;
      data[i] = p[0]; data[i + 1] = p[1]; data[i + 2] = p[2]; data[i + 3] = 255;
    }
  }
  return { width: s, height: s, data: data };
}
// 黑衣物（中央+下方）+ 亮黄垫板；v = 主体码值
function garmentScene(v, soleClip) {
  return makeImage(function (cx, cy) {
    if (soleClip && cy === 7 && cx >= 2 && cx <= 5) return PAL.white; // 白色鞋底（部分裁剪）
    const inCenter = cy >= 2 && cy <= 4 && cx >= 2 && cx <= 5;
    const below = (cy === 5 || cy === 6) && cx >= 1 && cx <= 5;
    return inCenter || below ? [v, v, v] : PAL.pad;
  });
}
// 衣物移出画面：全亮垫板 → 场景不命中
const EMPTY_SCENE = makeImage(function () { return PAL.pad; });

// 真实现场时序（逐项取自 DEFAULTS，不做毫秒级压缩）
const REAL = {
  openTimeoutMs: 200, frameWaitMs: 100, framePollMs: 5, degradedWatchMs: 60, attachTimeoutMs: 100,
  backoffMs: [10, 10, 10, 10], maxAttempts: 5,
  expEngageDelayMs: 800, expCycleMs: 250, expEngageHits: 3, expReleaseMisses: 10,
  expMinHoldMs: 1500, expReEngageCooldownMs: 3000, expStepGapMs: 500, expSettleMs: 400,
  expApplyTimeoutMs: 1000, expApplyFailLimit: 2
};
// 主检那种毫秒级压缩配置（用于量化「覆盖缺口」的对照实验）
const FAST = {
  openTimeoutMs: 200, frameWaitMs: 100, framePollMs: 5, degradedWatchMs: 60, attachTimeoutMs: 100,
  backoffMs: [10, 10, 10, 10], maxAttempts: 5,
  expEngageDelayMs: 10, expCycleMs: 10, expEngageHits: 3, expReleaseMisses: 4,
  expMinHoldMs: 20, expReEngageCooldownMs: 30, expStepGapMs: 20, expSettleMs: 10,
  expApplyTimeoutMs: 40, expApplyFailLimit: 2
};

function makeTrack(o) {
  const opts = o || {};
  return {
    readyState: 'live', muted: false, _h: {},
    caps: opts.caps !== undefined ? opts.caps : { exposureCompensation: { min: -3, max: 3, step: 0.1 } },
    settings: opts.settings || { exposureCompensation: 0 },
    failIf: opts.failIf || null,
    calls: [],
    addEventListener(k, f) { (this._h[k] = this._h[k] || []).push(f); },
    removeEventListener() {},
    stop() { this.readyState = 'ended'; },
    getCapabilities() { return this.caps; },
    getSettings() { return this.settings; },
    applyConstraints(cst) {
      this.calls.push(cst);
      if (this.failIf && this.failIf(cst)) return Promise.reject(new Error('apply-reject'));
      return Promise.resolve();
    }
  };
}

/**
 * @param {object} o  image 可为函数（响应型设备）/ 静态图（幽灵设备）/ 数组（按时序切换）
 */
function harness(o) {
  const opts = o || {};
  const clock = opts.clock || makeClock(100000);
  const logs = [];
  const track = opts.track || makeTrack(opts.trackOpts);
  const stream = { getTracks: function () { return [track]; }, getVideoTracks: function () { return [track]; } };
  const video = { readyState: 4, videoWidth: 640, videoHeight: 480, srcObject: null, play: function () { return Promise.resolve(); } };
  const state = {
    image: opts.image !== undefined ? opts.image : garmentScene(150),
    gray: new Array(64 * 64).fill(140),
    visible: true, focus: false, assistOn: true
  };
  const ctrl = C.createCameraController({
    mediaDevices: {
      getUserMedia: function () { return Promise.resolve(stream); },
      enumerateDevices: function () { return Promise.resolve([]); },
      addEventListener: function () {}, removeEventListener: function () {}
    },
    videoGetter: function () { return video; },
    now: function () { return clock.now(); },
    setTimeout: function (fn, ms) { return clock.setTimeout(fn, ms); },
    clearTimeout: function (id) { return clock.clearTimeout(id); },
    log: function (l, e, f) { logs.push({ level: l, event: e, fields: f || {} }); },
    frameSampler: function () { return state.gray; },
    gridSampler: function () { return typeof state.image === 'function' ? state.image() : state.image; },
    pageVisible: function () { return state.visible; },
    focusBusy: function () { return state.focus; },
    exposureAssistEnabled: function () { return state.assistOn; },
    config: Object.assign({}, opts.base === 'fast' ? FAST : REAL, opts.config || {})
  });
  return {
    clock: clock, logs: logs, track: track, ctrl: ctrl, video: video,
    setImage: function (i) { state.image = i; },
    boot: async function () { await drain(ctrl.mount(function () { return video; })); await flush(40); }
  };
}

// 取「最后一次真的下发到设备的补偿量」（幽灵/响应型设备的画面模型要用它）
function lastAppliedComp(track) {
  for (let i = track.calls.length - 1; i >= 0; i--) {
    const a = track.calls[i] && track.calls[i].advanced && track.calls[i].advanced[0];
    if (a && typeof a.exposureCompensation === 'number') return a.exposureCompensation;
  }
  return 0;
}
// 取「最后一次真的下发的曝光时间」
function lastAppliedTime(track) {
  for (let i = track.calls.length - 1; i >= 0; i--) {
    const a = track.calls[i] && track.calls[i].advanced && track.calls[i].advanced[0];
    if (a && typeof a.exposureTime === 'number') return a.exposureTime;
  }
  return null;
}
const evs = (logs, name) => logs.filter(function (x) { return x.event === name; });
const reasonsOf = (logs, name) => evs(logs, name).map(function (x) { return x.fields.reason; });

/* ========================================================================== *
 * 用例主体
 * ======================================================================== */
async function main() {
  /* ---------------------------------------------------------------- *
   * W. sRGB 降幅模型的独立数值验算（不引用被测代码的模型实现）
   * ---------------------------------------------------------------- */
  console.log('\n· W sRGB 降幅模型独立验算（QA 自行推导，不引用被测实现）');
  {
    // IEC 61966-2-1 正变换（真实 sRGB 传输函数，分段 + 0.055 偏移）
    const srgbEnc = (L) => (L <= 0.0031308 ? 12.92 * L : 1.055 * Math.pow(L, 1 / 2.4) - 0.055);
    const srgbDec = (V) => (V <= 0.04045 ? V / 12.92 : Math.pow((V + 0.055) / 1.055, 2.4));
    // 独立推导的降幅：码值按 sRGB 编码，线性光 ×2^ev → 码值 ×2^(ev/2.2)
    const drop = (code, ev, ped) => {
      const p = (ped || 0) / 255;
      const V0 = (code / 255 - p) / (1 - p);
      const V1 = srgbEnc(srgbDec(V0) * Math.pow(2, ev));
      return 1 - (p + (1 - p) * V1) * 255 / code;
    };
    const model = (ev) => 1 - Math.pow(2, ev / 2.2);   // QA 独立写出的模型，被测代码另有实现

    near(model(-1), 0.2703, 5e-4, 'W1 独立推导：-1EV 预期码值降幅 ≈27.0%（线性光减半 → 码值 ×0.73）');
    near(model(-2), 0.4675, 5e-4, 'W2 独立推导：-2EV 预期码值降幅 ≈46.7%');
    near(C.expectedDropRatio(-1, 2.2), model(-1), 1e-9, 'W3 被测实现与 QA 独立推导一致（-1EV）');
    near(C.expectedDropRatio(-2, 2.2), model(-2), 1e-9, 'W4 被测实现与 QA 独立推导一致（-2EV）');

    // 模型与真实 sRGB 的偏差：工作区间（被 AE 提亮的黑衣物，码值 140~185）
    let maxBias = 0;     // 模型 − 真实（正数 = 模型高估 = 危险方向）
    let minMargin = 9e9; // 真实降幅 / 判定门槛
    for (let c = 140; c <= 185; c += 5) {
      for (let e = -3; e <= -0.25; e += 0.25) {
        const bias = model(e) - drop(c, e, 0);
        if (bias > maxBias) maxBias = bias;
        const margin = drop(c, e, 0) / (model(e) * 0.5);
        if (margin < minMargin) minMargin = margin;
      }
    }
    assert(maxBias <= 0.006, 'W5 工作区间内模型高估 ≤0.6pp（实测 ' + (maxBias * 100).toFixed(2) +
      'pp，偏差方向为保守，不会误伤好设备）');
    assert(minMargin >= 1.5, 'W6 好设备余量：真实降幅 / 判定门槛 ≥1.5×（实测最小 ' +
      minMargin.toFixed(2) + '×，ratio=0.5 兜得住模型偏差）');

    // 黑电平鲁棒性（真实摄像头常有 pedestal）
    let pedMin = 9e9;
    [8, 16, 32].forEach(function (ped) {
      for (let c = Math.max(140, ped + 15); c <= 185; c += 5) {
        for (let e = -3; e <= -0.25; e += 0.25) {
          const m = drop(c, e, ped) / (model(e) * 0.5);
          if (m < pedMin) pedMin = m;
        }
      }
    });
    assert(pedMin >= 1.2, 'W7 含黑电平（pedestal 8~32）的好设备仍不被误判（最小余量 ' +
      pedMin.toFixed(2) + '×）');

    // 现场数据回代：ev 0→-2.0，subjectMean 155~182（现场日志原样）
    const field = C.judgeExposureEffect({
      baseline: 170,
      samples: [
        { ev: -0.34, mean: 170, t: 1000 }, { ev: -0.68, mean: 168, t: 1500 },
        { ev: -1.02, mean: 164, t: 2000 }, { ev: -1.36, mean: 170, t: 2500 },
        { ev: -1.70, mean: 155, t: 3000 }, { ev: -2.00, mean: 166, t: 3500 }
      ],
      startedAt: 0
    }, { expEffectWindowMs: 0 });
    assert(field.verdict === 'ineffective', 'W8 现场日志回代 → ineffective');
    assert(field.needDrop - field.dropRatio > 0.10,
      'W9 判别面干净：门槛 ' + (field.needDrop * 100).toFixed(1) + '% 与实测 ' +
      (field.dropRatio * 100).toFixed(1) + '% 相差 >10pp（不是擦线判定）');

    // 参数可注入性（判定不能写死）
    near(C.expectedDropRatio(-1, 1.0), 0.5, 1e-9, 'W10 gamma=1.0 时 -1EV 预期降幅 50%（参数真的生效）');
    near(C.expectedDropRatio(-1, 2.4), 0.2508, 5e-4, 'W11 gamma=2.4 时 -1EV 预期降幅 ≈25%');
    const edge = C.judgeExposureEffect({
      baseline: 170,
      samples: [{ ev: -1.0, mean: 170 * (1 - model(-1) * 0.5), t: 1000 },
        { ev: -1.5, mean: 170 * (1 - model(-1.5) * 0.5), t: 1500 }],
      startedAt: 0
    }, { expEffectWindowMs: 0, expEffectMinSteps: 1 });
    assert(edge.verdict === 'effective', 'W12 实测恰为预期×0.5（边界含等号）→ effective（' + edge.verdict + '）');

    // 收敛窗口的边界：窗口内的样本一律不参与；出窗口后同一形态立刻判得出来
    const ghostAt = function (t0) {
      const s = [];
      [1.2, 1.6, 2.0, 2.4, 2.8].forEach(function (d, i) {
        s.push({ ev: -d, mean: 170, t: t0 + i * 500 });
      });
      return C.judgeExposureEffect({ baseline: 170, samples: s, startedAt: 0 }, null);
    };
    const inWin = ghostAt(500);     // 全部落在 500~2500ms：只有最后一条出窗口
    const outWin = ghostAt(2500);   // 2500~4500ms：全部出窗口
    assert(inWin.candidates < 5, 'W13 收敛窗口内的样本被闸门挡掉（参与判定 ' + inWin.candidates + '/5 条，' +
      inWin.verdict + '）');
    // 5 条样本里前 minSteps-1=2 条必被步数门槛吃掉，故最多 3 条参与判定
    assert(outWin.verdict === 'ineffective' && outWin.candidates === 3,
      'W14 出窗口后同一形态立即判无效（参与 ' + outWin.candidates + '/3 条）—— 窗口是时间闸门，不是永久豁免');
  }

  /* ---------------------------------------------------------------- *
   * S. 默认收敛窗口 × 真实时序（P0：覆盖缺口复核）
   * ---------------------------------------------------------------- */
  console.log('\n· S 默认收敛窗口（2000ms）× 真实时序：覆盖缺口复核');
  {
    // S1/S2：幽灵设备（静态图）在【默认配置 + 真实时序】下确实会被检出
    const h = harness();
    await h.boot();
    const t0 = h.clock.t();
    let demoteAt = null;
    for (let i = 0; i < 20 && demoteAt == null; i++) {
      await pump(h.clock, 250, 10);
      if (reasonsOf(h.logs, 'CAM_EXP_FALLBACK').indexOf('comp-ineffective') >= 0) demoteAt = h.clock.t();
    }
    assert(demoteAt != null, 'S1 默认窗口 + 真实时序下幽灵设备仍被检出（判定路径不是死代码）');
    const engageAt = (evs(h.logs, 'CAM_EXP_ENGAGE')[0] || {}).t;
    const eng = evs(h.logs, 'CAM_EXP_ENGAGE')[0];
    // ENGAGE 日志不带 t，用第一条 STEP 反推：判定发生在 engage 之后 2~4s 之间
    const dt = demoteAt - t0;
    assert(dt > 2000 && dt < 8000, 'S2 检出发生在开流后 ' + dt + 'ms（含 800ms 启动延迟 + 3 帧滞回 + 2000ms 收敛窗口 + 2 次命中滞回）');
    note('S2 实测：开流到检出 ' + dt + 'ms（engage 首帧约 1.55s，判定窗口 2.0s，再 2 次无响应命中约 1.0s）');

    // S3：旧套件那种毫秒级配置 + 只推进 400ms —— 判定不触发（覆盖缺口量化）
    const hf = harness({ base: 'fast' });
    await hf.boot();
    await pump(hf.clock, 400, 5);
    const fbFast = reasonsOf(hf.logs, 'CAM_EXP_FALLBACK').filter(function (r) { return /ineffective/.test(r); });
    assert(fbFast.length === 0, 'S3 快时钟 + 只推进 400ms（旧套件形态）→ 判定完全不触发（实测原因集 ' +
      JSON.stringify(reasonsOf(hf.logs, 'CAM_EXP_FALLBACK')) + '）');
    assert(evs(hf.logs, 'CAM_EXP_STEP').length >= 3,
      'S4 但旧套件照样下发了很多步补偿（' + evs(hf.logs, 'CAM_EXP_STEP').length +
      ' 步）—— 说明旧用例确实「靠判定没触发才绿」，覆盖了下发却没覆盖判定');
    // S4b：同一套快时钟配置，只把推进时长从 400ms 拉到 4000ms —— 判定立刻触发。
    //      证明旧用例的"绿"来自"虚拟时间没走够"，而不是"默认窗口设计上不判"
    await pump(hf.clock, 3600, 5);
    const fbLong = reasonsOf(hf.logs, 'CAM_EXP_FALLBACK').filter(function (r) { return /ineffective/.test(r); });
    assert(fbLong.length > 0, 'S4b 同一场景推进到 4000ms（>2000ms 窗口）→ 判定立即触发（' +
      JSON.stringify(fbLong) + '）—— 旧套件覆盖的是「下发」，没覆盖「判定」');
    hf.ctrl.unmount(); await flush(60);
    assert(hf.clock.count() === 0, 'S5 快时钟路径无悬挂定时器');

    // S5：好设备（画面随补偿下降）在真实时序 + 默认窗口下 10s 全程不降级
    const hg = harness({
      image: function () {
        return garmentScene(Math.max(5, Math.round(150 * Math.pow(2, lastAppliedComp(hg.track) / 2.2))));
      }
    });
    await hg.boot();
    await pump(hg.clock, 10000, 10);
    const gi = hg.ctrl.getExposureInfo();
    assert(gi.tier === 1, 'S6 好设备 10s 全程停在 tier1（实际 tier=' + gi.tier + '）');
    assert(!reasonsOf(hg.logs, 'CAM_EXP_FALLBACK').some(function (r) { return /ineffective/.test(r); }),
      'S7 好设备无任何 ineffective 降级日志（实际 ' +
      JSON.stringify(reasonsOf(hg.logs, 'CAM_EXP_FALLBACK')) + '）');
    assert(gi.subjectMean != null && Math.abs(gi.subjectMean - C.DEFAULTS.expTargetMean) < 12,
      'S8 好设备主体亮度收敛到目标附近（' + (gi.subjectMean == null ? 'null' : gi.subjectMean.toFixed(1)) +
      ' ≈ ' + C.DEFAULTS.expTargetMean + '）');
    hg.ctrl.unmount(); await flush(60);
    assert(hg.clock.count() === 0, 'S9 好设备路径无悬挂定时器');

    // S10：好设备全链 engage → step → 衣物移出 → release → 还原
    const hr = harness({
      image: function () {
        return garmentScene(Math.max(5, Math.round(150 * Math.pow(2, lastAppliedComp(hr.track) / 2.2))));
      }
    });
    await hr.boot();
    await pump(hr.clock, 3000, 10);
    const beforeRel = hr.track.calls.length;
    hr.setImage(EMPTY_SCENE);                 // 衣物移出画面
    await pump(hr.clock, 6000, 10);           // 10 次未命中(2.5s) + 最短保持(1.5s)
    const relInfo = hr.ctrl.getExposureInfo();
    assert(evs(hr.logs, 'CAM_EXP_RELEASE').length >= 1, 'S10 衣物移出后触发 release（真实时序）');
    assert(relInfo.state === 'IDLE' && relInfo.tier === 0 && relInfo.ev === 0,
      'S11 release 后状态归零（state=' + relInfo.state + ' tier=' + relInfo.tier + ' ev=' + relInfo.ev + '）');
    const last = hr.track.calls[hr.track.calls.length - 1];
    assert(last && last.advanced && last.advanced[0].exposureCompensation === 0 &&
      last.advanced[0].exposureMode === undefined,
      'S12 release 把补偿归零（末条约束 ' + JSON.stringify(last && last.advanced) + '）');
    assert(hr.track.calls.length > beforeRel, 'S13 release 前确实下发过负补偿（' + beforeRel + ' 条）');
    hr.ctrl.unmount(); await flush(60);
    assert(hr.clock.count() === 0, 'S14 release 全链无悬挂定时器');
  }

  /* ---------------------------------------------------------------- *
   * T. 降级链正确性
   * ---------------------------------------------------------------- */
  console.log('\n· T 降级链：还原顺序 / 换量纲 / 幽灵 manual / 能力残缺');
  {
    const capsBoth = {
      exposureCompensation: { min: -3, max: 3, step: 0.1 },
      exposureMode: ['continuous', 'manual'],
      exposureTime: { min: 10, max: 10000 }
    };
    // T1：tier1 → tier2，还原必须发生在切新档之前
    const h = harness({
      trackOpts: { caps: capsBoth, settings: { exposureCompensation: 0, exposureTime: 500 } }
    });
    await h.boot();
    await pump(h.clock, 12000, 10);
    const calls = h.track.calls;
    const negIdx = [];
    calls.forEach(function (cst, i) {
      const a = cst.advanced && cst.advanced[0];
      if (a && typeof a.exposureCompensation === 'number' && a.exposureCompensation < 0) negIdx.push(i);
    });
    const lastNeg = negIdx.length ? negIdx[negIdx.length - 1] : -1;
    let restoreIdx = -1, manualIdx = -1;
    for (let i = lastNeg + 1; i < calls.length; i++) {
      const a = calls[i].advanced && calls[i].advanced[0];
      if (!a) continue;
      if (restoreIdx < 0 && a.exposureCompensation === 0 && a.exposureMode === undefined) restoreIdx = i;
      if (manualIdx < 0 && a.exposureMode === 'manual') manualIdx = i;
    }
    assert(restoreIdx >= 0 && manualIdx >= 0, 'T1 降级路径里既能找到还原约束也能找到 manual 约束（还原 idx=' +
      restoreIdx + '，manual idx=' + manualIdx + '）');
    assert(restoreIdx < manualIdx, 'T2 还原（补偿归零）严格早于切新档（' + restoreIdx + ' < ' + manualIdx +
      '）—— 顺序反了会让两份偏置瞬间叠加在同一台设备上');

    // T3：换量纲 —— tier2 首条约束的曝光时间必须等于基线（ev 归零），不带 tier1 的旧 ev
    const firstManual = calls[manualIdx];
    const baseTime = 500;
    assert(firstManual && Math.abs(firstManual.advanced[0].exposureTime - baseTime) < 1e-6,
      'T3 tier1→tier2 后首条 manual 约束的曝光时间 = 基线 ' + baseTime + '（实际 ' +
      (firstManual && firstManual.advanced[0].exposureTime) + '，说明 ev 已归零重新收敛）');
    assert(evs(h.logs, 'CAM_EXP_FALLBACK').some(function (x) { return x.fields.reason === 'manual-ineffective'; }),
      'T4 manual 也是幽灵能力 → 继续降到 tier0（实际 ' +
      JSON.stringify(reasonsOf(h.logs, 'CAM_EXP_FALLBACK')) + '）');
    assert(h.ctrl.getExposureInfo().tier === 0, 'T5 两级降级后落在 tier0');
    // T6：降级次数封顶 2，之后不再判（不会无限循环降级）
    const demoteLogs = evs(h.logs, 'CAM_EXP_FALLBACK').filter(function (x) {
      return /ineffective|demote/.test(String(x.fields.reason));
    });
    assert(demoteLogs.length <= 3, 'T6 降级相关日志不超过 3 条（1 次 comp + 1 次 manual + 至多 1 次失败，实际 ' +
      demoteLogs.length + ' 条）');
    const frozen = h.track.calls.length;
    const enumBefore = evs(h.logs, 'CAM_EXP_ENUM').length;
    await pump(h.clock, 8000, 10);
    assert(h.track.calls.length === frozen,
      'T7 tier0 之后 8s 内不再向硬件下发任何约束（调用数冻结在 ' + frozen + '）');
    assert(evs(h.logs, 'CAM_EXP_ENUM').length === enumBefore,
      'T8 不会反复爬回硬件档（8s 内无新的档位探测，ENUM 序列 ' +
      JSON.stringify(evs(h.logs, 'CAM_EXP_ENUM').map(function (x) { return x.fields.tier; })) + '）');
    h.ctrl.unmount(); await flush(60);
    assert(h.clock.count() === 0, 'T9 两级降级路径无悬挂定时器');

    // T10：降级目标产不出曝光值（有 exposureTime.min 但 getSettings 不给基线）→ 直接 tier0，
    //      绝不发「切了 manual 却压不暗」的约束
    const h2 = harness({ trackOpts: { caps: capsBoth, settings: {} } });
    await h2.boot();
    await pump(h2.clock, 12000, 10);
    assert(h2.ctrl.getExposureInfo().tier === 0, 'T10 降级目标产不出曝光值 → 直接 tier0（实际 tier=' +
      h2.ctrl.getExposureInfo().tier + '）');
    assert(!h2.track.calls.some(function (cst) {
      const a = cst.advanced && cst.advanced[0];
      return a && a.exposureMode === 'manual';
    }), 'T11 全程未下发任何 manual 约束（不会切手动却不压暗）');
    h2.ctrl.unmount(); await flush(60);

    // T12：新档位下发失败 → demote-apply-failed → tier0
    const h3 = harness({
      trackOpts: {
        caps: capsBoth, settings: { exposureCompensation: 0, exposureTime: 500 },
        failIf: function (cst) { const a = cst.advanced && cst.advanced[0]; return !!(a && a.exposureMode === 'manual'); }
      }
    });
    await h3.boot();
    await pump(h3.clock, 12000, 10);
    assert(reasonsOf(h3.logs, 'CAM_EXP_FALLBACK').indexOf('demote-apply-failed') >= 0,
      'T12 新档位下发失败 → 留痕 demote-apply-failed（实际 ' +
      JSON.stringify(reasonsOf(h3.logs, 'CAM_EXP_FALLBACK')) + '）');
    assert(h3.ctrl.getExposureInfo().tier === 0, 'T13 新档下发失败后落在 tier0（不会停在「没生效的手动档」）');
    h3.ctrl.unmount(); await flush(60);
  }

  /* ---------------------------------------------------------------- *
   * U. 误伤与逃逸攻击
   * ---------------------------------------------------------------- */
  console.log('\n· U 误伤与逃逸攻击（好设备不许降级，幽灵设备不许逃逸）');
  {
    // 通用：跑一段真实时序，返回是否降级 + 最终信息
    async function run(imageFn, opts) {
      const o = opts || {};
      const h = harness({
        image: function () { return imageFn(h); },
        trackOpts: o.trackOpts
      });
      await h.boot();
      await pump(h.clock, o.ms || 10000, 10);
      const info = h.ctrl.getExposureInfo();
      const demoted = reasonsOf(h.logs, 'CAM_EXP_FALLBACK').some(function (r) { return /ineffective/.test(r); });
      return { h: h, info: info, demoted: demoted, logs: h.logs };
    }
    const responsive = function (h, lagSteps, jitter, driftPerSec) {
      const calls = h.track.calls.filter(function (cst) {
        const a = cst.advanced && cst.advanced[0];
        return a && typeof a.exposureCompensation === 'number';
      });
      const n = calls.length;
      const k = Math.max(0, n - 1 - (lagSteps || 0));
      const evApplied = n ? calls[k].advanced[0].exposureCompensation : 0;
      const t = h.clock.t() - 100000;
      const drift = (driftPerSec || 0) * (t / 1000);
      let v = 150 * Math.pow(2, evApplied / 2.2) + drift;
      if (jitter) v += (Math.sin(t / 137) * jitter);
      return garmentScene(Math.max(5, Math.round(v)));
    };

    // U1：慢热设备（响应滞后 1 步）
    let r = await run(function (h) { return responsive(h, 1); });
    assert(!r.demoted, 'U1 慢热设备（响应滞后 1 步 ≈500ms）不被误判（实际 ' +
      JSON.stringify(reasonsOf(r.logs, 'CAM_EXP_FALLBACK')) + '）');
    r.h.ctrl.unmount(); await flush(40);

    // U2：慢热 2 步（≈1s）
    r = await run(function (h) { return responsive(h, 2); });
    assert(!r.demoted, 'U2 响应滞后 2 步（≈1s）仍不被误判（2000ms 收敛窗口 + ratio 0.5 兜住）');
    r.h.ctrl.unmount(); await flush(40);

    // U3：衣物微动导致亮度抖动（±8 码值）
    r = await run(function (h) { return responsive(h, 0, 8); });
    assert(!r.demoted, 'U3 衣物微动抖动 ±8 码值不被误判（滞回 hits=2 生效）');
    r.h.ctrl.unmount(); await flush(40);

    // U4：环境光缓慢变亮（+3 码值/秒 —— 约 13 秒变亮 15%，对「缓慢」已属偏快）
    r = await run(function (h) { return responsive(h, 0, 0, 3); });
    assert(!r.demoted, 'U4 环境光缓慢变亮（+3 码值/秒）不被误判（实测是否降级：' + r.demoted + '）');
    r.h.ctrl.unmount(); await flush(40);

    // U4b：量化误伤边界 —— 判定用的是 engage 时刻的固定基线，漂移会侵蚀「实测降幅」。
    //      这里把边界扫出来存档，作为遗留风险的量化依据（不是通过/失败的判据）。
    let boundary = null;
    for (const d of [2, 4, 6, 8, 12]) {
      const rr = await run(function (h) { return responsive(h, 0, 0, d); });
      if (rr.demoted && boundary == null) boundary = d;
      rr.h.ctrl.unmount(); await flush(40);
    }
    assert(boundary == null || boundary >= 6,
      'U4b 误伤边界：漂移速率需 ≥' + boundary + ' 码值/秒（累计约 50 码值 ≈ 基线 31%）才会误判好设备');
    note('U4b 实测误伤边界：环境光持续变亮 ≥' + boundary +
      ' 码值/秒（判定前累计约 50 码值）时，好设备会被误判成幽灵能力。' +
      '根因：判定用 engage 时刻的固定基线算降幅，与补偿无关的整体变亮会被算进"没响应"。' +
      '现场 AE 处于 continuous 模式时会自行抵消环境光漂移，风险可控；建议后续改为按 Δev 的增量判定。');

    // U5：设备把 exposureCompensation.min 报成 -0.5，但**真的响应** → 不许降级
    const tight = { exposureCompensation: { min: -0.5, max: 3, step: 0.1 } };
    r = await run(function (h) { return responsive(h, 0); }, { trackOpts: { caps: tight } });
    const appliedTight = lastAppliedComp(r.h.track);
    near(appliedTight, -0.5, 1e-9, 'U5 前置：闭环要 -3.0，设备只收 -0.5（实际下发 ' + appliedTight + '）');
    assert(!r.demoted, 'U6 钳位到 -0.5EV 的好设备不被误判（pinned 豁免不会反过来误伤正常设备，实际 ' +
      JSON.stringify(reasonsOf(r.logs, 'CAM_EXP_FALLBACK')) + '）');
    r.h.ctrl.unmount(); await flush(40);

    // U7：同样钳位到 -0.5，但设备是幽灵 → 必须判得出来（不能靠「永远到不了 1EV」逃逸）
    const hGhostTight = harness({ trackOpts: { caps: tight } });
    await hGhostTight.boot();
    await pump(hGhostTight.clock, 12000, 10);
    assert(reasonsOf(hGhostTight.logs, 'CAM_EXP_FALLBACK').indexOf('comp-ineffective') >= 0,
      'U7 钳位在 -0.5EV 的幽灵设备仍被判无效（minEv 门槛的 pinned 豁免真的生效，实际 ' +
      JSON.stringify(reasonsOf(hGhostTight.logs, 'CAM_EXP_FALLBACK')) + '）');
    assert(hGhostTight.ctrl.getExposureInfo().tier === 0, 'U8 钳位幽灵设备最终落到 tier0');
    hGhostTight.ctrl.unmount(); await flush(60);

    // U9：降级到 tier2 期间衣物移出 → 还原走 continuous
    const capsBoth = {
      exposureCompensation: { min: -3, max: 3, step: 0.1 },
      exposureMode: ['continuous', 'manual'],
      exposureTime: { min: 10, max: 10000 }
    };
    const hRel = harness({
      trackOpts: { caps: capsBoth, settings: { exposureCompensation: 0, exposureTime: 500 } }
    });
    await hRel.boot();
    await pump(hRel.clock, 5000, 10);           // 已完成 tier1→tier2 降级
    const tierNow = hRel.ctrl.getExposureInfo().tier;
    assert(tierNow === 2, 'U9 前置：此刻正处于 tier2（实际 tier=' + tierNow + '）');
    hRel.setImage(EMPTY_SCENE);
    await pump(hRel.clock, 6000, 10);
    const relCalls = hRel.track.calls.slice(-3);
    assert(relCalls.some(function (cst) {
      const a = cst.advanced && cst.advanced[0];
      return a && a.exposureMode === 'continuous';
    }), 'U10 tier2 期间 release → 还原切回 continuous（末三条 ' +
      JSON.stringify(relCalls.map(function (c) { return c.advanced && c.advanced[0]; })) + '）');
    assert(hRel.ctrl.getExposureInfo().state === 'IDLE' && hRel.ctrl.getExposureInfo().tier === 0,
      'U11 release 后状态与档位归零（state=' + hRel.ctrl.getExposureInfo().state +
      ' tier=' + hRel.ctrl.getExposureInfo().tier + '）');
    hRel.ctrl.unmount(); await flush(60);
    assert(hRel.clock.count() === 0, 'U12 降级中 release 路径无悬挂定时器');

    // U13：已降到 tier0 后 release —— plan 为 null，不得报错、不得发无意义约束
    const hT0 = harness();
    await hT0.boot();
    await pump(hT0.clock, 8000, 10);
    assert(hT0.ctrl.getExposureInfo().tier === 0, 'U13 前置：已降到 tier0');
    const beforeCalls = hT0.track.calls.length;
    hT0.setImage(EMPTY_SCENE);
    await pump(hT0.clock, 6000, 10);
    assert(hT0.track.calls.length === beforeCalls,
      'U14 tier0 期间/之后 release 不再下发任何约束（' + beforeCalls + ' → ' + hT0.track.calls.length + '）');
    assert(evs(hT0.logs, 'CAM_EXP_RELEASE').length >= 1, 'U15 tier0 状态仍能正常 release（不卡死在 ACTIVE）');
    hT0.ctrl.unmount(); await flush(60);
    assert(hT0.clock.count() === 0, 'U16 tier0 release 路径无悬挂定时器');

    // U17：持久降级的粒度 —— 同一 engage 会话内不爬回；跨 release→re-engage 会重新探测
    const hPers = harness();
    await hPers.boot();
    await pump(hPers.clock, 8000, 10);
    assert(hPers.ctrl.getExposureInfo().tier === 0, 'U17 前置：已降到 tier0');
    hPers.setImage(EMPTY_SCENE);
    await pump(hPers.clock, 6000, 10);                   // release
    assert(hPers.ctrl.getExposureInfo().state === 'IDLE', 'U18 前置：已 release');
    const callsAtRelease = hPers.track.calls.length;      // 二次 engage 的约束都在这条线之后
    hPers.setImage(garmentScene(150));                   // 下一件衣物进画
    await pump(hPers.clock, 3000, 10);                    // 冷却 3s 后重新 engage
    const enumSeq = evs(hPers.logs, 'CAM_EXP_ENUM').map(function (x) { return x.fields.tier; });
    // U19 行为存档已随修复改写：降级结论现在按 deviceId 在会话级持久化，
    // release → 重新 engage 不再重走 tier1 的无效补偿窗口（原存档断言要求“重新探测 tier1”已作废）。
    //
    // 断言写成「tier1 被枚举的次数恰好为 1」而不是「ENUM 末位===0」：末位那条会随推进时长
    // 变化——把 pump 拉长到二次降级完成，缺记忆时 ENUM 也会以 0 结尾，于是绿着放过缺陷。
    // 计数式断言与时间无关，记忆失效必然多出一次 tier1（QA 阳性对照 P1/P2 已验证）
    const tier1Enums = enumSeq.filter(function (t) { return t === 1; }).length;
    assert(enumSeq.length >= 2 && tier1Enums === 1,
      'U19 跨会话行为存档：tier1 只在本设备首次 engage 时被枚举一次（ENUM 序列 ' +
      JSON.stringify(enumSeq) + '，tier1 枚举次数 ' + tier1Enums + '）');
    const ghosts = evs(hPers.logs, 'CAM_EXP_FALLBACK').filter(function (x) {
      return x.fields.reason === 'ghost-remembered';
    });
    assert(ghosts.length === 1 && ghosts[0].fields.from === 1,
      'U19b 二次 engage 凭会话记忆直接跳过 tier1（ghost-remembered 次数=' + ghosts.length +
      ' from=' + (ghosts.length ? ghosts[0].fields.from : 'none') + '）');
    const afterRe = hPers.track.calls.slice(callsAtRelease).map(function (c) { return c.advanced && c.advanced[0]; });
    assert(hPers.ctrl.getExposureInfo().tier === 0 && !afterRe.some(function (a) {
      return a && (typeof a.exposureCompensation === 'number' || typeof a.exposureTime === 'number');
    }), 'U19c 二次 engage 直接落 tier0，不再向设备下发任何曝光约束（tier=' +
      hPers.ctrl.getExposureInfo().tier + '，release 之后下发 ' + JSON.stringify(afterRe) + '）');
    note('U19 已修复并改写本条存档：降级结论原先只在单次 engage 内有效（U/T7/T8 会话内不爬回已验证），' +
      'release 后重新 engage 会重新探测 tier1，幽灵设备每件衣物都要重走约 4s 的无效补偿窗口。' +
      '现已按 deviceId 在会话级持久化「实测无效」的档位（换设备即失效），二次 engage 走 ' +
      'ghost-remembered 直接落到可用档位，不再下发负补偿。');
    hPers.ctrl.unmount(); await flush(60);
    assert(hPers.clock.count() === 0, 'U20 重新 engage 路径无悬挂定时器');
  }

  /* ---------------------------------------------------------------- *
   * V. 现场闭环 + 软件兜底 LUT 与 EV 语义的一致性
   * ---------------------------------------------------------------- */
  console.log('\n· V 现场闭环：幽灵设备端到端 + tier0 软件兜底的语义一致性');
  {
    const h = harness();
    await h.boot();
    const t0 = h.clock.t();
    // 落到 tier0 的判据：已 engage（ACTIVE）且已降到软件兜底档。
    // 不能只看 tier===0 —— 未 engage 时 tier 本来就是 0，会把「还没开始」误当成「已兜底」
    let landAt = null;
    for (let i = 0; i < 40 && landAt == null; i++) {
      await pump(h.clock, 250, 10);
      const s = h.ctrl.getExposureInfo();
      if (s.state === 'ACTIVE' && s.tier === 0) landAt = h.clock.t();
    }
    assert(landAt != null, 'V1 幽灵设备端到端最终落到 tier0（ACTIVE + 软件兜底档）');
    const cost = landAt - t0;
    assert(cost <= 6000, 'V2 从开流到落到可压暗路径耗时 ' + cost + 'ms（≤6000ms 可接受）');
    note('V2 实测：开流 → tier0 用时 ' + cost + 'ms（800ms 启动延迟 + 750ms engage 滞回 + 2000ms 收敛窗口 + 2 次无响应命中）');
    // tier0 后闭环继续推进 ev（供存档 LUT 用），再跑 6s 让它走到下限
    await pump(h.clock, 6000, 10);
    const info = h.ctrl.getExposureInfo();
    assert(info.state === 'ACTIVE', 'V3 最终状态仍 ACTIVE（辅助没有因为降级而整体停摆）');

    // 徽标语义：tier0 → 渲染层提示「软件压暗」
    const rSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
    const capStart = rSrc.indexOf('async function capture()');
    const capBody = rSrc.slice(capStart, rSrc.indexOf('function removeShot', capStart));
    assert(/expInfo\.tier === 0/.test(capBody) && /buildExposureLut/.test(capBody),
      'V4 tier0 时拍照路径确实走软件兜底 LUT（徽标如实显示「软件压暗」）');

    // ★ 语义一致性：软件兜底压暗的幅度必须与 EV 语义（sRGB 模型）一致。
    //   expEvMin 之所以从 -2.0 加深到 -3.0，依据正是「150 → 58（expTargetMean）需要 -3EV」；
    //   LUT 若按另一套公式执行，闭环算出的 ev 就与存档图实际得到的压暗量对不上。
    const evFinal = h.ctrl.getExposureInfo().ev;
    // 第 2 轮起 tier0 的 ev 走解析解 solveTier0Ev 并被 expEvMin 兜底；
    // 主体卡在 150 的幽灵设备解析解正好是 -3.02，钳到 -3.00
    near(evFinal, C.DEFAULTS.expEvMin, 1e-6, 'V5 前置：tier0 下 ev 已取到解析解并被下限护栏兜住，当前 ' + evFinal.toFixed(2) + 'EV');
    const lut = C.buildExposureLut(evFinal);
    const want = Math.round(150 * Math.pow(2, evFinal / 2.2));   // sRGB 模型：-3EV → 150×0.3876 ≈ 58
    assert(Math.abs(lut[150] - want) <= 10,
      'V6 软件兜底幅度与 EV 语义一致：主体码值 150 在 ' + evFinal.toFixed(2) + 'EV 下应压到 ≈' +
      want + '（= expTargetMean ' + C.DEFAULTS.expTargetMean + '），实测 ' + lut[150]);

    // ★ 被裁剪的高光必须能被压回来：现场投诉的正是「白色鞋底完全过曝无细节」
    assert(lut[255] < 250,
      'V7 软件兜底必须把裁剪高光压回可辨范围：255 在 ' + evFinal.toFixed(2) + 'EV 下应显著变暗，实测 ' + lut[255]);

    // 暗部层次：压暗后仍要留有梯度（黑衣物褶皱是唯一信息量）
    const gaps = [20, 30, 45, 60].map(function (v) { return lut[v]; });
    assert(gaps[3] > gaps[0] && gaps[0] >= 0,
      'V8 暗部仍保有梯度（20→' + gaps[0] + '，30→' + gaps[1] + '，45→' + gaps[2] + '，60→' + gaps[3] + '）');
    assert(gaps[0] > 0 || gaps[1] > 0,
      'V9 暗部没有被压成死黑一片（20/30 至少还留一个非零级，实测 ' + gaps[0] + '/' + gaps[1] + '）');

    h.ctrl.unmount();
    await flush(60);
    assert(h.clock.count() === 0, 'V10 现场闭环全程无悬挂定时器');
  }

  /* ---------------------------------------------------------------- *
   * X. 会话级幽灵记忆（第 2 轮新增特性）的边界攻击
   *    记忆让「一次判定」的影响从单件衣物变成整个会话，攻击面随之放大
   * ---------------------------------------------------------------- */
  console.log('\n· X 会话级幽灵记忆：边界攻击');
  {
    const capsBoth = {
      exposureCompensation: { min: -3, max: 3, step: 0.1 },
      exposureMode: ['continuous', 'manual'], exposureTime: { min: 10, max: 10000 }
    };
    // 工具：跑到「ACTIVE + tier0」，返回耗时；配合 0/负值判定「卡」
    const runToTier0 = async function (h, maxMs) {
      const t0 = h.clock.t();
      for (let i = 0; i < (maxMs || 25000) / 250; i++) {
        await pump(h.clock, 250, 10);
        const s = h.ctrl.getExposureInfo();
        if (s.state === 'ACTIVE' && s.tier === 0) return h.clock.t() - t0;
      }
      return null;
    };
    const cycleCloth = async function (h, image) {
      h.setImage(EMPTY_SCENE);
      await pump(h.clock, 6000, 10);            // 10 次未命中 + 最短保持
      if (image) h.setImage(image);
    };

    // X1：双档都无效的设备 —— engage 只跳过被探测到的那一档，tier2 仍要重跑一次
    const hBoth = harness({
      trackOpts: { caps: capsBoth, settings: { exposureCompensation: 0, exposureTime: 500, deviceId: 'cam-A' } }
    });
    await hBoth.boot();
    const cost1 = await runToTier0(hBoth);
    assert(cost1 != null && evs(hBoth.logs, 'CAM_EXP_ENUM').map(function (x) { return x.fields.tier; }).join(',') === '1,2',
      'X1 前置：首件衣物走完 tier1→tier2→tier0（用时 ' + cost1 + 'ms，ENUM=' +
      evs(hBoth.logs, 'CAM_EXP_ENUM').map(function (x) { return x.fields.tier; }).join(',') + '）');
    const callsBefore2nd = hBoth.track.calls.length;
    await cycleCloth(hBoth, garmentScene(150));
    const cost2 = await runToTier0(hBoth);
    const secondCalls = hBoth.track.calls.slice(callsBefore2nd);
    const secondManual = secondCalls.filter(function (cst) {
      const a = cst.advanced && cst.advanced[0];
      return a && a.exposureMode === 'manual';
    });
    const secondComp = secondCalls.filter(function (cst) {
      const a = cst.advanced && cst.advanced[0];
      return a && typeof a.exposureCompensation === 'number';
    });
    assert(secondComp.length === 0, 'X2 tier1 确实被记忆跳过（第二件衣物零补偿约束）');
    assert(secondManual.length > 0 && cost2 > 2000,
      'X3 ★已知缺口存档★ tier1/tier2 都被记为无效，但 engage 只查了「先探测到的那一档」，' +
      'tier2 仍被重走一次（第二件衣物仍下发 ' + secondManual.length + ' 次 manual 约束、耗时 ' + cost2 + 'ms）');
    note('X3 已知缺口（DEF-3）：双档幽灵设备的「无效窗口」只从约 4.3s 降到约 3.5s，没降到 0。' +
      '修复点：engageAssist 跳档后应循环复查 demoteExposurePlan 的产出档是否也在记忆里' +
      '（demoteExposureTier 换档时同样要查），而不是只查一次入口档。');
    hBoth.ctrl.unmount(); await flush(60);

    // X4：deviceId 变化 → 记忆必须失效（正向断言，换摄像头不许串档）
    const trackWithId = makeTrack({ caps: { exposureCompensation: { min: -3, max: 3, step: 0.1 } }, settings: { exposureCompensation: 0, deviceId: 'cam-A' } });
    const hId = harness({ track: trackWithId });
    await hId.boot();
    await runToTier0(hId);
    await cycleCloth(hId, null);
    trackWithId.settings.deviceId = 'cam-B';     // 换摄像头
    const goodImg = function () { return garmentScene(Math.max(5, Math.round(150 * Math.pow(2, lastAppliedComp(trackWithId) / 2.2)))); };
    hId.setImage(goodImg);
    await pump(hId.clock, 4000, 10);
    assert(hId.ctrl.getExposureInfo().tier === 1,
      'X4 换摄像头（deviceId 变化）→ 记忆失效，新设备的 tier1 重新可用（实际 tier=' +
      hId.ctrl.getExposureInfo().tier + '）');
    hId.ctrl.unmount(); await flush(60);

    // X5：设备不上报 deviceId 时，两台设备的记忆落在同一个 '' 槽里
    const trackNoId = makeTrack({ caps: { exposureCompensation: { min: -3, max: 3, step: 0.1 } }, settings: { exposureCompensation: 0 } });
    const hNoId = harness({ track: trackNoId });
    await hNoId.boot();
    await runToTier0(hNoId);                      // A 机（幽灵）被记住
    await cycleCloth(hNoId, null);
    const goodImg2 = function () { return garmentScene(Math.max(5, Math.round(150 * Math.pow(2, lastAppliedComp(trackNoId) / 2.2)))); };
    hNoId.setImage(goodImg2);                     // B 机（好设备，同样不上报 deviceId）
    await pump(hNoId.clock, 4000, 10);
    assert(hNoId.ctrl.getExposureInfo().tier === 0,
      'X5 ★已知缺口存档★ 设备不上报 deviceId 时，B 机被 A 机的记录挡住（实际 tier=' +
      hNoId.ctrl.getExposureInfo().tier + '，ENUM=' +
      evs(hNoId.logs, 'CAM_EXP_ENUM').map(function (x) { return x.fields.tier; }).join(',') + '）');
    note('X5 已知缺口（DEF-4）：devIdOf() 拿不到 deviceId 时返回空串，两台「无 deviceId」的设备共用同一个槽，' +
      '`devId !== expGhost.dev` 恒为假 → 记忆永不清空。建议：用 track.id / label 兜底，' +
      '仍取不到就**不启用记忆**（退化成每次重新探测），而不是落到共享的空串槽。');
    hNoId.ctrl.unmount(); await flush(60);

    // X6：误判一旦发生就被持久化 —— 环境光漂移的一次误伤不再局限于单件衣物
    const trackDrift = makeTrack();
    let drift = 0;
    const hDrift = harness({ track: trackDrift });
    // 画面 = 正常设备的后续响应 + 与补偿无关的整体漂移
    const driftImage = function () {
      const elapsed = hDrift.clock.t() - 100000;
      return garmentScene(Math.max(5, Math.min(255, Math.round(
        150 * Math.pow(2, lastAppliedComp(trackDrift) / 2.2) + drift * (elapsed / 1000)))));
    };
    hDrift.setImage(driftImage);
    await hDrift.boot();
    drift = 8;                                   // 超过 U4b 实测误伤边界（6 码值/秒）
    let falsePositive = null;
    for (let i = 0; i < 60 && falsePositive == null; i++) {
      await pump(hDrift.clock, 250, 10);
      if (reasonsOf(hDrift.logs, 'CAM_EXP_FALLBACK').some(function (r) { return /ineffective/.test(r); })) {
        falsePositive = true;
      }
    }
    assert(falsePositive, 'X6 前置：环境光 +8 码值/秒 触发一次 false-positive 降级（U4b 边界已被跨过）');
    await cycleCloth(hDrift, null);
    drift = 0;                                   // 环境光恢复正常
    hDrift.setImage(driftImage);
    await pump(hDrift.clock, 5000, 10);
    assert(hDrift.ctrl.getExposureInfo().tier === 0,
      'X7 ★已知缺口存档★ 一次漂移误判被记忆持久化，环境光恢复后本会话内也不再自愈（实际 tier=' +
      hDrift.ctrl.getExposureInfo().tier + '）');
    note('X7 已知缺口（DEF-5，风险放大）：记忆把「单次误伤」放大成「整会话失效」，且没有 TTL / 复核 / 解锁路径。' +
      'U4b 实测误伤边界是「环境光持续变亮 ≥6 码值/秒」，原先只损失一件衣物，现在好设备会在本次会话内' +
      '永久失去硬件补偿。建议：给记忆加证据强度门槛（同一档位被判无效 ≥2 次才记）或加 TTL / 每 N 次 engage 复核一次。');
    hDrift.ctrl.unmount(); await flush(60);
    assert(hDrift.clock.count() === 0, 'X8 记忆路径无悬挂定时器');

    // X9：apply 失败/超时不写记忆 —— 设备忙不是能力无效（正向断言）
    const trackFlaky = makeTrack({
      failIf: function (cst) {
        const a = cst.advanced && cst.advanced[0];
        return !!(a && typeof a.exposureCompensation === 'number' && a.exposureCompensation < 0);
      }
    });
    const hFlaky = harness({ track: trackFlaky });
    await hFlaky.boot();
    await pump(hFlaky.clock, 6000, 10);
    const fbFlaky = reasonsOf(hFlaky.logs, 'CAM_EXP_FALLBACK');
    assert(fbFlaky.indexOf('fail-limit') >= 0 && !fbFlaky.some(function (r) { return /ineffective/.test(r); }),
      'X9 前置：连续 apply 失败走 fail-limit 降 tier0，没有产生任何 ineffective 判定（' +
      JSON.stringify(fbFlaky) + '）');
    await cycleCloth(hFlaky, garmentScene(150));
    await pump(hFlaky.clock, 3000, 10);
    const enumFlaky = evs(hFlaky.logs, 'CAM_EXP_ENUM').map(function (x) { return x.fields.tier; });
    const ghostFlaky = evs(hFlaky.logs, 'CAM_EXP_FALLBACK').filter(function (x) {
      return x.fields.reason === 'ghost-remembered';
    });
    assert(ghostFlaky.length === 0 && enumFlaky.length >= 2 && enumFlaky[enumFlaky.length - 1] === 1,
      'X10 apply 失败/超时不写幽灵记忆：重新 engage 仍从 tier1 探测（ENUM=' +
      JSON.stringify(enumFlaky) + '，ghost-remembered=' + ghostFlaky.length + ' 次）');
    hFlaky.ctrl.unmount(); await flush(60);

    // X11：跳过留痕必须带原档位，否则现场看不出跳过的是哪一档
    const hTrace = harness();
    await hTrace.boot();
    await runToTier0(hTrace);
    await cycleCloth(hTrace, garmentScene(150));
    await pump(hTrace.clock, 3000, 10);
    const tr = evs(hTrace.logs, 'CAM_EXP_FALLBACK').filter(function (x) { return x.fields.reason === 'ghost-remembered'; });
    assert(tr.length === 1 && tr[0].fields.from === 1 && tr[0].fields.tier === 0 && tr[0].fields.ev === 0,
      'X11 ghost-remembered 留痕齐全：from=' + (tr.length ? tr[0].fields.from : 'none') +
      ' tier=' + (tr.length ? tr[0].fields.tier : 'none') + ' ev=' + (tr.length ? tr[0].fields.ev : 'none'));
    hTrace.ctrl.unmount(); await flush(60);
    assert(hTrace.clock.count() === 0, 'X12 留痕路径无悬挂定时器');
  }

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败' + (notes.length ? '，' + notes.length + ' 条观察项' : ''));
  if (notes.length) {
    console.log('\n观察项：');
    notes.forEach(function (n) { console.log('  · ' + n); });
  }
  if (fail) {
    console.log('\n失败清单：');
    failures.forEach(function (m) { console.log('  - ' + m); });
    process.exitCode = 1;
  }
}

const unhandled = [];
process.on('unhandledRejection', function (e) { unhandled.push(e && e.message ? e.message : String(e)); });

main().then(function () {
  if (unhandled.length) {
    console.log('\n✗ 全程存在 ' + unhandled.length + ' 条未处理的 Promise 拒绝：' + JSON.stringify(unhandled));
    process.exitCode = 1;
  }
}).catch(function (e) {
  console.error('脚本异常：', (e && e.stack) || e);
  process.exitCode = 1;
});
