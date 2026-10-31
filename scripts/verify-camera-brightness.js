'use strict';
/* =============================================================================
 * verify-camera-brightness.js —— 摄像头原生亮度（brightness）调节回归主检
 *
 *   node scripts/verify-camera-brightness.js
 *
 * 覆盖三部分：
 *   A. 纯函数层：能力探测 capabilityProbeBrightness / 量程钳位 clampBrightnessValue
 *      / 设备默认推导 defaultBrightnessValue（含负向对照）
 *   B. 控制器编排：开流进入 LIVE 后 refreshBrightness 按记忆恢复并下发、
 *      setBrightness 实时预览（不存档）/ 提交存档（本设备 / 全局默认两种槽位）、
 *      resetBrightness 清设备覆盖、能力不支持时整体 no-op、悬挂 track 超时竞速
 *   C. 变异测试（负向对照）：注入缺陷后断言必须转红，证明用例不是摆设
 *
 * 取代原 verify-camera-exposure*.js（v1.2.19 移除自动曝光辅助引擎，改用本滑块）。
 * 只依赖 Node 内置模块与 renderer/camera-controller.js（UMD，Node 下可 require）。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const os = require('os');

const C = require(process.env.CAM_CTRL_PATH || '../renderer/camera-controller.js');

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
  assert(isFinite(d) && d <= (tol == null ? 1e-9 : tol), m + '（实际 ' + a + '，期望 ' + b + '±' + (tol == null ? 1e-9 : tol) + '）');
}

const ROOT = path.resolve(__dirname, '..');
const CTRL_PATH = process.env.CAM_CTRL_PATH
  ? (path.isAbsolute(process.env.CAM_CTRL_PATH) ? process.env.CAM_CTRL_PATH : path.resolve(ROOT, process.env.CAM_CTRL_PATH))
  : path.join(ROOT, 'renderer', 'camera-controller.js');

/* ========================================================================== *
 * 一、虚拟时钟 + 假对象（确定性，无真实 sleep）
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
async function drain(p, n) {
  let done = false, value;
  Promise.resolve(p).then(function (v) { done = true; value = v; }, function (e) { done = true; value = e; });
  for (let i = 0; i < (n || 800) && !done; i++) await Promise.resolve();
  return { done: done, value: value };
}
async function pump(clock, ms, step) {
  const st = step || 5;
  const target = clock.t() + ms;
  while (clock.t() < target) { clock.advance(st); await flush(24); }
  await flush(80);
}

/* ---------- 假 track / 假流 / 假 video ---------- */
function makeBrightTrack(opts) {
  const o = opts || {};
  const t = {
    readyState: 'live', muted: false, _h: {},
    caps: o.caps !== undefined ? o.caps
      : { brightness: { min: -64, max: 64, step: 1 }, width: { min: 320, max: 1920 }, height: { min: 240, max: 1080 } },
    settings: o.settings || { brightness: 0, deviceId: 'dev-A' },
    calls: [], hang: !!o.hang, reject: !!o.reject,
    addEventListener(k, f) { (this._h[k] = this._h[k] || []).push(f); },
    removeEventListener(k, f) { const a = this._h[k] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); },
    stop() { this.readyState = 'ended'; },
    getCapabilities() { return this.caps; },
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
  return { readyState: 4, videoWidth: 640, videoHeight: 480, srcObject: null, play() { return Promise.resolve(); } };
}

