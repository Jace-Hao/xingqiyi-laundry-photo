'use strict';
/* 摄像头黑屏修复 · 纯逻辑验证脚本（任务 #4 / 4.1）
 *
 * node scripts/verify-camera.js
 *
 * 覆盖契约 §6.3 的七条不变式与 §8 的错误恢复矩阵：
 *   I1 单一活跃流        I2 谁创建谁停止      I3 显示与状态一致
 *   I4 错误必可见        I5 拍照闸门          I6 attach 必成功或必报错
 *   I7 卸载即释放
 *
 * 与 .workbuddy/tmp/smoke-camera.js 的关系：那份是开发期冒烟，本份是交付脚本，
 * 差异有三：①每个用例独立审计「本用例产生的流是否全部停止」；
 *          ②补了契约里冒烟没覆盖的分支（I3/I4、设备插拔、幂等、UNSUPPORTED、
 *            空采样、sampleCenterGray 正确性、退避钳位、DEGRADED 观察期）；
 *          ③结尾做全局泄漏审计，退出码非 0 即失败。
 *
 * 只依赖 renderer/camera-controller.js（UMD，Node 下 module.exports），不碰 DOM。
 */
const C = require('../renderer/camera-controller.js');

let pass = 0;
let fail = 0;
const failures = [];

function ok(m) { pass++; console.log('  ✓ ' + m); }
function bad(m) { fail++; failures.push(m); console.log('  ✗ ' + m); }
function assert(cond, m) { cond ? ok(m) : bad(m); }
function eq(a, b, m) { assert(JSON.stringify(a) === JSON.stringify(b), m + '（实际 ' + JSON.stringify(a) + '）'); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 假对象 ---------- */
const allStreams = [];

function makeTrack() {
  return {
    readyState: 'live',
    muted: false,
    _h: {},
    addEventListener(t, f) { (this._h[t] = this._h[t] || []).push(f); },
    removeEventListener(t, f) { const a = this._h[t] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); },
    stop() { this.readyState = 'ended'; },
    getCapabilities() { return { width: { max: 1920 }, height: { max: 1080 } }; },
    applyConstraints() { return Promise.resolve(); },
    getSettings() { return { width: 1920, height: 1080 }; },
    fire(t) { (this._h[t] || []).slice().forEach((f) => f()); }
  };
}
function makeStream() {
  const t = makeTrack();
  const s = { getTracks: () => [t], getVideoTracks: () => [t], __t: t };
  allStreams.push(s);
  return s;
}
function makeVideo(over) {
  return Object.assign({
    readyState: 4, videoWidth: 1920, videoHeight: 1080,
    srcObject: null,
    play() { return Promise.resolve(); }
  }, over || {});
}
function makeMd(opts) {
  const o = opts || {};
  const self = {
    calls: 0,
    lastConstraints: null,
    err: o.err || null,
    _h: {},
    getUserMedia(constraints) {
      self.calls += 1;
      self.lastConstraints = constraints;
      const err = self.err;
      const delay = o.delay == null ? 5 : o.delay;
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          if (err) return reject(Object.assign(new Error(err), { name: err }));
          resolve(makeStream());
        }, delay);
      });
    },
    enumerateDevices() { return Promise.resolve([]); },
    addEventListener(t, f) { (self._h[t] = self._h[t] || []).push(f); },
    removeEventListener(t, f) { const a = self._h[t] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); },
    fire(t) { (self._h[t] || []).slice().forEach((f) => f()); }
  };
  return self;
}

const live = (list) => list.filter((s) => s.__t.readyState === 'live').length;
const liveAll = () => live(allStreams);

/* 用例包装：用例结束后审计「本用例产生的流是否全部停止」——这是 I1/I2/I7 的总闸 */
async function test(name, fn) {
  const mark = allStreams.length;
  console.log('\n· ' + name);
  try {
    await fn();
  } catch (e) {
    bad(name + ' 用例抛异常：' + (e && e.message));
  }
  const mine = allStreams.slice(mark);
  const leaked = live(mine);
  assert(leaked === 0, '本用例产生的 ' + mine.length + ' 条流全部已停止（残留 live ' + leaked + '）');
}

/* 通用小配置：把真实世界的秒级等待压到毫秒，行为不变 */
const CFG = {
  openTimeoutMs: 400,
  frameWaitMs: 200,
  framePollMs: 10,
  degradedWatchMs: 60,
  attachTimeoutMs: 300,
  backoffMs: [10, 10, 10, 10],
  maxAttempts: 5
};
function make(log, over) {
  const o = Object.assign({
    mediaDevices: makeMd(),
    videoGetter: () => makeVideo(),
    config: CFG,
    log: log || function () {}
  }, over || {});
  return C.createCameraController(o);
}

