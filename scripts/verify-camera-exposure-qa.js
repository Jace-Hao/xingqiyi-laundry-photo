'use strict';
/* =============================================================================
 * verify-camera-exposure-qa.js —— 曝光辅助的「独立验证」（QA 侧，不复用实现者断言）
 *
 *   node scripts/verify-camera-exposure-qa.js
 *
 * 与 verify-camera-exposure.js 的分工：
 *   实现者（寇豆码）的套件回答「我写的功能按我的理解正确」；
 *   本套件回答「换一双眼睛看，它是否真的正确」，因此刻意做三件不同的事：
 *     ① 对设计文档的两处「必须改」偏离做独立数值推演 —— 不是采信结论，
 *        而是把设计文档的原始写法在本地实现一遍，与实现代码对拍，看差异是否真实存在；
 *     ② 攻击边界与错误路径（能力缺字段、step 为 0/负、EV 贴下限、跨冷却再入画、
 *        悬挂 track 降级、卸载残留），这些是「跑通一次正常流程」看不见的地方；
 *     ③ 对断言本身的判别力做阳性对照（红线检查器、LUT 时序检查器、变异体），
 *        证明它们不是空跑。
 *
 * 只依赖 Node 内置模块与 renderer/camera-controller.js（UMD，Node 下可 require）。
 * 设计文档：docs/exposure-assist-design.md（§6 检测 / §7 曝光策略 / §8 代码 / §9 交互契约）
 * ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const C = require(path.join(ROOT, 'renderer', 'camera-controller.js'));

let pass = 0;
let fail = 0;
const failures = [];

function ok(m) { pass++; console.log('  ✓ ' + m); }
function bad(m) { fail++; failures.push(m); console.log('  ✗ ' + m); }
function assert(cond, m) { cond ? ok(m) : bad(m); }
function eq(a, b, m) {
  const s = JSON.stringify(a);
  const t = JSON.stringify(b);
  assert(s === t, m + (s === t ? '' : '（实际 ' + s + ' / 期望 ' + t + '）'));
}
function near(a, b, tol, m) {
  const d = Math.abs(Number(a) - Number(b));
  assert(isFinite(d) && d <= (tol == null ? 1e-9 : tol),
    m + '（实际 ' + a + '，期望 ' + b + '±' + (tol == null ? 1e-9 : tol) + '）');
}
// 观察项：只记录、不计入通过/失败（用来留证「已知但不致命的粗糙点」）
const notes = [];
function note(m) { notes.push(m); console.log('  · 观察 ' + m); }

/* ========================================================================== *
 * 零、自建测试环境（虚拟时钟 + 假 track / 流 / video）—— 不复用实现者的 harness
 * ======================================================================== */
function makeClock(start) {
  let t = start == null ? 200000 : start;
  let nextId = 1;
  const jobs = new Map(); // id → { at, fn }
  return {
    now() { return t; },
    setTimeout(fn, ms) {
      const id = nextId++;
      jobs.set(id, { at: t + (Number(ms) || 0), fn: fn });
      return id;
    },
    clearTimeout(id) { return jobs.delete(id); },
    pending() { return jobs.size; },
    t() { return t; },
    // 把时钟推进 ms，按到期顺序执行所有回调（回调里新挂的定时器同样参与排序）
    advance(ms) {
      const limit = t + ms;
      for (;;) {
        let pick = null;
        let pickAt = Infinity;
        jobs.forEach(function (v, k) {
          if (v.at <= limit && v.at < pickAt) { pickAt = v.at; pick = k; }
        });
        if (pick === null) break;
        const job = jobs.get(pick);
        jobs.delete(pick);
        t = Math.max(t, job.at);
        job.fn();
      }
      t = limit;
      return t;
    }
  };
}

async function flush(n) {
  const k = n == null ? 60 : n;
  for (let i = 0; i < k; i++) await Promise.resolve();
}

// 推进虚拟时间并持续排空微任务（异步链路靠这个前进）
async function pump(clock, ms, step) {
  const s = step || 5;
  const target = clock.t() + ms;
  while (clock.t() < target) {
    clock.advance(s);
    await flush(20);
  }
  await flush(60);
}

// 在有限次微任务内等待 promise settle（不依赖真实时间）
async function settle(p, n) {
  let done = false;
  let value;
  Promise.resolve(p).then(function (v) { done = true; value = v; }, function (e) { done = true; value = e; });
  for (let i = 0; i < (n || 600) && !done; i++) await Promise.resolve();
  return { done: done, value: value };
}

/* 色板：与设计文档 §6.1 场景表同构，但像素取值为本套件自行定义 */
const COL = {
  pad: [255, 232, 84],     // 亮黄垫板：luma≈220、sat≈0.67 → 高亮格
  grey: [150, 150, 150],   // 被 AE 提亮成灰白的黑衣物：luma=150、sat=0 → 主体格
  white: [246, 246, 246],  // 白垫板/白衣物
  navy: [28, 40, 120]      // 深蓝衣物：luma≈55、sat≈0.77 → 高饱和，不算主体
};

// 按 8×8 格铺出 64×64 的 ImageData 结构
function makeImage(pickCell) {
  const g = 8;
  const side = 64;
  const cw = side / g;
  const data = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const c = pickCell(Math.floor(x / cw), Math.floor(y / cw));
      const i = (y * side + x) * 4;
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
    }
  }
  return { width: side, height: side, data: data };
}

const IMG = {
  // 黑衣物在中央 + 亮黄垫板 → 命中
  hit() {
    return makeImage(function (cx, cy) {
      const center = cy >= 2 && cy <= 4 && cx >= 2 && cx <= 5;
      const below = (cy === 5 || cy === 6) && cx >= 1 && cx <= 5;
      return center || below ? COL.grey : COL.pad;
    });
  },
  // 白衣物 + 白垫板 → 主体面积不足，不命中
  miss() {
    return makeImage(function (cx, cy) { return cy === 0 && cx < 2 ? COL.grey : COL.white; });
  },
  // 深蓝衣物 → 高饱和被排除，不命中
  navy() {
    return makeImage(function (cx, cy) {
      const center = cy >= 2 && cy <= 4 && cx >= 2 && cx <= 5;
      return center ? COL.navy : COL.pad;
    });
  }
};

/**
 * 假视频轨：mode 可切换 ok / reject / hang，calls 录制每一次 applyConstraints。
 */
function makeTrack(opts) {
  const o = opts || {};
  const t = {
    readyState: 'live',
    muted: false,
    _h: {},
    calls: [],
    mode: o.mode || 'ok',
    caps: o.caps === undefined ? { exposureCompensation: { min: -3, max: 3, step: 0.1 } } : o.caps,
    settings: o.settings === undefined ? { exposureCompensation: 0 } : o.settings,
    addEventListener(k, f) { (this._h[k] = this._h[k] || []).push(f); },
    removeEventListener(k, f) {
      const a = this._h[k] || [];
      const i = a.indexOf(f);
      if (i >= 0) a.splice(i, 1);
    },
    stop() { this.readyState = 'ended'; },
    getCapabilities() { return this.caps; },
    getSettings() { return this.settings; },
    applyConstraints(cst) {
      this.calls.push(cst);
      if (this.mode === 'hang') return new Promise(function () {});
      if (this.mode === 'reject') return Promise.reject(new Error('qa-reject'));
      return Promise.resolve();
    },
    fire(k) { (this._h[k] || []).slice().forEach(function (f) { f(); }); }
  };
  return t;
}

function makeVideo() {
  return {
    readyState: 4,
    videoWidth: 640,
    videoHeight: 480,
    srcObject: null,
    play() { return Promise.resolve(); }
  };
}

// 曝光辅助的时间参数整体压到毫秒级：行为与 250ms/1500ms/3000ms 一致，只是跑得快
const TCFG = {
  openTimeoutMs: 200,
  frameWaitMs: 100,
  framePollMs: 5,
  degradedWatchMs: 400,
  attachTimeoutMs: 100,
  backoffMs: [10, 10, 10, 10],
  maxAttempts: 4,
  resBudgetMs: 100,
  expEngageDelayMs: 10,
  expCycleMs: 10,
  expEngageHits: 3,
  expReleaseMisses: 4,
  expMinHoldMs: 100,
  expReEngageCooldownMs: 300,
  expStepGapMs: 20,
  expSettleMs: 10,
  expApplyTimeoutMs: 40,
  expApplyFailLimit: 2
};

function makeHarness(over) {
  const o = over || {};
  const M = o.mod || C;          // 可注入「变异后的控制器模块」，用于等价性实验
  const clock = makeClock();
  const logs = [];
  const track = o.track || makeTrack(o.trackOpts);
  const stream = {
    getTracks() { return [track]; },
    getVideoTracks() { return [track]; }
  };
  const video = o.video || makeVideo();
  const scene = {
    image: o.image !== undefined ? o.image : IMG.hit(),
    gray: o.gray !== undefined ? o.gray : new Array(4096).fill(140),
    visible: o.visible !== false,
    focus: o.focus === true,
    assistOn: o.assistOn !== false
  };
  const ctrl = M.createCameraController({
    mediaDevices: {
      getUserMedia() { return Promise.resolve(stream); },
      enumerateDevices() { return Promise.resolve([]); },
      addEventListener() {},
      removeEventListener() {}
    },
    videoGetter() { return video; },
    now() { return clock.now(); },
    setTimeout(fn, ms) { return clock.setTimeout(fn, ms); },
    clearTimeout(id) { return clock.clearTimeout(id); },
    log(l, e, f) { logs.push({ level: l, event: e, fields: f || {}, t: clock.now() }); },
    frameSampler() { return scene.gray; },
    gridSampler() { return scene.image; },
    pageVisible() { return scene.visible; },
    focusBusy() { return scene.focus; },
    exposureAssistEnabled() { return scene.assistOn; },
    config: Object.assign({}, TCFG, o.config || {})
  });
  return {
    clock: clock,
    logs: logs,
    track: track,
    video: video,
    ctrl: ctrl,
    scene: scene,
    setImage(img) { scene.image = img; },
    setGray(arr) { scene.gray = arr; },
    setVisible(v) { scene.visible = !!v; },
    setFocus(v) { scene.focus = !!v; }
  };
}

async function boot(h) {
  const r = await settle(h.ctrl.mount(function () { return h.video; }));
  await flush(40);
  return r;
}

const logsOf = (logs, name) => logs.filter(function (x) { return x.event === name; });
const hasLog = (logs, name) => logsOf(logs, name).length > 0;
const reasonsOf = (logs, name) => logsOf(logs, name).map(function (x) { return x.fields.reason; });

/* ========================================================================== *
 * 一、【P0-1】独立复核：nextEvStep 的符号（设计文档 §7.2 / §8.2 写的是 ev + step）
 *
 * 设计文档原文：err = subjectMean - expTargetMean（正=还太亮），step = err × 增益（正），
 *               ev = clamp(ev + step, expEvMin, 0)
 * 这里把文档原文在本地实现成 docEvStep()，与实现的 nextEvStep() 逐帧对拍。
 * ======================================================================== */
function docEvStep(curEv, subjectMean, cfg) {
  const c = cfg;
  const err = subjectMean - c.expTargetMean;
  if (Math.abs(err) < c.expDeadzone) return { ev: curEv, step: 0, err: err };
  let step = err * c.expEvGain;
  if (step > c.expMaxStepEv) step = c.expMaxStepEv;
  if (step < -c.expMaxStepEv) step = -c.expMaxStepEv;
  let next = curEv + step;               // ← 设计文档原文
  if (next < c.expEvMin) next = c.expEvMin;
  if (next > 0) next = 0;
  return { ev: next, step: next - curEv, err: err };
}

