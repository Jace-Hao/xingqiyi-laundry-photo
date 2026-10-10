'use strict';
/* =============================================================================
 * verify-camera-res-qa2.js —— 第二层 QA 独立对抗性验证
 *
 * 定位：不复用工程师的 verify-camera-res.js 假对象，独立实现虚拟时钟 + 可脚本化
 * track / mediaDevices，从「刁钻输入、降级链真实性、预算闸门、串档、I1/定时器、
 * 既有契约」六个角度重新打一遍。
 *
 *   node scripts/verify-camera-res-qa2.js
 *
 * 只依赖 renderer/camera-controller.js（UMD 纯逻辑），不碰 DOM / Electron。
 * ========================================================================== */
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

/* ========================================================================== *
 * 虚拟时钟：确定性推进，杜绝真实 sleep 带来的抖动与慢测试
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

// 推进时钟直到 promise settle；返回是否结束与「消耗的虚拟时长」
async function settle(clock, p, maxMs, step) {
  step = step || 5;
  let done = false;
  let val = null;
  p.then(function (v) { done = true; val = v; }, function (e) { done = true; val = e; });
  const t0 = clock.t();
  let elapsed = 0;
  while (!done && elapsed < maxMs) {
    clock.advance(step);
    for (let i = 0; i < 400; i++) await Promise.resolve();
    elapsed = clock.t() - t0;
  }
  return { done: done, value: val, elapsed: elapsed };
}

/* ========================================================================== *
 * 假 track：按「第几次 applyConstraints」脚本化 —— 保证能精确编排降级链
 * ======================================================================== */
const allStreams = [];

function makeTrack(o) {
  o = o || {};
  return {
    readyState: 'live',
    muted: false,
    _h: {},
    _w: o.width == null ? 640 : o.width,
    _hgt: o.height == null ? 480 : o.height,
    _fps: o.fps == null ? 30 : o.fps,
    deviceId: o.deviceId == null ? 'cam-a' : o.deviceId,
    caps: o.caps || { width: { max: 1920 }, height: { max: 1080 } },
    plan: o.plan || null,          // [{ at: <调用序号>, act: 'ok'|'over'|'hang'|'mismatch'|'err' }]
    defaultAct: o.defaultAct || 'ok',
    applyDelayMs: o.applyDelayMs || 0, // 让 applyConstraints 走虚拟时钟，便于在探测过程中采样
    timer: o.timer || null,
    applyCalls: [],
    addEventListener(type, f) { (this._h[type] = this._h[type] || []).push(f); },
    removeEventListener(type, f) { const a = this._h[type] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); },
    stop() { this.readyState = 'ended'; },
    getCapabilities() { return this.caps; },
    getSettings() { return { width: this._w, height: this._hgt, frameRate: this._fps, deviceId: this.deviceId }; },
    applyConstraints(cst) {
      this.applyCalls.push({ w: cst && cst.width, h: cst && cst.height, fps: cst && cst.frameRate });
      const idx = this.applyCalls.length - 1;
      let act = this.defaultAct;
      if (this.plan) {
        for (let i = 0; i < this.plan.length; i++) {
          if (this.plan[i].at === idx) { act = this.plan[i].act; break; }
        }
      }
      if (act === 'hang') return new Promise(function () { /* 永不 settle */ });
      if (act === 'over') return Promise.reject(Object.assign(new Error('overconstrained'), { name: 'OverconstrainedError' }));
      if (act === 'err') return Promise.reject(Object.assign(new Error('boom'), { name: 'NotReadableError' }));
      if (act === 'mismatch') return this._after(0, true); // 口头接受但输出不变（驱动没真切档）
      if (cst && cst.width && cst.width.exact) this._w = cst.width.exact;
      if (cst && cst.height && cst.height.exact) this._hgt = cst.height.exact;
      if (cst && cst.frameRate && cst.frameRate.ideal) this._fps = cst.frameRate.ideal;
      return this._after(0, true);
    },
    // 延迟 resolve：delay<0 表示永不 settle
    _after(ms, ok) {
      const self = this;
      if (self.applyDelayMs > 0) {
        return new Promise(function (resolve, reject) {
          (self.timer || setTimeout)(function () { ok ? resolve() : reject(); }, self.applyDelayMs);
        });
      }
      return ok ? Promise.resolve() : Promise.reject();
    },
    fire(type) { (this._h[type] || []).slice().forEach(function (f) { f(); }); }
  };
}

function makeStream(o) {
  const t = makeTrack(o && o.track);
  const s = { getTracks: function () { return [t]; }, getVideoTracks: function () { return [t]; }, __t: t };
  allStreams.push(s);
  return s;
}

// 从下标 from 起统计「未被 stop 的流」数量（隔离各测试组，避免互相污染）
function liveSince(from) {
  let n = 0;
  for (let i = from; i < allStreams.length; i++) if (allStreams[i].__t.readyState === 'live') n++;
  return n;
}

function makeVideo(o) {
  return Object.assign({
    readyState: 4,
    videoWidth: 640,
    videoHeight: 480,
    srcObject: null,
    play: function () { return Promise.resolve(); }
  }, o || {});
}

