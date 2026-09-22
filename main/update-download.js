'use strict';
/**
 * 更新下载核心：多地址自动降级下载（GitHub 直连 → 国内加速通道）。
 *
 * 适用场景：GitHub 直连不稳定（连接失败、中途断流、速度过慢）时，
 * 自动切换到国内加速地址重试，直至某一个地址完整下载成功。
 *
 * 规则：
 * - 每次尝试独立超时：响应头 connectTimeoutMs / 数据间断流 idleTimeoutMs；
 * - 首段速度探测：进入下载 slowProbeMs 后、仍有后备地址、且收到字节低于
 *   slowProbeBytes 时视为「过慢」，切换到下一地址（仅当存在后备地址时启用）；
 * - 用户取消（外部 signal）立即中止，且不再尝试后续地址；
 * - 只依赖 fs 与传入的 fetchImpl（应用中使用 Electron net.fetch），便于测试注入。
 */

const fs = require('fs');

const DEFAULT_CONFIG = {
  connectTimeoutMs: 12000, // 等待响应头（含重定向）
  idleTimeoutMs: 15000, // 数据流中断判定
  slowProbeMs: 25000, // 首段速度探测窗口
  slowProbeBytes: 256 * 1024 // 窗口内低于该字节数视为过慢
};

function cleanupSignal(signal, handler) {
  try {
    if (signal && handler) signal.removeEventListener('abort', handler);
  } catch (e) {
    /* 忽略 */
  }
}

/**
 * 单地址下载尝试（写入 destPart）。
 * @returns {Promise<{status:'done',bytes:number,total:number}|{status:'canceled'}|{status:'failed',reason:string,message:string}>}
 */
function downloadOne(url, destPart, opts) {
  return new Promise((resolve) => {
    const fetchImpl = opts.fetchImpl;
    const signal = opts.signal;
    const onProgress = opts.onProgress;
    const connectTimeoutMs = opts.connectTimeoutMs || DEFAULT_CONFIG.connectTimeoutMs;
    const idleTimeoutMs = opts.idleTimeoutMs || DEFAULT_CONFIG.idleTimeoutMs;
    const slowProbeMs = opts.slowProbeMs || DEFAULT_CONFIG.slowProbeMs;
    const slowProbeBytes = opts.slowProbeBytes || DEFAULT_CONFIG.slowProbeBytes;
    const applySlowProbe = !!opts.applySlowProbe;

    let settled = false;
    let userAborted = false;
    let timedOut = false;
    let tooSlow = false;
    let connectTimer = null;
    let idleTimer = null;
    let probeTimer = null;
    let out = null;

    const cleanup = () => {
      if (connectTimer) clearTimeout(connectTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (probeTimer) clearInterval(probeTimer);
      connectTimer = idleTimer = probeTimer = null;
      cleanupSignal(signal, onOuterAbort);
      try {
        if (out && !out.writableEnded) out.destroy();
      } catch (e) {
        /* 忽略 */
      }
    };
    const done = (r) => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(r);
      }
    };
    const fail = (reason, message) => done({ status: 'failed', reason, message });
    const abortAttempt = () => {
      try {
        ctrl.abort();
      } catch (e) {
        /* 忽略 */
      }
    };
    function onOuterAbort() {
      userAborted = true;
      abortAttempt();
    }

    const ctrl = new AbortController();
    if (signal) {
      if (signal.aborted) userAborted = true;
      else signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    if (userAborted) return done({ status: 'canceled' });

    connectTimer = setTimeout(() => {
      timedOut = true;
      abortAttempt();
    }, connectTimeoutMs);

    fetchImpl(url, { signal: ctrl.signal, headers: { 'User-Agent': 'xingqiyi-laundry-photo' } })
      .then((resp) => {
        if (settled) return;
        if (!resp.ok || !resp.body) {
          if (userAborted) return done({ status: 'canceled' });
          if (timedOut) return fail('timeout', '连接超时');
          return fail('http', '服务器返回状态 ' + resp.status);
        }
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        const total = Number(resp.headers.get('content-length')) || 0;
        let received = 0;
        const startedAt = Date.now();
        if (applySlowProbe) {
          probeTimer = setInterval(() => {
            if (Date.now() - startedAt >= slowProbeMs && received < slowProbeBytes) {
              tooSlow = true;
              abortAttempt();
            }
          }, 1000);
        }
        const resetIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            timedOut = true;
            abortAttempt();
          }, idleTimeoutMs);
        };
        resetIdle();

        let writeErr = null;
        out = fs.createWriteStream(destPart);
        out.on('error', (e) => {
          writeErr = writeErr || e;
          abortAttempt();
        });

        (async () => {
          try {
            for await (const chunk of resp.body) {
              resetIdle();
              received += chunk.length;
              out.write(chunk);
              if (typeof onProgress === 'function') onProgress(received, total);
            }
            if (writeErr) return fail('write', '写入文件失败：' + (writeErr.message || writeErr));
            if (userAborted) return done({ status: 'canceled' });
            if (tooSlow) return fail('slow', '下载速度过慢');
            if (timedOut) return fail('timeout', '数据中断（长时间无响应）');
            out.end((e) => {
              if (e) return fail('write', '写入文件失败：' + (e.message || e));
              done({ status: 'done', bytes: received, total });
            });
          } catch (e) {
            if (userAborted) return done({ status: 'canceled' });
            if (tooSlow) return fail('slow', '下载速度过慢');
            if (timedOut) return fail('timeout', '连接超时或数据中断');
            fail('net', (e && e.message) || String(e));
          }
        })();
      })
      .catch((e) => {
        if (settled) return;
        if (userAborted) return done({ status: 'canceled' });
        if (timedOut) return fail('timeout', '连接超时');
        fail('net', (e && e.message) || String(e));
      });
  });
}