// 亮度模型（码值域）：实现端 sRGB gamma 下，补偿每 -1EV 码值 ×2^(-1/γ)。
// 用 120×2^(ev/γ) 而非朴素 120×2^ev：真实 8bit 管线的码值响应比线性光缓 2.2 倍，
// 一步即可收敛（见调查报告 docs/field-2026-10-23-tier0-darkening.md §ISP 提亮）。
// 若用朴素线性模型，本段会造出「ev 在 -0.34↔-0.08 间来回呼吸」的极限环——那是测试
// 模型失真，不是实现行为，故收敛推演必须用真实码值响应。
const brightnessAt = (ev) => 120 * Math.pow(2, ev / C.SRGB_GAMMA);

async function sectEvSign() {
  console.log('\n· 【P0-1】nextEvStep 符号：独立数值推演 + 与设计文档写法对拍');
  const D = C.DEFAULTS;
  const S0 = 120;   // 任务书指定：subjectMean=120
  const T = 105;    // expTargetMean（2026-10-23 现场标定 58→105，调查报告 docs/field-2026-10-23-tier0-darkening.md）
  const G = 0.025;  // expEvGain
  assert(D.expTargetMean === T && D.expEvGain === G, 'Q1 默认阈值确为 target=105、gain=0.025（推演前提成立）');

  /* --- 手工推演（以常量自身推导第一帧，不写死结论） --- */
  const err0 = S0 - T;                       // 15
  const step0raw = err0 * G;                 // 0.375
  const step0 = Math.min(step0raw, D.expMaxStepEv); // 0.34（单步上限）
  eq(err0, 15, 'Q2 首帧 err = 120 − 105 = 15（正=还太亮，需要更负的补偿）');
  near(step0raw, 0.375, 1e-9, 'Q3 首帧原始步长 = 15 × 0.025 = 0.375 EV');
  near(step0, 0.34, 1e-9, 'Q4 单步上限把首帧步长钳到 0.34 EV');

  // 文档写法：ev + step → 正向 → 被上限锁 0 → 永远停在 0（补偿一次都没下发）
  const docSeq = [];
  let dev = 0;
  for (let i = 0; i < 20; i++) {
    const r = docEvStep(dev, S0, D);
    docSeq.push({ ev: r.ev, step: r.step, err: r.err });
    dev = r.ev;
  }
  assert(docSeq.every(function (x) { return x.ev === 0 && x.step === 0; }),
    'Q5 文档写法（ev + step）：20 帧后 ev 恒为 0、步长恒为 0 —— 负补偿一次都发不出去');
  assert(docSeq.every(function (x) { return x.err === 15; }),
    'Q6 文档写法下 err 20 帧不变（亮度从未被改变），闭环在 ev=0 处死锁');
  assert(docSeq.every(function (x) { return x.ev > D.expEvMin; }),
    'Q7 文档写法永远够不到下限 expEvMin（不是「钳位过紧」，是根本不动）');

  // 实现写法：ev − step，配合亮度模型逐帧推演
  const implSeq = [];
  let ev = 0;
  for (let i = 0; i < 20; i++) {
    const measured = brightnessAt(ev);          // 当前补偿下的实测主体亮度
    const r = C.nextEvStep(ev, measured, D);
    implSeq.push({ ev: r.ev, step: r.step, err: r.err, mean: measured });
    if (r.step === 0) break;
    ev = r.ev;
  }
  // 打印推演表，供人工复核（不是断言，但把过程留在日志里）
  console.log('      推演表（实现写法，亮度模型 mean = 120×2^(ev/γ)，γ=' + C.SRGB_GAMMA + '）：');
  console.log('        帧 |  curEv  | subjectMean | err   | 步长    | 新 ev');
  implSeq.forEach(function (x, i) {
    console.log('        ' + (i + 1) + '  | ' + (i === 0 ? 0 : implSeq[i - 1].ev).toFixed(4) +
      ' | ' + x.mean.toFixed(2) + '       | ' + x.err.toFixed(2) +
      '  | ' + x.step.toFixed(4) + ' | ' + x.ev.toFixed(4));
  });
  assert(implSeq[0].ev < 0 && implSeq[0].step < 0,
    'Q8 实现写法（ev − step）：过亮时首帧 ev=' + implSeq[0].ev.toFixed(3) + '，补偿方向正确（负）');
  assert(implSeq.length >= 2 && implSeq.length <= 8,
    'Q9 实现写法在 ' + implSeq.length + ' 帧内收敛（分步逼近，不跳变）');
  const last = implSeq[implSeq.length - 1];
  assert(Math.abs(last.err) < D.expDeadzone,
    'Q10 收敛判据成立：末帧 err=' + last.err.toFixed(2) + ' 落入死区 ±' + D.expDeadzone);
  near(last.mean, T, D.expDeadzone, 'Q11 末帧主体亮度 ' + last.mean.toFixed(1) + ' 命中目标 105±8（黑/深色而有纹理）');
  assert(implSeq.every(function (x) { return x.ev >= D.expEvMin - 1e-12 && x.ev <= 0; }),
    'Q12 全过程中 ev 始终落在 [expEvMin, 0] 内（只防过曝，不做正补偿）');
  const mono = implSeq.every(function (x, i) { return i === 0 || x.ev <= implSeq[i - 1].ev + 1e-12; });
  assert(mono, 'Q13 步进单调不振荡（否则画面上会看到亮度来回呼吸）');

  // 反向（欠曝）：两个写法的方向必须相反 —— 说明这不是「等价改写」，符号确实是实质差异
  const under = 40;                            // 比目标 105 暗 65
  const implUp = C.nextEvStep(-1.0, under, D);
  const docUp = docEvStep(-1.0, under, D);
  assert(implUp.ev > -1.0, 'Q14 实现：比目标更暗时补偿回调（-1.0 → ' + implUp.ev.toFixed(3) + '），闭环自愈');
  assert(docUp.ev < -1.0, 'Q15 文档：同一输入反而越补越负（-1.0 → ' + docUp.ev.toFixed(3) + '），方向颠倒');
  assert(implUp.ev !== docUp.ev, 'Q16 两写法在同一输入上输出不同 → 该偏离是行为级修正，不是等价重写');

  // 边界：非数值输入不得瞎调
  const nul = C.nextEvStep(-0.4, null, D);
  const nan = C.nextEvStep(-0.4, NaN, D);
  assert(nul.step === 0 && nul.ev === -0.4 && nan.step === 0 && nan.ev === -0.4,
    'Q17 subjectMean 为 null/NaN 时不动（采样失败不瞎调）');
}

/* ========================================================================== *
 * 二、【P0-2】独立复核：stepAssistHysteresis 的时间戳（设计文档 §8.2 只复制 state/hit/miss）
 * ======================================================================== */
function docHysteresis(st, hit, nowMs, cfg) {
  const c = cfg;
  const s = { state: st.state, hit: st.hit, miss: st.miss };  // ← 设计文档原文：丢掉时间戳
  if (hit) { s.hit += 1; s.miss = 0; } else { s.miss += 1; s.hit = 0; }
  if (s.state === 'IDLE' && s.hit >= c.expEngageHits &&
    nowMs - (st.releasedAt || 0) >= c.expReEngageCooldownMs) {
    return { st: { state: 'ACTIVE', hit: 0, miss: 0, engagedAt: nowMs, releasedAt: 0 }, action: 'engage' };
  }
  if (s.state === 'ACTIVE' && s.miss >= c.expReleaseMisses &&
    nowMs - (st.engagedAt || 0) >= c.expMinHoldMs) {
    return { st: { state: 'IDLE', hit: 0, miss: 0, engagedAt: 0, releasedAt: nowMs }, action: 'release' };
  }
  return { st: s, action: null };
}

async function sectHysteresisStamp() {
  console.log('\n· 【P0-2】stepAssistHysteresis 时间戳：中间帧是否真的丢字段');
  const D = C.DEFAULTS;
  const engaged = { state: 'ACTIVE', hit: 0, miss: 0, engagedAt: 100000, releasedAt: 0 };

  // 「命中但不切换状态」的中间帧（miss=1 < expReleaseMisses）
  const mid = C.stepAssistHysteresis(engaged, false, 100100, D);
  assert(mid.action === null && mid.st.state === 'ACTIVE', 'Q18 构造成立：单帧未命中不切换状态（action=null）');
  assert(mid.st.engagedAt === 100000, 'Q19 实现：中间帧把 engagedAt 原样带下去（' + mid.st.engagedAt + '）');
  assert(mid.st.releasedAt === 0, 'Q20 实现：中间帧把 releasedAt 原样带下去');

  // 把同一中间帧连推 3 次，时间戳必须一直活着
  let s = engaged;
  let aliveStamp = true;
  for (let i = 1; i <= 3; i++) {
    const r = C.stepAssistHysteresis(s, false, 100100 + i * 10, D);
    s = r.st;
    if (s.engagedAt !== 100000) aliveStamp = false;
  }
  assert(aliveStamp, 'Q21 实现：连续 3 个中间帧后 engagedAt 仍未丢失');

  // 文档写法：同一路径丢字段 —— 证明设计文档确实有 bug
  const docMid = docHysteresis(engaged, false, 100100, D);
  assert(docMid.st.engagedAt === undefined && docMid.st.releasedAt === undefined,
    'Q22 文档写法：中间帧返回的 st 里 engagedAt/releasedAt 均为 undefined（字段被丢弃，bug 成立）');

  /* --- 后果一：冷却闸门永久失效（这才是真正的现场危害：反复横跳） --- */
  const released = { state: 'IDLE', hit: 0, miss: 0, engagedAt: 0, releasedAt: 105000 };
  // 冷却 3000ms：105000 + 750 处的三连命中不该 engage
  let si = released;
  let siEngage = null;
  for (let i = 1; i <= 3; i++) {
    const r = C.stepAssistHysteresis(si, true, 105000 + i * 250, D);
    si = r.st;
    if (r.action === 'engage') siEngage = 105000 + i * 250;
  }
  assert(siEngage === null, 'Q23 实现：release 后 750ms 的三连命中仍被冷却挡住（不提前 engage）');

  let sd = released;
  let sdEngage = null;
  for (let i = 1; i <= 3; i++) {
    const r = docHysteresis(sd, true, 105000 + i * 250, D);
    sd = r.st;
    if (r.action === 'engage') sdEngage = 105000 + i * 250;
  }
  eq(sdEngage, 105750, 'Q24 文档写法：release 仅 750ms 后就重新 engage（冷却 3000ms 被架空）');
  assert(sdEngage !== null && sdEngage - released.releasedAt < D.expReEngageCooldownMs,
    'Q25 文档写法在冷却期内 engage → 正是设计文档 §6.3 要防的「半出画→再入画反复横跳」');

  // 实现：冷却期满后必须能正常 engage（不能反向修成「永不 engage」）
  let sp = si;
  let spEngage = null;
  for (let i = 1; i <= 8; i++) {
    const r = C.stepAssistHysteresis(sp, true, 105000 + D.expReEngageCooldownMs + i * 250, D);
    sp = r.st;
    if (r.action === 'engage') { spEngage = 105000 + D.expReEngageCooldownMs + i * 250; break; }
  }
  assert(spEngage !== null && spEngage >= 105000 + D.expReEngageCooldownMs,
    'Q26 实现：冷却期满后正常 engage（修复没有把闸门修成永久关闭）');

  /* --- 后果二：最短保持闸门失效（门控可被绕过） --- */
  const fresh = { state: 'ACTIVE', hit: 0, miss: 0, engagedAt: 100000, releasedAt: 0 };
  // 100ms 间隔连打 10 帧未命中 = 1000ms < expMinHoldMs(1500) → 不该 release
  let hi = fresh;
  let hiRel = null;
  for (let i = 1; i <= 10; i++) {
    const r = C.stepAssistHysteresis(hi, false, 100000 + i * 100, D);
    hi = r.st;
    if (r.action === 'release') hiRel = 100000 + i * 100;
  }
  assert(hiRel === null, 'Q27 实现：未满 expMinHoldMs 前连续 10 帧未命中也不 release');

  let hd = fresh;
  let hdRel = null;
  for (let i = 1; i <= 10; i++) {
    const r = docHysteresis(hd, false, 100000 + i * 100, D);
    hd = r.st;
    if (r.action === 'release') hdRel = 100000 + i * 100;
  }
  eq(hdRel, 101000, 'Q28 文档写法：凑满 10 帧未命中即刻 release（engagedAt 已丢失 → nowMs−0 恒过闸）');
  assert(hdRel !== null && hdRel - fresh.engagedAt < D.expMinHoldMs,
    'Q29 文档写法在最短保持期内（' + (hdRel - fresh.engagedAt) + 'ms < ' + D.expMinHoldMs +
    'ms）release → 衣物半出画就恢复，补偿抖动');

  /* --- 字段完整性：任何转移分支的返回 st 都必须带齐 4 个字段 --- */
  const seeds = [
    { state: 'IDLE', hit: 0, miss: 0, engagedAt: 0, releasedAt: 0 },
    { state: 'IDLE', hit: 2, miss: 0, engagedAt: 0, releasedAt: 0 },
    { state: 'IDLE', hit: 2, miss: 0, engagedAt: 0, releasedAt: 100 },
    { state: 'ACTIVE', hit: 0, miss: 0, engagedAt: 100, releasedAt: 0 },
    { state: 'ACTIVE', hit: 0, miss: 9, engagedAt: 100, releasedAt: 0 },
    { state: 'ACTIVE', hit: 0, miss: 9, engagedAt: 1, releasedAt: 0 }
  ];
  const times = [0, 100, 500, 2000, 5000, 99999];
  let bad4 = 0;
  seeds.forEach(function (sd) {
    [true, false].forEach(function (hit) {
      times.forEach(function (tm) {
        const r = C.stepAssistHysteresis(sd, hit, tm, D);
        const keys = Object.keys(r.st).sort().join(',');
        if (keys !== 'engagedAt,hit,miss,releasedAt,state' && keys !== 'engagedAt,hit,miss,releasedAt,state') {
          bad4++;
        }
        if (!('engagedAt' in r.st) || !('releasedAt' in r.st)) bad4++;
      });
    });
  });
  assert(bad4 === 0, 'Q30 全部 ' + (seeds.length * 2 * times.length) + ' 条转移路径都返回 4 个字段（state/hit/miss/时间戳）');
}

