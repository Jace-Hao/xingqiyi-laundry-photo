'use strict';
/* =============================================================================
 * verify-camera-exposure.js —— 曝光辅助（黑色衣物过曝防护）回归主检
 *
 *   node scripts/verify-camera-exposure.js
 *
 * 覆盖三部分：
 *   I.  纯函数层：网格统计 / 场景判定（A~F 六场景）/ 滞回 / EV 闭环 / 能力探测 /
 *       约束构造（红线：只带 advanced 曝光键）/ 软件兜底 LUT
 *   II. 控制器编排：假 track 录制 applyConstraints 序列、悬挂 track 竞速、
 *       黑帧门控放行与照常拒绝、对焦脉冲与页面隐藏避让、总开关、
 *       生命周期（engage→step→release→restore）、卸载后无悬挂定时
 *   III.静态契约：渲染层注入名 / 总开关 / 徽标类名 / 拍照软件兜底的时序、
 *       事件白名单（scripts/verify-camera.js ENUM）、日志字段纪律
 *
 * 只依赖 Node 内置模块与 renderer/camera-controller.js（UMD，Node 下可 require）。
 * 设计文档：docs/exposure-assist-design.md
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

// 被测模块：默认取真实源码；变异测试通过 runAll(mutantModule) 注入被改坏的副本
let C = require(process.env.CAM_CTRL_PATH || '../renderer/camera-controller.js');

let pass = 0;
let fail = 0;
let failures = [];

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
  assert(isFinite(d) && d <= (tol == null ? 1e-9 : tol), m + '（实际 ' + a + '，期望 ' + b + '±' + (tol == null ? 1e-9 : tol) + '）');
}

const ROOT = path.resolve(__dirname, '..');

/* ========================================================================== *
 * 一、虚拟时钟 + 假对象（确定性，无真实 sleep）
 * ======================================================================== */