async function main() {
  console.log('=== verify-camera：摄像头生命周期契约 ===');

  /* ---------- 0. 契约常量 ---------- */
  console.log('\n· 契约常量（§8）');
  eq(C.DEFAULTS.backoffMs, [400, 800, 1600, 3200], 'DEFAULTS.backoffMs = 400/800/1600/3200');
  assert(C.DEFAULTS.openTimeoutMs === 8000, 'DEFAULTS.openTimeoutMs = 8000');
  assert(C.DEFAULTS.maxAttempts === 5, 'DEFAULTS.maxAttempts = 5');
  eq(C.STATES, { UNINIT: 'UNINIT', STARTING: 'STARTING', LIVE: 'LIVE', DEGRADED: 'DEGRADED', SLEEPING: 'SLEEPING', ERROR: 'ERROR' }, 'STATES 六态齐全');

  /* ---------- 1. classifyError 分类矩阵 ---------- */
  console.log('\n· 错误分类矩阵（§8）');
  assert(C.classifyError({ name: 'NotAllowedError' }).code === 'PERMISSION_DENIED', 'NotAllowedError → PERMISSION_DENIED');
  assert(C.classifyError({ name: 'NotAllowedError' }).fatal === true, 'PERMISSION_DENIED 不可重试');
  assert(C.classifyError({ name: 'SecurityError' }).code === 'SECURITY', 'SecurityError → SECURITY');
  assert(C.classifyError({ name: 'NotFoundError' }).code === 'NO_DEVICE', 'NotFoundError → NO_DEVICE');
  assert(C.classifyError({ name: 'OverconstrainedError' }).code === 'OVERCONSTRAINED', 'OverconstrainedError → OVERCONSTRAINED');
  assert(C.classifyError({ name: 'OverconstrainedError' }).recoverable === true, 'OVERCONSTRAINED 可重试（降级）');
  assert(C.classifyError({ name: 'NotReadableError' }).code === 'DEVICE_BUSY', 'NotReadableError → DEVICE_BUSY');
  assert(C.classifyError({ name: 'TrackStartError' }).code === 'DEVICE_BUSY', 'TrackStartError → DEVICE_BUSY');
  assert(C.classifyError({ name: 'AbortError' }).code === 'DEVICE_BUSY', 'AbortError → DEVICE_BUSY');
  assert(C.classifyError({ name: 'WhateverError' }).code === 'UNKNOWN', '未知错误 → UNKNOWN');
  assert(!!C.classifyError({ name: 'NotAllowedError' }).message, '错误对象带中文引导文案（I4）');

  /* ---------- 2. 纯函数：灰度采样与黑帧判定 ---------- */
  console.log('\n· 黑帧检测（防黑照片入库）');
  {
    const n = 64 * 64;
    const black = new Array(n).fill(5);
    const normal = new Array(n).fill(128);
    const dark = [];
    for (let i = 0; i < n; i++) dark.push(20 + (i % 7) * 4); // 暗但有细节：模拟深色衣物
    assert(C.analyzeGraySamples(black).black === true, '纯黑样本判黑（均值 5 < 12 且方差 0 < 4）');
    assert(C.analyzeGraySamples(normal).black === false, '正常样本不判黑');
    assert(C.analyzeGraySamples(dark).black === false, '暗但细节丰富的样本不误杀（防深色衣物误判）');
    const empty = C.analyzeGraySamples([]);
    assert(empty.black === false && empty.mean === null, '空采样不判黑（采样失败要放行而非拦拍）');

    // sampleCenterGray：4×4 图取中心 2×2，中心像素置白、四周置黑
    const w = 4, h = 4;
    const data = new Array(w * h * 4).fill(0);
    const white = [20, 24, 36, 40]; // 中心 2×2 的 R 通道下标
    white.forEach((i) => { data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; });
    const s = C.sampleCenterGray({ data, width: w, height: h }, 2);
    eq(s, [255, 255, 255, 255], 'sampleCenterGray 正确取到中心 2×2 灰度');
    assert(C.sampleCenterGray({ data: null, width: 0, height: 0 }, 2) === null, '无图像数据时返回 null');
  }

  /* ---------- 3. 正常打开：I3 / I5 / 分辨率 ---------- */
  await test('正常打开', async () => {
    const logs = [];
    const md = makeMd();
    const video = makeVideo();
    const c = make((l, e, f) => logs.push({ l, e, f }), { mediaDevices: md, videoGetter: () => video });
    assert(c.state === 'UNINIT' && c.canCapture() === false, '未 mount 时 canCapture 为假（I5）');
    const r = await c.mount(() => video);
    assert(r === true && c.state === 'LIVE', 'mount → LIVE');
    assert(logs.some((x) => x.e === 'CAM_LIVE'), '记录 CAM_LIVE');
    assert(video.srcObject === c.getStream(), 'video.srcObject 与 stream 同一对象（I3）');
    eq(c.getResolution(), { width: 1920, height: 1080 }, '记录摄像头最大分辨率');
    assert(c.canCapture() === true, 'LIVE 时 canCapture 为真（I5）');
    assert(liveAll() === 1, '全程只有 1 条 live track（I1）');
    c.unmount();
    assert(c.getStream() === null, 'unmount 后 stream 为 null（I3）');
  });

  /* ---------- 4. RC-1a：gUM 未返回就卸载，迟到的流必须被 stop ---------- */
  await test('RC-1a 卸载竞态（最贴现场的复现路径 R2）', async () => {
    const logs = [];
    const md = makeMd({ delay: 80 });
    const c = make((l, e, f) => logs.push({ l, e, f }), { mediaDevices: md, videoGetter: () => null });
    c.mount(() => null);
    assert(c.canCapture() === false, 'STARTING 期间禁止拍照（I5）');
    await sleep(10);
    c.unmount();
    await sleep(200);
    assert(logs.some((x) => x.e === 'CAM_LEAK_GUARD'), '记录 CAM_LEAK_GUARD（线上唯一的泄漏证据）');
  });

  /* ---------- 5. RC-1b：并发 open 只保留 1 条流 ---------- */
  await test('RC-1b 并发取流（复现路径 R1/R8）', async () => {
    const md = makeMd({ delay: 10 });
    const video = makeVideo();
    const c = make(null, { mediaDevices: md, videoGetter: () => video });
    c.mount(() => video);
    const p1 = c.open('cam-a');
    const p2 = c.open('cam-a');
    const p3 = c.open('cam-b');
    await Promise.all([p1, p2, p3]);
    await sleep(60);
    assert(c.state === 'LIVE', '并发 3 次 open 后进入 LIVE（' + c.state + '）');
    assert(c.snapshot().preferredId === 'cam-b', '最终生效的是最后一次请求的设备');
    c.unmount();
  });

  /* ---------- 6. open() 幂等：STARTING 期间同设备不重复取流 ----------
   * 这两条曾是全脚本仅有的红灯：R10 授权预检让 open() 变成异步，预检 await 期间
   * state 仍是 UNINIT、openPromise 仍为 null，幂等分支（要求 state === STARTING）
   * 整个失效，重复 open 会真的取两次流；真机上表现为扫码唤醒与 mount 撞车时
   * 摄像头被开两次、第二次 NotReadableError —— 与 RC-1b 同源。
   * 已修：预检移进 STARTING 会话内部（attemptLoop 在 attempt===0 时执行），
   * 状态与令牌在预检期间就已生效，卸载/休眠/再开一律由令牌裁决。
   * 保留这两条作为回归闸门，不要删。 */
  await test('STARTING 期间幂等（回归闸门：曾因预检异步化而红）', async () => {
    const md = makeMd({ delay: 50 });
    const video = makeVideo();
    const c = make(null, { mediaDevices: md, videoGetter: () => video });
    const p1 = c.mount(() => video);
    const p2 = c.open('');
    await Promise.all([p1, p2]);
    assert(md.calls === 1, '同设备重复 open 只调用 1 次 getUserMedia（实际 ' + md.calls + '）');
    assert(liveAll() >= 1 && c.state === 'LIVE', '仍能正常出画');
    c.unmount();
  });

  /* 无 checkAccess 时 open() 全程同步，幂等天然成立；生产配置下 checkAccess 一定注入
   * （window.api.cameraAccess），预检在 STARTING 会话内部执行，必须单独钉住它不会
   * 把幂等窗口重新拆开 */
  await test('注入 checkAccess 后仍须幂等（生产配置）', async () => {
    const md = makeMd({ delay: 40 });
    const video = makeVideo();
    const c = make(null, {
      mediaDevices: md, videoGetter: () => video,
      checkAccess: () => Promise.resolve({ ok: true, data: { status: 'granted' } })
    });
    const p1 = c.mount(() => video);
    const p2 = c.open('');
    await Promise.all([p1, p2]);
    assert(md.calls === 1, '有预检时同设备重复 open 仍只取 1 次流（实际 ' + md.calls + '）：并发两次 gUM 会让第二次 NotReadableError');
    c.unmount();
  });

  /* 预检必须在 STARTING 会话内部执行：若 await 期间状态还停在 UNINIT，
   * sleep / canCapture / 空闲计时 / 覆盖层会全部误判（曾实测 sleep 被拒、
   * 窗口已隐藏却仍把摄像头打开） */
  await test('预检窗口内的状态一致性', async () => {
    const md = makeMd({ delay: 40 });
    const video = makeVideo();
    let release = null;
    const c = make(null, {
      mediaDevices: md, videoGetter: () => video,
      checkAccess: () => new Promise((r) => { release = r; })
    });
    const p = c.mount(() => video);
    await sleep(10);
    assert(c.getState() === 'STARTING', '预检期间状态应为 STARTING（实际 ' + c.getState() + '）');
    assert(c.canCapture() === false, '预检期间禁止拍照');
    assert(c.sleep('hidden') === true, '预检期间允许休眠（窗口隐藏与预检撞车时不能放行）');
    release({ ok: true, data: { status: 'granted' } });
    await p;
    await sleep(150);
    assert(c.state === 'SLEEPING', '预检返回后不得把摄像头重新打开（实际 ' + c.state + '）');
    c.unmount();
  });

  /* ---------- 7. I6：attach 必成功或必报错 ---------- */
  await test('I6 无 video 元素 → ERROR 且回收流（复现路径 S1）', async () => {
    const logs = [];
    const c = make((l, e, f) => logs.push({ l, e, f }), { videoGetter: () => null });
    await c.mount(() => null);
    assert(c.state === 'ERROR', '取不到 video 元素 → ERROR，绝不静默');
    assert(!!c.error && c.error.code === 'ATTACH_FAIL', '错误码 ATTACH_FAIL：' + (c.error && c.error.message));
    assert(!!c.error.message, '错误对象带可展示文案（I4：渲染层覆盖层直接显示）');
    assert(logs.some((x) => x.e === 'CAM_ATTACH_FAIL'), '记录 CAM_ATTACH_FAIL');
    assert(c.getStream() === null, 'ERROR 下 stream 为 null（I3）');
    assert(c.canCapture() === false, 'ERROR 下禁止拍照（I5）');
  });

  /* ---------- 8. play() 失败 → ERROR + 回收流（RC-3 主路径） ---------- */
  await test('play() 拒绝 → ERROR/PLAY_FAIL', async () => {
    const video = makeVideo({
      readyState: 0, videoWidth: 0, videoHeight: 0,
      play() { return Promise.reject(Object.assign(new Error('play fail'), { name: 'AbortError' })); }
    });
    const c = make(null, { videoGetter: () => video });
    await c.mount(() => video);
    assert(c.state === 'ERROR' && c.error.code === 'PLAY_FAIL', 'play() 拒绝 → ERROR/PLAY_FAIL');
    assert(video.srcObject === null, '失败后清空 srcObject（I3：不留黑屏）');
  });

  /* ---------- 9. 画面迟迟不出帧 → NO_FRAME ---------- */
  await test('画面未输出 → NO_FRAME', async () => {
    const video = makeVideo({ readyState: 0, videoWidth: 0, videoHeight: 0 });
    const c = make(null, { videoGetter: () => video, config: Object.assign({}, CFG, { frameWaitMs: 60 }) });
    await c.mount(() => video);
    assert(c.state === 'ERROR' && c.error.code === 'NO_FRAME', 'frameWaitMs 内未出帧 → ERROR/NO_FRAME');
  });

  /* ---------- 10. 退避序列与重试 ---------- */
  await test('退避重试 400/800 后转 ERROR（§8）', async () => {
    const logs = [];
    const md = makeMd({ err: 'NotReadableError' });
    const c = make((l, e, f) => logs.push({ l, e, f }), {
      mediaDevices: md,
      config: Object.assign({}, CFG, { backoffMs: [400, 800, 1600, 3200], maxAttempts: 3 })
    });
    await c.mount(() => makeVideo());
    const delays = logs.filter((x) => x.e === 'CAM_RETRY' && x.f.delayMs).map((x) => x.f.delayMs);
    eq(delays, [400, 800], '退避序列按 cfg 顺序取用（已压到 maxAttempts=3）');
    assert(md.calls === 3, '共调用 3 次 getUserMedia（实际 ' + md.calls + '）');
    assert(c.state === 'ERROR' && c.error.code === 'DEVICE_BUSY', '重试耗尽 → ERROR/DEVICE_BUSY');
    assert(c.error.recoverable === true, 'DEVICE_BUSY 标记为可恢复（覆盖层给「重试」按钮）');
  });

  await test('退避索引钳位：超出 backoffMs 长度时取最后一个', async () => {
    const logs = [];
    const md = makeMd({ err: 'NotReadableError' });
    const c = make((l, e, f) => logs.push({ l, e, f }), {
      mediaDevices: md,
      config: Object.assign({}, CFG, { backoffMs: [10, 20], maxAttempts: 4 })
    });
    await c.mount(() => makeVideo());
    const delays = logs.filter((x) => x.e === 'CAM_RETRY' && x.f.delayMs).map((x) => x.f.delayMs);
    eq(delays, [10, 20, 20], '第 3 次起钳位到 backoffMs 末位');
  });

  /* ---------- 11. 不可重试错误 ---------- */
  await test('权限拒绝 → 立即 ERROR，不重试', async () => {
    const md = makeMd({ err: 'NotAllowedError' });
    const c = make(null, { mediaDevices: md });
    await c.mount(() => makeVideo());
    assert(c.state === 'ERROR' && c.error.code === 'PERMISSION_DENIED', '权限拒绝 → ERROR/PERMISSION_DENIED');
    assert(md.calls === 1, '只调用 1 次 getUserMedia（实际 ' + md.calls + '）');
    assert(c.error.recoverable === false, 'PERMISSION_DENIED 不可自动恢复（引导去系统设置）');
  });

  await test('无设备 → 立即 ERROR，不重试', async () => {
    const md = makeMd({ err: 'NotFoundError' });
    const c = make(null, { mediaDevices: md });
    await c.mount(() => makeVideo());
    assert(c.state === 'ERROR' && c.error.code === 'NO_DEVICE', '无设备 → ERROR/NO_DEVICE');
    assert(md.calls === 1, '只调用 1 次 getUserMedia');
  });

  await test('环境不支持（无 getUserMedia）→ UNSUPPORTED', async () => {
    const c = C.createCameraController({
      mediaDevices: { addEventListener() {}, removeEventListener() {} },
      videoGetter: () => makeVideo(),
      config: CFG,
      log: function () {}
    });
    await c.mount(() => makeVideo());
    assert(c.state === 'ERROR' && c.error.code === 'UNSUPPORTED', '无 getUserMedia → ERROR/UNSUPPORTED');
  });

  /* ---------- 12. OverconstrainedError 降级 ---------- */
  await test('OverconstrainedError 降级重试（复现路径 R1/S4）', async () => {
    const md = makeMd({ err: 'OverconstrainedError' });
    const c = make(null, { mediaDevices: md });
    await c.mount(() => makeVideo());
    assert(md.lastConstraints.video === true, '降级后回退 { video: true }：' + JSON.stringify(md.lastConstraints));
    assert(md.calls === 5, '重试到 maxAttempts=5 次后放弃（实际 ' + md.calls + '）');
    assert(c.state === 'ERROR' && c.error.code === 'OVERCONSTRAINED', '降级仍失败 → ERROR/OVERCONSTRAINED');
  });

  await test('指定设备时首帧用 exact 约束', async () => {
    const md = makeMd();
    const c = make(null, { mediaDevices: md });
    await c.mount(() => makeVideo());
    c.unmount();
    const md2 = makeMd();
    const c2 = make(null, { mediaDevices: md2 });
    await c2.mount(() => makeVideo());
    await c2.open('cam-x');
    eq(md2.lastConstraints, { video: { deviceId: { exact: 'cam-x' } }, audio: false }, '带 deviceId 时用 exact 约束');
    c2.unmount();
  });

  /* ---------- 12b. R10：系统级授权预检 ---------- */
  await test('R10 授权预检（复现路径 R10：系统隐私开关关闭）', async () => {
    const denied = C.createCameraController({
      mediaDevices: makeMd(), videoGetter: () => makeVideo(), config: CFG, log: function () {},
      checkAccess: () => Promise.resolve({ ok: true, data: { status: 'denied' } })
    });
    const mdDenied = { calls: 0 };
    await denied.mount(() => makeVideo());
    assert(denied.state === 'ERROR' && denied.error.code === 'PERMISSION_DENIED', 'denied → ERROR/PERMISSION_DENIED，不等 gUM 失败才知道');
    assert(denied.error.privacy === true, '错误带 privacy 标记（渲染层据此显示「去系统设置开启」按钮）');
    denied.unmount();

    const mdG = makeMd();
    const granted = make(null, { mediaDevices: mdG, checkAccess: () => Promise.resolve({ ok: true, data: { status: 'granted' } }) });
    await granted.mount(() => makeVideo());
    assert(granted.state === 'LIVE', 'granted → 正常取流');
    granted.unmount();

    const mdU = makeMd();
    const unknown = make(null, { mediaDevices: mdU, checkAccess: () => Promise.resolve({ ok: false, message: 'unsupported' }) });
    await unknown.mount(() => makeVideo());
    assert(unknown.state === 'LIVE', '预检接口不可用（ok:false）→ 放行，绝不阻断取流');
    unknown.unmount();

    const mdT = makeMd();
    const thrown = make(null, { mediaDevices: mdT, checkAccess: () => Promise.reject(new Error('ipc down')) });
    await thrown.mount(() => makeVideo());
    assert(thrown.state === 'LIVE', '预检抛异常 → 放行，绝不阻断取流');
    thrown.unmount();

    const mdR = makeMd();
    const restricted = make(null, { mediaDevices: mdR, checkAccess: () => Promise.resolve({ ok: true, data: { status: 'restricted' } }) });
    await restricted.mount(() => makeVideo());
    assert(restricted.state === 'ERROR' && restricted.error.code === 'PERMISSION_DENIED', 'restricted → 同样拦截');
    assert(mdR.calls === 0, '被拦截时不调用 getUserMedia（实际 ' + mdR.calls + '）');
    restricted.unmount();
  });

  await test('openPrivacySettings 降级', async () => {
    const c = make(null);
    assert(await c.openPrivacySettings() === false, '无注入且无 window.api → 返回 false，渲染层降级为纯文案引导');
    const c2 = make(null, { openPrivacy: () => Promise.resolve({ ok: true }) });
    assert(await c2.openPrivacySettings() === true, '注入可用时返回 true');
    const c3 = make(null, { openPrivacy: () => Promise.reject(new Error('x')) });
    assert(await c3.openPrivacySettings() === false, '抛异常时返回 false，不冒泡');
  });

  /* ---------- 13. RC-2：track ended → 自动重连 ---------- */
  await test('RC-2 track ended 自动重连（复现路径 R3）', async () => {
    const logs = [];
    const md = makeMd();
    const video = makeVideo();
    const c = make((l, e, f) => logs.push({ l, e, f }), { mediaDevices: md, videoGetter: () => video });
    await c.mount(() => video);
    const first = c.getStream();
    assert(c.canCapture() === true, '重连前可拍照');
    first.__t.fire('ended');
    assert(logs.some((x) => x.e === 'CAM_TRACK_ENDED'), 'track ended 被感知（旧实现完全无感知）');
    assert(c.canCapture() === false, 'ended 瞬间禁止拍照（I5：防黑照片）');
    await sleep(150);
    assert(c.state === 'LIVE', 'ended 后自动重连回 LIVE（' + c.state + '）');
    assert(c.getStream() !== first, '重连后换成新流');
    c.unmount();
  });

  /* ---------- 14. RC-2：muted → DEGRADED ---------- */
  await test('RC-2 muted → DEGRADED 禁止拍照，unmute 回 LIVE', async () => {
    const md = makeMd();
    const video = makeVideo();
    const c = make(null, { mediaDevices: md, videoGetter: () => video });
    await c.mount(() => video);
    const t = c.getStream().__t;
    t.muted = true;
    t.fire('mute');
    assert(c.state === 'DEGRADED', 'muted → DEGRADED');
    assert(c.canCapture() === false, 'DEGRADED 时禁止拍照（I5，防黑照片入库）');
    t.muted = false;
    t.fire('unmute');
    assert(c.state === 'LIVE', 'unmute 且画面就绪 → 回到 LIVE');
    c.unmount();
  });

  /* ---------- 15. DEGRADED 观察期超时 → 重连 ---------- */
  await test('DEGRADED 观察期超时自动重连', async () => {
    const logs = [];
    const md = makeMd();
    const video = makeVideo();
    const c = make((l, e, f) => logs.push({ l, e, f }), {
      mediaDevices: md, videoGetter: () => video,
      config: Object.assign({}, CFG, { degradedWatchMs: 40 })
    });
    await c.mount(() => video);
    c.getStream().__t.muted = true;
    c.getStream().__t.fire('mute');
    await sleep(200);
    assert(logs.some((x) => x.e === 'CAM_DEGRADED'), '观察期超时记 CAM_DEGRADED');
    assert(c.state === 'LIVE', '超时后自动重连回 LIVE（' + c.state + '）');
    c.unmount();
  });

  /* ---------- 16. 休眠：I3 + 迟到流回收 + 唤醒 ---------- */
  await test('休眠与唤醒（复现路径 R5/R6/R7）', async () => {
    const logs = [];
    const md = makeMd({ delay: 60 });
    const video = makeVideo();
    const c = make((l, e, f) => logs.push({ l, e, f }), { mediaDevices: md, videoGetter: () => video });
    c.mount(() => video);
    await sleep(5);
    c.sleep('hidden');
    assert(c.state === 'SLEEPING', 'sleep → SLEEPING');
    assert(video.srcObject === null, '休眠后清空 srcObject（I3：不留黑屏）');
    assert(c.getStream() === null, '休眠后 stream 为 null（I3）');
    assert(c.canCapture() === false, '休眠时禁止拍照（I5）');
    await sleep(200);
    assert(logs.some((x) => x.e === 'CAM_SLEEP'), '记录 CAM_SLEEP');
    await c.wake();
    assert(c.state === 'LIVE', 'wake → LIVE');
    assert(logs.some((x) => x.e === 'CAM_WAKE'), '记录 CAM_WAKE');
    assert(c.getAttempt() === 0, '唤醒成功后 attempt 归零');
    c.unmount();
  });

  /* ---------- 17. 设备插拔（RC-6） ---------- */
  await test('设备插拔自动恢复（复现路径 R4）', async () => {
    const logs = [];
    const md = makeMd({ err: 'NotFoundError' });
    const video = makeVideo();
    const c = make((l, e, f) => logs.push({ l, e, f }), { mediaDevices: md, videoGetter: () => video });
    await c.mount(() => video);
    assert(c.state === 'ERROR' && c.error.code === 'NO_DEVICE', '先进入 ERROR/NO_DEVICE');
    md.err = null; // 摄像头插回
    md.fire('devicechange');
    assert(logs.some((x) => x.e === 'CAM_DEVICE_CHANGE'), 'devicechange 被感知');
    await sleep(150);
    assert(c.state === 'LIVE', '插回后自动重开（' + c.state + '）');
    c.unmount();
  });

  /* ---------- 18. 打开超时 ---------- */
  await test('打开超时 → ERROR 且迟到流被回收', async () => {
    const logs = [];
    const md = makeMd({ delay: 300 });
    const c = make((l, e, f) => logs.push({ l, e, f }), {
      mediaDevices: md,
      config: Object.assign({}, CFG, { openTimeoutMs: 60, maxAttempts: 1, backoffMs: [10] })
    });
    await c.mount(() => makeVideo());
    assert(c.state === 'ERROR' && c.error.code === 'OPEN_TIMEOUT', '打开超时 → ERROR/OPEN_TIMEOUT');
    await sleep(500);
    assert(logs.some((x) => x.e === 'CAM_LEAK_GUARD'), '超时后迟到的流被 LEAK_GUARD stop');
  });

  /* ---------- 19. 黑帧闸门 ---------- */
  await test('黑帧闸门（复现路径 R9：杜绝黑照片入库）', async () => {
    const black = new Array(64 * 64).fill(5);
    const normal = new Array(64 * 64).fill(128);
    const video = makeVideo();
    const c = C.createCameraController({
      mediaDevices: makeMd(), videoGetter: () => video,
      frameSampler: () => black, config: CFG, log: function () {}
    });
    await c.mount(() => video);
    assert(c.isBlackFrame(video) === true, '全黑画面被检出');
    c.unmount();

    const c2 = C.createCameraController({
      mediaDevices: makeMd(), videoGetter: () => video,
      frameSampler: () => normal, config: CFG, log: function () {}
    });
    await c2.mount(() => video);
    assert(c2.isBlackFrame(video) === false, '正常画面放行');
    c2.unmount();

    const c3 = C.createCameraController({
      mediaDevices: makeMd(), videoGetter: () => video,
      frameSampler: () => black, blackFrameEnabled: () => false, config: CFG, log: function () {}
    });
    await c3.mount(() => video);
    assert(c3.isBlackFrame(video) === false, 'window.__xqyBlackFrame=false 可现场关闭检测');
    c3.unmount();

    const c4 = C.createCameraController({
      mediaDevices: makeMd(), videoGetter: () => video, config: CFG, log: function () {}
    });
    await c4.mount(() => video);
    assert(c4.isBlackFrame(video) === false, '无采样器时放行（不因检测缺失而拦拍）');
    c4.unmount();
  });

  /* ---------- 20. 竞态：attach 途中 track 死亡 ---------- */
  await test('attach 途中 track 死亡：重连不被旧尝试打回 ERROR', async () => {
    const md = makeMd({ delay: 5 });
    const baseGum = md.getUserMedia;
    md.getUserMedia = (cst) => baseGum(cst).then((s) => { setTimeout(() => s.__t.fire('ended'), 30); return s; });
    const video = makeVideo({ readyState: 0, videoWidth: 0, videoHeight: 0 });
    setTimeout(() => { video.readyState = 4; video.videoWidth = 1920; video.videoHeight = 1080; }, 150);
    const c = make(null, { mediaDevices: md, videoGetter: () => video, config: Object.assign({}, CFG, { frameWaitMs: 400 }) });
    // 该场景下每条流都会在自己出画后再次死亡，控制器处在「出画 → 断开 → 重连」的循环里，
    // 固定时刻采样状态会随机落在 LIVE / STARTING / ERROR 任一相位（用例曾因此偶发红）。
    //
    // 判定依据（用 .workbuddy/tmp/probe-case20-flaky.js 的 252 格参数网格 + 150 次精确压测得出）：
    //   - 现配置（window=600）下 150/150 恒为 sawLive=true、errCode=FLAP_STORM，确实稳定；
    //   - 但网格扫描里出现了 errCode=RETRY_EXHAUSTED —— 闪断风暴有「两种」合法终态：
    //     闪断闸门先触发是 FLAP_STORM，重试先耗尽是 RETRY_EXHAUSTED，取决于谁先到。
    //   → 原断言「ERROR 只能是 FLAP_STORM」把「恰好先触发闸门」当成了必然，属于隐性相位依赖：
    //     机器变慢或改了 frameWaitMs / flapMax / maxAttempts 就可能翻红。
    //
    // 因此判据改为两件事，都不依赖时刻采样：
    //   ① 等到控制器进入终态再断言（最多等 1500ms），不再固定 600ms 采样；
    //   ② 只排除「旧尝试」产生的错误码——这才是本用例真正要表达的语义
    //      （旧尝试的失败不得覆盖新重连），至于终态是哪种风暴码，是配置决定的，不该由用例规定。
    const STALE_ATTEMPT_CODES = ['ATTACH_FAIL', 'PLAY_FAIL', 'NO_FRAME', 'NO_TRACK', 'OPEN_TIMEOUT', 'UNSUPPORTED'];
    const STORM_CODES = ['FLAP_STORM', 'RETRY_EXHAUSTED'];
    let sawLive = false;
    let errCode = null;
    c.onStateChange((pp) => { if (pp.state === 'LIVE') sawLive = true; });
    c.onError((pp) => { if (pp.error) errCode = pp.error.code; });
    c.mount(() => video);
    let waited = 0;
    while (waited < 1500 && c.state !== 'ERROR') { await sleep(30); waited += 30; }
    assert(sawLive, '重连循环中至少出画一次（等待 ' + waited + 'ms，末态 ' + c.state + '）');
    assert(STALE_ATTEMPT_CODES.indexOf(errCode) < 0,
      '旧尝试的失败没有把新重连打回 ERROR（实际 err=' + errCode + '，只应为 null 或 ' + STORM_CODES.join('/') + '）');
    assert(errCode === null || STORM_CODES.indexOf(errCode) >= 0,
      '终态若转 ERROR 只能是风暴类终态（实际 ' + errCode + '）');
    c.unmount();
  });

  /* ---------- 21. 快照字段 ---------- */
  await test('snapshot 字段完整（供渲染层与单测断言）', async () => {
    const c = make(null);
    await c.mount(() => makeVideo());
    const s = c.snapshot();
    assert(s.state === 'LIVE' && s.liveTracks === 1 && s.alive === true && s.hasStream === true, 'LIVE 快照字段正确');
    assert(typeof s.seq === 'number' && s.seq > 0, 'seq 为正整数（令牌守卫依赖它）');
    assert(typeof s.attempt === 'number' && typeof s.trackBinds === 'number', 'attempt / trackBinds 字段存在');
    c.unmount();
  });

  /* ---------- 21b. 悬挂兜底（P1-1 / P1-2 / P2-1：永不 settle 不得卡死） ---------- */
  await test('P1-1 play() 永不 settle → 超时代码 PLAY_TIMEOUT 且置 ERROR（不卡 STARTING）', async () => {
    const video = makeVideo({ play() { return new Promise(() => {}); } }); // 永不 resolve
    const c = make(null, { mediaDevices: makeMd(), videoGetter: () => video, config: CFG });
    c.mount(() => video);
    let waited = 0;
    while (waited < 2000 && c.state !== 'ERROR') { await sleep(30); waited += 30; }
    assert(c.state === 'ERROR', '未卡在 STARTING，转 ERROR（末态 ' + c.state + '，耗时 ' + waited + 'ms）');
    assert(c.getError() && c.getError().code === 'PLAY_TIMEOUT', '错误码为 PLAY_TIMEOUT（实际 ' + (c.getError() && c.getError().code) + '）');
    assert(c.getStream() === null, '流已回收，不留 live track');
    c.unmount();
  });

  await test('P2-1 授权预检 IPC 永不 settle → 超时放行并正常出画（不卡准备中）', async () => {
    const checkAccess = () => new Promise(() => {}); // 永不 resolve
    const c = make(null, { mediaDevices: makeMd(), videoGetter: () => makeVideo(), checkAccess: checkAccess, config: CFG });
    c.mount(() => makeVideo());
    let waited = 0;
    while (waited < 2000 && c.state !== 'LIVE') { await sleep(30); waited += 30; }
    assert(c.state === 'LIVE', '预检超时后正常出画（末态 ' + c.state + '，耗时 ' + waited + 'ms）');
    assert(c.getError() === null, '无错误（预检超时视为放行）');
    c.unmount();
  });

  await test('P1-2 applyConstraints() 永不 settle → 跳过提分辨率直接出画', async () => {
    // applyConstraints 永不 resolve：控制器应在 applyConstraintMs 超时后继续，仍 LIVE
    const track = makeTrack();
    track.applyConstraints = function () { return new Promise(() => {}); };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track], __t: track };
    allStreams.push(stream);
    const md = makeMd();
    md.getUserMedia = () => Promise.resolve(stream);
    const c = make(null, { mediaDevices: md, videoGetter: () => makeVideo(), config: CFG });
    c.mount(() => makeVideo());
    let waited = 0;
    while (waited < 2000 && c.state !== 'LIVE') { await sleep(30); waited += 30; }
    assert(c.state === 'LIVE', 'applyConstraints 悬挂后仍能出画（末态 ' + c.state + '，耗时 ' + waited + 'ms）');
    c.unmount();
  });

  /* ---------- 22. 事件订阅与退订 ---------- */
  await test('事件订阅可退订', async () => {
    const c = make(null);
    let n = 0;
    const off = c.onStateChange(() => { n++; });
    await c.mount(() => makeVideo());
    assert(n > 0, '状态变化回调被触发（' + n + ' 次）');
    off();
    const before = n;
    c.sleep('manual');
    assert(n === before, '退订后不再收到回调');
    c.unmount();
  });

  /* ---------- 23. 日志契约：事件名与字段必须过主进程那一关 ---------- */
  await test('日志事件名对齐契约枚举（§10 / main/camera-log.js）', async () => {
    const fs = require('fs');
    const p = require('path');
    const root = p.join(__dirname, '..');
    const logSrc = fs.readFileSync(p.join(root, 'main', 'camera-log.js'), 'utf8');
    const m = logSrc.match(/const FIXED_KEYS = \[([^\]]+)\]/);
    assert(!!m, '能从 main/camera-log.js 读到 FIXED_KEYS 定义');
    const fixed = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
    assert(fixed.length === 9 && fixed[0] === 'ts' && fixed[8] === 'res', 'FIXED_KEYS = ' + fixed.join('/'));
    // 契约 §10 事件枚举 + 本次放行的窗口可见性事件
    const ENUM = [
      'CAM_MOUNT', 'CAM_UNMOUNT', 'CAM_START_BEGIN', 'CAM_GUM_OK', 'CAM_GUM_FAIL',
      'CAM_ATTACH_FAIL', 'CAM_PLAY_FAIL', 'CAM_PLAY_TIMEOUT', 'CAM_LIVE', 'CAM_DEGRADED', 'CAM_TRACK_ENDED',
      'CAM_TRACK_MUTED', 'CAM_RETRY', 'CAM_SLEEP', 'CAM_WAKE', 'CAM_DEVICE_CHANGE',
      'CAM_CAPTURE_OK', 'CAM_CAPTURE_REJECT', 'CAM_LEAK_GUARD',
      'CAM_PERMISSION_CHECK', 'CAM_PERMISSION_REQUEST', 'CAM_WINDOW_STATE'
    ];
    const used = new Set();
    for (const f of ['renderer/renderer.js', 'renderer/camera-controller.js']) {
      const src = fs.readFileSync(p.join(root, f), 'utf8');
      let mm;
      const re = /'CAM_[A-Z_]+'/g;
      while ((mm = re.exec(src)) !== null) used.add(mm[0].replace(/'/g, ''));
    }
    const unknown = [...used].filter((e) => ENUM.indexOf(e) < 0).sort();
    assert(used.size >= 15, '渲染层共使用 ' + used.size + ' 个日志事件');
    assert(unknown.length === 0, '事件名全部在枚举内（放行 CAM_WINDOW_STATE）' + (unknown.length ? ' → 越界：' + unknown.join(',') : ''));
    assert(used.has('CAM_LEAK_GUARD') && used.has('CAM_WINDOW_STATE') && used.has('CAM_PERMISSION_CHECK'),
      '关键事件齐备（泄漏证据 / 窗口可见性 / 权限预检）');
    assert(used.has('CAM_CAPTURE_OK') && used.has('CAM_CAPTURE_REJECT'), '拍照成功与拒收都要留痕');
  });

  await test('运行期日志字段合规（主进程只收原始类型附加字段）', async () => {
    const fs = require('fs');
    const p = require('path');
    const logSrc = fs.readFileSync(p.join(__dirname, '..', 'main', 'camera-log.js'), 'utf8');
    const fixed = logSrc.match(/const FIXED_KEYS = \[([^\]]+)\]/)[1]
      .split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
    const logs = [];
    const c = make((l, e, f) => logs.push({ level: l, event: e, fields: f || {} }), {
      frameSampler: () => new Array(64 * 64).fill(5),
      checkAccess: () => Promise.resolve({ ok: true, data: { status: 'granted' } })
    });
    await c.mount(() => makeVideo());
    c.isBlackFrame(makeVideo()); // 触发一次 CAM_CAPTURE_REJECT（渲染层拒收黑帧的同源字段）
    c.sleep('idle');
    await c.wake();
    c.getStream().__t.fire('mute');
    c.getStream().__t.fire('unmute');
    c.getStream().__t.fire('ended');
    await sleep(200);
    c.unmount();
    assert(logs.length >= 10, '一次完整生命周期产生 ' + logs.length + ' 条日志');
    assert(logs.every((x) => ['info', 'warn', 'error'].indexOf(x.level) >= 0), 'level 仅 info/warn/error');
    let badExtra = 0;
    let badType = 0;
    for (const x of logs) {
      const extra = Object.keys(x.fields).filter((k) => fixed.indexOf(k) < 0);
      if (extra.length > 6) badExtra++;
      for (const k of extra) {
        const v = x.fields[k];
        if (!(v === null || ['string', 'number', 'boolean'].indexOf(typeof v) >= 0)) badType++;
      }
    }
    assert(badExtra === 0, '附加字段 ≤ 6 个（main/camera-log.js MAX_EXTRA_KEYS）');
    assert(badType === 0, '附加字段均为原始类型（对象/数组会被主进程丢弃）');
    const withRes = logs.filter((x) => x.fields.res);
    assert(withRes.length > 0 && withRes.every((x) => typeof x.fields.res.w === 'number' && typeof x.fields.res.h === 'number'),
      'res 恒为 { w, h }（' + withRes.length + ' 条带 res）');
    assert(logs.filter((x) => x.fields.err).every((x) => x.fields.err && typeof x.fields.err === 'object'),
      'err 恒为 { name, message }');
    const need = ['CAM_MOUNT', 'CAM_START_BEGIN', 'CAM_LIVE', 'CAM_SLEEP', 'CAM_WAKE',
      'CAM_TRACK_MUTED', 'CAM_TRACK_ENDED', 'CAM_PERMISSION_CHECK', 'CAM_UNMOUNT', 'CAM_CAPTURE_REJECT'];
    const miss = need.filter((e) => !logs.some((x) => x.event === e));
    assert(miss.length === 0, '关键路径日志齐备' + (miss.length ? ' → 缺：' + miss.join(',') : ''));
  });

  /* ---------- 24. 状态迁移合法性 ---------- */
  await test('状态迁移合法性（§6.2：SLEEPING/ERROR 必须经 STARTING 才回 LIVE）', async () => {
    const LEGAL = {
      UNINIT: ['STARTING', 'ERROR', 'SLEEPING', 'UNINIT'],
      STARTING: ['LIVE', 'ERROR', 'UNINIT', 'SLEEPING', 'DEGRADED', 'STARTING'],
      LIVE: ['DEGRADED', 'SLEEPING', 'UNINIT', 'STARTING', 'ERROR'],
      DEGRADED: ['LIVE', 'STARTING', 'SLEEPING', 'UNINIT', 'ERROR'],
      SLEEPING: ['STARTING', 'UNINIT', 'SLEEPING'],
      ERROR: ['STARTING', 'UNINIT', 'SLEEPING', 'ERROR']
    };
    const seqs = [];
    const c = make(null, { config: Object.assign({}, CFG, { degradedWatchMs: 40 }) });
    c.onStateChange((pp) => seqs.push(pp.prev + '->' + pp.state));
    await c.mount(() => makeVideo());
    c.sleep('manual');
    await c.wake();
    c.getStream().__t.fire('mute');
    await sleep(200); // DEGRADED 观察期超时 → 自动重连
    c.unmount();
    const illegal = seqs.filter((s) => {
      const parts = s.split('->');
      return !(LEGAL[parts[0]] || []).includes(parts[1]);
    });
    assert(seqs.length >= 5, '记录迁移 ' + seqs.length + ' 次：' + seqs.join(' | '));
    assert(illegal.length === 0, '全部迁移合法' + (illegal.length ? ' → 非法：' + illegal.join(',') : ''));
    assert(seqs.indexOf('SLEEPING->LIVE') < 0, '不存在 SLEEPING→LIVE 跳变（必须经 STARTING）');
    assert(seqs.indexOf('SLEEPING->STARTING') >= 0, 'SLEEPING→STARTING→LIVE 路径成立');
    assert(seqs.indexOf('ERROR->LIVE') < 0, '不存在 ERROR→LIVE 跳变');
  });

  await test('未挂载 / 终态下的非法操作被挡住', async () => {
    const c = make(null);
    assert(c.sleep('manual') === false, 'UNINIT 下 sleep 无效（返回 false）');
    assert(c.canCapture() === false, 'UNINIT 下禁拍（I5）');
    assert(c.getStream() === null, 'UNINIT 下无流');
    await c.mount(() => makeVideo());
    c.sleep('manual');
    assert(c.sleep('manual') === true, 'SLEEPING 下重复 sleep 幂等');
    assert(c.canCapture() === false, 'SLEEPING 下禁拍');
    c.unmount();
    assert((await c.wake()) === false, '已卸载后 wake 无效，不再取流');
  });

  /* ---------- 25. 闪断风暴闸门（拍板方案：成功即归零 + 30s 时间窗） ---------- */
  await test('闪断风暴闸门①：30 秒内 6 次闪断 → 转 ERROR 且不再自动重连', async () => {
    const logs = [];
    const md = makeMd();
    const video = makeVideo();
    const clock = { t: 100000 };
    const c = make((l, e, f) => logs.push({ l, e, f }), {
      mediaDevices: md, videoGetter: () => video, now: () => clock.t,
      config: Object.assign({}, CFG, { flapWindowMs: 30000, flapMax: 5 })
    });
    await c.mount(() => video);
    assert(c.state === 'LIVE', '前置：已出画');
    let callsAtTrip = -1;
    for (let i = 1; i <= 6; i++) {
      c.getStream().__t.fire('ended');
      const cnt = c.snapshot().flapCount;
      if (i <= 5) {
        assert(cnt === i, '第 ' + i + ' 次闪断累计计数 = ' + i + '（实际 ' + cnt + '）');
        assert(c.state === 'STARTING', '第 ' + i + ' 次闪断后仍自动重连（' + c.state + '）');
        await sleep(80);
        assert(c.state === 'LIVE', '第 ' + i + ' 次重连成功回 LIVE（' + c.state + '）');
      } else {
        assert(cnt === 6, '第 6 次闪断累计计数 = 6（实际 ' + cnt + '）');
        assert(c.state === 'ERROR', '超过 flapMax(5) → 转 ERROR（' + c.state + '）');
        assert(!!c.error && c.error.code === 'FLAP_STORM', '错误码 FLAP_STORM：' + (c.error && c.error.message));
        assert(/重试/.test(c.error.message), '错误文案提示人工点「重试」');
        callsAtTrip = md.calls;
      }
    }
    await sleep(200);
    assert(md.calls === callsAtTrip, '转 ERROR 后不再自动重连（gUM 停在 ' + callsAtTrip + ' 次，实际 ' + md.calls + '）');
    assert(c.canCapture() === false, 'ERROR 下禁拍（I5）');
    assert(c.getStream() === null, 'ERROR 下 stream 为 null（I3）');
    assert(logs.some((x) => x.e === 'CAM_RETRY' && x.f.flap >= 5), '重连日志带闪断计数（现场复盘）');
    assert(logs.some((x) => x.e === 'CAM_GUM_FAIL' && x.f.code === 'FLAP_STORM'), '记录 FLAP_STORM 终态日志');
    c.unmount();
  });

  await test('闪断风暴闸门②：两次断开间隔超过 30 秒 → 计数归零、仍自动重连', async () => {
    const md = makeMd();
    const video = makeVideo();
    const clock = { t: 100000 };
    const c = make(null, {
      mediaDevices: md, videoGetter: () => video, now: () => clock.t,
      config: Object.assign({}, CFG, { flapWindowMs: 30000, flapMax: 5 })
    });
    await c.mount(() => video);
    clock.t += 1000;
    c.getStream().__t.fire('ended'); // 距上次出画 1s（窗口内）
    assert(c.snapshot().flapCount === 1, '窗口内断开计数 = 1（实际 ' + c.snapshot().flapCount + '）');
    await sleep(80);
    assert(c.state === 'LIVE', '第一次断开后重连回 LIVE（' + c.state + '）');
    clock.t += 40000; // 稳定运行 40 秒后再次断开
    c.getStream().__t.fire('ended');
    assert(c.snapshot().flapCount === 0, '超过 30s 窗口 → 计数归零（实际 ' + c.snapshot().flapCount + '）');
    assert(c.state === 'STARTING', '不转 ERROR，仍自动重连（' + c.state + '）');
    await sleep(80);
    assert(c.state === 'LIVE', '长时间稳定运行后的偶发断开仍重连回 LIVE（' + c.state + '）');
    assert(c.canCapture() === true, '重连后可拍照');
    c.unmount();
  });

  await test('闪断风暴闸门③：成功出画 / 人工重试后计数归零（不被历史闪断连坐）', async () => {
    const md = makeMd();
    const video = makeVideo();
    const clock = { t: 100000 };
    const c = make(null, {
      mediaDevices: md, videoGetter: () => video, now: () => clock.t,
      config: Object.assign({}, CFG, { flapWindowMs: 30000, flapMax: 5 })
    });
    await c.mount(() => video);
    for (let i = 0; i < 3; i++) { // 连续 3 次闪断
      c.getStream().__t.fire('ended');
      await sleep(80);
    }
    assert(c.snapshot().flapCount === 3, '连续 3 次闪断后计数 = 3（实际 ' + c.snapshot().flapCount + '）');
    clock.t += 40000; // 成功出画并稳定运行超过窗口
    c.getStream().__t.fire('ended');
    assert(c.snapshot().flapCount === 0, '稳定运行超过窗口后计数归零（成功即复位）');
    await sleep(80);
    assert(c.state === 'LIVE', '仍正常出画（' + c.state + '）');
    // 人工点「重试」/重新打开同样清零，风暴历史不连坐
    for (let i = 0; i < 3; i++) {
      c.getStream().__t.fire('ended');
      await sleep(80);
    }
    assert(c.snapshot().flapCount === 3, '再次累计到 3（实际 ' + c.snapshot().flapCount + '）');
    await c.open();
    assert(c.snapshot().flapCount === 0, '人工重试后计数归零（实际 ' + c.snapshot().flapCount + '）');
    assert(c.state === 'LIVE', '人工重试后回到 LIVE（' + c.state + '）');
    c.getStream().__t.fire('ended');
    assert(c.snapshot().flapCount === 1, '重试后的单次闪断从 1 重新计数（实际 ' + c.snapshot().flapCount + '）');
    assert(c.state !== 'ERROR', '单次闪断不得被判成风暴');
    await sleep(80);
    c.unmount();
  });

  /* ---------- 全局泄漏审计 ---------- */
  console.log('\n· 全局审计');
  assert(liveAll() === 0, '累计 ' + allStreams.length + ' 条流，全部已 stop（残留 live ' + liveAll() + '）——I1/I2/I7');

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  if (fail) {
    console.log('\n失败项：');
    failures.forEach((m) => console.log('  - ' + m));
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
