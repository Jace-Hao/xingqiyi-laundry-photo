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

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const genApiToken = () => crypto.randomBytes(6).toString('hex');

function createStore({ dataDir, defaultPhotoDir, updateDir, appVersion = '0.0.0', photoScheme = 'xqy-photo' }) {
  const CONFIG_FILE = path.join(dataDir, 'config.json');
  const USERS_FILE = path.join(dataDir, 'users.json');
  const RECORDS_FILE = path.join(dataDir, 'records.json');
  const LOGS_FILE = path.join(dataDir, 'logs.json');
  const SESSIONS_FILE = path.join(dataDir, 'sessions.json');

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
    updateSourceUrl: ''
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
    logs.push({ id: uid(), time: now(), ...entry });
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
    appendLog({
      ...logBase(me),
      module: '衣物拍照',
      action: '新增存档',
      detail: `新增衣物照片存档：条码「${barcode}」第 ${seq} 张`,
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
        [l.username, l.module, l.action, l.detail].some((v) => String(v || '').toLowerCase().includes(kw))
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
      updateSourceUrl: c.updateSourceUrl || ''
    };
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

  function setPhotoPath(token, newPath) {
    const me = requireSessionAdmin(token);
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

  function getUpdateDir() {
    return updateDir || path.join(dataDir, 'updates');
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
    listUsers,
    createUser,
    updateUser,
    deleteUser,
    listLogs,
    overview,
    systemInfo,
    setMode,
    setClientConfig,
    updateSystemSettings,
    resetApiToken,
    setPhotoPath,
    checkUpdates,
    getUpdateDir,
    compareVersions,
    getPhotoDir,
    loadConfig,
    saveConfig
  };
}

module.exports = { createStore };
