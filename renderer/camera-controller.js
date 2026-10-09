'use strict';

/* ---------- 摄像头预览生命周期状态机 ----------
 * 纯逻辑模块：不引用 Vue、不直接引用 DOM。
 * DOM 通过注入的 videoGetter() / frameSampler() 获取，因此可以在 Node 下用假对象单测。
 *
 * 核心不变式（契约 §6.3）：
 *   I1 单一活跃流：任意时刻至多 1 条未被 stop() 的 MediaStream，releaseActive() 是唯一停止入口
 *   I2 谁创建谁停止：gUM 拿到的流若判定过期/组件已卸载，必须在同一调用链内 stop()
 *   I3 显示与状态一致：ERROR/SLEEPING 下 stream 必为 null，video.srcObject 同步清空
 *   I4 错误必可见：错误通过 error 对象暴露，由渲染层覆盖层呈现
 *   I5 拍照闸门：仅 LIVE 允许拍照
 *   I6 attach 必成功或必报错：videoEl 取不到不得静默跳过
 *   I7 卸载即释放：unmount() 返回后不存在任何 live track
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.CameraController = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null), function () {
  'use strict';

  var STATES = {
    UNINIT: 'UNINIT',
    STARTING: 'STARTING',
    LIVE: 'LIVE',
    DEGRADED: 'DEGRADED',
    SLEEPING: 'SLEEPING',
    ERROR: 'ERROR'
  };

  var DEFAULTS = {
    backoffMs: [400, 800, 1600, 3200],
    openTimeoutMs: 8000,
    degradedWatchMs: 5000,
    frameWaitMs: 5000,
    framePollMs: 60,
    maxAttempts: 5,
    sampleSize: 64,
    // 闪断风暴闸门：距上次出画不足 flapWindowMs 的断开才计一次「连续闪断」，
    // 累计超过 flapMax 次转 ERROR 等人工；稳定运行超过窗口期即视为不再闪断
    flapWindowMs: 30000,
    flapMax: 5,
    blackMean: 12,
    blackVariance: 4,
    // 悬挂兜底：play() / applyConstraints 部分 UVC 摄像头会永不 settle，
    // 若不加超时，控制器会卡在 STARTING 且无错误提示（与「黑屏只能重开」同族症状）
    attachTimeoutMs: 2000,
    applyConstraintMs: 1000,
    accessGateMs: 1000
  };

  /* ---------- 纯计算辅助（可被单测直接调用） ---------- */

  // 灰度样本统计：mean 为均值，variance 为总体方差；black 为「纯黑帧」判定
  function analyzeGraySamples(samples, thresholds) {
    var th = thresholds || {};
    var meanMax = th.mean == null ? DEFAULTS.blackMean : th.mean;
    var varMax = th.variance == null ? DEFAULTS.blackVariance : th.variance;
    var n = samples && samples.length ? samples.length : 0;
    if (!n) return { mean: null, variance: null, black: false, samples: 0 };
    // 脏数据（NaN/非有限值）不得被 || 0 强转成 0 误判纯黑：只统计有限样本
    var finite = 0;
    var sum = 0;
    for (var i = 0; i < n; i++) {
      var v = Number(samples[i]);
      if (!isFinite(v)) continue;
      sum += v; finite++;
    }
    if (!finite) return { mean: null, variance: null, black: false, samples: 0 };
    var mean = sum / finite;
    var acc = 0;
    for (var j = 0; j < n; j++) {
      var vj = Number(samples[j]);
      if (!isFinite(vj)) continue;
      var d = vj - mean;
      acc += d * d;
    }
    var variance = acc / finite;
    return { mean: mean, variance: variance, black: mean < meanMax && variance < varMax, samples: finite };
  }

  // 从 ImageData 结构里取中心 size×size 的灰度样本（不触碰 DOM，纯数组运算）
  function sampleCenterGray(image, size) {
    var side = Math.max(1, Math.min(size || DEFAULTS.sampleSize, (image && image.width) || 0, (image && image.height) || 0));
    var data = image && image.data;
    if (!data || !image.width || !image.height) return null;
    var x0 = Math.floor((image.width - side) / 2);
    var y0 = Math.floor((image.height - side) / 2);
    var out = new Array(side * side);
    var k = 0;
    for (var y = 0; y < side; y++) {
      var row = (y0 + y) * image.width;
      for (var x = 0; x < side; x++) {
        var i = (row + x0 + x) * 4;
        out[k++] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      }
    }
    return out;
  }

  // 错误分类：fatal=true 表示不可重试（权限/无设备/安全上下文）
  function classifyError(e) {
    var name = (e && e.name) || 'Error';
    var message = (e && e.message) || '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return { code: 'PERMISSION_DENIED', fatal: true, recoverable: false, message: '系统未授予摄像头权限，请在系统设置中允许本程序使用摄像头', err: { name: name, message: message } };
    }
    if (name === 'SecurityError') {
      return { code: 'SECURITY', fatal: true, recoverable: false, message: '当前环境不允许调用摄像头', err: { name: name, message: message } };
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return { code: 'NO_DEVICE', fatal: true, recoverable: false, message: '未检测到摄像头，请检查设备连接', err: { name: name, message: message } };
    }
    if (name === 'OverconstrainedError') {
      return { code: 'OVERCONSTRAINED', fatal: false, recoverable: true, message: '所选摄像头不支持当前参数，已尝试降级重试', err: { name: name, message: message } };
    }
    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
      return { code: 'DEVICE_BUSY', fatal: false, recoverable: true, message: '摄像头被其他程序占用或未就绪', err: { name: name, message: message } };
    }
    return { code: 'UNKNOWN', fatal: false, recoverable: true, message: '无法打开摄像头：' + (message || name), err: { name: name, message: message } };
  }

  function shortDeviceId(id) {
    if (!id) return null;
    return String(id).slice(0, 8);
  }

  // 默认日志：优先走 window.api.cameraLog（主进程落盘），不可用时降级到控制台，绝不抛错
  function defaultLog(level, event, fields) {
    try {
      var api = typeof window !== 'undefined' ? window.api : null;
      if (api && typeof api.cameraLog === 'function') {
        var p = api.cameraLog({ level: level, event: event, fields: fields || {} });
        if (p && typeof p.catch === 'function') p.catch(function () {});
        return;
      }
    } catch (e) {
      /* IPC 不可用时静默降级，绝不影响拍照主流程 */
    }
    try {
      console.log('[camera]', level, event, fields || {});
    } catch (e2) {
      /* 无控制台也不影响 */
    }
  }

  /* ---------- 控制器 ---------- */

  function createCameraController(options) {
    var opt = options || {};
    var cfg = Object.assign({}, DEFAULTS, opt.config || {});
    var md = opt.mediaDevices || (typeof navigator !== 'undefined' ? navigator.mediaDevices : null) || null;
    var now = opt.now || function () { return Date.now(); };
    var st = opt.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
    var ct = opt.clearTimeout || function (id) { return clearTimeout(id); };
    var log = opt.log || defaultLog;
    var videoGetter = opt.videoGetter || function () { return null; };
    var frameSampler = opt.frameSampler || null;
    var blackFrameEnabled = opt.blackFrameEnabled || function () { return true; };
    // 系统级摄像头授权预检（R10）：由渲染层注入 window.api.cameraAccess，
    // 不支持时为 null，一律放行，绝不阻断正常取流
    var checkAccess = opt.checkAccess || null;
    var openPrivacy = opt.openPrivacy || null;

    var alive = false;
    var state = STATES.UNINIT;
    var error = null; // { code, message, recoverable }
    var stream = null;
    var resolution = null; // { width, height }
    var seq = 0;
    var attempt = 0;
    var preferredId = '';
    var fallbackNoExact = false; // OverconstrainedError 后降级为 { video: true }
    var openPromise = null;
    var degradedTimer = null;
    // 闪断闸门状态：lastLiveAt = 上次成功出画的时刻；flapCount = 连续闪断计数
    var lastLiveAt = 0;
    var flapCount = 0;
    var timers = [];
    var waiters = [];
    var trackBinds = [];
    var deviceBound = false;

    var listeners = { state: [], error: [], devices: [] };

    function on(name, cb) {
      if (typeof cb !== 'function') return function () {};
      listeners[name].push(cb);
      return function () {
        var i = listeners[name].indexOf(cb);
        if (i >= 0) listeners[name].splice(i, 1);
      };
    }

    function emit(name, payload) {
      var arr = listeners[name].slice();
      for (var i = 0; i < arr.length; i++) {
        try {
          arr[i](payload);
        } catch (e) {
          /* 订阅者自身异常不得影响状态机推进 */
        }
      }
    }

    // 日志 res 字段恒为 { w, h }（或 null），与主进程 camera-log.js 的 resOf 对齐
    function resField() {
      return resolution && (resolution.width || resolution.height)
        ? { w: resolution.width || 0, h: resolution.height || 0 }
        : null;
    }

    function setState(next, reason) {
      if (state === next) return;
      var prev = state;
      state = next;
      // 每次出画都记下时刻：闪断闸门靠「距上次出画多久」区分偶发闪断与高频闪断
      if (next === STATES.LIVE) lastLiveAt = now();
      emit('state', { state: state, prev: prev, reason: reason || null, resolution: resolution });
    }

    // 闪断闸门（拍板方案：成功即归零 + 时间窗闸门）：
    // 只有「距上次成功出画不足 flapWindowMs 就再次断开」才计一次连续闪断；
    // 稳定运行超过窗口后的断开视为偶发，计数归零重新计。
    // 注意：进入 LIVE 本身不清零，否则每次闪断都被自己的重连成功洗掉，闸门永远触发不了
    function noteFlap() {
      var within = lastLiveAt > 0 && (now() - lastLiveAt) < cfg.flapWindowMs;
      flapCount = within ? flapCount + 1 : 0;
      return flapCount;
    }

    function setError(next) {
      var same = (!error && !next) || (error && next && error.code === next.code && error.message === next.message);
      error = next || null;
      if (!same) emit('error', { error: error, state: state });
    }

    /* ---------- 定时器 ---------- */

    function waitMs(ms) {
      var w = { resolve: null, id: null, promise: null, cancelled: false };
      w.promise = new Promise(function (resolve) {
        w.resolve = resolve;
        w.id = st(function () {
          var i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          var t = timers.indexOf(w.id);
          if (t >= 0) timers.splice(t, 1);
          w.id = null;
          resolve(true);
        }, ms);
        timers.push(w.id);
        waiters.push(w);
      });
      // 取消：立即清除底层定时器并从 timers 摘掉，避免 Promise.race 落败一侧的
      // 计时器成为悬挂定时（实测会导致空闲期残留 2 个 pending 定时器）。
      w.cancel = function () {
        if (w.cancelled) return;
        w.cancelled = true;
        if (w.id != null) {
          try { ct(w.id); } catch (e) {}
          var t = timers.indexOf(w.id);
          if (t >= 0) timers.splice(t, 1);
          w.id = null;
        }
        try { w.resolve(false); } catch (e) {}
      };
      return w;
    }

    function clearTimers() {
      // 先放行等待中的 waiter，避免 unmount 后 async 流程永久挂起（泄漏闭包）
      var ws = waiters.slice();
      waiters.length = 0;
      for (var i = 0; i < ws.length; i++) {
        try { ws[i].resolve(false); } catch (e) {}
      }
      var ts = timers.slice();
      timers.length = 0;
      for (var j = 0; j < ts.length; j++) {
        try { ct(ts[j]); } catch (e2) {}
      }
      clearDegradedWatch();
    }

    function clearDegradedWatch() {
      if (degradedTimer != null) {
        try { ct(degradedTimer); } catch (e) {}
        var i = timers.indexOf(degradedTimer);
        if (i >= 0) timers.splice(i, 1);
        degradedTimer = null;
      }
    }

    /* ---------- 流的停止与回收 ---------- */

    function trackList(s) {
      if (!s) return [];
      return (typeof s.getTracks === 'function' ? s.getTracks() : []) || [];
    }

    function unbindTracks(s) {
      for (var i = trackBinds.length - 1; i >= 0; i--) {
        var b = trackBinds[i];
        if (b.s !== s) continue;
        try {
          if (b.type === 'prop') {
            b.t.onended = null;
            b.t.onmute = null;
            b.t.onunmute = null;
          } else if (b.t && typeof b.t.removeEventListener === 'function') {
            b.t.removeEventListener(b.type, b.fn);
          }
        } catch (e) {}
        trackBinds.splice(i, 1);
      }
    }

    // 只停轨道不做日志（供上层自行决定事件名）
    function stopTracks(s) {
      var tracks = trackList(s);
      unbindTracks(s);
      for (var i = 0; i < tracks.length; i++) {
        try { tracks[i].stop(); } catch (e) {}
      }
      return tracks.length;
    }

    // 停止一条「不该继续存在」的流（漏 guard 用），默认打 CAM_LEAK_GUARD
    function stopStream(s, reason, event) {
      var tracks = stopTracks(s);
      if (tracks.length || event) {
        log(event && event !== 'CAM_LEAK_GUARD' ? 'error' : 'warn', event || 'CAM_LEAK_GUARD', {
          seq: seq,
          reason: reason || null,
          tracks: tracks.length
        });
      }
      return tracks.length;
    }

    // I1：唯一的「停止当前活跃流」入口
    function releaseActive(reason) {
      var s = stream;
      stream = null;
      openPromise = null;
      clearDegradedWatch();
      var el = safeVideo();
      if (el) {
        try {
          if (!s || el.srcObject === s || el.srcObject == null) el.srcObject = null;
        } catch (e) {}
      }
      if (!s) return 0;
      unbindTracks(s);
      var tracks = trackList(s);
      for (var i = 0; i < tracks.length; i++) {
        try { tracks[i].stop(); } catch (e2) {}
      }
      return tracks.length;
    }

    function safeVideo() {
      try { return videoGetter(); } catch (e) { return null; }
    }

    function activeTrack() {
      if (!stream || typeof stream.getVideoTracks !== 'function') return null;
      var t = stream.getVideoTracks();
      return t && t.length ? t[0] : null;
    }

    /* ---------- 设备监听 ---------- */

    function handleDeviceChange() {
      if (!alive) return;
      log('info', 'CAM_DEVICE_CHANGE', { seq: seq, state: state, device: shortDeviceId(preferredId) });
      emit('devices', { state: state });
      // 因「无设备/参数不匹配/占用」而停在 ERROR 时，插拔设备是唯一的自动恢复入口
      if (state === STATES.ERROR && error && (error.code === 'NO_DEVICE' || error.code === 'OVERCONSTRAINED' || error.code === 'DEVICE_BUSY' || error.code === 'RETRY_EXHAUSTED' || error.code === 'OPEN_TIMEOUT')) {
        attempt = 0;
        fallbackNoExact = false;
        open(preferredId);
      }
    }

    function bindDeviceChange() {
      if (!md || typeof md.addEventListener !== 'function' || deviceBound) return;
      try {
        md.addEventListener('devicechange', handleDeviceChange);
        deviceBound = true;
      } catch (e) {}
    }

    function unbindDeviceChange() {
      if (!md || typeof md.removeEventListener !== 'function' || !deviceBound) return;
      try { md.removeEventListener('devicechange', handleDeviceChange); } catch (e) {}
      deviceBound = false;
    }

    /* ---------- track 生命周期（RC-2） ---------- */

    function bindTracks(s, mySeq) {
      var tracks = trackList(s);
      for (var i = 0; i < tracks.length; i++) {
        var t = tracks[i];
        var onEnded = function () { handleTrackEnded(mySeq); };
        var onMute = function () { handleTrackMuted(mySeq); };
        var onUnmute = function () { handleTrackUnmuted(mySeq); };
        if (t && typeof t.addEventListener === 'function') {
          t.addEventListener('ended', onEnded);
          t.addEventListener('mute', onMute);
          t.addEventListener('unmute', onUnmute);
          trackBinds.push({ s: s, t: t, type: 'ended', fn: onEnded });
          trackBinds.push({ s: s, t: t, type: 'mute', fn: onMute });
          trackBinds.push({ s: s, t: t, type: 'unmute', fn: onUnmute });
        } else if (t) {
          t.onended = onEnded;
          t.onmute = onMute;
          t.onunmute = onUnmute;
          trackBinds.push({ s: s, t: t, type: 'prop', fn: null });
        }
      }
    }

    function handleTrackEnded(mySeq) {
      if (mySeq !== seq || !alive) return;
      log('warn', 'CAM_TRACK_ENDED', { seq: seq, device: shortDeviceId(preferredId), attempt: attempt, flap: flapCount });
      releaseActive('ended');
      clearTimers();
      setState(STATES.STARTING, 'ended');
      reconnect('ended');
    }

    function handleTrackMuted(mySeq) {
      if (mySeq !== seq || !alive) return;
      log('warn', 'CAM_TRACK_MUTED', { seq: seq, device: shortDeviceId(preferredId) });
      if (state === STATES.LIVE || state === STATES.STARTING) setState(STATES.DEGRADED, 'muted');
      startDegradedWatch(mySeq);
    }

    function handleTrackUnmuted(mySeq) {
      if (mySeq !== seq || !alive) return;
      var el = safeVideo();
      if (frameReady(el)) {
        clearDegradedWatch();
        setState(STATES.LIVE, 'unmuted');
        log('info', 'CAM_LIVE', { seq: seq, device: shortDeviceId(preferredId), res: resField(), reason: 'unmuted', flap: flapCount });
      } else {
        startDegradedWatch(mySeq);
      }
    }

    function startDegradedWatch(mySeq) {
      clearDegradedWatch();
      degradedTimer = st(function () {
        var firedId = degradedTimer;
        degradedTimer = null;
        // 回调触发时把自身 id 从 timers 数组摘掉，避免数组随闪断次数单调增长（D2 泄漏）
        if (firedId != null) {
          var ti = timers.indexOf(firedId);
          if (ti >= 0) timers.splice(ti, 1);
        }
        if (mySeq !== seq || !alive) return;
        if (state !== STATES.DEGRADED) return;
        log('warn', 'CAM_DEGRADED', { seq: seq, reason: 'watch-timeout', attempt: attempt });
        releaseActive('degraded-timeout');
        setState(STATES.STARTING, 'degraded-timeout');
        reconnect('muted');
      }, cfg.degradedWatchMs);
      timers.push(degradedTimer);
    }

    function frameReady(el) {
      if (!el) return false;
      return el.readyState >= 2 && el.videoWidth > 0 && el.videoHeight > 0;
    }

    /* ---------- 打开流程 ---------- */

    function buildConstraints(deviceId) {
      var video = true;
      if (deviceId && !fallbackNoExact) video = { deviceId: { exact: deviceId } };
      return { video: video, audio: false };
    }

    async function applyMaxResolution(track) {
      if (!track || typeof track.getCapabilities !== 'function' || typeof track.applyConstraints !== 'function') return null;
      var cap = null;
      try { cap = track.getCapabilities(); } catch (e) { return null; }
      var maxW = cap && cap.width && cap.width.max;
      var maxH = cap && cap.height && cap.height.max;
      if (maxW && maxH) {
        try {
          // 部分 UVC 摄像头 applyConstraints 会永不 settle，必须加超时，超时则跳过提分辨率直接出画
          var acw = waitMs(cfg.applyConstraintMs);
          await Promise.race([
            track.applyConstraints({ width: { ideal: maxW }, height: { ideal: maxH } }),
            acw.promise
          ]);
          acw.cancel();
        } catch (e) {
          /* 部分摄像头不支持调整，保持当前分辨率 */
        }
      }
      try {
        var s = track.getSettings();
        resolution = { width: s.width || 0, height: s.height || 0 };
      } catch (e2) {
        resolution = null;
      }
      return resolution;
    }

    async function waitForFrame(el, mySeq) {
      var deadline = now() + cfg.frameWaitMs;
      while (true) {
        if (!alive || mySeq !== seq) return 'stale';
        if (frameReady(el)) return 'ok';
        if (now() >= deadline) return 'timeout';
        await waitMs(cfg.framePollMs).promise;
      }
    }

    // I6：attach 单一入口，失败即回收流并置 ERROR，绝不静默跳过
    async function attachStream(el, s, mySeq) {
      if (mySeq == null) mySeq = seq;
      if (!el) {
        abandon(s, 'ATTACH_FAIL', '取景区未就绪，无法挂载画面', 'CAM_ATTACH_FAIL', 'no-video-el', mySeq);
        return false;
      }
      try {
        el.srcObject = s;
      } catch (e) {
        abandon(s, 'ATTACH_FAIL', '取景区挂载失败：' + (e.message || e.name), 'CAM_ATTACH_FAIL', 'srcObject', mySeq);
        return false;
      }
      try {
        if (typeof el.play === 'function') {
          // P1-1：play() 永不 settle 时必须超时兜底，否则永久 STARTING 且无错误提示
          var atw = waitMs(cfg.attachTimeoutMs);
          await Promise.race([
            el.play(),
            atw.promise.then(function () { return Promise.reject(new Error('attach-timeout')); })
          ]);
          atw.cancel();
        }
      } catch (e2) {
        try { el.srcObject = null; } catch (e3) {}
        var isTimeout = e2 && e2.message === 'attach-timeout';
        abandon(s, isTimeout ? 'PLAY_TIMEOUT' : 'PLAY_FAIL', isTimeout ? '画面播放超时，摄像头可能未就绪或被占用' : '画面播放失败，摄像头可能已被其他程序占用', isTimeout ? 'CAM_PLAY_TIMEOUT' : 'CAM_PLAY_FAIL', isTimeout ? 'play-timeout' : 'play', mySeq);
        return false;
      }
      var r = await waitForFrame(el, mySeq);
      if (r !== 'ok') {
        try { el.srcObject = null; } catch (e4) {}
        abandon(s, 'NO_FRAME', r === 'stale' ? '画面已失效，正在重新打开摄像头' : '摄像头未输出画面，请检查设备连接', 'CAM_ATTACH_FAIL', r, mySeq);
        return false;
      }
      return true;
    }

    // 回收一条流并置 ERROR；若本次调用已被更新的取流取代（或组件已卸载），
    // 只回收流、不再覆盖状态，避免把刚发起的重连打回 ERROR
    function abandon(s, code, message, event, reason, mySeq) {
      if (stream === s) stream = null;
      var tracks = stopTracks(s);
      var stale = (mySeq != null && mySeq !== seq) || !alive;
      if (stale) {
        log('warn', event, { seq: seq, attempt: attempt, reason: reason, code: code, tracks: tracks, stale: true });
        return;
      }
      setState(STATES.ERROR, code);
      setError({ code: code, message: message, recoverable: true });
      log('error', event, { seq: seq, attempt: attempt, reason: reason, code: code, tracks: tracks });
    }

    function failOpen(res, mySeq) {
      setState(STATES.ERROR, res.code);
      setError({ code: res.code, message: res.message, recoverable: !!res.recoverable });
      log('error', 'CAM_GUM_FAIL', { seq: mySeq, attempt: attempt, code: res.code, err: res.err, fatal: true });
    }

    async function attemptOnce(mySeq, deviceId, att) {
      if (!md || typeof md.getUserMedia !== 'function') {
        return { code: 'UNSUPPORTED', fatal: true, recoverable: false, message: '当前环境不支持摄像头调用', err: { name: 'UnsupportedError', message: 'getUserMedia unavailable' } };
      }
      var constraints = buildConstraints(deviceId);
      var gum;
      try {
        gum = md.getUserMedia(constraints);
      } catch (e) {
        return classifyError(e);
      }
      // 泄漏兜底：本次调用被作废（卸载/休眠/换设备/超时）后到达的流，一律立即 stop
      var timedOut = false;
      gum.then(function (s) {
        if (timedOut || !alive || mySeq !== seq) stopStream(s, timedOut ? 'open-timeout' : 'stale', 'CAM_LEAK_GUARD');
      }, function () {});

      var guarded = gum.then(
        function (s) { return { ok: true, stream: s }; },
        function (e) { return { ok: false, err: e }; }
      );

      var timerId = null;
      var timeoutP = new Promise(function (resolve) {
        timerId = st(function () { resolve({ timeout: true }); }, cfg.openTimeoutMs);
        timers.push(timerId);
      });

      var raced = await Promise.race([guarded, timeoutP]);
      if (timerId != null) {
        try { ct(timerId); } catch (e) {}
        var ti = timers.indexOf(timerId);
        if (ti >= 0) timers.splice(ti, 1);
      }

      if (raced && raced.timeout) {
        timedOut = true;
        var to = { code: 'OPEN_TIMEOUT', fatal: false, recoverable: true, message: '摄像头打开超时，请检查是否被其他程序占用', err: { name: 'TimeoutError', message: 'getUserMedia timeout ' + cfg.openTimeoutMs + 'ms' } };
        log('error', 'CAM_GUM_FAIL', { seq: mySeq, attempt: att, code: to.code, err: to.err, reason: 'timeout' });
        return to;
      }

      if (!raced.ok) {
        var res = classifyError(raced.err);
        log('error', 'CAM_GUM_FAIL', { seq: mySeq, attempt: att, code: res.code, err: res.err, reason: 'gum' });
        return res;
      }

      var s = raced.stream;
      // RC-1a / RC-1b：gUM resolve 后第一件事就是校验「组件还活着」且「本次调用仍有效」
      if (!alive || mySeq !== seq) {
        stopStream(s, 'stale', 'CAM_LEAK_GUARD');
        return { cancelled: true };
      }
      if (!s || typeof s.getTracks !== 'function' || !trackList(s).length) {
        stopStream(s, 'no-track', 'CAM_GUM_FAIL');
        return { code: 'NO_TRACK', fatal: false, recoverable: true, message: '摄像头未返回视频轨道', err: { name: 'NoTrackError', message: 'no track' } };
      }

      stream = s;
      bindTracks(s, mySeq);
      log('info', 'CAM_GUM_OK', { seq: mySeq, device: shortDeviceId(deviceId), attempt: att, tracks: trackList(s).length });
      var track = activeTrack();
      await applyMaxResolution(track);

      var el = safeVideo();
      var attached = await attachStream(el, s, mySeq);
      if (!attached) return { handled: true };

      if (!alive || mySeq !== seq) {
        releaseActive('late');
        return { cancelled: true };
      }
      setState(STATES.LIVE, 'attached');
      log('info', 'CAM_LIVE', { seq: mySeq, device: shortDeviceId(deviceId), res: resField(), attempt: att, flap: flapCount });
      return true;
    }

    // 系统授权预检放在 STARTING 会话内部执行（而不是在 open() 前 await）：
    // 预检期间状态已是 STARTING，卸载 / 休眠 / 再开都能按令牌正常裁决，
    // 不会出现「预检返回后无视用户已休眠又把摄像头打开」这类倒灌
    async function attemptLoop(mySeq, deviceId) {
      try {
        if (attempt === 0) {
          var gate = await checkPermissionGate();
          if (!alive || mySeq !== seq) return false; // 预检期间已被卸载 / 取代 / 休眠
          if (gate) {
            setState(STATES.ERROR, gate.code);
            setError(gate);
            log('error', 'CAM_PERMISSION_CHECK', { seq: mySeq, reason: 'blocked', code: gate.code, fatal: true });
            return false;
          }
        }
      while (true) {
        if (!alive || mySeq !== seq) return false;
        attempt += 1;
        var r = await attemptOnce(mySeq, deviceId, attempt);
        if (r === true) {
          attempt = 0;
          fallbackNoExact = false;
          return true;
        }
        if (!r || r.cancelled || r.handled) return false;
        if (!alive || mySeq !== seq) return false;
        if (r.code === 'OVERCONSTRAINED' && !fallbackNoExact) {
          fallbackNoExact = true;
          log('warn', 'CAM_RETRY', { seq: mySeq, attempt: attempt, reason: 'overconstrained-fallback', delayMs: 0 });
          continue;
        }
        if (r.fatal || attempt >= cfg.maxAttempts) {
          failOpen(r, mySeq);
          return false;
        }
        var delay = cfg.backoffMs[Math.min(attempt - 1, cfg.backoffMs.length - 1)];
        log('warn', 'CAM_RETRY', { seq: mySeq, attempt: attempt, reason: r.code, delayMs: delay });
        await waitMs(delay).promise;
        if (!alive || mySeq !== seq) return false;
      }
      } catch (e) {
        // P3-4：意外异常不得变成 unhandled rejection 并卡在 STARTING
        if (alive && mySeq === seq) {
          setState(STATES.ERROR, 'UNKNOWN');
          setError({ code: 'UNKNOWN', message: '打开摄像头时发生意外错误：' + ((e && e.message) || e), recoverable: true });
        }
        log('error', 'CAM_GUM_FAIL', { seq: mySeq, attempt: attempt, code: 'UNKNOWN', err: { name: (e && e.name) || 'Error', message: (e && e.message) || String(e) }, reason: 'unexpected' });
        return false;
      }
    }

    function runOpen(deviceId) {
      seq += 1;
      var mySeq = seq;
      // 新会话开始前，先回收任何残留的活跃流（保证 I1）
      releaseActive('supersede');
      clearTimers();
      setError(null);
      setState(STATES.STARTING, 'open');
      log('info', 'CAM_START_BEGIN', { seq: mySeq, device: shortDeviceId(deviceId), attempt: attempt + 1 });
      var p = attemptLoop(mySeq, deviceId).then(function (ok) {
        if (openPromise === p) openPromise = null;
        return ok;
      });
      openPromise = p;
      return p;
    }

    // ---------- R10：系统级授权预检 ----------
    // 仅 denied / restricted 直接判 ERROR 并给出「去系统设置开启」引导；
    // granted / not-determined / unknown / 接口失败 / ok:false 一律放行正常取流
    var ACCESS_BLOCK = { denied: 1, restricted: 1 };

    function statusOf(res) {
      if (typeof res === 'string') return res;
      if (!res || typeof res !== 'object') return null;
      if (res.data && res.data.status) return res.data.status;
      if (res.status) return res.status;
      return null;
    }

    async function checkPermissionGate() {
      if (!checkAccess) return null;
      var res = null;
      try {
        // P2-1：预检 IPC 挂起时超时放行，不得让界面永久停在「准备中」
        var agw = waitMs(cfg.accessGateMs);
        res = await Promise.race([checkAccess(), agw.promise]);
        agw.cancel();
      } catch (e) {
        return null; // 接口异常不得阻断取流
      }
      if (res === false) return null; // 超时放行（waitMs 返回 false 表示被 clearTimers 打断）
      var status = statusOf(res);
      log('info', 'CAM_PERMISSION_CHECK', { seq: seq, reason: status || 'unknown' });
      if (!status) return null;
      if (!ACCESS_BLOCK[String(status).toLowerCase()]) return null;
      return {
        code: 'PERMISSION_DENIED',
        message: '系统未授予摄像头权限，请到系统设置中开启后重试',
        recoverable: true,
        privacy: true // 渲染层据此显示「去系统设置开启摄像头」按钮
      };
    }

    // 打开系统摄像头隐私设置；平台不支持 / 接口缺失时返回 false，由渲染层降级为文案引导
    function openPrivacySettings() {
      var fn = openPrivacy;
      if (!fn && typeof window !== 'undefined' && window.api && typeof window.api.openCameraPrivacy === 'function') {
        fn = function () { return window.api.openCameraPrivacy(); };
      }
      if (!fn) return Promise.resolve(false);
      return Promise.resolve()
        .then(function () { return fn(); })
        .then(function (r) { return !!(r && r.ok); })
        .catch(function () { return false; });
    }

    function open(deviceId) {
      if (!alive) return Promise.resolve(false);
      var nextId = typeof deviceId === 'string' ? deviceId : preferredId;
      var sameId = nextId === preferredId;
      // 幂等：STARTING 中重复调用（同一设备）直接复用同一次取流
      if (state === STATES.STARTING && openPromise && sameId) return openPromise;
      preferredId = nextId;
      if (!sameId) fallbackNoExact = false;
      attempt = 0;
      fallbackNoExact = false;
      // 人工发起的打开（挂载 / 重试 / 换设备 / 唤醒）视为新一轮，闪断计数归零
      flapCount = 0;
      lastLiveAt = 0;
      return runOpen(nextId);
    }

    function reconnect(reason) {
      if (!alive) return Promise.resolve(false);
      // 判定「是否已有在途取流」只看 openPromise：releaseActive() 会把它清空，
      // 若改用 state === STARTING 判断，重连会被自己刚设置的 STARTING 挡掉，永久卡住
      if (openPromise) return openPromise;
      // 闪断闸门：先按「距上次出画多久」累计连续闪断次数，再决定要不要继续自动重连
      var flaps = noteFlap();
      log('warn', 'CAM_RETRY', { seq: seq, attempt: attempt, reason: reason, flap: flaps });
      if (flaps > cfg.flapMax) {
        // 反复闪断：停止自动重连，转 ERROR 并提示人工点「重试」，避免重连风暴
        setState(STATES.ERROR, 'FLAP_STORM');
        setError({
          code: 'FLAP_STORM',
          message: '摄像头反复中断（' + flaps + ' 次），已停止自动重连，请检查连接后点「重试」',
          recoverable: true
        });
        log('error', 'CAM_GUM_FAIL', { seq: seq, attempt: attempt, reason: reason, code: 'FLAP_STORM', flap: flaps, fatal: true });
        return Promise.resolve(false);
      }
      if (attempt >= cfg.maxAttempts) {
        setState(STATES.ERROR, 'RETRY_EXHAUSTED');
        setError({ code: 'RETRY_EXHAUSTED', message: '摄像头信号中断且自动重连未成功，请检查连接后点「重试」', recoverable: true });
        log('error', 'CAM_GUM_FAIL', { seq: seq, attempt: attempt, reason: reason, code: 'RETRY_EXHAUSTED', fatal: true });
        return Promise.resolve(false);
      }
      return runOpen(preferredId);
    }

    /* ---------- 对外 API ---------- */

    function mount(getter) {
      if (typeof getter === 'function') videoGetter = getter;
      alive = true;
      attempt = 0;
      fallbackNoExact = false;
      setError(null);
      setState(STATES.UNINIT, 'mount');
      bindDeviceChange();
      log('info', 'CAM_MOUNT', { seq: seq, device: shortDeviceId(preferredId) });
      // P3-4：mount 发起的打开流程必须被 catch，意外异常不能变 unhandled rejection
      return open(preferredId).catch(function (e) {
        if (alive) {
          setState(STATES.ERROR, 'UNKNOWN');
          setError({ code: 'UNKNOWN', message: '打开摄像头时发生意外错误：' + ((e && e.message) || e), recoverable: true });
        }
        log('error', 'CAM_GUM_FAIL', { seq: seq, attempt: attempt, code: 'UNKNOWN', err: { name: (e && e.name) || 'Error', message: (e && e.message) || String(e) }, reason: 'mount-unexpected' });
        return false;
      });
    }

    // I7：返回后不存在任何 live track，也不存在在途待认领的流（迟到的 gUM 结果会被 stop）
    function unmount() {
      var before = state;
      log('info', 'CAM_UNMOUNT', { seq: seq, state: before, attempt: attempt });
      alive = false;
      seq += 1; // 作废所有在途 gUM
      clearTimers();
      unbindDeviceChange();
      releaseActive('unmount');
      openPromise = null;
      setState(STATES.UNINIT, 'unmount');
      setError(null);
      // 注意：不在 unmount 清空 listeners —— 订阅者（渲染层）自行通过 on() 返回的
      // 反订阅函数管理生命周期；控制器清空会导致「复用同一 controller 做
      // mount/unmount/mount」时界面状态永久停在旧值（G 类缺陷）。
      return true;
    }

    function sleep(reason) {
      if (!alive) return false;
      if (state === STATES.SLEEPING) return true;
      if (state === STATES.UNINIT) return false;
      var why = reason || 'manual';
      seq += 1; // 作废在途 gUM：休眠期间到达的流必须被 CAM_LEAK_GUARD stop
      clearTimers();
      releaseActive('sleep:' + why);
      setState(STATES.SLEEPING, why);
      log('info', 'CAM_SLEEP', { seq: seq, reason: why, attempt: attempt });
      return true;
    }

    function wake() {
      if (!alive) return Promise.resolve(false);
      if (state === STATES.STARTING) return openPromise || Promise.resolve(false);
      if (state === STATES.LIVE) return Promise.resolve(true);
      attempt = 0;
      fallbackNoExact = false;
      log('info', 'CAM_WAKE', { seq: seq, state: state, device: shortDeviceId(preferredId) });
      return open(preferredId);
    }

    function degrade(reason) {
      if (state !== STATES.LIVE) return false;
      setState(STATES.DEGRADED, reason);
      log('warn', 'CAM_DEGRADED', { seq: seq, reason: reason });
      startDegradedWatch(seq);
      return true;
    }

    // I5：仅 LIVE 允许拍照；LIVE 下还要复核 track 与画面，否则降级
    function canCapture() {
      if (!alive || state !== STATES.LIVE) return false;
      var el = safeVideo();
      if (!frameReady(el)) {
        degrade('frame-not-ready');
        return false;
      }
      var t = activeTrack();
      if (!t || t.readyState !== 'live' || t.muted) {
        degrade('track-not-live');
        return false;
      }
      return true;
    }

    function isBlackFrame(el) {
      var enabled = true;
      try { enabled = blackFrameEnabled() !== false; } catch (e) { enabled = true; }
      if (!enabled || !frameSampler) return false;
      var target = el || safeVideo();
      if (!target) return false;
      var samples = null;
      try { samples = frameSampler(target, cfg.sampleSize); } catch (e) { samples = null; }
      if (!samples || !samples.length) return false;
      var r = analyzeGraySamples(samples, { mean: cfg.blackMean, variance: cfg.blackVariance });
      if (r.black) {
        log('warn', 'CAM_CAPTURE_REJECT', { seq: seq, reason: 'black-frame', mean: Math.round(r.mean * 100) / 100, variance: Math.round(r.variance * 100) / 100 });
      }
      return r.black;
    }

    function snapshot() {
      return {
        state: state,
        error: error,
        seq: seq,
        attempt: attempt,
        hasStream: !!stream,
        // 现场复盘用：连续闪断次数与上次出画时刻（闪断闸门的两个输入）
        flapCount: flapCount,
        lastLiveAt: lastLiveAt,
        liveTracks: stream ? trackList(stream).filter(function (t) { return t.readyState === 'live'; }).length : 0,
        resolution: resolution,
        preferredId: preferredId,
        alive: alive,
        trackBinds: trackBinds.length
      };
    }

    var api = {
      STATES: STATES,
      DEFAULTS: DEFAULTS,
      // 生命周期
      mount: mount,
      unmount: unmount,
      open: open,
      sleep: sleep,
      wake: wake,
      // 闸门与检测
      canCapture: canCapture,
      isBlackFrame: isBlackFrame,
      openPrivacySettings: openPrivacySettings,
      // 供单测/渲染层读取
      getState: function () { return state; },
      getError: function () { return error; },
      getStream: function () { return stream; },
      getTrack: function () { return activeTrack(); },
      getResolution: function () { return resolution; },
      getSeq: function () { return seq; },
      getAttempt: function () { return attempt; },
      snapshot: snapshot,
      // 单入口（暴露出来便于断言 I1/I6）
      releaseActive: releaseActive,
      attachStream: attachStream,
      // 事件订阅
      onStateChange: function (cb) { return on('state', cb); },
      onError: function (cb) { return on('error', cb); },
      onDevicesChange: function (cb) { return on('devices', cb); }
    };

    Object.defineProperty(api, 'state', { get: function () { return state; } });
    Object.defineProperty(api, 'error', { get: function () { return error; } });

    return api;
  }

  return {
    STATES: STATES,
    DEFAULTS: DEFAULTS,
    createCameraController: createCameraController,
    create: createCameraController,
    analyzeGraySamples: analyzeGraySamples,
    sampleCenterGray: sampleCenterGray,
    classifyError: classifyError
  };
});