/* 假 mediaDevices
 *  - supported：严格模式，gUM 约束里 exact 的分辨率不在列表内就抛 OverconstrainedError
 *  - disabled：冷启动开关（mount 阶段让它直接失败，避免污染 store / 计数） */
function makeMd(o) {
  o = o || {};
  const self = {
    calls: 0,
    timer: o.timer || null,
    lastConstraints: null,
    allConstraints: [],
    supported: o.supported || null,
    streamOpts: o.stream || {},
    err: o.err || null,
    disabled: false,
    _h: {},
    getUserMedia(cst) {
      if (self.disabled) return Promise.reject(Object.assign(new Error('no device'), { name: 'NotFoundError' }));
      self.calls += 1;
      self.lastConstraints = cst;
      self.allConstraints.push(JSON.parse(JSON.stringify(cst)));
      if (self.err) return Promise.reject(Object.assign(new Error(self.err), { name: self.err }));
      if (self.supported) {
        const v = cst && cst.video;
        const w = v && v.width && v.width.exact;
        const h = v && v.height && v.height.exact;
        if (w || h) {
          const hit = self.supported.some(function (p) { return p[0] === w && p[1] === h; });
          if (!hit) return Promise.reject(Object.assign(new Error('over'), { name: 'OverconstrainedError' }));
        }
      }
      const st = Object.assign({}, self.streamOpts || {});
      st.track = Object.assign({}, st.track || {}, { timer: self.timer });
      return Promise.resolve(makeStream(st));
    },
    enumerateDevices() { return Promise.resolve([]); },
    addEventListener(t, f) { (self._h[t] = self._h[t] || []).push(f); },
    removeEventListener(t, f) { const a = self._h[t] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); },
    fire(t) { (self._h[t] || []).slice().forEach(function (f) { f(); }); }
  };
  return self;
}

const CFG = {
  openTimeoutMs: 3000,
  frameWaitMs: 500,
  framePollMs: 20,
  degradedWatchMs: 200,
  attachTimeoutMs: 300,
  applyConstraintMs: 150,
  resBudgetMs: 400,
  resMaxRungs: 16,
  resMaxFps: 3,
  backoffMs: [10, 10, 10, 10],
  maxAttempts: 5
};

function makeCtrl(o) {
  o = o || {};
  const clock = o.clock || makeClock();
  const store = o.store || {};
  const logs = [];
  const md = o.md || makeMd(Object.assign({}, o.mdOpts || {}, { timer: clock.setTimeout }));
  const ctrl = C.createCameraController({
    mediaDevices: md,
    videoGetter: function () { return o.video || makeVideo(); },
    config: Object.assign({}, CFG, o.config || {}),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    log: function (level, event, fields) { logs.push({ level: level, event: event, fields: fields }); },
    loadResolutionPref: o.loadPref === null ? null : function (id) {
      const k = id || '';
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
    },
    saveResolutionPref: o.savePref === null ? null : function (id, val) {
      const k = id || '';
      if (val === null || val === undefined) delete store[k];
      else store[k] = val;
    }
  });
  return { ctrl: ctrl, clock: clock, store: store, logs: logs, md: md };
}

const evs = function (logs, name) { return logs.filter(function (l) { return l.event === name; }); };
const reasons = function (logs, name) {
  return evs(logs, name).map(function (l) { return l.fields && l.fields.reason; });
};

/* 启动一次会话。
 *  - dev 为 undefined：直接用 mount()（mount 内部已以默认设备开一次流）
 *  - dev 给定：先「冷启动」mount（gUM 直接失败，不落存档 / 不产生流），再 open(dev)，
 *    这样 store 与计数不被 mount 的默认设备会话污染 */
async function boot(h, dev) {
  const s0 = allStreams.length;
  if (dev === undefined || dev === null) {
    await settle(h.clock, h.ctrl.mount(), 30000);
    return { from: s0, logs: h.logs.slice(), calls: h.md.calls };
  }
  h.md.disabled = true;
  await settle(h.clock, h.ctrl.mount(), 30000);
  h.md.disabled = false;
  const baseLogs = h.logs.length;
  const baseCalls = h.md.calls;
  await settle(h.clock, h.ctrl.open(dev), 30000);
  return { from: s0, logs: h.logs.slice(baseLogs), calls: h.md.calls - baseCalls };
}

/* 供 CLI 与变异测试共用：mod 为被测模块（可注入被改坏的副本） */
async function runAll(mod) {
  if (mod) C = mod;
  pass = 0;
  fail = 0;
  failures = [];
  await suite();
  return { pass: pass, fail: fail, failures: failures.slice() };
}

async function main() {
  await runAll(null);
}

if (require.main === module) {
  main().catch(function (e) {
    console.error('脚本异常：', e && e.stack || e);
    process.exitCode = 1;
  });
}

module.exports = { runAll: runAll };