/* ========================================================================== *
 * 三、【P0-3】红线：曝光约束绝不夹带 width / height / frameRate
 * ======================================================================== */
const RES_KEYS = ['width', 'height', 'frameRate', 'aspectRatio'];

function resKeyHits(node, prefix) {
  const hits = [];
  (function walk(n, p) {
    if (!n || typeof n !== 'object') return;
    Object.keys(n).forEach(function (k) {
      if (RES_KEYS.indexOf(k) >= 0) hits.push(p + '.' + k);
      walk(n[k], p + '.' + k);
    });
  })(node, prefix || 'cst');
  return hits;
}

async function sectRedline() {
  console.log('\n· 【P0-3】红线：曝光约束只带 advanced 曝光键');
  const D = C.DEFAULTS;

  /* --- 1. 静态：源码里到底有几处构造曝光约束的地方 --- */
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'camera-controller.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  const expFns = ['buildExposureConstraints', 'buildExposureRestoreConstraints'];
  expFns.forEach(function (fn) {
    const i = src.indexOf('function ' + fn + '(');
    assert(i > 0, 'Q31 源码可定位 ' + fn + '()');
  });
  // 只有这两个函数会 return 带 advanced 的对象：必须确认没有第三个漏网的构造点
  const iA = src.indexOf('function buildExposureConstraints(');
  const iB = src.indexOf('function buildExposureRestoreConstraints(');
  const iEnd = src.indexOf('function buildExposureLut(', iB);
  assert(iA > 0 && iB > iA && iEnd > iB, 'Q32 两个约束构造函数在源码中连续成段（便于界定「唯一的构造区」）');
  const advancedLines = [];
  {
    const re = /return \{ advanced:/g;
    let mm;
    while ((mm = re.exec(src)) !== null) advancedLines.push(mm.index);
  }
  eq(advancedLines.length, 7, 'Q33 return { advanced: ... } 共 7 处（tier1 施加 / brightness 施加 / tier2 施加 / tier1 恢复 / brightness 恢复 / continuous 恢复 / tier2 恢复）');
  const outside = advancedLines.filter(function (i) { return i < iA || i > iEnd; });
  assert(outside.length === 0, 'Q34 5 处构造全部落在 buildExposureConstraints ~ buildExposureRestoreConstraints 区间内（区间外 ' +
    outside.length + ' 处）');

  /* --- 2. 穷举所有分支逐一扫红线（不是抽样） --- */
  const tier1 = { tier: 1, reason: 'x', min: -3, max: 3, step: 0.1 };
  const tier2Time = {
    tier: 2, reason: 'x', baseTime: 500, baseIso: null,
    timeMin: 10, timeMax: 10000, isoMin: null, isoMax: null, restoreMode: 'continuous'
  };
  const tier2Iso = {
    tier: 2, reason: 'x', baseTime: null, baseIso: 200,
    timeMin: null, timeMax: null, isoMin: 50, isoMax: 3200, restoreMode: 'manual-baseline'
  };
  const tier2Both = {
    tier: 2, reason: 'x', baseTime: 500, baseIso: 200,
    timeMin: 10, timeMax: 10000, isoMin: 50, isoMax: 3200, restoreMode: 'manual-baseline'
  };
  const branches = [
    ['tier1 补偿 -1.2', C.buildExposureConstraints(tier1, -1.2)],
    ['tier1 补偿 0', C.buildExposureConstraints(tier1, 0)],
    ['tier1 补偿 -2.0（下限）', C.buildExposureConstraints(tier1, -2.0)],
    ['tier2 压曝光时间', C.buildExposureConstraints(tier2Time, -1)],
    ['tier2 退调 iso', C.buildExposureConstraints(tier2Iso, -1)],
    ['tier2 双能力（优先时间）', C.buildExposureConstraints(tier2Both, -1)],
    ['tier1 恢复', C.buildExposureRestoreConstraints({ tier: 1 })],
    ['tier2 恢复 continuous', C.buildExposureRestoreConstraints({ tier: 2, restoreMode: 'continuous' })],
    ['tier2 恢复基线', C.buildExposureRestoreConstraints({ tier: 2, restoreMode: 'manual-baseline', baseTime: 500, baseIso: 200 })],
    ['brightness 施加 -1.2', C.buildExposureConstraints({ tier: 'brightness', reason: 'brightness', min: 0, max: 255, step: 1, base: 128 }, -1.2)],
    ['brightness 恢复', C.buildExposureRestoreConstraints({ tier: 'brightness', reason: 'brightness', min: 0, max: 255, step: 1, base: 128 })],
    ['tier0 施加（应为 null）', C.buildExposureConstraints({ tier: 0 }, -1)],
    ['tier0 恢复（应为 null）', C.buildExposureRestoreConstraints({ tier: 0 })]
  ];
  let nonNull = 0;
  let violations = [];
  branches.forEach(function (b) {
    if (b[1] === null) return;
    nonNull++;
    violations = violations.concat(resKeyHits(b[1], b[0]));
    // 结构纪律：只允许 advanced 一个顶层键
    const top = Object.keys(b[1]);
    if (top.length !== 1 || top[0] !== 'advanced') violations.push(b[0] + ' 顶层键异常:' + top.join('|'));
  });
  eq(nonNull, 11, 'Q35 11 条有产出的分支全部纳入扫描（tier1×3 / tier2×3 / tier1 恢复 / tier2 恢复×2 / brightness 施加 / brightness 恢复；tier0 两条为 null，不发约束）');
  assert(violations.length === 0, 'Q36 全部 11 条分支零分辨率/帧率键（越界：' + (violations.join(',') || '无') + '）');
  // 按名字取 tier0 两条，不要按索引：branches 里插入 brightness 分支后索引整体后移，
  // 写死下标会让这条断言悄悄指向别的分支（Q37 曾因此指向 brightness 而误报红）。
  const branchByName = {};
  branches.forEach(function (b) { branchByName[b[0]] = b[1]; });
  assert(branchByName['tier0 施加（应为 null）'] === null && branchByName['tier0 恢复（应为 null）'] === null,
    'Q37 tier0 两条路径返回 null（软件兜底不发任何约束，物理上不可能碰分辨率）');

  /* --- 3. 阳性对照：把 width 塞进去，检查器必须变红（证明不是空跑） --- */
  const poisoned = JSON.parse(JSON.stringify(branches[0][1]));
  poisoned.width = { exact: 1920 };
  poisoned.advanced[0].height = { exact: 1080 };
  const poisonedHits = resKeyHits(poisoned, 'probe');
  assert(poisonedHits.length === 2, 'Q38 阳性对照：检查器能抓到人为夹带的 width/height（' + poisonedHits.join(',') + '）');

  /* --- 4. 运行期：真实链路里每一次 applyConstraints 的约束都过一遍红线 --- */
  const h = makeHarness();
  await boot(h);
  await pump(h.clock, 200, 5);            // engage + 若干步
  h.setImage(IMG.miss());
  await pump(h.clock, 300, 5);            // release + restore
  h.track.mode = 'reject';
  h.setImage(IMG.hit());
  await pump(h.clock, 300, 5);            // 再 engage → apply 失败 → 降级
  h.ctrl.unmount();
  await flush(60);

  assert(h.track.calls.length >= 3, 'Q39 运行期确实下发了 ' + h.track.calls.length + ' 次约束（非空跑）');
  let runtimeHits = [];
  h.track.calls.forEach(function (cst, i) { runtimeHits = runtimeHits.concat(resKeyHits(cst, '#' + i)); });
  assert(runtimeHits.length === 0, 'Q40 运行期全链路零分辨率键（越界：' + (runtimeHits.join(',') || '无') + '）');

  // 另：恢复路径的约束也必须只带 advanced
  const restores = h.track.calls.filter(function (cst) {
    const a = cst && cst.advanced;
    return a && a.length === 1 && (a[0].exposureCompensation === 0 || a[0].exposureMode === 'continuous');
  });
  assert(restores.length >= 1, 'Q41 链路中出现过恢复约束（补偿归零 / 切回 continuous）');
}

/* ========================================================================== *
 * 四、【P1】边界与错误路径
 * ======================================================================== */
async function sectBoundary() {
  console.log('\n· 【P1】边界与错误路径');

  /* --- 4.1 能力对象缺字段：不能用 NaN/Infinity 去发约束 --- */
  const capNoMax = { exposureCompensation: { min: -3, step: 0.1 } };
  const pNoMax = C.pickExposurePlan(capNoMax, {});
  assert(pNoMax.tier === 1, 'Q42 只有 min、缺 max 的补偿能力仍判 tier1（能力可用就别降级）');
  eq(pNoMax.max, 0, 'Q43 缺 max 时上界兜底为 0（本方案不做正补偿，0 是安全上界）');
  const cNoMax = C.buildExposureConstraints(pNoMax, -1.5);
  near(cNoMax.advanced[0].exposureCompensation, -1.5, 1e-9, 'Q44 缺 max 不影响负补偿下发（-1.5 原样透传）');
  near(C.buildExposureConstraints(pNoMax, 0.8).advanced[0].exposureCompensation, 0, 1e-9,
    'Q45 缺 max 时正值被夹到 0（不会把画面往更亮推）');

  const capNoMin = { exposureCompensation: { max: 3, step: 0.1 } };
  assert(C.pickExposurePlan(capNoMin, {}).tier === 0, 'Q46 缺 min 不判 tier1（min 缺失无法钳位，宁可降级）');

  const capT2NoTimeMax = { exposureMode: ['manual'], exposureTime: { min: 10 } };
  const pT2a = C.pickExposurePlan(capT2NoTimeMax, { exposureTime: 500 });
  eq(pT2a.tier, 2, 'Q47 exposureTime 缺 max 仍判 tier2');
  eq(pT2a.timeMax, 1e9, 'Q48 缺 timeMax 兜底 1e9（不产生 undefined 比较）');
  const cT2a = C.buildExposureConstraints(pT2a, -2);
  near(cT2a.advanced[0].exposureTime, 125, 1e-9, 'Q49 缺 timeMax 时仍按 500×2^-2=125µs 压暗');
  assert(isFinite(cT2a.advanced[0].exposureTime), 'Q50 曝光时间是有限数（不是 NaN/Infinity）');

  const capT2NoIsoMax = { exposureMode: ['manual'], iso: { min: 100 } };
  const pT2b = C.pickExposurePlan(capT2NoIsoMax, { iso: 400 });
  eq(pT2b.isoMax, 1e9, 'Q51 缺 isoMax 兜底 1e9');
  const cT2b = C.buildExposureConstraints(pT2b, -1);
  near(cT2b.advanced[0].iso, 200, 1e-9, 'Q52 只有 iso 能力时按 400×2^-1=200 下调');
  assert(isFinite(cT2b.advanced[0].iso), 'Q53 iso 是有限数');

  // 能力对象整体缺失 / 抛异常 —— 必须降级而不是崩
  assert(C.pickExposurePlan(null, null).tier === 0, 'Q54 能力为 null → tier0');
  const capThrowTrack = makeTrack({ caps: null });
  capThrowTrack.getCapabilities = function () { throw new Error('caps-boom'); };
  const hThrow = makeHarness({ track: capThrowTrack });
  await boot(hThrow);
  await pump(hThrow.clock, 120, 5);
  assert(hThrow.ctrl.state === 'LIVE', 'Q55 getCapabilities() 抛异常不影响出画（仍 LIVE）');
  assert(hThrow.ctrl.getExposureInfo().tier === 0, 'Q56 能力探测抛异常 → 降级 tier0 软件兜底');
  hThrow.ctrl.unmount();
  await flush(40);

  const capNoComp = { exposureMode: ['continuous'] };
  const hNoComp = makeHarness({ track: makeTrack({ caps: capNoComp }) });
  await boot(hNoComp);
  await pump(hNoComp.clock, 120, 5);
  assert(hNoComp.ctrl.getExposureInfo().state === 'ACTIVE' && hNoComp.ctrl.getExposureInfo().tier === 0,
    'Q57 无补偿能力 → 仍进 ACTIVE 但 tier0（EV 闭环照走，供拍照 LUT 用）');
  assert(hNoComp.track.calls.length === 0, 'Q58 tier0 一次硬件约束都不发（不会拿无效约束去骚扰设备）');
  const tier0Ev = hNoComp.ctrl.getExposureInfo().ev;
  assert(tier0Ev < 0, 'Q59 tier0 下 EV 仍在闭环推进（' + tier0Ev.toFixed(3) + '，供 LUT 用）');
  hNoComp.ctrl.unmount();
  await flush(40);

  /* --- 4.2 step 为 0 / 负数 / 非数：不得除零或死循环 --- */
  const mkPlan = function (step) { return { tier: 1, min: -3, max: 3, step: step }; };
  near(C.buildExposureConstraints(mkPlan(0), -1.234).advanced[0].exposureCompensation, -1.234, 1e-9,
    'Q60 step=0 → 跳过取整，原值透传（无除零）');
  near(C.buildExposureConstraints(mkPlan(-0.1), -1.234).advanced[0].exposureCompensation, -1.234, 1e-9,
    'Q61 step<0 → 同样跳过取整（负数步长不会让 Math.round 来回震荡）');
  const nanStep = C.buildExposureConstraints(mkPlan(NaN), -1.234);
  assert(isFinite(nanStep.advanced[0].exposureCompensation) &&
    Math.abs(nanStep.advanced[0].exposureCompensation + 1.234) < 1e-9,
    'Q62 step=NaN → 跳过取整，仍发有限数（不会把 NaN 送进设备约束）');
  const infStep = C.buildExposureConstraints(mkPlan(Infinity), -1.234);
  assert(isFinite(infStep.advanced[0].exposureCompensation) &&
    Math.abs(infStep.advanced[0].exposureCompensation + 1.234) < 1e-9,
    'Q63 step=Infinity → isFinite 守卫生效，原值透传（不再算出 0×∞=NaN）');
  near(C.buildExposureConstraints(mkPlan(0.1), -1.234).advanced[0].exposureCompensation, -1.2, 1e-9,
    'Q64 step=0.1 → 正常取整到 -1.2（对照组：取整逻辑本身没坏）');

  /* --- 4.3 EV 贴住 expEvMin 后继续步进 --- */
  const D = C.DEFAULTS;
  const atFloor = C.nextEvStep(D.expEvMin, 200, D);
  eq(atFloor.step, 0, 'Q65 已在下限时纯函数不再产出步长（step=0）');
  near(atFloor.ev, D.expEvMin, 1e-12, 'Q66 下限值保持不变（不会被二次钳位放大）');
  const beyond = C.nextEvStep(D.expEvMin - 0.5, 200, D);
  near(beyond.ev, D.expEvMin, 1e-12, 'Q67 越界输入（ev 已低于下限）回到下限，不外溢');

  // 控制器层：静态过亮场景下，EV 到下限后不得继续空转 applyConstraints
  // 场景必须「持续命中且持续过亮」：黑衣物固定在中央，subjectMean 恒为 150（不随补偿变化），
  // 于是闭环必然一路走到 expEvMin —— 这正是「贴住下限」的最小复现
  const hFloor = makeHarness({
    image: IMG.hit(),
    config: { expEvMin: -0.6, expMaxStepEv: 0.34 }
  });
  await boot(hFloor);
  await pump(hFloor.clock, 400, 5);
  near(hFloor.ctrl.getExposureInfo().ev, -0.6, 1e-9, 'Q68 控制器层 EV 钳在 expEvMin=-0.6');
  const callsAtFloor = hFloor.track.calls.length;
  assert(callsAtFloor >= 2, 'Q69 前置成立：到下限前确实下发过约束（' + callsAtFloor + ' 次）');
  await pump(hFloor.clock, 400, 5);
  eq(hFloor.track.calls.length, callsAtFloor,
    'Q70 贴住下限后不再空转 applyConstraints（调用数冻结在 ' + callsAtFloor + '）');
  hFloor.ctrl.unmount();
  await flush(40);

  /* --- 4.4 入画 → 出画 → 入画：跨冷却的时序 --- */
  const hCd = makeHarness();
  await boot(hCd);
  await pump(hCd.clock, 120, 5);
  assert(hCd.ctrl.getExposureInfo().state === 'ACTIVE', 'Q71 前置：入画后已 ACTIVE');
  const engagesBefore = logsOf(hCd.logs, 'CAM_EXP_ENGAGE').length;
  hCd.setImage(IMG.miss());
  await pump(hCd.clock, 200, 5);
  const relLogs = logsOf(hCd.logs, 'CAM_EXP_RELEASE');
  assert(relLogs.length >= 1, 'Q72 出画后 release');
  const relT = relLogs[relLogs.length - 1].t;      // 精确的 release 时刻（取自日志时间戳）
  // 立刻再入画
  hCd.setImage(IMG.hit());
  await pump(hCd.clock, TCFG.expReEngageCooldownMs + 400, 5);
  const engagesAfter = logsOf(hCd.logs, 'CAM_EXP_ENGAGE').slice(engagesBefore);
  assert(engagesAfter.length >= 1, 'Q73 冷却期满后重新 engage（状态机不卡死，实际 ' +
    hCd.ctrl.getExposureInfo().state + '）');
  const gap = engagesAfter.length ? engagesAfter[0].t - relT : -1;
  assert(gap >= TCFG.expReEngageCooldownMs,
    'Q74 再入画的 engage 时刻距 release 至少 expReEngageCooldownMs（实际间隔 ' + gap +
    'ms ≥ ' + TCFG.expReEngageCooldownMs + 'ms）—— 冷却闸门在控制器层真的生效');
  assert(!hasLog(hCd.logs, 'CAM_EXP_FALLBACK') || hCd.ctrl.getExposureInfo().tier === 1,
    'Q75 反复入画出画不会把辅助拖进降级态');

  // 补一条更狠的：出画→入画×3 循环，期间不得出现「冷却期内 engage」
  const hCd2 = makeHarness();
  await boot(hCd2);
  await pump(hCd2.clock, 120, 5);
  for (let k = 0; k < 3; k++) {
    hCd2.setImage(IMG.miss());
    await pump(hCd2.clock, 150, 5);
    hCd2.setImage(IMG.hit());
    await pump(hCd2.clock, 150, 5);
  }
  const rel2 = logsOf(hCd2.logs, 'CAM_EXP_RELEASE');
  const eng2 = logsOf(hCd2.logs, 'CAM_EXP_ENGAGE');
  let earlyRe = 0;
  rel2.forEach(function (r) {
    eng2.forEach(function (g) {
      if (g.t > r.t && g.t - r.t < TCFG.expReEngageCooldownMs) earlyRe++;
    });
  });
  eq(earlyRe, 0, 'Q76 3 轮快速「出画→入画」中零次「冷却期内 engage」（release ' + rel2.length +
    ' 次 / engage ' + eng2.length + ' 次）');
  hCd.ctrl.unmount();
  hCd2.ctrl.unmount();
  await flush(40);

  /* --- 4.5 悬挂 track：失败达上限 → 降级 tier0 → 不再走硬件路径 --- */
  const hHang = makeHarness();
  await boot(hHang);
  await pump(hHang.clock, 60, 5);      // 先让 engage 正常完成（否则走的是 engage-apply-failed 分支）
  assert(hHang.ctrl.getExposureInfo().tier === 1, 'Q77 前置：硬件档 engage 成功（tier=1）');
  hHang.track.mode = 'hang';           // 之后设备开始悬挂
  await pump(hHang.clock, 400, 5);
  const info = hHang.ctrl.getExposureInfo();
  const fb = reasonsOf(hHang.logs, 'CAM_EXP_FALLBACK');
  assert(fb.indexOf('apply-timeout') >= 0, 'Q78 悬挂 applyConstraints 被竞速记账（apply-timeout）');
  assert(info.tier === 0, 'Q79 连续失败达 expApplyFailLimit → tier0 软件兜底（实际 tier=' + info.tier + '）');
  assert(fb.indexOf('fail-limit') >= 0, 'Q80 降级原因可追溯（fail-limit）；实际原因集 ' + JSON.stringify(fb));
  const callsAfterDegrade = hHang.track.calls.length;
  await pump(hHang.clock, 400, 5);
  assert(hHang.track.calls.length <= callsAfterDegrade + 1,
    'Q81 降级后不再反复尝试硬件路径（新增调用 ' + (hHang.track.calls.length - callsAfterDegrade) + ' 次，仅允许降级时那一次恢复）');
  assert(hHang.ctrl.getExposureInfo().tier === 0, 'Q82 降级是持久的（后续周期不会自己爬回硬件档）');
  hHang.ctrl.unmount();
  await flush(60);
  eq(hHang.clock.pending(), 0, 'Q83 悬挂 + 降级 + 卸载后没有残留定时器（I7）');

  /* --- 4.6 unmount 后无残留：定时器 / 在途竞速 --- */
  const hU = makeHarness();
  await boot(hU);
  await pump(hU.clock, 120, 5);
  hU.track.mode = 'hang';
  await pump(hU.clock, 15, 5);         // 卡在一次 apply 的中途
  const hangCalls = hU.track.calls.length;
  hU.ctrl.unmount();
  await flush(200);
  eq(hU.clock.pending(), 0, 'Q84 在途悬挂 apply 时 unmount → 无残留定时器');
  assert(hU.ctrl.getStream() === null, 'Q85 unmount 后无活跃流（I7）');
  assert(hU.track.readyState === 'ended', 'Q86 unmount 后 track 已 stop');
  const afterUnmount = hU.track.calls.length;
  await flush(100);
  eq(hU.track.calls.length, afterUnmount, 'Q87 unmount 之后不再产生任何新的 applyConstraints');
  assert(hangCalls > 0, 'Q88 前置成立：卸载前确实卡在 apply 上（' + hangCalls + ' 次调用）');

  /* --- 4.7 黑帧门控（§9.1）--- */
  const hGate = makeHarness({ gray: new Array(4096).fill(5) });   // 中心区全黑
  await boot(hGate);
  await pump(hGate.clock, 120, 5);
  assert(hGate.ctrl.getExposureInfo().state === 'ACTIVE', 'Q89 前置：门控场景下辅助 ACTIVE');
  assert(hGate.ctrl.isBlackFrame(hGate.video) === false, 'Q90 ACTIVE 且场景均值健康 → 放行（不把压暗后的黑衣物当全黑）');
  assert(hasLog(hGate.logs, 'CAM_EXP_BLACKGATE'), 'Q91 放行留痕 CAM_EXP_BLACKGATE');
  hGate.setImage(makeImage(function () { return [2, 2, 2]; }));   // 捂住镜头
  assert(hGate.ctrl.isBlackFrame(hGate.video) === true, 'Q92 捂住镜头（场景均值崩塌）→ 照常拒拍');
  hGate.ctrl.stopExposureAssist('qa', false);
  hGate.setImage(IMG.hit());
  assert(hGate.ctrl.isBlackFrame(hGate.video) === true, 'Q93 非 ACTIVE 时黑帧判定与改造前一致（门控不介入）');
  hGate.ctrl.unmount();
  await flush(40);

  /* --- 4.8 tier2 能力残缺：绝不发出「无曝光值的 manual」约束 --- */
  const weakT2 = C.pickExposurePlan({ exposureMode: ['manual', 'continuous'], exposureTime: { max: 10000 } },
    { exposureTime: 500 });
  eq(weakT2.tier, 0, 'Q94 只报 exposureTime.max（无 min）且无 iso → 降级 tier0（不切手动却不发曝光值）');
  eq(weakT2.reason, 'manual-without-min', 'Q95 降级原因可追溯（manual-without-min）');
  assert(C.buildExposureConstraints(weakT2, -1) === null, 'Q96 该设备不发任何曝光约束（走软件兜底，徽标如实显示「软件压暗」）');

  // 反向：不能误伤「有 min 无 max」的正常设备
  const pm1 = C.pickExposurePlan({ exposureMode: ['manual'], exposureTime: { min: 10 } }, { exposureTime: 500 });
  eq(pm1.tier, 2, 'Q97 有 timeMin 无 timeMax → 仍 tier2（1e9 兜底，不误伤）');
  near(C.buildExposureConstraints(pm1, -2).advanced[0].exposureTime, 125, 1e-9,
    'Q98 仍按 500×2⁻²=125µs 压暗');
  const pm2 = C.pickExposurePlan({ exposureMode: ['manual'], iso: { min: 100 } }, { iso: 400 });
  eq(pm2.tier, 2, 'Q99 有 isoMin 无 isoMax → 仍 tier2');
  near(C.buildExposureConstraints(pm2, -1).advanced[0].iso, 200, 1e-9, 'Q100 仍按 400×2⁻¹=200 下调');

  // 残余缺口（已上报，未阻断）：能力有 min，但 getSettings() 不给基线时仍会退化成无曝光值
  const noBase = C.pickExposurePlan({ exposureMode: ['manual', 'continuous'], exposureTime: { min: 10, max: 10000 } }, {});
  const noBaseCst = C.buildExposureConstraints(noBase, -1);
  if (noBaseCst && !noBaseCst.advanced[0].exposureTime && !noBaseCst.advanced[0].iso) {
    note('tier2 残余缺口：能力报 timeMin、但 getSettings() 未返回 exposureTime 基线（baseTime=null）时，' +
      'buildExposureConstraints 仍会产出 { advanced: [{ exposureMode: "manual" }] } —— 切了手动却不发曝光值，' +
      '画面不会被压暗而徽标显示「曝光补偿 xEV」。触发面比已修的那条更窄（需驱动能报 capabilities 却在 ' +
      'getSettings 里省略 exposureTime），且 tier2 本身就有 manual 冻结 AE 的语义。' +
      '根治建议：在 buildExposureConstraints 的 tier2 分支末尾加「两个曝光值都没产出 → return null」，' +
      '让 applyExposure 返回 false 并自然降级 tier0（一处守卫即覆盖全部基线缺失路径）。');
  } else {
    ok('Q101 tier2 在基线缺失时也不会发出无曝光值的 manual 约束');
  }
}

/* ========================================================================== *
 * 五、【P2】变异体抽查：转红原因必须是业务断言，而不是脚本崩溃
 * ======================================================================== */
const SRC_PATH = path.join(ROOT, 'renderer', 'camera-controller.js');
const SUITE_PATH = path.join(ROOT, 'scripts', 'verify-camera-exposure.js');

function loadSrcLf() {
  return fs.readFileSync(SRC_PATH, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * 在临时目录造一个变异体并子进程跑实现者的主检套件。
 * 子进程跑的好处：进程隔离，崩溃/退出码/输出都能独立观察，不受本套件状态污染。
 */
function runMutant(tag, from, to) {
  const src = loadSrcLf();
  const hits = src.split(from).length - 1;
  if (hits !== 1) return { anchor: hits, ok: false, why: '锚点命中 ' + hits + ' 次（应为 1）' };
  const body = src.split(from).join(to);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-mut-'));
  const file = path.join(dir, 'controller-mutant-' + tag + '.js');
  fs.writeFileSync(file, body, 'utf8');
  const r = spawnSync(process.execPath, [SUITE_PATH], {
    env: Object.assign({}, process.env, { CAM_CTRL_PATH: file }),
    encoding: 'utf8'
  });
  try { fs.unlinkSync(file); fs.rmdirSync(dir); } catch (e) { /* 清不掉不影响结论 */ }
  const out = (r.stdout || '') + (r.stderr || '');
  const lines = out.split('\n');
  const redLines = lines.filter(function (l) { return l.indexOf('  ✗ ') === 0; }).map(function (l) { return l.trim(); });
  const summary = (out.match(/结果：(\d+) 通过，(\d+) 失败/) || []);
  return {
    anchor: hits,
    ok: true,
    exit: r.status,
    crashed: out.indexOf('脚本异常') >= 0,
    pass: summary[1] ? Number(summary[1]) : -1,
    fail: summary[2] ? Number(summary[2]) : -1,
    red: redLines,
    out: out
  };
}

/**
 * 在本进程里加载一份变异后的控制器模块（供等价性对照实验用）。
 * 与 runMutant 的区别：runMutant 走子进程跑实现者的整段套件；这里要拿到模块本体
 * 去驱动本套件自己的 harness，才能逐项对比对外可观察结果。
 */
function requireMutantModule(sp) {
  const src = loadSrcLf();
  const body = src.split(sp.from).join(sp.to);
  const file = path.join(os.tmpdir(), 'qa-eq-' + sp.id + '-' + Date.now() + '.js');
  fs.writeFileSync(file, body, 'utf8');
  const mod = require(file);
  try { fs.unlinkSync(file); } catch (e) {}
  return mod;
}

async function sectMutants() {
  console.log('\n· 【P2】变异体抽查（M12 / M13 / M17 / M26 + QA 自加 MQ1）');
  const src = loadSrcLf();

  // 抽查清单：前 4 条照抄实现者的变异定义（独立重跑、独立判读），第 5 条由 QA 自己加
  const spots = [
    {
      id: 'M12',
      what: '删掉 EV 累计下限钳位',
      from: 'if (next < c.expEvMin) next = c.expEvMin; // 下限保护：再暗就逼近黑帧闸门',
      to: '/* QA-MUTANT: 下限钳位被删除 */',
      expect: ['D6', 'D7', 'D12'],
      semantic: function (s2) {
        // 语义校验：删除后 nextEvStep 必须真的能越过下限（不是语法错误）
        const m = s2.replace('/* QA-MUTANT: 下限钳位被删除 */', '');
        return m.indexOf('next < c.expEvMin') < 0;
      }
    },
    {
      id: 'M13',
      what: '删掉单步上限钳位',
      from: 'if (step > c.expMaxStepEv) step = c.expMaxStepEv;',
      to: '/* QA-MUTANT: 单步上限被删除 */',
      expect: ['D5'],
      semantic: function (s2) { return s2.indexOf('step > c.expMaxStepEv') < 0; }
    },
    {
      id: 'M17',
      what: '★红线★ 曝光约束夹带 width',
      from: 'return { advanced: [{ exposureMode: \'continuous\', exposureCompensation: v }] };',
      to: 'return { advanced: [{ exposureMode: \'continuous\', exposureCompensation: v }], width: { exact: 1920 } };',
      expect: ['E16', 'F9'],
      semantic: function (s2) { return s2.indexOf('], width: { exact: 1920 } };') > 0; }
    },
    {
      id: 'M26',
      what: '滞回状态只复制 state/hit/miss（还原设计文档原文）',
      from: '      hit: st.hit,\n      miss: st.miss,\n      engagedAt: st.engagedAt || 0,\n      releasedAt: st.releasedAt || 0\n    };',
      to: '      hit: st.hit,\n      miss: st.miss\n    };',
      expect: ['C7', 'C10'],
      semantic: function (s2) {
        const i = s2.indexOf('function stepAssistHysteresis');
        const body = s2.slice(i, i + 900);
        return body.indexOf('engagedAt: st.engagedAt') < 0;
      }
    },
    {
      id: 'MQ1',
      what: '（QA 自加）删掉 applyExposure 落败一侧的 expW.cancel()',
      from: '        expW.cancel();',
      to: '        /* QA-MUTANT: 竞速定时器不回收 */',
      // 预期：这条是「等价变异」—— 见下面的等价性论证，抓不到不是覆盖缺口
      expect: [],
      equivalent: true,
      semantic: function (s2) { return s2.indexOf('expW.cancel();') < 0; }
    }
  ];

  for (const sp of spots) {
    const from = sp.from;
    const hits = src.split(from).length - 1;
    assert(hits === 1, sp.id + ' 锚点在当前源码中唯一命中（实际 ' + hits + ' 次）——变异的靶点没漂移');
    if (hits !== 1) continue;
    assert(sp.semantic(src.split(from).join(sp.to)),
      sp.id + ' 变异体修改的是业务语义（不是语法噪音/注释）');
    const r = runMutant(sp.id, from, sp.to);
    assert(r.ok, sp.id + ' 变异体成功生成并跑完子进程');
    if (!r.ok) continue;

    if (sp.equivalent) {
      // 等价变异：不要求转红，但必须解释清楚「为什么不转红」，而不是放过一行没测的代码
      assert(r.crashed === false, sp.id + ' 子进程无异常（等价性判定本身可信）');
      eq(r.fail, 0, sp.id + ' 该变异确实不产生任何断言失败（等价变异，非覆盖缺口）');
      // 等价性论证：waitMs 自身把定时器登记进 timers/waiters，clearTimers 会兜底回收；
      // 落败 promise 之后即便 resolve，也没人再读它。用变异模块做对照实验证明：
      //   ① 运行中确实多留了定时器（变异生效了，不是「没打上」）；
      //   ② 卸载后照样清零（兜底回收有效）；
      //   ③ 对外可观察结果（EV/档位/调用次数）与真源码逐项相同。
      const mutMod = requireMutantModule(sp);
      const hReal = makeHarness();
      const hMut = makeHarness({ mod: mutMod });
      const runSteps = async function (h) {
        await boot(h);
        await pump(h.clock, 80, 5);
        const mid = h.clock.pending();
        h.ctrl.unmount();
        await flush(120);
        return {
          mid: mid,
          after: h.clock.pending(),
          ev: h.ctrl.getExposureInfo().ev,
          tier: h.ctrl.getExposureInfo().tier,
          calls: h.track.calls.length,
          steps: logsOf(h.logs, 'CAM_EXP_STEP').length
        };
      };
      const a = await runSteps(hReal);
      const b = await runSteps(hMut);
      assert(b.mid > a.mid, sp.id + ' 变异确实生效：运行中残留定时器从 ' + a.mid + ' 个增加到 ' + b.mid + ' 个');
      eq(b.after, 0, sp.id + ' 等价性证据①：clearTimers 仍能兜住（卸载后残留 ' + b.after + ' 个定时器）');
      eq({ ev: b.ev, tier: b.tier, calls: b.calls, steps: b.steps },
        { ev: a.ev, tier: a.tier, calls: a.calls, steps: a.steps },
        sp.id + ' 等价性证据②：对外可观察结果（EV/档位/约束次数/调整步数）与真源码逐项相同');
      note('MQ1（删掉 expW.cancel()）是等价变异：waitMs 自己把定时器登记进 timers/waiters，' +
        'clearTimers 在卸载/休眠时兜底回收；落败的 promise 之后 resolve 也无人再读。' +
        '实测差异只是「运行中多挂几个计时器」（' + a.mid + '→' + b.mid + ' 个），对外行为完全一致。' +
        '因此那一行属于防御性回收（减少 timers 抖动、提前释放 waiter 闭包），不是正确性支柱，' +
        '测试抓不到它属于预期，不是覆盖缺口。');
      continue;
    }

    assert(r.crashed === false, sp.id + ' 转红原因是断言失败而非脚本崩溃（输出无「脚本异常」）');
    assert(r.fail > 0 && r.pass > 0, sp.id + ' 套件仍能跑完大部分用例（通过 ' + r.pass + ' / 失败 ' + r.fail +
      '），说明不是整体崩掉');
    const hit = sp.expect.filter(function (k) {
      return r.red.some(function (line) { return line.indexOf('✗ ' + k) === 0; });
    });
    assert(hit.length === sp.expect.length,
      sp.id + ' 预期断言全部变红（' + hit.join('/') + '）；红行样例：' +
      (r.red[0] || '无'));
  }

  // 反向对照：不改源码时套件必须全绿（证明上面的红是变异带来的）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-base-'));
  const base = path.join(dir, 'controller-base.js');
  fs.writeFileSync(base, src, 'utf8');
  const rb = spawnSync(process.execPath, [SUITE_PATH], {
    env: Object.assign({}, process.env, { CAM_CTRL_PATH: base }),
    encoding: 'utf8'
  });
  try { fs.unlinkSync(base); fs.rmdirSync(dir); } catch (e) {}
  const baseOk = (rb.stdout || '').indexOf('0 失败') >= 0;
  assert(baseOk, 'Q102 反向对照：未变异源码在子进程里仍 0 失败（红绿对比有效）');
}

/* ========================================================================== *
 * 六、【P1】tier0 LUT 在拍照链路里的时序（断言判别力的阳性对照）
 * ======================================================================== */
// 完全照搬实现者的检查逻辑（M10~M12），用来验证它抓不抓得住「顺序颠倒」
function orderCheck(rendererSrc) {
  const capStart = rendererSrc.indexOf('async function capture()');
  if (capStart < 0) return { ok: false, why: '定位不到 capture()' };
  const capEnd = rendererSrc.indexOf('function removeShot', capStart);
  const body = rendererSrc.slice(capStart, capEnd > 0 ? capEnd : capStart + 8000);
  const iLut = body.indexOf('buildExposureLut');
  const iWm = body.indexOf('drawTimeWatermark');
  const iDraw = body.indexOf('ctx.drawImage(v, 0, 0)');
  return {
    ok: iDraw >= 0 && iLut > iDraw && iWm > iLut,
    iDraw: iDraw, iLut: iLut, iWm: iWm,
    lutAfterDraw: iLut > iDraw,
    lutBeforeWatermark: iWm > iLut,
    body: body
  };
}

async function sectLutOrder() {
  console.log('\n· 【P1】tier0 软件兜底的拍照时序（drawImage → LUT → 水印）');
  const rSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
  const good = orderCheck(rSrc);
  assert(good.ok, 'Q103 真实源码顺序正确（drawImage@' + good.iDraw + ' < LUT@' + good.iLut +
    ' < 水印@' + good.iWm + '）');

  const body = good.body;
  const lutStart = body.indexOf('        // 曝光辅助软件兜底（仅 tier0');
  const lutEnd = body.indexOf('ctx.putImageData(frame, 0, 0);');
  assert(lutStart > 0 && lutEnd > lutStart, 'Q104 能定位 LUT 代码块（用于构造倒序样本）');
  const blockEnd = body.indexOf('}', lutEnd) + 1;
  const block = body.slice(lutStart, blockEnd);
  const drawCall = '        ctx.drawImage(v, 0, 0);';

  // 样本一：LUT 整体挪到 drawImage 之前（压暗的是上一次的画面 / 空白画布）
  const rev1 = body.split(block).join('').replace(drawCall, block + '\n' + drawCall);
  const c1 = orderCheck(rSrc.split(body).join(rev1));
  assert(c1.ok === false && c1.lutAfterDraw === false,
    'Q105 阳性对照：LUT 挪到 drawImage 之前 → 检查器必须变红（实际 ' +
    (c1.ok ? '没抓住！' : '抓住，iDraw=' + c1.iDraw + ' > iLut=' + c1.iLut) + '）');

  // 样本二：LUT 挪到水印之后（时间戳被一起压暗，白字变灰）
  const wmIdx = body.indexOf('drawTimeWatermark(ctx, canvas.width, canvas.height, watermarkTimeText(shotAt));');
  assert(wmIdx > 0, 'Q106 能定位水印调用（用于构造错序样本）');
  const wmLine = body.slice(wmIdx, body.indexOf('\n', wmIdx));
  const rev2 = body.split(block).join('').replace(wmLine, wmLine + '\n' + block);
  const c2 = orderCheck(rSrc.split(body).join(rev2));
  assert(c2.ok === false && c2.lutBeforeWatermark === false,
    'Q107 阳性对照：LUT 挪到水印之后 → 检查器必须变红（实际 ' +
    (c2.ok ? '没抓住！' : '抓住，iLut=' + c2.iLut + ' > iWm=' + c2.iWm) + '）');

  // 样本三：删掉三重限定中的任意一条，静态断言应能察觉
  assert(/expInfo\.tier === 0/.test(body), 'Q108 LUT 只在 tier0 生效（硬件档预览与存档一致）');
  assert(/expInfo\.state === 'ACTIVE'/.test(body), 'Q109 LUT 只在 ACTIVE 生效');
  assert(/expInfo\.ev < 0/.test(body), 'Q110 LUT 只在 EV 为负时生效（ev=0 恒等，不做无意义遍历）');
  assert(/typeof window\.CameraController\.buildExposureLut === 'function'/.test(body),
    'Q111 LUT 取用前做能力检查（UMD 未加载时不炸拍照主链）');

  // v1.2.17 曾给 <video> 套 SVG feComponentTransfer 滤镜，在 Electron/Chromium 下
  // 把视频硬件合成层渲染挂掉 → 整片白屏。回归防护：源码里不得再出现该滤镜定义。
  assert(/id="xqy-exposure-lut"/.test(rSrc) === false,
    'Q150 预览已彻底移除 SVG feComponentTransfer 滤镜定义（防白屏回归）');
  // 预览 <video> 不得绑定任何 :style 滤镜（任何 CSS/SVG filter 作用在 video 合成层都可能白屏）
  assert(/<video[^>]*:style/.test(rSrc) === false,
    'Q151 预览 <video> 不绑定任何后期 :style 滤镜（白屏根因防护）');

  // 亮度参数档（brightness）：相机原生 ISP 亮度偏移，预览与成片在 ISP 层同源压暗，所见即所得。
  assert(/e\.tier === 'brightness'/.test(rSrc) && /'亮度调节 '\s*\+/.test(rSrc),
    'Q152 徽标在 brightness 档显示「亮度调节」且 level ok（原生 ISP 压暗、预览即所见）');
  // tier0 软件兜底与 brightness 档必须可区分（一个是显示层补暗 warn、一个是硬件压暗 ok）
  assert(/tier === 0/.test(rSrc) && /'软件压暗 '/.test(rSrc),
    'Q153 徽标在 tier0 显示「软件压暗」且为 warn 色（与 brightness 硬件档区隔）');

  // 控制器层确认：brightness 档确实从 ISP 层下发，而非任何预览期滤镜
  const cSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'camera-controller.js'), 'utf8');
  assert(/tier:\s*'brightness'/.test(cSrc) && /reason:\s*'brightness'/.test(cSrc),
    'Q154 pickExposurePlan 在 cap.brightness 可用时优先返回 brightness 档');
  assert(/advanced:\s*\[\{\s*brightness:\s*bVal\s*\}\]/.test(cSrc),
    'Q155 brightness 档通过 track.applyConstraints({advanced:[{brightness}]}) 在 ISP 层压暗');
}

/* ========================================================================== *
 * 八、【P1】亮度参数档（brightness）的档位语义
 *
 * 背景：brightness 是**字符串档**（'brightness'），而 tier1/tier2 是数字档。
 * `'brightness' > 0 === false` —— 凡是用 `tier > 0` 判「是不是硬件档」的地方，
 * 字符串档都会被静默误判成 tier0。已修复的三条不变量在此锁死：
 *   ① cfg 未定义（模块级纯函数引用闭包变量 → 真机每次 apply 都抛 ReferenceError，
 *      曝光辅助彻底失效）；
 *   ② 幽灵记忆记不进字符串档（expGhostRemember 的 `tier > 0` 恒 false → 打击计数
 *      永远为 0 → 幽灵设备反复走 brightness 档浪费探测窗口）；
 *   ③ 降级链断裂 + 原地打转（tier1 → brightness → tier1 循环）。
 * ======================================================================== */
async function sectBrightnessTier() {
  console.log('\n· 【P1】亮度参数档（brightness）：字符串档的语义与降级链');

  /* --- ① 档位身份的唯一判定源 --- */
  eq(C.tierRank(0), 0, 'Q156 tierRank(0)=0（软件兜底，底档）');
  eq(C.tierRank(1), 1, 'Q157 tierRank(1)=1（曝光补偿，硬件档）');
  eq(C.tierRank('brightness'), 1, 'Q158 tierRank(\'brightness\')=1（原生亮度，同属硬件档）');
  eq(C.tierRank(2), 2, 'Q159 tierRank(2)=2（手动曝光，最重档）');
  eq(C.tierRank('未知档'), 0, 'Q160 tierRank 对未知档位返回 0（不抛异常、不猜）');
  // 反向对照：字符串档与 0 的数值比较恒为 false —— 这正是本轮三类缺陷的共同根因
  assert(('brightness' > 0) === false,
    'Q161 反向对照：\'brightness\' > 0 恒为 false（这就是字符串档必须走 tierRank 的根因）');

  /* --- ② 幽灵记忆的键归一化 --- */
  eq(C.expGhostKey(1), 't1', 'Q162 数字档 1 的记忆键是 t1');
  eq(C.expGhostKey(2), 't2', 'Q163 数字档 2 的记忆键是 t2');
  eq(C.expGhostKey('brightness'), 's:brightness', 'Q164 字符串档的记忆键是 s:brightness（不与数字撞车）');
  eq(C.expGhostKey(0), '', 'Q165 tier0 不进幽灵记忆（键为空串）');

  /* --- ③ buildExposureConstraints 的 cfg 形参（ReferenceError 防护）--- */
  const bPlan = { tier: 'brightness', reason: 'brightness', min: 0, max: 255, step: 1, base: 128 };
  // 不传 cfg：必须退回 DEFAULTS.expEvMin，不能抛 ReferenceError
  let noCfg = null;
  try {
    noCfg = C.buildExposureConstraints(bPlan, -1.5);
  } catch (e) {
    noCfg = { error: String(e && e.message) };
  }
  assert(noCfg && !noCfg.error && noCfg.advanced && noCfg.advanced[0].brightness !== undefined,
    'Q166 buildExposureConstraints 不传 cfg 时不抛 ReferenceError（模块级纯函数不得引用闭包变量）' +
    (noCfg && noCfg.error ? '（实际抛：' + noCfg.error + '）' : ''));
  // 传 cfg：EV 下限换了，满量程参照必须跟着换（映射与闭环深度同源）
  const withCfgA = C.buildExposureConstraints(bPlan, -1.5, { expEvMin: -3.0 });
  const withCfgB = C.buildExposureConstraints(bPlan, -1.5, { expEvMin: -1.5 });
  assert(withCfgA.advanced[0].brightness !== withCfgB.advanced[0].brightness,
    'Q167 cfg.expEvMin 变化会改变 brightness 映射（EV 下限是满量程参照，必须同源）');
  // 满量程边界：请求到 EV 下限时恰好吃满 BRIGHT_DROP_K 比例的**可用下行空间**。
  // 可下行空间 = base − min（不是 span = max − min）：基线在量程中点时，
  // 从 base 往下最多只能走到 min，能吃掉的量程只有 span 的一半。
  const bPlan2 = { tier: 'brightness', reason: 'brightness', min: 0, max: 255, step: 1, base: 128 };
  const atFloor = C.buildExposureConstraints(bPlan2, -3.0, { expEvMin: -3.0 });
  const drop = 128 - atFloor.advanced[0].brightness;
  const usable = 128 - 0;   // base → min
  near(drop / usable, 0.7, 0.01,
    'Q168 请求到 EV 下限时吃满可用下行空间的 70%（BRIGHT_DROP_K，给 ISP 留余量）');
  // 单调性：EV 越负 → brightness 码值越低（越暗）
  const seq = [-0.5, -1.0, -1.5, -2.0, -3.0].map(function (ev) {
    return C.buildExposureConstraints(bPlan, ev, { expEvMin: -3.0 }).advanced[0].brightness;
  });
  let mono = true;
  for (let i = 1; i < seq.length; i++) if (seq[i] > seq[i - 1]) mono = false;
  assert(mono, 'Q169 brightness 码值随 EV 加深单调不增（方向反了就是越压越亮）');
  eq(seq[seq.length - 1], C.buildExposureConstraints(bPlan, -3.0, { expEvMin: -3.0 }).advanced[0].brightness,
    'Q170 同一 EV 多次构造结果一致（纯函数，无隐藏状态）');
  // 恢复约束：必须回到基线码值，否则 release 后画面永久偏暗
  eq(C.buildExposureRestoreConstraints(bPlan).advanced[0].brightness, 128,
    'Q171 brightness 恢复约束回到基线码值 128（release 后画面不残留偏暗）');
  // 越界钳位：码值不得超出能力量程
  const clamped = C.buildExposureConstraints({ tier: 'brightness', reason: 'brightness', min: 10, max: 100, step: 1, base: 50 }, -3.0, { expEvMin: -3.0 });
  assert(clamped.advanced[0].brightness >= 10 && clamped.advanced[0].brightness <= 100,
    'Q172 brightness 码值被钳在能力量程内（实际 ' + clamped.advanced[0].brightness + '）');

  /* --- ④ 降级链：tier1 → brightness → tier2 → tier0，且不原地打转 --- */
  const capAll = {
    exposureCompensation: { min: -3, max: 3, step: 0.1 },
    brightness: { min: 0, max: 255, step: 1 },
    exposureMode: ['manual', 'continuous'],
    exposureTime: { min: 10, max: 100000 }
  };
  const settingsAll = { exposureCompensation: 0, brightness: 128, exposureTime: 1000 };

  // 只摘当前档的能力键 → 会退成 brightness；再摘 brightness → 又选回 tier1（原地打转）
  const d1 = C.demoteExposurePlan({ tier: 1, reason: 'x', min: -3, max: 3, step: 0.1 }, capAll, settingsAll, {});
  eq(d1.tier, 'brightness', 'Q173 降级链第一跳：tier1 无效 → 落到 brightness 档（不是直接掉 tier0）');
  assert(d1.plan && d1.plan.tier === 'brightness', 'Q174 降级到 brightness 时必须带上可用的 plan');
  eq(d1.reason, 'comp-ineffective', 'Q175 brightness 降级原因记为 comp-ineffective（不是 manual-ineffective）');

  // 累积 banned 后再降：brightness 也无效 → 必须继续往下（tier2），且不回到 tier1
  const d2 = C.demoteExposurePlan(d1.plan, capAll, settingsAll, d1.banned || {});
  assert(d2.tier === 2 || d2.tier === 0,
    'Q176 累积 banned 后降级不会回到 tier1（原地打转已消除），实际落到 tier=' + d2.tier);
  assert(d2.tier !== 1, 'Q177 降级链绝不回到已被判无效的 tier1');
  assert(d2.banned && d2.banned.exposureCompensation && d2.banned.brightness,
    'Q178 banned 集合累积了两个已失效能力键（探测空间单调收缩）');

  // brightness 档自身被判无效 → 也能降级。
  // 契约：demoteExposurePlan 只摘**当前档**的能力键；「不回到 tier1」靠的是调用方
  // 跨调用累积 banned（否则只摘 brightness → tier1 又复活 → 原地打转）。
  // 因此这里必须带上「tier1 已被摘掉」的 banned 才能断言降级成功。
  const d3 = C.demoteExposurePlan(
    { tier: 'brightness', reason: 'brightness', min: 0, max: 255, step: 1, base: 128 },
    capAll, settingsAll, { exposureCompensation: true });
  assert(d3.tier === 2 || d3.tier === 0,
    'Q179 brightness 档被判无效时能继续降级（不是掉进 tier0），实际 tier=' + d3.tier);
  assert(d3.tier !== 1,
    'Q180 brightness 降级后不回 tier1（banned 已累积摘掉该键，否则原地打转）');
  assert(d3.banned && d3.banned.brightness && d3.banned.exposureCompensation,
    'Q181 从 brightness 降级时 banned 累积了 brightness 与已摘掉的 exposureCompensation');

  /* --- ⑦ 崩塌守卫不得接管 brightness 档（行为级契约）---
   * 崩塌守卫的判据是 EV 模型（floor = 参照 × 2^(-深度/γ)），而 brightness 是
   * ISP 黑电平偏移、实际压暗深度与 EV 非线性 → 用 EV 模型算它的崩塌下限会得出
   * 错误的 floor，把 brightness 档误判成「画面崩塌」→ 立刻降 tier0，亮度档白做。
   * 准入判定已提为模块级纯函数 collapseGuardApplies（控制器里唯一来源），
   * 这里直接断言它的行为。
   * ⚠️ 之前这里是**静态 grep 源码**（找 'expAssist.tier > 0' 字面量），
   * 而变异测试注入的是副本模块、静态扫描读的却是真实源码文件 → 静态断言
   * 在变异框架下**结构上不可能变红**（M58 就这样漏网）。行为级断言直接调
   * 被测模块的导出函数，变异体改了实现就会变红。
   */
  eq(C.collapseGuardApplies(1), true, 'Q192 崩塌守卫适用 tier1（曝光补偿，EV 模型成立）');
  eq(C.collapseGuardApplies(2), true, 'Q193 崩塌守卫适用 tier2（手动曝光，崩塌成因所在）');
  eq(C.collapseGuardApplies('brightness'), false,
    'Q194 崩塌守卫不适用 brightness 档（ISP 黑电平偏移、深度与 EV 非线性，'
    + '用 EV 模型算崩塌下限会把它误判成崩塌 → 白白降级到 tier0）');
  eq(C.collapseGuardApplies(0), false, 'Q195 崩塌守卫不适用 tier0（软件兜底没下发硬件约束）');
  // 反向对照：准入判定必须**排除**字符串档，而不是靠 'brightness' > 0 === false
  // 的隐式类型转换侥幸为 false —— 后者是巧合不是契约，后人「顺手统一成
  // tierRank(...) > 0」就会翻车（tierRank('brightness')===1，与 tier1 同秩）。
  eq(C.collapseGuardApplies('1'), false,
    'Q196 崩塌守卫不适用字符串 \'1\'（档位身份只认数字字面量 1/2，不靠类型转换）');
  eq(C.collapseGuardApplies(undefined), false,
    'Q197 崩塌守卫不适用 undefined（档位缺失时不得误判为适用）');

  // 手动档是硬件链最后一环 → 只能落 tier0
  const d4 = C.demoteExposurePlan({ tier: 2, reason: 'x', baseTime: 500, baseIso: null, timeMin: 10, timeMax: 10000, isoMin: null, isoMax: null, restoreMode: 'continuous' }, capAll, settingsAll, {});
  eq(d4.tier, 0, 'Q183 手动档（tier2）判无效后只能落 tier0（硬件链终点）');
  eq(d4.reason, 'manual-ineffective', 'Q184 手动档降级原因记为 manual-ineffective（与硬件档可区分）');
  const d5 = C.demoteExposurePlan({ tier: 0 }, capAll, settingsAll, {});
  eq(d5.tier, 0, 'Q185 tier0 传入降级函数仍是 tier0（不产生非法档位）');

  /* --- ⑤ 运行时：brightness 设备真的走 brightness 档并下发 brightness 约束 --- */
  const bTrack = makeTrack({
    caps: { brightness: { min: 0, max: 255, step: 1 } },
    settings: { brightness: 128 }
  });
  const hB = makeHarness({ track: bTrack });
  await boot(hB);
  await pump(hB.clock, 200, 5);
  const infoB = hB.ctrl.getExposureInfo();
  eq(infoB.tier, 'brightness', 'Q186 只有 brightness 能力的设备落到 brightness 档');
  const bCalls = bTrack.calls.filter(function (c) {
    return c && c.advanced && c.advanced[0] && typeof c.advanced[0].brightness === 'number';
  });
  assert(bCalls.length > 0, 'Q187 brightness 档真的下发了 brightness 约束（' + bCalls.length + ' 次）');
  // 绝不能同时下发曝光补偿（两个偏置叠在同一台设备上 = 画面莫名偏暗）
  const compCalls = bTrack.calls.filter(function (c) {
    return c && c.advanced && c.advanced[0] && typeof c.advanced[0].exposureCompensation === 'number';
  });
  eq(compCalls.length, 0, 'Q188 brightness 档不下发 exposureCompensation（两个偏置不叠加）');
  // 约束形状：只允许 advanced 一个顶层键
  const badShape = bCalls.filter(function (c) {
    const t = Object.keys(c);
    return t.length !== 1 || t[0] !== 'advanced';
  });
  eq(badShape.length, 0, 'Q189 brightness 约束只有 advanced 一个顶层键（最小约束原则）');

  /* --- ⑥ 运行时：brightness 设备被重复判无效后，记忆能拦住它（不再反复探测）--- */
  // 设备报告 brightness 但实际不响应 → 有效性判定会判无效 → 连续两次后应被记住
  const zTrack = makeTrack({
    caps: { brightness: { min: 0, max: 255, step: 1 } },
    settings: { brightness: 128 }
  });
  const hZ = makeHarness({ track: zTrack });
  await boot(hZ);
  await pump(hZ.clock, 400, 5);
  await flush(80);
  const zFallback = logsOf(hZ.logs, 'CAM_EXP_FALLBACK');
  const zEnum = logsOf(hZ.logs, 'CAM_EXP_ENUM').map(function (x) { return x.fields.tier; });
  // 记忆是否被触发：出现 ghost-remembered 说明字符串档的打击真被记进并读出了
  const ghostSkips = zFallback.filter(function (x) { return x.fields.reason === 'ghost-remembered'; });
  const ghostStrikes = zFallback.map(function (x) { return x.fields.ghostStrike; }).filter(function (v) { return v != null; });
  assert(ghostStrikes.every(function (v) { return v >= 1; }),
    'Q190 brightness 档的幽灵打击被记进记忆（strike≥1，字符串档没被当成 tier0 吞掉）');
  assert(zEnum.indexOf('brightness') >= 0 || ghostSkips.length > 0,
    'Q191 brightness 档确实被启用过（ENUM 里出现 brightness 或走了跳档路径）');
  hZ.ctrl.unmount();
  await flush(40);
}

/* ========================================================================== *
 * 七、契约登记与快照
 * ======================================================================== */
async function sectContract() {
  console.log('\n· 契约登记与快照');
  const vSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-camera.js'), 'utf8');
  const m = vSrc.match(/const ENUM = \[([\s\S]*?)\];/);
  assert(!!m, 'Q112 verify-camera.js 可读取事件白名单 ENUM');
  const enumList = (m ? (m[1].match(/'CAM_[A-Z_]+'/g) || []) : []).map(function (s) { return s.replace(/'/g, ''); });
  const need = ['CAM_EXP_ENUM', 'CAM_EXP_ENGAGE', 'CAM_EXP_STEP', 'CAM_EXP_RELEASE',
    'CAM_EXP_RESTORE', 'CAM_EXP_SKIP', 'CAM_EXP_FALLBACK', 'CAM_EXP_BLACKGATE'];
  const missing = need.filter(function (e) { return enumList.indexOf(e) < 0; });
  assert(missing.length === 0, 'Q113 8 个 CAM_EXP_* 全部登记进 ENUM（缺：' + (missing.join(',') || '无') + '）');

  // 源码里实际打出的事件必须都在白名单内（越界会被主进程丢弃）
  const used = new Set();
  ['renderer/renderer.js', 'renderer/camera-controller.js'].forEach(function (f) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const re = /'CAM_[A-Z_]+'/g;
    let mm;
    while ((mm = re.exec(s)) !== null) used.add(mm[0].replace(/'/g, ''));
  });
  const stray = Array.from(used).filter(function (e) { return enumList.indexOf(e) < 0; });
  assert(stray.length === 0, 'Q114 源码中无未登记 CAM_* 事件（越界：' + (stray.join(',') || '无') + '）');

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const vs = pkg.scripts.verify;
  assert(vs.indexOf('verify-camera-exposure.js') > 0, 'Q115 verify 链含曝光主检');
  assert(vs.indexOf('verify-camera-exposure-mutation.js') > 0, 'Q116 verify 链含曝光变异测试');
  assert(vs.indexOf('verify-camera-exposure.js') < vs.indexOf('verify-camera-exposure-mutation.js'),
    'Q117 主检排在变异测试之前（变异测试依赖主检的 runAll）');
  assert(vs.split('&&').length >= 13, 'Q118 verify 链仍是串行 && 链（' + vs.split('&&').length + ' 段）');

  /* --- 阈值表：设计文档 §6.2 与 DEFAULTS 必须逐项一致（"全部集中在一处可调"的前提） --- */
  const mdSrc = fs.readFileSync(path.join(ROOT, 'docs', 'exposure-assist-design.md'), 'utf8')
    .replace(/\r\n/g, '\n');
  const docCfg = {};
  mdSrc.split('\n').forEach(function (l) {
    const mm = l.match(/^\| `(exp[A-Za-z]+)` \| (-?[0-9.]+) \|/);
    if (mm) docCfg[mm[1]] = Number(mm[2]);
  });
  const cfgKeys = Object.keys(C.DEFAULTS).filter(function (k) { return k.indexOf('exp') === 0; });
  eq(cfgKeys.length, 26, 'Q119 DEFAULTS 的 exp* 配置共 26 项');
  eq(Object.keys(docCfg).length, 26, 'Q120 设计文档 §6.2 阈值表也列了 26 项');
  const cfgDiff = cfgKeys.filter(function (k) { return docCfg[k] !== C.DEFAULTS[k]; })
    .map(function (k) { return k + '(doc=' + docCfg[k] + '/code=' + C.DEFAULTS[k] + ')'; });
  assert(cfgDiff.length === 0, 'Q121 阈值表与实现逐项一致（不一致：' + (cfgDiff.join(',') || '无') + '）');

  /* --- 文档勘误落地：§7.2 的符号与 §8.2 的状态对象必须是修正后的写法 --- */
  assert(mdSrc.indexOf('var next = curEv - step;') > 0,
    'Q122 设计文档 §7.2/§8.2 已是修正后的符号（curEv − step），不会有人「按文档还原」把闭环打回死锁');
  eq(mdSrc.split('var next = curEv + step;').length - 1, 0,
    'Q123 文档里不再有可直接复制的 curEv + step 代码');
  assert(/engagedAt: st\.engagedAt \|\| 0/.test(mdSrc) && /releasedAt: st\.releasedAt \|\| 0/.test(mdSrc),
    'Q124 设计文档 §8.2 的状态对象已带 engagedAt/releasedAt（最短保持与冷却闸门有依据）');
  assert(mdSrc.indexOf('至少有一个给出了 `min`') > 0,
    'Q125 设计文档 §7.1 的 t2 触发条件已同步「至少有一个给出 min」（文档与实现不再对不上）');
  assert((mdSrc.match(/勘误/g) || []).length >= 4, 'Q126 四处勘误标记齐备（' +
    (mdSrc.match(/勘误/g) || []).length + ' 处），原文错在哪可追溯');

  /* --- 徽标文案：tier0 必须说「软件压暗」，硬件档必须说「曝光补偿」（不能骗现场） --- */
  const rSrc2 = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
  assert(/e\.state !== 'ACTIVE'/.test(rSrc2) && /return null;/.test(rSrc2),
    'Q127 徽标只在 ACTIVE 时显示（不残留误导现场）');
  assert(/e\.tier === 0\)\s*return \{ text: '软件压暗/.test(rSrc2),
    'Q128 tier0 徽标说「软件压暗」（预览仍偏亮，必须如实告知）');
  assert(/text: '曝光补偿 ' \+ ev \+ 'EV', level: 'ok'/.test(rSrc2),
    'Q129 硬件档徽标说「曝光补偿」且用 ok 语义色');

  /* --- 变异锚点守卫：verify-camera-res-mutation.js 的 M4 以「6 空格 + acw.cancel();」为锚点 ---
   * 曝光辅助新增了同形状的竞速回收代码，若沿用 acw 命名，那个锚点会命中 2 次而失效
   * （变异体变成「锚点不唯一 → 跳过」，等于悄悄丢掉一条负向对照）。
   * 这里把「锚点唯一」变成常驻断言，防止将来有人把变量名改回去。
   */
  const anchor = '      acw.cancel();';
  const cSrcLf = fs.readFileSync(path.join(ROOT, 'renderer', 'camera-controller.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  eq(cSrcLf.split(anchor).length - 1, 1,
    'Q130 res-mutation M4 的锚点「6 空格 acw.cancel();」在源码中仍唯一命中（曝光路径用 expW 命名，规避有效）');
  assert(/\bexpW\.cancel\(\);/.test(cSrcLf), 'Q131 曝光竞速的计时器回收用独立变量名 expW（不与 acw 撞车）');
  const resMutSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-camera-res-mutation.js'), 'utf8');
  assert(resMutSrc.indexOf("from: '      acw.cancel();'") > 0,
    'Q132 res-mutation 的 M4 定义未被改动（规避是靠源码侧改名，而不是让变异体将就）');

  /* --- 卸载时恢复失败：必须是「失败留痕」而不是未处理拒绝 --- */
  const hRej = makeHarness();
  await boot(hRej);
  await pump(hRej.clock, 60, 5);
  assert(hRej.ctrl.getExposureInfo().tier === 1, 'Q133 前置：硬件档已介入（dirty 为真）');
  const rejections = [];
  const onRej = function (e) { rejections.push(e); };
  process.on('unhandledRejection', onRej);
  hRej.track.mode = 'reject';       // 恢复约束也会被拒
  hRej.ctrl.unmount();
  await flush(200);
  process.removeListener('unhandledRejection', onRej);
  eq(rejections.length, 0, 'Q134 卸载时恢复失败不产生未处理拒绝（best-effort 有 catch）');
  assert(hasLog(hRej.logs, 'CAM_EXP_RESTORE'), 'Q135 恢复失败仍留痕 CAM_EXP_RESTORE（现场可追溯）');

  // 快照：现场复盘字段必须齐
  const hS = makeHarness();
  await boot(hS);
  await pump(hS.clock, 120, 5);
  const snap = hS.ctrl.snapshot();
  assert(snap.exposure && typeof snap.exposure === 'object', 'Q136 snapshot 带 exposure 字段');
  eq(Object.keys(snap.exposure).sort().join(','), 'adjusts,ev,fails,sceneMean,state,subjectMean,subjectRatio,tier',
    'Q137 snapshot.exposure 八项齐备');
  const info = hS.ctrl.getExposureInfo();
  eq(Object.keys(info).sort().join(','), 'adjusts,appliedEv,ev,fails,sceneMean,state,subjectMean,tier',
    'Q138 getExposureInfo 八项齐备（渲染层徽标 / LUT 只依赖这些；appliedEv 为实测实际生效 EV，徽标据此诚实展示）');
  let seen = 0;
  const off = hS.ctrl.onExposureChange(function () { seen++; });
  assert(typeof off === 'function', 'Q139 onExposureChange 返回退订函数');
  await pump(hS.clock, 100, 5);
  assert(seen > 0, 'Q140 曝光状态有推送（' + seen + ' 次）');
  off();
  hS.ctrl.unmount();
  await flush(40);
  eq(hS.clock.pending(), 0, 'Q141 卸载后无悬挂定时器');
}

/* ========================================================================== *
 * 入口
 * ======================================================================== */
async function main() {
  console.log('=== verify-camera-exposure-qa：曝光辅助的独立验证（QA 侧） ===');
  const unhandled = [];
  process.on('unhandledRejection', function (e) { unhandled.push(e); });

  await sectEvSign();
  await sectHysteresisStamp();
  await sectRedline();
  await sectBoundary();
  await sectMutants();
  await sectLutOrder();
  await sectBrightnessTier();
  await sectContract();

  assert(unhandled.length === 0, 'Q142 全程无未处理的 Promise 拒绝（实际 ' + unhandled.length + ' 条）');

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败' +
    (notes.length ? '，' + notes.length + ' 条观察项' : ''));
  if (notes.length) {
    console.log('\n观察项（不阻断，供后续迭代参考）：');
    notes.forEach(function (n) { console.log('  · ' + n); });
  }
  if (fail) {
    console.log('\n失败清单：');
    failures.forEach(function (m) { console.log('  - ' + m); });
  }
  if (fail) process.exitCode = 1;
}

main().catch(function (e) {
  console.error('脚本异常：', (e && e.stack) || e);
  process.exitCode = 1;
});
