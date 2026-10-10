'use strict';
/* 摄像头「锁定最高可用分辨率」修复验证（BugFix：切摄像头 / 重启后分辨率回落）
 *
 * node scripts/verify-camera-res.js
 *
 * 与 scripts/verify-camera.js 的分工：
 *   verify-camera.js  = 生命周期契约（I1–I7）
 *   verify-camera-qa.js = QA 对抗性探测
 *   本脚本            = 分辨率链路的专项验证（阶梯枚举 / 开流前写约束 / 逐档降级 /
 *                       实际输出校验 / 持久化 / 换设备不串档 / 不产生第二条流）
 *
 * 只依赖 renderer/camera-controller.js（UMD），不碰 DOM、不依赖 Electron。
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

/** 可脚本化的 track：supported 为「设备真正支持的档位」表，未列出的档位一律 OverconstrainedError */
function makeTrack(extra) {
  const t = Object.assign({
    readyState: 'live',
    muted: false,
    _h: {},
    _w: 640,
    _h2: 480,
    _fps: 30,
    supported: null, // [[w,h], ...] 不设则接受任何档位
    hang: false, // applyConstraints 永不 settle
    deviceId: 'cam-a',
    addEventListener(type, f) { (this._h[type] = this._h[type] || []).push(f); },
    removeEventListener(type, f) { const a = this._h[type] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); },
    stop() { this.readyState = 'ended'; },
    getCapabilities() { return { width: { max: 1920 }, height: { max: 1080 } }; },
    applyConstraints(cst) {
      if (this.hang) return new Promise(() => {});
      const w = cst && cst.width && cst.width.exact;
      const h = cst && cst.height && cst.height.exact;
      if (this.supported) {
        const hit = this.supported.some((p) => p[0] === w && p[1] === h);
        if (!hit) return Promise.reject(Object.assign(new Error('over'), { name: 'OverconstrainedError' }));
      }
      this._w = w || this._w;
      this._h2 = h || this._h2;
      return Promise.resolve();
    },
    getSettings() { return { width: this._w, height: this._h2, frameRate: this._fps, deviceId: this.deviceId }; },
    fire(type) { (this._h[type] || []).slice().forEach((f) => f()); }
  }, extra || {});
  return t;
}
function makeStream(extra) {
  const t = makeTrack(extra && extra.track);
  const s = { getTracks: () => [t], getVideoTracks: () => [t], __t: t };
  allStreams.push(s);
  return s;
}
function makeVideo(over) {
  return Object.assign({
    readyState: 4, videoWidth: 1920, videoHeight: 1080, srcObject: null,
    play() { return Promise.resolve(); }
  }, over || {});
}
function makeMd(opts) {
  const o = opts || {};
  const self = {
    calls: 0,
    lastConstraints: null,
    allConstraints: [],
    err: o.err || null,
    _h: {},
    getUserMedia(cst) {
      self.calls += 1;
      self.lastConstraints = cst;
      self.allConstraints.push(JSON.parse(JSON.stringify(cst)));
      const err = self.err;
      const delay = o.delay == null ? 5 : o.delay;
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          if (err) return reject(Object.assign(new Error(err), { name: err }));
          resolve(makeStream(o.stream));
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

const CFG = {
  openTimeoutMs: 400,
  frameWaitMs: 200,
  framePollMs: 10,
  degradedWatchMs: 60,
  attachTimeoutMs: 300,
  applyConstraintMs: 30,
  resBudgetMs: 2000,
  resMaxRungs: 16,
  resMaxFps: 3,
  backoffMs: [10, 10, 10, 10],
  maxAttempts: 5
};

function make(over) {
  const o = Object.assign({
    mediaDevices: makeMd(),
    videoGetter: () => makeVideo(),
    config: CFG,
    log: function () {}
  }, over || {});
  return C.createCameraController(o);
}

async function main() {
  console.log('=== verify-camera-res：最高分辨率锁定 ===');

  /* ---------- 1. 纯函数：候选阶梯 ---------- */
  console.log('\n· 1 候选阶梯 buildResolutionLadder');
  {
    const cap = { width: { max: 1920 }, height: { max: 1080 } };
    const ladder = C.buildResolutionLadder(cap);
    assert(ladder.length > 0, '能力齐全时阶梯非空（' + ladder.length + ' 档）');
    eq(ladder[0], { width: 1920, height: 1080 }, '首档 = 双 max 组合（不许只拼 width.max × height.max 之外的更低档）');
    let sorted = true;
    for (let i = 1; i < ladder.length; i++) {
      if (ladder[i - 1].width * ladder[i - 1].height < ladder[i].width * ladder[i].height) sorted = false;
    }
    assert(sorted, '像素面积降序');
    assert(ladder.every((r) => r.width <= 1920 && r.height <= 1080), '全部档位落在能力区间内（不越界）');
    const seen = new Set();
    let dup = 0;
    ladder.forEach((r) => { const k = r.width + 'x' + r.height + '@' + (r.frameRate || 0); if (seen.has(k)) dup++; seen.add(k); });
    assert(dup === 0, '无重复档位');
    assert(ladder.length <= C.DEFAULTS.resMaxRungs, '档位数不超过 resMaxRungs（' + ladder.length + ' ≤ ' + C.DEFAULTS.resMaxRungs + '）');

    // 帧率：最高档展开多个备选，且降帧优先于降分辨率
    const capFps = { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 30, min: 5 } };
    const l2 = C.buildResolutionLadder(capFps);
    assert(l2[0].frameRate === 30, '首档取设备最高帧率（' + l2[0].frameRate + '）');
    const topArea = 1920 * 1080;
    const topRungs = l2.filter((r) => r.width * r.height === topArea);
    assert(topRungs.length >= 2, '最高分辨率带多个帧率备选（' + topRungs.map((r) => r.frameRate).join('/') + '）');
    assert(l2.indexOf(topRungs[topRungs.length - 1]) < l2.findIndex((r) => r.width * r.height < topArea),
      '先降帧率、再降分辨率（带宽不足时保住分辨率）');

    // 能力区间下界生效
    const l3 = C.buildResolutionLadder({ width: { max: 1280, min: 320 }, height: { max: 720, min: 240 } });
    assert(l3.every((r) => r.width >= 320 && r.height >= 240 && r.width <= 1280 && r.height <= 720), '有 min 时不生成越界档位');
    eq(l3[0], { width: 1280, height: 720 }, '下界不影响首档');

    // 脏数据 / 缺字段
    eq(C.buildResolutionLadder(null), [], 'capabilities 为 null → 空阶梯');
    eq(C.buildResolutionLadder({}), [], 'capabilities 为空对象 → 空阶梯');
    eq(C.buildResolutionLadder({ width: { max: 1920 } }), [], '缺 height → 空阶梯（不瞎猜）');
    assert(C.buildResolutionLadder({ width: { min: 640, max: 1920 }, height: { min: 480, max: 1080 } }).length > 0, '只给 min/max 也能造出阶梯');
  }

  /* ---------- 2. 纯函数：归一化与存档 ---------- */
  console.log('\n· 2 归一化与存档校验');
  {
    eq(C.normalizeResolution({ width: 1920, height: 1080 }), { width: 1920, height: 1080 }, '标准 {width,height}');
    eq(C.normalizeResolution({ w: 640, h: 480, fps: 30 }), { width: 640, height: 480, frameRate: 30 }, '兼容存档格式 {w,h,fps}');
    assert(C.normalizeResolution(null) === null, 'null → null');
    assert(C.normalizeResolution({ width: 0, height: 1080 }) === null, '0 宽 → null');
    assert(C.normalizeResolution({ width: NaN, height: 1080 }) === null, 'NaN → null');
    assert(C.normalizeResolution({ width: 99999, height: 1080 }) === null, '超出 7680 → null');

    const p = C.parseResolutionPref({ v: 1, w: 1920, h: 1080, fps: 30, ts: 1730000000000 });
    assert(p && p.width === 1920 && p.height === 1080 && p.frameRate === 30 && p.ts === 1730000000000, '合法存档被接受并带上时间戳');
    assert(C.parseResolutionPref({ v: 99, w: 1920, h: 1080 }) === null, '版本不认 → 当作没存过（不会被脏存档锁死）');
    assert(C.parseResolutionPref({ v: 1, w: 0, h: 0 }) === null, '字段非法 → null');
    assert(C.parseResolutionPref('{}') === null, '非对象 → null');

    const made = C.makeResolutionPref({ width: 1280, height: 720, frameRate: 25 }, 1730000000000, 'cam-a');
    eq(made, { v: C.RES_PREF_VERSION, w: 1280, h: 720, fps: 25, ts: 1730000000000, dev: 'cam-a' },
      '存档带版本号、时间戳与来源设备（默认档位靠 dev 防串档）');
    assert(C.makeResolutionPref(null, 1) === null, '非法档位不落存档');
  }

  /* ---------- 3. 纯函数：gUM 约束 ---------- */
  console.log('\n· 3 gUM 约束组装');
  {
    eq(C.buildResolutionConstraints('cam-x', null), { video: { deviceId: { exact: 'cam-x' } }, audio: false },
      '无记忆档位时与旧契约完全一致（不破坏 verify-camera 的断言）');
    eq(C.buildResolutionConstraints('', null), { video: true, audio: false }, '无设备无档位 → { video: true }');
    const c = C.buildResolutionConstraints('cam-x', { width: 1920, height: 1080, frameRate: 30 });
    assert(c.video.width.exact === 1920 && c.video.height.exact === 1080, '分辨率用 exact 锁定（ideal 只是倾向，会掉档）');
    assert(c.video.frameRate && c.video.frameRate.ideal === 30 && !c.video.frameRate.exact, 'frameRate 只用 ideal（降帧比整档失败划算）');
    assert(c.video.deviceId.exact === 'cam-x', 'deviceId 仍是 exact');
    assert(c.audio === false, 'audio 恒为 false');
  }

  /* ---------- 4. 开流前命中记忆档位 ---------- */
  console.log('\n· 4 记忆命中：分辨率必须写进 getUserMedia 约束');
  {
    const saves = [];
    // 假摄像头的能力与真实输出都是 2560×1440（与记忆档位一致）
    const md = makeMd({ stream: { track: { _w: 2560, _h2: 1440, getCapabilities: () => ({ width: { max: 2560 }, height: { max: 1440 } }) } } });
    const video = makeVideo({ videoWidth: 2560, videoHeight: 1440 });
    const c = make({
      mediaDevices: md,
      videoGetter: () => video,
      loadResolutionPref: () => ({ v: 1, w: 2560, h: 1440, fps: 30, ts: Date.now() }),
      saveResolutionPref: (id, val) => saves.push({ id: id, val: val })
    });
    await c.mount(() => video); // mount 时还不知道 deviceId，走全量枚举并存档
    saves.length = 0; // 只看「命中记忆」这一次
    md.allConstraints.length = 0;
    await c.open('cam-a');
    await sleep(60);
    assert(c.state === 'LIVE', '命中记忆档位后正常出画（' + c.state + '）');
    const v = md.lastConstraints.video;
    assert(v && v.width && v.width.exact === 2560 && v.height.exact === 1440,
      '开流前的 gUM 约束已带 exact 分辨率（实际 ' + JSON.stringify(v) + '）——否则只能开默认档再事后提');
    assert(v.deviceId && v.deviceId.exact === 'cam-a', '设备约束不得被分辨率约束顶掉');
    eq(c.getResolution(), { width: 2560, height: 1440 }, '实际输出 = 记忆档位');
    assert(c.snapshot().resolutionSource === 'pref', '来源标记为 pref（' + c.snapshot().resolutionSource + '）');
    assert(saves.some((s) => s.id === 'cam-a' && s.val && s.val.w === 2560), '锁定成功即持久化（按 deviceId 存档）');
    c.unmount();
  }

  /* ---------- 5. 逐档降级：最高档被拒 → 次优档 ---------- */
  console.log('\n· 5 逐档降级（旧实现会静默吞掉 OverconstrainedError）');
  {
    const logs = [];
    const md = makeMd({ stream: { track: { supported: [[1280, 720], [640, 480]], _w: 640, _h2: 480 } } });
    const video = makeVideo({ videoWidth: 1280, videoHeight: 720 });
    const c = make({
      mediaDevices: md,
      videoGetter: () => video,
      log: (l, e, f) => logs.push({ l: l, e: e, f: f || {} })
    });
    await c.mount(() => video);
    await c.open('cam-b');
    await sleep(120);
    assert(c.state === 'LIVE', '降级后仍正常出画（' + c.state + '）');
    eq(c.getResolution(), { width: 1280, height: 720 }, '锁定到设备真正支持的最高档（不是默认的 640×480）');
    assert(c.getError() === null, '降级不置错误（拍照主流程不受影响）');
    const fb = logs.filter((x) => x.e === 'CAM_RES_FALLBACK');
    assert(fb.length >= 1, '降级有日志（' + fb.length + ' 条 CAM_RES_FALLBACK）');
    assert(fb.some((x) => x.f.reason === 'overconstrained'), '降级原因可辨（overconstrained）');
    assert(logs.some((x) => x.e === 'CAM_RES_ENUM' && x.f.rungs > 1), '记录了枚举到的档位数（现场可核对最高档）');
    assert(logs.some((x) => x.e === 'CAM_RES_APPLY' && x.f.res && x.f.res.w === 1280), '记录了最终锁定的档位');
    assert(fb.concat(logs).every((x) => Object.keys(x.f).length <= 9), '日志字段体量受控（附加字段 ≤ 6）');
    c.unmount();
  }

  /* ---------- 6. 全档失败：仍要出画，只留日志 ---------- */
  console.log('\n· 6 全档失败：保留当前流、不置 ERROR');
  {
    const logs = [];
    const md = makeMd({ stream: { track: { supported: [[1, 1]], _w: 640, _h2: 480 } } });
    const video = makeVideo({ videoWidth: 640, videoHeight: 480 });
    const c = make({
      mediaDevices: md,
      videoGetter: () => video,
      config: Object.assign({}, CFG, { resMaxRungs: 4 }),
      log: (l, e, f) => logs.push({ l: l, e: e, f: f || {} })
    });
    await c.mount(() => video);
    await c.open('cam-c');
    await sleep(120);
    assert(c.state === 'LIVE', '全档失败仍然出画（' + c.state + '）');
    assert(c.getError() === null, '不得置 ERROR（分辨率是优化项，不该挡住拍照）');
    eq(c.getResolution(), { width: 640, height: 480 }, '实际输出如实记录（不谎报最高档）');
    assert(logs.some((x) => x.e === 'CAM_RES_FALLBACK' && x.f.reason === 'ladder-exhausted'), '明确记录「全档失败」');
    c.unmount();
  }

  /* ---------- 7. applyConstraints 永不 settle ---------- */
  console.log('\n· 7 applyConstraints 悬挂：超时兜底，不卡 STARTING');
  {
    const md = makeMd({ stream: { track: { hang: true, _w: 640, _h2: 480 } } });
    const video = makeVideo({ videoWidth: 640, videoHeight: 480 });
    const c = make({
      mediaDevices: md,
      videoGetter: () => video,
      config: Object.assign({}, CFG, { resMaxRungs: 3 })
    });
    c.mount(() => video);
    c.open('cam-d');
    let waited = 0;
    while (waited < 2000 && c.state !== 'LIVE') { await sleep(30); waited += 30; }
    assert(c.state === 'LIVE', '悬挂后仍出画（末态 ' + c.state + '，耗时 ' + waited + 'ms）');
    eq(c.getResolution(), { width: 640, height: 480 }, '悬挂时按当前输出记录');
    c.unmount();
  }

  /* ---------- 8. 记忆档位被设备拒绝 → 清空记忆 ---------- */
  console.log('\n· 8 记忆档位失效：清空并回落（换了一台能力更低的摄像头时）');
  {
    const saves = [];
    const md = makeMd({ delay: 2, stream: { track: { _w: 640, _h2: 480 } } });
    const video = makeVideo({ videoWidth: 640, videoHeight: 480 });
    const c = make({
      mediaDevices: md,
      videoGetter: () => video,
      loadResolutionPref: () => ({ v: 1, w: 3840, h: 2160, fps: 30, ts: Date.now() }),
      saveResolutionPref: (id, val) => saves.push({ id: id, val: val })
    });
    // 这台摄像头只认 1920×1080 及以下：带 3840×2160 的 exact 约束必然 OverconstrainedError
    const realGum = md.getUserMedia;
    md.getUserMedia = (cst) => {
      const vv = cst && cst.video;
      // 走 realGum 以保证 constraints 被记录进 allConstraints（断言要看每次请求带了什么）
      md.err = vv && vv.width && vv.width.exact === 3840 ? 'OverconstrainedError' : null;
      return realGum(cst);
    };
    await c.mount(() => video);
    saves.length = 0;
    md.allConstraints.length = 0;
    await c.open('cam-e');
    await sleep(120);
    assert(c.state === 'LIVE', '清空记忆后仍能出画（' + c.state + '）');
    assert(saves.some((s) => s.id === 'cam-e' && s.val === null), '失效的记忆档位被清空（否则每次开流都先撞一次 OverconstrainedError）');
    assert(md.allConstraints.length >= 2, '失败后有回落重试（共 ' + md.allConstraints.length + ' 次 gUM）');
    assert(md.allConstraints.some((x) => x.video === true || !(x.video.width && x.video.width.exact === 3840)),
      '回落后的 gUM 不再带那个被拒的档位（实际 ' + JSON.stringify(md.allConstraints[md.allConstraints.length - 1]) + '）');
    assert(c.getResolution() !== null, '仍记录实际输出');
    c.unmount();
  }

  /* ---------- 9. 换设备不串档 ---------- */
  console.log('\n· 9 切换摄像头：不得沿用别的设备的记忆档位');
  {
    const PREFS = {
      'cam-a': { v: 1, w: 1920, h: 1080, fps: 30, ts: 1 },
      'cam-b': { v: 1, w: 640, h: 480, fps: 30, ts: 1 }
    };
    const loads = [];
    const saves = [];
    const md = makeMd({ stream: { track: { _w: 1920, _h2: 1080 } } });
    const video = makeVideo();
    const c = make({
      mediaDevices: md,
      videoGetter: () => video,
      loadResolutionPref: (id) => { loads.push(id); return PREFS[id] || null; },
      saveResolutionPref: (id, val) => saves.push({ id: id, val: val })
    });
    await c.mount(() => video);
    await c.open('cam-a');
    await sleep(80);
    assert(md.lastConstraints.video.width.exact === 1920, 'cam-a 用 cam-a 的档位（' + md.lastConstraints.video.width.exact + '）');
    await c.open('cam-b');
    await sleep(80);
    assert(md.lastConstraints.video.width.exact === 640, '切到 cam-b 后立刻换成 cam-b 的档位（' + md.lastConstraints.video.width.exact + '）');
    assert(loads.indexOf('cam-a') >= 0 && loads.indexOf('cam-b') >= 0, '按 deviceId 分别读取（' + loads.join(',') + '）');
    assert(saves.some((s) => s.id === 'cam-a') && saves.some((s) => s.id === 'cam-b'), '按 deviceId 分别存档');
    c.unmount();
  }

  /* ---------- 10. 出画复核：settings 与 video 实际尺寸不一致 ---------- */
  console.log('\n· 10 实际输出校验（驱动没真正切档时必须留证据）');
  {
    const logs = [];
    const md = makeMd({ stream: { track: { _w: 1920, _h2: 1080 } } });
    // track 说 1920×1080，画面实际只有 1280×720 —— 现场「设了更高分辨率但不生效」的同款症状
    const video = makeVideo({ videoWidth: 1280, videoHeight: 720 });
    const c = make({
      mediaDevices: md,
      videoGetter: () => video,
      log: (l, e, f) => logs.push({ l: l, e: e, f: f || {} })
    });
    await c.mount(() => video);
    await c.open('cam-f');
    await sleep(80);
    eq(c.getResolution(), { width: 1280, height: 720 }, '以画面真实尺寸为准（拍照出图用的是 video 尺寸）');
    const v = logs.filter((x) => x.e === 'CAM_RES_VERIFY');
    assert(v.length >= 1, '出画后做了交叉校验（' + v.length + ' 条 CAM_RES_VERIFY）');
    assert(v.some((x) => x.f.reason === 'video-mismatch' && x.f.gotW === 1280 && x.f.gotH === 720),
      '不一致时记录原因与实际尺寸（现场复盘「为什么掉档」）');

    // 一致时不报警
    const logs2 = [];
    const md2 = makeMd({ stream: { track: { _w: 1920, _h2: 1080 } } });
    const video2 = makeVideo({ videoWidth: 1920, videoHeight: 1080 });
    const c2 = make({
      mediaDevices: md2,
      videoGetter: () => video2,
      log: (l, e, f) => logs2.push({ l: l, e: e, f: f || {} })
    });
    await c2.mount(() => video2);
    await c2.open('cam-g');
    await sleep(80);
    eq(c2.getResolution(), { width: 1920, height: 1080 }, '一致时维持 settings 值');
    assert(logs2.some((x) => x.e === 'CAM_RES_VERIFY' && x.f.reason === 'ok'), '一致时记 ok');
    c.unmount();
    c2.unmount();
  }

  /* ---------- 11. I1：探测过程不得产生第二条流 ---------- */
  console.log('\n· 11 单一活跃流（I1）与泄漏审计');
  {
    const base = allStreams.length;
    const md = makeMd({ delay: 5, stream: { track: { supported: [[1280, 720]], _w: 640, _h2: 480 } } });
    const video = makeVideo({ videoWidth: 1280, videoHeight: 720 });
    const c = make({
      mediaDevices: md,
      videoGetter: () => video,
      loadResolutionPref: () => ({ v: 1, w: 1920, h: 1080, ts: 1 }),
      saveResolutionPref: () => {}
    });
    await c.mount(() => video);
    await c.open('cam-h');
    await sleep(120);
    assert(c.state === 'LIVE', '开流成功（' + c.state + '）');
    const mine = allStreams.slice(base);
    assert(live(mine) === 1, '逐档探测全程只有 1 条 live 流（实际 ' + live(mine) + ' / 共产生 ' + mine.length + '）');
    c.unmount();
    assert(live(mine) === 0, 'unmount 后无 live track（I7）');
  }

  /* ---------- 12. 契约不变：既有断言必须继续成立 ---------- */
  console.log('\n· 12 既有契约不被破坏');
  {
    const md = makeMd();
    const c = make({ mediaDevices: md, videoGetter: () => makeVideo() });
    await c.mount(() => makeVideo());
    await c.open('cam-i');
    await sleep(60);
    eq(c.getResolution(), { width: 1920, height: 1080 }, 'getResolution() 仍是 { width, height }（verify-camera 的强断言）');
    eq(md.lastConstraints, { video: { deviceId: { exact: 'cam-i' } }, audio: false }, '无记忆档位时 gUM 约束一字不改');
    const info = c.getResolutionInfo();
    assert(info && info.actual && info.request && typeof info.source === 'string', 'getResolutionInfo() 暴露请求档位 / 实际档位 / 来源');
    const s = c.snapshot();
    assert(s.resolutionRequest && typeof s.resolutionSource === 'string', 'snapshot 同时暴露请求档位与来源');
    c.unmount();
  }

  /* ---------- 13. 重启场景：deviceId 还没枚举出来也要一次到位 ---------- */
  console.log('\n· 13 重启后（未指定设备）靠「默认设备档位」命中');
  {
    const saves = [];
    const loads = [];
    const md = makeMd({ stream: { track: { _w: 1920, _h2: 1080, deviceId: 'cam-a' } } });
    const video = makeVideo();
    const c = make({
      mediaDevices: md,
      videoGetter: () => video,
      loadResolutionPref: (id) => { loads.push(id); return id === '' ? { v: 1, w: 1920, h: 1080, fps: 30, ts: 1, dev: 'cam-a' } : null; },
      saveResolutionPref: (id, val) => saves.push({ id: id, val: val })
    });
    await c.mount(() => video); // 启动时 deviceId 为空（还没枚举）
    await sleep(80);
    assert(c.state === 'LIVE', '重启后正常出画（' + c.state + '）');
    const v = md.lastConstraints.video;
    assert(v && v.width && v.width.exact === 1920, '重启后第一次 gUM 就带上记忆档位（实际 ' + JSON.stringify(v) + '）——否则必然先落到默认档');
    assert(c.snapshot().resolutionSource === 'pref', '来源 pref（' + c.snapshot().resolutionSource + '）');
    eq(c.getResolution(), { width: 1920, height: 1080 }, '实际输出即记忆档位');
    assert(saves.some((s) => s.id === '' && s.val && s.val.w === 1920), '回写默认设备档位（下次启动继续命中）');
    assert(saves.some((s) => s.id === 'cam-a' && s.val && s.val.w === 1920), '同时按真实 deviceId 存一份（下拉里选它时直接命中）');
    c.unmount();
  }

  /* ---------- 14. 默认档位的防串档 ---------- */
  console.log('\n· 14 默认摄像头换过（设备对不上）→ 作废默认档位并重新枚举');
  {
    const saves = [];
    const md = makeMd({ stream: { track: { _w: 640, _h2: 480, deviceId: 'cam-new' } } });
    const video = makeVideo();
    const c = make({
      mediaDevices: md,
      videoGetter: () => video,
      // 记忆来自 cam-old，实际出流的是 cam-new
      loadResolutionPref: (id) => (id === '' ? { v: 1, w: 800, h: 600, fps: 30, ts: 1, dev: 'cam-old' } : null),
      saveResolutionPref: (id, val) => saves.push({ id: id, val: val })
    });
    await c.mount(() => video);
    await sleep(80);
    assert(c.state === 'LIVE', '换设备后仍正常出画（' + c.state + '）');
    assert(saves.some((s) => s.id === '' && s.val === null), '对不上的默认档位被作废（不会沿用别的设备的记忆值）');
    eq(c.getResolution(), { width: 1920, height: 1080 }, '作废后走全量枚举，锁到本机最高档（不是记忆里的 800×600）');
    assert(c.snapshot().resolutionSource !== 'pref', '来源不得再标 pref（' + c.snapshot().resolutionSource + '）');
    c.unmount();
  }

  /* ---------- 15. 记忆档位被拒时不得顺带放开设备约束 ---------- */
  console.log('\n· 15 记忆档位被拒：只去掉分辨率，保留用户选的那台设备');
  {
    const saves = [];
    const md = makeMd({ delay: 2, stream: { track: { _w: 640, _h2: 480, deviceId: 'cam-x' } } });
    const video = makeVideo({ videoWidth: 640, videoHeight: 480 });
    const c = make({
      mediaDevices: md,
      videoGetter: () => video,
      loadResolutionPref: (id) => (id === 'cam-x' ? { v: 1, w: 3840, h: 2160, fps: 30, ts: 1 } : null),
      saveResolutionPref: (id, val) => saves.push({ id: id, val: val })
    });
    const realGum = md.getUserMedia;
    md.getUserMedia = (cst) => {
      const vv = cst && cst.video;
      md.err = vv && vv.width && vv.width.exact === 3840 ? 'OverconstrainedError' : null;
      return realGum(cst);
    };
    await c.mount(() => video);
    await c.open('cam-x');
    await sleep(120);
    assert(c.state === 'LIVE', '仍能出画（' + c.state + '）');
    assert(saves.some((s) => s.id === 'cam-x' && s.val === null), '记忆档位被清空');
    const kept = md.allConstraints.filter((x) => x.video && x.video.deviceId && x.video.deviceId.exact === 'cam-x' && !x.video.width);
    assert(kept.length >= 1, '回落时保留了 deviceId 约束（否则会打开默认摄像头而不是用户选的那台）');
    const firstX = md.allConstraints.filter((x) => x.video && x.video.deviceId && x.video.deviceId.exact === 'cam-x')[0];
    assert(firstX && firstX.video.width && firstX.video.width.exact === 3840,
      '首次仍带记忆档位尝试（一次到位优先，实际 ' + JSON.stringify(firstX) + '）');
    c.unmount();
  }

  /* ---------- 16. 指定设备必须按各自 deviceId 存取（双向） ---------- */
  console.log('\n· 16 自己的档位要能命中，别人的档位不能串（双向）');
  {
    // 两台能力不同的摄像头：A 能上 1920×1080，B 只能到 1280×720
    const PER = {
      'cam-a': { caps: { width: { max: 1920 }, height: { max: 1080 } } },
      'cam-b': { caps: { width: { max: 1280 }, height: { max: 720 } } }
    };
    const store = {}; // 扮演 localStorage：键必须各自独立
    const md = makeMd();
    let liveTrack = null;
    md.getUserMedia = (cst) => {
      md.calls += 1;
      md.lastConstraints = cst;
      md.allConstraints.push(JSON.parse(JSON.stringify(cst)));
      const id = cst && cst.video && cst.video.deviceId ? cst.video.deviceId.exact : '';
      const per = PER[id] || PER['cam-a'];
      // 开流一律先给默认档 640×480 —— 真实摄像头重启后多数开在默认档，必须靠 applyConstraints 复现
      liveTrack = makeTrack({ deviceId: id || 'cam-default', getCapabilities: () => per.caps, _w: 640, _h2: 480 });
      const s = { getTracks: () => [liveTrack], getVideoTracks: () => [liveTrack], __t: liveTrack };
      allStreams.push(s);
      return Promise.resolve(s);
    };
    // 画面尺寸始终跟随 track 实际输出（否则会命中「出画复核不一致」这条别的分支）
    const video = makeVideo();
    Object.defineProperty(video, 'videoWidth', { get: () => (liveTrack ? liveTrack._w : 0) });
    Object.defineProperty(video, 'videoHeight', { get: () => (liveTrack ? liveTrack._h2 : 0) });
    const c = make({
      mediaDevices: md,
      videoGetter: () => video,
      loadResolutionPref: (id) => store[id] || null,
      saveResolutionPref: (id, val) => { if (val) store[id] = val; else delete store[id]; }
    });

    await c.mount(() => video);
    await c.open('cam-a');
    await sleep(80);
    assert(c.state === 'LIVE' && c.getResolution().width === 1920, 'A 首开锁定 1920×1080（' + JSON.stringify(c.getResolution()) + '）');
    assert(store['cam-a'] && store['cam-a'].w === 1920, 'A 的档位按 A 自己的 deviceId 落盘（键 ' + Object.keys(store).join(',') + '）');

    // 打开 B：不得带上 A 的档位
    await c.open('cam-b');
    await sleep(80);
    const cstB = md.lastConstraints.video;
    assert(cstB.deviceId && cstB.deviceId.exact === 'cam-b' && !cstB.width,
      '开 B 时不串 A 的档位（实际 ' + JSON.stringify(cstB) + '）');
    assert(c.getResolution().width === 1280, 'B 锁到自己能力的上限 1280×720（' + JSON.stringify(c.getResolution()) + '）');
    assert(store['cam-b'] && store['cam-b'].w === 1280, 'B 的档位按 B 自己的 deviceId 落盘');
    assert(store['cam-a'] && store['cam-a'].w === 1920,
      'A 的存档未被 B 覆盖（仍 ' + JSON.stringify(store['cam-a'] || null) + '）——串档变异体的落点');

    // 再打开 A：必须命中它自己的存档
    md.allConstraints.length = 0;
    await c.open('cam-a');
    await sleep(80);
    const cstA = md.allConstraints[0].video;
    assert(cstA.width && cstA.width.exact === 1920 && cstA.height && cstA.height.exact === 1080,
      '再开 A 命中 A 自己的存档（实际 ' + JSON.stringify(cstA) + '）');
    eq(c.getResolution(), { width: 1920, height: 1080 }, '复现到 A 的档位');
    assert(c.getResolutionInfo().source === 'pref', '来源 pref（' + c.getResolutionInfo().source + '）——记忆命中并成功复现也要标 pref');
    c.unmount();
  }

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