/* 造一套完整的假环境（控制器 + 虚拟时钟 + 可变亮度记忆）。 */
function makeBrightHarness(over) {
  const o = over || {};
  const clock = o.clock || makeClock(100000);
  const logs = [];
  const pref = o.pref ? JSON.parse(JSON.stringify(o.pref)) : { default: null, devices: {} };
  const track = o.track || makeBrightTrack(o.trackOpts);
  const stream = { getTracks: function () { return [track]; }, getVideoTracks: function () { return [track]; } };
  const video = o.video || makeVideo();
  const md = {
    getUserMedia() { return Promise.resolve(stream); },
    enumerateDevices() { return Promise.resolve([]); },
    addEventListener() {}, removeEventListener() {}
  };
  const ctrl = C.createCameraController({
    mediaDevices: md,
    videoGetter: function () { return video; },
    now: function () { return clock.now(); },
    setTimeout: function (fn, ms) { return clock.setTimeout(fn, ms); },
    clearTimeout: function (id) { return clock.clearTimeout(id); },
    log: function (lv, ev, f) { logs.push({ level: lv, event: ev, fields: f || {} }); },
    frameSampler: function () { return o.gray || new Array(64 * 64).fill(140); },
    loadBrightnessPref: function () { return pref; },
    saveBrightnessPref: function (s) {
      pref.default = (s && typeof s.default === 'number') ? s.default : null;
      pref.devices = (s && s.devices && typeof s.devices === 'object') ? s.devices : {};
    },
    config: Object.assign({}, C.DEFAULTS, {
      applyConstraintMs: 40, attachTimeoutMs: 40, openTimeoutMs: 200, frameWaitMs: 100, framePollMs: 5,
      degradedWatchMs: 60, backoffMs: [10, 10, 10, 10], maxAttempts: 5,
      resBudgetMs: 200, resMaxRungs: 4, resMaxFps: 1
    }, o.config || {})
  });
  const eventsOf = (name) => logs.filter((x) => x.event === name);
  return { clock, logs, eventsOf, track, stream, video, md, ctrl, pref };
}

async function boot(h) {
  await drain(h.ctrl.mount(function () { return h.video; }));
  await flush(40);
}

/* ========================================================================== *
 * A. 纯函数层
 * ======================================================================== */