function makeClock(start) {
  let t = start == null ? 100000 : start;
  let nextId = 1;
  const pending = new Map();
  return {
    now() { return t; },
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { at: t + (Number(ms) || 0), fn: fn });
      return id;
    },
    clearTimeout(id) { pending.delete(id); return undefined; },
    count() { return pending.size; },
    t() { return t; },
    advance(ms) {
      const target = t + ms;
      for (;;) {
        let sid = null;
        let sat = Infinity;
        pending.forEach(function (v, k) {
          if (v.at <= target && v.at < sat) { sat = v.at; sid = k; }
        });
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

// 排空微任务队列：异步链路（await 链）靠这个推进
async function flush(n) {
  const k = n == null ? 80 : n;
  for (let i = 0; i < k; i++) await Promise.resolve();
}

// 推进虚拟时钟并持续排空微任务
async function pump(clock, ms, step) {
  const st = step || 5;
  const target = clock.t() + ms;
  while (clock.t() < target) {
    clock.advance(st);
    await flush(24);
  }
  await flush(80);
}

// 在限定次数内排空 promise，返回是否已 settle
async function drain(p, n) {
  let done = false;
  let value;
  Promise.resolve(p).then(function (v) { done = true; value = v; }, function (e) { done = true; value = e; });
  for (let i = 0; i < (n || 800) && !done; i++) await Promise.resolve();
  return { done: done, value: value };
}

/* 颜色调色板（按 8×8 格铺到 64×64 像素，computeGridStats 会还原成同样的格） */
const PAL = {
  pad: [255, 230, 80],     // 亮黄垫板：luma≈220.4、sat≈0.69 → 高亮格
  grey: [150, 150, 150],   // 被 AE 提亮成灰白的黑衣物：luma=150、sat=0 → 主体格
  dark: [30, 30, 30],      // 整体昏暗店面：luma=30、sat=0
  black: [3, 3, 3],        // 镜头遮挡 / 信号黑
  white: [245, 245, 245],  // 白衣物 + 白垫板
  navy: [30, 40, 120],     // 深蓝衣物：luma≈56、sat=0.75 → 因饱和度高不算主体
  shadow: [40, 40, 40],    // 边缘阴影 / 黑色电线
  // 米色 / 浅棕垫板：luma≈162（≤185，不算高亮格）、sat≈0.46（≥0.28，不算主体格）
  // 用来构造「场景里没有亮参照」的用例（设计文档 §10 待明确事项 2 的现场风险）
  beige: [205, 150, 110]
};

/**
 * 由「格 → 颜色」函数造一张 64×64 的 ImageData 结构。
 * @param {function(number,number):number[]} pickColor (cx, cy) → [r,g,b]
 */
function makeImage(pickColor, grid, side) {
  const g = grid || C.DEFAULTS.expGridCells;
  const s = side || C.DEFAULTS.expGridSize;
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

// 六类场景（设计文档 §6.1 场景表逐行）
const SCENE = {
  // A. 黑衣物（中心） + 亮黄垫板 —— 目标场景，必须触发
  A() {
    return makeImage(function (cx, cy) {
      const inCenter = cy >= 2 && cy <= 4 && cx >= 2 && cx <= 5;
      const below = (cy === 5 || cy === 6) && cx >= 1 && cx <= 5;
      return inCenter || below ? PAL.grey : PAL.pad;
    });
  },
  // B1. 整体昏暗店面 / 黑色台垫 —— 没有亮参照，不触发
  B1() { return makeImage(function () { return PAL.dark; }); },
  // B2. 大面积暗物（占画面 87%）—— 主体面积超上限，不触发
  B2() {
    return makeImage(function (cx, cy) { return cy === 0 ? PAL.pad : PAL.shadow; });
  },
  // C. 镜头遮挡 / 信号黑 —— 归黑帧检测管，不触发
  C() { return makeImage(function () { return PAL.black; }); },
  // D. 白衣物 + 白垫板 —— AE 工作正常，主体面积太小，不触发
  D() {
    return makeImage(function (cx, cy) {
      return cy === 0 && cx < 3 ? PAL.grey : PAL.white;
    });
  },
  // E1. 画面角落的零星暗物（黑色电线 / 桌沿）—— 面积过小，不触发
  E1() {
    return makeImage(function (cx, cy) {
      return cy === 7 && cx < 3 ? PAL.shadow : PAL.pad;
    });
  },
  // E2. 暗物面积够但全在画面左侧边缘 —— 中心加权不过，不触发
  E2() {
    return makeImage(function (cx, cy) {
      return cx <= 1 && cy <= 5 ? PAL.shadow : PAL.pad;
    });
  },
  // F. 深蓝 / 深棕衣物 + 亮垫板 —— 饱和度高，过不了主体格判定，不触发
  F() {
    return makeImage(function (cx, cy) {
      const inCenter = cy >= 2 && cy <= 4 && cx >= 2 && cx <= 5;
      const below = cy === 5 && cx >= 2 && cx <= 5;
      return inCenter || below ? PAL.navy : PAL.pad;
    });
  },
  // G. 只有米色垫板（不够亮）+ 被提亮的黑衣物 —— 没有亮参照就没有对照物，
  //    无法区分「AE 把黑衣物提亮了」与「场景本来就偏暗」，必须不触发
  G() {
    return makeImage(function (cx, cy) {
      const inCenter = cy >= 2 && cy <= 4 && cx >= 2 && cx <= 5;
      return inCenter ? PAL.grey : PAL.beige;
    });
  }
};

/* ---------- 假 track / 假流 / 假 video ---------- */
function makeExpTrack(opts) {
  const o = opts || {};
  const t = {
    readyState: 'live',
    muted: false,
    _h: {},
    caps: o.caps !== undefined ? o.caps : { exposureCompensation: { min: -3, max: 3, step: 0.1 } },
    settings: o.settings || { exposureCompensation: 0 },
    calls: [],
    hang: !!o.hang,
    reject: !!o.reject,
    capsThrows: !!o.capsThrows,
    addEventListener(k, f) { (this._h[k] = this._h[k] || []).push(f); },
    removeEventListener(k, f) { const a = this._h[k] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); },
    stop() { this.readyState = 'ended'; },
    getCapabilities() {
      if (this.capsThrows) throw new Error('caps-boom');
      return this.caps;
    },
    getSettings() { return this.settings; },
    applyConstraints(cst) {
      this.calls.push(cst);
      if (this.hang) return new Promise(function () {});
      if (this.reject) return Promise.reject(new Error('apply-reject'));
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

const CFG = {
  openTimeoutMs: 200,
  frameWaitMs: 100,
  framePollMs: 5,
  degradedWatchMs: 60,
  attachTimeoutMs: 100,
  backoffMs: [10, 10, 10, 10],
  maxAttempts: 5,
  // 曝光辅助：把秒级参数压到毫秒级，行为不变
  expEngageDelayMs: 10,
  expCycleMs: 10,
  expEngageHits: 3,
  expReleaseMisses: 4,
  expMinHoldMs: 20,
  expReEngageCooldownMs: 30,
  expStepGapMs: 20,
  expSettleMs: 10,
  expApplyTimeoutMs: 40,
  expApplyFailLimit: 2
};

/**
 * 造一套完整的假环境（控制器 + 虚拟时钟 + 可变场景）。
 * scene / gray / visible / focus / assistOn 都是可变对象，测试用 h.setXxx() 切换。
 */
function makeHarness(over) {
  const o = over || {};
  const clock = o.clock || makeClock(100000);
  const logs = [];
  // track 放在一个可变盒子里：QA DEF-4 的「换摄像头」用例需要把流里挂的 track
  // 换成**另一个对象**（同一对象换图不算换设备，任何身份方案都区分不了）
  const trackBox = { cur: o.track || makeExpTrack(o.trackOpts) };
  const track = trackBox.cur;
  const stream = {
    getTracks: function () { return [trackBox.cur]; },
    getVideoTracks: function () { return [trackBox.cur]; }
  };
  const video = o.video || makeVideo();
  const state = {
    image: o.image !== undefined ? o.image : SCENE.A(),
    gray: o.gray !== undefined ? o.gray : new Array(64 * 64).fill(140),
    visible: o.visible !== false,
    focus: o.focus === true,
    assistOn: o.assistOn !== false
  };
  const md = {
    calls: 0,
    getUserMedia() { this.calls += 1; return Promise.resolve(stream); },
    enumerateDevices() { return Promise.resolve([]); },
    addEventListener() {},
    removeEventListener() {}
  };
  const ctrl = C.createCameraController({
    mediaDevices: md,
    videoGetter: function () { return video; },
    now: function () { return clock.now(); },
    setTimeout: function (fn, ms) { return clock.setTimeout(fn, ms); },
    clearTimeout: function (id) { return clock.clearTimeout(id); },
    log: function (l, e, f) { logs.push({ level: l, event: e, fields: f || {} }); },
    frameSampler: function () { return state.gray; },
    // image 允许是函数：幽灵能力 / 正常设备的对照实验需要「画面亮度随已下发补偿变化」，
    // 静态图只能造出幽灵设备那一半场景
    gridSampler: function () { return typeof state.image === 'function' ? state.image() : state.image; },
    pageVisible: function () { return state.visible; },
    focusBusy: function () { return state.focus; },
    exposureAssistEnabled: function () { return state.assistOn; },
    config: Object.assign({}, CFG, o.config || {})
  });
  return {
    clock: clock,
    logs: logs,
    track: track,
    stream: stream,
    video: video,
    md: md,
    ctrl: ctrl,
    scene: state,
    // 换摄像头：把流里挂的 track 换成另一个对象（activeTrack() 每次现读，故立即生效）
    setTrack(t) { trackBox.cur = t; },
    curTrack() { return trackBox.cur; },
    setImage(img) { state.image = img; },
    setGray(arr) { state.gray = arr; },
    setVisible(v) { state.visible = !!v; },
    setFocus(v) { state.focus = !!v; },
    setAssist(v) { state.assistOn = !!v; }
  };
}

// 出画（LIVE）；gUM 与 play 都是微任务级，靠 drain 推进
async function boot(h) {
  const r = await drain(h.ctrl.mount(function () { return h.video; }));
  await flush(40);
  return r;
}

const eventsOf = (logs, name) => logs.filter(function (x) { return x.event === name; });
const hasEvent = (logs, name) => eventsOf(logs, name).length > 0;
const reasonsOf = (logs, name) => eventsOf(logs, name).map(function (x) { return x.fields.reason; });

// 曝光红线：约束里绝不能出现分辨率/帧率键
const RES_KEYS = ['width', 'height', 'frameRate', 'aspectRatio'];
function redlineViolations(cst) {
  const bad = [];
  (function walk(node, p) {
    if (!node || typeof node !== 'object') return;
    Object.keys(node).forEach(function (k) {
      if (RES_KEYS.indexOf(k) >= 0) bad.push(p + '.' + k);
      walk(node[k], p + '.' + k);
    });
  })(cst, 'cst');
  return bad;
}

/* ========================================================================== *
 * 二、用例主体
 * ======================================================================== */
async function suite() {
  /* ---------------------------------------------------------------- *
   * A. computeGridStats：网格统计
   * ---------------------------------------------------------------- */
  console.log('\n· A 网格统计（computeGridStats）');
  {
    assert(C.computeGridStats(null, 8) === null, 'A1 无图像数据返回 null');
    assert(C.computeGridStats({ width: 0, height: 0, data: null }, 8) === null, 'A2 空尺寸返回 null');

    // 4×4 图、2×2 格 → 每格 2×2 像素
    const w = 4;
    const data = new Uint8ClampedArray(w * w * 4);
    const put = function (x, y, r, g, b) {
      const i = (y * w + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    };
    // 左上格全白（luma 255 > 250 → clip=1）；其余全灰 100（sat=0）
    put(0, 0, 255, 255, 255); put(1, 0, 255, 255, 255);
    put(0, 1, 255, 255, 255); put(1, 1, 255, 255, 255);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) if (!(x < 2 && y < 2)) put(x, y, 100, 100, 100);
    const cells = C.computeGridStats({ width: w, height: w, data: data }, 2);
    assert(cells && cells.length === 4, 'A3 2×2 网格产出 4 格（实际 ' + (cells && cells.length) + '）');
    near(cells[0].mean, 255, 1e-9, 'A4 左上格 mean=255');
    near(cells[0].clip, 1, 1e-9, 'A5 左上格 clip 比例=1（luma>250 的像素占比）');
    near(cells[1].mean, 100, 1e-9, 'A6 右上格 mean=100');
    near(cells[1].sat, 0, 1e-9, 'A7 纯灰像素 sat=0');

    // 饱和度与除零：纯黑像素 sat 定义为 0（max=0 不做除法）
    const blackImg = makeImage(function () { return PAL.black; });
    const bc = C.computeGridStats(blackImg, 8);
    near(bc[0].sat, 0, 1e-9, 'A8 纯黑像素 sat=0（避免除零）');
    near(bc[0].mean, 3, 1e-9, 'A9 纯黑像素 mean=3');

    // 亮黄垫板：高饱和 + 高亮度
    const padImg = makeImage(function () { return PAL.pad; });
    const pc = C.computeGridStats(padImg, 8);
    near(pc[0].mean, 220.375, 1e-6, 'A10 亮黄垫板 mean≈220.4（Rec.601 灰度）');
    near(pc[0].sat, 175 / 255, 1e-6, 'A11 亮黄垫板 sat≈0.686（(max-min)/max）');
    assert(C.computeGridStats(padImg, 8).length === 64, 'A12 默认 8×8=64 格');
  }

  /* ---------------------------------------------------------------- *
   * B. classifyExposureGrid：六场景判定（四道闸门）
   * ---------------------------------------------------------------- */
  console.log('\n· B 场景判定（classifyExposureGrid，设计文档 §6.1 场景表）');
  {
    const classify = function (img) {
      return C.classifyExposureGrid(C.computeGridStats(img, 8), C.DEFAULTS);
    };

    const a = classify(SCENE.A());
    assert(a.hit === true && a.reason === 'black-garment', 'B1 场景A 黑衣物+亮垫板 → 触发（' + a.reason + '）');
    assert(a.subjectRatio >= 0.08 && a.subjectRatio <= 0.75, 'B2 场景A 主体占比在闸门内（' + a.subjectRatio.toFixed(3) + '）');
    assert(a.hiRatio >= 0.06, 'B3 场景A 有亮参照（hiRatio=' + a.hiRatio.toFixed(3) + '）');
    assert(a.centerSubjectRatio >= 0.15, 'B4 场景A 暗质量在中央（' + a.centerSubjectRatio.toFixed(3) + '）');
    near(a.subjectMean, 150, 1e-6, 'B5 场景A 被控量 subjectMean=150（EV 闭环输入）');

    const b1 = classify(SCENE.B1());
    assert(b1.hit === false && b1.reason === 'overall-dark-or-blocked', 'B6 场景B1 昏暗店面/黑台垫 → 不触发（' + b1.reason + '）');
    assert(b1.sceneMean < C.DEFAULTS.expSceneMeanMin, 'B7 场景B1 被场景均值下限挡住');

    const b2 = classify(SCENE.B2());
    assert(b2.hit === false && b2.reason === 'subject-too-large', 'B8 场景B2 暗物占 87% → 不触发（' + b2.reason + '）');

    const c = classify(SCENE.C());
    assert(c.hit === false && c.reason === 'overall-dark-or-blocked', 'B9 场景C 镜头遮挡/信号黑 → 不触发（' + c.reason + '）');

    const d = classify(SCENE.D());
    assert(d.hit === false && d.reason === 'subject-too-small', 'B10 场景D 白衣物+白垫板 → 不触发（' + d.reason + '）');

    const e1 = classify(SCENE.E1());
    assert(e1.hit === false && e1.reason === 'subject-too-small', 'B11 场景E1 角落零星暗物 → 不触发（' + e1.reason + '）');

    const e2 = classify(SCENE.E2());
    assert(e2.hit === false && e2.reason === 'subject-off-center', 'B12 场景E2 暗物全在左侧边缘 → 中心加权不过（' + e2.reason + '）');
    assert(e2.subjectRatio >= 0.08, 'B13 场景E2 主体面积本身是够的（证明挡住它的是中心加权）');
    assert(e2.centerSubjectRatio < 0.15, 'B14 场景E2 中心主体占比不足（' + e2.centerSubjectRatio.toFixed(3) + '）');

    const f = classify(SCENE.F());
    assert(f.hit === false && f.reason === 'subject-too-small', 'B15 场景F 深蓝衣物（高饱和）→ 不触发（' + f.reason + '）');

    // 场景G：唯一挡住触发的是「高亮参照面积下限」这道闸门
    const g = classify(SCENE.G());
    assert(g.hit === false && g.reason === 'no-bright-reference', 'B19 场景G 米色垫板不够亮（无亮参照）→ 不触发（' + g.reason + '）');
    assert(g.sceneMean >= C.DEFAULTS.expSceneMeanMin && g.subjectRatio >= C.DEFAULTS.expSubjectAreaMin &&
      g.centerSubjectRatio >= C.DEFAULTS.expCenterSubjectMin,
      'B20 场景G 已过其余三道闸门（证明挡住它的确实是亮参照下限）');

    // 空网格
    const empty = C.classifyExposureGrid([], C.DEFAULTS);
    assert(empty.hit === false && empty.reason === 'no-cells', 'B16 空网格不误触发（' + empty.reason + '）');
    assert(empty.sceneMean === null, 'B17 空网格 sceneMean 为 null（不撒谎成 0）');

    // 部分阈值传入时其余回落到 DEFAULTS
    const onlyTh = C.classifyExposureGrid(C.computeGridStats(SCENE.A(), 8), { expSceneMeanMin: 45 });
    assert(onlyTh.hit === true, 'B18 只覆盖一项阈值时其余回落到 DEFAULTS（仍能命中）');
  }

  /* ---------------------------------------------------------------- *
   * C. stepAssistHysteresis：防抖
   * ---------------------------------------------------------------- */
  console.log('\n· C 滞回状态机（stepAssistHysteresis）');
  {
    const st0 = { state: 'IDLE', hit: 0, miss: 0, engagedAt: 0, releasedAt: 0 };
    let st = st0;
    let r = C.stepAssistHysteresis(st, true, 100000, C.DEFAULTS);
    assert(r.action === null && r.st.state === 'IDLE' && r.st.hit === 1, 'C1 第 1 帧命中不立即 engage（hit=1）');
    st = r.st;
    r = C.stepAssistHysteresis(st, true, 100100, C.DEFAULTS);
    assert(r.action === null && r.st.hit === 2, 'C2 第 2 帧命中仍不 engage（hit=2）');
    st = r.st;
    r = C.stepAssistHysteresis(st, true, 100200, C.DEFAULTS);
    assert(r.action === 'engage' && r.st.state === 'ACTIVE', 'C3 连续 3 帧命中 → engage');
    assert(r.st.engagedAt === 100200, 'C4 engage 时记下 engagedAt');

    // release：连续 expReleaseMisses(10) 帧未命中 + 最短保持
    st = r.st;
    let rel = null;
    for (let i = 1; i <= 10; i++) {
      r = C.stepAssistHysteresis(st, false, 100200 + i * 200, C.DEFAULTS);
      st = r.st;
      if (r.action === 'release' && rel === null) rel = { at: i, st: r.st };
    }
    assert(rel !== null, 'C5 连续未命中最终 release');
    assert(rel && rel.at === 10, 'C6 release 门槛 = expReleaseMisses(10)（实际第 ' + (rel && rel.at) + ' 帧）');

    // 最短保持：engagedAt 之后不足 expMinHoldMs 不得 release
    let s2 = { state: 'ACTIVE', hit: 0, miss: 0, engagedAt: 100000, releasedAt: 0 };
    let early = null;
    for (let i = 1; i <= 10; i++) {
      const rr = C.stepAssistHysteresis(s2, false, 100000 + i * 100, C.DEFAULTS);
      s2 = rr.st;
      if (rr.action === 'release') early = { at: i, t: 100000 + i * 100 };
    }
    assert(early === null, 'C7 未满 expMinHoldMs(1500) 前连续 10 帧未命中也不 release');
    const held = C.stepAssistHysteresis(s2, false, 101600, C.DEFAULTS);
    assert(held.action === 'release', 'C8 满 expMinHoldMs 后立即 release');

    // 冷却：release 后 expReEngageCooldownMs 内不得再 engage
    let s3 = held.st;
    assert(s3.state === 'IDLE' && s3.releasedAt === 101600, 'C9 release 时记下 releasedAt');
    let regaged = null;
    for (let i = 1; i <= 3; i++) {
      const rr = C.stepAssistHysteresis(s3, true, 101600 + i * 100, C.DEFAULTS);
      s3 = rr.st;
      if (rr.action === 'engage') regaged = 101600 + i * 100;
    }
    assert(regaged === null, 'C10 release 后冷却期内即使连续命中也不 engage');
    const after = C.stepAssistHysteresis(s3, true, 101600 + C.DEFAULTS.expReEngageCooldownMs, C.DEFAULTS);
    assert(after.action === 'engage', 'C11 冷却期满后重新 engage');

    // 命中/未命中的计数互斥（hit 清零 miss，反之亦然）
    const mix = C.stepAssistHysteresis({ state: 'IDLE', hit: 2, miss: 0, engagedAt: 0, releasedAt: 0 }, false, 200000, C.DEFAULTS);
    assert(mix.st.hit === 0 && mix.st.miss === 1, 'C12 未命中时命中计数清零（半出画不会攒出假命中）');
  }

  /* ---------------------------------------------------------------- *
   * D. nextEvStep：EV 闭环
   * ---------------------------------------------------------------- */
  console.log('\n· D EV 闭环步长（nextEvStep）');
  {
    const D = C.DEFAULTS;
    const dead = C.nextEvStep(-0.5, D.expTargetMean + D.expDeadzone - 1, D);
    assert(dead.step === 0 && dead.ev === -0.5, 'D1 死区内不动（步长 0、ev 不变）');

    const dark = C.nextEvStep(0, D.expTargetMean, D);
    assert(dark.step === 0, 'D2 误差为 0 时不动');

    const bright = C.nextEvStep(0, 150, D);
    assert(bright.step < 0 && bright.ev < 0, 'D3 过亮 → EV 往负方向走（ev=' + bright.ev.toFixed(3) + '）');
    near(bright.err, 150 - D.expTargetMean, 1e-9, 'D4 err = subjectMean - expTargetMean');

    const cap = C.nextEvStep(0, 255, D);
    near(Math.abs(cap.step), D.expMaxStepEv, 1e-9, 'D5 单步上限 expMaxStepEv=0.34（防画面跳变）');

    // 从「差一步就到底」的位置起算：单步上限 0.34，起点取下限 +0.1 才会真的撞到下限
    const floor = C.nextEvStep(D.expEvMin + 0.1, 150, D);
    near(floor.ev, D.expEvMin, 1e-9, 'D6 累计下限钳到 expEvMin=' + D.expEvMin);
    const atFloor = C.nextEvStep(D.expEvMin, 150, D);
    assert(atFloor.step === 0 && atFloor.ev === D.expEvMin, 'D7 已在下限时不再下发（step=0，避免空转 applyConstraints）');

    const tooDark = C.nextEvStep(-1.0, 20, D);
    assert(tooDark.ev > -1.0, 'D8 比目标更暗时回调减小补偿（闭环自愈）');
    assert(tooDark.ev <= 0, 'D9 EV 上限锁 0（欠曝交给 AE，不做正补偿）');

    const nul = C.nextEvStep(-0.3, null, D);
    assert(nul.step === 0 && nul.ev === -0.3, 'D10 无主体亮度时不动（采样失败不瞎调）');

    // 单调收敛：静态场景下逐步逼近，不振荡
    let ev = 0;
    const seq = [];
    for (let i = 0; i < 20; i++) {
      const rr = C.nextEvStep(ev, 150, D);
      if (rr.step === 0) break;
      ev = rr.ev;
      seq.push(ev);
    }
    const mono = seq.every(function (v, i) { return i === 0 || v <= seq[i - 1] + 1e-12; });
    assert(mono && seq.length >= 4, 'D11 静态过亮场景下 EV 单调下行（' + seq.length + ' 步收敛到 ' + ev.toFixed(2) + '）');
    assert(ev >= D.expEvMin - 1e-12, 'D12 收敛过程始终不越过下限');

    /* --- 下限加深（设计文档 §10 待明确事项 6 的现场结论） --- */
    assert(D.expEvMin === -3.0, 'D13 EV 累计下限已加深到 -3.0（现场：0→-2.0 全程不收敛）');
    // 真实响应设备（亮度 = 150×2^(ev/2.2)，sRGB 编码）在 -2.0 下够不到目标：
    // 贴住下限空转正是现场形态；加深到 -3.0 后闭环才有机会真正收敛
    const modelAt = (evv) => 150 * Math.pow(2, evv / 2.2);
    const runLoop = function (minEv) {
      let e = 0;
      let last = null;
      for (let i = 0; i < 40; i++) {
        const rr = C.nextEvStep(e, modelAt(e), Object.assign({}, D, { expEvMin: minEv }));
        last = rr;
        if (rr.step === 0) break;
        e = rr.ev;
      }
      return { ev: e, err: last ? last.err : null };
    };
    const atOld = runLoop(-2.0);
    const atNew = runLoop(-3.0);
    assert(Math.abs(atOld.err) > D.expDeadzone,
      'D14 旧下限 -2.0 下闭环贴住下限仍不达标（err=' + atOld.err.toFixed(1) + ' > 死区 ' + D.expDeadzone + '）');
    assert(Math.abs(atNew.err) < D.expDeadzone,
      'D15 新下限 -3.0 下闭环真的收敛（err=' + atNew.err.toFixed(1) + ' 落入死区，ev=' + atNew.ev.toFixed(2) + '）');
    assert(atNew.ev < -2.0, 'D16 收敛点确实落在旧下限之外（' + atNew.ev.toFixed(2) + ' < -2.0，证明加深是必要的）');
  }

  /* ---------------------------------------------------------------- *
   * E. pickExposurePlan + 约束构造（含分辨率红线）
   * ---------------------------------------------------------------- */
  console.log('\n· E 能力探测与约束构造（§7.1 / §7.3）');
  {
    const p1 = C.pickExposurePlan({ exposureCompensation: { min: -3, max: 3, step: 0.1 } }, {});
    assert(p1.tier === 1 && p1.reason === 'exposure-compensation', 'E1 exposureCompensation 可用 → tier1 硬件偏置');
    assert(p1.min === -3 && p1.max === 3 && p1.step === 0.1, 'E2 tier1 带上设备区间与步长');

    const p2 = C.pickExposurePlan({ exposureMode: ['continuous', 'manual'], exposureTime: { min: 10, max: 10000 } }, { exposureTime: 500 });
    assert(p2.tier === 2 && p2.reason === 'manual-exposure', 'E3 支持 manual + exposureTime → tier2 硬件手动');
    assert(p2.restoreMode === 'continuous', 'E4 tier2 能切回 continuous 时 restoreMode=continuous');
    assert(p2.baseTime === 500 && p2.timeMin === 10 && p2.timeMax === 10000, 'E5 tier2 记下基线与区间');

    const p2b = C.pickExposurePlan({ exposureMode: ['manual'], iso: { min: 100, max: 3200 } }, { iso: 400 });
    assert(p2b.tier === 2 && p2b.restoreMode === 'manual-baseline', 'E6 无 continuous 时 restoreMode=manual-baseline（释放要还原基线）');

    assert(C.pickExposurePlan(null, null).tier === 0, 'E7 无能力对象 → tier0 软件兜底');
    assert(C.pickExposurePlan({}, {}).tier === 0, 'E8 空能力对象 → tier0');
    assert(C.pickExposurePlan({ exposureMode: ['continuous'] }, {}).tier === 0, 'E9 只有连续档、无补偿无手动 → tier0');

    // tier1 优先级高于 tier2
    const both = C.pickExposurePlan({
      exposureCompensation: { min: -2, max: 2, step: 0.5 },
      exposureMode: ['manual'], exposureTime: { min: 1, max: 100 }
    }, {});
    assert(both.tier === 1, 'E10 两条路都可用时优先 tier1（保留 AE 自适应，语义最干净）');

    // 约束构造：tier1 按步长取整 + 区间钳位
    // 统一用 advOf() 取值：能力探测被变异破坏时约束会是 null，
    // 直接取 [0] 会抛异常中断整个套件，掩盖真正的红断言
    const advOf = function (cst) { return (cst && cst.advanced && cst.advanced[0]) || {}; };
    const c1 = C.buildExposureConstraints(p1, -1.24);
    assert(c1 && c1.advanced && c1.advanced.length === 1, 'E11 tier1 约束结构 = { advanced: [ ... ] }');
    assert(advOf(c1).exposureMode === 'continuous', 'E12 tier1 保留连续 AE 模式');
    near(advOf(c1).exposureCompensation, -1.2, 1e-9, 'E13 tier1 按设备步长 0.1 取整');
    const c1min = C.buildExposureConstraints(p1, -99);
    near(advOf(c1min).exposureCompensation, -3, 1e-9, 'E14 tier1 钳到设备下限');
    const c1max = C.buildExposureConstraints(p1, 99);
    near(advOf(c1max).exposureCompensation, 3, 1e-9, 'E15 tier1 钳到设备上限');

    // 红线：任何档位的约束都不得夹带分辨率/帧率键
    const allCst = [
      C.buildExposureConstraints(p1, -1.2),
      C.buildExposureConstraints(p2, -1.2),
      C.buildExposureConstraints(p2b, -1.2),
      C.buildExposureRestoreConstraints(p1),
      C.buildExposureRestoreConstraints(p2),
      C.buildExposureRestoreConstraints(p2b)
    ];
    const bad = [];
    allCst.forEach(function (cst, i) {
      redlineViolations(cst).forEach(function (v) { bad.push('#' + i + v); });
    });
    assert(bad.length === 0, 'E16 红线：所有曝光约束都不含 width/height/frameRate（' + (bad.join(',') || '无违规') + '）');

    // tier2：优先压曝光时间，且负 EV 让时间变短
    const c2 = C.buildExposureConstraints(p2, -1);
    near(advOf(c2).exposureTime, 250, 1e-9, 'E17 tier2 EV=-1 → 曝光时间 ×2^-1 = 250µs');
    assert(advOf(c2).iso === undefined, 'E18 tier2 有曝光时间时不动 iso（升 iso 只加噪点）');
    const c2clamp = C.buildExposureConstraints(p2, -12);
    near(advOf(c2clamp).exposureTime, 10, 1e-9, 'E19 tier2 曝光时间钳到 timeMin');
    const c2iso = C.buildExposureConstraints(p2b, -1);
    assert(advOf(c2iso).exposureTime === undefined && advOf(c2iso).iso > 0, 'E20 只有 iso 能力的设备才退而调 iso');

    // 恢复约束：最小约束原则
    const r1 = C.buildExposureRestoreConstraints(p1);
    eq(r1, { advanced: [{ exposureCompensation: 0 }] }, 'E21 tier1 恢复 = 补偿归零');
    const r2 = C.buildExposureRestoreConstraints(p2);
    eq(r2, { advanced: [{ exposureMode: 'continuous' }] }, 'E22 tier2 恢复 = 切回 continuous');
    assert(C.buildExposureRestoreConstraints({ tier: 0 }) === null, 'E23 tier0 无恢复约束（本来就没改过设备）');

    // LUT：与 §7.5 判定同源的 sRGB 模型压暗（out = in × 2^(ev/gamma)）
    const lut = C.buildExposureLut(-1);
    assert(lut.length === 256, 'E24 LUT 长度 256');
    assert(lut[0] === 0 && lut[255] < 255 && lut[255] === Math.round(255 * Math.pow(2, -1 / C.SRGB_GAMMA)),
      'E25 LUT 黑点保持 0→0，且白点一起压暗（ev=-1：255 → ' + lut[255] +
      '，不再锁 255 —— 锁 255 就是「白色鞋底一点没救」）');
    near(lut[128], Math.round(128 * Math.pow(2, -1 / C.SRGB_GAMMA)), 0,
      'E26 ev=-1 → 中间调 128 × 2^(-1/2.2) = ' + lut[128] + '（与 §7.5 判定同源）');
    assert(lut[64] === Math.round(64 * Math.pow(2, -1 / C.SRGB_GAMMA)) && lut[64] > 0,
      'E27 暗部按比例压暗且不死黑（保住褶皱纹理：64 → ' + lut[64] + '）');
    let mono = true;
    for (let i = 1; i < 256; i++) if (lut[i] < lut[i - 1]) mono = false;
    assert(mono, 'E28 LUT 单调不减');
    const lut2 = C.buildExposureLut(-2);
    assert(lut2[128] < lut[128], 'E29 补偿越深压得越狠');
    const lut0 = C.buildExposureLut(0);
    assert(lut0[0] === 0 && lut0[128] === 128 && lut0[255] === 255, 'E30 ev=0 → 恒等 LUT（不改变画面）');
    const lutPos = C.buildExposureLut(0.5);
    assert(lutPos[128] === 128, 'E31 正 EV 也退化为恒等（本方案不做提亮）');

    /* --- 【QA DEF-1】LUT 的「压暗量 vs EV」语义校验 ---
     * 旧实现只有单调性/端点断言，于是「码值域幂次曲线」这种与 EV 定义完全脱钩的实现
     * 也能全绿。下面 5 条把 LUT 与 §7.5 的判定模型绑死：LUT 造成的降幅必须
     * 等于 expectedDropRatio(ev)，否则「判定说该降 27%」与「兜底实际压掉 96%」
     * 会同时成立（现场后果：黑衣物被压成近全黑、白色鞋底永远救不回来）。
     */
    const G = C.SRGB_GAMMA;
    const lutSem = (ev) => C.buildExposureLut(ev);
    // ① 逐点语义：LUT 的降幅 == §7.5 判定的预期降幅（误差只来自取整，≤1 码值）
    let semBad = 0;
    [-0.5, -1, -2, -3].forEach(function (ev) {
      const L = lutSem(ev);
      const expDrop = C.expectedDropRatio(ev, G);
      [40, 80, 128, 180, 220].forEach(function (v) {
        const drop = (v - L[v]) / v;
        if (Math.abs(drop - expDrop) * v > 1.0) semBad++;
      });
    });
    eq(semBad, 0, 'E46 LUT 降幅与 §7.5 预期降幅逐点一致（差异仅来自取整，越界 ' + semBad + ' 处）');

    // ② 现场取值：ev=-3（tier0 顶到 expEvMin 的真实取值）必须把主体压到目标附近
    const lut3 = lutSem(-3);
    near(lut3[150], C.DEFAULTS.expTargetMean, 1, 'E47 ev=-3：黑衣物主体 150 → ' + lut3[150] +
      '（正合 expTargetMean=' + C.DEFAULTS.expTargetMean + '，旧实现是 4）');
    // ③ 被裁剪的白色必须救得回来（现场投诉的那一项：白色鞋底完全过曝裁剪）
    assert(lut3[255] < 255 && lut3[255] > 30,
      'E48 被裁剪的白色 255 → ' + lut3[255] + '（拉回可辨范围，旧实现是 255 = 一点没压）');
    // ④ 暗部层次：等比压暗，褶皱不被抹成 0
    const shadows = [20, 30, 45, 60].map(function (v) { return lut3[v]; });
    assert(shadows.every(function (x) { return x > 0; }),
      'E49 ev=-3：褶皱暗部 20/30/45/60 → ' + shadows.join('/') + '（全 >0，旧实现全为 0）');
    const ratioKept = shadows.every(function (x, i) {
      return Math.abs(x / [20, 30, 45, 60][i] - Math.pow(2, -3 / G)) < 0.06;
    });
    assert(ratioKept, 'E50 暗部是等比例压暗（相对关系保留 = 层次保留，不是幂次压死）');

    /* --- 【QA DEF-2】tier0 的 EV 解析解 --- */
    const solve = (mean) => C.solveTier0Ev(mean, C.DEFAULTS);
    near(solve(100), G * Math.log2(C.DEFAULTS.expTargetMean / 100), 1e-9,
      'E51 tier0 解析解：主体 100 → ev=' + solve(100).toFixed(2) + '（闭环会一路撞到 -3.00 过压 1.27 档）');
    assert(solve(100) > C.DEFAULTS.expEvMin, 'E52 主体 100 的解在下限之内（不会被 expEvMin 截断）');
    near(solve(150), C.DEFAULTS.expEvMin, 0.02,
      'E53 主体 150 → ev≈' + solve(150).toFixed(2) + '（贴下限，即 -3.0 这个下限值正是照 150→58 定的）');
    assert(solve(C.DEFAULTS.expTargetMean) === 0, 'E54 已在目标亮度 → ev=0（不做无谓压暗）');
    assert(solve(20) === 0, 'E55 比目标更暗 → 不提亮（欠曝交给现场补光，与上限锁 0 一致）');
    assert(solve(null) === null && solve(0) === null, 'E56 无主体亮度时返回 null（采样失败不瞎算）');
    // 解析解与 LUT 必须自洽：套用解析解出的 ev，主体应落到目标亮度
    [100, 130, 150].forEach(function (m) {
      const evv = solve(m);
      near(C.buildExposureLut(evv)[m], C.DEFAULTS.expTargetMean, 6,
        'E57 解析解自洽：主体 ' + m + ' 经 ev=' + evv.toFixed(2) + ' 压暗后落在目标附近');
    });

    /* --- 收尾修复项的正向断言（QA 严过关复核提出） --- */
    // 1) 设备把 step 报成 Infinity：绝不能让 NaN 进约束
    const pInf = C.pickExposurePlan({ exposureCompensation: { min: -3, max: 3, step: Infinity } }, {});
    assert(pInf.tier === 1, 'E32 step=Infinity 的设备仍判 tier1（能力可用就别降级）');
    const cInf = C.buildExposureConstraints(pInf, -1.24);
    const vInf = advOf(cInf).exposureCompensation;
    assert(typeof vInf === 'number' && isFinite(vInf), 'E33 step=Infinity 时补偿值是有限数（不是 NaN/Infinity）');
    near(vInf, -1.24, 1e-9, 'E34 step=Infinity 时不做取整、原样透传 ev');
    eq(cInf, { advanced: [{ exposureMode: 'continuous', exposureCompensation: -1.24 }] },
      'E35 step=Infinity 的约束结构仍只含 advanced 曝光键');

    // 2) tier2 能力残缺（只有 exposureTime.max，无 min，也无 iso）→ 必须降级 tier0，
    //    否则会切了 manual 却发不出曝光值：画面不压暗、徽标却说「曝光补偿 xEV」
    const pWeak = C.pickExposurePlan({ exposureMode: ['manual', 'continuous'], exposureTime: { max: 10000 } }, { exposureTime: 500 });
    assert(pWeak.tier === 0, 'E36 只报 exposureTime.max（无 min）且无 iso → tier0（不许假装能调）');
    assert(pWeak.reason === 'manual-without-min', 'E37 降级原因可追溯（' + pWeak.reason + '）');
    assert(C.buildExposureConstraints(pWeak, -1) === null, 'E38 该设备不再发出「无曝光值的 manual」约束');

    // 反面对照：有 min 的残缺能力不许被误伤
    const pKeepTime = C.pickExposurePlan({ exposureMode: ['manual'], exposureTime: { min: 10 } }, { exposureTime: 500 });
    assert(pKeepTime.tier === 2, 'E39 有 timeMin 无 timeMax 仍判 tier2（1e9 兜底覆盖，不误伤正常设备）');
    const pKeepIso = C.pickExposurePlan({ exposureMode: ['manual'], iso: { min: 100 } }, { iso: 400 });
    assert(pKeepIso.tier === 2, 'E40 有 isoMin 无 isoMax 仍判 tier2');
    assert(advOf(C.buildExposureConstraints(pKeepTime, -1)).exposureTime > 0, 'E41 有 timeMin 时确实能压曝光时间');

    // 3) 上游 pickExposurePlan 守不住的那一格：能力**有** min 会判 tier2，
    //    但 getSettings() 不给基线（baseTime/baseIso 为 null）时同样产不出曝光值。
    //    这必须由构造函数末尾的不变式封死，不能只靠上游单点判定。
    const pNoBase = C.pickExposurePlan({ exposureMode: ['manual', 'continuous'], exposureTime: { min: 10, max: 10000 } }, {});
    assert(pNoBase.tier === 2, 'E42 能力有 timeMin 时上游仍判 tier2（这正是漏网的入口）');
    assert(C.buildExposureConstraints(pNoBase, -1) === null, 'E43 但基线缺失 → 构造函数返回 null，不发「无曝光值的 manual」');
    const pNoBaseIso = C.pickExposurePlan({ exposureMode: ['manual'], iso: { min: 100, max: 1600 } }, {});
    assert(C.buildExposureConstraints(pNoBaseIso, -1) === null, 'E44 iso 同形：基线缺失同样返回 null');
    // 反面对照：给了基线就照常产出，不变式不能误伤正常路径
    assert(advOf(C.buildExposureConstraints(pKeepTime, -1)).exposureTime > 0, 'E45 有基线时不变式不拦截（仍产出曝光时间）');
  }

  /* ---------------------------------------------------------------- *
   * F. 控制器集成：engage → step → release → restore 全链路
   * ---------------------------------------------------------------- */
  console.log('\n· F 控制器集成（engage → step → release → restore）');
  await (async function () {
    const h = makeHarness();
    const seen = [];
    h.ctrl.onExposureChange(function (e) { seen.push(e); });
    await boot(h);
    assert(h.ctrl.state === 'LIVE', 'F1 出画 LIVE（实际 ' + h.ctrl.state + '）');
    assert(h.ctrl.getExposureInfo().state === 'IDLE', 'F2 LIVE 后辅助进入 IDLE 待机（未命中前不介入）');

    // 推进到 engage（3 帧命中）并进入闭环
    await pump(h.clock, 120, 5);
    assert(hasEvent(h.logs, 'CAM_EXP_ENUM'), 'F3 engage 时记录能力探测结果（CAM_EXP_ENUM）');
    const enumLog = eventsOf(h.logs, 'CAM_EXP_ENUM')[0];
    assert(enumLog && enumLog.fields.tier === 1, 'F4 假 track 探测为 tier1（实际 ' + (enumLog && enumLog.fields.tier) + '）');
    assert(hasEvent(h.logs, 'CAM_EXP_ENGAGE'), 'F5 记录 CAM_EXP_ENGAGE');
    assert(hasEvent(h.logs, 'CAM_EXP_STEP'), 'F6 闭环持续下发 EV 调整（CAM_EXP_STEP）');
    assert(h.ctrl.getExposureInfo().state === 'ACTIVE', 'F7 辅助进入 ACTIVE');

    // 红线：整条链路的每一次 applyConstraints 都只带曝光键
    const bad = [];
    h.track.calls.forEach(function (cst, i) {
      redlineViolations(cst).forEach(function (v) { bad.push('#' + i + v); });
    });
    assert(h.track.calls.length >= 3, 'F8 全链路至少下发 3 次曝光约束（实际 ' + h.track.calls.length + '）');
    assert(bad.length === 0, 'F9 红线：链路中每次 applyConstraints 都不夹带分辨率/帧率（' + (bad.join(',') || '无违规') + '）');

    // 第一次是 engage 的中性模式，后续是逐步加深的负补偿
    const comps = h.track.calls.map(function (cst) {
      return cst.advanced && cst.advanced[0] ? cst.advanced[0].exposureCompensation : null;
    });
    assert(comps[0] === 0, 'F10 engage 先从 0 起（具体压多少交给闭环，实际 ' + comps[0] + '）');
    const negatives = comps.slice(1).filter(function (v) { return typeof v === 'number' && v < 0; });
    assert(negatives.length >= 2, 'F11 后续约束全是负补偿（实际 ' + JSON.stringify(comps) + '）');
    const desc = negatives.every(function (v, i) { return i === 0 || v <= negatives[i - 1] + 1e-9; });
    assert(desc, 'F12 补偿逐步加深（单调，不振荡）');
    assert(h.ctrl.getExposureInfo().ev >= C.DEFAULTS.expEvMin - 1e-9, 'F13 累计补偿不越过下限');

    // 场景翻转为「正常」（白衣物 + 白垫板）→ 连续未命中 → release + 恢复
    const callsBefore = h.track.calls.length;
    h.setImage(SCENE.D());
    await pump(h.clock, 200, 5);
    assert(hasEvent(h.logs, 'CAM_EXP_RELEASE'), 'F14 衣物移出画面后 release（CAM_EXP_RELEASE）');
    const restoreCalls = h.track.calls.slice(callsBefore).filter(function (cst) {
      return cst.advanced && cst.advanced.length === 1 &&
        cst.advanced[0].exposureCompensation === 0 && cst.advanced[0].exposureMode === undefined;
    });
    assert(restoreCalls.length >= 1, 'F15 release 真的把补偿还回去了（下发 { exposureCompensation: 0 }）');
    assert(hasEvent(h.logs, 'CAM_EXP_RESTORE'), 'F16 记录 CAM_EXP_RESTORE');
    // 恢复日志在「根本没恢复」时不存在，取 [0] 前必须先兜底，
    // 否则变异体会以「脚本异常」中断套件而不是给出精准的红断言
    const restoreLog0 = eventsOf(h.logs, 'CAM_EXP_RESTORE')[0] || { fields: {} };
    assert(restoreLog0.fields.ok === true, 'F17 恢复成功记账 ok=true');
    assert(h.ctrl.getExposureInfo().state === 'IDLE', 'F18 release 后回 IDLE');
    assert(h.ctrl.getExposureInfo().ev === 0, 'F19 release 后 EV 归零（内部状态与设备一致）');
    assert(seen.length > 0, 'F20 onExposureChange 有推送（' + seen.length + ' 次）');

    // 卸载：无残留定时器、无 live track
    h.ctrl.unmount();
    await flush(60);
    assert(h.clock.count() === 0, 'F21 unmount 后无悬挂定时器（残留 ' + h.clock.count() + ' 个）');
    assert(h.track.readyState === 'ended', 'F22 unmount 后 track 已停止（I7）');
  })();

  /* ---------------------------------------------------------------- *
   * G. 悬挂 track：竞速超时兜底
   * ---------------------------------------------------------------- */
  console.log('\n· G 悬挂 track 竞速（UVC applyConstraints 永不 settle）');
  await (async function () {
    const h = makeHarness({ trackOpts: { hang: true } });
    await boot(h);
    await pump(h.clock, 200, 5);
    const fb = eventsOf(h.logs, 'CAM_EXP_FALLBACK');
    assert(fb.some(function (x) { return x.fields.reason === 'apply-timeout'; }),
      'G1 悬挂 applyConstraints 被 expApplyTimeoutMs 竞速放行（reason=apply-timeout）');
    assert(h.ctrl.getExposureInfo().fails > 0, 'G2 失败计数如实记账（fails=' + h.ctrl.getExposureInfo().fails + '）');
    // 仍然活着：状态没被拖死，周期还在推进
    assert(h.ctrl.state === 'LIVE', 'G3 悬挂不拖死主链（仍 LIVE）');
    const cycles = eventsOf(h.logs, 'CAM_EXP_SKIP').length + eventsOf(h.logs, 'CAM_EXP_FALLBACK').length;
    assert(cycles >= 1, 'G4 周期在持续推进');
    h.ctrl.unmount();
    await flush(80);
    assert(h.clock.count() === 0, 'G5 竞速落败一侧的定时器已回收（无悬挂定时）');
  })();

  /* ---------------------------------------------------------------- *
   * H. 失败降级到软件兜底
   * ---------------------------------------------------------------- */
  console.log('\n· H 连续失败降级 tier0（软件兜底）');
  await (async function () {
    const h = makeHarness({ trackOpts: { reject: true } });
    await boot(h);
    await pump(h.clock, 200, 5);
    const fb = eventsOf(h.logs, 'CAM_EXP_FALLBACK').map(function (x) { return x.fields.reason; });
    assert(fb.indexOf('apply-error') >= 0, 'H1 applyConstraints 拒绝被记账（reason=apply-error）');
    assert(fb.indexOf('software-fallback') >= 0 || fb.indexOf('engage-apply-failed') >= 0 || fb.indexOf('fail-limit') >= 0,
      'H2 硬件路径失效后降级（实际 ' + JSON.stringify(fb) + '）');
    assert(h.ctrl.getExposureInfo().tier === 0, 'H3 降级后 tier=0（改由拍照时软件压暗）');
    h.ctrl.unmount();
    await flush(60);
    assert(h.clock.count() === 0, 'H4 降级路径也不留悬挂定时器');
  })();

  /* ---------------------------------------------------------------- *
   * I. 对焦脉冲 / 页面隐藏避让
   * ---------------------------------------------------------------- */
  console.log('\n· I 与既有机制的避让（对焦脉冲 / 页面隐藏）');
  await (async function () {
    // 对焦脉冲期间整周期跳过
    const h1 = makeHarness({ focus: true });
    await boot(h1);
    await pump(h1.clock, 120, 5);
    const skips = reasonsOf(h1.logs, 'CAM_EXP_SKIP');
    assert(skips.indexOf('focus-pulse') >= 0, 'I1 对焦脉冲期间记 CAM_EXP_SKIP{reason:focus-pulse}');
    assert(!hasEvent(h1.logs, 'CAM_EXP_ENGAGE'), 'I2 对焦脉冲期间绝不 engage（帧统计是噪声，且约束交叠有回弹风险）');
    assert(h1.track.calls.length === 0, 'I3 对焦脉冲期间一次曝光约束都不发');
    // 脉冲结束后恢复运转
    h1.setFocus(false);
    await pump(h1.clock, 150, 5);
    assert(hasEvent(h1.logs, 'CAM_EXP_ENGAGE'), 'I4 脉冲结束后辅助自动恢复（下个周期自愈）');
    h1.ctrl.unmount();

    // 页面隐藏
    const h2 = makeHarness({ visible: false });
    await boot(h2);
    await pump(h2.clock, 120, 5);
    assert(reasonsOf(h2.logs, 'CAM_EXP_SKIP').indexOf('page-hidden') >= 0, 'I5 页面隐藏时记 CAM_EXP_SKIP{reason:page-hidden}');
    assert(!hasEvent(h2.logs, 'CAM_EXP_ENGAGE'), 'I6 页面隐藏时不做任何曝光调整');
    h2.ctrl.unmount();
    await flush(40);
  })();

  /* ---------------------------------------------------------------- *
   * J. 总开关
   * ---------------------------------------------------------------- */
  console.log('\n· J 总开关（window.__xqyExposureAssist 的注入通道）');
  await (async function () {
    const h = makeHarness({ assistOn: false });
    await boot(h);
    await pump(h.clock, 150, 5);
    assert(h.ctrl.getExposureInfo().state === 'OFF', 'J1 总开关关闭 → 辅助 OFF（实际 ' + h.ctrl.getExposureInfo().state + '）');
    assert(!hasEvent(h.logs, 'CAM_EXP_ENGAGE') && !hasEvent(h.logs, 'CAM_EXP_STEP'), 'J2 关闭后完全静默');
    assert(h.track.calls.length === 0, 'J3 关闭后一次约束都不发（一行命令整体退出）');
    h.ctrl.unmount();
    await flush(40);

    // 未注入 gridSampler（既有调用方 / 老渲染层）→ 整体 OFF，既有行为零影响
    const c = C.createCameraController({
      mediaDevices: {
        getUserMedia: function () { return Promise.resolve({ getTracks: function () { return [makeExpTrack()]; }, getVideoTracks: function () { return [makeExpTrack()]; } }); },
        enumerateDevices: function () { return Promise.resolve([]); },
        addEventListener: function () {}, removeEventListener: function () {}
      },
      videoGetter: function () { return makeVideo(); },
      config: CFG,
      log: function () {}
    });
    assert(c.getExposureInfo().state === 'OFF', 'J4 未注入 gridSampler → 辅助 OFF（既有调用方不受任何影响）');
    c.unmount();
  })();

  /* ---------------------------------------------------------------- *
   * K. 黑帧门控放行（§9.1）
   * ---------------------------------------------------------------- */
  console.log('\n· K 黑帧门控（门控放行 + 实时复采兜底）');
  await (async function () {
    // 中心区域全黑（mean=5、variance=0 → 绝对阈值判黑），但全帧场景健康
    const blackCenter = new Array(64 * 64).fill(5);
    const h = makeHarness({ gray: blackCenter });
    await boot(h);
    await pump(h.clock, 120, 5);
    assert(h.ctrl.getExposureInfo().state === 'ACTIVE', 'K1 前置：辅助已 ACTIVE');

    const r1 = h.ctrl.isBlackFrame(h.video);
    assert(r1 === false, 'K2 ACTIVE 期间「被正确压暗的黑衣物」不再被误判成全黑（放行）');
    const gate = eventsOf(h.logs, 'CAM_EXP_BLACKGATE');
    assert(gate.length === 1, 'K3 记录 CAM_EXP_BLACKGATE（放行证据）');
    // 门控被变异拆除时 gate 为空，这里不能直接取 [0] 否则会中断整个套件
    const g0 = gate[0] || { fields: {} };
    assert(g0.fields.reason === 'assist-active', 'K4 门控原因可追溯');
    assert(typeof g0.fields.sceneMean === 'number' && typeof g0.fields.mean === 'number', 'K5 门控日志带场景均值与中心均值');

    // 镜头被捂住：实时复采的场景均值崩塌 → 照常拒拍
    h.setImage(SCENE.C());
    const r2 = h.ctrl.isBlackFrame(h.video);
    assert(r2 === true, 'K6 镜头被捂住时门控不放行（实时复采兜底，场景均值 < expBlackFloor）');
    assert(eventsOf(h.logs, 'CAM_EXP_BLACKGATE').length === 1, 'K7 被捂住的场景不产生额外的门控放行');

    // 辅助不在 ACTIVE 时门控完全不介入（既有黑帧行为不变）
    h.ctrl.stopExposureAssist('test', false);
    h.setImage(SCENE.A());
    const r3 = h.ctrl.isBlackFrame(h.video);
    assert(r3 === true, 'K8 辅助未激活时黑帧判定与改造前完全一致（非 ACTIVE 不放行）');
    assert(hasEvent(h.logs, 'CAM_CAPTURE_REJECT'), 'K9 仍按原路径记录 CAM_CAPTURE_REJECT');
    h.ctrl.unmount();
    await flush(40);
  })();

  /* ---------------------------------------------------------------- *
   * L. 生命周期：sleep / DEGRADED 复活 / 快照与 API
   * ---------------------------------------------------------------- */
  console.log('\n· L 生命周期与快照（sleep / DEGRADED 复活 / snapshot / api）');
  await (async function () {
    const h = makeHarness();
    await boot(h);
    await pump(h.clock, 120, 5);
    assert(h.ctrl.getExposureInfo().state === 'ACTIVE', 'L1 前置：已 ACTIVE');

    const snap = h.ctrl.snapshot();
    assert(snap.exposure && typeof snap.exposure === 'object', 'L2 snapshot 带 exposure 字段');
    const keys = Object.keys(snap.exposure).sort().join(',');
    eq(keys, 'adjusts,ev,fails,sceneMean,state,subjectMean,subjectRatio,tier', 'L3 snapshot.exposure 八项齐备');
    assert(snap.exposure.state === 'ACTIVE' && snap.exposure.tier === 1, 'L4 快照如实反映档位与状态（现场复盘用）');

    const info = h.ctrl.getExposureInfo();
    assert(info && info.state === 'ACTIVE' && typeof info.ev === 'number', 'L5 getExposureInfo 可用');
    let off = null;
    off = h.ctrl.onExposureChange(function () {});
    assert(typeof off === 'function', 'L6 onExposureChange 返回退订函数');
    off();

    // sleep：恢复 + 停止 + 清定时器
    const before = h.track.calls.length;
    h.ctrl.sleep('test');
    await flush(60);
    assert(h.ctrl.getStream() === null, 'L7 sleep 后无活跃流（I3）');
    const restored = h.track.calls.slice(before).some(function (cst) {
      return cst.advanced && cst.advanced.length === 1 && cst.advanced[0].exposureCompensation === 0;
    });
    assert(restored, 'L8 sleep 前把设备曝光还回去（自定义曝光不会残留在设备上）');
    assert(h.clock.count() === 0, 'L9 sleep 后无悬挂定时器');

    // 唤醒后重新启动辅助
    await drain(h.ctrl.wake());
    await flush(40);
    await pump(h.clock, 150, 5);
    assert(h.ctrl.getExposureInfo().state === 'ACTIVE', 'L10 唤醒后辅助重新 engage（新流新会话）');
    h.ctrl.unmount();
    await flush(60);
    assert(h.clock.count() === 0, 'L11 unmount 后无悬挂定时器');
  })();

  /* ---------------------------------------------------------------- *
   * O. 幽灵能力：有效性判定（judgeExposureEffect，设计文档 §7.5）
   * ---------------------------------------------------------------- */
  console.log('\n· O 曝光有效性判定（幽灵能力检测，§7.5）');
  {
    const E = C.EXP_EFFECT;
    // 默认判定参数：这几条是「防误伤」的量化承诺，改参数必须同步改这里
    assert(E.hits === 2, 'O1 滞回：连续 ' + E.hits + ' 次无响应才判无效（单帧不判，防 AE 抖动误伤）');
    assert(E.minSteps === 3 && E.minEv === 1.0,
      'O2 证据门槛：至少 ' + E.minSteps + ' 步且累计 ≥' + E.minEv + 'EV 才判');
    assert(E.windowMs === 2000, 'O3 收敛窗口 ' + E.windowMs + 'ms（engage/换档后先让 AE 收敛再判）');
    assert(E.ratio === 0.5 && E.gamma === 2.2,
      'O4 判据：实测降幅 ≥ 预期降幅×' + E.ratio + '（预期按 sRGB gamma ' + E.gamma + ' 折算）');

    // 亮度模型：真实响应设备 linear ×2^ev → 8bit 码值 ×2^(ev/2.2)
    const model = (base, ev) => base * Math.pow(2, ev / E.gamma);
    const NoWin = { expEffectWindowMs: 0 };   // 关掉收敛窗口（虚拟时钟只跑几百毫秒）

    // ① 正常设备：亮度按模型下降 → effective
    const goodSamples = [];
    [0.34, 0.68, 1.02, 1.36].forEach(function (d, i) {
      goodSamples.push({ ev: -d, mean: model(170, -d), t: 1000 + i * 500 });
    });
    const good = C.judgeExposureEffect({ baseline: 170, samples: goodSamples, startedAt: 0 }, NoWin);
    assert(good.verdict === 'effective', 'O5 正常设备：亮度随补偿下降 → effective（实际 ' + good.verdict + '）');
    near(good.expectedDrop, 1 - Math.pow(2, -1.36 / E.gamma), 1e-9,
      'O6 预期降幅按 1−2^(ev/gamma) 折算（ev=-1.36 → ' + good.expectedDrop.toFixed(3) + '）');
    assert(good.dropRatio >= good.needDrop, 'O7 实测降幅 ' + good.dropRatio.toFixed(3) +
      ' ≥ 门槛 ' + good.needDrop.toFixed(3) + '（留了一倍余量）');

    // ② 幽灵设备：ev 一路压到 -2.0，亮度只在噪声里波动 → ineffective（现场形态）
    const ghostSamples = [
      { ev: -0.34, mean: 170, t: 1000 },
      { ev: -0.68, mean: 168, t: 1500 },
      { ev: -1.02, mean: 164, t: 2000 },
      { ev: -1.36, mean: 170, t: 2500 },
      { ev: -1.70, mean: 155, t: 3000 },
      { ev: -2.00, mean: 166, t: 3500 }
    ];
    const ghost = C.judgeExposureEffect({ baseline: 170, samples: ghostSamples, startedAt: 0 }, NoWin);
    assert(ghost.verdict === 'ineffective', 'O8 幽灵设备（现场日志原样）：ev 0→-2.0 亮度不降 → ineffective');
    assert(ghost.streak >= E.hits, 'O9 判定成立前已有 ' + ghost.streak + ' 次连续无响应（不是单帧冲动）');
    assert(ghost.dropRatio < ghost.needDrop, 'O10 实测降幅 ' + ghost.dropRatio.toFixed(3) +
      ' < 门槛 ' + ghost.needDrop.toFixed(3) + '（判别面很干净，不是擦线）');

    // ③ 滞回：只测到 1 次无响应 → pending（好设备不会因此被降级）
    const oneMiss = C.judgeExposureEffect({
      baseline: 170,
      samples: [{ ev: -0.34, mean: 168, t: 1000 }, { ev: -0.68, mean: 166, t: 1500 }, { ev: -1.02, mean: 168, t: 2000 }],
      startedAt: 0
    }, NoWin);
    assert(oneMiss.verdict === 'pending' && oneMiss.reason === 'hysteresis',
      'O11 只有 1 次无响应 → pending（滞回生效，AE 抖动不会一次判死设备）');

    // ④ 噪声：单帧反弹但整体在降 → 仍判有效（防误伤的核心）
    //    数据 = 亮度模型值 + 少量噪声（AE 抖动 / 衣物微动的真实形态）
    const noisy = C.judgeExposureEffect({
      baseline: 170,
      samples: [
        { ev: -0.34, mean: model(170, -0.34) + 4, t: 1000 },
        { ev: -0.68, mean: model(170, -0.68) - 3, t: 1500 },
        { ev: -1.02, mean: model(170, -1.02) + 2, t: 2000 },
        { ev: -1.36, mean: model(170, -1.36), t: 2500 }
      ],
      startedAt: 0
    }, NoWin);
    assert(noisy.verdict === 'effective', 'O12 单帧反弹 + 整体按模型下降 → 仍判有效（噪声不误伤，实际 ' + noisy.verdict + '）');

    // ⑤ 证据不足：步数不够 / 补偿太浅 / 还在收敛窗口内 / 基线缺失
    const few = C.judgeExposureEffect({
      baseline: 170, samples: [{ ev: -0.34, mean: 170, t: 1000 }], startedAt: 0
    }, NoWin);
    assert(few.verdict === 'pending' && few.reason === 'need-steps', 'O13 步数不足 → pending（need-steps）');
    const shallow = C.judgeExposureEffect({
      baseline: 170,
      samples: [{ ev: -0.1, mean: 170, t: 1000 }, { ev: -0.2, mean: 170, t: 1500 }, { ev: -0.3, mean: 170, t: 2000 }],
      startedAt: 0
    }, NoWin);
    assert(shallow.verdict === 'pending' && shallow.reason === 'need-steps',
      'O14 补偿不足 ' + E.minEv + 'EV → pending（浅补偿的预期降幅落在噪声里）');
    const inWindow = C.judgeExposureEffect({
      baseline: 170, samples: ghostSamples, startedAt: 3000
    }, null);
    assert(inWindow.verdict === 'pending', 'O15 收敛窗口内不判（默认 windowMs=' + E.windowMs + '，防 AE 收敛期误伤）');
    assert(C.judgeExposureEffect({ baseline: null, samples: ghostSamples, startedAt: 0 }, NoWin).verdict === 'pending',
      'O16 无基线 → pending（采样失败不瞎判）');

    // ⑥ 反向：亮度反而上升（AE 对抗且补偿无效）→ 无效
    const rising = C.judgeExposureEffect({
      baseline: 170,
      samples: [
        { ev: -0.34, mean: 175, t: 1000 },
        { ev: -0.68, mean: 178, t: 1500 },
        { ev: -1.02, mean: 180, t: 2000 },
        { ev: -1.36, mean: 182, t: 2500 }
      ],
      startedAt: 0
    }, NoWin);
    assert(rising.verdict === 'ineffective' && rising.dropRatio < 0,
      'O17 补偿下发但亮度反而上升 → ineffective（降幅为负，实际 ' + rising.verdict + '）');

    // ⑦ 中途恢复响应 → 滞回清零（设备只是慢热，不该被降级）
    const late = C.judgeExposureEffect({
      baseline: 170,
      samples: [
        { ev: -0.34, mean: 170, t: 1000 },
        { ev: -0.68, mean: 169, t: 1500 },
        { ev: -1.02, mean: 168, t: 2000 },
        { ev: -1.36, mean: 120, t: 2500 }
      ],
      startedAt: 0
    }, NoWin);
    assert(late.verdict === 'effective' && late.streak === 0, 'O18 慢热设备恢复响应后滞回清零 → effective');

    // ⑧ 设备把补偿钳死（pinned）：永远到不了 1EV，也必须判得出来。
    //    步数门槛照旧生效（前两步仍混着 AE 收敛），所以是第 4 条样本才成立
    const pinnedSeq = [
      { ev: -0.5, mean: 170, pinned: true, t: 1000 },
      { ev: -0.5, mean: 171, pinned: true, t: 1500 },
      { ev: -0.5, mean: 169, pinned: true, t: 2000 },
      { ev: -0.5, mean: 170, pinned: true, t: 2500 }
    ];
    const pinned = C.judgeExposureEffect({ baseline: 170, samples: pinnedSeq, startedAt: 0 }, NoWin);
    assert(pinned.verdict === 'ineffective',
      'O19 设备把补偿钳死在 -0.5EV（pinned）→ 仍判无效（现场「压不动」形态，实际 ' + pinned.verdict + '）');
    const pinnedNot = C.judgeExposureEffect({
      baseline: 170,
      samples: [{ ev: -0.5, mean: 170, t: 1000 }, { ev: -0.5, mean: 171, t: 1500 }, { ev: -0.5, mean: 169, t: 2000 }],
      startedAt: 0
    }, NoWin);
    assert(pinnedNot.verdict === 'pending',
      'O20 同样的浅补偿但**没有** pinned 标记 → 不判（深度门槛照旧生效）');

    // ⑨ 主检正对照：判据不是恒真——把达成系数拉到 1.5（要求比物理上可能的降幅还多）
    //    后，同一条完美响应序列必须翻成 ineffective。否则说明 verdict 是写死的
    const strict = C.judgeExposureEffect({ baseline: 170, samples: goodSamples, startedAt: 0 },
      { expEffectWindowMs: 0, expEffectRatio: 1.5 });
    assert(strict.verdict === 'ineffective',
      'O21 判据随参数变化（不是恒真断言）：ratio=1.5 时完美响应序列判为 ' + strict.verdict);
    assert(good.verdict === 'effective' && strict.verdict === 'ineffective',
      'O22 同一条序列在 ratio=0.5 与 1.5 下结论相反（判据真的在起作用）');
  }

  /* ---------------------------------------------------------------- *
   * P. 幽灵能力：档位降级链（demoteExposurePlan，§7.5）
   * ---------------------------------------------------------------- */
  console.log('\n· P 档位降级链（tier1 → tier2 → tier0）');
  {
    const capCompOnly = { exposureCompensation: { min: -3, max: 3, step: 0.1 } };
    const capBoth = {
      exposureCompensation: { min: -3, max: 3, step: 0.1 },
      exposureMode: ['continuous', 'manual'],
      exposureTime: { min: 10, max: 10000 }
    };
    const plan1 = C.pickExposurePlan(capCompOnly, { exposureCompensation: 0 });
    assert(plan1.tier === 1, 'P1 前置：补偿能力 → tier1');

    // ① 无 manual 能力可退 → 直接软件兜底
    const d1 = C.demoteExposurePlan(plan1, capCompOnly, { exposureCompensation: 0 });
    assert(d1.tier === 0 && d1.plan === null, 'P2 tier1 无效 + 无 manual → tier0 软件兜底');
    assert(d1.reason === 'comp-ineffective', 'P3 降级原因可追溯（' + d1.reason + '）');

    // ② 有 manual 且能产出曝光值 → 换手动档重试
    const d2 = C.demoteExposurePlan(plan1, capBoth, { exposureCompensation: 0, exposureTime: 500 });
    assert(d2.tier === 2 && d2.plan && d2.plan.tier === 2, 'P4 tier1 无效 + manual 可用 → 降到 tier2 重试');
    assert(d2.reason === 'comp-ineffective', 'P5 降级原因仍是 comp-ineffective（' + d2.reason + '）');
    const c2 = C.buildExposureConstraints(d2.plan, -1);
    assert(c2 && c2.advanced[0].exposureMode === 'manual' && isFinite(c2.advanced[0].exposureTime),
      'P6 新档位确实能产出 manual 曝光时间（换路有效，不是空降）');

    // ③ manual 也无效 → 软件兜底
    const d3 = C.demoteExposurePlan(d2.plan, capBoth, { exposureTime: 500 });
    assert(d3.tier === 0 && d3.reason === 'manual-ineffective',
      'P7 tier2 也无效 → tier0，原因 manual-ineffective（' + d3.reason + '）');

    // ④ 已在 tier0：不再往下（也不会被误判成可降级）
    const d4 = C.demoteExposurePlan({ tier: 0, reason: 'unsupported' }, capBoth, {});
    assert(d4.tier === 0, 'P8 tier0 已经是底（不会再降，也不会误升）');

    // ⑤ 能力残缺（有 manual 但拿不到基线）→ 不许降成一个「切了手动却不压暗」的档
    const d5 = C.demoteExposurePlan(plan1, capBoth, {});
    assert(d5.tier === 0 && d5.plan === null,
      'P9 降级目标产不出曝光值 → 直接 tier0（换路不能换来「切手动却不压暗」）');
    assert(C.buildExposureConstraints(d5.plan, -1) === null || d5.plan === null,
      'P10 降级后的档位不会发出无曝光值的 manual 约束');

    // ⑥ 实际下发量：设备把补偿钳死时，判定必须拿钳后的值算预期
    const tightPlan = C.pickExposurePlan({ exposureCompensation: { min: -0.5, max: 3, step: 0.1 } }, {});
    const tightCst = C.buildExposureConstraints(tightPlan, -2.0);
    near(C.appliedEvOf(tightPlan, -2.0, tightCst), -0.5, 1e-9,
      'P11 appliedEvOf 取设备钳位后的实际值（闭环要 -2.0，设备只给 -0.5）');
    const t2Plan = C.pickExposurePlan({ exposureMode: ['manual'], exposureTime: { min: 10, max: 10000 } }, { exposureTime: 500 });
    near(C.appliedEvOf(t2Plan, -1, C.buildExposureConstraints(t2Plan, -1)), -1, 1e-9,
      'P12 tier2 按 exposureTime 反算实际 EV（500→250µs = -1EV）');
    assert(C.appliedEvOf(t2Plan, -1, null) === -1, 'P13 无约束时回退为闭环值（不抛错）');
  }

  /* ---------------------------------------------------------------- *
   * R. 控制器集成：幽灵能力自动降级 / 正常设备不误伤（§7.5）
   * ---------------------------------------------------------------- */
  console.log('\n· R 控制器集成（幽灵能力 → 自动降级；正常设备 → 不误伤）');

  // 正常设备：画面亮度按已下发的补偿变化（sRGB 编码模型）。幽灵设备用静态图。
  function lastAppliedComp(track) {
    for (let i = track.calls.length - 1; i >= 0; i--) {
      const a = track.calls[i] && track.calls[i].advanced && track.calls[i].advanced[0];
      if (a && typeof a.exposureCompensation === 'number') return a.exposureCompensation;
    }
    return 0;
  }
  function responsiveImage(mean) {
    const v = Math.max(5, Math.min(255, Math.round(mean)));
    return makeImage(function (cx, cy) {
      const inCenter = cy >= 2 && cy <= 4 && cx >= 2 && cx <= 5;
      const below = (cy === 5 || cy === 6) && cx >= 1 && cx <= 5;
      return inCenter || below ? [v, v, v] : PAL.pad;
    });
  }

  // 过压设备模型（缺陷 2 / 缺陷 3 共用）：设备实际执行的曝光时间比请求的更短，
  // 实际压暗深度 = 请求 ×(1+depth)。X 组用它验证过压检出与徽标诚实，
  // Z 组用它验证「过压不被崩塌守卫误判」。乘法而非「请求 − depth」的原因见 X 组注释
  function lastAppliedTime(track) {
    for (let i = track.calls.length - 1; i >= 0; i--) {
      const a = track.calls[i] && track.calls[i].advanced && track.calls[i].advanced[0];
      if (a && typeof a.exposureTime === 'number') return a.exposureTime;
    }
    return null;
  }
  function overPressImage(track, bt, depth, sN, pN) {
    return function () {
      const t = lastAppliedTime(track) || bt;     // 设备收到的请求时间
      const reqEv = Math.log2(t / bt);             // 请求的 EV
      // 过压（乘法模型）：设备实际执行时间比请求更短，使实际压暗深度 = 请求 ×(1+depth)。
      // 用乘法而非「请求 − depth」：后者在请求 ev=0 时已把整帧压暗 depth EV，导致中性帧
      // 一上来就过暗、闸门永远不命中、过压检测根本没机会运行。乘法在请求 0 时给中性帧
      // （正常 engage），只在请求变负后才越压越深，符合「用户请求压暗、设备执行得更狠」
      const actualEv = reqEv * (1 + depth);
      const f = Math.pow(2, actualEv / 2.2);
      return makeImage(function (cx, cy) {
        const inCenter = cy >= 2 && cy <= 4 && cx >= 2 && cx <= 5;
        const below = (cy === 5 || cy === 6) && cx >= 1 && cx <= 5;
        const base = (inCenter || below) ? sN : pN;
        const v = Math.max(0, Math.min(255, Math.round(base * f)));
        return [v, v, v];
      });
    };
  }

  await (async function () {
    /* --- R1/R2：正常设备与幽灵设备的对照（同一套参数，只差画面响不响应） --- */
    const mkResponsive = function () {
      const track = makeExpTrack();
      return makeHarness({
        track: track,
        image: function () { return responsiveImage(150 * Math.pow(2, lastAppliedComp(track) / 2.2)); },
        config: { expEffectWindowMs: 0 }
      });
    };
    const hGood = mkResponsive();
    await boot(hGood);
    await pump(hGood.clock, 400, 5);
    const goodInfo = hGood.ctrl.getExposureInfo();
    assert(goodInfo.tier === 1, 'R1 正常设备（亮度随补偿下降）不降级，停在 tier1（实际 tier=' + goodInfo.tier + '）');
    assert(!reasonsOf(hGood.logs, 'CAM_EXP_FALLBACK').some(function (r) { return r.indexOf('ineffective') >= 0; }),
      'R2 正常设备不产生任何 ineffective 降级日志（实际 ' +
      JSON.stringify(reasonsOf(hGood.logs, 'CAM_EXP_FALLBACK')) + '）');
    assert(goodInfo.ev < -2.0, 'R3 正常设备闭环真的压到了旧下限之外（ev=' + goodInfo.ev.toFixed(2) + '，下限已加深）');
    assert(goodInfo.subjectMean != null && Math.abs(goodInfo.subjectMean - C.DEFAULTS.expTargetMean) < 12,
      'R4 正常设备主体亮度收敛到目标附近（' + (goodInfo.subjectMean == null ? 'null' : goodInfo.subjectMean.toFixed(1)) +
      ' ≈ ' + C.DEFAULTS.expTargetMean + '）');
    hGood.ctrl.unmount();
    await flush(60);
    assert(hGood.clock.count() === 0, 'R5 正常设备路径无悬挂定时器');

    const hGhost = makeHarness({ config: { expEffectWindowMs: 0 } });
    await boot(hGhost);
    await pump(hGhost.clock, 400, 5);
    const fbGhost = reasonsOf(hGhost.logs, 'CAM_EXP_FALLBACK');
    assert(fbGhost.indexOf('comp-ineffective') >= 0,
      'R6 幽灵设备：补偿无效被检出并降级（实际原因集 ' + JSON.stringify(fbGhost) + '）');
    assert(hGhost.ctrl.getExposureInfo().tier === 0,
      'R7 无 manual 可退 → 直接降到 tier0 软件兜底（实际 tier=' + hGhost.ctrl.getExposureInfo().tier + '）');
    const stepLogs = eventsOf(hGhost.logs, 'CAM_EXP_STEP');
    assert(stepLogs.length >= 3, 'R8 降级前确实下发过多步补偿（' + stepLogs.length + ' 步，不是一步就判死）');
    const downLog = eventsOf(hGhost.logs, 'CAM_EXP_FALLBACK').filter(function (x) {
      return x.fields.reason === 'comp-ineffective';
    })[0] || { fields: {} };
    assert(downLog.fields.from === 1 && downLog.fields.tier === 0,
      'R9 降级留痕带原档位与新档位（from=' + downLog.fields.from + ' → tier=' + downLog.fields.tier + '）');
    assert(typeof downLog.fields.drop === 'number', 'R10 降级留痕带实测降幅 drop=' + downLog.fields.drop);

    // 降级前必须把补偿还回去：否则设备会一直停在降曝态（用户看到「莫名偏暗」）
    const negIdx = [];
    hGhost.track.calls.forEach(function (cst, i) {
      const a = cst.advanced && cst.advanced[0];
      if (a && typeof a.exposureCompensation === 'number' && a.exposureCompensation < 0) negIdx.push(i);
    });
    const lastNeg = negIdx.length ? negIdx[negIdx.length - 1] : -1;
    const restoredAfter = hGhost.track.calls.slice(lastNeg + 1).some(function (cst) {
      const a = cst.advanced && cst.advanced[0];
      return a && a.exposureCompensation === 0 && a.exposureMode === undefined;
    });
    assert(restoredAfter, 'R11 降级前先把补偿归零（最后一次负补偿之后确实下发了 { exposureCompensation: 0 }）');

    // 降级后 ev 归零重新收敛（换量纲），且不再回到硬件档
    const evAfterDemote = hGhost.ctrl.getExposureInfo().ev;
    assert(evAfterDemote <= 0, 'R12 降级后内部 ev 从 0 重新起算（当前 ' + evAfterDemote.toFixed(2) + '）');
    await pump(hGhost.clock, 400, 5);
    assert(hGhost.ctrl.getExposureInfo().tier === 0, 'R13 降级是持久的（后续周期不会自己爬回硬件档）');
    assert(hGhost.track.calls.length === lastNeg + 2,
      'R14 降级后不再向硬件下发约束（调用数冻结在 ' + hGhost.track.calls.length + '）');
    hGhost.ctrl.unmount();
    await flush(60);
    assert(hGhost.clock.count() === 0, 'R15 降级路径无悬挂定时器');
  })();

  await (async function () {
    /* --- R16~R21：tier1 → tier2 → tier0 完整两级降级（manual 也是幽灵能力） --- */
    const caps = {
      exposureCompensation: { min: -3, max: 3, step: 0.1 },
      exposureMode: ['continuous', 'manual'],
      exposureTime: { min: 10, max: 10000 }
    };
    const h2 = makeHarness({
      trackOpts: { caps: caps, settings: { exposureCompensation: 0, exposureTime: 500 } },
      config: { expEffectWindowMs: 0 }
    });
    await boot(h2);
    await pump(h2.clock, 200, 5);
    const enums = eventsOf(h2.logs, 'CAM_EXP_ENUM').map(function (x) { return x.fields.tier; });
    assert(enums[0] === 1, 'R16 首次探测仍优先 tier1（补偿语义最干净，实际 ' + enums[0] + '）');
    await pump(h2.clock, 400, 5);
    assert(enums.indexOf(2) >= 0, 'R17 tier1 判无效后自动切 tier2（manual + 曝光时间，实际档位序列 ' + JSON.stringify(enums) + '）');
    const manualCalls = h2.track.calls.filter(function (cst) {
      const a = cst.advanced && cst.advanced[0];
      return a && a.exposureMode === 'manual' && typeof a.exposureTime === 'number';
    });
    assert(manualCalls.length >= 1, 'R18 tier2 确实下发了 manual 曝光时间约束（' + manualCalls.length + ' 次）');
    await pump(h2.clock, 500, 5);
    const fb2 = reasonsOf(h2.logs, 'CAM_EXP_FALLBACK');
    assert(fb2.indexOf('manual-ineffective') >= 0,
      'R19 manual 也是幽灵能力 → 继续降到 tier0（实际原因集 ' + JSON.stringify(fb2) + '）');
    assert(h2.ctrl.getExposureInfo().tier === 0, 'R20 两级降级后落在 tier0（软件兜底）');
    assert(eventsOf(h2.logs, 'CAM_EXP_STEP').some(function (x) { return x.fields.tier === 2; }),
      'R21 tier2 期间的 EV 步长照常留痕（现场能看到换档后是否仍无效）');
    h2.ctrl.unmount();
    await flush(60);
    assert(h2.clock.count() === 0, 'R22 两级降级路径无悬挂定时器');
  })();

  await (async function () {
    /* --- R23~R26：clipRatio 进日志（白色高光裁剪证据）+ 字段纪律 --- */
    const h3 = makeHarness({ config: { expEffectWindowMs: 0 } });
    await boot(h3);
    await pump(h3.clock, 150, 5);
    const steps = eventsOf(h3.logs, 'CAM_EXP_STEP');
    assert(steps.length > 0, 'R23 前置：产生 CAM_EXP_STEP 日志（' + steps.length + ' 条）');
    assert(steps.every(function (x) { return typeof x.fields.clipRatio === 'number'; }),
      'R24 CAM_EXP_STEP 带 clipRatio（高光裁剪占比，判断白色是否还在被裁剪）');
    assert(steps[0].fields.clipRatio >= 0 && steps[0].fields.clipRatio <= 1,
      'R25 clipRatio 是 0~1 的比例（实际 ' + steps[0].fields.clipRatio + '）');
    const fixed = fs.readFileSync(path.join(ROOT, 'main', 'camera-log.js'), 'utf8')
      .match(/const FIXED_KEYS = \[([^\]]+)\]/)[1]
      .split(',').map(function (s) { return s.trim().replace(/^['"]|['"]$/g, ''); });
    const maxExtra = steps.reduce(function (acc, x) {
      const n = Object.keys(x.fields).filter(function (k) { return fixed.indexOf(k) < 0; }).length;
      return n > acc ? n : acc;
    }, 0);
    assert(maxExtra <= 6, 'R26 clipRatio 加入后附加字段仍 ≤6（实际 ' + maxExtra + '，MAX_EXTRA_KEYS=6）');
    h3.ctrl.unmount();
    await flush(60);

    // 现场形态（黑白相间的鞋、白色鞋底被裁剪）：画面里必须有真被裁剪的高光，
    // clipRatio 才 > 0 —— 否则这条字段等于永远是 0，看不出白色是否还在过曝
    const clipScene = makeImage(function (cx, cy) {
      if (cy >= 3 && cy <= 4 && cx >= 2 && cx <= 4) return PAL.grey;   // 黑衣物主体
      if (cy === 6 && cx >= 1 && cx <= 4) return [255, 255, 255];      // 白色鞋底：全裁剪
      return PAL.pad;                                                  // 亮黄垫板
    });
    const h4 = makeHarness({ image: clipScene, config: { expEffectWindowMs: 0 } });
    await boot(h4);
    await pump(h4.clock, 150, 5);
    const clipSteps = eventsOf(h4.logs, 'CAM_EXP_STEP');
    assert(clipSteps.length > 0, 'R27 前置：裁剪场景产生 CAM_EXP_STEP（' + clipSteps.length + ' 条）');
    assert(clipSteps[0].fields.clipRatio > 0,
      'R28 白色鞋底被裁剪时 clipRatio > 0（实际 ' + clipSteps[0].fields.clipRatio + '，现场据此判断过曝有没有救回来）');
    h4.ctrl.unmount();
    await flush(60);
  })();

  /* ---------------------------------------------------------------- *
   * S. tier0 软件兜底的 EV 语义（QA DEF-2）：解析解而不是撞下限
   * ---------------------------------------------------------------- */
  console.log('\n· S tier0 软件兜底（EV 取解析解，不过压存档图）');
  await (async function () {
    // 画面主体亮度 = 100（比 150 暗，正好落在「闭环会过压、解析解不会」的区间）
    const imgAt = function (v) {
      return makeImage(function (cx, cy) {
        const inCenter = cy >= 2 && cy <= 4 && cx >= 2 && cx <= 5;
        const below = (cy === 5 || cy === 6) && cx >= 1 && cx <= 5;
        return inCenter || below ? [v, v, v] : PAL.pad;
      });
    };
    // 无任何曝光能力的设备 → 直接 tier0
    const hT0 = makeHarness({
      image: imgAt(100),
      trackOpts: { caps: { exposureMode: ['continuous'] }, settings: {} }
    });
    await boot(hT0);
    await pump(hT0.clock, 400, 5);
    const info0 = hT0.ctrl.getExposureInfo();
    assert(info0.tier === 0 && info0.state === 'ACTIVE',
      'S1 前置：无曝光能力的设备 → tier0 且照常 ACTIVE（实际 tier=' + info0.tier + '）');
    const want = C.solveTier0Ev(100, C.DEFAULTS);
    near(info0.ev, want, 0.02,
      'S2 tier0 EV 取解析解 ' + info0.ev.toFixed(2) + '（= ' + want.toFixed(2) +
      '，不再是撞到下限的 ' + C.DEFAULTS.expEvMin + '）');
    assert(info0.ev > C.DEFAULTS.expEvMin + 0.5,
      'S3 主体 100 时不撞下限（过压 1.27 档的旧行为已消除，实际 ' + info0.ev.toFixed(2) + '）');
    near(C.buildExposureLut(info0.ev)[100], C.DEFAULTS.expTargetMean, 6,
      'S4 解析解与 LUT 自洽：主体 100 经该 EV 压暗后落在目标亮度附近（' +
      C.buildExposureLut(info0.ev)[100] + ' ≈ ' + C.DEFAULTS.expTargetMean + '）');
    hT0.ctrl.unmount();
    await flush(60);
    assert(hT0.clock.count() === 0, 'S5 tier0 路径无悬挂定时器');

    // 阳性对照：旧的「闭环步进」在同一输入上确实会一路撞到下限（证明 S2/S3 不是恒真）
    let evOld = 0;
    for (let i = 0; i < 40; i++) {
      const rr = C.nextEvStep(evOld, 100, C.DEFAULTS);   // 只改存档图 → 实测恒为 100
      if (rr.step === 0) break;
      evOld = rr.ev;
    }
    near(evOld, C.DEFAULTS.expEvMin, 1e-9,
      'S6 阳性对照：闭环写法在主体 100 上确实撞到下限 ' + evOld.toFixed(2) + '（过压 ' +
      Math.abs(evOld - want).toFixed(2) + ' 档）');

    // 主体 150（现场黑白鞋那一档）→ 解析解恰好贴下限，说明 -3.0 这个值就是照 150→58 定的
    const hT1 = makeHarness({
      image: imgAt(150),
      trackOpts: { caps: { exposureMode: ['continuous'] }, settings: {} }
    });
    await boot(hT1);
    await pump(hT1.clock, 400, 5);
    near(hT1.ctrl.getExposureInfo().ev, C.DEFAULTS.expEvMin, 0.02,
      'S7 主体 150 → 解析解贴住下限 ' + hT1.ctrl.getExposureInfo().ev.toFixed(2) +
      '（正是 -3.0 这个下限值的定标场景）');
    near(C.buildExposureLut(hT1.ctrl.getExposureInfo().ev)[150], C.DEFAULTS.expTargetMean, 6,
      'S8 该 EV 下存档主体压到 ' + C.buildExposureLut(hT1.ctrl.getExposureInfo().ev)[150] +
      '（目标 ' + C.DEFAULTS.expTargetMean + '）');
    hT1.ctrl.unmount();
    await flush(60);
  })();

  /* ---------------------------------------------------------------- *
   * T. 会话级幽灵记忆（QA 观察项 U19）：换衣物不再重走无效补偿窗口
   * ---------------------------------------------------------------- */
  console.log('\n· T 会话级幽灵记忆（记账门槛 2 次；达门槛后下一件衣物直接跳过无效档）');
  await (async function () {
    // 下一件衣物进画 → release → 重新 engage，返回这一段里新产生的设备约束
    const nextCloth = async function (h, image, ms) {
      const from = h.curTrack().calls.length;
      h.setImage(SCENE.D());                 // 衣物移出画面 → release
      await pump(h.clock, 200, 5);
      h.setImage(image || SCENE.A());        // 下一件衣物入画 → 重新 engage
      await pump(h.clock, ms || 400, 5);
      return h.curTrack().calls.slice(from).map(function (c) { return c.advanced && c.advanced[0]; });
    };
    // 「还在走硬件路径」的口径：补偿值 / manual 模式 / 曝光时间 / ISO 任一出现即算
    const hwOf = function (list) {
      return list.filter(function (a) {
        return a && (typeof a.exposureCompensation === 'number' ||
          a.exposureMode === 'manual' ||
          typeof a.exposureTime === 'number' ||
          typeof a.iso === 'number');
      });
    };
    // 负补偿条数（tier1 真在压暗的证据）
    const negOf = function (list) {
      return list.filter(function (a) {
        return a && typeof a.exposureCompensation === 'number' && a.exposureCompensation < 0;
      });
    };
    const ghostLogsOf = function (h) {
      return eventsOf(h.logs, 'CAM_EXP_FALLBACK').filter(function (x) {
        return x.fields.reason === 'ghost-remembered';
      });
    };

    // ① 幽灵设备：**第一次**判无效只计证据（不记账），**第二次**才记账，
    //    第三次 engage 起跳过 tier1。中间这一次是方案① 故意多付的探测窗口，
    //    必须断言它仍然发生 —— 否则后人会把「多付一件衣物的窗口」当 bug 改回去
    const hg = makeHarness({
      config: { expEffectWindowMs: 0 },
      trackOpts: { settings: { exposureCompensation: 0, deviceId: 'ghost-cam-1' } }
    });
    await boot(hg);
    await pump(hg.clock, 400, 5);
    assert(hg.ctrl.getExposureInfo().tier === 0,
      'T1 前置：首次 engage 判无效并降级 tier0（实际 ' + hg.ctrl.getExposureInfo().tier + '）');
    // engage#2：只有 1 次证据，不到门槛 → 仍要完整重探 tier1（方案① 的代价，常驻契约）
    const calls2 = await nextCloth(hg);
    assert(negOf(calls2).length > 0 && hg.ctrl.getExposureInfo().tier === 0,
      'T2 第 2 次 engage 仍重新探测 tier1（记账门槛 2 次，这次是故意多付的窗口）：负补偿 ' +
      negOf(calls2).length + ' 次、tier=' + hg.ctrl.getExposureInfo().tier);
    assert(ghostLogsOf(hg).length === 0,
      'T2b 门槛未达时不得跳过任何档位（ghost-remembered ' + ghostLogsOf(hg).length + ' 次）');
    // 门槛达成的那次判无效必须留下 ghostStrike=2，现场能看出「这次开始记账了」
    const strikeLogs = eventsOf(hg.logs, 'CAM_EXP_FALLBACK').filter(function (x) {
      return x.fields.ghostStrike != null;
    });
    assert(strikeLogs.length === 2 && strikeLogs[0].fields.ghostStrike === 1 && strikeLogs[1].fields.ghostStrike === 2,
      'T2c 判无效日志带累计次数 ghostStrike=' +
      JSON.stringify(strikeLogs.map(function (x) { return x.fields.ghostStrike; })) + '（1 → 2，到 2 才记账）');
    // engage#3：门槛已达 → 直接跳过
    const calls3 = await nextCloth(hg);
    eq(negOf(calls3).length, 0,
      'T3 第 3 次 engage 不再下发任何负补偿（幽灵记忆生效，实际 ' + negOf(calls3).length + ' 次）');
    assert(ghostLogsOf(hg).length === 1,
      'T3b 跳过留痕恰好 1 条 CAM_EXP_FALLBACK{reason:ghost-remembered}（实际 ' + ghostLogsOf(hg).length + ' 条）');
    const remLog = ghostLogsOf(hg)[0] || { fields: {} };
    assert(remLog.fields.from === 1 && remLog.fields.tier === 0,
      'T4 留痕带原档位 from=' + remLog.fields.from + ' tier=' + remLog.fields.tier +
      '（现场可回看跳过了哪一档、落到哪一档）');
    hg.ctrl.unmount();
    await flush(60);
    assert(hg.clock.count() === 0, 'T5 幽灵记忆路径无悬挂定时器');

    // ② 好设备不受影响：从没被判过无效，第二次 engage 仍是 tier1
    const trackOk = makeExpTrack({ settings: { exposureCompensation: 0, deviceId: 'good-cam-1' } });
    // 注意：好设备必须始终是「可响应」的画面函数，换衣物时也不能换成静态图
    // （静态图在判定眼里就是幽灵设备，会把对照组自己变成实验组）
    const okImage = function () { return responsiveImage(150 * Math.pow(2, lastAppliedComp(trackOk) / 2.2)); };
    const hOk = makeHarness({
      track: trackOk,
      image: okImage,
      config: { expEffectWindowMs: 0 }
    });
    await boot(hOk);
    await pump(hOk.clock, 400, 5);
    assert(hOk.ctrl.getExposureInfo().tier === 1, 'T6 好设备首次 engage 停在 tier1');
    hOk.setImage(SCENE.D());
    await pump(hOk.clock, 200, 5);
    hOk.setImage(okImage);
    await pump(hOk.clock, 200, 5);
    assert(hOk.ctrl.getExposureInfo().tier === 1,
      'T7 好设备第二次 engage 仍是 tier1（记忆只记「实测无效」，不误伤）');
    assert(reasonsOf(hOk.logs, 'CAM_EXP_FALLBACK').indexOf('ghost-remembered') < 0,
      'T8 好设备不产生 ghost-remembered 日志');
    hOk.ctrl.unmount();
    await flush(60);

    // ③ 换设备即失效：另一台机器的同一档位可能好使，不能串档
    const hSwap = makeHarness({
      config: { expEffectWindowMs: 0 },
      trackOpts: { settings: { exposureCompensation: 0, deviceId: 'ghost-cam-2' } }
    });
    await boot(hSwap);
    await pump(hSwap.clock, 400, 5);
    assert(hSwap.ctrl.getExposureInfo().tier === 0, 'T9 前置：A 机判无效并降级 tier0');
    // 攒够 2 次证据（engage#2）再换设备，否则「记忆失效」这条会变成恒真
    await nextCloth(hSwap);
    assert(ghostLogsOf(hSwap).length === 0 && hSwap.ctrl.getExposureInfo().tier === 0,
      'T9b 前置：A 机累计 2 次判无效已记账门槛（此时尚未跳过，ghost-remembered ' +
      ghostLogsOf(hSwap).length + ' 次）');
    hSwap.track.settings.deviceId = 'other-cam-9';   // 换了一台摄像头
    const enumsBefore = eventsOf(hSwap.logs, 'CAM_EXP_ENUM').length;
    const callsSwap = await nextCloth(hSwap);
    const newEnums = eventsOf(hSwap.logs, 'CAM_EXP_ENUM').slice(enumsBefore);
    assert(newEnums.length > 0 && newEnums[0].fields.tier === 1,
      'T10 换设备后记忆（含计数）失效，重新从 tier1 探测（实际 ' +
      JSON.stringify(newEnums.map(function (x) { return x.fields.tier; })) + '，负补偿 ' +
      negOf(callsSwap).length + ' 次）');
    hSwap.ctrl.unmount();
    await flush(60);

    /* ④ DEF-3（QA 第 2 轮）：双档幽灵设备 —— tier1/tier2 都被实测判过无效时，
       第二次 engage 必须把**两档一起**跳过，而不是只跳过先探测到的那一档。
       只跳一档的话 tier2 仍会被完整重走（实测仍下发 6 次 manual 约束、耗时 3.5s） */
    const capsBoth = {
      exposureCompensation: { min: -3, max: 3, step: 0.1 },
      exposureMode: ['manual', 'continuous'],
      exposureTime: { min: 10, max: 1000, step: 1 }
    };
    const hBoth = makeHarness({
      config: { expEffectWindowMs: 0 },
      trackOpts: {
        caps: capsBoth,
        settings: { exposureCompensation: 0, exposureTime: 500, deviceId: 'ghost-cam-3' }
      }
    });
    await boot(hBoth);
    await pump(hBoth.clock, 800, 5);
    assert(hBoth.ctrl.getExposureInfo().tier === 0,
      'T11 前置：双档幽灵设备首件衣物走完 tier1→tier2→tier0（实际 ' +
      hBoth.ctrl.getExposureInfo().tier + '）');
    const enumsBoth = eventsOf(hBoth.logs, 'CAM_EXP_ENUM').map(function (x) { return x.fields.tier; });
    assert(enumsBoth.join(',') === '1,2',
      'T11b 首件衣物两个硬件档都被枚举过（ENUM=' + enumsBoth.join(',') + '）');
    // engage#2：每档证据都才 1 次，不到门槛 → 两档仍要完整重走（方案① 的代价）
    const callsB2 = await nextCloth(hBoth, SCENE.A(), 800);
    assert(hwOf(callsB2).length > 0 && hBoth.ctrl.getExposureInfo().tier === 0,
      'T12 第 2 次 engage 仍重走两个硬件档（记账门槛 2 次，这次是故意多付的窗口）：硬件约束 ' +
      hwOf(callsB2).length + ' 条、tier=' + hBoth.ctrl.getExposureInfo().tier);
    // engage#3：两档都达门槛 → 一起跳过，零硬件补偿约束
    const callsB3 = await nextCloth(hBoth, SCENE.A(), 800);
    assert(hwOf(callsB3).length === 0 && hBoth.ctrl.getExposureInfo().tier === 0,
      'T12b 第 3 次 engage 两档一起跳过：零硬件补偿约束（' + hwOf(callsB3).length +
      ' 条；manual ' + callsB3.filter(function (a) { return a && a.exposureMode === 'manual'; }).length +
      '、负补偿 ' + negOf(callsB3).length +
      '、tier=' + hBoth.ctrl.getExposureInfo().tier + '）');
    assert(ghostLogsOf(hBoth).length >= 1,
      'T12c 双档跳过留痕（ghost-remembered ' + ghostLogsOf(hBoth).length + ' 条）');
    hBoth.ctrl.unmount();
    await flush(60);
    assert(hBoth.clock.count() === 0, 'T13 双档跳过路径无悬挂定时器');

    /* ⑤ DEF-4（QA 第 2 轮）：设备标识不能只认 deviceId。
       拿不到 deviceId 的两台设备若共用同一个空串槽，`devId !== expGhost.dev` 恒为假
       → 记忆永不清空 → 好设备被上一台幽灵设备的记录挡在硬件补偿之外。
       兜底链：deviceId → track.id → track.label → track 实例号 */
    const hNoId = makeHarness({
      config: { expEffectWindowMs: 0 },
      trackOpts: { settings: { exposureCompensation: 0 } }   // 故意不给 deviceId
    });
    await boot(hNoId);
    await pump(hNoId.clock, 800, 5);
    assert(hNoId.ctrl.getExposureInfo().tier === 0,
      'T14 前置：无 deviceId 的幽灵设备首件衣物仍降级 tier0（实际 ' +
      hNoId.ctrl.getExposureInfo().tier + '）');
    const callsN2 = await nextCloth(hNoId, SCENE.A(), 800);
    assert(negOf(callsN2).length > 0,
      'T14b 无 deviceId 同样受记账门槛约束：第 2 次 engage 仍在探测（负补偿 ' +
      negOf(callsN2).length + ' 次）');
    const callsN3 = await nextCloth(hNoId, SCENE.A(), 800);
    const negNoId = negOf(callsN3);
    // 这条同时钉住「engage 侧与记忆侧必须同源」：engage 若改回直接读 settings.deviceId
    // （拿不到就是空串），与记忆侧的 track#N 永远不相等，记忆会被自己清空
    assert(negNoId.length === 0 && hNoId.ctrl.getExposureInfo().tier === 0,
      'T15 无 deviceId 时记忆照样生效：第二次 engage 零负补偿（实际 ' + negNoId.length + ' 次）');
    hNoId.ctrl.unmount();
    await flush(60);

    // label 兜底：换了一台同样不上报 deviceId 的摄像头（label 变化）→ 记忆必须失效
    const trackLbl = makeExpTrack({ settings: { exposureCompensation: 0 } });
    trackLbl.label = 'USB Camera A';
    const lblImage = function () { return responsiveImage(150 * Math.pow(2, lastAppliedComp(trackLbl) / 2.2)); };
    const hLbl = makeHarness({ track: trackLbl, image: SCENE.A(), config: { expEffectWindowMs: 0 } });
    await boot(hLbl);
    await pump(hLbl.clock, 800, 5);
    assert(hLbl.ctrl.getExposureInfo().tier === 0,
      'T16 前置：A 机（无 deviceId，仅有 label）判无效降级 tier0（实际 ' +
      hLbl.ctrl.getExposureInfo().tier + '）');
    // 先在这台机器上攒够 2 次证据（engage#2），否则「记忆失效」无从谈起
    await nextCloth(hLbl, SCENE.A(), 800);
    assert(hLbl.ctrl.getExposureInfo().tier === 0,
      'T16b 前置：A 机两次判无效（已记账门槛，仍停在 tier0）');
    trackLbl.label = 'USB Camera B';            // 换了一台摄像头
    hLbl.setImage(SCENE.D());
    await pump(hLbl.clock, 200, 5);
    hLbl.setImage(lblImage);                    // 新设备是好设备
    const enumsLblBefore = eventsOf(hLbl.logs, 'CAM_EXP_ENUM').length;
    await pump(hLbl.clock, 200, 5);
    const newEnumsLbl = eventsOf(hLbl.logs, 'CAM_EXP_ENUM').slice(enumsLblBefore);
    assert(newEnumsLbl.length > 0 && newEnumsLbl[0].fields.tier === 1,
      'T17 label 变化（另一台同样无 deviceId 的摄像头）→ 记忆失效，重新从 tier1 探测（实际 ' +
      JSON.stringify(newEnumsLbl.map(function (x) { return x.fields.tier; })) + '）');
    hLbl.ctrl.unmount();
    await flush(60);
    assert(hLbl.clock.count() === 0, 'T18 兜底身份路径无悬挂定时器');

    // 连 label 都拿不到时按 track 实例发号兜底（真实换设备必然换 track 对象）
    const ctrlSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'camera-controller.js'), 'utf8');
    assert(/__expUid\s*==\s*null/.test(ctrlSrc) && /ghostUidSeq/.test(ctrlSrc),
      'T19 连 label 也拿不到时按 track 实例发号兜底（不落共享空串槽）');

    /* ⑥ 最严格的一版：换**真的另一台**摄像头（流里挂的 track 换成另一个对象），
       且两台都既没有 deviceId 也没有 label —— 只能靠 track 实例号区分。
       双向：正向「B 机不被 A 机的记录挡住」，反向「A 机自己的记录仍然命中」
       （反向这条专门防 devIdOf 恒返回随机串那类变异：随机串会让「不串档」通过，
       但会让「自己命中」失败） */
    const trackA = makeExpTrack({ settings: { exposureCompensation: 0 } });   // 无 deviceId / id / label
    const hTwo = makeHarness({ track: trackA, config: { expEffectWindowMs: 0 } });
    await boot(hTwo);
    await pump(hTwo.clock, 800, 5);
    assert(hTwo.ctrl.getExposureInfo().tier === 0,
      'T20 前置：A 机（无任何标识）判无效降级 tier0（实际 ' + hTwo.ctrl.getExposureInfo().tier + '）');
    // engage#2：攒够 2 次证据（这次仍要探测）
    const callsA2 = await nextCloth(hTwo, SCENE.A(), 800);
    assert(negOf(callsA2).length > 0 && hTwo.ctrl.getExposureInfo().tier === 0,
      'T20a 第 2 次 engage 仍在探测（门槛 2 次，负补偿 ' + negOf(callsA2).length + ' 次）');
    // 反向：还在 A 机上，第 3 件衣物必须走记忆（自己命中）
    const callsA3 = await nextCloth(hTwo, SCENE.A(), 800);
    assert(negOf(callsA3).length === 0 && hTwo.ctrl.getExposureInfo().tier === 0,
      'T20b 反向：A 机自己的记录在自己的会话里仍然命中（零负补偿，实际 ' + negOf(callsA3).length +
      ' 次；若 devIdOf 恒返回随机串这条会红）');
    // 正向：换到 B 机（另一个 track 对象、同样无任何标识、好设备）
    // 必须先让衣物移出画面触发 release，否则还停在 A 机的 ACTIVE 会话里，换了 track
    // 也不会重新 engage（记忆根本没机会被读）
    hTwo.setImage(SCENE.D());
    await pump(hTwo.clock, 200, 5);
    const trackB = makeExpTrack({ settings: { exposureCompensation: 0 } });
    hTwo.setTrack(trackB);
    hTwo.setImage(function () { return responsiveImage(150 * Math.pow(2, lastAppliedComp(trackB) / 2.2)); });
    await pump(hTwo.clock, 800, 5);
    assert(hTwo.ctrl.getExposureInfo().tier === 1,
      'T21 换摄像头（新 track 对象、同样无任何标识）→ 记忆按设备隔离，B 机正常拿到 tier1（实际 tier=' +
      hTwo.ctrl.getExposureInfo().tier + '）');
    hTwo.ctrl.unmount();
    await flush(60);
    assert(hTwo.clock.count() === 0, 'T22 换 track 路径无悬挂定时器');
  })();

  /* ---------------------------------------------------------------- *
   * M. 渲染层静态契约（§8.5 / §8.6 / §8.7）
   * ---------------------------------------------------------------- */
  console.log('\n· M 渲染层静态契约扫描');
  {
    const rSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'styles.css'), 'utf8');

    assert(/function\s+sampleExposureGrid/.test(rSrc), 'M1 渲染层有整帧降采样采样器 sampleExposureGrid');
    assert(/ctx\.drawImage\(video,\s*0,\s*0,\s*vw,\s*vh,\s*0,\s*0,\s*side,\s*side\)/.test(rSrc),
      'M2 采样器把整帧缩到 side×side（不是取中心）');
    assert(/gridSampler:\s*sampleExposureGrid/.test(rSrc), 'M3 注入 gridSampler');
    assert(/pageVisible:\s*\(\)\s*=>\s*!document\.hidden/.test(rSrc), 'M4 注入 pageVisible（页面可见性）');
    assert(/focusBusy:\s*\(\)\s*=>\s*focusPulseBusy/.test(rSrc), 'M5 注入 focusBusy（对焦脉冲）');
    assert(/exposureAssistEnabled:\s*\(\)\s*=>\s*window\.__xqyExposureAssist\s*!==\s*false/.test(rSrc),
      'M6 总开关走 window.__xqyExposureAssist !== false');
    assert(/exposure-badge/.test(rSrc) && /class="exposure-badge"/.test(rSrc), 'M7 拍照操作条有曝光徽标');
    assert(/onExposureChange/.test(rSrc), 'M8 渲染层订阅 onExposureChange');
    assert(/buildExposureLut/.test(rSrc), 'M9 拍照路径有软件兜底 LUT');

    // 时序：LUT 必须在 drawImage 之后、drawTimeWatermark 之前
    const capStart = rSrc.indexOf('async function capture()');
    assert(capStart > 0, 'M10 能定位 capture()');
    const capEnd = rSrc.indexOf('function removeShot', capStart);
    const capBody = rSrc.slice(capStart, capEnd > 0 ? capEnd : capStart + 8000);
    const iLut = capBody.indexOf('buildExposureLut');
    const iWm = capBody.indexOf('drawTimeWatermark');
    const iDraw = capBody.indexOf('ctx.drawImage(v, 0, 0)');
    assert(iDraw >= 0 && iLut > iDraw, 'M11 软件兜底在 drawImage 之后（压暗的是存档图）');
    assert(iWm > iLut, 'M12 软件兜底在水印之前（时间戳始终是醒目白色）');
    assert(/expInfo\.tier === 0/.test(capBody), 'M13 软件兜底只在 tier0 生效（硬件档预览与存档一致）');
    assert(/expInfo\.state === 'ACTIVE'/.test(capBody), 'M14 软件兜底只在 ACTIVE 生效');

    assert(/\.exposure-badge\s*\{/.test(cssSrc), 'M15 styles.css 有 .exposure-badge');
    assert(/\.exposure-badge\.ok\s*\{/.test(cssSrc) && /\.exposure-badge\.warn\s*\{/.test(cssSrc),
      'M16 徽标两档样式（ok / warn）齐备');
    assert(/--success-soft/.test(cssSrc) && /--warning-soft/.test(cssSrc), 'M17 徽标复用既有语义色变量');

    // 控制器边界：不碰 DOM / localStorage
    const cSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'camera-controller.js'), 'utf8');
    // 先剥掉注释再扫：注释里为了说明「禁止碰 localStorage」会提到它，那不是代码
    const cCode = cSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    assert(!/\bdocument\./.test(cCode), 'M18 控制器不读 document（页面可见性走注入）');
    assert(!/\blocalStorage\b/.test(cCode), 'M19 控制器不碰 localStorage（读写一律注入）');
  }

  /* ---------------------------------------------------------------- *
   * N. 事件白名单与日志字段纪律（§9.5）
   * ---------------------------------------------------------------- */
  console.log('\n· N 事件白名单与日志字段纪律');
  {
    const vSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-camera.js'), 'utf8');
    const m = vSrc.match(/const ENUM = \[([\s\S]*?)\];/);
    assert(!!m, 'N1 verify-camera.js 里能读到 ENUM 白名单');
    const ENUM = (m ? m[1] : '').match(/'CAM_[A-Z_]+'/g) || [];
    const enumList = ENUM.map(function (s) { return s.replace(/'/g, ''); });
    const NEW_EVENTS = ['CAM_EXP_ENUM', 'CAM_EXP_ENGAGE', 'CAM_EXP_STEP', 'CAM_EXP_RELEASE',
      'CAM_EXP_RESTORE', 'CAM_EXP_SKIP', 'CAM_EXP_FALLBACK', 'CAM_EXP_BLACKGATE', 'CAM_EXP_OVERPRESS'];
    const missing = NEW_EVENTS.filter(function (e) { return enumList.indexOf(e) < 0; });
    assert(missing.length === 0, 'N2 8 个 CAM_EXP_* 事件全部登记进 ENUM（缺：' + (missing.join(',') || '无') + '）');

    // 源码里用到的事件必须都在白名单内（静态扫描，与 verify-camera.js 第 23 组同源）
    const used = new Set();
    ['renderer/renderer.js', 'renderer/camera-controller.js'].forEach(function (f) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      let mm;
      const re = /'CAM_[A-Z_]+'/g;
      while ((mm = re.exec(src)) !== null) used.add(mm[0].replace(/'/g, ''));
    });
    const stray = Array.from(used).filter(function (e) { return enumList.indexOf(e) < 0; }).sort();
    assert(stray.length === 0, 'N3 源码中不存在未登记的 CAM_* 事件（越界：' + (stray.join(',') || '无') + '）');

    // 运行期：跑一遍完整链路，逐条核对字段纪律
    const logSrc = fs.readFileSync(path.join(ROOT, 'main', 'camera-log.js'), 'utf8');
    const fixed = logSrc.match(/const FIXED_KEYS = \[([^\]]+)\]/)[1]
      .split(',').map(function (s) { return s.trim().replace(/^['"]|['"]$/g, ''); });
    const h = makeHarness({ gray: new Array(64 * 64).fill(5) });
    await boot(h);
    await pump(h.clock, 150, 5);
    h.ctrl.isBlackFrame(h.video);        // 触发门控放行
    h.setImage(SCENE.D());
    await pump(h.clock, 200, 5);         // 触发 release / restore
    h.setImage(SCENE.C());
    await pump(h.clock, 60, 5);
    h.ctrl.unmount();
    await flush(60);

    const expLogs = h.logs.filter(function (x) { return x.event.indexOf('CAM_EXP_') === 0; });
    assert(expLogs.length > 0, 'N4 完整生命周期产生 ' + expLogs.length + ' 条 CAM_EXP_* 日志');
    let badExtra = 0;
    let badType = 0;
    let badEvent = 0;
    expLogs.forEach(function (x) {
      if (enumList.indexOf(x.event) < 0) badEvent++;
      const extra = Object.keys(x.fields).filter(function (k) { return fixed.indexOf(k) < 0; });
      if (extra.length > 6) badExtra++;
      extra.forEach(function (k) {
        const v = x.fields[k];
        if (!(v === null || ['string', 'number', 'boolean'].indexOf(typeof v) >= 0)) badType++;
      });
    });
    assert(badEvent === 0, 'N5 CAM_EXP_* 事件名全部在 ENUM 内');
    assert(badExtra === 0, 'N6 附加字段 ≤ 6 个（main/camera-log.js MAX_EXTRA_KEYS）');
    assert(badType === 0, 'N7 附加字段均为原始类型（对象/数组会被主进程丢弃）');
    assert(expLogs.every(function (x) { return ['info', 'warn', 'error'].indexOf(x.level) >= 0; }), 'N8 level 仅 info/warn/error');
    assert(h.clock.count() === 0, 'N9 整轮结束后无悬挂定时器');
  }

  /* ---------------------------------------------------------------- *
   * W. 缺陷 1：压暗导致检测闸门自杀（整帧暗化 → 亮垫板跌破高亮阈值）
   * ---------------------------------------------------------------- */
  console.log('\n· W 缺陷 1：压暗导致检测闸门自杀（整帧暗化还原）');
  {
    // 整帧随已下发补偿变暗（真实设备行为：曝光补偿压暗整帧，含亮垫板）。
    // ev<0 → 因子 <1 → 整帧变暗。缺陷 1 的修复：ACTIVE 且已介入负补偿时，
    // 参与判定闸门的亮度按曝光偏移还原回中性刻度（只还原亮参照格与场景均值）。
    function lastAppliedComp(track) {
      for (let i = track.calls.length - 1; i >= 0; i--) {
        const a = track.calls[i] && track.calls[i].advanced && track.calls[i].advanced[0];
        if (a && typeof a.exposureCompensation === 'number') return a.exposureCompensation;
      }
      return 0;
    }
    function darkeningImage(track, subjectMean, padMean) {
      return function () {
        const ev = lastAppliedComp(track);
        const f = Math.pow(2, ev / 2.2);
        return makeImage(function (cx, cy) {
          const inCenter = cy >= 2 && cy <= 4 && cx >= 2 && cx <= 5;
          const below = (cy === 5 || cy === 6) && cx >= 1 && cx <= 5;
          const base = (inCenter || below) ? subjectMean : padMean;
          const v = Math.max(0, Math.min(255, Math.round(base * f)));
          return [v, v, v];
        });
      };
    }
    const subjN = 150, padN = 210;
    const trackW = makeExpTrack();
    const hW = makeHarness({
      track: trackW,
      image: darkeningImage(trackW, subjN, padN),
      config: { expEffectWindowMs: 0 }
    });
    await boot(hW);
    // 注入负补偿前，先确认中性帧能正常 engage（subject 150≤185、pad 210>185、均值>45）
    await pump(hW.clock, 60, 5);
    assert(hW.ctrl.getExposureInfo().state === 'ACTIVE', 'W1 整帧暗化模型下中性帧正常 engage 进入 ACTIVE');
    // 推多帧，闭环把 ev 压到负值，整帧被压暗
    await pump(hW.clock, 400, 5);
    const infoW = hW.ctrl.getExposureInfo();
    // 关键：即使负补偿把整帧（含亮垫板）压暗，闸门也不该自杀 → 不会反复 RESTORE/ENGAGE 振荡
    const engageCntW = eventsOf(hW.logs, 'CAM_EXP_ENGAGE').length;
    assert(engageCntW === 1, 'W2 整帧被压暗后没有「engage→release→再 engage」振荡（CAM_EXP_ENGAGE 仅 1 次，实际 ' + engageCntW + '）');
    // 闭环确实在压暗（实测主体亮度被压低，证明是「真变暗」，不是静态帧）
    assert(infoW.subjectMean != null && infoW.subjectMean < subjN - 10,
      'W3 闭环确实把主体压暗了（实测主体 ' + (infoW.subjectMean == null ? 'null' : infoW.subjectMean.toFixed(1)) + ' < 中性 ' + subjN + '）');
    // 闸门自杀的判据：未翻转场景却自行 release（无 flip 的 release 才是自杀）
    const releaseLogsW = eventsOf(hW.logs, 'CAM_EXP_RELEASE');
    assert(releaseLogsW.length === 0, 'W4 未翻转场景却无「自杀式」自行 release（release 次数 ' + releaseLogsW.length + '，应为 0）');
    hW.ctrl.unmount();
    await flush(60);
    assert(hW.clock.count() === 0, 'W5 无悬挂定时器');
  }

  /* ---------------------------------------------------------------- *
   * X. 缺陷 2：tier2 过压设备（执行时间比请求更短 → 实际压暗超出请求）
   * ---------------------------------------------------------------- */
  console.log('\n· X 缺陷 2：tier2 过压设备（实际压暗深度超出请求）');
  {
    // 过压设备：tier2 手动曝光路径，设备实际执行时间比请求的更短（时间下限 / 量化 /
    // 单位解释都可能），实际压暗比请求深 overDepth EV。闭环假设「请求 ev = 实际 ev」
    // 1:1，看到过暗就往回加 ev → bang-bang 振荡。修复：每步用实测主体亮度反推实际
    // 生效 EV，与请求比对，超容差记过压设备并收紧 ev 下限；徽标诚实展示实际 EV。
    // （overPressImage / lastAppliedTime 已提升为共享辅助 —— Z 组复用同一模型验证
    //   「过压不被崩塌守卫误判」，两份实现必然漂移，故只保留一份）
    const baseTime = 1000, overDepth = 2.0;
    const subjN = 150, padN = 210;
    const trackX = makeExpTrack({
      caps: { exposureMode: ['manual', 'continuous'], exposureTime: { min: 10, max: 100000 } },
      settings: { exposureTime: baseTime }
    });
    const hX = makeHarness({
      track: trackX,
      image: overPressImage(trackX, baseTime, overDepth, subjN, padN),
      config: { expEffectWindowMs: 0 }
    });
    await boot(hX);
    // 缺陷 3 起 engage 也记 lastApplyAt（模式切换后要先等 settle 再测帧，否则崩塌守卫
    // 会拿到过渡帧）。首步因此晚 250ms，过压需要两次间隔 500ms 的实测才记账，
    // 窗口从 600ms 放宽到 1400ms；断言本身不变
    await pump(hX.clock, 1400, 5);
    const infoX = hX.ctrl.getExposureInfo();
    // ① 过压被检出：打出 CAM_EXP_OVERPRESS（reason: over-press）
    const overLogs = eventsOf(hX.logs, 'CAM_EXP_OVERPRESS');
    assert(overLogs.length >= 1 && overLogs[0].fields.reason === 'over-press',
      'X1 过压设备被打上 CAM_EXP_OVERPRESS（reason=over-press，实际 ' + overLogs.length + ' 条）');
    // ② 徽标诚实展示「实际生效 EV」——比请求的更深（appliedEv 由实测亮度反推，非钳位请求 ev）
    assert(typeof infoX.appliedEv === 'number' && isFinite(infoX.appliedEv) && infoX.appliedEv < infoX.ev - 0.5,
      'X2 徽标诚实展示过压深度（appliedEv=' + infoX.appliedEv.toFixed(2) + ' 比请求 ev=' + infoX.ev.toFixed(2) + ' 深 ≥0.5EV）');
    // ③ 闭环不再往更深（只会被设备再压更深）处请求：ev 被钳在可达深度（evFloor）之上，不冲到 -3 停在过暗态
    assert(infoX.ev >= -1.6,
      'X3 请求 ev 被钳在可达深度之上（ev=' + infoX.ev.toFixed(2) + '，未一路冲到 -3 后停在过暗态）');
    hX.ctrl.unmount();
    await flush(60);
    assert(hX.clock.count() === 0, 'X4 无悬挂定时器');
  }

  /* ---------------------------------------------------------------- *
   * Y. QA F1：tier0（软件压暗）徽标必须显示解析解 EV，不残留硬件档实测值
   * ---------------------------------------------------------------- */
  console.log('\n· Y QA F1：tier0 徽标显示软件解析解，不残留硬件档实测 EV');
  {
    // 只报 exposureCompensation、无 manual 能力，且画面不随约束变化（幽灵）→
    // 走完 tier1 判无效 → 降级 tier0。tier1 阶段 actualEv 被实测反推记为 ≈0；
    // 若 tier0 不清零/不更新 actualEv，徽标会把「软件压暗」显示成那个残留值（0.0EV），
    // 与拍照时真正下发的解析解（solveTier0Ev）不符——用户看到的档位是假的。
    const capsCompOnly = { exposureCompensation: { min: -3, max: 3, step: 0.1 } };
    const hY = makeHarness({
      config: { expEffectWindowMs: 0 },
      trackOpts: { caps: capsCompOnly, settings: { exposureCompensation: 0, deviceId: 'ghost-cam-tier0' } }
    });
    await boot(hY);
    await pump(hY.clock, 800, 5);
    const infoY = hY.ctrl.getExposureInfo();
    assert(infoY.tier === 0,
      'Y1 前置：tier1 幽灵设备判无效后降级 tier0（实际 tier=' + infoY.tier + '）');
    const solvedY = C.solveTier0Ev(infoY.subjectMean, {});
    assert(solvedY != null && solvedY < 0,
      'Y2 前置：tier0 解析解存在且为负（' + (solvedY == null ? 'null' : solvedY.toFixed(2)) + 'EV）');
    assert(Math.abs(infoY.ev - solvedY) < 1e-9,
      'Y3 tier0 的 ev 即软件解析解（ev=' + infoY.ev.toFixed(3) + '，解析解=' + solvedY.toFixed(3) + '）');
    assert(typeof infoY.appliedEv === 'number' && isFinite(infoY.appliedEv) &&
      Math.abs(infoY.appliedEv - solvedY) < 1e-9,
      'Y4 徽标口径：tier0 的 appliedEv 也是解析解，不残留 tier1 阶段的实测值' +
      '（appliedEv=' + infoY.appliedEv.toFixed(3) + '，解析解=' + solvedY.toFixed(3) +
      '；残留值会是 tier1 实测的 ≈0）');
    hY.ctrl.unmount();
    await flush(60);
    assert(hY.clock.count() === 0, 'Y5 无悬挂定时器');
  }

  /* ---------------------------------------------------------------- *
   * Z. 缺陷 3：画面崩塌守卫 / tier1 min>=0 诚实化 / 零调整安全网
   *    （v1.2.15 现场：HB-HD Camera eba4:dc26，闭环每 3s 无限振荡）
   * ---------------------------------------------------------------- */
  console.log('\n· Z 缺陷 3：画面崩塌守卫（现场 -7.5EV → 闭环死循环）');
  await (async function () {
    /* ---- Z1 纯函数：exposureCompensation.min >= 0 的设备不选 tier1（F4 诚实化）---- */
    // UVC 设备报 {min:0,max:15} 表示「只能提亮」。这类设备上 buildExposureConstraints
    // 会把任何负 ev 钳回 0 —— 约束发出去、画面一点不变，正是幽灵能力的形态。
    // min>=0 时直接不走这条路径：功能与旧的「钳到 0」完全一致，只是不再装看不出来
    eq(C.pickExposurePlan({ exposureCompensation: { min: 0, max: 15, step: 1 } }, { exposureCompensation: 0 }).tier, 0,
      'Z1 只报正补偿（min:0）的设备不选 tier1（负 ev 会被钳回 0，发了等于没发）');
    eq(C.pickExposurePlan({
      exposureCompensation: { min: 0, max: 15, step: 1 },
      exposureMode: ['manual', 'continuous'],
      exposureTime: { min: 10, max: 100000 }
    }, { exposureTime: 1000 }).tier, 2,
      'Z1b min>=0 但有 manual 能力的设备仍落 tier2（manual 才是真能压暗的路径，不误伤）');
    eq(C.pickExposurePlan({ exposureCompensation: { min: -3, max: 3, step: 0.1 } }, { exposureCompensation: 0 }).tier, 1,
      'Z1c 有负补偿能力的设备仍选 tier1（诚实化不误伤正常设备）');

    /* ---- Z2 集成：min>=0 设备 engage 即落 tier0，且从未下发过 tier1 约束 ---- */
    const trackMin0 = makeExpTrack({
      caps: { exposureCompensation: { min: 0, max: 15, step: 1 } },
      settings: { exposureCompensation: 0, deviceId: 'min0-cam' }
    });
    const hMin0 = makeHarness({ track: trackMin0, config: { expEffectWindowMs: 0 } });
    await boot(hMin0);
    await pump(hMin0.clock, 300, 5);
    const infoMin0 = hMin0.ctrl.getExposureInfo();
    eq(infoMin0.tier, 0, 'Z2 只报正补偿的设备 engage 即落 tier0（实际 tier=' + infoMin0.tier + '）');
    const compCalls0 = trackMin0.calls.filter(function (c) {
      const a = c.advanced && c.advanced[0];
      return a && typeof a.exposureCompensation === 'number';
    });
    eq(compCalls0.length, 0,
      'Z2b 全程未下发任何 exposureCompensation 约束（' + compCalls0.length +
      ' 次）——旧实现会把负 ev 钳成 0 发出去，白付每件衣物 4.3s 探测窗口');
    assert(reasonsOf(hMin0.logs, 'CAM_EXP_ENUM').indexOf('unsupported') >= 0,
      'Z2c ENUM 如实记录 tier0 原因 unsupported（现场可从日志看出「这台设备没有可用硬件路径」）');
    hMin0.ctrl.unmount();
    await flush(60);
    assert(hMin0.clock.count() === 0, 'Z2d 无悬挂定时器');

    /* ---- Z3 集成：tier2 切 manual 后帧崩到请求无法解释的深度 → 守卫命中降级 ---- */
    const trackZ = makeExpTrack({
      caps: { exposureMode: ['manual', 'continuous'], exposureTime: { min: 10, max: 100000 } },
      settings: { exposureTime: 1000, deviceId: 'collapse-cam' }
    });
    // 现场形态有两点必须复刻，少一点都测不出真故障：
    // ① 崩塌与「设备处在 manual 模式」绑定，而不是与某一次 apply 绑定 —— restore 切回
    //    continuous 后画面会恢复，于是形成「engage→崩→release→再 engage→再崩」的无限
    //    振荡（v1.2.14 全天 87 次 engage / 86 次零 STEP 就是这么来的）。若把崩塌写成
    //    一次性 latch，振荡根本不会发生，「无振荡」断言会变成恒真
    // ② 崩塌是**非均匀**的：亮垫板几乎全灭、衣物只掉一半。均匀崩塌会被缺陷 1 的整帧
    //    还原机制完美抵消（还原系数恰为 1/f），闸门照样命中 —— 现场日志里的反转形态
    //    是 subject-too-small（还原系数≈6.2 后衣物格 adjMean≈460 > 185 → 主体格判失），
    //    只有非均匀崩塌能把它造出来
    let zInManual = false;
    const rawApplyZ = trackZ.applyConstraints.bind(trackZ);
    trackZ.applyConstraints = function (cst) {
      const p = rawApplyZ(cst);
      const a = cst && cst.advanced && cst.advanced[0];
      if (a && a.exposureMode === 'manual') zInManual = true;
      if (a && a.exposureMode === 'continuous') zInManual = false;   // restore 切回连续
      return p;
    };
    function collapseGrid() {
      return makeImage(function (cx, cy) {
        const inCenter = cy >= 2 && cy <= 4 && cx >= 2 && cx <= 5;
        const below = (cy === 5 || cy === 6) && cx >= 1 && cx <= 5;
        const base = (inCenter || below) ? PAL.grey : PAL.pad;
        // 衣物（灰 150）掉到 47%、垫板（亮黄）几乎全灭（2.2%）——现场 HB-HD Camera
        // continuous→manual 后 203 → 19（≈-7.6EV）且亮部/暗部衰减不同步的形态
        const f = (inCenter || below) ? 0.47 : 0.022;
        return base.map(function (v) { return Math.max(0, Math.round(v * f)); });
      });
    }
    const hZ = makeHarness({
      track: trackZ,
      image: function () { return zInManual ? collapseGrid() : SCENE.A(); },
      config: { expEffectWindowMs: 0 }
    });
    await boot(hZ);
    // 逐周期推进到崩塌命中为止（再等约 40ms 画面持续不命中就会正常 release，
    // 必须先抓住命中瞬间的状态）
    let fbZ = [];
    for (let i = 0; i < 80 && fbZ.length === 0; i++) {
      await pump(hZ.clock, 5, 5);
      fbZ = eventsOf(hZ.logs, 'CAM_EXP_FALLBACK').filter(function (x) {
        return x.fields.reason === 'frame-collapse';
      });
    }
    const infoZ = hZ.ctrl.getExposureInfo();
    assert(fbZ.length === 1,
      'Z3 崩塌被守卫检出：恰好 1 条 CAM_EXP_FALLBACK{reason:frame-collapse}（实际 ' + fbZ.length + ' 条）');
    eq(infoZ.tier, 0, 'Z3b 崩塌后立刻落 tier0（实际 tier=' + infoZ.tier + '）');
    assert(eventsOf(hZ.logs, 'CAM_EXP_ENUM').some(function (x) {
      return x.fields.tier === 0 && x.fields.reason === 'frame-collapse';
    }), 'Z3c ENUM 记录 tier0 reason=frame-collapse（现场可回看「为什么掉了硬件档」）');
    const rsZ = eventsOf(hZ.logs, 'CAM_EXP_RESTORE').filter(function (x) {
      return x.fields.reason === 'frame-collapse';
    });
    assert(rsZ.length === 1 && rsZ[0].fields.ok === true,
      'Z3d 崩塌后立刻还原（CAM_EXP_RESTORE{reason:frame-collapse,ok:true}，实际 ' + rsZ.length + ' 条）');
    assert(eventsOf(hZ.logs, 'CAM_EXP_ENGAGE').length === 1 && eventsOf(hZ.logs, 'CAM_EXP_RELEASE').length === 0,
      'Z3e 无振荡：ENGAGE 仅 1 次、RELEASE 0 次（缺陷未修复时是每 3s 一次的 engage/release 循环）');
    eq(infoZ.state, 'ACTIVE',
      'Z3f 会话保持 ACTIVE 不 release（避免「还原→冷却→再 engage→再崩」的二次闪跳，实际 ' + infoZ.state + '）');
    // 崩塌日志的字段纪律：非固定键 ≤6（refMean/rawMean/floorMean 是现场定位「崩了多少」的唯一依据）
    const fixedKeys = ['ts', 'level', 'event', 'seq', 'device', 'attempt', 'reason', 'err', 'res'];
    const extraZ = fbZ.length ? Object.keys(fbZ[0].fields).filter(function (k) {
      return fixedKeys.indexOf(k) < 0;
    }) : [];
    assert(extraZ.length > 0 && extraZ.length <= 6,
      'Z3g 崩塌日志附加字段 ≤6 个（实际 ' + extraZ.length + '：' + extraZ.join(',') + '）');
    assert(fbZ.length && fbZ[0].fields.rawMean < fbZ[0].fields.floorMean &&
      fbZ[0].fields.floorMean < fbZ[0].fields.refMean,
      'Z3h 崩塌日志数值自洽：rawMean(' + (fbZ.length ? fbZ[0].fields.rawMean : '?') + ') < floorMean(' +
      (fbZ.length ? fbZ[0].fields.floorMean : '?') + ') < refMean(' + (fbZ.length ? fbZ[0].fields.refMean : '?') + ')');
    eq(fbZ.length ? fbZ[0].fields.ghostStrike : 0, 1,
      'Z3i 崩塌记 1 次幽灵记忆（ghostStrike=1，连续两次后下次 engage 直接跳过该档位）');
    // 长时间也不再 engage：画面一直崩着（不命中闸门），闭环不得反复试探
    await pump(hZ.clock, 1500, 5);
    assert(eventsOf(hZ.logs, 'CAM_EXP_ENGAGE').length === 1,
      'Z3j 崩塌后 1.5s 内无第二次 engage（无振荡，实际 ' +
      eventsOf(hZ.logs, 'CAM_EXP_ENGAGE').length + ' 次）');
    hZ.ctrl.unmount();
    await flush(60);
    assert(hZ.clock.count() === 0, 'Z3k 无悬挂定时器');

    /* ---- Z4 过压设备不被误判成崩塌（按次取照判据的负向对照）---- */
    // X 组模型：实际压暗 = 请求 ×3。若崩塌判据按「档位累计深度」取照，过压设备在
    // ev≈-1.36 时就会被误判成崩塌（实测栽过：X2 徽标测试因此失败）；按次取照时
    // 每步只容许「本步请求 + 2EV」，过压每步 ≤1.02EV 天然在容差内
    const trackOP = makeExpTrack({
      caps: { exposureMode: ['manual', 'continuous'], exposureTime: { min: 10, max: 100000 } },
      settings: { exposureTime: 1000, deviceId: 'overpress-cam' }
    });
    const hOP = makeHarness({
      track: trackOP,
      image: overPressImage(trackOP, 1000, 2.0, 150, 210),
      config: { expEffectWindowMs: 0 }
    });
    await boot(hOP);
    await pump(hOP.clock, 2000, 5);
    eq(eventsOf(hOP.logs, 'CAM_EXP_FALLBACK').filter(function (x) {
      return x.fields.reason === 'frame-collapse';
    }).length, 0,
      'Z4 过压设备（实际压暗 = 请求 ×3）全程不被误判成崩塌（实际 0 条 frame-collapse）');
    assert(eventsOf(hOP.logs, 'CAM_EXP_OVERPRESS').length >= 1,
      'Z4b 同一设备仍能正常检出过压（崩塌守卫没有把过压检测一起屏蔽掉）');
    hOP.ctrl.unmount();
    await flush(60);
    assert(hOP.clock.count() === 0, 'Z4c 无悬挂定时器');

    /* ---- Z5 零调整 release 的安全网：记幽灵记忆，两次后跳过该档 ---- */
    // 崩塌守卫漏过的变体 / 能力残缺：硬件档会话一次补偿都没下发成就被判离场
    // （闸门反转 → subjectMean 为 null → nextEvStep 返回 step=0 → 零 apply）。
    // 没有安全网，闭环会永远重复「engage→零调整→release」而没有任何机制能挣脱
    const trackZA = makeExpTrack({
      caps: { exposureCompensation: { min: -3, max: 3, step: 0.1 } },
      settings: { exposureCompensation: 0, deviceId: 'zeroadj-cam' }
    });
    let zaWhite = false;
    const rawApplyZA = trackZA.applyConstraints.bind(trackZA);
    trackZA.applyConstraints = function (cst) {
      const p = rawApplyZA(cst);
      // 只在**补偿**约束（engage/STEP，带 exposureMode:'continuous'）之后翻转画面；
      // restore 约束只有 {exposureCompensation:0}，不翻 —— 否则还原瞬间又把画面切走
      const a = cst && cst.advanced && cst.advanced[0];
      if (a && a.exposureMode === 'continuous') zaWhite = true;
      return p;
    };
    const hZA = makeHarness({
      track: trackZA,
      image: function () { return zaWhite ? allWhite() : SCENE.A(); },
      config: { expEffectWindowMs: 0 }
    });
    function allWhite() {
      return makeImage(function () { return PAL.white; });
    }
    await boot(hZA);
    // 第一件衣物：engage 后画面变全白（闸门反转、subjectMean 为 null）→ 零调整 release
    await pump(hZA.clock, 400, 5);
    const relZA = eventsOf(hZA.logs, 'CAM_EXP_RELEASE');
    assert(relZA.length === 1 && relZA[0].fields.adjusts === 0 && relZA[0].fields.ghostStrike === 1,
      'Z5 零调整 release 记幽灵记忆（release ' + relZA.length + ' 次，adjusts=' +
      (relZA.length ? relZA[0].fields.adjusts : '?') + '，ghostStrike=' +
      (relZA.length ? relZA[0].fields.ghostStrike : '?') + '）');
    const relExtra = relZA.length ? Object.keys(relZA[0].fields).filter(function (k) {
      return fixedKeys.indexOf(k) < 0;
    }) : [];
    assert(relExtra.length > 0 && relExtra.length <= 6,
      'Z5b RELEASE 诊断字段 ≤6 个（实际 ' + relExtra.length + '：' + relExtra.join(',') +
      '）——gate/rawMean/subjRatio/adjusts/ghostStrike 是现场区分「场景变了」与「还原系数失真」的唯一依据');
    // 第二件衣物：strike=1 未达门槛 → 仍重新探测 tier1（没有跳过）。
    // 注意这里与 T 组的幽灵设备不同：闸门反转后 subjectMean 为 null → nextEvStep 返回
    // step=0，整场会话一次负补偿都不会发 —— 「仍探测」的证据是 ENUM 仍报 tier1，
    // 而不是负补偿条数
    zaWhite = false;
    await pump(hZA.clock, 400, 5);
    const enumsZA2 = eventsOf(hZA.logs, 'CAM_EXP_ENUM');
    assert(enumsZA2.length === 2 && enumsZA2[1].fields.tier === 1,
      'Z5c 第 2 次 engage 仍重新探测 tier1（记账门槛 2 次，这次是故意多付的窗口；ENUM tier 序列 ' +
      JSON.stringify(enumsZA2.map(function (x) { return x.fields.tier; })) + '）');
    eq(eventsOf(hZA.logs, 'CAM_EXP_FALLBACK').filter(function (x) {
      return x.fields.reason === 'ghost-remembered';
    }).length, 0, 'Z5c2 门槛未达时不得跳过任何档位（ghost-remembered 0 条）');
    await pump(hZA.clock, 400, 5);
    const relZA2 = eventsOf(hZA.logs, 'CAM_EXP_RELEASE');
    assert(relZA2.length === 2 && relZA2[1].fields.ghostStrike === 2,
      'Z5d 第二次零调整 release 累计到门槛（ghostStrike=' +
      (relZA2.length > 1 ? relZA2[1].fields.ghostStrike : '?') + '，到 2 才记账）');
    // 第三件衣物：门槛已达 → 直接跳过 tier1，且不再零调整空转
    zaWhite = false;
    const ghostBefore = eventsOf(hZA.logs, 'CAM_EXP_FALLBACK').filter(function (x) {
      return x.fields.reason === 'ghost-remembered';
    }).length;
    const callsZA3from = trackZA.calls.length;
    await pump(hZA.clock, 600, 5);
    const callsZA3 = trackZA.calls.slice(callsZA3from).filter(function (c) {
      const a = c.advanced && c.advanced[0];
      return a && typeof a.exposureCompensation === 'number';
    });
    eq(callsZA3.length, 0,
      'Z5e 第 3 次 engage 不再下发任何 exposureCompensation 约束（幽灵记忆生效，实际 ' +
      callsZA3.length + ' 次）');
    eq(eventsOf(hZA.logs, 'CAM_EXP_FALLBACK').filter(function (x) {
      return x.fields.reason === 'ghost-remembered';
    }).length, ghostBefore + 1,
      'Z5f 跳过留痕恰好 1 条 CAM_EXP_FALLBACK{reason:ghost-remembered}');
    hZA.ctrl.unmount();
    await flush(60);
    assert(hZA.clock.count() === 0, 'Z5g 零调整路径无悬挂定时器');
  })();
}

/* ========================================================================== *
 * 三、入口
 * ======================================================================== */
async function runAll(mod) {
  if (mod) C = mod;
  pass = 0;
  fail = 0;
  failures = [];
  console.log('=== verify-camera-exposure：曝光辅助（黑色衣物过曝防护） ===');
  await suite();
  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  if (fail) {
    console.log('\n失败清单：');
    failures.forEach(function (m) { console.log('  - ' + m); });
  }
  // 注意：这里不改 process.exitCode —— 变异测试会在同一进程内反复调用 runAll()，
  // 逐轮污染退出码会让「全部变异都被抓住」的脚本仍然以非 0 退出
  return { pass: pass, fail: fail, failures: failures.slice() };
}

if (require.main === module) {
  runAll(null).then(function (r) {
    if (r && r.fail) process.exitCode = 1;
  }).catch(function (e) {
    console.error('脚本异常：', (e && e.stack) || e);
    process.exitCode = 1;
  });
}

module.exports = { runAll: runAll };
