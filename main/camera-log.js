'use strict';

/**
 * 摄像头诊断日志（RC-9：打包后无控制台，现场「黑屏」无法复盘）
 *
 * 设计原则（任何一条被破坏都会让日志反过来影响拍照主流程）：
 * 1. 只追加、不阻塞：写入走内存队列 + setImmediate 异步落盘，绝不在
 *    取流/拍照的同步路径上做 fs 读写。
 * 2. 静默降级：目录不可写、磁盘满、权限不足一律停用日志并只告警一次，
 *    绝不让 cameraLog.write() 把异常抛回调用方（渲染层或权限回调）。
 * 3. 体量可控：单文件 2 MB 轮转（旧文件另存 .1）、按天切文件、保留 7 天、
 *    队列上限 400 行（超出丢最旧），避免日志本身把磁盘写满。
 * 4. 单行 JSON：便于 grep 与事后解析；固定 9 字段恒定存在（缺项写 null）。
 *
 * 只依赖 node 内置模块，可在纯 Node 环境里单测（scripts/verify-camera-log.js）。
 */

const fs = require('fs');
const path = require('path');

// 单文件轮转阈值：达到即把当前文件另存为 .1，重新写新文件
const MAX_FILE_BYTES = 2 * 1024 * 1024;
// 保留天数：启动时清理超过该时长的历史日志
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
// 待写队列上限：极端情况下（磁盘卡死）防止内存无限增长
const MAX_PENDING_LINES = 400;
// 连续写入失败多少次后彻底停用（避免每条日志都重试一遍 IO）
const MAX_CONSECUTIVE_FAILS = 3;
// 字符串字段截断长度：错误文案可能很长，只留够定位用的部分
const MAX_ERR_MESSAGE = 300;
const MAX_SHORT_FIELD = 64;
const MAX_EXTRA_LEN = 200;
// 允许的附加字段个数（固定 9 字段之外，仅收原始类型，对象/数组一律丢弃）
const MAX_EXTRA_KEYS = 6;

// 固定字段：始终存在、顺序固定，缺项写 null，绝不省略键
const FIXED_KEYS = ['ts', 'level', 'event', 'seq', 'device', 'attempt', 'reason', 'err', 'res'];
const LEVELS = ['info', 'warn', 'error'];
const FILE_RE = /^camera-(\d{8})\.log(\.\d+)?$/;

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function dayKey(d) {
  return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
}

/** 数字字段：非有限数一律归 null，避免 NaN/Infinity 破坏 JSON */
function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/** 短字符串字段：空串归一为 null，超长截断 */
function shortStr(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (!s) return null;
  return s.length > MAX_SHORT_FIELD ? s.slice(0, MAX_SHORT_FIELD) : s;
}

/** deviceId 只记前 8 位：够区分设备，又不把完整设备标识写进日志 */
function deviceOf(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (!s) return null;
  return s.slice(0, 8);
}

/** err 恒为 { name, message } 或 null；传字符串时按 message 收 */
function errOf(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    const m = v.slice(0, MAX_ERR_MESSAGE);
    return m ? { name: null, message: m } : null;
  }
  if (typeof v !== 'object') return null;
  const message = v.message === null || v.message === undefined
    ? null
    : String(v.message).slice(0, MAX_ERR_MESSAGE);
  const name = v.name === null || v.name === undefined ? null : String(v.name).slice(0, MAX_SHORT_FIELD);
  if (!message && !name) return null;
  return { name: name, message: message };
}

/** res 恒为 { w, h } 或 null；两个数都取不到时整体为 null */
function resOf(v) {
  if (!v || typeof v !== 'object') return null;
  const w = num(v.w);
  const h = num(v.h);
  if (w === null && h === null) return null;
  return { w: w, h: h };
}

/**
 * 组装一行日志。任何异常都被吞掉 —— 日志格式出错也不该影响调用方。
 * 附加字段只收原始类型且跳过 __proto__ 等危险键，防止原型污染与日志膨胀。
 */
function buildLine(level, event, fields) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const rec = {
    ts: new Date().toISOString(),
    level: LEVELS.indexOf(level) >= 0 ? level : 'info',
    event: shortStr(event) || 'CAM_UNKNOWN',
    seq: num(f.seq),
    device: deviceOf(f.device),
    attempt: num(f.attempt),
    reason: shortStr(f.reason),
    err: errOf(f.err),
    res: resOf(f.res)
  };
  let extra = 0;
  for (const k of Object.keys(f)) {
    if (extra >= MAX_EXTRA_KEYS) break;
    if (FIXED_KEYS.indexOf(k) >= 0) continue;
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (k.length > MAX_SHORT_FIELD) continue;
    const v = f[k];
    if (v === null || v === undefined) {
      rec[k] = null;
    } else if (typeof v === 'string') {
      rec[k] = v.slice(0, MAX_EXTRA_LEN);
    } else if (typeof v === 'number') {
      rec[k] = isFinite(v) ? v : null;
    } else if (typeof v === 'boolean') {
      rec[k] = v;
    } else {
      continue; // 对象/数组不入日志（例如整个 DOMException、设备列表）
    }
    extra++;
  }
  return JSON.stringify(rec);
}

/**
 * 创建一个日志实例。
 * @param {object} options
 * @param {string} options.dir 日志目录（<userData>/logs）
 */