function brightnessPureChecks(M) {
  let p = 0, f = 0; const fails = [];
  function a(cond, m) { if (cond) p++; else { f++; fails.push(m); } }
  function e(va, vb, m) { const s = JSON.stringify(va), t = JSON.stringify(vb); if (s === t) p++; else { f++; fails.push(m + '（' + s + '/' + t + '）'); } }

  // A1 能力探测
  let cap = M.capabilityProbeBrightness({ brightness: { min: -64, max: 64, step: 1 } });
  a(cap.supported === true && cap.min === -64 && cap.max === 64 && cap.step === 1, 'A1 合法量程 → supported');
  cap = M.capabilityProbeBrightness({});
  a(cap.supported === false, 'A1 无 brightness 能力 → unsupported');
  cap = M.capabilityProbeBrightness({ brightness: { max: 64 } });
  a(cap.supported === false, 'A1 缺 min → unsupported');
  cap = M.capabilityProbeBrightness({ brightness: { min: -64 } });
  a(cap.supported === false, 'A1 缺 max → unsupported');
  cap = M.capabilityProbeBrightness({ brightness: { min: 0, max: 0, step: 1 } });
  a(cap.supported === false, 'A1 退化量程 min>=max → unsupported');
  cap = M.capabilityProbeBrightness({ brightness: { min: -64, max: 64, step: 0 } });
  a(cap.supported === true && cap.step === 0, 'A1 step 非正数归一为 0');

  // A2 量程钳位 + 步进对齐
  const c = { min: -64, max: 64, step: 1 };
  e(M.clampBrightnessValue(-100, c), -64, 'A2 低于下限→钳到 -64');
  e(M.clampBrightnessValue(100, c), 64, 'A2 高于上限→钳到 64');
  e(M.clampBrightnessValue(10, c), 10, 'A2 区间内→原值');
  e(M.clampBrightnessValue(10.5, c), 11, 'A2 step 对齐：10.5→11（向最近档，.5 进位）');
  e(M.clampBrightnessValue(10.6, c), 11, 'A2 step 对齐：10.6→11');
  e(M.clampBrightnessValue('abc', c), -64, 'A2 非数字→钳到下限');
  const c0 = { min: 0, max: 255, step: 0 };
  e(M.clampBrightnessValue(300, c0), 255, 'A2 step=0 仅钳位：300→255');
  e(M.clampBrightnessValue(128, c0), 128, 'A2 step=0 不取整：128→128');

  // A3 设备默认推导
  const cap2 = M.capabilityProbeBrightness({ brightness: { min: -64, max: 64, step: 1 } });
  e(M.defaultBrightnessValue(cap2, { brightness: 5 }), 5, 'A3 用 settings.brightness');
  e(M.defaultBrightnessValue(cap2, { brightness: 999 }), 64, 'A3 settings 超限被钳位');
  e(M.defaultBrightnessValue(cap2, {}), 0, 'A3 无 settings→量程中点');
  e(M.defaultBrightnessValue(cap2, null), 0, 'A3 settings 为 null→量程中点');
  // A4 亮度校准（扫码成功钩子）
  const cb = { supported: true, min: -64, max: 64, step: 1 };
  // 偏暗帧（均值 30）-> 亮度应上调；偏亮帧（均值 220）-> 亮度应下调
  const up = M.calibrateBrightness(30, cb, 0);
  a(up > 0, 'A4 偏暗帧(30) -> 亮度上调 (>0)');
  const down = M.calibrateBrightness(220, cb, 0);
  a(down < 0, 'A4 偏亮帧(220) -> 亮度下调 (<0)');
  // 中灰附近（均值 140）-> 死区内，保持原值
  e(M.calibrateBrightness(140, cb, 0), 0, 'A4 中灰(140)在死区内 -> 保持 0');
  // 不支持能力 -> no-op 返回原值
  e(M.calibrateBrightness(30, { supported: false, min: 0, max: 0, step: 1 }, 5), 5, 'A4 不支持能力 -> 返回原值');
  // 帧均值不可信（NaN）-> 不动
  e(M.calibrateBrightness(NaN, cb, 0), 0, 'A4 帧均值 NaN -> 保持原值');
  // 已封顶/封底：偏暗但已在 max -> 钳在 max；偏亮但已在 min -> 钳在 min
  e(M.calibrateBrightness(30, cb, 64), 64, 'A4 已在 max 且偏暗 -> 钳在 64');
  e(M.calibrateBrightness(220, cb, -64), -64, 'A4 已在 min 且偏亮 -> 钳在 -64');
  // 步进对齐：step>0 时结果对齐到步进网格
  const cb2 = { supported: true, min: 0, max: 255, step: 5 };
  const cval = M.calibrateBrightness(30, cb2, 0);
  a((cval % 5) === 0, 'A4 步进对齐：结果落在 step 网格上 (' + cval + ')');
  return { p, f, fails };
}

/* ========================================================================== *
 * B. 控制器编排
 * ======================================================================== */