/**
 * 多地址自动降级下载。
 * @param {Object} p
 * @param {Array<{url:string,channel:string}>} p.candidates 候选地址（按优先级，channel: direct/accel/lan）
 * @param {string} p.destPart 写入的临时文件路径（.part）
 * @param {Function} p.fetchImpl fetch 实现（Electron net.fetch / 测试注入）
 * @param {AbortSignal} [p.signal] 外部取消信号
 * @param {Function} [p.onProgress] (received, total, channel)
 * @param {Function} [p.onAttempt] (index, count, candidate)（尝试开始）
 * @param {Object} [p.config] 超时配置覆盖（测试用）
 * @returns {Promise<{ok:true,bytes:number,channel:string}|{ok:false,canceled?:boolean,message:string}>}
 */
async function downloadWithFallback(p) {
  const candidates = p.candidates;
  const destPart = p.destPart;
  const fetchImpl = p.fetchImpl;
  const signal = p.signal;
  const onProgress = p.onProgress;
  const onAttempt = p.onAttempt;
  const config = Object.assign({}, DEFAULT_CONFIG, p.config || {});
  if (!Array.isArray(candidates) || !candidates.length) return { ok: false, message: '下载地址无效' };

  let lastError = null;
  for (let i = 0; i < candidates.length; i++) {
    if (signal && signal.aborted) return { ok: false, canceled: true, message: '已取消下载' };
    const cand = candidates[i];
    if (typeof onAttempt === 'function') onAttempt(i, candidates.length, cand);
    const res = await downloadOne(cand.url, destPart, {
      fetchImpl,
      signal,
      onProgress: typeof onProgress === 'function' ? (r, t) => onProgress(r, t, cand.channel) : undefined,
      connectTimeoutMs: config.connectTimeoutMs,
      idleTimeoutMs: config.idleTimeoutMs,
      slowProbeMs: config.slowProbeMs,
      slowProbeBytes: config.slowProbeBytes,
      applySlowProbe: i < candidates.length - 1
    });
    if (res.status === 'done') return { ok: true, bytes: res.bytes, channel: cand.channel };
    if (res.status === 'canceled') return { ok: false, canceled: true, message: '已取消下载' };
    lastError = res;
  }
  const base = lastError ? lastError.message || lastError.reason : '未知错误';
  const suffix = candidates.length > 1 ? '（已自动尝试直连与加速通道）' : '';
  return { ok: false, message: '下载失败：' + base + suffix };
}

module.exports = { downloadWithFallback, DEFAULT_CONFIG };
