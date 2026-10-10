'use strict';
/* =============================================================================
 * verify-camera-res-budget.js —— resBudgetMs 总预算闸门的「出厂默认值」实测
 *
 * 目的：用线上真实默认参数（resBudgetMs=2500 / applyConstraintMs=1000）实测两种极端，
 *       为「不落地选项 B（首档之后单档超时降级到 400ms）」这个决策提供数字依据：
 *         极端 A：每一档都被明确拒绝（Overconstrained 秒回）→ 应当毫秒级，不吃满预算
 *         极端 B：每一档都悬挂（applyConstraints 永不 settle）→ 应当被卡在 ~3s，不是 15s
 *
 *   node scripts/verify-camera-res-budget.js
 *
 * 只依赖 renderer/camera-controller.js，虚拟时钟驱动，全程确定性、不 sleep。
 * ========================================================================== */
const C = require('../renderer/camera-controller.js');

const DEFAULTS = C.DEFAULTS;
let pass = 0;
let fail = 0;
const failures = [];
function ok(m) { pass++; console.log('  ✓ ' + m); }
function bad(m) { fail++; failures.push(m); console.log('  ✗ ' + m); }
function assert(c, m) { c ? ok(m) : bad(m); }

/* ---------- 虚拟时钟 ---------- */
function makeClock() {
  let t = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    now() { return t; },
    setTimeout(fn, ms) { const id = nextId++; pending.set(id, { at: t + (Number(ms) || 0), fn: fn }); return id; },
    clearTimeout(id) { pending.delete(id); },
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

const allStreams = [];
function makeTrack(o) {
  o = o || {};
  return {
    readyState: 'live', muted: false, _h: {},
    _w: o.width == null ? 640 : o.width,
    _hgt: o.height == null ? 480 : o.height,
    _fps: 30,
    deviceId: o.deviceId || 'cam-a',
    caps: o.caps || { width: { max: 3840 }, height: { max: 2160 } },
    act: o.act || 'ok', // ok | over | hang
    applyCalls: [],
    addEventListener(t, f) { (this._h[t] = this._h[t] || []).push(f); },
    removeEventListener(t, f) { const a = this._h[t] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); },
    stop() { this.readyState = 'ended'; },
    getCapabilities() { return this.caps; },
    getSettings() { return { width: this._w, height: this._hgt, frameRate: this._fps, deviceId: this.deviceId }; },
    applyConstraints(cst) {
      this.applyCalls.push({ w: cst && cst.width && cst.width.exact, h: cst && cst.height && cst.height.exact });
      if (this.act === 'hang') return new Promise(function () {});
      if (this.act === 'over') return Promise.reject(Object.assign(new Error('over'), { name: 'OverconstrainedError' }));
      if (cst && cst.width && cst.width.exact) this._w = cst.width.exact;
      if (cst && cst.height && cst.height.exact) this._hgt = cst.height.exact;
      return Promise.resolve();
    }
  };
}
function makeStream(o) {
  const t = makeTrack(o && o.track);
  const s = { getTracks: () => [t], getVideoTracks: () => [t], __t: t };
  allStreams.push(s);
  return s;
}
function makeVideo(o) {
  return Object.assign({ readyState: 4, videoWidth: 640, videoHeight: 480, srcObject: null, play: () => Promise.resolve() }, o || {});
}

function makeMd(o) {
  o = o || {};
  const self = {
    calls: 0, lastConstraints: null,
    getUserMedia(cst) {
      self.calls += 1;
      self.lastConstraints = cst;
      return Promise.resolve(makeStream(o.stream));
    },
    enumerateDevices() { return Promise.resolve([]); },
    addEventListener() {}, removeEventListener() {}
  };
  return self;
}

