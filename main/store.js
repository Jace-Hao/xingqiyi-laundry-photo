'use strict';

/**
 * 数据层：配置、存储、认证（会话令牌）、衣物存档（条形码索引）、用户管理、操作日志。
 * 与 Electron 解耦：
 * - 所有业务方法以会话令牌识别操作者（无全局会话状态），支持多客户端并发访问；
 * - 服务端节点通过 HTTP API 暴露本模块，客户端节点远程调用。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const license = require('./license');

// 请求来源上下文：服务端收到网络请求时把客户端 IP 存入这里，
// 写日志时自动读取，无需层层修改业务函数签名。
const requestContext = new AsyncLocalStorage();
// 本机（服务端界面或直接调用数据层）操作没有网络来源，统一记为本机地址
const LOCAL_IP = '127.0.0.1';

// 把 IPv6 映射地址（::ffff:192.168.1.5）还原为纯 IPv4，便于阅读
function normalizeIp(raw) {
  const ip = String(raw || '').trim();
  if (!ip) return LOCAL_IP;
  if (ip === '::1' || ip.toLowerCase() === 'localhost') return LOCAL_IP;
  return ip.replace(/^::ffff:/i, '');
}

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const genApiToken = () => crypto.randomBytes(6).toString('hex');

/** 在指定的来源 IP 上下文中执行一段逻辑，期间写入的日志都会带上该 IP */
function withRequestIp(ip, fn) {
  return requestContext.run({ ip: normalizeIp(ip) }, fn);
}

/** 读取当前请求来源 IP；不在网络请求上下文中时为本机地址 */
function currentRequestIp() {
  const ctx = requestContext.getStore();
  return normalizeIp(ctx && ctx.ip);
}

