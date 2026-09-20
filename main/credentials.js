'use strict';

/**
 * 登录凭据保存（记住账号 / 记住密码）
 *
 * 安全设计（重要）：
 * - 密码**永不**明文落盘。仅当系统级凭据保护可用（Electron safeStorage：
 *   Windows 用 DPAPI、macOS 用 Keychain）时才保存密码，保存的是加密后的 base64。
 * - 加密不可用时**不降级为明文**，只记住账号名并明确告知原因。
 *   静默降级等于在部分机器上留后门，这是本模块刻意避免的。
 * - 解密失败（系统凭据变更、文件被篡改）时返回空密码与原因，不回退到任何猜测值。
 * - 本模块不写日志、不打印密码；调用方也不得记录 password 字段。
 *
 * 依赖注入（safeStorage / filePath / now）便于在无 Electron 环境下测试。
 */

const fs = require('fs');
const path = require('path');

/** 最多记住的账号数，超出按最近登录时间裁剪，避免文件无限增长 */
const MAX_SAVED = 20;
const FILE_VERSION = 1;

function createCredentialStore({ filePath, safeStorage, now }) {
  const clock = typeof now === 'function' ? now : () => new Date().toISOString();

  function readAll() {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!raw || !Array.isArray(raw.accounts)) return { version: FILE_VERSION, accounts: [] };
      // 丢弃结构非法的条目，避免脏数据导致后续读写异常
      const accounts = raw.accounts.filter(
        (a) => a && typeof a.username === 'string' && a.username.trim()
      );
      return { version: raw.version || FILE_VERSION, accounts };
    } catch (e) {
      // 文件不存在或损坏时按空处理，不影响登录流程
      return { version: FILE_VERSION, accounts: [] };
    }
  }

  function writeAll(data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // 先写临时文件再原子改名，避免写入中断留下半个文件
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  }

  /** 系统级凭据保护是否可用（不可用时只记账号名） */
  function passwordSupported() {
    try {
      return !!(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable());
    } catch (e) {
      return false;
    }
  }

  function encryptPassword(plain) {
    return safeStorage.encryptString(String(plain)).toString('base64');
  }

  function decryptPassword(b64) {
    return safeStorage.decryptString(Buffer.from(String(b64), 'base64'));
  }

  function findAccount(accounts, username) {
    const u = String(username || '').trim().toLowerCase();
    return accounts.find((a) => String(a.username).toLowerCase() === u) || null;
  }

  /**
   * 列出已保存账号（供登录页下拉选择）。
   * 不返回密文，只返回元信息与「是否已保存密码」标记，避免密文流到界面层。
   */
  function list() {
    return readAll()
      .accounts.map((a) => ({
        username: a.username,
        name: a.name || '',
        store: a.store || '',
        role: a.role || '',
        hasPassword: !!a.encPassword,
        savedAt: a.savedAt || '',
        lastLoginAt: a.lastLoginAt || ''
      }))
      .sort((x, y) => String(y.lastLoginAt || '').localeCompare(String(x.lastLoginAt || '')));
  }

  /**
   * 保存（或更新）一个账号。
   * @param {object} p { username, password, name, store, role, rememberPassword }
   *   - rememberPassword=false 时清除该账号已保存的密码（只留账号名）
   *   - password 为空且 rememberPassword 非 false 时保留原有密码
   * @returns {{ saved:boolean, hasPassword:boolean, notice:string }}
   *   notice 为「密码未能保存」的用户可读原因，空字符串表示无异常
   */
  function save(p = {}) {
    const username = String(p.username || '').trim();
    if (!username) throw new Error('缺少账号名，无法保存');

    const data = readAll();
    const accounts = data.accounts;
    const existing = findAccount(accounts, username);
    const rememberPassword = p.rememberPassword !== false;
    const plainPassword = p.password === undefined || p.password === null ? '' : String(p.password);

    let encPassword = existing ? existing.encPassword || null : null;
    let notice = '';

    if (!rememberPassword) {
      // 用户取消记住密码：必须清掉已保存的密文，而不是保留旧的
      encPassword = null;
    } else if (plainPassword) {
      if (passwordSupported()) {
        try {
          encPassword = encryptPassword(plainPassword);
        } catch (e) {
          encPassword = null;
          notice = '密码加密失败，本次仅记住账号名';
        }
      } else {
        // 刻意不降级为明文：宁可只记账号名，也不留明文凭据
        encPassword = null;
        notice = '系统凭据保护不可用，本次仅记住账号名（不会以明文保存密码）';
      }
    }

    const entry = {
      username,
      name: String(p.name || (existing && existing.name) || ''),
      store: String(p.store || (existing && existing.store) || ''),
      role: String(p.role || (existing && existing.role) || ''),
      encPassword,
      savedAt: existing && existing.savedAt ? existing.savedAt : clock(),
      lastLoginAt: clock()
    };

    const idx = existing ? accounts.indexOf(existing) : -1;
    if (idx >= 0) accounts[idx] = entry;
    else accounts.push(entry);

    // 按最近登录排序后裁剪，保证被裁掉的是最久未用的账号
    accounts.sort((a, b) => String(b.lastLoginAt || '').localeCompare(String(a.lastLoginAt || '')));
    writeAll({ version: FILE_VERSION, accounts: accounts.slice(0, MAX_SAVED) });

    return { saved: true, hasPassword: !!entry.encPassword, notice };
  }

  /**
   * 读取某账号已保存的密码（用于登录页自动填充）。
   * 返回空 password 表示没有可用密码；error 说明原因。
   */
  function get(username) {
    const a = findAccount(readAll().accounts, username);
    if (!a) return null;
    const out = { username: a.username, name: a.name || '', password: '', error: '' };
    if (!a.encPassword) return out;
    try {
      out.password = decryptPassword(a.encPassword);
    } catch (e) {
      // 解密失败常见于系统凭据变更或文件被篡改：如实告知，不用任何兜底值
      out.error = '已保存的密码无法解密（系统凭据可能已变更），请手动输入密码';
    }
    return out;
  }

  /** 删除单个已保存账号；返回是否真的删除了 */
  function remove(username) {
    const data = readAll();
    const before = data.accounts.length;
    const target = findAccount(data.accounts, username);
    if (!target) return false;
    data.accounts = data.accounts.filter((a) => a !== target);
    if (data.accounts.length === before) return false;
    writeAll(data);
    return true;
  }

  /** 清空全部已保存凭据（含密文） */
  function clear() {
    writeAll({ version: FILE_VERSION, accounts: [] });
    return true;
  }

  return { list, save, get, remove, clear, passwordSupported, filePath, MAX_SAVED };
}

module.exports = { createCredentialStore, MAX_SAVED };