async function settle(clock, p, maxMs, step) {
  step = step || 1;
  let done = false, val = null;
  p.then(function (v) { done = true; val = v; }, function (e) { done = true; val = e; });
  const t0 = clock.t();
  let elapsed = 0;
  while (!done && elapsed < maxMs) {
    clock.advance(step);
    for (let i = 0; i < 300; i++) await Promise.resolve();
    elapsed = clock.t() - t0;
  }
  return { done: done, value: val, elapsed: elapsed };
}

/* 跑一次开流，返回 { 耗时, 探测档数, 状态, 能否拍照, 留痕 reason } */
async function runOnce(act) {
  const clock = makeClock();
  const logs = [];
  const caps = { width: { max: 3840 }, height: { max: 2160 } }; // → 16 档阶梯
  const ctrl = C.createCameraController({
    mediaDevices: makeMd({ stream: { track: { caps: caps, act: act, width: 320, height: 200 } } }),
    videoGetter: () => makeVideo({ videoWidth: 320, videoHeight: 200 }),
    config: {
      resBudgetMs: DEFAULTS.resBudgetMs,
      applyConstraintMs: DEFAULTS.applyConstraintMs,
      resMaxRungs: DEFAULTS.resMaxRungs,
      openTimeoutMs: 5000, frameWaitMs: 500, framePollMs: 20,
      attachTimeoutMs: 300, degradedWatchMs: 200, maxAttempts: 5, backoffMs: [10, 10, 10, 10]
    },
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    log: function (level, event, fields) { logs.push({ level: level, event: event, fields: fields }); }
  });
  const r = await settle(clock, ctrl.mount(), 60000, 1);
  const track = allStreams[allStreams.length - 1].__t;
  const fb = logs.filter(function (l) { return l.event === 'CAM_RES_FALLBACK'; });
  return {
    done: r.done,
    elapsed: r.elapsed,
    probes: track.applyCalls.length,
    rungs: (logs.filter(function (l) { return l.event === 'CAM_RES_ENUM'; })[0] || {}).fields
      ? logs.filter(function (l) { return l.event === 'CAM_RES_ENUM'; })[0].fields.rungs : null,
    state: ctrl.getState(),
    canCapture: ctrl.canCapture(),
    reason: fb.length ? fb[fb.length - 1].fields.reason : null,
    reasonFields: fb.length ? fb[fb.length - 1].fields : null,
    pending: clock.count()
  };
}