function createStore({ dataDir, defaultPhotoDir, updateDir, appVersion = '0.0.0', photoScheme = 'xqy-photo' }) {
  const CONFIG_FILE = path.join(dataDir, 'config.json');
  const USERS_FILE = path.join(dataDir, 'users.json');
  const RECORDS_FILE = path.join(dataDir, 'records.json');
  const LOGS_FILE = path.join(dataDir, 'logs.json');
  const SESSIONS_FILE = path.join(dataDir, 'sessions.json');
  const OFFLINE_QUEUE_FILE = path.join(dataDir, 'offline-queue.json');

  function readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return fallback;
    }
  }

  function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  const loadUsers = () => readJson(USERS_FILE, []);
  const saveUsers = (u) => writeJson(USERS_FILE, u);
  const loadRecords = () => readJson(RECORDS_FILE, []);
  const saveRecords = (r) => writeJson(RECORDS_FILE, r);
  const loadLogs = () => readJson(LOGS_FILE, []);
  const saveLogs = (l) => writeJson(LOGS_FILE, l);
  const loadSessions = () => readJson(SESSIONS_FILE, []);
  const saveSessions = (s) => writeJson(SESSIONS_FILE, s);

  // ---------- 配置 ----------
  const DEFAULT_CONFIG = () => ({
    mode: '',
    port: 17521,
    token: genApiToken(),
    photoDir: defaultPhotoDir,
    serverUrl: '',
    serverToken: '',
    updateSourceUrl: '',
    trialStartedAt: '',
    activation: null,
    // 强制推送安装包：{ enabled, version, fileName, at, by }
    forceUpdate: null
  });

  function loadConfig() {
    const c = readJson(CONFIG_FILE, null);
    if (!c) return DEFAULT_CONFIG();
    return { ...DEFAULT_CONFIG(), ...c };
  }

  function saveConfig(c) {
    writeJson(CONFIG_FILE, c);
  }

  const getPhotoDir = () => loadConfig().photoDir || defaultPhotoDir;

  // 照片 URL：photoFile 形如「条码目录/文件名.jpg」，整体编码后放入标准路径段。
  // 注意：不能放进 host 段——WHATWG URL 会把含子目录的 host 判为非法，导致解析为空、图片加载失败。
  const encodePhotoUrl = (file) => `${photoScheme}://photo/${encodeURIComponent(file)}`;

  // 把「条码目录/文件名」安全解析为照片根目录下的绝对路径（防穿越）
  function resolvePhotoFile(fileName) {
    const parts = String(fileName || '').split('/').filter(Boolean);
    if (!parts.length || parts.length > 2) return null;
    for (const seg of parts) {
      if (seg === '.' || seg === '..' || /[/\\:*?"<>|]/.test(seg)) return null;
    }
    return path.join(getPhotoDir(), ...parts);
  }

  // ---------- 密码 ----------
  function hashPassword(password, salt) {
    return crypto.scryptSync(String(password), salt, 64).toString('hex');
  }

  function verifyPassword(password, salt, expected) {
    const actual = Buffer.from(hashPassword(password, salt), 'hex');
    const exp = Buffer.from(expected, 'hex');
    return actual.length === exp.length && crypto.timingSafeEqual(actual, exp);
  }

  function publicUser(u) {
    const { passwordHash, salt, ...rest } = u;
    return rest;
  }

  // ---------- 操作日志 ----------
  function appendLog(entry) {
    const logs = loadLogs();
    // 来源 IP：网络请求取客户端地址，本机操作为 127.0.0.1
    logs.push({ id: uid(), time: now(), ip: currentRequestIp(), ...entry });
    saveLogs(logs);
  }

  const logBase = (u) => ({ userId: u.id, username: u.username, role: u.role });

  // ---------- 会话 ----------
  function createSession(userId) {
    const token = uid();
    const sessions = loadSessions();
    sessions.push({ token, userId, createdAt: now() });
    saveSessions(sessions);
    return token;
  }

  function removeSession(token) {
    saveSessions(loadSessions().filter((s) => s.token !== token));
  }

  // 镜像登录：客户端远程登录成功后，在本机建立同令牌的本地会话，
  // 使服务器失联时可直接用该令牌降级为本机操作，无需重新登录。
  function mirrorLogin(user, sessionToken) {
    const users = loadUsers();
    const entry = users.find((u) => u.username === user.username);
    if (!entry) return null;
    const sessions = loadSessions();
    if (!sessions.some((s) => s.token === sessionToken)) {
      sessions.push({ token: sessionToken, userId: entry.id, createdAt: now() });
      saveSessions(sessions);
    }
    return entry;
  }

  function getSessionUser(token) {
    if (!token) return null;
    const s = loadSessions().find((x) => x.token === token);
    if (!s) return null;
    const u = loadUsers().find((x) => x.id === s.userId);
    if (!u || !u.active) {
      removeSession(token);
      return null;
    }
    return u;
  }

  function requireSession(token) {
    const u = getSessionUser(token);
    if (!u) throw new Error('未登录或会话已失效，请重新登录');
    return u;
  }

  function requireSessionAdmin(token) {
    const u = requireSession(token);
    if (u.role !== 'admin') throw new Error('无权限：仅管理员可执行该操作');
    return u;
  }

  function requireSessionPermission(token, perm) {
    const u = requireSession(token);
    if (u.role === 'admin') return u;
    if (!u.permissions || !u.permissions[perm]) throw new Error('无权限：当前账号未开通该功能，请联系管理员');
    return u;
  }

  // ---------- 初始化 ----------
  function ensureSeedData() {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(getPhotoDir(), { recursive: true });
    saveConfig(loadConfig());
    const users = readJson(USERS_FILE, null);
    if (users === null) {
      const salt = crypto.randomBytes(16).toString('hex');
      const admin = {
        id: uid(),
        username: 'admin',
        name: '系统管理员',
        role: 'admin',
        salt,
        passwordHash: hashPassword('admin123', salt),
        permissions: { capture: true, query: true },
        active: true,
        createdAt: now(),
        lastLoginAt: null,
        createdBy: 'system'
      };
      saveUsers([admin]);
      appendLog({
        userId: admin.id,
        username: 'admin',
        role: 'admin',
        module: '系统',
        action: '初始化',
        detail: '首次启动，创建默认管理员账号 admin（初始密码 admin123）',
        result: '成功'
      });
    }

    // 旧版本数据迁移：早期记录以客户姓名索引，统一迁移为条形码索引并补编号
    const records = loadRecords();
    let migrated = false;
    for (const r of records) {
      if (!r.barcode) {
        r.barcode = String(r.customerName || '未命名').trim() || '未命名';
        delete r.customerName;
        migrated = true;
      }
    }
    const seqCounter = {};
    const sorted = [...records].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    for (const r of sorted) {
      seqCounter[r.barcode] = (seqCounter[r.barcode] || 0) + 1;
      if (r.seq !== seqCounter[r.barcode]) {
        r.seq = seqCounter[r.barcode];
        migrated = true;
      }
    }
    if (migrated) saveRecords(records);
  }

  // ---------- 认证 ----------
  function login({ username, password } = {}) {
    username = String(username || '').trim();
    const users = loadUsers();
    const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!user || !verifyPassword(password || '', user.salt, user.passwordHash)) {
      appendLog({
        userId: user ? user.id : null,
        username: username || '-',
        role: user ? user.role : '-',
        module: '认证',
        action: '登录失败',
        detail: `账号 ${username || '-'} 登录失败（账号不存在或密码错误）`,
        result: '失败'
      });
      throw new Error('账号不存在或密码错误');
    }
    if (!user.active) {
      appendLog({
        userId: user.id,
        username: user.username,
        role: user.role,
        module: '认证',
        action: '登录失败',
        detail: `账号 ${user.username} 已被停用，登录被拒绝`,
        result: '失败'
      });
      throw new Error('该账号已被停用，请联系管理员');
    }
    user.lastLoginAt = now();
    saveUsers(users);
    const sessionToken = createSession(user.id);
    appendLog({
      ...logBase(user),
      module: '认证',
      action: '登录',
      detail: `账号 ${user.username} 登录成功（进入${user.role === 'admin' ? '管理端' : '客户端'}）`,
      result: '成功'
    });
    return { user: publicUser(user), sessionToken };
  }

  function logout(token) {
    const u = getSessionUser(token);
    if (u) {
      appendLog({
        ...logBase(u),
        module: '认证',
        action: '退出登录',
        detail: `账号 ${u.username} 退出登录`,
        result: '成功'
      });
    }
    removeSession(token);
    return true;
  }

  const current = (token) => {
    const u = getSessionUser(token);
    return u ? publicUser(u) : null;
  };

  function changePassword(token, { oldPassword, newPassword } = {}) {
    const me = requireSession(token);
    if (!newPassword || String(newPassword).length < 6) throw new Error('新密码长度至少 6 位');
    const users = loadUsers();
    const user = users.find((u) => u.id === me.id);
    if (!verifyPassword(oldPassword || '', user.salt, user.passwordHash)) throw new Error('原密码不正确');
    user.salt = crypto.randomBytes(16).toString('hex');
    user.passwordHash = hashPassword(newPassword, user.salt);
    saveUsers(users);
    appendLog({
      ...logBase(user),
      module: '认证',
      action: '修改密码',
      detail: `账号 ${user.username} 修改了自己的登录密码`,
      result: '成功'
    });
    return true;
  }

  // ---------- 衣物照片存档（条形码索引） ----------
  function addRecord(token, p = {}) {
    const me = requireSessionPermission(token, 'capture');
    const barcode = String(p.barcode || '').trim();
    if (!barcode) throw new Error('请填写衣物条形码');
    if (barcode.length > 64) throw new Error('条形码过长（最多 64 位）');
    if (!p.imageData || !String(p.imageData).startsWith('data:image/')) throw new Error('缺少照片数据，请先拍摄');
    const base64 = String(p.imageData).split(',')[1];
    if (!base64) throw new Error('照片数据无效');

    const id = uid();
    const photoDir = getPhotoDir();
    // 按条码建立子文件夹；条码中不能用于目录名的字符替换为下划线
    const safeBarcode = barcode.replace(/[\\/:*?"<>|]/g, '_').slice(0, 64);
    const barcodeDir = path.join(photoDir, safeBarcode);
    fs.mkdirSync(barcodeDir, { recursive: true });
    // 文件名 = 拍摄时间精确到分钟（YYYYMMDDHHmm）；同一分钟内多张追加序号
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    let baseName = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`;
    let photoName = `${baseName}.jpg`;
    let n = 2;
    while (fs.existsSync(path.join(barcodeDir, photoName))) {
      photoName = `${baseName}-${n}.jpg`;
      n++;
    }
    fs.writeFileSync(path.join(barcodeDir, photoName), Buffer.from(base64, 'base64'));

    const records = loadRecords();
    const seq = records.filter((r) => r.barcode === barcode).length + 1;
    const record = {
      id,
      barcode,
      seq,
      userId: me.id,
      username: me.username,
      note: String(p.note || '').trim(),
      photoFile: `${safeBarcode}/${photoName}`,
      createdAt: now()
    };
    records.push(record);
    saveRecords(records);
    // 日志拆分：条码首次出现时记「新增条码」，照片一律记「新增存档照片」
    if (seq === 1) {
      appendLog({
        ...logBase(me),
        module: '衣物拍照',
        action: '新增条码',
        detail: `新增衣物条码档案：条码「${barcode}」`,
        result: '成功'
      });
    }
    appendLog({
      ...logBase(me),
      module: '衣物拍照',
      action: '新增存档照片',
      detail: `新增存档照片：条码「${barcode}」第 ${seq} 张`,
      result: '成功'
    });
    return { ...record, photoUrl: encodePhotoUrl(record.photoFile) };
  }

  function listRecords(token, p = {}) {
    const me = requireSessionPermission(token, 'query');
    const isAdmin = me.role === 'admin';
    let list = loadRecords();
    if (!isAdmin) list = list.filter((r) => r.userId === me.id);
    else if (p.userId && p.userId !== 'all') list = list.filter((r) => r.userId === p.userId);

    const barcodeFilter = String(p.barcode || '').trim().toLowerCase();
    if (barcodeFilter) list = list.filter((r) => String(r.barcode || '').toLowerCase() === barcodeFilter);

    const kw = String(p.keyword || '').trim().toLowerCase();
    if (kw) {
      list = list.filter((r) =>
        [r.barcode, r.note, r.username].some((v) => String(v || '').toLowerCase().includes(kw))
      );
    }
    if (p.dateFrom) list = list.filter((r) => r.createdAt >= new Date(p.dateFrom + 'T00:00:00').toISOString());
    if (p.dateTo) list = list.filter((r) => r.createdAt <= new Date(p.dateTo + 'T23:59:59.999').toISOString());

    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const total = list.length;
    const page = Math.max(1, Number(p.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(p.pageSize) || 12));
    const items = list
      .slice((page - 1) * pageSize, page * pageSize)
      .map((r) => ({ ...r, photoUrl: encodePhotoUrl(r.photoFile) }));

    if (!p.silent) {
      appendLog({
        ...logBase(me),
        module: isAdmin ? '数据查看' : '衣物查询',
        action: '查询记录',
        detail: `查询衣物存档：关键词「${kw || '无'}」，条码「${barcodeFilter || '无'}」，共 ${total} 条，第 ${page} 页`,
        result: '成功'
      });
    }
    return { items, total, page, pageSize };
  }

  function getRecord(token, id) {
    const me = requireSession(token);
    const r = loadRecords().find((x) => x.id === id);
    if (!r) throw new Error('记录不存在或已被删除');
    if (me.role !== 'admin' && r.userId !== me.id) throw new Error('无权限查看该记录');
    appendLog({
      ...logBase(me),
      module: me.role === 'admin' ? '数据查看' : '衣物查询',
      action: '查看记录',
      detail: `查看存档详情：条码「${r.barcode}」第 ${r.seq} 张（所属账号 ${r.username}）`,
      result: '成功'
    });
    return { ...r, photoUrl: encodePhotoUrl(r.photoFile) };
  }

  function deleteRecord(token, id) {
    const me = requireSession(token);
    const records = loadRecords();
    const idx = records.findIndex((r) => r.id === id);
    if (idx === -1) throw new Error('记录不存在或已被删除');
    const r = records[idx];
    if (me.role !== 'admin' && r.userId !== me.id) throw new Error('无权限删除该记录');
    records.splice(idx, 1);
    saveRecords(records);
    try {
      fs.unlinkSync(path.join(getPhotoDir(), r.photoFile));
    } catch (e) {
      /* 照片文件缺失不影响记录删除 */
    }
    appendLog({
      ...logBase(me),
      module: me.role === 'admin' ? '数据管理' : '衣物查询',
      action: '删除存档',
      detail: `删除衣物照片存档：条码「${r.barcode}」第 ${r.seq} 张（所属账号 ${r.username}）`,
      result: '成功'
    });
    return true;
  }

  // 批量删除：一次会话只写一次记录文件；权限逐条校验，返回成功条数
  function deleteRecords(token, ids) {
    const me = requireSession(token);
    const idSet = new Set(Array.isArray(ids) ? ids.map(String) : []);
    if (!idSet.size) throw new Error('未选择任何记录');
    if (idSet.size > 500) throw new Error('单次最多批量删除 500 条');
    const records = loadRecords();
    const kept = [];
    let deleted = 0;
    let skipped = 0;
    for (const r of records) {
      if (!idSet.has(r.id)) {
        kept.push(r);
        continue;
      }
      if (me.role !== 'admin' && r.userId !== me.id) {
        skipped++;
        continue;
      }
      try {
        fs.unlinkSync(path.join(getPhotoDir(), r.photoFile));
      } catch (e) {
        /* 照片文件缺失不影响记录删除 */
      }
      deleted++;
    }
    if (!deleted) throw new Error('没有可删除的记录（不存在或无权限）');
    saveRecords(kept);
    appendLog({
      ...logBase(me),
      module: me.role === 'admin' ? '数据管理' : '衣物查询',
      action: '批量删除存档',
      detail: `批量删除衣物照片存档 ${deleted} 条${skipped ? `，跳过无权限 ${skipped} 条` : ''}`,
      result: '成功'
    });
    return { deleted, skipped };
  }

  // ---------- 照片批量导出（按条码/订单号分文件夹保存） ----------
  const fmtPhotoTime = (iso) => {
    const d = new Date(iso || '');
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
  };

  // 把存档照片复制到用户选择的目录，按条码（订单号）建立子文件夹。
  // barcodes 为空数组时表示导出当前账号可见的全部记录。
  function exportPhotos(token, p = {}) {
    const me = requireSessionPermission(token, 'query');
    const targetDir = path.resolve(String((p && p.targetDir) || '').trim());
    if (!targetDir) throw new Error('请先选择保存目录');
    fs.mkdirSync(targetDir, { recursive: true });

    let barcodes = Array.isArray(p.barcodes)
      ? [...new Set(p.barcodes.map((x) => String(x || '').trim()).filter(Boolean))]
      : [];
    let records = loadRecords();
    const isAdmin = me.role === 'admin';
    // 客户端账号只能导出自己的存档
    if (!isAdmin) records = records.filter((r) => r.userId === me.id);
    if (barcodes.length) {
      const set = new Set(barcodes.map((b) => b.toLowerCase()));
      records = records.filter((r) => set.has(String(r.barcode || '').toLowerCase()));
    } else {
      barcodes = [...new Set(records.map((r) => String(r.barcode || '')))];
    }
    if (!records.length) throw new Error('没有符合条件的存档记录，无法导出');

    const photoDir = getPhotoDir();
    let exported = 0;
    let skipped = 0;
    let failed = 0;
    let folderCount = 0;
    for (const code of barcodes) {
      const group = records.filter((r) => String(r.barcode || '') === code);
      if (!group.length) continue;
      const safeCode = code.replace(/[\\/:*?"<>|]/g, '_').slice(0, 64) || '未命名';
      const dir = path.join(targetDir, safeCode);
      fs.mkdirSync(dir, { recursive: true });
      folderCount++;
      group.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
      for (const r of group) {
        const src = path.join(photoDir, r.photoFile);
        const ext = path.extname(r.photoFile) || '.jpg';
        const name = `${fmtPhotoTime(r.createdAt)}_第${r.seq}张${ext}`;
        try {
          fs.copyFileSync(src, path.join(dir, name));
          exported++;
        } catch (e) {
          if (fs.existsSync(src)) failed++;
          else skipped++;
        }
      }
    }
    appendLog({
      ...logBase(me),
      module: me.role === 'admin' ? '数据管理' : '记录查询',
      action: '批量导出照片',
      detail:
        `按条码文件夹批量导出衣物照片：${folderCount} 个文件夹、${exported} 张` +
        `${skipped ? `，照片文件缺失跳过 ${skipped} 张` : ''}${failed ? `，导出失败 ${failed} 张` : ''} → ${targetDir}`,
      result: '成功'
    });
    return { exported, skipped, failed, folders: folderCount, targetDir };
  }

  // ---------- 用户管理（管理端） ----------
  function listUsers(token) {
    requireSessionAdmin(token);
    return loadUsers()
      .map(publicUser)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  function createUser(token, p = {}) {
    const me = requireSessionAdmin(token);
    const username = String(p.username || '').trim();
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) throw new Error('用户名须为 3-20 位字母、数字或下划线');
    if (!p.password || String(p.password).length < 6) throw new Error('初始密码长度至少 6 位');
    const users = loadUsers();
    if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) throw new Error('用户名已存在');
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: uid(),
      username,
      name: String(p.name || '').trim() || username,
      role: p.role === 'admin' ? 'admin' : 'client',
      salt,
      passwordHash: hashPassword(p.password, salt),
      permissions: {
        capture: p.permissions ? !!p.permissions.capture : true,
        query: p.permissions ? !!p.permissions.query : true
      },
      active: true,
      createdAt: now(),
      lastLoginAt: null,
      createdBy: me.username
    };
    users.push(user);
    saveUsers(users);
    appendLog({
      ...logBase(me),
      module: '用户管理',
      action: '新增用户',
      detail: `创建账号 ${user.username}（${user.role === 'admin' ? '管理员' : '客户端'}，姓名：${user.name}）`,
      result: '成功'
    });
    return publicUser(user);
  }

  function updateUser(token, p = {}) {
    const me = requireSessionAdmin(token);
    const users = loadUsers();
    const user = users.find((u) => u.id === p.id);
    if (!user) throw new Error('账号不存在');
    const isSelf = user.id === me.id;
    const changes = [];

    if (p.role !== undefined && p.role !== user.role) {
      if (isSelf) throw new Error('不能修改自己的角色');
      user.role = p.role === 'admin' ? 'admin' : 'client';
      changes.push(`角色改为${user.role === 'admin' ? '管理员' : '客户端'}`);
    }
    if (p.name !== undefined && String(p.name).trim() && String(p.name).trim() !== user.name) {
      user.name = String(p.name).trim();
      changes.push(`姓名改为「${user.name}」`);
    }
    if (p.active !== undefined && p.active !== user.active) {
      if (isSelf && !p.active) throw new Error('不能停用自己的账号');
      user.active = !!p.active;
      changes.push(user.active ? '启用账号' : '停用账号');
    }
    if (p.permissions) {
      user.permissions = { capture: !!p.permissions.capture, query: !!p.permissions.query };
      changes.push(`权限改为「拍照:${user.permissions.capture ? '开' : '关'}/查询:${user.permissions.query ? '开' : '关'}」`);
    }
    if (p.newPassword) {
      if (String(p.newPassword).length < 6) throw new Error('重置密码长度至少 6 位');
      user.salt = crypto.randomBytes(16).toString('hex');
      user.passwordHash = hashPassword(p.newPassword, user.salt);
      changes.push('重置密码');
    }
    if (!changes.length) return publicUser(user);

    saveUsers(users);
    appendLog({
      ...logBase(me),
      module: '用户管理',
      action: p.newPassword && changes.length === 1 ? '重置密码' : '修改用户',
      detail: `修改账号 ${user.username}：${changes.join('；')}`,
      result: '成功'
    });
    return publicUser(user);
  }

  function deleteUser(token, id) {
    const me = requireSessionAdmin(token);
    if (id === me.id) throw new Error('不能删除自己的账号');
    const users = loadUsers();
    const idx = users.findIndex((u) => u.id === id);
    if (idx === -1) throw new Error('账号不存在');
    const [removed] = users.splice(idx, 1);
    saveUsers(users);
    // 一并清理该账号的会话
    saveSessions(loadSessions().filter((s) => s.userId !== id));
    appendLog({
      ...logBase(me),
      module: '用户管理',
      action: '删除用户',
      detail: `删除账号 ${removed.username}（姓名：${removed.name}）`,
      result: '成功'
    });
    return true;
  }

  // ---------- 日志查询（管理端） ----------
  function listLogs(token, p = {}) {
    const me = requireSessionAdmin(token);
    let list = loadLogs();
    if (p.userId && p.userId !== 'all') list = list.filter((l) => l.userId === p.userId);
    if (p.action && p.action !== 'all') list = list.filter((l) => l.action === p.action);
    const kw = String(p.keyword || '').trim().toLowerCase();
    if (kw) {
      list = list.filter((l) =>
        [l.username, l.module, l.action, l.detail, l.ip].some((v) => String(v || '').toLowerCase().includes(kw))
      );
    }
    if (p.dateFrom) list = list.filter((l) => l.time >= new Date(p.dateFrom + 'T00:00:00').toISOString());
    if (p.dateTo) list = list.filter((l) => l.time <= new Date(p.dateTo + 'T23:59:59.999').toISOString());

    list.sort((a, b) => b.time.localeCompare(a.time));
    const total = list.length;
    const page = Math.max(1, Number(p.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(p.pageSize) || 20));
    const items = list.slice((page - 1) * pageSize, page * pageSize);

    if (!p.silent) {
      appendLog({
        ...logBase(me),
        module: '日志查询',
        action: '查询日志',
        detail: `查询操作日志：关键词「${kw || '无'}」，共 ${total} 条，第 ${page} 页`,
        result: '成功'
      });
    }
    return { items, total, page, pageSize };
  }

  // ---------- 数据总览（管理端） ----------
  function overview(token) {
    requireSessionAdmin(token);
    const users = loadUsers();
    const records = loadRecords();
    const logs = loadLogs();
    const todayIso = now().slice(0, 10);
    const recentRecords = [...records]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 6)
      .map((r) => ({ ...r, photoUrl: encodePhotoUrl(r.photoFile) }));
    const recentLogs = [...logs].sort((a, b) => b.time.localeCompare(a.time)).slice(0, 8);
    return {
      userCount: users.length,
      activeUserCount: users.filter((u) => u.active).length,
      adminCount: users.filter((u) => u.role === 'admin').length,
      recordCount: records.length,
      todayRecordCount: records.filter((r) => r.createdAt.slice(0, 10) === todayIso).length,
      logCount: logs.length,
      recentRecords,
      recentLogs
    };
  }

  // ---------- 系统配置 ----------
  function systemInfo() {
    const c = loadConfig();
    return {
      mode: c.mode,
      port: c.port,
      token: c.token,
      photoDir: c.photoDir,
      serverUrl: c.serverUrl,
      updateSourceUrl: c.updateSourceUrl || '',
      // 远程连接服务器状态：前端据此禁用照片路径修改
      remoteClient: c.mode === 'client' && !!String(c.serverUrl || '').trim()
    };
  }

  // ---------- 激活与试用 ----------
  // 试用状态：activated（已激活）/ trial（试用中）/ expired（试用到期）
  function licenseStatus() {
    const c = loadConfig();
    const machineCode = license.genMachineCode();
    if (c.activation && license.verifyActivationCode(machineCode, c.activation.code)) {
      return {
        state: 'activated',
        machineCode,
        activationCode: c.activation.code,
        activatedAt: c.activation.at || '',
        trialDays: license.TRIAL_DAYS,
        trialDaysLeft: 0
      };
    }
    // 首次查询时开始计算试用期；同时校验激活码是否被拷贝到别的电脑
    if (!c.trialStartedAt) {
      c.trialStartedAt = now();
      saveConfig(c);
    }
    const started = new Date(c.trialStartedAt).getTime();
    const used = Math.floor((Date.now() - started) / 86400000);
    const left = Math.max(0, license.TRIAL_DAYS - used);
    const copied = !!(c.activation && c.activation.code);
    return {
      state: left > 0 ? 'trial' : 'expired',
      machineCode,
      activationCode: '',
      activatedAt: '',
      trialDays: license.TRIAL_DAYS,
      trialDaysLeft: left,
      copiedFromOtherMachine: copied
    };
  }

  function activate(code) {
    const machineCode = license.genMachineCode();
    if (!license.verifyActivationCode(machineCode, code)) {
      throw new Error('激活码无效或与本机不匹配，请核对机器码后重新获取');
    }
    const c = loadConfig();
    c.activation = { code: String(code).toUpperCase().replace(/\s+/g, ''), at: now(), machineCode };
    saveConfig(c);
    return licenseStatus();
  }

  function setMode(mode) {
    const c = loadConfig();
    c.mode = mode === 'client' ? 'client' : 'server';
    if (!c.token) c.token = genApiToken();
    saveConfig(c);
    return systemInfo();
  }

  function normalizeServerUrl(url) {
    let u = String(url || '').trim();
    if (!u) throw new Error('请填写服务器地址');
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    return u.replace(/\/+$/, '');
  }

  function setClientConfig(serverUrl, serverToken) {
    const c = loadConfig();
    c.mode = 'client';
    c.serverUrl = normalizeServerUrl(serverUrl);
    c.serverToken = String(serverToken || '').trim();
    if (!c.serverToken) throw new Error('请填写服务器连接码');
    saveConfig(c);
    return systemInfo();
  }

  function updateSystemSettings(token, { port } = {}) {
    const me = requireSessionAdmin(token);
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('端口须为 1-65535 的整数');
    const c = loadConfig();
    const oldPort = c.port;
    c.port = p;
    saveConfig(c);
    appendLog({
      ...logBase(me),
      module: '系统设置',
      action: '修改端口',
      detail: `服务端口由 ${oldPort} 修改为 ${p}`,
      result: '成功'
    });
    return systemInfo();
  }

  function resetApiToken(token) {
    const me = requireSessionAdmin(token);
    const c = loadConfig();
    c.token = genApiToken();
    saveConfig(c);
    appendLog({
      ...logBase(me),
      module: '系统设置',
      action: '重置连接码',
      detail: '重新生成了服务器连接码，客户端需使用新连接码重新配置',
      result: '成功'
    });
    return c.token;
  }

  // 是否为「远程连接服务器」的客户端：本机以客户端模式运行且已配置服务器地址。
  // 此状态下照片实际存放在服务器端，本机改路径既无意义又会造成两边目录不一致。
  const isRemoteClient = () => {
    const c = loadConfig();
    return c.mode === 'client' && !!String(c.serverUrl || '').trim();
  };

  function setPhotoPath(token, newPath) {
    const me = requireSessionAdmin(token);
    if (isRemoteClient()) {
      throw new Error('当前为远程连接服务器状态，照片由服务器统一管理，不可在本机修改照片保存位置。请在服务端电脑上修改。');
    }
    const target = path.resolve(String(newPath || '').trim());
    if (!target) throw new Error('请选择照片保存路径');
    const oldDir = getPhotoDir();
    if (path.normalize(target) === path.normalize(oldDir)) {
      return { moved: 0, photoDir: oldDir };
    }
    fs.mkdirSync(target, { recursive: true });
    // 递归收集旧目录下所有 .jpg（含条码子目录），得到相对路径列表
    const relFiles = [];
    (function walk(dir, rel) {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        return;
      }
      for (const en of entries) {
        if (en.isDirectory()) walk(path.join(dir, en.name), rel ? rel + '/' + en.name : en.name);
        else if (en.isFile() && en.name.endsWith('.jpg')) relFiles.push(rel ? rel + '/' + en.name : en.name);
      }
    })(oldDir, '');
    for (const f of relFiles) {
      if (fs.existsSync(path.join(target, f))) throw new Error('目标目录已存在同名照片文件：' + f);
    }
    let moved = 0;
    for (const f of relFiles) {
      const src = path.join(oldDir, f);
      const dst = path.join(target, f);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      try {
        fs.renameSync(src, dst);
      } catch (e) {
        // 跨磁盘时 rename 会失败，改为复制后删除源文件
        fs.copyFileSync(src, dst);
        fs.unlinkSync(src);
      }
      moved++;
    }
    const c = loadConfig();
    c.photoDir = target;
    saveConfig(c);
    appendLog({
      ...logBase(me),
      module: '系统设置',
      action: '修改照片路径',
      detail: `照片保存路径由「${oldDir}」改为「${target}」，迁移照片 ${moved} 张`,
      result: '成功'
    });
    return { moved, photoDir: target };
  }

  // ---------- 版本与更新 ----------
  // 语义化版本比较：a > b 返回 1，a < b 返回 -1，相等返回 0
  function compareVersions(a, b) {
    const pa = String(a || '0').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b || '0').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0;
      const y = pb[i] || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }

  // 扫描更新文件夹：从文件名中提取版本号（如 xingqiyi-1.2.0.zip / v1.2.0.zip / 1.2.0.zip）
  function checkUpdates() {
    const dir = updateDir || path.join(dataDir, 'updates');
    let latest = null;
    let latestFile = '';
    try {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        const m = f.match(/(\d+\.\d+\.\d+)/);
        if (!m) continue;
        if (!latest || compareVersions(m[1], latest) > 0) {
          latest = m[1];
          latestFile = f;
        }
      }
    } catch (e) {
      /* 更新文件夹不存在时视为无更新 */
    }
    return {
      currentVersion: appVersion,
      latestVersion: latest,
      latestFile,
      hasUpdate: !!latest && compareVersions(latest, appVersion) > 0
    };
  }

  // ---------- 强制推送安装包 ----------
  // 服务端管理员把安装包放入更新文件夹后，在此标记「强制推送版本」；
  // 客户端登录后查询到该版本高于自身版本时，自动下载安装包并提示安装。

  // 列出更新文件夹内的安装包文件（按版本号降序）
  function listUpdateFiles() {
    const dir = getUpdateDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
      return fs
        .readdirSync(dir)
        .filter((f) => /\.(exe|zip|msi)$/i.test(f))
        .map((f) => {
          let size = 0;
          try {
            size = fs.statSync(path.join(dir, f)).size;
          } catch (e) {
            /* 忽略单个文件读取失败 */
          }
          const m = f.match(/(\d+\.\d+\.\d+)/);
          return { name: f, size, version: m ? m[1] : '' };
        })
        .sort((a, b) => compareVersions(b.version || '0', a.version || '0'));
    } catch (e) {
      return [];
    }
  }

  // 校验安装包文件名：只允许更新文件夹内的单层文件名，禁止路径穿越
  function safeUpdateFileName(fileName) {
    const name = String(fileName || '').trim();
    if (!name || name.includes('..') || /[\\/]/.test(name)) return '';
    return name;
  }

  function getForceUpdate() {
    const c = loadConfig();
    const f = c.forceUpdate || null;
    const files = listUpdateFiles();
    const fileName = (f && f.fileName) || '';
    return {
      enabled: !!(f && f.enabled),
      version: (f && f.version) || '',
      fileName,
      at: (f && f.at) || '',
      by: (f && f.by) || '',
      // 文件被移走时前端要能提示「推送已失效」，避免客户端下载失败
      fileExists: !!fileName && files.some((x) => x.name === fileName),
      files
    };
  }

  function setForceUpdate(token, p = {}) {
    const me = requireSessionAdmin(token);
    const c = loadConfig();
    const enabled = !!p.enabled;
    if (enabled) {
      const fileName = safeUpdateFileName(p.fileName);
      if (!fileName) throw new Error('请选择要推送的安装包文件');
      if (!fs.existsSync(path.join(getUpdateDir(), fileName))) {
        throw new Error('更新文件夹中不存在该安装包：' + fileName);
      }
      const m = fileName.match(/(\d+\.\d+\.\d+)/);
      if (!m) throw new Error('安装包文件名需包含版本号，例如 xingqiyi-laundry-photo-setup-0.1.7.exe');
      c.forceUpdate = { enabled: true, version: m[1], fileName, at: now(), by: me.username };
      saveConfig(c);
      appendLog({
        ...logBase(me),
        module: '系统设置',
        action: '强制推送安装包',
        detail: `设置强制推送版本 ${m[1]}（文件：${fileName}），客户端下次登录时将自动下载并提示安装`,
        result: '成功'
      });
    } else {
      const prev = (c.forceUpdate && c.forceUpdate.version) || '';
      c.forceUpdate = { enabled: false, version: '', fileName: '', at: now(), by: me.username };
      saveConfig(c);
      appendLog({
        ...logBase(me),
        module: '系统设置',
        action: '取消强制推送',
        detail: prev ? `取消强制推送版本 ${prev}` : '取消强制推送安装包',
        result: '成功'
      });
    }
    return getForceUpdate();
  }

  // 供服务端 HTTP 接口解析安装包绝对路径（已做路径穿越防护）
  function resolveUpdateFile(fileName) {
    const name = safeUpdateFileName(fileName);
    if (!name) return null;
    const abs = path.join(getUpdateDir(), name);
    try {
      return fs.statSync(abs).isFile() ? abs : null;
    } catch (e) {
      return null;
    }
  }

  // ---------- 离线镜像（客户端灾难冗余） ----------
  // 客户端在远程操作成功后把账号与存档镜像到本机，服务器失联时可继续登录、拍照与查询。
  // 镜像用户会为密码重新生成本机校验子（服务端不会下发密码哈希）。
  function mirrorUser(user, plainPassword) {
    const users = loadUsers();
    const idx = users.findIndex((u) => u.username === user.username);
    const salt = crypto.randomBytes(16).toString('hex');
    const entry = {
      id: user.id,
      username: user.username,
      name: user.name || user.username,
      role: user.role === 'admin' ? 'admin' : 'client',
      salt,
      passwordHash: hashPassword(plainPassword, salt),
      permissions: {
        capture: !!(user.permissions && user.permissions.capture),
        query: !!(user.permissions && user.permissions.query)
      },
      active: user.active !== false,
      createdAt: user.createdAt || now(),
      lastLoginAt: user.lastLoginAt || null,
      mirrored: true,
      mirroredAt: now()
    };
    if (idx === -1) users.push(entry);
    else users[idx] = entry;
    saveUsers(users);
    return entry;
  }

  // 把服务端返回的存档记录合并进本机镜像（按 id 去重，保留离线待同步标记）
  function mirrorRecords(items) {
    if (!Array.isArray(items) || !items.length) return 0;
    const records = loadRecords();
    const index = new Map(records.map((r) => [r.id, r]));
    let added = 0;
    for (const it of items) {
      if (!it || !it.id) continue;
      const exist = index.get(it.id);
      const { photoUrl, ...plain } = it;
      if (exist) {
        // 已同步成功的记录直接更新；待同步记录保留 pendingSync 标记
        index.set(it.id, { ...exist, ...plain, pendingSync: exist.pendingSync || false });
      } else {
        index.set(it.id, { ...plain, pendingSync: false });
        added++;
      }
    }
    saveRecords([...index.values()]);
    return added;
  }

  // 离线新增的存档：先落到本机镜像，再登记待同步
  function addRecordOffline(token, p = {}) {
    const me = requireSessionPermission(token, 'capture');
    const barcode = String(p.barcode || '').trim();
    if (!barcode) throw new Error('请填写衣物条形码');
    if (!p.imageData || !String(p.imageData).startsWith('data:image/')) throw new Error('缺少照片数据，请先拍摄');
    const base64 = String(p.imageData).split(',')[1];
    if (!base64) throw new Error('照片数据无效');

    const id = uid();
    const photoDir = getPhotoDir();
    const safeBarcode = barcode.replace(/[\\/:*?"<>|]/g, '_').slice(0, 64);
    const barcodeDir = path.join(photoDir, safeBarcode);
    fs.mkdirSync(barcodeDir, { recursive: true });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const baseName = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`;
    let photoName = `${baseName}.jpg`;
    let n = 2;
    while (fs.existsSync(path.join(barcodeDir, photoName))) {
      photoName = `${baseName}-${n}.jpg`;
      n++;
    }
    fs.writeFileSync(path.join(barcodeDir, photoName), Buffer.from(base64, 'base64'));

    const records = loadRecords();
    const seq = records.filter((r) => r.barcode === barcode).length + 1;
    const record = {
      id,
      barcode,
      seq,
      userId: me.id,
      username: me.username,
      note: String(p.note || '').trim(),
      photoFile: `${safeBarcode}/${photoName}`,
      createdAt: now(),
      pendingSync: true,
      localPhotoDir: photoDir
    };
    records.push(record);
    saveRecords(records);
    // 离线队列只保存可重放的必要信息（照片留在本机，同步时再读取上传）
    offlineQueuePush({
      id,
      barcode,
      note: record.note,
      photoFile: record.photoFile,
      photoAbsPath: path.join(photoDir, record.photoFile),
      createdAt: record.createdAt,
      username: me.username
    });
    appendLog({
      ...logBase(me),
      module: '衣物拍照',
      action: '离线存档',
      detail: `服务器失联，离线存档：条码「${barcode}」第 ${seq} 张（待同步）`,
      result: '成功'
    });
    return { ...record, photoUrl: encodePhotoUrl(record.photoFile) };
  }

  // 同步成功后用服务端返回的记录替换本机离线副本
  function replaceOfflineRecord(localId, serverRecord) {
    const records = loadRecords();
    const idx = records.findIndex((r) => r.id === localId);
    if (idx === -1) return false;
    const { photoUrl, ...plain } = serverRecord || {};
    records[idx] = { ...records[idx], ...plain, pendingSync: false };
    saveRecords(records);
    return true;
  }

  // 本机待同步存档数量（用于界面提示）
  function pendingSyncCount() {
    return loadOfflineQueue().length;
  }

  function getUpdateDir() {
    return updateDir || path.join(dataDir, 'updates');
  }

  // ---------- 离线队列（灾难冗余） ----------
  // 服务器失联时，客户端把待同步的存档暂存到本地队列；恢复后按序补传。
  const loadOfflineQueue = () => readJson(OFFLINE_QUEUE_FILE, []);
  const saveOfflineQueue = (q) => writeJson(OFFLINE_QUEUE_FILE, q);

  function offlineQueuePush(item) {
    const q = loadOfflineQueue();
    q.push({ ...item, queuedAt: now() });
    saveOfflineQueue(q);
    return q.length;
  }

  function offlineQueueList() {
    const q = loadOfflineQueue();
    return { count: q.length, items: q.map((x) => ({ queuedAt: x.queuedAt, barcode: x.barcode || '' })) };
  }

  function offlineQueueTake(limit = 20) {
    return loadOfflineQueue().slice(0, limit);
  }

  function offlineQueueRemove(ids) {
    const set = new Set(Array.isArray(ids) ? ids : [ids]);
    const q = loadOfflineQueue().filter((x) => !set.has(x.id));
    saveOfflineQueue(q);
    return q.length;
  }

  // ---------- 按日期导出照片（含归档表格） ----------
  function exportPhotosByDate(token, p = {}) {
    const me = requireSessionPermission(token, 'query');
    const targetDir = path.resolve(String((p && p.targetDir) || '').trim());
    if (!targetDir) throw new Error('请先选择保存目录');
    const dateFrom = String(p.dateFrom || '').trim();
    const dateTo = String(p.dateTo || '').trim();
    if (!dateFrom || !dateTo) throw new Error('请选择开始与结束日期');
    if (dateFrom > dateTo) throw new Error('开始日期不能晚于结束日期');
    const fromIso = new Date(dateFrom + 'T00:00:00').toISOString();
    const toIso = new Date(dateTo + 'T23:59:59.999').toISOString();

    fs.mkdirSync(targetDir, { recursive: true });
    let records = loadRecords();
    if (me.role !== 'admin') records = records.filter((r) => r.userId === me.id);
    records = records.filter((r) => r.createdAt >= fromIso && r.createdAt <= toIso);
    if (!records.length) throw new Error('该日期范围内没有存档记录，无法导出');

    const photoDir = getPhotoDir();
    const rows = [['条码', '文件位置']];
    let exported = 0;
    let skipped = 0;
    let failed = 0;
    let folderCount = 0;
    const byBarcode = new Map();
    for (const r of records) {
      const code = String(r.barcode || '未命名');
      if (!byBarcode.has(code)) byBarcode.set(code, []);
      byBarcode.get(code).push(r);
    }
    for (const [code, group] of byBarcode) {
      const safeCode = code.replace(/[\\/:*?"<>|]/g, '_').slice(0, 64) || '未命名';
      const dir = path.join(targetDir, safeCode);
      fs.mkdirSync(dir, { recursive: true });
      folderCount++;
      group.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
      for (const r of group) {
        const src = path.join(photoDir, r.photoFile);
        const ext = path.extname(r.photoFile) || '.jpg';
        const name = `${fmtPhotoTime(r.createdAt)}_第${r.seq}张${ext}`;
        const dst = path.join(dir, name);
        try {
          fs.copyFileSync(src, dst);
          exported++;
          rows.push([code, dst]);
        } catch (e) {
          if (fs.existsSync(src)) failed++;
          else skipped++;
        }
      }
    }

    // 生成 CSV 归档表格（带 BOM，Excel 打开中文不乱码）
    const csv = rows.map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const csvPath = path.join(targetDir, `导出清单_${dateFrom}_${dateTo}.csv`);
    fs.writeFileSync(csvPath, '\ufeff' + csv, 'utf8');

    appendLog({
      ...logBase(me),
      module: me.role === 'admin' ? '数据管理' : '记录查询',
      action: '按日期导出照片',
      detail:
        `按日期范围导出衣物照片：${dateFrom} 至 ${dateTo}，` +
        `${folderCount} 个条码文件夹、${exported} 张` +
        `${skipped ? `，照片缺失跳过 ${skipped} 张` : ''}${failed ? `，导出失败 ${failed} 张` : ''} → ${targetDir}`,
      result: '成功'
    });
    return { exported, skipped, failed, folders: folderCount, targetDir, csvPath };
  }

  return {
    ensureSeedData,
    login,
    logout,
    current,
    changePassword,
    getPhotoDir,
    resolvePhotoFile,
    addRecord,
    listRecords,
    getRecord,
    deleteRecord,
    deleteRecords,
    exportPhotos,
    exportPhotosByDate,
    listUsers,
    createUser,
    updateUser,
    deleteUser,
    listLogs,
    overview,
    systemInfo,
    licenseStatus,
    activate,
    setMode,
    setClientConfig,
    updateSystemSettings,
    resetApiToken,
    setPhotoPath,
    checkUpdates,
    getUpdateDir,
    compareVersions,
    listUpdateFiles,
    getForceUpdate,
    setForceUpdate,
    resolveUpdateFile,
    offlineQueuePush,
    offlineQueueList,
    offlineQueueTake,
    offlineQueueRemove,
    mirrorUser,
    mirrorRecords,
    mirrorLogin,
    addRecordOffline,
    replaceOfflineRecord,
    pendingSyncCount,
    loadConfig,
    saveConfig
  };
}

module.exports = { createStore, withRequestIp, normalizeIp };
