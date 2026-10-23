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
    // 黑帧复采：单次采样会把「对焦脉冲 / 自动曝光 / 分辨率重协商」造成的**瞬时**黑帧
    // 误判成镜头被遮挡而拒拍（现场表现：预览看着正常，却间歇性提示「画面全黑、拍不了」）。
    // 命中黑帧后在 blackRetryMs 总预算内按 blackSampleGapMs 复采，只有持续全黑才真的拒收。
    blackRetryMs: 900,
    blackSampleGapMs: 120,
    // 拍照闸门瞬时未通过时的复检间隔：track 短暂 mute 在对焦脉冲期间很常见，
    // 不该一次未通过就直接把拍照判死
    captureGateRetryMs: 260,
    // 悬挂兜底：play() / applyConstraints 部分 UVC 摄像头会永不 settle，
    // 若不加超时，控制器会卡在 STARTING 且无错误提示（与「黑屏只能重开」同族症状）
    attachTimeoutMs: 2000,
    applyConstraintMs: 1000,
    accessGateMs: 1000,
    // 分辨率锁定：逐档探测的总预算。部分 UVC 摄像头每档 applyConstraints 都要等满
    // applyConstraintMs 才超时，不加总预算会把「出画」拖成十几秒（现场表现为黑屏）
    resBudgetMs: 2500,
    // 阶梯最大档位数 / 最高档的帧率备选数（防止候选集无限膨胀）
    resMaxRungs: 16,
    resMaxFps: 3,

    // ===== 曝光辅助：黑色衣物过曝防护（设计文档 docs/exposure-assist-design.md）=====
    // 所有曝光 applyConstraints 只带 advanced 曝光键，绝不夹带 width/height/frameRate
    // （夹带一次就可能破坏分辨率锁定，项目纪律红线）
    expGridSize: 64,             // 整帧降采样边长（64×64 像素统计，开销可忽略）
    expGridCells: 8,             // 网格划分数：8×8=64 格
    expSubjectMeanMax: 185,      // 主体格亮度上限：比垫板暗即候选
    expSubjectSatMax: 0.28,      // 主体格饱和度上限：低饱和=灰黑系；
    //   深蓝/深棕/深绿衣物饱和度高，不触发（它们不过曝成灰白）
    expHiMeanMin: 185,           // 高亮格亮度下限：亮垫板/亮背景参照
    expSubjectAreaMin: 0.08,     // 主体面积下限：零星暗物（电线/阴影）不触发
    expSubjectAreaMax: 0.75,     // 主体面积上限：超过视为整体昏暗场景，不触发
    expHiAreaMin: 0.06,          // 高亮面积下限：没有亮参照就无法区分
    //   「AE 提亮黑衣物」与「场景本来就暗」
    expCenterSubjectMin: 0.15,   // 中心区域主体下限：衣物在台垫中央，
    //   顺带排除画面边缘暗物（电线/桌沿阴影）
    expSceneMeanMin: 45,         // 场景均值下限：低于此=昏暗/遮挡/黑信号，
    //   那是黑帧检测的职责，不触发
    expEngageHits: 3,            // 滞回 engage：连续 3 帧命中（≈750ms）
    expReleaseMisses: 10,        // 滞回 release：连续 10 帧未命中（≈2.5s）
    expMinHoldMs: 1500,          // engage 后最短保持：衣物半出画不急着恢复
    expReEngageCooldownMs: 3000, // release 后冷却：防反复横跳
    expCycleMs: 250,             // 检测周期
    expEngageDelayMs: 800,       // LIVE 后启动延迟：避开分辨率探测/首帧 AE 窗口
    expTargetMean: 58,           // 闭环目标：主体平均亮度（黑而有纹理）
    expDeadzone: 8,              // 死区：AE 自身波动 ±几格很正常，不动
    expEvGain: 0.025,            // 步长增益：误差×0.025=步长(EV)
    expMaxStepEv: 0.34,          // 单步上限 1/3 档：小步逼近防画面跳变
    // 累计下限。勘误 2026-10：原为 -2.0。现场（黑白相间鞋、白色鞋底过曝裁剪）
    // ev 从 0 压到 -2.0 全程 subjectMean 仍在 155~182，闭环贴住下限空转永远不达标。
    // -2.0 对应亮度只剩 1/4，而实测只掉了 1/5 不到——说明这点余量对极黑衣物 + 强环境光
    // 根本不够（设计文档 §10 待明确事项 6 的现场结论）。加深到 -3.0 后闭环才有机会
    // 收敛到 expTargetMean。注意：实际下发仍被设备 cap.exposureCompensation.min 二次钳位
    expEvMin: -3.0,
    expStepGapMs: 500,           // 两次曝光 applyConstraints 最小间隔
    expSettleMs: 400,            // 单次调整后稳定等待：拿过渡值算步长会过冲
    expApplyTimeoutMs: 1000,     // 曝光 applyConstraints 超时竞速（UVC 悬挂兜底）
    expApplyFailLimit: 2,        // 连续失败这么多次：停硬件路径、降级软件兜底
    expBlackFloor: 4             // 黑帧门控兜底：ACTIVE 时场景均值 <4 仍拒拍
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

  /* ---------- 曝光辅助：纯计算（可单测，不碰 DOM / MediaStreamTrack） ----------
   * 黑色衣物过曝防护的「判定与数学」全部落在这里：渲染层只负责把整帧降采样成
   * ImageData，编排层只负责拿结果去发约束。这样 CI 无摄像头环境也能覆盖绝大部分逻辑。
   * 设计文档：docs/exposure-assist-design.md §6 / §7
   */

  // 网格降采样统计：整帧按 grid×grid 切格，每格算 { mean, sat, clip }
  // 为什么整帧统计而不是继续用中心 64×64：黑色衣物检测要回答的是
  // 「画面里暗主体占多大、有没有亮背景参照」，这是全局问题，中心采样回答不了
  function computeGridStats(image, grid) {
    var g = Math.max(1, grid || DEFAULTS.expGridCells);
    var w = image && image.width ? image.width : 0;
    var h = image && image.height ? image.height : 0;
    var data = image && image.data;
    if (!w || !h || !data) return null;
    var cw = Math.max(1, Math.floor(w / g));
    var ch = Math.max(1, Math.floor(h / g));
    var cells = new Array(g * g);
    for (var cy = 0; cy < g; cy++) {
      for (var cx = 0; cx < g; cx++) {
        var sum = 0;
        var satSum = 0;
        var clip = 0;
        var n = 0;
        var y1 = cy * ch;
        var x1 = cx * cw;
        for (var y = 0; y < ch; y++) {
          var row = (y1 + y) * w;
          for (var x = 0; x < cw; x++) {
            var i = (row + x1 + x) * 4;
            var r = data[i];
            var gg = data[i + 1];
            var b = data[i + 2];
            var mx = Math.max(r, gg, b);
            var mn = Math.min(r, gg, b);
            var luma = (r * 299 + gg * 587 + b * 114) / 1000;
            sum += luma;
            // 饱和度 (max-min)/max；纯黑像素（max=0）定义为 0，避免除零
            satSum += mx > 0 ? (mx - mn) / mx : 0;
            if (luma > 250) clip++;
            n++;
          }
        }
        cells[cy * g + cx] = n
          ? { mean: sum / n, sat: satSum / n, clip: clip / n }
          : { mean: 0, sat: 0, clip: 0 };
      }
    }
    return cells;
  }

  // 场景判定：是否命中「黑色衣物过曝」场景。四类相邻暗场景的区分见设计文档 §6.1
  function classifyExposureGrid(cells, th, opts) {
    // 缺省阈值取 DEFAULTS：单测可以直接传 { expXxx: ... } 只覆盖关心的几项
    var t = Object.assign({}, DEFAULTS, th || {});
    var grid = t.expGridCells;
    // 曝光还原（缺陷 1）：ACTIVE 且「实测实际生效 EV」(actualEv) < 0 时，参与「判定闸门」
    // 的亮度要按曝光偏移还原回中性刻度，否则压暗整帧会把亮垫板压到 expHiMeanMin 以下、
    // 甚至跌到 expSubjectMeanMax 以下混入主体计数 → 闸门自杀 → 闭环反复 RESTORE/ENGAGE
    // 振荡（用户看到的循环跳亮）。
    // 物理：设备压暗整帧，实测 c.mean = 中性亮度 × 2^(actualEv/gamma)。还原即乘 2^(-actualEv/gamma)。
    // 还原口径必须覆盖全部四道闸（亮参照格 / 场景均值 / 主体格 / 中心主体），理由：
    //   · 亮参照格（垫板）中性≈185，压暗后极易跌破 → 不还原则 hiRatio 塌陷、no-bright-reference。
    //   · 主体格：黑衣物中性=150 本就 ≤185，但整帧压暗后亮垫板会跌到 ≤185 而被误判成主体 →
    //     subjectRatio 飙到 1.0、subject-too-large 自杀。用还原亮度判主体可让垫板还原回 210
    //     （>185，不算主体）、黑衣物还原回 150（≤185，仍算主体）。
    //   · 还原系数取「实测实际生效 EV」而非「请求 EV」：帧不随补偿变暗的静态/幽灵设备
    //     actualEv≈0 → 系数≈1 → 主体按原始亮度判，与旧实现完全一致、不漂移、不误判失格。
    //   · ev=0（未介入 / actualEv=0）时系数为 1，所有量与原实现完全一致。
    var ev = opts && typeof opts.ev === 'number' ? opts.ev : 0;
    var gamma = (opts && opts.gamma) ? opts.gamma : SRGB_GAMMA;
    if (!(gamma > 0)) gamma = SRGB_GAMMA;
    // 曝光还原（缺陷 1）：设备压暗的是「整帧」，实测 c.mean = 中性亮度 × 2^(actualEv/gamma)。
    // 闸门的还原不是按某个 EV 值乘系数，而是按「当前整帧相对 engage 时中性帧的实测压暗系数 f」
    // 还原回中性刻度（f = 当前场景均值 / 中性场景均值，整帧均匀缩放 → 该比值恰为 f）。
    // 还原口径覆盖全部四道闸（亮参照格 / 场景均值 / 主体格 / 中心主体）：
    //   · 亮参照格（垫板）中性≈185，压暗后极易跌破 → 不还原则 hiRatio 塌陷、no-bright-reference。
    //   · 主体格：黑衣物中性=150 本就 ≤185，但整帧压暗后亮垫板会跌到 ≤185 而被误判成主体 →
    //     subjectRatio 飙到 1.0、subject-too-large 自杀。用还原亮度判主体可让垫板还原回 210
    //     （>185，不算主体）、黑衣物还原回 150（≤185，仍算主体）。
    // 用「场景均值之比」而非「请求 EV / 实测 EV」的好处：
    //   · 无帧滞后——比值来自当前这一帧；过压设备若把帧压得更狠，比值天然含这份额外压暗，
    //     还原仍精确（用请求 EV 还原会欠还原，垫板仍跌破 185 → subject-too-large）。
    //   · 对帧不随补偿变暗的静态 / 幽灵设备，f≈1 → 还原系数≈1 → 主体按原始亮度判，与旧实现
    //     完全一致、不漂移到 185 以上误判失格。
    //   · ev=0（未介入 / 无中性参照）→ 还原系数=1，所有量与原实现完全一致。
    var refMean = (opts && typeof opts.refMean === 'number' && opts.refMean > 0) ? opts.refMean : 0;
    var n = cells && cells.length ? cells.length : 0;
    if (!n) {
      return {
        hit: false, reason: 'no-cells', subjectRatio: 0, hiRatio: 0,
        centerSubjectRatio: 0, sceneMean: null, subjectMean: null, clipRatio: 0, cells: 0
      };
    }
    // 先算「原始（未还原）场景均值」：整帧均匀缩放 → 当前场景均值 / 中性场景均值 = f。
    var rawSceneSum = 0;
    for (var k0 = 0; k0 < n; k0++) rawSceneSum += cells[k0].mean;
    var rawSceneMean = rawSceneSum / n;
    var restoreFactor = (refMean > 0 && rawSceneMean > 0) ? refMean / rawSceneMean : 1;
    var subject = 0;
    var hi = 0;
    var centerSubject = 0;
    var centerTotal = 0;
    var sum = 0;        // 还原后的场景均值（用于闸门判定，≈ 中性场景均值）
    var subjSum = 0;    // 原始主体均值（闭环反馈，不参与还原）
    var clipSum = 0;
    // 中心区域 = 网格中央一半（g/4 ~ 3g/4）
    var lo = Math.floor(grid / 4);
    var hiEdge = Math.ceil((grid * 3) / 4);
    for (var i = 0; i < n; i++) {
      var c = cells[i];
      var cx = i % grid;
      var cy = Math.floor(i / grid);
      var adjMean = c.mean * restoreFactor;   // 四道闸共用同一还原亮度（亮参照格/场景均值/主体格/中心主体）
      // 主体格判据用「还原后亮度」(adjMean)，与亮参照格 / 场景均值同一口径：
      // 整帧压暗时亮垫板被还原回 210（>185，不算主体 → 否则 subject-too-large 自杀），
      // 黑衣物被还原回 150（≤185，仍算主体）。饱和判据仍用原始 c.sat（亮度缩放不改色相）。
      var isSubject = adjMean <= t.expSubjectMeanMax && c.sat < t.expSubjectSatMax;
      if (isSubject) { subject++; subjSum += c.mean; }   // subjSum 仍用原始亮度，供闭环反馈
      if (adjMean > t.expHiMeanMin) hi++;
      sum += adjMean;
      clipSum += c.clip;
      if (cx >= lo && cx < hiEdge && cy >= lo && cy < hiEdge) {
        centerTotal++;
        if (isSubject) centerSubject++;
      }
    }
    var out = {
      hit: false,
      reason: 'normal',
      subjectRatio: subject / n,
      hiRatio: hi / n,
      centerSubjectRatio: centerTotal ? centerSubject / centerTotal : 0,
      sceneMean: sum / n,
      subjectMean: subject ? subjSum / subject : null,
      clipRatio: clipSum / n,
      cells: n
    };
    // 按序短路：每一道都对应一类必须排除的场景（设计文档 §6.1 场景表）
    if (out.sceneMean < t.expSceneMeanMin) { out.reason = 'overall-dark-or-blocked'; return out; }
    if (out.hiRatio < t.expHiAreaMin) { out.reason = 'no-bright-reference'; return out; }
    if (out.subjectRatio < t.expSubjectAreaMin) { out.reason = 'subject-too-small'; return out; }
    if (out.subjectRatio > t.expSubjectAreaMax) { out.reason = 'subject-too-large'; return out; }
    if (out.centerSubjectRatio < t.expCenterSubjectMin) { out.reason = 'subject-off-center'; return out; }
    out.hit = true;
    out.reason = 'black-garment';
    return out;
  }

  // 滞回状态机：engage 要连续 expEngageHits 帧命中，release 要连续
  // expReleaseMisses 帧未命中且满足最短保持/冷却。单帧抖动不改状态，
  // 否则补偿会跟着画面闪烁反复横跳（那比过曝本身更扰人）
  function stepAssistHysteresis(st, hit, nowMs, cfg) {
    var c = Object.assign({}, DEFAULTS, cfg || {});
    // engagedAt / releasedAt 必须原样带下去：只在「不改状态」的分支里复制
    // state/hit/miss 会把这两个时间戳丢掉，最短保持与冷却闸门就永久失效
    // （engagedAt 变 undefined → nowMs - 0 恒大于阈值）
    var s = {
      state: st.state,
      hit: st.hit,
      miss: st.miss,
      engagedAt: st.engagedAt || 0,
      releasedAt: st.releasedAt || 0
    };
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

  // EV 闭环步长：按实测主体亮度与目标的误差算下一步补偿（比例控制）
  //   err  = subjectMean - expTargetMean   （正=还太亮）
  //   step = clamp(err × expEvGain, ±expMaxStepEv)   （正=要压暗，EV 往下走）
  //   ev   = clamp(ev - step, expEvMin, 0)
  // 死区内不动：AE 自身波动 ±几格就微调会让日志爆炸、画面有呼吸感
  function nextEvStep(curEv, subjectMean, cfg) {
    var c = Object.assign({}, DEFAULTS, cfg || {});
    if (subjectMean == null || !isFinite(subjectMean)) return { ev: curEv, step: 0, err: 0 };
    var err = subjectMean - c.expTargetMean;
    if (Math.abs(err) < c.expDeadzone) return { ev: curEv, step: 0, err: err };
    var step = err * c.expEvGain;
    if (step > c.expMaxStepEv) step = c.expMaxStepEv;
    if (step < -c.expMaxStepEv) step = -c.expMaxStepEv;
    var next = curEv - step;
    if (next < c.expEvMin) next = c.expEvMin; // 下限保护：再暗就逼近黑帧闸门
    if (next > 0) next = 0;                   // 上限锁 0：本方案只解决过曝，不做正补偿
    return { ev: next, step: next - curEv, err: err };
  }

  // sRGB 编码指数（IEC 61966-2-1 的 2.2 幂次近似）：线性光 ×2^ev ↔ 8bit 码值 ×2^(ev/gamma)。
  // 全模块只有这一处定义，§7.5 的预期降幅与 §7.3 的软件兜底 LUT 必须同源 —— 两套
  // 「EV 的定义」曾经同时存在（判定照 sRGB 模型、兜底照幂次曲线），后果是
  // 「判定说该降 27%」与「兜底实际压掉 96%」同时成立（QA DEF-1）
  var SRGB_GAMMA = 2.2;

  /* ---------- 曝光有效性判定（设计文档 §7.5）：幽灵能力检测 ----------
   * 现场 2026-10-22：某设备 getCapabilities() 报告 exposureCompensation 有 min/max、
   * applyConstraints() 也不报错，但 ev 从 0 压到 -2.0 期间主体亮度只在 155~182 噪声
   * 波动——约束「发出去了」，画面却一点没变。闭环因此永远不达标，只能贴着 expEvMin 空转。
   * 这类「幽灵能力」没有任何 API 能提前识别，唯一的判据是**实测**：发了补偿，亮度有没有
   * 按预期方向降。tier2 的 exposureTime 同样可能是幽灵能力（UVC 什么都敢报），所以这套
   * 判定对 tier1/tier2 通用；tier0 不发约束、只改存档图，不适用。
   */

  // 判定参数。**刻意不进 DEFAULTS**：DEFAULTS 的 exp* 项与设计文档 §6.2 阈值表一一对应
  // （QA 按 26 项对拍），新增判定参数另立一表，由 effectCfgOf() 从控制器 cfg 里
  // 按 expEffect* 名覆盖（单测可注入，现场默认取这里的值）
  var EXP_EFFECT = {
    windowMs: 2000,  // 收敛窗口：engage / 换档后先等这么久再判。刚下发模式切换时
    //   AE 与驱动都在重收敛，此时的亮度变化不能用来判设备能力（防误伤）
    minSteps: 3,     // 至少下发过这么多次补偿步才判（前两步还混着 AE 收敛）
    minEv: 1.0,      // 累计补偿至少这么深才判：比这更浅的补偿在 8bit 上只对应几个
    //   百分点的亮度变化，会被 AE 抖动和衣物微动淹没
    gamma: SRGB_GAMMA, // 8bit 灰度是 sRGB 编码：线性光 ×2^ev → 码值 ×2^(ev/gamma)
    ratio: 0.5,      // 实测降幅 ≥ 预期降幅 × 该系数才算有效。留一倍余量吸收 AE 回弹
    hits: 2          // 连续这么多次「无响应」才判无效。单帧不判：AE 收敛、衣物微动
    //   都会让单帧亮度偏高，一次误判就会把好设备降成软件兜底
  };

  // 幽灵记忆的**记账门槛**（QA DEF-5，方案①）：同一设备、同一档位被实测判无效累计到
  // 这个次数，才把「本设备这条路径无效」记进会话记忆。
  // 为什么不是 1 次：环境光漂移（QA U4b 实测边界：持续变亮 ≥6 码值/秒）会让好设备被
  // 误判；单次记账就把「一件衣物的误伤」放大成「整会话不可恢复地失去硬件补偿」，
  // 而本模块全部设计原则就是「自动恢复」。付一件衣物约 4.3s 的探测窗口是**有界、自愈、
  // 用户几乎无感**的代价 —— 风险不对称，所以选 2 而不是 1。
  // 注意：调回 1 会让变异体 M42（记账门槛被放宽）失去判别力。
  var EXP_GHOST = { minStrikes: 2 };

  // 过压设备（缺陷 2）：tier2 手动曝光路径，设备实际执行时间比请求的更短（时间下限 /
  // 量化 / 单位解释都可能），导致实际压暗深度超过请求。闭环假设「请求 ev = 实际 ev」线性
  // 1:1，看到过暗就往回加 ev → bang-bang 振荡，用户看到过暗且循环跳变。每步用实测主体
  // 亮度反推实际生效 EV，与请求比对，超过容差即记过压设备，并把闭环 ev 下限收紧到
  // 「实测可达深度」，不再往更深处请求（更深只会被设备再压更深）。
  var EXP_OVERPRESS = {
    tol: 0.5,   // 实际比请求深超过 0.5EV 才判（吸收 AE 抖动 / 衣物微动）
    hits: 2     // 连续 2 次确认，避免单次噪声误判
  };

  function numOr(v, dflt) {
    var n = Number(v);
    return isFinite(n) ? n : dflt;
  }

  // 把控制器 cfg 里的 expEffect* 覆盖项并进判定参数表（未覆盖的取 EXP_EFFECT 默认）
  function effectCfgOf(cfg) {
    var c = cfg || {};
    return {
      windowMs: Math.max(0, numOr(c.expEffectWindowMs, EXP_EFFECT.windowMs)),
      minSteps: Math.max(1, Math.round(numOr(c.expEffectMinSteps, EXP_EFFECT.minSteps))),
      minEv: Math.max(0, numOr(c.expEffectMinEv, EXP_EFFECT.minEv)),
      gamma: numOr(c.expEffectGamma, EXP_EFFECT.gamma) || EXP_EFFECT.gamma,
      ratio: numOr(c.expEffectRatio, EXP_EFFECT.ratio),
      hits: Math.max(1, Math.round(numOr(c.expEffectHits, EXP_EFFECT.hits)))
    };
  }

  // 预期亮度降幅：线性光 ×2^ev → 8bit 码值 ×2^(ev/gamma)。ev=-1 → 码值 ×0.73（降 27%）
  function expectedDropRatio(ev, gamma) {
    var g = numOr(gamma, EXP_EFFECT.gamma);
    if (!(g > 0)) g = EXP_EFFECT.gamma;
    var v = ev < 0 ? ev : 0; // 本方案不做正补偿，正 EV 不产生降幅预期
    return 1 - Math.pow(2, v / g);
  }

  /**
   * 曝光有效性判定（纯函数，Node 可单测）：这台设备的曝光能力是不是幽灵能力。
   *
   * @param {object} obs { baseline:number, samples:Array<{ev:number,mean:number,t:number,pinned?:boolean}>,
   *                        startedAt:number }
   *   baseline  本档位开始时的主体亮度（判定的参照点）
   *   samples   每次下发补偿后测到的稳态主体亮度（ev 为**实际下发**的值）
   *   startedAt 本档位开始时刻（收敛窗口闸门的起点）
   * @param {object} [cfg] 可含 expEffect* 覆盖项
   * @returns {{verdict:string, reason:string, dropRatio:?number, needDrop:?number,
   *            expectedDrop:?number, streak:number, candidates:number}}
   *   verdict: 'effective'（确实在压暗） / 'ineffective'（幽灵能力） / 'pending'（证据不足）
   */
  function judgeExposureEffect(obs, cfg) {
    var e = effectCfgOf(cfg);
    var o = obs || {};
    var out = {
      verdict: 'pending', reason: 'no-baseline', dropRatio: null, needDrop: null,
      expectedDrop: null, streak: 0, candidates: 0
    };
    var baseline = Number(o.baseline);
    if (!isFinite(baseline) || baseline <= 0) return out;
    var samples = o.samples || [];
    var startedAt = Number(o.startedAt);
    if (!isFinite(startedAt)) startedAt = null;
    var streak = 0;
    var considered = 0;
    var last = null;
    for (var i = 0; i < samples.length; i++) {
      var s = samples[i];
      if (!s) continue;
      var mean = Number(s.mean);
      var ev = Number(s.ev);
      if (!isFinite(mean) || !isFinite(ev)) continue;
      // ① 步数门槛：前两步测的还混着 AE 收敛，没有判别力
      if (i < e.minSteps - 1) continue;
      // ② 深度门槛：补偿太浅时预期降幅落在噪声里。例外是「已经压不动了」
      //    （pinned：贴住 EV 下限或设备把值钳死），那正是现场空转的形态，必须判
      if (Math.abs(ev) < e.minEv && !s.pinned) continue;
      // ③ 收敛窗口：刚 engage / 刚换档时 AE 与驱动都在重收敛，此时判会误伤好设备
      if (startedAt != null && isFinite(Number(s.t)) && Number(s.t) - startedAt < e.windowMs) continue;
      considered++;
      var expected = expectedDropRatio(ev, e.gamma);
      var need = expected * e.ratio;
      var drop = (baseline - mean) / baseline;
      last = { dropRatio: drop, needDrop: need, expectedDrop: expected };
      // 滞回：连续 e.hits 次不达标才算无效，任何一次达标即清零（防单帧噪声误伤）
      if (drop < need) streak++; else streak = 0;
    }
    out.candidates = considered;
    out.streak = streak;
    if (last) {
      out.dropRatio = last.dropRatio;
      out.needDrop = last.needDrop;
      out.expectedDrop = last.expectedDrop;
    }
    if (considered === 0) { out.reason = 'need-steps'; return out; }
    if (streak >= e.hits) { out.verdict = 'ineffective'; out.reason = 'no-response'; return out; }
    if (streak === 0) { out.verdict = 'effective'; out.reason = 'responded'; return out; }
    out.reason = 'hysteresis';
    return out;
  }

  // 能力探测 → 三档降级路径（设计文档 §7.1）。摄像头能力差异极大，
  // 且部分 UVC 的 getCapabilities() 直接抛异常，调用方必须包 try
  function pickExposurePlan(cap, settings) {
    if (!cap || typeof cap !== 'object') return { tier: 0, reason: 'no-capabilities' };
    if (cap.exposureCompensation && typeof cap.exposureCompensation.min === 'number') {
      return {
        tier: 1,
        reason: 'exposure-compensation',
        min: cap.exposureCompensation.min,
        max: typeof cap.exposureCompensation.max === 'number' ? cap.exposureCompensation.max : 0,
        step: cap.exposureCompensation.step || 0
      };
    }
    var modes = cap.exposureMode || [];
    if (modes.indexOf('manual') >= 0 && (cap.exposureTime || cap.iso)) {
      // 只有 min 才能定下「压到哪」。设备只报 exposureTime.max（无 min）又无 iso 能力时，
      // buildExposureConstraints 会退化成「切了 manual 却不发任何曝光值」——画面根本
      // 不会被压暗，但渲染层徽标仍显示「曝光补偿 xEV」，用户看到的反馈与事实不符。
      // 这类能力残缺的设备一律降级 tier0（软件兜底，徽标如实显示「软件压暗」）。
      // 注意别误伤「有 min 无 max」的正常设备：那种由下面的 1e9 兜底覆盖，仍算 tier2
      var timeMin = cap.exposureTime && typeof cap.exposureTime.min === 'number' ? cap.exposureTime.min : null;
      var isoMin = cap.iso && typeof cap.iso.min === 'number' ? cap.iso.min : null;
      if (timeMin == null && isoMin == null) return { tier: 0, reason: 'manual-without-min' };
      return {
        tier: 2,
        reason: 'manual-exposure',
        baseTime: settings && settings.exposureTime ? settings.exposureTime : null,
        baseIso: settings && settings.iso ? settings.iso : null,
        timeMin: timeMin,
        timeMax: cap.exposureTime && typeof cap.exposureTime.max === 'number' ? cap.exposureTime.max : 1e9,
        isoMin: isoMin,
        isoMax: cap.iso && typeof cap.iso.max === 'number' ? cap.iso.max : 1e9,
        restoreMode: modes.indexOf('continuous') >= 0 ? 'continuous' : 'manual-baseline'
      };
    }
    return { tier: 0, reason: 'unsupported' };
  }

  // 按档位构造曝光约束。红线：绝不夹带 width/height/frameRate ——
  // 曝光调整碰分辨率键会破坏 applyMaxResolution 的锁定（项目纪律）
  function buildExposureConstraints(plan, ev) {
    if (!plan || plan.tier === 0) return null;
    if (plan.tier === 1) {
      var v = ev;
      // 按设备步长取整：部分 UVC 对非步长整数倍的补偿直接拒绝。
      // isFinite 守卫不可省：有设备把 step 报成 Infinity，而
      // Math.round(ev / Infinity) * Infinity === NaN —— NaN 会一路送进
      // applyConstraints（被静默忽略或直接 reject），那样负补偿等于没发。
      // 步长不可用时原样透传 ev（绝大多数设备本身就接受任意小数）
      if (plan.step > 0 && isFinite(plan.step)) v = Math.round(ev / plan.step) * plan.step;
      if (v < plan.min) v = plan.min;
      if (v > plan.max) v = plan.max;
      return { advanced: [{ exposureMode: 'continuous', exposureCompensation: v }] };
    }
    // tier2 手动档：EV 负补偿 = 曝光时间 ×2^ev；优先压时间不升 iso
    // （升 iso 只加噪点不救过曝，时间才是曝光量的主轴）
    var adv2 = { exposureMode: 'manual' };
    if (plan.baseTime && plan.timeMin != null) {
      var t = plan.baseTime * Math.pow(2, ev);
      if (t < plan.timeMin) t = plan.timeMin;
      if (t > plan.timeMax) t = plan.timeMax;
      adv2.exposureTime = t;
    } else if (plan.baseIso && plan.isoMin != null) {
      var iso = plan.baseIso * Math.pow(2, ev);
      if (iso < plan.isoMin) iso = plan.isoMin;
      if (iso > plan.isoMax) iso = plan.isoMax;
      adv2.iso = iso;
    }
    // 不变式：产不出具体曝光值就绝不发 manual 约束。
    // 上游 pickExposurePlan 只守住了「能力里没有 min」，守不住「能力有 min 但
    // getSettings() 不给基线」这种组合（baseTime / baseIso 为 null）——那类设备
    // 会被切进手动模式却拿不到曝光量，画面根本不会变暗，而渲染层徽标仍显示
    // 「曝光补偿 xEV」，属于用户可见的撒谎。把守点下沉到构造函数末尾，任何
    // 上游判定遗漏的组合在这里都会被封死。
    if (adv2.exposureTime === undefined && adv2.iso === undefined) return null;
    return { advanced: [adv2] };
  }

  // 恢复约束：最小约束原则（只发必须发的键）—— 多发一个键就多一次
  // Overconstrained / 悬挂风险。tier1 只把补偿归零；tier2 切回 continuous
  // 把曝光交还 AE（切回连续后 time/iso 约束自动失效，无需逐个还原）
  function buildExposureRestoreConstraints(plan) {
    if (!plan || plan.tier === 0) return null;
    if (plan.tier === 1) return { advanced: [{ exposureCompensation: 0 }] };
    if (plan.restoreMode === 'continuous') return { advanced: [{ exposureMode: 'continuous' }] };
    var adv = { exposureMode: 'manual' };
    if (plan.baseTime) adv.exposureTime = plan.baseTime;
    if (plan.baseIso) adv.iso = plan.baseIso;
    return { advanced: [adv] };
  }

  // 实际下发到设备的补偿量（EV）。闭环算出的 ev 会被设备步长取整、min/max 钳位，
  // 真正下发的值可能更浅（例如设备 min=-0.5，闭环要 -2.0 也只能发 -0.5）。
  // 有效性判定必须拿「真的发下去的值」算预期降幅，否则会高估预期、误判好设备
  function appliedEvOf(plan, ev, cst) {
    if (!cst || !cst.advanced || !cst.advanced[0]) return ev;
    var a = cst.advanced[0];
    if (!plan || plan.tier === 1) {
      return typeof a.exposureCompensation === 'number' ? a.exposureCompensation : ev;
    }
    if (plan.tier === 2 && typeof a.exposureTime === 'number' && plan.baseTime > 0) {
      return Math.log(a.exposureTime / plan.baseTime) / Math.LN2;
    }
    if (plan.tier === 2 && typeof a.iso === 'number' && plan.baseIso > 0) {
      return Math.log(a.iso / plan.baseIso) / Math.LN2;
    }
    return ev;
  }

  /**
   * 有效性判定失败后的档位降级（纯函数）：tier1 → tier2 → tier0，一路只往下走。
   * tier1 的 exposureCompensation 是幽灵能力时，把该能力从 cap 里摘掉再探测，
   * 让 pickExposurePlan 有机会落到 manual 路径；manual 同样无效就只剩软件兜底。
   *
   * @param {object} plan 当前档位（pickExposurePlan 的产物）
   * @param {object} cap track.getCapabilities()
   * @param {object} settings track.getSettings()
   * @returns {{tier:number, reason:string, plan:(object|null)}}
   */
  function demoteExposurePlan(plan, cap, settings) {
    var tier = plan && typeof plan.tier === 'number' ? plan.tier : 0;
    if (tier === 2) return { tier: 0, reason: 'manual-ineffective', plan: null };
    if (tier !== 1) return { tier: 0, reason: 'unsupported', plan: null };
    // 把 exposureCompensation 摘掉再探测：它可能只是「报告有、实际无效」
    var cap2 = {};
    var k;
    if (cap && typeof cap === 'object') {
      for (k in cap) {
        if (Object.prototype.hasOwnProperty.call(cap, k) && k !== 'exposureCompensation') cap2[k] = cap[k];
      }
    }
    var next = pickExposurePlan(cap2, settings);
    // 只有真能产出曝光值的 manual 才值得切：构造不出曝光值等于「切了手动却不压暗」，
    // 与幽灵能力是同一个用户可见后果（徽标说在压暗、画面其实没压）
    if (next.tier === 2 && !buildExposureConstraints(next, -EXP_EFFECT.minEv)) {
      return { tier: 0, reason: 'comp-ineffective', plan: null };
    }
    if (next.tier === 2) return { tier: 2, reason: 'comp-ineffective', plan: next };
    return { tier: 0, reason: 'comp-ineffective', plan: null };
  }

  // 软件兜底查找表：out = in × 2^(ev/gamma)（与 §7.5 判定同源的 sRGB 模型）
  //
  // 勘误 2026-10（QA DEF-1）：原实现 out = 255×(in/255)^(2^-ev) 是在**码值域做幂运算**，
  // 等价于把线性光取幂 L → L^(2^-ev)，而不是曝光补偿应有的 L → L×2^ev。实测 ev=-3
  // （tier0 闭环顶到 expEvMin 后的真实取值）：黑衣物主体 150 → 4（近全黑，而非目标 58）、
  // 被裁剪的白色鞋底 255 → 255（永远救不回来，正是现场投诉的那一项）、褶皱暗部
  // 20~60 全部抹成 0。越深的补偿偏差越大（-1EV→等效 -2.19EV、-3EV→等效 -12EV）。
  // 正确做法与硬件补偿同源：线性光 ×2^ev → 码值 ×2^(ev/gamma)，码值域就是一次乘法。
  // 「gamma 曲线保住暗部层次」的原始理由也随之更正 —— 真正在保层次的是等比例压暗
  // （暗部按比例一起降、相对关系不变），幂次曲线恰恰是把暗部压死的那个。
  function buildExposureLut(ev) {
    var lut = new Uint8ClampedArray(256);
    var v = Number(ev);
    // ev ≥ 0 / 非数 → 恒等（本方案不做提亮）；Uint8ClampedArray 自身会夹 [0,255]
    if (!isFinite(v) || v >= 0) {
      for (var i0 = 0; i0 < 256; i0++) lut[i0] = i0;
      return lut;
    }
    var k = Math.pow(2, v / SRGB_GAMMA);
    for (var i = 0; i < 256; i++) lut[i] = Math.round(i * k);
    return lut;
  }

  // tier0（软件兜底）的 EV 解析解：code × 2^(ev/gamma) = expTargetMean
  //   →  ev = clamp(gamma × log2(expTargetMean / subjectMean), expEvMin, 0)
  // 为什么 tier0 不能继续用 nextEvStep 的闭环：tier0 只改存档图、不改预览，闭环读到的
  // subjectMean 永远是「没被压暗的原图」，误差恒为正 → EV 一路撞到 expEvMin。实测
  // 主体 100 只需 -1.73EV 却取了 -3.00EV（存档被过压 1.27 档），主体 130 只需 -2.56EV。
  // 解析解一步到位，且不会把存档压到目标以下。
  function solveTier0Ev(subjectMean, cfg) {
    var c = Object.assign({}, DEFAULTS, cfg || {});
    var mean = Number(subjectMean);
    var target = Number(c.expTargetMean);
    if (!isFinite(mean) || mean <= 0 || !isFinite(target) || target <= 0) return null;
    var ev = SRGB_GAMMA * (Math.log(target / mean) / Math.LN2);
    if (ev > 0) ev = 0;                 // 比目标更暗：不提亮（欠曝交给现场补光）
    if (ev < c.expEvMin) ev = c.expEvMin;
    return ev;
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

  /* ---------- 分辨率：纯计算（可单测，不碰 DOM / navigator） ---------- */

  var RES_PREF_VERSION = 1;

  // 分辨率单边合法性上限：与 normalizeResolution 共用同一个常量。
  // 别在两处硬编码 —— 一旦失配，阶梯就会产出我们自己判非法的档位：
  // 那类档位会被 buildResolutionConstraints 静默丢掉（等于记忆失效），还白占一档探测预算。
  var MAX_RES_DIM = 7680;

  // 常见摄像头档位表（面积降序）。Chromium 的 getCapabilities() 只给 min/max 区间、
  // 不给离散档位，因此候选集 = 「标准档位表 ∩ 能力区间」+「双 max 组合」，
  // 而不是直接把 width.max 与 height.max 拼在一起 —— 后者经常拼出设备根本不支持的
  // 组合（例如 width.max=1920 只在 720 及以下高度可用），一 applyConstraints 就
  // OverconstrainedError，旧实现把它静默吞掉，于是「设置了更高分辨率但不生效」。
  var STANDARD_RATINGS = [
    [3840, 2160], [2560, 1440], [1920, 1080], [1600, 1200], [1600, 900],
    [1280, 1024], [1280, 960], [1280, 720], [1024, 768], [960, 540],
    [800, 600], [640, 480], [640, 360], [352, 288], [320, 240], [176, 144]
  ];

  function intOf(v) {
    var n = Number(v);
    return isFinite(n) ? Math.floor(n) : null;
  }

  /**
   * 取能力区间：max/min 缺一半时用另一半兜底，区间反了就换回来。
   * upper 为合法性上限（分辨率用 MAX_RES_DIM），超过即夹到上限，
   * 保证阶梯不会产出「我们自己也判非法」的档位。
   */
  function capRange(cap, key, upper) {
    var c = cap && cap[key];
    if (!c || typeof c !== 'object') return null;
    var max = typeof c.max === 'number' && isFinite(c.max) ? Math.floor(c.max) : null;
    var min = typeof c.min === 'number' && isFinite(c.min) ? Math.floor(c.min) : null;
    if (max == null && min == null) return null;
    // 退化能力（个别虚拟/驱动异常的摄像头会报 max:0）：整体判无效。
    // 不能靠「区间反了就交换」把它凑成 max=1 —— 那会向设备下发 width:{exact:1} 这种荒谬档位
    if (max != null && max < 1) return null;
    if (max == null) max = min;
    if (min == null) min = 1;
    if (max < min) {
      var t = min;
      min = max;
      max = t;
    }
    if (upper != null) {
      if (max > upper) max = upper;
      if (min > upper) min = upper;
    }
    return { min: min, max: max };
  }

  /**
   * 由 getCapabilities() 构造「分辨率候选阶梯」（纯函数）。
   * 排序：像素面积降序 → 帧率降序 → 宽度降序。
   * 帧率只对最高档展开多个备选：USB 摄像头常常是「分辨率够、带宽不够」，
   * 降帧率能保住分辨率，比直接掉到下一档分辨率更划算。
   *
   * @param {object} capabilities track.getCapabilities() 的返回值
   * @param {object} [options] { maxRungs, maxFps }
   * @returns {Array<{width:number,height:number,frameRate?:number}>}
   */
  function buildResolutionLadder(capabilities, options) {
    var opt = options || {};
    var maxRungs = opt.maxRungs == null ? DEFAULTS.resMaxRungs : Math.max(1, intOf(opt.maxRungs) || 1);
    var maxFps = opt.maxFps == null ? DEFAULTS.resMaxFps : Math.max(1, intOf(opt.maxFps) || 1);
    var w = capRange(capabilities, 'width', MAX_RES_DIM);
    var h = capRange(capabilities, 'height', MAX_RES_DIM);
    if (!w || !h || w.max < 1 || h.max < 1) return [];
    var wMin = Math.max(1, w.min);
    var hMin = Math.max(1, h.min);

    var pairs = [];
    function pushPair(pw, ph) {
      if (!(pw >= wMin && pw <= w.max && ph >= hMin && ph <= h.max)) return;
      for (var i = 0; i < pairs.length; i++) {
        if (pairs[i][0] === pw && pairs[i][1] === ph) return;
      }
      pairs.push([pw, ph]);
    }

    // ① 双 max 组合：绝大多数摄像头的最高档就是它，必须排在最前
    pushPair(w.max, h.max);
    // ② 最大宽 × 常用高（最多 3 档）：处理「最大宽度只与较低高度搭配」的摄像头
    var altH = [];
    for (var i = 0; i < STANDARD_RATINGS.length && altH.length < 3; i++) {
      var sh = STANDARD_RATINGS[i][1];
      if (sh <= h.max && altH.indexOf(sh) < 0) altH.push(sh);
    }
    for (var a = 0; a < altH.length; a++) pushPair(w.max, altH[a]);
    // ③ 标准档位表 ∩ 能力区间
    for (var j = 0; j < STANDARD_RATINGS.length; j++) {
      pushPair(STANDARD_RATINGS[j][0], STANDARD_RATINGS[j][1]);
    }
    // ④ 兜底：能力区间下界（下界小得离谱时不放，避免出现 1×1 这种不可能的档位）
    if (wMin >= 160 && hMin >= 120) pushPair(wMin, hMin);
    if (!pairs.length) return [];

    pairs.sort(function (p1, p2) {
      var d = p2[0] * p2[1] - p1[0] * p1[1];
      return d ? d : p2[0] - p1[0];
    });

    // 帧率备选：最高档展开 [max, 30, 15…]，其余档只取设备最高帧率
    var fps = capRange(capabilities, 'frameRate');
    var topFps = null;
    var fpsList = [null];
    if (fps) {
      topFps = Math.max(1, fps.max);
      fpsList = [topFps];
      var fpHint = [30, 20, 15, 10, 5];
      var fpMin = Math.max(1, Math.ceil(fps.min));
      for (var k = 0; k < fpHint.length && fpsList.length < maxFps; k++) {
        if (fpHint[k] >= topFps || fpHint[k] < fpMin) continue;
        fpsList.push(fpHint[k]);
      }
    }

    var out = [];
    for (var p = 0; p < pairs.length; p++) {
      var list = p === 0 ? fpsList : [topFps];
      for (var q = 0; q < list.length; q++) {
        var rung = { width: pairs[p][0], height: pairs[p][1] };
        if (list[q]) rung.frameRate = list[q];
        out.push(rung);
      }
    }
    return out.length > maxRungs ? out.slice(0, maxRungs) : out;
  }

  /**
   * 归一化一个分辨率值：接受 {width,height,frameRate} / {w,h,fps}，非法一律返回 null。
   * 用于校验 getSettings() 输出与持久化的记忆档位，脏数据不得污染状态机。
   */
  function normalizeResolution(value) {
    if (!value || typeof value !== 'object') return null;
    var w = intOf(value.width != null ? value.width : value.w);
    var h = intOf(value.height != null ? value.height : value.h);
    if (!w || !h || w < 1 || h < 1 || w > MAX_RES_DIM || h > MAX_RES_DIM) return null;
    var out = { width: w, height: h };
    var fps = intOf(value.frameRate != null ? value.frameRate : value.fps);
    if (fps && fps > 0 && fps <= 240) out.frameRate = fps;
    return out;
  }

  /**
   * 校验持久化的记忆档位：带版本号与时间戳，版本不认 / 字段非法一律当「没存过」，
   * 宁可走一次全量枚举，也不能拿脏存档把分辨率锁死在一个设备不支持的档位上。
   */
  function parseResolutionPref(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.v != null && Number(raw.v) !== RES_PREF_VERSION) return null;
    var r = normalizeResolution(raw);
    if (!r) return null;
    r.version = RES_PREF_VERSION;
    r.ts = intOf(raw.ts) || 0;
    if (typeof raw.dev === 'string' && raw.dev) r.dev = raw.dev;
    return r;
  }

  /**
   * 生成待持久化的存档（v=版本号，ts=时间戳，dev=这份档位来自哪台设备）。
   * dev 只用于「没指定设备」那份存档的防串档校验。
   */
  function makeResolutionPref(rung, ts, dev) {
    var r = normalizeResolution(rung);
    if (!r) return null;
    return {
      v: RES_PREF_VERSION,
      w: r.width,
      h: r.height,
      fps: r.frameRate || 0,
      ts: typeof ts === 'number' && isFinite(ts) ? Math.floor(ts) : 0,
      dev: typeof dev === 'string' ? dev : ''
    };
  }

  /**
   * 组装 gUM 的视频约束（纯函数）。分辨率用 exact 才是「锁定」；
   * frameRate 只用 ideal —— 带宽不够时降帧比整档失败更划算。
   * 没有档位可写时返回与旧实现完全一致的结构（video:true / deviceId exact），
   * 保证既有契约断言不被破坏。
   *
   * @param {string} deviceId 设备 id（空串 / 降级态下不写 deviceId）
   * @param {object} [rung] 记忆档位 {width,height,frameRate}
   * @returns {{video:(true|object),audio:boolean}}
   */
  function buildResolutionConstraints(deviceId, rung) {
    var video = null;
    if (deviceId) video = { deviceId: { exact: deviceId } };
    var r = normalizeResolution(rung);
    if (r) {
      video = video || {};
      video.width = { exact: r.width };
      video.height = { exact: r.height };
      if (r.frameRate) video.frameRate = { ideal: r.frameRate };
    }
    return { video: video === null ? true : video, audio: false };
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
    // 分辨率记忆的注入点：controller 是纯逻辑模块，禁止直接碰 localStorage。
    // 未注入时（Node 单测 / 无痕模式）一律 no-op，退化为「每次全量枚举」
    var loadPref = typeof opt.loadResolutionPref === 'function' ? opt.loadResolutionPref : null;
    var savePref = typeof opt.saveResolutionPref === 'function' ? opt.saveResolutionPref : null;
    // 曝光辅助的 4 个注入（黑色衣物过曝防护）。与 blackFrameEnabled 同一模式：
    // 控制器是纯逻辑模块，不碰 DOM、不读 document、不读 localStorage。
    // 未注入时一律按「不拦 / 不启用」处理，既有调用方不受任何影响
    var gridSampler = typeof opt.gridSampler === 'function' ? opt.gridSampler : null;
    var pageVisible = typeof opt.pageVisible === 'function' ? opt.pageVisible : null;
    var focusBusy = typeof opt.focusBusy === 'function' ? opt.focusBusy : null;
    var exposureAssistEnabled = typeof opt.exposureAssistEnabled === 'function' ? opt.exposureAssistEnabled : null;

    var alive = false;
    var state = STATES.UNINIT;
    var error = null; // { code, message, recoverable }
    var stream = null;
    var resolution = null; // 实际输出 { width, height[, frameRate] }
    var resolutionRequest = null; // 本次请求（并校验通过）的档位，与 resolution 对照用
    var resolutionSource = 'none'; // pref | already | ladder | none —— 当前分辨率是怎么来的
    var resPrefUsed = null; // 本次 gUM 约束里带上的记忆档位（命中失败时据此清空记忆）
    var resPrefMissed = false; // 本轮打开中记忆档位已被证明不可用，后续尝试不再带它
    var resDroppedTried = false; // 本轮已试过「保留设备、只去掉分辨率约束」，再失败才放开设备
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

    var listeners = { state: [], error: [], devices: [], exposure: [] };

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

    // 任意档位对象 → 日志 res 字段（附加字段只收原始类型，不能把对象塞进日志）
    function resFieldOf(r) {
      return r && r.width && r.height ? { w: r.width, h: r.height } : null;
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
      clearExposureWatch();
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
      // 曝光恢复必须赶在 stream=null（activeTrack 会失效）与 track.stop() 之前点火：
      // 流一停，设备上的负补偿就再也还回不去了。best-effort、不 await、失败只留痕
      if (expAssist.state === 'ACTIVE' && expAssist.dirty) restoreExposure('release');
      stopExposureAssist('release', false);
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
        // 同一 track 复活：曝光辅助重启（内部先尽力恢复上一会话的补偿
        // 再归零，否则设备停在降曝态而内部状态已重置，两边会对不上）
        startExposureAssist(mySeq);
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

    /* ---------- 曝光辅助：黑色衣物过曝防护（设计文档 docs/exposure-assist-design.md）----------
     * 自包含闭环：检测（纯函数）→ 滞回决策 → 执行（applyConstraints 竞速）→ 恢复。
     * 不碰 DOM、不碰 localStorage；帧数据经注入的 gridSampler 取得。
     * 三态：OFF（禁用/无采样器）/ IDLE（在测未命中）/ ACTIVE（已介入）。
     * 所有对外副作用（日志、约束下发）都被包在里面，任何异常都不得影响预览与拍照主链。
     */
    var expAssist = {
      state: 'OFF',      // OFF（禁用/无采样器）/ IDLE / ACTIVE
      st: { state: 'IDLE', hit: 0, miss: 0, engagedAt: 0, releasedAt: 0 },
      ev: 0,
      tier: 0,
      plan: null,
      dirty: false,      // 本会话是否真的改过设备曝光（决定要不要恢复）
      lastSceneMean: null,
      lastSubjectMean: null,
      lastSubjectRatio: null,
      // 缺陷 1：engage 时（ev=0、整帧中性）捕获的「中性场景均值」，作为判定闸门的还原参照。
      // ACTIVE 后每帧按「当前场景均值 / 中性场景均值」这一由整帧实测得出的压暗系数 f 还原回
      // 中性刻度（亮垫板→210、黑衣物→150）。用场景均值之比而非请求/实测 EV：该比值恰为 1/f、
      // 天然含过压带来的额外压暗、且无帧滞后；对帧不随补偿变暗的静态/幽灵设备 f≈1 → 不还原
      // → 与旧实现完全一致，不会漂移到 185 以上误判失格。
      expRefMean: 0,
      adjusts: 0,
      fails: 0,
      lastApplyAt: 0,
      // 有效性判定（幽灵能力检测，§7.5）：本档位开始时的主体亮度 + 每次下发后的
      // 实测响应序列。effBaseline 为 null 时由第一个样本补上（换档后画面基准变了）
      effBaseline: null,
      effSamples: [],
      effAt: 0,
      demotions: 0,
      lastAppliedEv: 0,   // 上一次**请求**下发到设备的补偿量（EV，幽灵能力判定用）
      prevAppliedEv: 0,   // 上上一次，用于识别「已经压不动了（pinned）」
      // 缺陷 2：过压设备。overPress = 请求 EV − 实际 EV（>0 表示过压）；
      // evFloor 把闭环 ev 下限收紧到实测可达深度，避免往「只会被设备再压更深」处请求。
      // actualEv 是实测反推的实际生效 EV（徽标与过压判定用，比请求值诚实）
      overPress: 0,
      overPressStreak: 0,
      evFloor: -3.0,
      actualEv: 0
    };
    var expWatch = null;

    // 会话级「幽灵能力」记忆（QA 观察项 U19）：本设备哪个档位已被实测判过无效。
    // 为什么需要：降级结论原先只在单次 engage 内有效，release 后重新 engage 会重新探测
    // tier1 —— 幽灵设备每放一件衣物都要重走一次约 4s 的「徽标显示 -xEV、画面其实没压暗」
    // 窗口，那正是现场投诉的形态。能力是**设备**的属性而不是流的属性，所以按 deviceId
    // 记在会话里；换设备即失效（engageAssist 每次比对 deviceId）。
    // 注意：只有「实测无效」才记账，apply 失败/超时不记 —— 那可能是设备忙，不是能力无效
    var expGhost = { dev: '', tiers: {} };
    // 拿不到任何设备标识时的兜底发号器：见 devIdOf() 注释（QA DEF-4）
    var ghostUidSeq = 0;

    function expGhostBlocked(tier) {
      return !!(tier > 0 && (expGhost.tiers[tier] || 0) >= EXP_GHOST.minStrikes);
    }

    // 当前 track 的设备标识：幽灵记忆按设备记，不能串档（QA DEF-4）。
    // 为什么不能「拿不到就返回空串」：两台都不上报 deviceId 的设备会落进同一个空串槽，
    // `devId !== expGhost.dev` 恒为假 → 记忆永不清空 → 好设备被上一台幽灵设备的记录
    // 挡在硬件补偿之外（实测：B 机全程 0 条补偿约束、直接 tier0）。兜底链按
    // deviceId → track.id（浏览器给每条 track 的唯一串）→ track.label（设备名）→
    // track 实例号；换设备必然换 track 对象，实例号因此能把两台设备分开。
    function devIdOf() {
      var t = activeTrack();
      if (!t) return '';
      var id = '';
      try {
        var s = typeof t.getSettings === 'function' ? t.getSettings() : null;
        if (s && s.deviceId) id = String(s.deviceId);
      } catch (e) { id = ''; }
      if (!id) { try { if (t.id) id = String(t.id); } catch (e1) { id = ''; } }
      if (!id) { try { if (t.label) id = String(t.label); } catch (e2) { id = ''; } }
      if (!id) {
        try {
          if (t.__expUid == null) t.__expUid = 'track#' + (++ghostUidSeq);
          id = String(t.__expUid);
        } catch (e3) { id = ''; }
      }
      return id;
    }

    // 记一次「实测无效」，返回该档位在本设备上累计被判无效的次数（供日志回看第几次）。
    // 计数跟着 devId 走：换设备时连计数一起清空 —— 换了一台机器，上一台还差一次才达
    // 门槛的证据不该被继承（否则 A 机 1 次 + B 机 1 次就凑成 2 次，误伤新设备）
    function expGhostRemember(tier, devId) {
      if (!(tier > 0)) return 0;
      var d = typeof devId === 'string' ? devId : '';
      if (d !== expGhost.dev) { expGhost.dev = d; expGhost.tiers = {}; }
      var n = (expGhost.tiers[tier] || 0) + 1;
      expGhost.tiers[tier] = n;
      return n;
    }

    function expEnabled() {
      if (!gridSampler) return false;
      try { return exposureAssistEnabled() !== false; } catch (e) { return false; }
    }

    // LIVE 后启动。内部先 stopExposureAssist('restart', true)：DEGRADED→LIVE
    // 复活时同一 track 上可能还挂着上一会话的负补偿，必须先尽力恢复再归零，
    // 否则设备停在降曝态而内部状态已重置，两边会对不上
    function startExposureAssist(mySeq) {
      stopExposureAssist('restart', true);
      if (!expEnabled()) return;
      expAssist.state = 'IDLE';
      expAssist.st = { state: 'IDLE', hit: 0, miss: 0, engagedAt: 0, releasedAt: 0 };
      expAssist.ev = 0;
      expAssist.tier = 0;
      expAssist.plan = null;
      expAssist.dirty = false;
      expAssist.actualEv = 0;   // 缺陷 2：实测 EV 一并清零，避免下次 engage 徽标读到残留
      expAssist.lastSceneMean = null;
      expAssist.lastSubjectMean = null;
      expAssist.lastSubjectRatio = null;
      expAssist.adjusts = 0;
      expAssist.fails = 0;
      expAssist.lastApplyAt = 0;
      expAssist.demotions = 0;
      expAssist.overPress = 0;
      expAssist.overPressStreak = 0;
      expAssist.evFloor = cfg.expEvMin;
      expAssist.actualEv = 0;
      expAssist.expRefMean = 0;
      resetEffectWatch(null);
      scheduleExposureCycle(mySeq, cfg.expEngageDelayMs);
    }

    // 有效性判定的观测序列归零（engage / 换档时调用）。换档后画面基准与量纲都变了，
    // 旧基线与旧样本不能沿用：曝光补偿与曝光时间不是同一个量纲，继承旧 ev 没有意义。
    // 注意 demotions 不在这里清零：换档本身是一次降级，计数要跨档位累加
    function resetEffectWatch(baseline) {
      expAssist.effBaseline = baseline == null ? null : baseline;
      expAssist.effSamples = [];
      expAssist.effAt = now();
      expAssist.lastAppliedEv = 0;
      expAssist.prevAppliedEv = 0;
    }

    function scheduleExposureCycle(mySeq, delay) {
      clearExposureWatch();
      expWatch = st(function () {
        var firedId = expWatch;
        expWatch = null;
        // 回调触发时把自身 id 从 timers 摘掉，避免数组随周期单调增长
        if (firedId != null) {
          var ti = timers.indexOf(firedId);
          if (ti >= 0) timers.splice(ti, 1);
        }
        if (mySeq !== seq || !alive) return;
        exposureCycle(mySeq);
      }, delay);
      timers.push(expWatch);
    }

    function clearExposureWatch() {
      if (expWatch == null) return;
      try { ct(expWatch); } catch (e) {}
      var i = timers.indexOf(expWatch);
      if (i >= 0) timers.splice(i, 1);
      expWatch = null;
    }

    // 停止辅助；restore=true 且 dirty 时把设备曝光还回去。
    // 新流（attemptOnce 路径）本来就是默认曝光，此时 dirty=false，
    // 不会白发一次 applyConstraints —— 那也是给爱悬挂的 UVC 添堵
    function stopExposureAssist(reason, restore) {
      clearExposureWatch();
      if (restore && expAssist.dirty) restoreExposure(reason);
      expAssist.state = expEnabled() ? 'IDLE' : 'OFF';
      expAssist.st = { state: 'IDLE', hit: 0, miss: 0, engagedAt: 0, releasedAt: 0 };
      expAssist.ev = 0;
      expAssist.tier = 0;
      expAssist.plan = null;
      expAssist.dirty = false;
      expAssist.actualEv = 0;   // 缺陷 2：实测 EV 一并清零，避免下次 engage 徽标读到残留
      expAssist.demotions = 0;
      expAssist.overPress = 0;
      expAssist.overPressStreak = 0;
      expAssist.evFloor = cfg.expEvMin;
      expAssist.actualEv = 0;
      expAssist.expRefMean = 0;
      resetEffectWatch(null);
      emitExposure();
    }

    async function exposureCycle(mySeq) {
      try {
        // 闸门组：仅 LIVE + 页面可见 + 采样器可用。对焦脉冲期间整个周期跳过 ——
        // single-shot 期间部分 UVC 停输出，此时的帧统计全是噪声，且曝光
        // applyConstraints 与对焦 applyConstraints 交叠有回弹风险
        if (mySeq !== seq || !alive || state !== STATES.LIVE) return;
        if (!expEnabled()) { stopExposureAssist('disabled', false); return; }
        if (pageVisible && !pageVisible()) {
          log('info', 'CAM_EXP_SKIP', { seq: seq, reason: 'page-hidden' });
          scheduleExposureCycle(mySeq, cfg.expCycleMs);
          return;
        }
        if (focusBusy && focusBusy()) {
          log('info', 'CAM_EXP_SKIP', { seq: seq, reason: 'focus-pulse' });
          scheduleExposureCycle(mySeq, cfg.expCycleMs);
          return;
        }
        var el = safeVideo();
        if (!frameReady(el)) { scheduleExposureCycle(mySeq, cfg.expCycleMs); return; }
        var image = null;
        try { image = gridSampler(el, cfg.expGridSize); } catch (e) { image = null; }
        var cells = computeGridStats(image, cfg.expGridCells);
        if (!cells) { scheduleExposureCycle(mySeq, cfg.expCycleMs); return; }
        // 缺陷 1 修复：把当前整帧按「engage 时中性场景均值 / 当前场景均值」这一实测压暗系数
        // 还原回中性刻度（亮垫板→210、黑衣物→150），四道闸同一口径，闸门稳定不再自杀。
        // 用场景均值之比（而非请求 EV / 实测 EV）的原因：整帧均匀压暗下该比值恰为 1/f、天然
        // 含过压带来的额外压暗、且无帧滞后；对帧不随补偿变暗的静态/幽灵设备 f≈1 → 不还原 →
        // 与旧实现完全一致。ev=0（无中性参照）→ 还原系数=1。
        var clOpts = (expAssist.state === 'ACTIVE' && expAssist.expRefMean > 0)
          ? { refMean: expAssist.expRefMean, gamma: SRGB_GAMMA } : { refMean: 0, gamma: SRGB_GAMMA };
        var cl = classifyExposureGrid(cells, cfg, clOpts);
        expAssist.lastSceneMean = cl.sceneMean;
        expAssist.lastSubjectMean = cl.subjectMean;
        expAssist.lastSubjectRatio = cl.subjectRatio;
        var h = stepAssistHysteresis(expAssist.st, cl.hit, now(), cfg);
        expAssist.st = h.st;
        if (h.action === 'engage') await engageAssist(mySeq, cl);
        else if (h.action === 'release') releaseAssist('no-hit');
        else if (expAssist.state === 'ACTIVE') await tickClosedLoop(mySeq, cl);
        if (mySeq !== seq || !alive) return;
        scheduleExposureCycle(mySeq, cfg.expCycleMs);
      } catch (e) {
        // 曝光辅助任何意外都不得影响预览/拍照主链：记一条日志，下个周期再来
        log('warn', 'CAM_EXP_FALLBACK', { seq: seq, reason: 'cycle-error', err: { name: (e && e.name) || 'Error', message: (e && e.message) || String(e) } });
        if (mySeq === seq && alive) scheduleExposureCycle(mySeq, cfg.expCycleMs);
      }
    }

    async function engageAssist(mySeq, cl) {
      var track = activeTrack();
      expAssist.state = 'ACTIVE';
      expAssist.ev = 0;
      // 缺陷 2：实测实际生效 EV 一并清零。不清零的后果见 tier0 分支：从硬件档降级下来时
      // 徽标会把上一个硬件档的实测值当成「软件压暗」的档位显示（QA F1）
      expAssist.actualEv = 0;
      expAssist.adjusts = 0;
      expAssist.fails = 0;
      if (!track || typeof track.getCapabilities !== 'function') {
        expAssist.tier = 0;
        expAssist.plan = null;
        log('warn', 'CAM_EXP_FALLBACK', { seq: seq, reason: 'no-track-capability', tier: 0 });
        emitExposure();
        return;
      }
      var cap = null;
      var settings = null;
      try { cap = track.getCapabilities(); } catch (e) { cap = null; }
      try { settings = track.getSettings(); } catch (e2) { settings = null; }
      // 换设备即清空幽灵记忆：能力是设备的属性，另一台机器可能这条路径是好使的
      // 必须与 expGhostRemember 用**同一个** devIdOf() 兜底链，否则 engage 侧拿到空串、
      // 记忆侧拿到 track#N，两边永远不相等 → 上一次刚记下的结论在下次 engage 被误判成
      // 「换设备」清空（QA DEF-4 的直接后果：记忆形同不存在）
      var devId = devIdOf();
      if (devId !== expGhost.dev) { expGhost.dev = devId; expGhost.tiers = {}; }
      var plan = pickExposurePlan(cap, settings);
      // 已知无效的档位直接跳过：不让现场每一件衣物都重看一次「徽标说在压暗、画面没变」
      var skippedTier = 0;
      // 必须**循环**复查，不能只查一次入口档：双档幽灵设备（tier1 与 tier2 都被实测判过
      // 无效）若只跳过 tier1，落到 tier2 后 tier2 仍会被完整重走一遍（QA DEF-3 实测：
      // 第二件衣物仍下发 6 次 manual 约束，无效窗口只从 4.3s 降到 3.5s 而不是 0）。
      // 降级链尾是 tier0（tier0 不在记忆里），循环必然终止；guard 只是防御性上限。
      var guard = 0;
      while (plan.tier > 0 && expGhostBlocked(plan.tier) && guard++ < 4) {
        var alt = demoteExposurePlan(plan, cap, settings);
        if (!skippedTier) skippedTier = plan.tier;
        plan = alt.plan || { tier: 0, reason: alt.reason };
      }
      expAssist.plan = plan;
      expAssist.tier = plan.tier;
      expAssist.demotions = skippedTier ? 1 : 0;
      if (skippedTier) {
        log('warn', 'CAM_EXP_FALLBACK', {
          seq: seq, reason: 'ghost-remembered', tier: plan.tier, from: skippedTier, ev: 0, drop: null
        });
      }
      log('info', 'CAM_EXP_ENUM', { seq: seq, tier: plan.tier, reason: plan.reason });
      if (plan.tier === 0) {
        // 硬件不支持：不发任何约束，改由拍照时软件压暗（徽标提示「软件压暗」）
        log('warn', 'CAM_EXP_FALLBACK', { seq: seq, reason: 'software-fallback', tier: 0 });
        emitExposure();
        return;
      }
      // 有效性判定的起点：本档位下的第一条基线 + 空观测序列
      resetEffectWatch(cl.subjectMean);
      // 缺陷 1：捕获 engage 时的中性场景均值作为判定闸门还原参照（此时 ev=0、整帧中性，
      // clOpts.refMean=0 → cl.sceneMean 即原始中性场景均值）。ACTIVE 后每帧按实测压暗系数还原，
      // 亮垫板被还原回 210、黑衣物还原回 150，闸门不再自杀。
      expAssist.expRefMean = (cl && isFinite(cl.sceneMean) && cl.sceneMean > 0) ? cl.sceneMean : 0;
      // 先把模式切过去（补偿从 0 起，具体压多少交给闭环），失败即降级 tier0
      var cst = buildExposureConstraints(plan, 0);
      var ok = await applyExposure(track, cst, mySeq);
      if (!ok) {
        expAssist.tier = 0;
        expAssist.plan = null;
        log('warn', 'CAM_EXP_FALLBACK', { seq: seq, reason: 'engage-apply-failed', tier: plan.tier });
      } else {
        expAssist.dirty = true;
        expAssist.lastAppliedEv = appliedEvOf(plan, 0, cst);
        expAssist.prevAppliedEv = 0;
      }
      log('info', 'CAM_EXP_ENGAGE', {
        seq: seq,
        tier: expAssist.tier,
        ev: expAssist.ev,
        subjectRatio: Math.round(cl.subjectRatio * 100) / 100,
        sceneMean: cl.sceneMean == null ? null : Math.round(cl.sceneMean)
      });
      emitExposure();
    }

    async function tickClosedLoop(mySeq, cl) {
      var nowMs = now();
      // 频率限制：距上次 apply 不足 max(stepGap, settle) 不动。不足 settle
      // 说明 AE 还在收敛，此刻测的亮度是过渡值，拿它算步长会过冲
      if (nowMs - expAssist.lastApplyAt < Math.max(cfg.expStepGapMs, cfg.expSettleMs)) return;

      // 缺陷 2：用实测主体亮度反推「实际生效 EV」。闭环假设「请求 ev = 实际 ev」线性 1:1，
      // 设备若把请求时间再乘 1/k 执行（时间下限 / 量化 / 单位解释都可能），实际压暗会更深，
      // 闭环看到过暗就往回加 ev → bang-bang 振荡。先量出 actual，供过压判定与徽标使用。
      var measuredEv = null;
      if (cl.subjectMean != null && isFinite(cl.subjectMean) && cl.subjectMean > 0 &&
          expAssist.effBaseline != null && isFinite(expAssist.effBaseline) && expAssist.effBaseline > 0 &&
          expAssist.lastApplyAt > 0) {
        measuredEv = SRGB_GAMMA * (Math.log(cl.subjectMean / expAssist.effBaseline) / Math.LN2);
        if (!isFinite(measuredEv) || measuredEv > 0) measuredEv = null;  // 物理上不会变亮
      }
      // 过压判定（连续命中才记，吸收 AE 抖动 / 衣物微动）：实际比请求深超过容差即记过压设备，
      // 并把闭环 ev 下限收紧到「实测可达深度」，不再往更深（只会被设备再压更深）处请求。
      if (measuredEv != null && expAssist.ev < 0) {
        var op = expAssist.ev - measuredEv;   // >0 表示实际更深
        var prevOverPress = expAssist.overPress;
        if (measuredEv < expAssist.ev - EXP_OVERPRESS.tol && op > 0) {
          expAssist.overPressStreak += 1;
        } else {
          expAssist.overPressStreak = 0;
        }
        if (expAssist.overPressStreak >= EXP_OVERPRESS.hits && op > expAssist.overPress) {
          expAssist.overPress = op;
          expAssist.evFloor = Math.min(0, cfg.expEvMin + op);
          // 只在「过压更深了」时记一条；稳态后 op 不再增长就不再刷日志
          // （真实设备每周期都过压，不拦会秒级刷屏）
          if (op > (prevOverPress + 1e-9)) {
            log('warn', 'CAM_EXP_OVERPRESS', {
              seq: seq, reason: 'over-press', tier: expAssist.tier,
              requestedEv: Math.round(expAssist.ev * 100) / 100,
              measuredEv: Math.round(measuredEv * 100) / 100,
              overPress: Math.round(op * 100) / 100,
              evFloor: Math.round(expAssist.evFloor * 100) / 100
            });
          }
        }
      }
      // 闭环步长：把 ev 下限收紧到过压后可达深度，不再请求更深
      var r = nextEvStep(expAssist.ev, cl.subjectMean, cfg);
      if (r.ev < expAssist.evFloor) {
        r = { ev: expAssist.evFloor, step: expAssist.evFloor - expAssist.ev, err: r.err };
      }
      // 幽灵能力只能靠这一步测出来：约束发出去 ≠ 画面真的变暗（lastAppliedEv 仍为请求值）
      if (expAssist.tier > 0 && cl.hit && expAssist.lastApplyAt > 0) {
        recordEffectSample(cl, nowMs, r.err > 0 &&
          Math.abs(expAssist.lastAppliedEv - expAssist.prevAppliedEv) < 1e-6);
      }
      // 有效性判定：只判硬件档（tier0 根本没发过约束，也不影响预览采样）。
      // 判定放这里而不是「apply 成功之后」：贴住下限时不会再有 apply，
      // 而那正是现场「一直空转」的形态，必须照样判得到
      if (expAssist.tier > 0 && expAssist.demotions < 2) {
        var v = judgeExposureEffect({
          baseline: expAssist.effBaseline,
          samples: expAssist.effSamples,
          startedAt: expAssist.effAt
        }, cfg);
        if (v.verdict === 'ineffective') {
          await demoteExposureTier(mySeq, v);
          return;
        }
      }
      if (r.step === 0) return;
      if (expAssist.tier === 0) {
        // 软件兜底档：没有约束可发，EV 走**解析解**（solveTier0Ev）——闭环在这里是开环的，
        // 见该函数注释。lastApplyAt 也要记账：否则每周期都来一次，日志会爆炸
        var solved = solveTier0Ev(cl.subjectMean, cfg);
        if (solved == null) return;
        var jump = solved - expAssist.ev;
        // 已在位（含抖动 <0.01EV ≈ 0.4% 亮度）就不重复记账
        if (Math.abs(jump) < 0.01) return;
        expAssist.ev = solved;
        // 缺陷 2 / QA F1：tier0 的「实际生效 EV」就是拍照时下发的软件解析解（没有硬件约束可发）。
        // 不清零的后果：从硬件档降级到 tier0 时，actualEv 残留上一个硬件档的实测值，
        // 徽标会把「软件压暗」显示成那个残留值（如 -2.4EV），与实际下发的解析解不符
        expAssist.actualEv = solved;
        expAssist.lastApplyAt = nowMs;
        expAssist.adjusts += 1;
        log('info', 'CAM_EXP_STEP', {
          seq: seq, tier: 0,
          ev: Math.round(solved * 100) / 100,
          step: Math.round(jump * 100) / 100,
          subjectMean: cl.subjectMean == null ? null : Math.round(cl.subjectMean),
          clipRatio: clipFieldOf(cl)
        });
        emitExposure();
        return;
      }
      var track = activeTrack();
      if (!track) return;
      var cst = buildExposureConstraints(expAssist.plan, r.ev);
      var ok = await applyExposure(track, cst, mySeq);
      if (!ok) {
        // 连续失败达到上限：停硬件路径降软件兜底，并把这轮补偿恢复掉
        if (expAssist.fails >= cfg.expApplyFailLimit) {
          log('warn', 'CAM_EXP_FALLBACK', { seq: seq, reason: 'fail-limit', tier: expAssist.tier });
          restoreExposure('fail-limit');
          expAssist.tier = 0;
          expAssist.plan = null;
          emitExposure();
        }
        return;
      }
      expAssist.prevAppliedEv = expAssist.lastAppliedEv;
      expAssist.lastAppliedEv = appliedEvOf(expAssist.plan, r.ev, cst);
      // 实测反推的实际生效 EV：幽灵判定的 lastAppliedEv 保持「请求值」不变，这里单独记账，
      // 供徽标诚实展示（缺陷 2）与「闭环是否已被钳在可达深度」判定
      expAssist.actualEv = (measuredEv != null) ? measuredEv : expAssist.actualEv;
      expAssist.ev = r.ev;
      expAssist.lastApplyAt = nowMs;
      expAssist.adjusts += 1;
      log('info', 'CAM_EXP_STEP', {
        seq: seq, tier: expAssist.tier,
        ev: Math.round(r.ev * 100) / 100,
        step: Math.round(r.step * 100) / 100,
        subjectMean: cl.subjectMean == null ? null : Math.round(cl.subjectMean),
        clipRatio: clipFieldOf(cl)
      });
      emitExposure();
    }

    // 高光裁剪占比（千分位）：白色鞋底/白垫板「还在被裁剪」是过曝的直接证据。
    // classifyExposureGrid 早就算出 clip，只是没透出——调参时没有它只能靠猜
    function clipFieldOf(cl) {
      var v = cl && cl.clipRatio;
      return v == null || !isFinite(Number(v)) ? null : Math.round(Number(v) * 1000) / 1000;
    }

    // 记一次「已下发补偿 → 实测亮度」的配对样本。只在硬件档且场景仍命中时记：
    // 衣物移出画面后的亮度与补偿无关，记进去会污染判定
    function recordEffectSample(cl, nowMs, pinned) {
      var mean = Number(cl && cl.subjectMean);
      if (!isFinite(mean)) return;
      // 换档后第一帧的画面基准可能与 engage 时不同（如切 manual 冻结了 AE），
      // 基线缺失时就用第一个样本补上
      if (expAssist.effBaseline == null || !isFinite(expAssist.effBaseline)) expAssist.effBaseline = mean;
      expAssist.effSamples.push({
        ev: expAssist.lastAppliedEv,
        mean: mean,
        t: nowMs,
        pinned: !!pinned
      });
      // 只留最近 12 条：贴住下限时每个周期都会记一条，不设上限数组会一直增长
      if (expAssist.effSamples.length > 12) expAssist.effSamples.shift();
    }

    // 档位降级（幽灵能力 → 换一条路）：tier1 → tier2 → tier0。
    //   ① 先把当前档位的约束还回去（补偿归零 / 切回 continuous），否则两份曝光
    //      偏置会叠在同一台设备上，用户看到的是「莫名偏暗」；
    //   ② 重新探测下一档（把无效的那个能力摘掉再探测）；
    //   ③ 换量纲 → ev 归零、基线与观测序列重置，对新档位**重新做一次有效性验证**。
    async function demoteExposureTier(mySeq, verdict) {
      var track = activeTrack();
      var from = expAssist.tier;
      var oldPlan = expAssist.plan;
      var reason = from === 2 ? 'manual-ineffective' : 'comp-ineffective';
      expAssist.demotions += 1;
      // 记进会话级幽灵记忆（达到 EXP_GHOST.minStrikes 才真正生效）：下次 engage
      // （下一件衣物）直接跳过这个档位。返回值是「这台设备这条路径第几次被判无效」，
      // 未达门槛时现场也能从日志看出「还差一次」，不用猜为什么这次没跳过
      var ghostStrikes = expGhostRemember(from, devIdOf());
      // ① 还回去（best-effort：失败只留痕，见 restoreExposure 注释）
      restoreExposure(reason);
      var cap = null;
      var settings = null;
      try {
        cap = track && typeof track.getCapabilities === 'function' ? track.getCapabilities() : null;
      } catch (e) { cap = null; }
      try {
        settings = track && typeof track.getSettings === 'function' ? track.getSettings() : null;
      } catch (e2) { settings = null; }
      var next = demoteExposurePlan(oldPlan, cap, settings);
      // 降级后同样要查一次记忆：tier1 判无效会降到 tier2，而 tier2 可能在上一次
      // engage 里已经单独被判过无效（双档幽灵设备，QA DEF-3）。与 engage 侧同一个循环
      var g2 = 0;
      while (next.tier > 0 && next.plan && expGhostBlocked(next.tier) && g2++ < 4) {
        next = demoteExposurePlan(next.plan, cap, settings);
      }
      log('warn', 'CAM_EXP_FALLBACK', {
        seq: seq,
        reason: reason,
        tier: next.tier,
        from: from,
        ev: Math.round(expAssist.ev * 100) / 100,
        drop: verdict && verdict.dropRatio == null ? null : Math.round(verdict.dropRatio * 1000) / 1000,
        // 第几次被判无效（含本次）。未达 EXP_GHOST.minStrikes 时不会记账，
        // 现场凭这个字段就能区分「还没到门槛」和「记忆没生效」
        ghostStrike: ghostStrikes
      });
      // ③ 换量纲：补偿与曝光时间不是同一个量纲，继承旧 ev 没有意义，从 0 重新收敛
      expAssist.ev = 0;
      expAssist.adjusts = 0;
      expAssist.fails = 0;
      resetEffectWatch(null);
      if (next.tier === 0 || !next.plan || !track) {
        expAssist.plan = null;
        expAssist.tier = 0;
        emitExposure();
        return;
      }
      expAssist.plan = next.plan;
      expAssist.tier = next.plan.tier;
      log('info', 'CAM_EXP_ENUM', { seq: seq, tier: next.plan.tier, reason: reason });
      // 新档位同样从 0 起（具体压多少交给闭环），失败就再降一级到软件兜底
      var cst = buildExposureConstraints(next.plan, 0);
      var ok = await applyExposure(track, cst, mySeq);
      if (!ok) {
        expAssist.plan = null;
        expAssist.tier = 0;
        log('warn', 'CAM_EXP_FALLBACK', { seq: seq, reason: 'demote-apply-failed', tier: next.plan.tier });
      } else {
        expAssist.dirty = true;
        expAssist.lastAppliedEv = appliedEvOf(next.plan, 0, cst);
        expAssist.prevAppliedEv = 0;
        expAssist.lastApplyAt = now();
      }
      emitExposure();
    }

    // 曝光约束统一竞速：部分 UVC 摄像头 applyConstraints 永不 settle，
    // 不竞速会把曝光周期（进而拍照前的等待）卡死。与 tryApplyRung 同构
    async function applyExposure(track, cst, mySeq) {
      if (!track || !cst || typeof track.applyConstraints !== 'function') return false;
      // 变量名刻意不用 acw：scripts/verify-camera-res-mutation.js 的 M4 变异体以
      // 「acw.cancel();」为锚点定位 tryApplyRung 的定时器回收，这里同名会让锚点失配
      var expW = waitMs(cfg.expApplyTimeoutMs);
      var err = null;
      var raced = null;
      try {
        raced = await Promise.race([
          track.applyConstraints(cst).then(function () { return 'ok'; }, function (e) { err = e; return 'err'; }),
          expW.promise.then(function (v) { return v === false ? 'aborted' : 'timeout'; })
        ]);
      } catch (e2) {
        err = err || e2;
        raced = 'err';
      } finally {
        // 防御性回收，不是正确性支柱：sleep / unmount / 重开流这几条路径上的
        // clearTimers() 已经兜底清空了 timers[]，删掉这行不会改变 EV、档位或
        // 下发次数（QA 实测逐项相同），只是运行期间会多残留 1~2 颗已无用的定时器，
        // 并在超时前继续持有闭包。这里提前释放是为了少一点抖动
        expW.cancel();
      }
      // 'aborted' = 定时器被 clearTimers 打断（卸载/休眠），不算设备故障
      if (raced === 'aborted') return false;
      if (raced === 'timeout' || raced === 'err') {
        expAssist.fails += 1;
        log('warn', 'CAM_EXP_FALLBACK', {
          seq: mySeq,
          reason: raced === 'timeout' ? 'apply-timeout' : 'apply-error',
          err: err ? { name: (err && err.name) || 'Error', message: (err && err.message) || '' } : null
        });
        return false;
      }
      expAssist.fails = 0;
      return true;
    }

    function releaseAssist(reason) {
      if (expAssist.state !== 'ACTIVE') return;
      log('info', 'CAM_EXP_RELEASE', { seq: seq, reason: reason, ev: Math.round(expAssist.ev * 100) / 100 });
      // 衣物移出画面时 track 还活着，这里的恢复是用户可感知的，必须真发
      restoreExposure(reason);
      expAssist.state = 'IDLE';
      expAssist.st = { state: 'IDLE', hit: 0, miss: 0, engagedAt: 0, releasedAt: now() };
      expAssist.ev = 0;
      expAssist.tier = 0;
      expAssist.plan = null;
      expAssist.dirty = false;
      expAssist.actualEv = 0;   // 缺陷 2：实测 EV 一并清零，避免下次 engage 徽标读到残留
      expAssist.demotions = 0;
      expAssist.overPress = 0;
      expAssist.overPressStreak = 0;
      expAssist.evFloor = cfg.expEvMin;
      expAssist.actualEv = 0;
      expAssist.expRefMean = 0;
      resetEffectWatch(null);
      emitExposure();
    }

    // 恢复曝光：best-effort，点火即忘（sleep/unmount/releaseActive 路径是同步调用它的）。
    // 刻意不挂 waitMs 竞速定时器：那些路径上 clearTimers() 往往已经跑过，
    // 再挂一颗定时器就会留下永不回收的悬挂定时 —— 而这里的流马上就停，
    // 设备重置后设置本来就会丢，失败只需留痕，不需要重排
    function restoreExposure(reason) {
      var plan = expAssist.plan;
      if (!plan || plan.tier === 0 || expAssist.tier === 0) return Promise.resolve(false);
      var track = activeTrack();
      var cst = buildExposureRestoreConstraints(plan);
      if (!track || !cst || typeof track.applyConstraints !== 'function') {
        log('warn', 'CAM_EXP_RESTORE', { seq: seq, reason: reason, ok: false });
        return Promise.resolve(false);
      }
      var p = null;
      try {
        p = Promise.resolve(track.applyConstraints(cst));
      } catch (e) {
        p = Promise.reject(e);
      }
      p.then(function () {
        expAssist.dirty = false;
        log('info', 'CAM_EXP_RESTORE', { seq: seq, reason: reason, ok: true });
      }, function () {
        log('warn', 'CAM_EXP_RESTORE', { seq: seq, reason: reason, ok: false });
      });
      return Promise.resolve(true);
    }

    // 黑帧门控放行条件（设计文档 §9.1）。用「刚刚」采的场景均值而不是
    // 上一个周期的值：挡镜头后 sceneMean 会在一个周期内崩塌，若拿陈旧值
    // 放行，被遮挡的 release 滞回窗口（≈2.5s）里就可能放进黑照片。
    // gridSampler 是同步的，重新采一次的代价可接受
    function expGateSuppress() {
      if (expAssist.state !== 'ACTIVE' || !gridSampler) return false;
      var sceneMean = expAssist.lastSceneMean;
      try {
        var image = gridSampler(safeVideo(), cfg.expGridSize);
        var cells = computeGridStats(image, cfg.expGridCells);
        var cl = cells ? classifyExposureGrid(cells, cfg) : null;
        if (cl && cl.sceneMean != null) sceneMean = cl.sceneMean;
      } catch (e) { /* 采样失败时退回上一个周期的值 */ }
      return sceneMean != null && sceneMean >= cfg.expBlackFloor;
    }

    function emitExposure() {
      emit('exposure', {
        state: expAssist.state,
        ev: expAssist.ev,
        appliedEv: expAssist.actualEv,   // 缺陷 2：实际生效 EV（由实测亮度反推，诚实展示）
        tier: expAssist.tier,
        sceneMean: expAssist.lastSceneMean,
        subjectMean: expAssist.lastSubjectMean,
        adjusts: expAssist.adjusts
      });
    }

    function frameReady(el) {
      if (!el) return false;
      return el.readyState >= 2 && el.videoWidth > 0 && el.videoHeight > 0;
    }

    /* ---------- 打开流程 ---------- */

    /* ---------- 分辨率：候选阶梯 → 逐档锁定 → 持久化 ----------
     * 为什么必须这么绕：Chromium 必须在 track 已 live（gUM 成功）之后才能读到
     * getCapabilities()，开流前无法真正枚举格式。旧实现是「开流后用 ideal 提一次」：
     *   ① ideal 只是倾向，Chromium 可以自行降档 → 设了不生效；
     *   ② width.max × height.max 常被分别取到，拼出的组合设备并不支持 →
     *      OverconstrainedError 被 catch 静默吞掉 → 静默失败；
     *   ③ 不校验实际输出，掉到低分辨率无人知晓；
     *   ④ 不持久化，重启 / 换设备只能重新走「默认档 → 事后提档」→ 回落。
     * 三段式修复：
     *   ① 开流前：命中该设备的记忆档位 → 直接以 exact 写进 gUM 约束，一次到位；
     *   ② 开流后、attach 之前：按 buildResolutionLadder() 的阶梯逐档 applyConstraints
     *      ({exact}) 并用 getSettings() 校验实际输出，成功即锁定并持久化；
     *   ③ 全档失败：保留当前流正常出画，只写日志（绝不置 ERROR，绝不影响拍照）。
     */

    // 读取 track 报告的真实输出；getSettings 抛异常时返回 null，绝不影响出画
    function readRawSettings(track) {
      if (!track || typeof track.getSettings !== 'function') return null;
      try { return track.getSettings() || null; } catch (e) { return null; }
    }

    function readSettings(track) {
      return normalizeResolution(readRawSettings(track));
    }

    function sameRung(a, b) {
      if (!a || !b) return false;
      return a.width === b.width && a.height === b.height;
    }

    function toResolution(r) {
      var n = normalizeResolution(r);
      if (!n) return null;
      return { width: n.width, height: n.height };
    }

    // 存档键：指定了设备就严格按设备 id 存（切换摄像头绝不串档）；
    // 没指定设备（开系统默认摄像头，典型场景是刚启动、还没枚举出 deviceId）用默认键 ''。
    // 默认键的存档里记了它来自哪台设备（dev），一旦实际出流的设备对不上就立即作废，
    // 因此「换过默认摄像头 / 换过 USB 口」也不会沿用旧档位。
    function prefKeyOf(deviceId) {
      return deviceId ? deviceId : '';
    }

    function buildConstraints(deviceId) {
      resPrefUsed = null;
      var rung = null;
      // deviceId 为空 = 开系统默认摄像头（刚启动还没枚举出 deviceId 的典型场景）：
      // 这时用默认键 '' 的存档，让重启后也能一次到位；指定设备时严格按设备 id 取，绝不串档
      if (!fallbackNoExact && !resPrefMissed && loadPref) {
        try {
          rung = parseResolutionPref(loadPref(deviceId));
        } catch (e) {
          rung = null; // 存档损坏 / localStorage 不可用 → 当作没有记忆
        }
        log('info', 'CAM_RES_PREF', {
          seq: seq,
          device: shortDeviceId(deviceId),
          res: resFieldOf(rung),
          reason: rung ? 'hit' : 'miss'
        });
        if (rung) resPrefUsed = rung;
      }
      // 降级态（Overconstrained 后）不带 deviceId，也不带分辨率约束
      return buildResolutionConstraints(deviceId && !fallbackNoExact ? deviceId : '', rung);
    }

    /**
     * 逐档探测并锁定最高可用分辨率。
     * @returns {object|null} 实际输出 { width, height }（永远反映真实输出，不撒谎）
     */
    async function applyMaxResolution(track, deviceId, mySeq) {
      resolution = null;
      resolutionRequest = null;
      resolutionSource = 'none';
      var cur = readSettings(track);
      var raw = readRawSettings(track);
      var actualDev = raw && raw.deviceId ? raw.deviceId : '';
      // 防串档：默认键的存档记着它来自哪台设备，实际出流的设备对不上就作废并重新枚举
      // （换过摄像头 / 换过 USB 口时设备 id 会变，沿用旧档位会被 Overconstrained 打回）
      if (resPrefUsed && !deviceId && resPrefUsed.dev && actualDev && resPrefUsed.dev !== actualDev) {
        log('warn', 'CAM_RES_PREF', {
          seq: mySeq,
          device: shortDeviceId(actualDev),
          res: resFieldOf(resPrefUsed),
          reason: 'device-changed'
        });
        clearResolutionPref('', mySeq, 'device-changed');
      }
      var cap = null;
      try {
        cap = track && typeof track.getCapabilities === 'function' ? track.getCapabilities() : null;
      } catch (e) {
        cap = null;
      }
      var ladder = buildResolutionLadder(cap, { maxRungs: cfg.resMaxRungs, maxFps: cfg.resMaxFps });
      var top = ladder.length ? ladder[0] : null;
      log('info', 'CAM_RES_ENUM', {
        seq: mySeq,
        device: shortDeviceId(deviceId),
        res: resFieldOf(top),
        rungs: ladder.length,
        capW: cap && cap.width ? cap.width.max : null,
        capH: cap && cap.height ? cap.height.max : null,
        capFps: cap && cap.frameRate ? cap.frameRate.max : null
      });

      var chosen = null;
      var budgetHit = false;
      var deadline = now() + cfg.resBudgetMs; // 总预算：不让逐档探测把出画拖成十几秒
      for (var i = 0; i < ladder.length; i++) {
        if (!alive || mySeq !== seq) return toResolution(cur);
        // 总预算闸门只放在这一个地方（循环头部）：每轮复查一次。
        // 只在某个分支里查会让闸门形同虚设 —— 恒挂设备（部分 UVC 摄像头的真实行为）会
        // 一路 applyConstraints 超时，resMaxRungs(16) × applyConstraintMs(1000) ≈ 16s 才出画，
        // 那正是本次要消灭的现场症状。
        // 取舍说明：预算生效后最坏只探测 2~3 档是可接受的 —— 正常失败（Overconstrained）
        // 是秒回的、不吃满 applyConstraintMs，只有真悬挂才吃满，而真悬挂的设备本来也锁不上更高档。
        // 因此不要为了「多试几档」去调小 applyConstraintMs（1000ms 是 UVC 永不 settle 的生产安全兜底）。
        if (budgetHit || now() >= deadline) { budgetHit = true; break; }
        var rung = ladder[i];
        // 当前输出已经是这一档 → 不必调 applyConstraints。很多摄像头默认就开在最高档，
        // 而部分 UVC 设备一调 applyConstraints 就卡住，少调一次就少一次风险
        if (sameRung(cur, rung)) {
          chosen = rung;
          resolutionSource = resPrefUsed && sameRung(resPrefUsed, rung) ? 'pref' : 'already';
          break;
        }
        var applied = await tryApplyRung(track, rung, deviceId, mySeq);
        if (applied === 'stale') return toResolution(cur);
        if (!applied) continue;
        var got = readSettings(track);
        if (sameRung(got, rung)) {
          chosen = rung;
          // 「记忆命中但要 applyConstraints 复现」（重启后摄像头开在默认档的最常见路径）
          // 也算命中，不能标成 ladder —— 现场要靠这个字段判断记忆机制有没有起作用
          resolutionSource = resPrefUsed && sameRung(resPrefUsed, rung) ? 'pref' : 'ladder';
          cur = got;
          break;
        }
        // 设备「接受」了约束却没给到对应输出 —— 旧实现完全看不见这种情况
        log('warn', 'CAM_RES_FALLBACK', {
          seq: mySeq,
          device: shortDeviceId(deviceId),
          res: resFieldOf(rung),
          reason: 'verify-mismatch',
          gotW: got ? got.width : null,
          gotH: got ? got.height : null
        });
        cur = got;
      }

      resolution = toResolution(cur);
      if (chosen) {
        var req = toResolution(chosen);
        if (chosen.frameRate) req.frameRate = chosen.frameRate;
        resolutionRequest = req;
        log('info', 'CAM_RES_APPLY', {
          seq: mySeq,
          device: shortDeviceId(deviceId),
          res: resField(),
          reason: resolutionSource
        });
        persistResolution(deviceId, chosen, mySeq);
      } else if (ladder.length) {
        // 全档失败 / 预算耗尽：都保留当前流正常出画，只留证据（不置 ERROR、不影响拍照）。
        // reason 区分两者：'ladder-exhausted' = 阶梯里每一档都被设备拒绝了；
        //                 'budget-exhausted' = 还有档没试但总预算用完（通常意味着设备在悬挂）
        log('warn', 'CAM_RES_FALLBACK', {
          seq: mySeq,
          device: shortDeviceId(deviceId),
          res: resField(),
          reason: budgetHit ? 'budget-exhausted' : 'ladder-exhausted',
          budgetMs: cfg.resBudgetMs,
          rungs: ladder.length
        });
        if (resPrefUsed) clearResolutionPref(deviceId, mySeq, 'pref-unusable');
      }
      return resolution;
    }

    // 单档尝试：exact 锁定 + 超时兜底 + 显式失败原因。
    // 返回 'stale'（会话已作废）/ true（已应用）/ false（被拒或超时）
    async function tryApplyRung(track, rung, deviceId, mySeq) {
      if (!track || typeof track.applyConstraints !== 'function') return false;
      var cst = { width: { exact: rung.width }, height: { exact: rung.height } };
      // frameRate 只用 ideal：带宽不够时降帧比整档失败更划算
      if (rung.frameRate) cst.frameRate = { ideal: rung.frameRate };
      var acw = waitMs(cfg.applyConstraintMs);
      var timedOut = false;
      var err = null;
      try {
        await Promise.race([
          track.applyConstraints(cst).then(function () { return 'ok'; }, function (e) { err = e; return 'err'; }),
          acw.promise.then(function (v) { if (v !== false) timedOut = true; return 'timeout'; })
        ]);
      } catch (e2) {
        err = err || e2;
      }
      // 无论胜负都回收定时器：落败一侧的计时器若留下就是悬挂定时（QA 探测项 A/D1）
      acw.cancel();
      if (!alive || mySeq !== seq) return 'stale';
      if (timedOut || err) {
        log('warn', 'CAM_RES_FALLBACK', {
          seq: mySeq,
          device: shortDeviceId(deviceId),
          res: resFieldOf(rung),
          reason: timedOut ? 'apply-timeout' : ((err && err.name) === 'OverconstrainedError' ? 'overconstrained' : 'apply-error'),
          err: err ? { name: (err && err.name) || 'Error', message: (err && err.message) || '' } : null
        });
        return false;
      }
      return true;
    }

    // 锁定成功 → 持久化「设备 → 档位」，下次开流前直接写进 gUM 约束（重启 / 换设备不再回落）
    function persistResolution(deviceId, rung, mySeq) {
      if (!savePref) return;
      var keys = [prefKeyOf(deviceId)];
      // 开的是默认设备时额外按「实际出流的设备 id」存一份：
      // 下次明确指定这台设备（下拉里选它）时也能直接命中，不必再枚举一遍
      var raw = readRawSettings(activeTrack());
      var devId = raw && raw.deviceId ? raw.deviceId : '';
      if (!deviceId && devId) keys.push(devId);
      var payload = makeResolutionPref(rung, now(), devId);
      for (var i = 0; i < keys.length; i++) {
        try {
          savePref(keys[i], payload);
          log('info', 'CAM_RES_PERSIST', {
            seq: mySeq,
            device: shortDeviceId(keys[i]),
            res: resFieldOf(rung),
            reason: 'saved'
          });
        } catch (e) {
          /* 持久化失败不得影响拍照，仅此而已 */
        }
      }
    }

    // 记忆档位被设备拒绝 / 无法复现 → 立刻清空，避免每次开流都先撞一次失败
    function clearResolutionPref(deviceId, mySeq, reason) {
      var key = prefKeyOf(deviceId);
      resPrefUsed = null;
      resPrefMissed = true;
      if (!savePref) return;
      try {
        savePref(key, null);
        log('warn', 'CAM_RES_PERSIST', {
          seq: mySeq,
          device: shortDeviceId(key),
          reason: reason || 'cleared'
        });
      } catch (e) {
        /* 同上：清理失败不影响主流程 */
      }
    }

    // 出画后交叉校验：track.getSettings() 与 video.videoWidth/Height 必须一致。
    // 不一致 = 驱动没真正切档，这是现场「设了更高分辨率但不生效」唯一可观测的证据。
    // 以画面真实尺寸为准 —— 拍照出图用的是 video 尺寸，状态显示不能撒谎。
    function verifyOutputResolution(el, deviceId, mySeq) {
      if (!el) return;
      var vw = intOf(el.videoWidth) || 0;
      var vh = intOf(el.videoHeight) || 0;
      if (!vw || !vh) return; // 尚未出画：拿不到尺寸就不下结论
      if (resolution && resolution.width === vw && resolution.height === vh) {
        log('info', 'CAM_RES_VERIFY', {
          seq: mySeq,
          device: shortDeviceId(deviceId),
          res: resField(),
          reason: 'ok'
        });
        return;
      }
      log('warn', 'CAM_RES_VERIFY', {
        seq: mySeq,
        device: shortDeviceId(deviceId),
        res: resField(),
        reason: 'video-mismatch',
        gotW: vw,
        gotH: vh
      });
      resolution = { width: vw, height: vh };
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
        // 记忆档位被这台设备拒绝：立刻清空它，否则每次开流都要先撞一次 OverconstrainedError。
        // 非 Overconstrained 的可恢复错误（占用 / 未就绪）同样停用记忆档位：分辨率约束会
        // 让部分摄像头直接开不出流，宁可本轮退回「开流后再逐档提」，也不能打不开摄像头。
        if (resPrefUsed && !res.fatal && res.code !== 'NO_TRACK') {
          clearResolutionPref(deviceId, mySeq, res.code === 'OVERCONSTRAINED' ? 'overconstrained' : 'pref-blocked');
        }
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
      // 提分辨率必须在 attachStream() 之前：video.play() 之后再由驱动改分辨率会被底层覆盖
      await applyMaxResolution(track, deviceId, mySeq);

      var el = safeVideo();
      var attached = await attachStream(el, s, mySeq);
      if (!attached) return { handled: true };

      if (!alive || mySeq !== seq) {
        releaseActive('late');
        return { cancelled: true };
      }
      // 出画后用 video 真实尺寸复核一遍，不一致即留证据并以画面尺寸为准
      verifyOutputResolution(el, deviceId, mySeq);
      setState(STATES.LIVE, 'attached');
      log('info', 'CAM_LIVE', { seq: mySeq, device: shortDeviceId(deviceId), res: resField(), attempt: att, flap: flapCount });
      // 曝光辅助在 LIVE 之后启动，内部再延迟 expEngageDelayMs 避开
      // 分辨率探测与首帧 AE 收敛窗口
      startExposureAssist(mySeq);
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
          // 若这次失败是「记忆档位」带来的（已清空并停用记忆），只去掉分辨率约束、
          // 保留 deviceId 约束 —— 否则会连设备一起放开，打开的就不是用户选的那台摄像头了。
          // 再去一次仍然 Overconstrained，才回退到 { video: true }
          if (resPrefMissed && !resDroppedTried) {
            resDroppedTried = true;
            log('warn', 'CAM_RETRY', { seq: mySeq, attempt: attempt, reason: 'overconstrained-drop-res', delayMs: 0 });
          } else {
            fallbackNoExact = true;
            log('warn', 'CAM_RETRY', { seq: mySeq, attempt: attempt, reason: 'overconstrained-fallback', delayMs: 0 });
          }
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
      // 换设备 / 人工重开 = 新的一轮：上一轮被证明不可用的记忆档位重新纳入考虑
      resPrefMissed = false;
      resDroppedTried = false;
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
      resPrefMissed = false;
      resDroppedTried = false;
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

    // silent=true：只取判定结果、不写「拒收」日志。供 confirmBlackFrame 复采使用，
    // 避免留下「先记拒收、复采后却又放行」这种误导现场排查的日志。
    // 对外行为（默认调用）与改造前完全一致，既有契约测试不受影响。
    function isBlackFrame(el, silent) {
      var enabled = true;
      try { enabled = blackFrameEnabled() !== false; } catch (e) { enabled = true; }
      if (!enabled || !frameSampler) return false;
      var target = el || safeVideo();
      if (!target) return false;
      var samples = null;
      try { samples = frameSampler(target, cfg.sampleSize); } catch (e) { samples = null; }
      if (!samples || !samples.length) return false;
      var r = analyzeGraySamples(samples, { mean: cfg.blackMean, variance: cfg.blackVariance });
      if (r.black && expGateSuppress()) {
        // 曝光辅助 ACTIVE 期间的门控放行（设计文档 §9.1）：手动降曝后中心
        // 区域必然更暗，沿用 blackMean:12 的绝对阈值会把「被正确压暗的
        // 黑色衣物」误判成「画面全黑」而拒拍。ACTIVE 的成立条件本身已排除
        // 挡镜头/黑信号（要求高亮参照 ≥ expHiAreaMin、场景均值 ≥ expSceneMeanMin），
        // 故只保留一条兜底：实时场景均值 ≥ expBlackFloor 才放行。
        // 为什么这里不守 silent 约定：它不是拒收记录，而是「门控放行了一次
        // 本会被误拒的拍摄」的证据，且只在黑衣物+辅助激活时出现，量极小
        log('info', 'CAM_EXP_BLACKGATE', {
          seq: seq,
          reason: 'assist-active',
          sceneMean: expAssist.lastSceneMean == null ? null : Math.round(expAssist.lastSceneMean),
          mean: Math.round(r.mean * 100) / 100,
          variance: Math.round(r.variance * 100) / 100
        });
        return false;
      }
      if (r.black && !silent) {
        log('warn', 'CAM_CAPTURE_REJECT', { seq: seq, reason: 'black-frame', mean: Math.round(r.mean * 100) / 100, variance: Math.round(r.variance * 100) / 100 });
      }
      return r.black;
    }

    // 拍照前的黑帧复采（异步）：只有「持续全黑」才拒拍。
    // 背景：部分 UVC 摄像头在 single-shot 对焦脉冲、自动曝光调整或分辨率重协商期间会
    // 短暂停输出，那一瞬画面确实是黑的，但预览上看只是一闪。单次采样会把这种瞬时黑帧
    // 当成「镜头被遮挡」拒收 —— 正是「预览正常却间歇性提示全黑、无法拍摄」的来源。
    // 设计取舍：只放宽「时间维度」（复采到持续黑才拒），**不动阈值**，
    // 因此不会削弱「真挡镜头 / 真黑照片入库」的拦截能力。
    async function confirmBlackFrame(el) {
      if (!isBlackFrame(el, true)) return false;
      var deadline = now() + cfg.blackRetryMs;
      var attempts = 1;
      while (now() < deadline) {
        await waitMs(cfg.blackSampleGapMs).promise;
        // 复采期间被卸载 / 休眠：不拦拍，交由上层状态闸门裁决
        if (!alive) return false;
        attempts += 1;
        if (!isBlackFrame(el, true)) {
          log('warn', 'CAM_BLACK_RETRY', { seq: seq, reason: 'transient-recovered', attempts: attempts });
          return false;
        }
      }
      log('warn', 'CAM_CAPTURE_REJECT', { seq: seq, reason: 'black-frame-persistent', attempts: attempts, waitMs: cfg.blackRetryMs });
      return true;
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
        // 「请求档位」与「实际档位」同时暴露：现场核对「设了最高档但没生效」时，
        // 两者不一致就是驱动降档的铁证（getResolution() 只给实际档位）
        resolutionRequest: resolutionRequest,
        resolutionSource: resolutionSource,
        preferredId: preferredId,
        alive: alive,
        trackBinds: trackBinds.length,
        // 曝光辅助现场复盘：state=ACTIVE & tier=1 & ev=-1.2 = 硬件补偿正常工作；
        // tier=0 = 设备不支持走软件兜底（照片预览仍过曝是预期）；fails>0 = 约束在失败/超时
        exposure: {
          state: expAssist.state,
          ev: expAssist.ev,
          tier: expAssist.tier,
          sceneMean: expAssist.lastSceneMean,
          subjectMean: expAssist.lastSubjectMean,
          subjectRatio: expAssist.lastSubjectRatio,
          adjusts: expAssist.adjusts,
          fails: expAssist.fails
        }
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
      // 同步单次采样（对外契约不变，供测试与旧调用点使用）
      isBlackFrame: isBlackFrame,
      // 异步复采：拍照前应使用这个，瞬时黑帧不再误拒
      confirmBlackFrame: confirmBlackFrame,
      openPrivacySettings: openPrivacySettings,
      // 供单测/渲染层读取
      getState: function () { return state; },
      getError: function () { return error; },
      getStream: function () { return stream; },
      getTrack: function () { return activeTrack(); },
      getResolution: function () { return resolution; },
      // 请求档位 / 实际档位 / 来源（pref 记忆命中 | already 开流即最高档 | ladder 逐档锁定 | none 未锁定）
      getResolutionInfo: function () {
        return { request: resolutionRequest, actual: resolution, source: resolutionSource };
      },
      getSeq: function () { return seq; },
      getAttempt: function () { return attempt; },
      snapshot: snapshot,
      // 单入口（暴露出来便于断言 I1/I6）
      releaseActive: releaseActive,
      attachStream: attachStream,
      // 曝光辅助（黑色衣物过曝防护）：渲染层据此显示徽标与做软件兜底
      getExposureInfo: function () {
        return {
          state: expAssist.state,
          ev: expAssist.ev,
          appliedEv: expAssist.actualEv,   // 缺陷 2：实际生效 EV（徽标据此诚实展示）
          tier: expAssist.tier,
          sceneMean: expAssist.lastSceneMean,
          subjectMean: expAssist.lastSubjectMean,
          adjusts: expAssist.adjusts,
          fails: expAssist.fails
        };
      },
      onExposureChange: function (cb) { return on('exposure', cb); },
      // 生命周期由控制器自管理（attemptOnce / handleTrackUnmuted / releaseActive
      // 内部调用）；暴露出来仅为单测驱动，渲染层不调用
      startExposureAssist: startExposureAssist,
      stopExposureAssist: stopExposureAssist,
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
    classifyError: classifyError,
    // 分辨率锁定（纯函数，供单测直接断言）
    buildResolutionLadder: buildResolutionLadder,
    normalizeResolution: normalizeResolution,
    parseResolutionPref: parseResolutionPref,
    makeResolutionPref: makeResolutionPref,
    buildResolutionConstraints: buildResolutionConstraints,
    RES_PREF_VERSION: RES_PREF_VERSION,
    STANDARD_RATINGS: STANDARD_RATINGS,
    // 曝光辅助（黑色衣物过曝防护）：纯函数供单测直接断言
    computeGridStats: computeGridStats,
    classifyExposureGrid: classifyExposureGrid,
    stepAssistHysteresis: stepAssistHysteresis,
    nextEvStep: nextEvStep,
    pickExposurePlan: pickExposurePlan,
    buildExposureConstraints: buildExposureConstraints,
    buildExposureRestoreConstraints: buildExposureRestoreConstraints,
    buildExposureLut: buildExposureLut,
    // 幽灵能力检测（§7.5）：判定参数表 + 三个纯函数
    EXP_EFFECT: EXP_EFFECT,
    // 幽灵记忆的记账门槛（§7.5 DEF-5 方案①）：同一设备同一档位累计判无效这么多次才记账
    EXP_GHOST: EXP_GHOST,
    expectedDropRatio: expectedDropRatio,
    judgeExposureEffect: judgeExposureEffect,
    appliedEvOf: appliedEvOf,
    demoteExposurePlan: demoteExposurePlan,
    // sRGB 编码指数（§7.3 LUT 与 §7.5 判定共用同一个常量）
    SRGB_GAMMA: SRGB_GAMMA,
    solveTier0Ev: solveTier0Ev
  };
});