async function main() {
  console.log('=== verify-camera-res-budget：resBudgetMs 闸门「出厂默认值」实测 ===');
  console.log('  默认参数：resBudgetMs=' + DEFAULTS.resBudgetMs + 'ms，applyConstraintMs=' +
    DEFAULTS.applyConstraintMs + 'ms，resMaxRungs=' + DEFAULTS.resMaxRungs);
  console.log('  能力区间：3840×2160（满 16 档阶梯）\n');

  /* ---------- 极端 A：每一档都被明确拒绝（秒回） ---------- */
  console.log('· 极端 A：16 档全部 OverconstrainedError（正常失败，毫秒级回绝）');
  const A = await runOnce('over');
  console.log('    实测：耗时 ' + A.elapsed + 'ms / 探测 ' + A.probes + ' 档 / 阶梯 ' + A.rungs +
    ' 档 / 状态 ' + A.state + ' / 留痕 ' + A.reason);
  assert(A.done, 'A1 流程正常结束（未挂死）');
  assert(A.elapsed < 200, 'A2 正常失败不吃满预算：' + A.elapsed + 'ms ≪ 预算 ' + DEFAULTS.resBudgetMs + 'ms');
  assert(A.probes === 16, 'A3 预算没消耗 → 16 档全部试完（实际 ' + A.probes + '），最高可用档不会被预算误伤');
  assert(A.state === 'LIVE', 'A4 全档被拒仍正常出画（不置 ERROR）');
  assert(A.canCapture === true, 'A5 拍照闸门仍可用');
  assert(A.reason === 'ladder-exhausted', 'A6 留痕为 ladder-exhausted（每档都被明确拒绝），实际 ' + A.reason);
  assert(A.pending === 0, 'A7 无悬挂定时器（实际 ' + A.pending + '）');

  /* ---------- 极端 B：每一档都悬挂 ---------- */
  console.log('\n· 极端 B：16 档全部悬挂（applyConstraints 永不 settle）');
  const B = await runOnce('hang');
  console.log('    实测：耗时 ' + B.elapsed + 'ms / 探测 ' + B.probes + ' 档 / 阶梯 ' + B.rungs +
    ' 档 / 状态 ' + B.state + ' / 留痕 ' + B.reason);
  assert(B.done, 'B1 流程正常结束（未永久挂死）');
  assert(B.elapsed <= DEFAULTS.resBudgetMs + DEFAULTS.applyConstraintMs + 200,
    'B2 恒挂被预算卡住：' + B.elapsed + 'ms ≤ 预算 ' + DEFAULTS.resBudgetMs + 'ms + 单档 ' +
    DEFAULTS.applyConstraintMs + 'ms（不加闸门最坏 ' + (B.rungs * DEFAULTS.applyConstraintMs) + 'ms）');
  assert(B.elapsed < B.rungs * DEFAULTS.applyConstraintMs / 2,
    'B3 远小于「不加闸门」的 ' + (B.rungs * DEFAULTS.applyConstraintMs) + 'ms（实际 ' + B.elapsed + 'ms）');
  assert(B.probes <= Math.ceil(DEFAULTS.resBudgetMs / DEFAULTS.applyConstraintMs) + 1,
    'B4 探测档数被截断：' + B.probes + ' 档 ≤ 预算允许上限 ' +
    (Math.ceil(DEFAULTS.resBudgetMs / DEFAULTS.applyConstraintMs) + 1) + '（共 ' + B.rungs + ' 档）');
  assert(B.state === 'LIVE', 'B5 预算耗尽后仍正常出画（不置 ERROR）');
  assert(B.canCapture === true, 'B6 预算耗尽后拍照闸门仍可用');
  assert(B.reason === 'budget-exhausted', 'B7 留痕为 budget-exhausted（还有档没试但时间用完），实际 ' + B.reason);
  assert(B.pending === 0, 'B8 无悬挂定时器（实际 ' + B.pending + '）');

  /* ---------- 极端 C（混合）：前几档悬挂、后面某档其实可用 ----------
   * 这是预算闸门唯一的代价面：预算卡住后，本来「再试一档就能锁上」的设备会锁不上。
   * 只做量化记录，不做通过/失败判定 —— 结论交给决策者。 */
  console.log('\n· 极端 C（混合，仅供决策参考）：前 N 档悬挂、第 N+1 档其实可用');
  const capsC = { width: { max: 3840 }, height: { max: 2160 } };
  const ladderC = C.buildResolutionLadder(capsC);
  for (const hangN of [1, 2, 3]) {
    const clock = makeClock();
    const logs = [];
    const state = { n: 0 };
    const caps = capsC;
    // 自定义 track：前 hangN 档悬挂，其后成功
    const track = makeTrack({ caps: caps, act: 'ok', width: 320, height: 200 });
    track.applyConstraints = function (cst) {
      this.applyCalls.push({ w: cst && cst.width && cst.width.exact, h: cst && cst.height && cst.height.exact });
      const idx = this.applyCalls.length - 1;
      if (idx < hangN) return new Promise(function () {});
      this._w = cst.width.exact;
      this._hgt = cst.height.exact;
      return Promise.resolve();
    };
    const s = { getTracks: () => [track], getVideoTracks: () => [track], __t: track };
    allStreams.push(s);
    const ctrl = C.createCameraController({
      mediaDevices: { getUserMedia: function () { return Promise.resolve(s); }, enumerateDevices: () => Promise.resolve([]), addEventListener() {}, removeEventListener() {} },
      videoGetter: () => makeVideo({ videoWidth: 320, videoHeight: 200 }),
      config: { resBudgetMs: DEFAULTS.resBudgetMs, applyConstraintMs: DEFAULTS.applyConstraintMs, resMaxRungs: DEFAULTS.resMaxRungs, openTimeoutMs: 5000, frameWaitMs: 300, framePollMs: 10, attachTimeoutMs: 200, maxAttempts: 5, backoffMs: [10] },
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      log: function (l, e, f) { logs.push({ level: l, event: e, fields: f }); }
    });
    const r = await settle(clock, ctrl.mount(), 60000, 1);
    const target = ladderC[hangN]; // 那个「其实可用」的档
    const info = ctrl.getResolutionInfo();
    // 注意：actual 会被出画校验（video 尺寸）覆盖，request 才是「阶梯真正锁定的档」
    const locked = info.request;
    const hit = !!(locked && locked.width === target.width && locked.height === target.height);
    const fb = logs.filter(function (l) { return l.event === 'CAM_RES_FALLBACK'; });
    console.log('    前 ' + hangN + ' 档悬挂、第 ' + (hangN + 1) + ' 档（' + target.width + '×' + target.height +
      '）可用 → 耗时 ' + r.elapsed + 'ms，探测 ' + track.applyCalls.length + ' 档，阶梯锁定 ' +
      JSON.stringify(locked) + '（来源 ' + info.source + '）' +
      (hit ? '  ← 锁上了目标档' : '  ← 没锁上，留痕 ' + (fb.length ? fb[fb.length - 1].fields.reason : '无')));
    void state;
  }
  console.log('    说明：以上为代价面量化。真悬挂通常是设备级行为（驱动对不支持的格式一律不 settle），');
  console.log('          混合型（前几档挂、后面档能成）在真机上罕见；是否为此落地「选项 B」由决策者判断。');

  /* ---------- 超支边界：最多超支一次单档时长 ---------- */
  console.log('\n· 超支边界（工程师声称「检查点在每轮开始前，最多超支一次 applyConstraints」）');
  const combos = [[2500, 1000], [400, 150], [1000, 300], [600, 1000], [2000, 700]];
  let boundOk = true;
  const rows = [];
  for (const c of combos) {
    const clock = makeClock();
    const caps = { width: { max: 3840 }, height: { max: 2160 } };
    const ctrl = C.createCameraController({
      mediaDevices: makeMd({ stream: { track: { caps: caps, act: 'hang', width: 320, height: 200 } } }),
      videoGetter: () => makeVideo({ videoWidth: 320, videoHeight: 200 }),
      config: { resBudgetMs: c[0], applyConstraintMs: c[1], resMaxRungs: DEFAULTS.resMaxRungs, openTimeoutMs: 5000, frameWaitMs: 300, framePollMs: 10, attachTimeoutMs: 200, maxAttempts: 5, backoffMs: [10] },
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      log: function () {}
    });
    const r = await settle(clock, ctrl.mount(), 60000, 1);
    const over = r.elapsed - c[0];
    const within = r.elapsed <= c[0] + c[1] + 60;
    if (!within) boundOk = false;
    rows.push('    预算 ' + c[0] + 'ms / 单档 ' + c[1] + 'ms → 耗时 ' + r.elapsed + 'ms，超支 ' +
      over + 'ms（上限 ' + c[1] + 'ms）' + (within ? '' : '  ← 超出！'));
  }
  rows.forEach(function (l) { console.log(l); });
  assert(boundOk, 'C1 所有组合下总耗时 ≤ 预算 + 一次单档时长（超支有界，不会蔓延成十几秒）');

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  if (fail) {
    console.log('\n失败清单：');
    failures.forEach(function (m) { console.log('  - ' + m); });
    process.exitCode = 1;
  }
}

main().catch(function (e) { console.error('脚本异常：', e && e.stack || e); process.exitCode = 1; });