function createCameraLog(options) {
  const dir = options && options.dir ? options.dir : '';
  let initialized = false;
  let disabled = !dir;
  let currentDay = '';
  let currentFile = '';
  let currentBytes = 0;
  let queue = [];
  let draining = false;
  let failCount = 0;
  let warned = false;

  function warn(msg) {
    if (warned) return;
    warned = true;
    try {
      console.warn('[camera-log] ' + msg);
    } catch (e) {
      /* console 不可用时也不抛 */
    }
  }

  /** 期望的当日文件路径（即使目录不可用也返回，供客服取证时定位） */
  function fileForDay(day) {
    return path.join(dir, 'camera-' + day + '.log');
  }

  /** 清理超过保留期的历史日志：只在初始化时做一次，失败不影响写日志 */
  function cleanupOldFiles() {
    try {
      const names = fs.readdirSync(dir);
      const now = Date.now();
      for (const name of names) {
        const m = FILE_RE.exec(name);
        if (!m) continue;
        const d = m[1];
        const t = Date.parse(d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8) + 'T00:00:00');
        if (!isFinite(t)) continue;
        if (now - t > RETAIN_MS) {
          try {
            fs.unlinkSync(path.join(dir, name));
          } catch (e) {
            /* 单个文件删不掉不影响其余 */
          }
        }
      }
    } catch (e) {
      /* 目录读不到就算了 */
    }
  }

  /** 建目录 + 清理历史：只尝试一次，失败即永久停用 */
  function ensureReady() {
    if (disabled) return false;
    if (initialized) return true;
    initialized = true;
    try {
      fs.mkdirSync(dir, { recursive: true });
      cleanupOldFiles();
      return true;
    } catch (e) {
      disabled = true;
      queue = [];
      warn('日志目录不可用，摄像头日志已停用（不影响拍照）：' + ((e && e.message) || e));
      return false;
    }
  }

  function syncSize() {
    try {
      currentBytes = fs.statSync(currentFile).size;
    } catch (e) {
      currentBytes = 0;
    }
  }

  /** 轮转：当前文件另存为 .1（覆盖旧 .1），新文件从头写 */
  function rotate() {
    const backup = currentFile + '.1';
    try {
      if (fs.existsSync(backup)) fs.unlinkSync(backup);
    } catch (e) {
      /* 删不掉就尝试直接改名，改名失败则继续追加 */
    }
    try {
      fs.renameSync(currentFile, backup);
      currentBytes = 0;
    } catch (e) {
      currentBytes = 0; // 改名失败也重置计数，避免每批都重试改名
    }
  }

  /** 切换/初始化当日文件（跨天自动换文件） */
  function useToday() {
    const day = dayKey(new Date());
    if (day === currentDay && currentFile) return;
    currentDay = day;
    currentFile = fileForDay(day);
    syncSize();
  }

  function append(lines) {
    useToday();
    let buf = Buffer.from(lines.join('\n') + '\n', 'utf8');
    if (currentBytes + buf.length > MAX_FILE_BYTES) {
      rotate();
      buf = Buffer.from(lines.join('\n') + '\n', 'utf8');
    }
    fs.appendFileSync(currentFile, buf);
    currentBytes += buf.length;
  }

  async function appendAsync(lines) {
    useToday();
    let buf = Buffer.from(lines.join('\n') + '\n', 'utf8');
    if (currentBytes + buf.length > MAX_FILE_BYTES) {
      rotate();
      buf = Buffer.from(lines.join('\n') + '\n', 'utf8');
    }
    await fs.promises.appendFile(currentFile, buf);
    currentBytes += buf.length;
  }

  async function drain() {
    try {
      while (queue.length) {
        const batch = queue;
        queue = [];
        if (!ensureReady()) {
          queue = [];
          return;
        }
        try {
          await appendAsync(batch);
          failCount = 0;
        } catch (e) {
          failCount++;
          warn('写入失败：' + ((e && e.message) || e));
          if (failCount >= MAX_CONSECUTIVE_FAILS) {
            disabled = true;
            queue = [];
            warn('连续写入失败，摄像头日志已停用（不影响拍照）');
            return;
          }
        }
      }
    } finally {
      draining = false;
    }
  }

  function schedule() {
    if (draining) return;
    draining = true;
    setImmediate(drain);
  }

  /**
   * 写一行日志。永不抛异常；返回是否已被接受（接受不等于已落盘）。
   * @param {'info'|'warn'|'error'} level
   * @param {string} event 事件名，见契约 §10 事件枚举
   * @param {object} [fields] seq/device/attempt/reason/err/res 及少量原始类型附加字段
   */
  function write(level, event, fields) {
    if (disabled) return false;
    try {
      const line = buildLine(level, event, fields);
      if (queue.length >= MAX_PENDING_LINES) queue.shift();
      queue.push(line);
      schedule();
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 退出前同步冲刷剩余队列（尽力而为，绝不让退出流程卡住） */
  function flushSync() {
    try {
      if (disabled || !queue.length) return;
      if (!ensureReady()) {
        queue = [];
        return;
      }
      const lines = queue;
      queue = [];
      append(lines);
    } catch (e) {
      /* 退出阶段静默 */
    }
  }

  return {
    /** 显式初始化（在 whenReady 里调用一次，避免首条日志时才建目录） */
    init: function () {
      try {
        return ensureReady();
      } catch (e) {
        disabled = true;
        return false;
      }
    },
    write: write,
    flushSync: flushSync,
    /** 当前（今日）日志文件路径 */
    currentPath: function () {
      return dir ? fileForDay(dayKey(new Date())) : '';
    },
    isDisabled: function () {
      return disabled;
    }
  };
}

module.exports = { createCameraLog, buildLine, dayKey, MAX_FILE_BYTES };