async function sectionB() {
  console.log('  B. 控制器编排');

  // B1 支持设备：开流后用设备自身默认亮度（settings.brightness）恢复并下发
  {
    const h = makeBrightHarness({ trackOpts: { settings: { brightness: 0, deviceId: 'dev-A' } } });
    await boot(h);
    const st = await h.ctrl.refreshBrightness();
    assert(st.capability.supported === true, 'B1 能力 supported');
    eq(st.effective, 0, 'B1 生效值=设备默认亮度 0');
    eq(st.source, 'native', 'B1 来源=native');
    const applied = h.track.calls.some((c) => c.advanced && c.advanced[0] && c.advanced[0].brightness === 0);
    assert(applied, 'B1 refresh 通过 advanced.brightness=0 下发');
  }

  // B2 记忆优先：设备覆盖 > 全局默认 > 设备自身默认
  {
    const h = makeBrightHarness({ pref: { default: 30, devices: {} }, trackOpts: { settings: { brightness: 0, deviceId: 'dev-A' } } });
    await boot(h);
    const st = await h.ctrl.refreshBrightness();
    eq(st.effective, 30, 'B2 全局默认优先于设备默认');
    eq(st.source, 'default', 'B2 来源=default');
  }
  {
    const h = makeBrightHarness({ pref: { default: 30, devices: { 'dev-A': 25 } }, trackOpts: { settings: { brightness: 0, deviceId: 'dev-A' } } });
    await boot(h);
    const st = await h.ctrl.refreshBrightness();
    eq(st.effective, 25, 'B2 设备覆盖优先于全局默认');
    eq(st.source, 'device', 'B2 来源=device');
  }

  // B3 实时拖动：仅下发不存档
  {
    const h = makeBrightHarness({ pref: { default: 30, devices: {} }, trackOpts: { settings: { brightness: 0, deviceId: 'dev-A' } } });
    await boot(h);
    await h.ctrl.refreshBrightness();
    const r = await h.ctrl.setBrightness(40, { persist: false });
    assert(r.applied === true, 'B3 实时下发成功');
    const applied = h.track.calls.some((c) => c.advanced && c.advanced[0] && c.advanced[0].brightness === 40);
    assert(applied, 'B3 下发 advanced.brightness=40');
    eq(h.pref, { default: 30, devices: {} }, 'B3 实时拖动不写持久化');
  }

  // B4 提交（本设备）：写入 devices[deviceId]
  {
    const h = makeBrightHarness({ pref: { default: 30, devices: {} }, trackOpts: { settings: { brightness: 0, deviceId: 'dev-A' } } });
    await boot(h);
    await h.ctrl.refreshBrightness();
    const r = await h.ctrl.setBrightness(40, { persist: true, scope: 'device' });
    eq(r.source, 'device', 'B4 提交后来源=device');
    eq(h.pref.devices['dev-A'], 40, 'B4 设备覆盖写入 devices[dev-A]=40');
    eq(h.pref.default, 30, 'B4 全局默认未被改动');
  }

  // B5 提交（全局默认）：写入 default 并清掉设备覆盖
  {
    const h = makeBrightHarness({ pref: { default: 30, devices: { 'dev-A': 25 } }, trackOpts: { settings: { brightness: 0, deviceId: 'dev-A' } } });
    await boot(h);
    await h.ctrl.refreshBrightness();
    const r = await h.ctrl.setBrightness(50, { persist: true, scope: 'default' });
    eq(r.source, 'default', 'B5 提交后来源=default');
    eq(h.pref.default, 50, 'B5 全局默认写入 50');
    assert(h.pref.devices['dev-A'] === undefined, 'B5 设备覆盖被清除（跟随全局）');
  }

  // B6 重置：清设备覆盖，回退到全局默认并下发
  {
    const h = makeBrightHarness({ pref: { default: 30, devices: { 'dev-A': 25 } }, trackOpts: { settings: { brightness: 0, deviceId: 'dev-A' } } });
    await boot(h);
    await h.ctrl.refreshBrightness();
    const st = await h.ctrl.resetBrightness();
    eq(st.effective, 30, 'B6 重置后回退到全局默认 30');
    eq(st.source, 'default', 'B6 来源=default');
    const applied = h.track.calls.some((c) => c.advanced && c.advanced[0] && c.advanced[0].brightness === 30);
    assert(applied, 'B6 重置后下发 brightness=30');
    assert(h.pref.devices['dev-A'] === undefined, 'B6 设备覆盖已清除');
  }

  // B7 不支持设备：整体 no-op，不向 track 下发 brightness
  {
    const h = makeBrightHarness({ trackOpts: { caps: { width: { min: 320, max: 1920 }, height: { min: 240, max: 1080 } }, settings: { deviceId: 'dev-A' } } });
    await boot(h);
    const st = await h.ctrl.refreshBrightness();
    assert(st.capability.supported === false, 'B7 无 brightness 能力 → supported=false');
    eq(st.effective, 0, 'B7 生效值保持 0');
    const leaked = h.track.calls.some((c) => c.advanced && c.advanced[0] && c.advanced[0].brightness !== undefined);
    assert(!leaked, 'B7 不向 track 下发任何 brightness 约束');
    const r = await h.ctrl.setBrightness(10, { persist: true, scope: 'device' });
    assert(r.applied === false, 'B7 不支持时 setBrightness 不生效');
    eq(h.pref, { default: null, devices: {} }, 'B7 不支持时不写持久化');
  }

  // B8 悬挂 track：applyConstraints 永不 settle → 超时竞速兜底，记 CAM_BRIGHT_FAIL
  {
    const h = makeBrightHarness({ trackOpts: { settings: { brightness: 0, deviceId: 'dev-A' }, hang: true } });
    await boot(h);
    const p = h.ctrl.refreshBrightness();
    await pump(h.clock, 120, 5);
    const st = await p;
    assert(st.capability.supported === true, 'B8 能力仍探测为支持');
    assert(h.eventsOf('CAM_BRIGHT_FAIL').length > 0, 'B8 悬挂下发超时记 CAM_BRIGHT_FAIL');
  }
}

