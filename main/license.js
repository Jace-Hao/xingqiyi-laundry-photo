'use strict';

/**
 * 激活码算法（共享模块）：
 * - 软件与「激活码计算工具」必须使用同一套算法与密钥，保证两端结果一致。
 * - 机器码：由本机硬件特征派生的 16 位字符（4 组 × 4 位），每台电脑唯一。
 * - 激活码：由机器码派生的「XQY-XXXX-XXXX-XXXX」，与机器码一一绑定。
 * - 无激活码时可试用 7 天，从首次启动开始计算。
 *
 * 【密钥为何不写在本文件】
 * 本文件随代码仓库公开分发，任何硬编码在此的密钥都等于公开密钥，
 * 历史版本的密钥正是这样泄露的。实际密钥存放在 main/license-secret.json，
 * 该文件已被 .gitignore 忽略：对外只随安装包分发（打包规则包含 main/**），
 * 对维护者则私下传递，不进入任何公开仓库或文档。
 *
 * 密钥缺失时本模块不静默放行，而是抛出明确错误，由调用方决定降级提示，
 * 避免「删掉密钥文件即可绕过激活」的退化行为。
 */

const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');

const SECRET_FILE = path.join(__dirname, 'license-secret.json');
// 去除易混淆字符（0/O/1/I）的字符集
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TRIAL_DAYS = 7;

let cachedSecret = null;
let secretResolved = false;

/** 读取激活密钥；缺失或过短时返回 null，不抛异常 */
function loadSecret() {
  if (secretResolved) return cachedSecret;
  secretResolved = true;
  try {
    const raw = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8'));
    const s = String((raw && raw.secret) || '').trim();
    cachedSecret = s.length >= 16 ? s : null;
  } catch (e) {
    cachedSecret = null;
  }
  return cachedSecret;
}

/** 密钥是否可用（供调用方判断能否展示激活入口） */
function isSecretAvailable() {
  return !!loadSecret();
}

function requireSecret() {
  const s = loadSecret();
  if (!s) {
    throw new Error('激活密钥未配置：缺少 main/license-secret.json，请联系软件维护者获取');
  }
  return s;
}

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

/** 生成本机机器码（每台电脑唯一；依赖密钥，密钥更换后机器码会变化） */
function genMachineCode() {
  const secret = requireSecret();
  const material = [
    os.hostname(),
    os.platform(),
    String(os.totalmem()),
    (os.cpus()[0] || {}).model || 'cpu'
  ].join('|');
  const hex = crypto.createHmac('sha256', secret + ':machine').update(material).digest('hex');
  return group(toCharset(hex, 16));
}

/** 由机器码生成激活码 */
function genActivationCode(machineCode) {
  const secret = requireSecret();
  const normalized = String(machineCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (normalized.length !== 16) throw new Error('机器码格式不正确（应为 16 位字符）');
  const hex = crypto.createHmac('sha256', secret + ':activation').update(normalized).digest('hex');
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

module.exports = {
  genMachineCode,
  genActivationCode,
  verifyActivationCode,
  isSecretAvailable,
  TRIAL_DAYS
};