/* ========================================================================== */
async function suite() {
  /* ---------------------------------------------------------------- *
   * A. 阶梯排序在刁钻能力区间下的产物
   * ---------------------------------------------------------------- */
  console.log('\n· A buildResolutionLadder：刁钻能力区间');
  {
    const inRange = function (ladder, wMin, wMax, hMin, hMax) {
      return ladder.every(function (r) {
        return r.width >= wMin && r.width <= wMax && r.height >= hMin && r.height <= hMax;
      });
    };

    const l1 = C.buildResolutionLadder({ width: { min: 160, max: 1920 }, height: { min: 120, max: 1080 } });
    eq(l1[0], { width: 1920, height: 1080 }, 'A1 双 max 组合为首档');
    assert(inRange(l1, 160, 1920, 120, 1080), 'A1 每一档都落在 [min,max] 内（不拼非法档位）');

    const l2 = C.buildResolutionLadder({ width: { min: 640 }, height: { min: 480 } });
    assert(l2.length > 0, 'A2 只有 min 也能造出阶梯（' + l2.length + ' 档）');
    assert(inRange(l2, 1, 640, 1, 480), 'A2 只有 min 时不产出 > min 的档位');

    const l3 = C.buildResolutionLadder({ width: { min: 1920, max: 640 }, height: { min: 1080, max: 480 } });
    assert(inRange(l3, 640, 1920, 480, 1080), 'A3 min>max 时交换区间，产物仍落在合法区间内');

    const l4 = C.buildResolutionLadder({ width: { max: 1919.7 }, height: { max: 1079.9 } });
    assert(l4.every(function (r) { return Number.isInteger(r.width) && Number.isInteger(r.height); }), 'A4 非整数上限 → 产物全为整数');
    assert(inRange(l4, 1, 1919, 1, 1079), 'A4 取整后不越界');

    // A5 模块其余部分以 7680 为合法性上限（normalizeResolution），阶梯不得产出被自己判非法的档
    const l5 = C.buildResolutionLadder({ width: { max: 20000 }, height: { max: 20000 } });
    const over = l5.filter(function (r) { return r.width > 7680 || r.height > 7680; });
    assert(over.length === 0, 'A5 不得产出 >7680 的档位（否则 normalizeResolution 判非法）实际越界 ' + over.length + ' 档：' + JSON.stringify(over.slice(0, 2)));

    const l6 = C.buildResolutionLadder({ width: { max: 1920 }, height: { max: 1080 } });
    assert(l6.every(function (r) { return r.frameRate === undefined; }), 'A6 无 frameRate 能力 → 档位不带 frameRate');

    const l7 = C.buildResolutionLadder({ width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 120, min: 1 } });
    eq(l7.slice(0, 3).map(function (r) { return r.frameRate; }), [120, 30, 20], 'A7 最高档帧率备选降序（120→30→20）');
    assert(l7.every(function (r) { return !r.frameRate || (r.frameRate >= 1 && r.frameRate <= 120); }), 'A7 帧率落在能力区间内');

    const l8 = C.buildResolutionLadder({ width: { min: 160, max: 1600 }, height: { min: 120, max: 1200 }, frameRate: { max: 60, min: 5 } });
    let orderOk = true;
    for (let i = 1; i < l8.length; i++) {
      const a = l8[i - 1], b = l8[i];
      const aa = a.width * a.height, ba = b.width * b.height;
      if (aa < ba) { orderOk = false; break; }
      if (aa === ba) {
        const af = a.frameRate || 0, bf = b.frameRate || 0;
        if (af < bf) { orderOk = false; break; }
        if (af === bf && a.width < b.width) { orderOk = false; break; }
      }
    }
    assert(orderOk, 'A8 排序不变量：面积降序 → 帧率降序 → 宽度降序');

    const seen = new Set();
    let dup = 0;
    l8.forEach(function (r) {
      const k = r.width + 'x' + r.height + '@' + (r.frameRate || 0);
      if (seen.has(k)) dup++;
      seen.add(k);
    });
    assert(dup === 0, 'A9 无重复档位');

    const full = C.buildResolutionLadder({ width: { min: 160, max: 1600 }, height: { min: 120, max: 1200 } });
    const cut = C.buildResolutionLadder({ width: { min: 160, max: 1600 }, height: { min: 120, max: 1200 } }, { maxRungs: 3 });
    assert(cut.length === 3, 'A10 maxRungs=3 → 恰好 3 档（实际 ' + cut.length + '）');
    eq(cut, full.slice(0, 3), 'A10 截断保留的是最高三档（不是随机三档）');

    eq(C.buildResolutionLadder(undefined), [], 'A11 undefined → 空阶梯');
    eq(C.buildResolutionLadder({ width: { max: 0 }, height: { max: 1080 } }), [], 'A11 退化能力 max=0 → 应判为空阶梯（不产出 width=1 的荒谬档）');
    eq(C.buildResolutionLadder({ width: { max: NaN }, height: { max: 1080 } }), [], 'A11 NaN → 空阶梯');
    eq(C.buildResolutionLadder({ width: 'x', height: { max: 1080 } }), [], 'A11 非对象能力 → 空阶梯');

    const l12 = C.buildResolutionLadder({ width: { min: 1, max: 1920 }, height: { min: 1, max: 1080 } });
    assert(l12.every(function (r) { return r.width >= 160 && r.height >= 120; }), 'A12 下界极小时不产出荒谬档位（最小 ' + JSON.stringify(l12[l12.length - 1]) + '）');
  }

  /* ---------------------------------------------------------------- *
   * B. 降级链必须真的降级（4 档编排）
   * ---------------------------------------------------------------- */
  console.log('\n· B 降级链：overconstrained → timeout → verify-mismatch → 成功');
  {
    const caps = { width: { min: 160, max: 1600 }, height: { min: 120, max: 1200 } };
    const ladder = C.buildResolutionLadder(caps);
    eq(ladder[3], { width: 1280, height: 1024 }, 'B0 第 4 档 = 1280×1024（编排前提）');

    const plan = [
      { at: 0, act: 'over' },      // 最高档 1600×1200 被拒
      { at: 1, act: 'hang' },      // 次高档 1600×1080 悬挂超时
      { at: 2, act: 'mismatch' },  // 第三档 1600×900 口头接受但没真切
      { at: 3, act: 'ok' }         // 第四档 1280×1024 成功
    ];
    const s0 = allStreams.length;
    const h = makeCtrl({
      mdOpts: { stream: { track: { caps: caps, plan: plan, width: 640, height: 480, deviceId: 'cam-a' } } },
      video: makeVideo({ videoWidth: 1280, videoHeight: 1024 })
    });
    const b = await boot(h);
    eq(h.ctrl.getState(), 'LIVE', 'B1 最终出画 LIVE');
    eq(h.ctrl.getResolution(), { width: 1280, height: 1024 }, 'B1 锁定第四档（不是被拒/超时/假切的那几档）');
    const info = h.ctrl.getResolutionInfo();
    eq(info.request, { width: 1280, height: 1024 }, 'B1 请求档位 = 第四档');
    eq(info.source, 'ladder', 'B1 来源 ladder（逐档锁定）');

    const rs = reasons(b.logs, 'CAM_RES_FALLBACK');
    eq(rs, ['overconstrained', 'apply-timeout', 'verify-mismatch'], 'B2 三档失败原因分别被正确归类（不许把失败记成成功）');
    assert(rs.indexOf('ladder-exhausted') < 0, 'B2 未误报「全档失败」');
    const applyEv = evs(b.logs, 'CAM_RES_APPLY');
    assert(applyEv.length === 1 && applyEv[0].fields.res.w === 1280 && applyEv[0].fields.res.h === 1024,
      'B2 CAM_RES_APPLY 只记一次且记的是成功的第四档');

    const bad3 = [[1600, 1200], [1600, 1080], [1600, 900]];
    const got = h.ctrl.getResolution() || {};
    assert(!bad3.some(function (p) { return got.width === p[0] && got.height === p[1]; }),
      'B3 失败档位不得出现在最终 resolution 里（实际 ' + JSON.stringify(got) + '）');

    eq(h.store[''], { v: 1, w: 1280, h: 1024, fps: 0, ts: h.store[''] ? h.store[''].ts : 0, dev: 'cam-a' }, 'B4 只持久化成功的档位');
    eq(h.store['cam-a'], h.store[''], 'B4 同时按实际 deviceId 存一份');

    assert(liveSince(b.from) === 1, 'B5 全程只 1 条活跃流（I1，实际 ' + liveSince(b.from) + '）');
    assert(b.calls === 1, 'B5 降级过程中没有二次开流（gUM 调用 ' + b.calls + ' 次）');
    assert(h.clock.count() === 0, 'B5 结束后无悬挂定时器（pending ' + h.clock.count() + '）');
  }

  /* ---------------------------------------------------------------- *
   * C. 全档失败：流保留 / 能出画 / 不置 ERROR / 拍照闸门可用
   * ---------------------------------------------------------------- */
  console.log('\n· C 全档失败：不置 ERROR、不影响拍照');
  {
    const caps = { width: { min: 160, max: 1600 }, height: { min: 120, max: 1200 } };
    // 初始输出 320×200 不在阶梯里，避免「开流即最高档」提前命中
    const h = makeCtrl({
      mdOpts: { stream: { track: { caps: caps, defaultAct: 'over', width: 320, height: 200, deviceId: 'cam-a' } } },
      video: makeVideo({ videoWidth: 320, videoHeight: 200 })
    });
    const b = await boot(h);
    eq(h.ctrl.state, 'LIVE', 'C1 全档失败仍正常出画（不置 ERROR）');
    assert(h.ctrl.getError() === null, 'C1 error 为空（没有被拉响警报）');
    eq(h.ctrl.getResolution(), { width: 320, height: 200 }, 'C1 resolution 如实反映当前真实输出（不撒谎、不置空）');
    eq(h.ctrl.getResolutionInfo().source, 'none', 'C1 来源 none（未锁定任何档）');
    assert(reasons(b.logs, 'CAM_RES_FALLBACK').indexOf('ladder-exhausted') >= 0, 'C2 记下 ladder-exhausted 证据');
    assert(h.ctrl.canCapture() === true, 'C3 拍照闸门仍可用');
    assert(liveSince(b.from) === 1, 'C4 流被保留（未被回收，实际 ' + liveSince(b.from) + '）');
    assert(h.clock.count() === 0, 'C4 无悬挂定时器');
  }

  /* ---------------------------------------------------------------- *
   * D. resBudgetMs 总预算闸门
   * ---------------------------------------------------------------- */
  console.log('\n· D resBudgetMs 总预算闸门（每档都悬挂的极端场景）');
  {
    const caps = { width: { min: 160, max: 1600 }, height: { min: 120, max: 1200 } };
    const ladderN = C.buildResolutionLadder(caps).length;
    const budget = 400;
    const perRung = 150;
    const h = makeCtrl({
      config: { resBudgetMs: budget, applyConstraintMs: perRung },
      mdOpts: { stream: { track: { caps: caps, defaultAct: 'hang', width: 320, height: 200, deviceId: 'cam-a' } } },
      video: makeVideo({ videoWidth: 320, videoHeight: 200 })
    });
    const s0 = allStreams.length;
    const r = await settle(h.clock, h.ctrl.mount(), 60000);
    assert(r.done, 'D1 极端悬挂场景下仍能结束（未永久挂死）');
    const worst = ladderN * perRung;
    assert(r.elapsed <= budget + perRung + 300,
      'D2 总耗时被 resBudgetMs 卡住：实际 ' + r.elapsed + 'ms，预算 ' + budget + 'ms（不加闸门最坏 ' + worst + 'ms / ' + ladderN + ' 档）');
    const track = allStreams[allStreams.length - 1].__t;
    const maxProbes = Math.ceil(budget / perRung) + 1;
    assert(track.applyCalls.length <= maxProbes,
      'D2b 探测档数被预算截断：实际 ' + track.applyCalls.length + ' 次 applyConstraints，预算允许上限 ' + maxProbes + '（共 ' + ladderN + ' 档）');
    eq(h.ctrl.state, 'LIVE', 'D3 预算耗尽后仍正常出画');
    assert(h.ctrl.canCapture() === true, 'D3 预算耗尽后拍照闸门仍可用');
    assert(h.clock.count() === 0, 'D4 无悬挂定时器');
    assert(liveSince(s0) === 1, 'D4 只有 1 条活跃流');
  }

  /* ---------------------------------------------------------------- *
   * E. 持久化与串档
   * ---------------------------------------------------------------- */
  console.log('\n· E 持久化与串档');
  {
    // E1a 默认设备换过 + 新设备不支持旧档位（gUM 会先被 Overconstrained 打回）
    const store = {};
    store[''] = { v: 1, w: 1920, h: 1080, fps: 30, ts: 1000, dev: 'cam-a' };
    const capsB = { width: { min: 160, max: 1280 }, height: { min: 120, max: 720 } };
    const h = makeCtrl({
      store: store,
      mdOpts: {
        supported: [[1280, 720], [640, 480]],
        stream: { track: { caps: capsB, defaultAct: 'ok', width: 640, height: 480, deviceId: 'cam-b' } }
      },
      video: makeVideo({ videoWidth: 1280, videoHeight: 720 })
    });
    const b = await boot(h);
    eq(h.ctrl.state, 'LIVE', 'E1a 换设备后仍正常出画');
    eq(h.ctrl.getResolution(), { width: 1280, height: 720 }, 'E1a 锁到 B 自己的最高档（绝不沿用 A 的 1920×1080）');
    assert(h.store[''] === undefined || h.store[''].w === 1280, 'E1a 旧档位已作废（store 实际 ' + JSON.stringify(h.store['']) + '）');
    eq(h.store['cam-b'], { v: 1, w: 1280, h: 720, fps: 0, ts: h.store['cam-b'] ? h.store['cam-b'].ts : 0, dev: 'cam-b' }, 'E1a 改存 B 自己的档位');

    // E1b 默认设备换过 + gUM 放行（旧档位能开流但设备已不是 A）→ 必须记 device-changed 并作废
    const storeB = {};
    storeB[''] = { v: 1, w: 1920, h: 1080, fps: 30, ts: 1000, dev: 'cam-a' };
    const h1b = makeCtrl({
      store: storeB,
      mdOpts: { stream: { track: { caps: capsB, defaultAct: 'ok', width: 640, height: 480, deviceId: 'cam-b' } } },
      video: makeVideo({ videoWidth: 1280, videoHeight: 720 })
    });
    const b1b = await boot(h1b);
    eq(h1b.ctrl.getResolution(), { width: 1280, height: 720 }, 'E1b 换设备后以 B 的实际能力为准（不沿用 A 的 1920×1080）');
    assert(reasons(b1b.logs, 'CAM_RES_PREF').indexOf('device-changed') >= 0,
      'E1b 记下 device-changed 证据（实际 ' + JSON.stringify(reasons(b1b.logs, 'CAM_RES_PREF')) + '）');
    eq(storeB[''], { v: 1, w: 1280, h: 720, fps: 0, ts: storeB[''] ? storeB[''].ts : 0, dev: 'cam-b' }, 'E1b 默认键被改写为 B 的档位');

    // E2 存档版本不对 → 当作没存过，gUM 不带 exact
    const store2 = { 'cam-x': { v: 99, w: 1920, h: 1080, fps: 30, ts: 1000, dev: 'cam-x' } };
    const h2 = makeCtrl({
      store: store2,
      mdOpts: { stream: { track: { caps: { width: { max: 1280 }, height: { max: 720 } }, defaultAct: 'ok', width: 640, height: 480, deviceId: 'cam-x' } } },
      video: makeVideo({ videoWidth: 1280, videoHeight: 720 })
    });
    const b2 = await boot(h2, 'cam-x');
    eq(h2.md.lastConstraints, { video: { deviceId: { exact: 'cam-x' } }, audio: false },
      'E2 版本不认 → 退化成旧契约约束（不把脏存档写进 gUM）');
    eq(reasons(b2.logs, 'CAM_RES_PREF'), ['miss'], 'E2 记为 miss');

    // E3 指定了设备时严格按设备 id 取，绝不取别的设备的档位
    const store3 = { 'cam-a': { v: 1, w: 1920, h: 1080, fps: 30, ts: 1000, dev: 'cam-a' } };
    const h3 = makeCtrl({
      store: store3,
      mdOpts: { stream: { track: { caps: { width: { max: 1280 }, height: { max: 720 } }, defaultAct: 'ok', width: 640, height: 480, deviceId: 'cam-b' } } },
      video: makeVideo({ videoWidth: 1280, videoHeight: 720 })
    });
    const b3 = await boot(h3, 'cam-b');
    eq(reasons(b3.logs, 'CAM_RES_PREF'), ['miss'], 'E3 打开 B 时不得命中 A 的存档');
    eq(h3.md.lastConstraints, { video: { deviceId: { exact: 'cam-b' } }, audio: false }, 'E3 约束里只有 deviceId，无分辨率');

    // E4 空串 deviceId 是「默认设备」的合法键，存档命中
    const store4 = { '': { v: 1, w: 1280, h: 720, fps: 30, ts: 1000, dev: 'cam-a' } };
    const h4 = makeCtrl({
      store: store4,
      mdOpts: { stream: { track: { caps: { width: { max: 1920 }, height: { max: 1080 } }, defaultAct: 'ok', width: 640, height: 480, deviceId: 'cam-a' } } },
      video: makeVideo({ videoWidth: 1280, videoHeight: 720 })
    });
    const b4 = await boot(h4);
    eq(reasons(b4.logs, 'CAM_RES_PREF'), ['hit'], 'E4 默认设备（空串键）存档命中');
    eq(h4.md.lastConstraints, { video: { width: { exact: 1280 }, height: { exact: 720 }, frameRate: { ideal: 30 } }, audio: false },
      'E4 默认设备开流时带上记忆档位（空串键真的是合法键）');

    // E5 存档字段非法（w=0）→ 当作没存过
    const store5 = { '': { v: 1, w: 0, h: 0, fps: 0, ts: 1000, dev: 'cam-a' } };
    const h5 = makeCtrl({
      store: store5,
      mdOpts: { stream: { track: { caps: { width: { max: 1920 }, height: { max: 1080 } }, defaultAct: 'ok', width: 640, height: 480, deviceId: 'cam-a' } } },
      video: makeVideo({ videoWidth: 1920, videoHeight: 1080 })
    });
    const b5 = await boot(h5);
    eq(reasons(b5.logs, 'CAM_RES_PREF'), ['miss'], 'E5 字段非法 → 当作没存过');

    // E6 指定设备的存档必须按「设备 id」存取：切走再切回（或重启）要能命中自己的档位。
    // 若存档键被写成固定键（串档），这里就命中不了。
    const store6 = {};
    const mk6 = function () {
      return makeCtrl({
        store: store6,
        mdOpts: { stream: { track: { caps: { width: { max: 1280 }, height: { max: 720 } }, defaultAct: 'ok', width: 640, height: 480, deviceId: 'cam-b' } } },
        video: makeVideo({ videoWidth: 1280, videoHeight: 720 })
      });
    };
    const h6a = mk6();
    const b6a = await boot(h6a, 'cam-b');
    eq(reasons(b6a.logs, 'CAM_RES_PREF'), ['miss'], 'E6 首次打开 B：没有存档');
    eq(h6a.store['cam-b'], { v: 1, w: 1280, h: 720, fps: 0, ts: h6a.store['cam-b'] ? h6a.store['cam-b'].ts : 0, dev: 'cam-b' },
      'E6 首次打开 B 后按设备 id 落档（不是落到默认键）');

    const h6b = mk6();
    const b6b = await boot(h6b, 'cam-b');
    eq(reasons(b6b.logs, 'CAM_RES_PREF'), ['hit'], 'E6 再次打开 B → 命中它自己的存档');
    eq(h6b.md.lastConstraints, { video: { deviceId: { exact: 'cam-b' }, width: { exact: 1280 }, height: { exact: 720 } }, audio: false },
      'E6 再次打开 B 时 gUM 带上该设备的记忆档位');
  }

  /* ---------------------------------------------------------------- *
   * F. 重启链路：新 controller + 上次存档 → gUM 必须带 exact
   * ---------------------------------------------------------------- */
  console.log('\n· F 重启链路');
  {
    const store = {};
    const mk = function () {
      return makeCtrl({
        store: store,
        mdOpts: { stream: { track: { caps: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 30, min: 5 } }, defaultAct: 'ok', width: 640, height: 480, deviceId: 'cam-a' } } },
        video: makeVideo({ videoWidth: 1920, videoHeight: 1080 })
      });
    };
    const h1 = mk();
    await boot(h1);
    eq(h1.ctrl.getResolution(), { width: 1920, height: 1080 }, 'F0 首次启动锁到最高档');
    assert(store[''] && store['cam-a'], 'F0 首次启动已落存档');

    // 模拟进程退出 → 重建 controller（store 不变）
    const h2 = mk();
    const b2 = await boot(h2);
    const lc = h2.md.lastConstraints;
    assert(lc && lc.video && lc.video.width && lc.video.width.exact === 1920 && lc.video.height && lc.video.height.exact === 1080,
      'F1 重启后第一次 gUM 就带上 width/height exact（实际 ' + JSON.stringify(lc) + '）');
    eq(reasons(b2.logs, 'CAM_RES_PREF'), ['hit'], 'F1 CAM_RES_PREF.reason = hit');
    eq(h2.ctrl.getResolution(), { width: 1920, height: 1080 }, 'F2 重启后实际输出即记忆档位（不回落默认档）');
    eq(h2.ctrl.getResolutionInfo().source, 'pref',
      'F2 来源应标 pref（记忆命中并成功复现）——实际 ' + h2.ctrl.getResolutionInfo().source);
    assert(b2.calls === 1, 'F3 重启后一次开流成功，没有先撞一次失败再降级（gUM ' + b2.calls + ' 次）');

    const h3 = mk();
    await boot(h3, 'cam-a');
    eq(h3.md.lastConstraints, { video: { deviceId: { exact: 'cam-a' }, width: { exact: 1920 }, height: { exact: 1080 }, frameRate: { ideal: 30 } }, audio: false },
      'F4 指定设备重启：deviceId 与分辨率同时在约束里');
  }

  /* ---------------------------------------------------------------- *
   * G. I1 单一活跃流 + 定时器（逐档探测全程）
   * ---------------------------------------------------------------- */
  console.log('\n· G I1 与定时器');
  {
    const caps = { width: { min: 160, max: 1600 }, height: { min: 120, max: 1200 } };
    const h = makeCtrl({
      mdOpts: { stream: { track: { caps: caps, defaultAct: 'ok', applyDelayMs: 10, width: 320, height: 200, deviceId: 'cam-a' } } },
      video: makeVideo({ videoWidth: 1600, videoHeight: 1200 })
    });
    const s0 = allStreams.length;
    const p = h.ctrl.mount();
    let peak = 0;
    let steps = 0;
    let liveSum = 0;
    let done = false;
    p.then(function () { done = true; }, function () { done = true; });
    while (!done && steps < 4000) {
      h.clock.advance(2);
      for (let i = 0; i < 200; i++) await Promise.resolve();
      const n = liveSince(s0);
      liveSum += n;
      peak = Math.max(peak, n);
      steps++;
    }
    assert(done, 'G1 open 结束（' + steps + ' 步，活跃流采样累计 ' + liveSum + '）');
    assert(peak === 1, 'G1 逐档探测全程「同时存在的未 stop 流」峰值 = 1（实际 ' + peak + '）——I1');
    assert(h.clock.count() === 0, 'G2 流程结束后 pending 定时器 = 0（实际 ' + h.clock.count() + '）');

    h.ctrl.unmount();
    assert(liveSince(s0) === 0, 'G3 unmount 后 live track = 0（实际 ' + liveSince(s0) + '）');
    assert(h.clock.count() === 0, 'G3 unmount 后 pending 定时器 = 0');

    // 带悬挂档位时中途 unmount：不得留下悬挂定时器 / 活流
    const s1 = allStreams.length;
    const h2 = makeCtrl({
      config: { applyConstraintMs: 500, resBudgetMs: 200 },
      mdOpts: { stream: { track: { caps: caps, defaultAct: 'hang', width: 320, height: 200, deviceId: 'cam-a' } } },
      video: makeVideo({ videoWidth: 320, videoHeight: 200 })
    });
    const p2 = h2.ctrl.mount();
    let d2 = false;
    p2.then(function () { d2 = true; }, function () { d2 = true; });
    for (let i = 0; i < 20 && !d2; i++) { h2.clock.advance(10); for (let k = 0; k < 50; k++) await Promise.resolve(); }
    h2.ctrl.unmount();
    await settle(h2.clock, p2, 3000);
    assert(liveSince(s1) === 0, 'G4 悬挂场景中途 unmount 后无活流（实际 ' + liveSince(s1) + '）');
    assert(h2.clock.count() === 0, 'G4 悬挂场景中途 unmount 后无悬挂定时器（实际 ' + h2.clock.count() + '）');
  }

  /* ---------------------------------------------------------------- *
   * H. 既有契约回归
   * ---------------------------------------------------------------- */
  console.log('\n· H 既有契约回归');
  {
    // H1 无记忆档位 → gUM 约束与旧实现一字不差
    const h1 = makeCtrl({ store: {}, mdOpts: { stream: { track: { deviceId: 'cam-x' } } } });
    await boot(h1);
    eq(h1.md.allConstraints[0], { video: true, audio: false }, 'H1 无设备无记忆 → { video:true, audio:false }');

    const h2 = makeCtrl({ store: {}, mdOpts: { stream: { track: { deviceId: 'cam-x' } } } });
    await boot(h2, 'cam-x');
    eq(h2.md.lastConstraints, { video: { deviceId: { exact: 'cam-x' } }, audio: false }, 'H1 有设备无记忆 → deviceId exact');

    // H2 getResolution() 形状恒为 { width, height }
    const h3 = makeCtrl({
      mdOpts: { stream: { track: { caps: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 30, min: 5 } }, defaultAct: 'ok', width: 640, height: 480, deviceId: 'cam-a' } } },
      video: makeVideo({ videoWidth: 1920, videoHeight: 1080 })
    });
    await boot(h3);
    const res = h3.ctrl.getResolution();
    eq(Object.keys(res).sort(), ['height', 'width'], 'H2 getResolution() 只有 width/height（不破坏旧断言）');
    assert(typeof res.width === 'number' && typeof res.height === 'number', 'H2 宽高为数字');

    const snap = h3.ctrl.snapshot();
    ['state', 'error', 'seq', 'attempt', 'hasStream', 'resolution', 'preferredId', 'alive', 'liveTracks'].forEach(function (k) {
      assert(Object.prototype.hasOwnProperty.call(snap, k), 'H3 snapshot 保留旧字段 ' + k);
    });
    assert(Object.prototype.hasOwnProperty.call(snap, 'resolutionRequest') && Object.prototype.hasOwnProperty.call(snap, 'resolutionSource'),
      'H3 snapshot 新增 resolutionRequest / resolutionSource');
    eq(snap.resolution, { width: 1920, height: 1080 }, 'H3 snapshot.resolution 形状未变');

    // H4 日志字段契约：res 恒 {w,h}、err 恒 {name,message}、附加字段 ≤6 且为原始类型
    const RES_EVENTS = ['CAM_RES_ENUM', 'CAM_RES_PREF', 'CAM_RES_APPLY', 'CAM_RES_VERIFY', 'CAM_RES_FALLBACK', 'CAM_RES_PERSIST'];
    const h4 = makeCtrl({
      store: {},
      mdOpts: {
        supported: [[1920, 1080]],
        stream: { track: { caps: { width: { min: 160, max: 1600 }, height: { min: 120, max: 1200 }, frameRate: { max: 60, min: 5 } }, plan: [{ at: 0, act: 'over' }, { at: 1, act: 'mismatch' }], defaultAct: 'ok', width: 320, height: 200, deviceId: 'cam-a' } }
      },
      video: makeVideo({ videoWidth: 1280, videoHeight: 1024 })
    });
    const b4 = await boot(h4);
    const resLogs = b4.logs.filter(function (l) { return RES_EVENTS.indexOf(l.event) >= 0; });
    assert(resLogs.length > 0, 'H4 采集到 ' + resLogs.length + ' 条 CAM_RES_* 日志');
    const shapeBad = [];
    resLogs.forEach(function (l) {
      const f = l.fields || {};
      if (f.res != null) {
        if (typeof f.res !== 'object' || Object.keys(f.res).sort().join(',') !== 'h,w' ||
            typeof f.res.w !== 'number' || typeof f.res.h !== 'number') {
          shapeBad.push(l.event + ' res=' + JSON.stringify(f.res));
        }
      }
      if (f.err != null) {
        if (typeof f.err !== 'object' || Object.keys(f.err).sort().join(',') !== 'message,name') {
          shapeBad.push(l.event + ' err=' + JSON.stringify(f.err));
        }
      }
      const extra = Object.keys(f).filter(function (k) { return k !== 'res' && k !== 'err'; });
      if (extra.length > 6) shapeBad.push(l.event + ' 附加字段 ' + extra.length + ' 个 > 6');
      extra.forEach(function (k) {
        const v = f[k];
        if (v !== null && ['string', 'number', 'boolean'].indexOf(typeof v) < 0) {
          shapeBad.push(l.event + '.' + k + ' 非原始类型：' + typeof v);
        }
      });
    });
    assert(shapeBad.length === 0, 'H4 CAM_RES_* 日志字段契约（实际违规：' + shapeBad.join(' | ') + '）');
  }

  /* ---------------------------------------------------------------- *
   * I. 出画后交叉校验：以画面真实尺寸为准
   * ---------------------------------------------------------------- */
  console.log('\n· I 出画后交叉校验');
  {
    // track 被提到 1920×1080，但 video 实际只出 640×480（驱动没真切档）
    const h = makeCtrl({
      mdOpts: { stream: { track: { caps: { width: { max: 1920 }, height: { max: 1080 } }, defaultAct: 'ok', width: 640, height: 480, deviceId: 'cam-a' } } },
      video: makeVideo({ videoWidth: 640, videoHeight: 480 })
    });
    const b = await boot(h);
    eq(h.ctrl.getResolution(), { width: 640, height: 480 }, 'I1 以画面真实尺寸为准（状态显示不撒谎）');
    assert(reasons(b.logs, 'CAM_RES_VERIFY').indexOf('video-mismatch') >= 0, 'I1 记下 video-mismatch 证据');
    eq(h.ctrl.getResolutionInfo().request, { width: 1920, height: 1080 }, 'I2 请求档位仍如实暴露（两者不一致即驱动降档的铁证）');
  }

  console.log('\n· 全局审计');
  console.log('  · 全程累计创建 ' + allStreams.length + ' 条流');

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  if (fail) {
    console.log('\n失败清单：');
    failures.forEach(function (m) { console.log('  - ' + m); });
  }
}