/* ========================================================================== *
 * C. 变异测试（负向对照）
 * ======================================================================== */
function loadMutant(mutate) {
  const src = fs.readFileSync(CTRL_PATH, 'utf8');
  const mutated = mutate(src);
  const tmp = path.join(os.tmpdir(), 'cam-ctrl-bright-mutant-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.js');
  fs.writeFileSync(tmp, mutated, 'utf8');
  try { delete require.cache[require.resolve(tmp)]; } catch (e) {}
  const M = require(tmp);
  return M;
}

async function sectionC() {
  console.log('  C. 变异测试（负向对照）');
  const real = brightnessPureChecks(C);
  real.fails.forEach((m) => bad('[纯函数真实用例] ' + m));
  pass += real.p;
  ok('A 纯函数真实用例 ' + real.p + '/' + real.p + ' 通过');

  function mutantRun(name, mutate) {
    const M = loadMutant(mutate);
    const r = brightnessPureChecks(M);
    if (r.f === 0) bad('变异体「' + name + '」漏网：注入缺陷后纯函数用例仍全过');
    else ok('变异体「' + name + '」被抓住（' + r.f + ' 条转红）');
  }
  // 去掉上限钳位 → 「高于上限→钳到 64」用例应转红
  mutantRun('clamp 去掉上限钳位', (s) => s.replace('if (v > hi) v = hi;', '/* removed */'));
  // 去掉退化量程拒识 → 「min>=max → unsupported」用例应转红
  mutantRun('capabilityProbe 去掉 min>=max 拒识', (s) => s.replace('|| b.max <= b.min', ''));
  // 去掉 step 对齐 → 步进对齐用例应转红
  mutantRun('clamp 去掉步进对齐', (s) => s.replace('v = lo + steps * cap.step;', 'v = v; /* removed */'));
  mutantRun('calibrate 翻转误差符号（暗帧应提亮→变压暗）', (s) => s.replace('newFrac = curFrac + err * gain;', 'newFrac = curFrac - err * gain;'));
  mutantRun('calibrate 去掉死区（中灰应保持→变调整）', (s) => s.replace('if (Math.abs(err) <= deadband) return currentValue;', '/* removed */'));
}

/* ========================================================================== */
async function main() {
  console.log('=== verify-camera-brightness：摄像头原生亮度调节回归 ===\n');
  console.log('  A. 纯函数层');
  // A 真实用例在 sectionC 内汇总，这里先占位说明
  await sectionB();
  await sectionC();
  console.log('\n' + (fail ? 'FAILED' : 'ALL PASSED') + ' —— pass=' + pass + ' fail=' + fail);
  if (fail) { process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(2); });
