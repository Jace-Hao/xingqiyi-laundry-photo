'use strict';

/**
 * 激活码算法（共享模块）：
 * - 软件与「激活码计算工具」必须使用本模块，保证两端算法一致。
 * - 机器码：由本机硬件特征派生的 16 位字符（4 组 × 4 位），每台电脑唯一。
 * - 激活码：由机器码派生的「XQY-XXXX-XXXX-XXXX」，与机器码一一绑定。
 * - 无激活码时可试用 7 天，从首次启动开始计算。
 */

const crypto = require('crypto');
const os = require('os');

const SECRET = 'xingqiyi-laundry-photo-license-v1';
// 去除易混淆字符（0/O/1/I）的字符集
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TRIAL_DAYS = 7;

function toCharset(hex, len) {
  let out = '';
  for (let i = 0; i < len; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    out += CHARSET[byte % CHARSET.length];
  }
  return out;
}

function group(s) {
  return s.replace(/(.{4})(?=.)/g, '$1-');
}

/** 生成本机机器码（每台电脑唯一） */
function genMachineCode() {
  const material = [
    os.hostname(),
    os.platform(),
    String(os.totalmem()),
    (os.cpus()[0] || {}).model || 'cpu'
  ].join('|');
  const hex = crypto.createHmac('sha256', SECRET + ':machine').update(material).digest('hex');
  return group(toCharset(hex, 16));
}

/** 由机器码生成激活码 */
function genActivationCode(machineCode) {
  const normalized = String(machineCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (normalized.length !== 16) throw new Error('机器码格式不正确（应为 16 位字符）');
  const hex = crypto.createHmac('sha256', SECRET + ':activation').update(normalized).digest('hex');
  return 'XQY-' + group(toCharset(hex, 12));
}

/** 校验激活码是否与机器码匹配 */
function verifyActivationCode(machineCode, activationCode) {
  try {
    const expected = genActivationCode(machineCode);
    const input = String(activationCode || '').toUpperCase().replace(/\s+/g, '');
    return input.length > 0 && input === expected.replace(/\s+/g, '');
  } catch (e) {
    return false;
  }
}

module.exports = { genMachineCode, genActivationCode, verifyActivationCode, TRIAL_DAYS };
