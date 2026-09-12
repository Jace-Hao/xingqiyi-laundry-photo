'use strict';

const { app, BrowserWindow, ipcMain, session, Menu, protocol, net, Tray, nativeImage, powerSaveBlocker } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const { pathToFileURL } = require('url');
const { createStore } = require('./store');
const { startServer } = require('./server');

app.setName('星期衣精致洗衣衣物照片系统');

// 自定义协议：
// - app://       以正规 origin 加载界面资源（file:// 下 CSP 'self' 会拦截本地脚本，导致白屏）
// - xqy-photo:// 展示衣物照片。服务端模式读本地文件；客户端模式从远程服务器拉取
const APP_SCHEME = 'app';
const PHOTO_SCHEME = 'xqy-photo';
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: PHOTO_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }
]);

const DATA_DIR = path.join(app.getPath('userData'), 'data');
const DEFAULT_PHOTO_DIR = path.join(app.getPath('userData'), 'photos');
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

const APP_VERSION = require('../package.json').version;
const UPDATE_DIR = path.join(app.getPath('userData'), 'updates');

// 更新分发：通过 GitHub Releases 发布安装包，应用从这里检查最新版本。
// 仓库地址须与 package.json 的 repository 保持一致。
const GITHUB_REPO = 'Jace-Hao/xingqiyi-laundry-photo';
const GITHUB_RELEASES_PAGE = 'https://github.com/' + GITHUB_REPO + '/releases/latest';

const store = createStore({
  dataDir: DATA_DIR,
  defaultPhotoDir: DEFAULT_PHOTO_DIR,
  updateDir: UPDATE_DIR,
  appVersion: APP_VERSION,
  photoScheme: PHOTO_SCHEME
});

let httpServer = null;

// 服务端后台常驻（需求13）：托盘图标、真正退出标志、防休眠句柄
let tray = null;
let isQuitting = false;
let powerSaveId = null;

// ---------- 远程调用（客户端模式把 IPC 转发到服务端节点） ----------
function remoteCall(route, body, sessionToken) {
  return new Promise((resolve) => {
    const cfg = store.loadConfig();
    if (!cfg.serverUrl) {
      return resolve({ ok: false, message: '尚未配置服务器，请先在启动设置中填写服务器地址与连接码' });
    }
    let url;
    try {
      url = new URL(cfg.serverUrl + '/api/' + route);
    } catch (e) {
      return resolve({ ok: false, message: '服务器地址格式不正确' });
    }
    const lib = url.protocol === 'https:' ? https : http;
    const payload = body === undefined ? '' : JSON.stringify(body || {});
    const req = lib.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(payload),
          'x-api-token': cfg.serverToken || '',
          'x-session-token': sessionToken || ''
        },
        timeout: 60000
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve({ ok: false, message: '服务器返回数据异常' });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, message: '连接服务器超时，请检查网络与服务器是否在线' });
    });
    req.on('error', (e) => {
      resolve({ ok: false, message: '无法连接服务器：' + (e.message || e.code) });
    });
    req.write(payload);
    req.end();
  });
}

// ---------- 本地调用（服务端模式直接走数据层） ----------
function localCall(route, body, token) {
  const b = body || {};
  const routes = {
    'auth/login': () => store.login(b),
    'auth/logout': () => store.logout(token),
    'auth/current': () => store.current(token),
    'auth/changePassword': () => store.changePassword(token, b),
    'records/add': () => store.addRecord(token, b),
    'records/list': () => store.listRecords(token, b),
    'records/get': () => store.getRecord(token, b.id),
    'records/delete': () => store.deleteRecord(token, b.id),
    'records/deleteBatch': () => store.deleteRecords(token, b.ids),
    'records/exportPhotos': () => store.exportPhotos(token, b),
    'records/exportPhotosByDate': () => store.exportPhotosByDate(token, b),
    'users/list': () => store.listUsers(token),
    'users/create': () => store.createUser(token, b),
    'users/update': () => store.updateUser(token, b),
    'users/delete': () => store.deleteUser(token, b.id),
    'logs/list': () => store.listLogs(token, b),
    'stats/overview': () => store.overview(token)
  };
  const fn = routes[route];
  if (!fn) return Promise.resolve({ ok: false, message: '接口不存在' });
  try {
    return Promise.resolve({ ok: true, data: fn() });
  } catch (e) {
    return Promise.resolve({ ok: false, message: e.message || String(e) });
  }
}

// ---------- 离线降级判定与离线会话 ----------
// 客户端模式下服务器失联（网络层错误）时，允许用本机镜像继续工作。
// 注意：业务层错误（如密码错误、无权限）不属于失联，不得降级，避免绕过服务端校验。
function isConnFailure(r) {
  if (!r || r.ok) return false;
  const m = String(r.message || '');
  return /无法连接|连接超时|尚未配置|返回数据异常|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up/i.test(m);
}

// 离线会话：本机镜像登录产生的令牌，仅在服务器失联期间有效
const offlineSessions = new Map(); // localToken -> { username, offlineSince }
let syncTimer = null;

// ---------- 统一分发：按运行模式决定本地执行或远程转发 ----------
async function dispatch(route, body, sessionToken) {
  try {
    const cfg = store.loadConfig();
    if (cfg.mode === 'client') {
      // 离线会话令牌：直接走本机镜像（服务器恢复后需重新登录建立在线会话）
      const off = offlineSessions.get(sessionToken);
      if (off && off.offlineSince) {
        const lr = await localCall(route, body, off.localToken);
        if (lr.ok) lr.offline = true;
        return lr;
      }
      const r = await remoteCall(route, body, sessionToken);
      if (!isConnFailure(r)) {
        // 服务器可达：顺带触发待同步存档补传
        if (r.ok && store.pendingSyncCount() > 0) scheduleSync();
        return r;
      }
      // 服务器失联：降级到本机镜像，保证门店不停工
      const sess = offlineSessions.get(sessionToken);
      const localToken = sess ? sess.localToken : sessionToken;
      if (route === 'records/add') {
        try {
          const data = store.addRecordOffline(localToken, body || {});
          return { ok: true, data, offline: true };
        } catch (e) {
          return { ok: false, message: e.message || String(e) };
        }
      }
      const lr = await localCall(route, body, localToken);
      if (lr.ok) lr.offline = true;
      return lr;
    }
    return await localCall(route, body, sessionToken);
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
}

// ---------- 离线存档同步：服务器恢复后把待同步记录补传到服务端 ----------
async function syncOfflineRecords() {
  const cfg = store.loadConfig();
  if (cfg.mode !== 'client' || !cfg.serverUrl) return { synced: 0, failed: 0 };
  const fs = require('fs');
  const queue = store.offlineQueueTake(50);
  if (!queue.length) return { synced: 0, failed: 0 };

  // 用当前离线会话在服务端的令牌补传；无有效令牌时跳过本轮
  let remoteToken = '';
  for (const s of offlineSessions.values()) {
    if (s.serverToken) {
      remoteToken = s.serverToken;
      break;
    }
  }
  if (!remoteToken) return { synced: 0, failed: 0, reason: '缺少可用的登录会话，暂不同步' };

  let synced = 0;
  let failed = 0;
  for (const item of queue) {
    try {
      if (!fs.existsSync(item.photoAbsPath)) {
        // 照片已丢失，无法补传，丢弃该项避免永久卡住队列
        store.offlineQueueRemove([item.id]);
        failed++;
        continue;
      }
      const imageData = 'data:image/jpeg;base64,' + fs.readFileSync(item.photoAbsPath).toString('base64');
      const r = await remoteCall(
        'records/add',
        { imageData, barcode: item.barcode, note: item.note, syncFromOffline: true },
        remoteToken
      );
      if (!r.ok) {
        failed++;
        break; // 多为连接或权限问题，停止本轮同步，下次再试
      }
      store.replaceOfflineRecord(item.id, r.data);
      store.offlineQueueRemove([item.id]);
      synced++;
    } catch (e) {
      failed++;
      break;
    }
  }
  return { synced, failed, remaining: store.pendingSyncCount() };
}

function scheduleSync() {
  if (syncTimer) clearTimeout(syncTimer);
  // 服务器恢复后延迟触发，避免与界面操作争抢
  syncTimer = setTimeout(() => {
    syncTimer = null;
    syncOfflineRecords().catch(() => {});
  }, 1500);
}

// ---------- IPC 注册 ----------
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, payload, sessionToken) => {
    try {
      return await fn(payload, sessionToken);
    } catch (e) {
      return { ok: false, message: e.message || String(e) };
    }
  });
}

// 客户端登录：远程成功后镜像账号与存档到本机；服务器失联时用镜像离线登录
async function clientLogin(p) {
  const cfg = store.loadConfig();
  const r = await remoteCall('auth/login', p, '');
  if (!isConnFailure(r)) {
    if (r.ok) {
      // 镜像账号（本机重新生成校验子）与该账号的近期存档，供离线使用；
      // 并用同一令牌在本机建立会话，服务器失联时该令牌可直接降级使用
      try {
        store.mirrorUser(r.data.user, p.password);
        store.mirrorLogin(r.data.user, r.data.sessionToken);
        const list = await remoteCall('records/list', { silent: true, pageSize: 100 }, r.data.sessionToken);
        if (list.ok && list.data) store.mirrorRecords(list.data.items);
      } catch (e) {
        /* 镜像失败不影响正常登录 */
      }
      offlineSessions.set(r.data.sessionToken, {
        username: r.data.user.username,
        localToken: r.data.sessionToken,
        serverToken: r.data.sessionToken,
        offlineSince: null
      });
      if (store.pendingSyncCount() > 0) scheduleSync();
      // 登录成功后异步检查服务端强制推送的安装包，不阻塞登录返回；
      // 需要更新时后台静默下载，完成后由 update:force 事件通知界面弹窗提示安装
      checkForceUpdateForClient().catch(() => {});
    }
    return r;
  }
  // 服务器失联：用本机镜像离线登录（本机无缓存时提示）
  try {
    const local = store.login(p);
    offlineSessions.set(local.sessionToken, {
      username: local.user.username,
      localToken: local.sessionToken,
      serverToken: '',
      offlineSince: Date.now()
    });
    return { ok: true, data: { user: local.user, sessionToken: local.sessionToken }, offline: true };
  } catch (e) {
    return {
      ok: false,
      message: '无法连接服务器，且本机没有该账号的离线缓存：' + (e.message || String(e))
    };
  }
}

handle('auth:login', async (p) => {
  // 激活拦截：试用到期后必须输入激活码才能继续使用
  const lic = store.licenseStatus();
  if (lic.state === 'expired') {
    return { ok: false, expired: true, message: '试用期已结束，请在本机输入激活码后继续使用（机器码：' + lic.machineCode + '）', license: lic };
  }
  const cfg = store.loadConfig();
  if (cfg.mode === 'client') return clientLogin(p);
  return dispatch('auth/login', p);
});
handle('auth:logout', (_p, token) => {
  offlineSessions.delete(token);
  return dispatch('auth/logout', undefined, token);
});
handle('auth:current', (_p, token) => dispatch('auth/current', undefined, token));
handle('auth:changePassword', (p, token) => dispatch('auth/changePassword', p, token));

handle('records:add', (p, token) => dispatch('records/add', p, token));
handle('records:list', (p, token) => dispatch('records/list', p, token));
handle('records:get', (p, token) => dispatch('records/get', p, token));
handle('records:delete', (p, token) => dispatch('records/delete', p, token));
handle('records:deleteBatch', (p, token) => dispatch('records/deleteBatch', p, token));

// 客户端模式：照片在服务端电脑，主进程逐张从服务器拉取后按条码文件夹保存到本机目录
async function clientExportPhotos(p, sessionToken) {
  const fs = require('fs');
  const targetDir = String((p && p.targetDir) || '').trim();
  if (!targetDir) return { ok: false, message: '请先选择保存目录' };
  fs.mkdirSync(targetDir, { recursive: true });

  const barcodes = Array.isArray(p.barcodes)
    ? [...new Set(p.barcodes.map((x) => String(x || '').trim()).filter(Boolean))]
    : [];

  // 分页拉取全部符合条件的记录（silent 避免产生大量查询日志）
  const base = { silent: true, pageSize: 100 };
  const all = [];
  async function pullPage(extra, page) {
    return dispatch('records/list', { ...base, ...extra, page }, sessionToken);
  }
  if (barcodes.length) {
    for (const code of barcodes) {
      let page = 1;
      for (;;) {
        const r = await pullPage({ barcode: code }, page);
        if (!r.ok) return r;
        all.push(...r.data.items);
        if (r.data.items.length < base.pageSize) break;
        page++;
      }
    }
  } else {
    let page = 1;
    for (;;) {
      const r = await pullPage({}, page);
      if (!r.ok) return r;
      all.push(...r.data.items);
      if (r.data.items.length < base.pageSize || page > 500) break;
      page++;
    }
  }
  if (!all.length) return { ok: false, message: '没有符合条件的存档记录，无法导出' };

  const cfg = store.loadConfig();
  const photoUrl = (file) =>
    cfg.serverUrl + '/photo?f=' + encodeURIComponent(file) + '&token=' + encodeURIComponent(cfg.serverToken);
  const pad = (n) => String(n).padStart(2, '0');
  const fmtTime = (iso) => {
    const d = new Date(iso || '');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`;
  };

  const groups = new Map();
  for (const r of all) {
    const code = String(r.barcode || '');
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(r);
  }

  let exported = 0;
  let skipped = 0;
  let failed = 0;
  for (const [code, list] of groups) {
    const safeCode = code.replace(/[\\/:*?"<>|]/g, '_').slice(0, 64) || '未命名';
    const dir = path.join(targetDir, safeCode);
    fs.mkdirSync(dir, { recursive: true });
    list.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    for (const r of list) {
      const ext = path.extname(r.photoFile) || '.jpg';
      const name = `${fmtTime(r.createdAt)}_第${r.seq}张${ext}`;
      try {
        const resp = await net.fetch(photoUrl(r.photoFile));
        if (!resp.ok) {
          skipped++;
          continue;
        }
        const buf = Buffer.from(await resp.arrayBuffer());
        fs.writeFileSync(path.join(dir, name), buf);
        exported++;
      } catch (e) {
        failed++;
      }
    }
  }
  return { ok: true, data: { exported, skipped, failed, folders: groups.size, targetDir } };
}

handle('records:exportPhotos', async (p, token) => {
  const cfg = store.loadConfig();
  if (cfg.mode === 'client') return clientExportPhotos(p, token);
  return dispatch('records/exportPhotos', p, token);
});

// 客户端模式：按日期范围拉取记录与照片，按条码文件夹保存并生成归档表格
async function clientExportPhotosByDate(p, sessionToken) {
  const fs = require('fs');
  const targetDir = String((p && p.targetDir) || '').trim();
  if (!targetDir) return { ok: false, message: '请先选择保存目录' };
  const dateFrom = String(p.dateFrom || '').trim();
  const dateTo = String(p.dateTo || '').trim();
  if (!dateFrom || !dateTo) return { ok: false, message: '请选择开始与结束日期' };
  if (dateFrom > dateTo) return { ok: false, message: '开始日期不能晚于结束日期' };
  fs.mkdirSync(targetDir, { recursive: true });

  const base = { silent: true, pageSize: 100, dateFrom, dateTo };
  const all = [];
  let page = 1;
  for (;;) {
    const r = await dispatch('records/list', { ...base, page }, sessionToken);
    if (!r.ok) return r;
    all.push(...r.data.items);
    if (r.data.items.length < base.pageSize || page > 500) break;
    page++;
  }
  if (!all.length) return { ok: false, message: '该日期范围内没有存档记录，无法导出' };

  const cfg = store.loadConfig();
  const photoUrl = (file) =>
    cfg.serverUrl + '/photo?f=' + encodeURIComponent(file) + '&token=' + encodeURIComponent(cfg.serverToken);
  const pad = (n) => String(n).padStart(2, '0');
  const fmtTime = (iso) => {
    const d = new Date(iso || '');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`;
  };

  const groups = new Map();
  for (const r of all) {
    const code = String(r.barcode || '');
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(r);
  }

  const rows = [['条码', '文件位置']];
  let exported = 0;
  let skipped = 0;
  let failed = 0;
  for (const [code, list] of groups) {
    const safeCode = code.replace(/[\\/:*?"<>|]/g, '_').slice(0, 64) || '未命名';
    const dir = path.join(targetDir, safeCode);
    fs.mkdirSync(dir, { recursive: true });
    list.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    for (const r of list) {
      const ext = path.extname(r.photoFile) || '.jpg';
      const name = `${fmtTime(r.createdAt)}_第${r.seq}张${ext}`;
      const dst = path.join(dir, name);
      try {
        const resp = await net.fetch(photoUrl(r.photoFile));
        if (!resp.ok) {
          skipped++;
          continue;
        }
        const buf = Buffer.from(await resp.arrayBuffer());
        fs.writeFileSync(dst, buf);
        exported++;
        rows.push([code, dst]);
      } catch (e) {
        failed++;
      }
    }
  }

  const csv = rows.map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const csvPath = path.join(targetDir, `导出清单_${dateFrom}_${dateTo}.csv`);
  fs.writeFileSync(csvPath, '\ufeff' + csv, 'utf8');

  return { ok: true, data: { exported, skipped, failed, folders: groups.size, targetDir, csvPath } };
}

handle('records:exportPhotosByDate', async (p, token) => {
  const cfg = store.loadConfig();
  if (cfg.mode === 'client') return clientExportPhotosByDate(p, token);
  return dispatch('records/exportPhotosByDate', p, token);
});

handle('users:list', (_p, token) => dispatch('users/list', undefined, token));
handle('users:create', (p, token) => dispatch('users/create', p, token));
handle('users:update', (p, token) => dispatch('users/update', p, token));
handle('users:delete', (p, token) => dispatch('users/delete', p, token));

handle('logs:list', (p, token) => dispatch('logs/list', p, token));
handle('stats:overview', (_p, token) => dispatch('stats/overview', undefined, token));

// ---------- 系统配置类（本地，不随客户端转发） ----------
handle('system:info', () => {
  const info = store.systemInfo();
  return { ok: true, data: info };
});

// ---------- 激活与试用 ----------
handle('license:status', () => {
  return { ok: true, data: store.licenseStatus() };
});

handle('license:activate', (code) => {
  try {
    const data = store.activate(code);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
});

// ---------- 离线状态与手动同步 ----------
handle('offline:status', async () => {
  const cfg = store.loadConfig();
  let online = true;
  if (cfg.mode === 'client' && cfg.serverUrl) {
    // 用 /ping 轻量探测服务器是否可达（3 秒超时）
    online = await new Promise((resolve) => {
      let url;
      try {
        url = new URL(cfg.serverUrl.replace(/\/+$/, '') + '/ping');
      } catch (e) {
        return resolve(false);
      }
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(
        {
          method: 'GET',
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname,
          timeout: 3000
        },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        }
      );
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.on('error', () => resolve(false));
      req.end();
    });
  }
  return {
    ok: true,
    data: {
      online,
      mode: cfg.mode,
      pending: store.pendingSyncCount(),
      queue: store.offlineQueueList()
    }
  };
});

handle('offline:sync', async () => {
  try {
    const data = await syncOfflineRecords();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
});

handle('system:setMode', async (mode) => {
  const data = store.setMode(mode);
  if (data.mode === 'server') {
    await restartServerIfNeeded();
  } else if (httpServer) {
    await httpServer.close();
    httpServer = null;
    destroyTray();
  }
  return { ok: true, data };
});

handle('system:setClientConfig', async ({ serverUrl, serverToken } = {}) => {
  try {
    const data = store.setClientConfig(serverUrl, serverToken);
    if (httpServer) {
      await httpServer.close();
      httpServer = null;
      destroyTray();
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
});

handle('system:testServer', ({ serverUrl, serverToken } = {}) => {
  return new Promise((resolve) => {
    let url;
    try {
      let u = String(serverUrl || '').trim();
      if (!u) return resolve({ ok: false, message: '请填写服务器地址' });
      if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
      url = new URL(u.replace(/\/+$/, '') + '/ping');
    } catch (e) {
      return resolve({ ok: false, message: '服务器地址格式不正确' });
    }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        timeout: 8000
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            if (j.ok) resolve({ ok: true, data: true });
            else resolve({ ok: false, message: '服务器响应异常' });
          } catch (e) {
            resolve({ ok: false, message: '服务器响应异常' });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, message: '连接超时，请检查地址与网络' });
    });
    req.on('error', (e) => resolve({ ok: false, message: '无法连接：' + (e.message || e.code) }));
    req.end();
  });
});

handle('system:settings', async (p, token) => {
  try {
    const data = store.updateSystemSettings(token, p);
    await restartServerIfNeeded();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
});

handle('system:resetToken', (_p, token) => {
  try {
    const data = store.resetApiToken(token);
    restartServerIfNeeded();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
});

handle('system:photoPath', (p, token) => {
  try {
    const data = store.setPhotoPath(token, p && p.path);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
});

// ---------- 窗口焦点保护 ----------
// Windows 下调用原生对话框会抢走前台焦点；若此时主窗口处于最小化或失焦状态，
// 对话框关闭后主窗口可能再也收不到鼠标输入，表现为「所有输入框点不动，必须重启软件」。
// 因此弹出原生对话框前先把窗口恢复到前台，关闭后再夺回焦点。
function ensureWindowFocus() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.focus();
  } catch (e) {
    /* 忽略 */
  }
}

// 统一的目录选择：调用前后各恢复一次焦点，任何结果（含取消、异常）都不留下失焦窗口
function chooseDirectory(title) {
  const { dialog } = require('electron');
  ensureWindowFocus();
  return dialog
    .showOpenDialog(mainWindow, {
      title,
      properties: ['openDirectory', 'createDirectory']
    })
    .then((r) => {
      ensureWindowFocus();
      return r.canceled || !r.filePaths.length ? { ok: false, message: '已取消' } : { ok: true, data: r.filePaths[0] };
    })
    .catch((e) => {
      ensureWindowFocus();
      return { ok: false, message: e.message || String(e) };
    });
}

handle('system:chooseExportDir', () => chooseDirectory('选择照片导出保存目录'));

handle('system:choosePhotoDir', () => chooseDirectory('选择照片保存目录'));

handle('system:version', () => {
  return { ok: true, data: { version: APP_VERSION } };
});

// ---------- GitHub Releases 更新检查 ----------
// 使用 Electron 的 net 模块（走 Windows 系统证书库），
// 在代理/企业证书环境下也能正常访问，避免 Node 内置模块的证书验证失败。
function checkGitHubRelease() {
  const fetchAll = async () => {
    const resp = await net.fetch('https://api.github.com/repos/' + GITHUB_REPO + '/releases?per_page=20', {
      headers: {
        'User-Agent': 'xingqiyi-laundry-photo',
        Accept: 'application/vnd.github+json'
      }
    });
    if (!resp.ok) return { ok: false, message: 'GitHub 返回状态 ' + resp.status };
    const list = await resp.json();
    if (!Array.isArray(list)) return { ok: false, message: 'GitHub 返回数据异常' };
    // 遍历全部正式发布，按版本号取最高者，
    // 不依赖 GitHub「latest」的排序（其按发布时间排序，标签格式或发布顺序异常时会取错）
    let best = null;
    for (const rel of list) {
      if (rel.draft || rel.prerelease) continue;
      const tag = String(rel.tag_name || '').replace(/^v/i, '');
      if (!tag) continue;
      if (!best || store.compareVersions(tag, best.latestVersion) > 0) best = { latestVersion: tag, rel };
    }
    if (!best) return { ok: false, message: '仓库暂无正式发布' };
    const assets = Array.isArray(best.rel.assets) ? best.rel.assets : [];
    // 优先匹配 .exe 安装包，其次取任意第一个附件
    const asset = assets.find((a) => /\.exe$/i.test(a.name || '')) || assets[0];
    return {
      ok: true,
      latestVersion: best.latestVersion,
      downloadUrl: (asset && asset.browser_download_url) || best.rel.html_url || GITHUB_RELEASES_PAGE,
      // 资产名与发布说明：用于弹窗展示更新内容与「自动下载」保存文件名
      assetName: (asset && asset.name) || '',
      releaseNotes: String(best.rel.body || '').trim(),
      releasePage: best.rel.html_url || GITHUB_RELEASES_PAGE
    };
  };
  // 超时兜底：避免网络异常时界面长时间卡在「检查中」
  return Promise.race([
    fetchAll().catch((e) => ({ ok: false, message: '无法连接 GitHub：' + (e.message || e.code) })),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, message: '连接 GitHub 超时' }), 15000))
  ]);
}

handle('system:checkUpdate', async () => {
  // 首选：通过 GitHub Releases 在线检查最新版本
  const gh = await checkGitHubRelease();
  if (gh.ok) {
    return {
      ok: true,
      data: {
        currentVersion: APP_VERSION,
        latestVersion: gh.latestVersion,
        downloadUrl: gh.downloadUrl,
        assetName: gh.assetName || '',
        releaseNotes: gh.releaseNotes || '',
        releasePage: gh.releasePage || GITHUB_RELEASES_PAGE,
        hasUpdate: store.compareVersions(gh.latestVersion, APP_VERSION) > 0,
        source: 'github'
      }
    };
  }

  // 兜底：无法访问 GitHub 时，回退到原有「更新文件夹」机制
  const cfg = store.loadConfig();
  let remote = null;
  if (cfg.mode === 'client' && cfg.serverUrl) {
    // 客户端节点：向服务器查询其更新文件夹中的最新版本
    const r = await remoteCall('system/checkUpdate', {}, '');
    if (r.ok && r.data) remote = r.data;
  }
  const local = store.checkUpdates();
  // 取服务器与本机更新信息中较新的版本作为提示依据
  const pick = remote && remote.latestVersion &&
    (!local.latestVersion || store.compareVersions(remote.latestVersion, local.latestVersion) > 0)
      ? remote
      : local;
  return { ok: true, data: { ...pick, currentVersion: APP_VERSION, fromServer: !!remote && pick === remote, source: 'local' } };
});

handle('system:openUpdatePage', () => {
  const { shell } = require('electron');
  shell.openExternal(GITHUB_RELEASES_PAGE);
  return { ok: true, data: GITHUB_RELEASES_PAGE };
});

// ---------- 自动下载更新安装包 ----------
// 从 GitHub Releases 或服务端强制推送地址下载安装包到「下载」目录下的专属文件夹，
// 边下边报进度，完成后自动打开文件夹定位文件。手动下载与强制推送自动下载共用此实现。
let activeDownload = null;

async function downloadInstaller(url, name, opts = {}) {
  const fs = require('fs');
  const openFolder = opts.openFolder !== false;
  if (activeDownload) return { ok: false, message: '正在下载中，请稍候…' };
  if (!url || !/^https?:\/\//i.test(String(url))) return { ok: false, message: '下载地址无效' };
  if (!mainWindow) return { ok: false, message: '窗口未就绪' };

  const dir = path.join(app.getPath('downloads'), 'xingqiyi-laundry-photo');
  fs.mkdirSync(dir, { recursive: true });
  let fileName = String(name || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  if (!fileName) fileName = 'xingqiyi-laundry-photo-setup-' + Date.now() + '.exe';
  const target = path.join(dir, fileName);
  const tmp = target + '.part';

  const win = mainWindow;
  const send = (channel, payload) => {
    try {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    } catch (e) {
      /* 窗口销毁时忽略 */
    }
  };

  const controller = new AbortController();
  // 无响应看门狗：连续 30 秒收不到任何数据即中止下载，
  // 避免网络请求永久挂起导致下载状态无法解除、界面被全屏弹窗锁死
  const IDLE_TIMEOUT_MS = 30000;
  let timedOut = false;
  let idleTimer = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, IDLE_TIMEOUT_MS);
  };
  resetIdleTimer();
  activeDownload = { url: String(url), cancel: () => controller.abort() };
  try {
    const resp = await net.fetch(String(url), {
      signal: controller.signal,
      headers: { 'User-Agent': 'xingqiyi-laundry-photo' }
    });
    if (!resp.ok || !resp.body) throw new Error('服务器返回状态 ' + resp.status);
    const total = Number(resp.headers.get('content-length')) || 0;
    let received = 0;
    let lastSent = 0;
    const out = fs.createWriteStream(tmp);
    for await (const chunk of resp.body) {
      resetIdleTimer();
      out.write(chunk);
      received += chunk.length;
      const t = Date.now();
      if (t - lastSent >= 400) {
        lastSent = t;
        send('update:download-progress', { received, total });
      }
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));

    // 已存在同名安装包时先移除；移除失败则换带时间戳的文件名落位
    let finalTarget = target;
    try {
      fs.unlinkSync(target);
    } catch (e) {
      /* 可能不存在 */
    }
    try {
      fs.renameSync(tmp, target);
    } catch (e) {
      finalTarget = path.join(dir, fileName.replace(/(\.exe)?$/i, '-' + Date.now() + '$1'));
      fs.renameSync(tmp, finalTarget);
    }
    if (openFolder) {
      const { shell } = require('electron');
      shell.showItemInFolder(finalTarget);
      // 资源管理器窗口会抢走前台焦点，稍后夺回，避免返回软件后输入框点不动
      setTimeout(() => ensureWindowFocus(), 600);
    }
    return { ok: true, data: { file: finalTarget, size: received } };
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      /* 忽略 */
    }
    if (timedOut) return { ok: false, message: '下载超时：网络连接不稳定，请稍后重试' };
    if (controller.signal.aborted) return { ok: false, canceled: true, message: '已取消下载' };
    return { ok: false, message: '下载失败：' + (e.message || String(e)) };
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    activeDownload = null;
  }
}

handle('system:downloadUpdate', ({ url, name } = {}) => downloadInstaller(url, name));

handle('system:cancelDownload', () => {
  if (!activeDownload) return { ok: false, message: '当前没有正在进行的下载' };
  activeDownload.cancel();
  return { ok: true };
});

// ---------- 服务端强制推送安装包 ----------
// 服务端管理员在「系统设置」中选择更新文件夹里的安装包并开启强制推送；
// 客户端下次登录时自动查询，发现推送版本高于本机版本即静默下载并弹窗提示安装。
handle('system:forceUpdate', async () => {
  try {
    const cfg = store.loadConfig();
    if (cfg.mode === 'client' && cfg.serverUrl) {
      const r = await remoteCall('system/forceUpdate', {});
      if (!r.ok) return { ok: false, message: r.message || '获取服务端推送设置失败' };
      return { ok: true, data: { ...r.data, fromServer: true } };
    }
    return { ok: true, data: store.getForceUpdate() };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
});

handle('system:setForceUpdate', (p, token) => {
  try {
    const data = store.setForceUpdate(token, p || {});
    return { ok: true, data };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
});

// 拼装服务端安装包下载地址（连接码放查询参数，下载走 net.fetch 无法附加自定义请求头）
function buildServerUpdateUrl(cfg, fileName) {
  return (
    cfg.serverUrl.replace(/\/+$/, '') +
    '/update-file?f=' +
    encodeURIComponent(fileName) +
    '&token=' +
    encodeURIComponent(cfg.serverToken || '')
  );
}

// 客户端登录成功后调用：检查服务端强制推送，需要时静默下载安装包并通知界面弹窗
async function checkForceUpdateForClient() {
  const cfg = store.loadConfig();
  if (cfg.mode !== 'client' || !cfg.serverUrl) {
    return { ok: true, data: { needUpdate: false, reason: 'not-client' } };
  }
  const r = await remoteCall('system/forceUpdate', {});
  if (!r.ok || !r.data) return { ok: true, data: { needUpdate: false, reason: 'query-failed' } };
  const f = r.data;
  if (!f.enabled || !f.version) return { ok: true, data: { needUpdate: false, reason: 'not-pushed' } };
  if (store.compareVersions(f.version, APP_VERSION) <= 0) {
    return { ok: true, data: { needUpdate: false, reason: 'already-new', version: f.version } };
  }
  if (!f.fileExists || !f.fileName) {
    return { ok: true, data: { needUpdate: false, reason: 'file-missing', version: f.version } };
  }

  // 本机已下载过同一安装包（同名且大小一致）时不重复下载，直接提示安装
  const fs = require('fs');
  const dir = path.join(app.getPath('downloads'), 'xingqiyi-laundry-photo');
  const cached = path.join(dir, f.fileName);
  let payload = {
    needUpdate: true,
    version: f.version,
    fileName: f.fileName,
    file: cached,
    size: 0,
    downloaded: false
  };
  try {
    if (fs.existsSync(cached)) {
      payload.size = fs.statSync(cached).size;
      payload.downloaded = true;
    }
  } catch (e) {
    /* 缓存检查失败则走下载 */
  }

  if (!payload.downloaded) {
    if (activeDownload) return { ok: true, data: { ...payload, reason: 'busy' } };
    const dl = await downloadInstaller(buildServerUpdateUrl(cfg, f.fileName), f.fileName, { openFolder: false });
    if (!dl.ok) {
      return { ok: true, data: { needUpdate: false, reason: 'download-failed', message: dl.message, version: f.version } };
    }
    payload = { ...payload, file: dl.data.file, size: dl.data.size, downloaded: true };
  }

  // 通知界面弹出强制更新提示（登录页与主框架都在监听）
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:force', payload);
  } catch (e) {
    /* 窗口未就绪时忽略，界面仍可通过 checkForceUpdate 主动查询 */
  }
  return { ok: true, data: payload };
}

handle('system:checkForceUpdate', () => checkForceUpdateForClient());

// 打开已下载的安装包所在文件夹并定位文件（强制推送下载完成后由弹窗按钮触发）
handle('system:openInstaller', (p) => {
  const fs = require('fs');
  const { shell } = require('electron');
  const file = String((p && p.file) || '');
  if (!file || !fs.existsSync(file)) return { ok: false, message: '安装包文件不存在，可能已被移动或删除' };
  shell.showItemInFolder(file);
  // 资源管理器窗口会抢走前台焦点，稍后夺回，避免返回软件后输入框点不动
  setTimeout(() => ensureWindowFocus(), 600);
  return { ok: true, data: file };
});

// 直接启动安装程序（用户点击「立即安装」时使用）
handle('system:runInstaller', (p) => {
  const fs = require('fs');
  const { shell } = require('electron');
  const file = String((p && p.file) || '');
  if (!file || !fs.existsSync(file)) return { ok: false, message: '安装包文件不存在，可能已被移动或删除' };
  if (!/\.exe$/i.test(file)) {
    // 非可执行安装包（如 zip）只做定位，由用户自行解压安装
    shell.showItemInFolder(file);
    return { ok: true, data: { opened: false, file } };
  }
  return shell.openPath(file).then((err) => {
    if (err) return { ok: false, message: '启动安装程序失败：' + err };
    setTimeout(() => ensureWindowFocus(), 600);
    return { ok: true, data: { opened: true, file } };
  });
});

handle('system:copyText', (text) => {
  const { clipboard } = require('electron');
  clipboard.writeText(String(text || ''));
  return { ok: true };
});

handle('system:openUpdateDir', () => {
  const { shell } = require('electron');
  const dir = store.getUpdateDir();
  require('fs').mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
  // 资源管理器窗口会抢走前台焦点，稍后夺回，避免返回软件后输入框点不动
  setTimeout(() => ensureWindowFocus(), 600);
  return { ok: true, data: dir };
});

handle('system:localIp', () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  let ip = '';
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) {
        ip = n.address;
        break;
      }
    }
    if (ip) break;
  }
  return { ok: true, data: ip || '127.0.0.1' };
});

async function restartServerIfNeeded() {
  const cfg = store.loadConfig();
  if (cfg.mode !== 'server') return;
  try {
    if (httpServer) {
      await httpServer.close();
      httpServer = null;
    }
    httpServer = await startServer(store, { port: cfg.port });
    // 服务端后台常驻（需求13）：运行时切换到服务端也创建托盘并防休眠
    createTray();
    if (powerSaveId === null) {
      try {
        powerSaveId = powerSaveBlocker.start('prevent-app-suspension');
      } catch (e) {
        /* 忽略 */
      }
    }
  } catch (e) {
    console.error('[server] 启动失败：' + (e.message || e));
  }
}

// ---------- 窗口 ----------
let mainWindow = null;

// 窗口状态持久化：记住上次是否最大化及手动调整过的尺寸，下次启动沿用。
// 首次运行（无状态文件）默认最大化，满足「打开软件即全屏显示」的要求。
const WINDOW_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
const DEFAULT_WINDOW = { width: 1300, height: 860, isMaximized: true };

function loadWindowState() {
  try {
    const fs = require('fs');
    const state = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf8'));
    // 尺寸需落在合理范围内，避免显示器变化后窗口过小或跑出屏幕
    const width = Number(state.width) >= 800 ? Number(state.width) : DEFAULT_WINDOW.width;
    const height = Number(state.height) >= 600 ? Number(state.height) : DEFAULT_WINDOW.height;
    // 强制最大化：如果用户没有明确设置过窗口状态，或者窗口尺寸过小，都强制最大化
    const isMaximized = state.isMaximized === undefined || state.isMaximized !== false || (width < 1200 || height < 700);
    return {
      width,
      height,
      x: Number.isFinite(state.x) ? state.x : undefined,
      y: Number.isFinite(state.y) ? state.y : undefined,
      isMaximized
    };
  } catch (e) {
    // 首次运行或状态文件损坏，返回默认最大化状态
    return Object.assign({}, DEFAULT_WINDOW);
  }
}

// 保存窗口状态；最大化时用还原态尺寸记录，避免退出后下次打开变成小窗
function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const fs = require('fs');
    const isMaximized = mainWindow.isMaximized();
    let bounds;
    try {
      bounds = isMaximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    } catch (e) {
      bounds = mainWindow.getBounds();
    }
    if (!bounds || !(bounds.width > 0)) return;
    fs.mkdirSync(path.dirname(WINDOW_STATE_FILE), { recursive: true });
    fs.writeFileSync(
      WINDOW_STATE_FILE,
      JSON.stringify({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized
      }),
      'utf8'
    );
  } catch (e) {
    /* 状态保存失败不影响主流程 */
  }
}

// 拖动/缩放窗口会高频触发事件，延迟合并写入，避免反复读写磁盘
let saveWindowStateTimer = null;
function scheduleSaveWindowState() {
  if (saveWindowStateTimer) clearTimeout(saveWindowStateTimer);
  saveWindowStateTimer = setTimeout(() => {
    saveWindowStateTimer = null;
    saveWindowState();
  }, 400);
}

function createWindow() {
  const winState = loadWindowState();

  mainWindow = new BrowserWindow({
    width: winState.width,
    height: winState.height,
    x: winState.x,
    y: winState.y,
    minWidth: 1024,
    minHeight: 680,
    title: '星期衣精致洗衣衣物照片系统',
    icon: path.join(RENDERER_DIR, 'assets', 'logo.png'),
    backgroundColor: '#f2f6fc',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      // 在窗口显示后再最大化，确保生效
      if (winState.isMaximized) {
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.maximize();
          }
        }, 50);
      }
    }
  });

  // 记录用户手动调整的窗口状态；最大化/还原状态变化即时落盘
  mainWindow.on('resize', scheduleSaveWindowState);
  mainWindow.on('move', scheduleSaveWindowState);
  mainWindow.on('maximize', saveWindowState);
  mainWindow.on('unmaximize', saveWindowState);

  mainWindow.webContents.on('console-message', (_e, _level, message) => {
    console.log('[renderer] ' + message);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[main] 页面加载失败: ' + code + ' ' + desc);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] 渲染进程异常退出: ' + details.reason);
    // 渲染进程崩溃后界面会整体失去响应（含输入框），自动重载恢复，避免用户只能手动重启软件
    if (details.reason !== 'clean-exit' && mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.loadURL(APP_SCHEME + '://renderer/index.html');
      } catch (e) {
        /* 忽略 */
      }
    }
  });

  // 窗口重新获得焦点时把焦点交回页面内容：
  // 原生对话框、资源管理器窗口关闭后，Windows 可能只把焦点给到窗口边框而不给页面，
  // 此时所有输入框都点不动，这里主动补一次 webContents.focus() 作为兜底。
  mainWindow.on('focus', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.focus();
      } catch (e) {
        /* 忽略 */
      }
    }
  });

  mainWindow.loadURL(APP_SCHEME + '://renderer/index.html');

  // 服务端后台常驻（需求13）：服务端模式下点关闭按钮只把窗口隐藏到托盘，
  // HTTP 服务继续运行，避免店员客户端断连；只有托盘「退出程序」或系统退出才真正关闭。
  mainWindow.on('close', (e) => {
    // 关闭/隐藏前先落盘窗口状态（closed 事件时窗口已不可读，只能在这里保存）
    if (saveWindowStateTimer) {
      clearTimeout(saveWindowStateTimer);
      saveWindowStateTimer = null;
    }
    saveWindowState();
    if (isQuitting) return;
    if (isServerRunning()) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 服务端是否正在后台提供 HTTP 服务（用于决定是否常驻托盘）
function isServerRunning() {
  const cfg = store.loadConfig();
  return cfg.mode === 'server' && !!httpServer;
}

// 显示并聚焦主窗口（托盘菜单 / 双击托盘图标 / 窗口已销毁时重建）
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

// 创建系统托盘图标（服务端模式），提供「显示主窗口」与「退出程序」入口
function createTray() {
  if (tray) return;
  try {
    const iconPath = path.join(RENDERER_DIR, 'assets', 'logo.png');
    const image = nativeImage.createFromPath(iconPath);
    const trayImage = image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 });
    tray = new Tray(trayImage);
    tray.setToolTip('星期衣精致洗衣衣物照片系统（服务运行中）');
    const menu = Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMainWindow() },
      { type: 'separator' },
      {
        label: '退出程序',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]);
    tray.setContextMenu(menu);
    tray.on('double-click', () => showMainWindow());
  } catch (e) {
    console.error('[tray] 创建托盘失败：' + (e.message || e));
    tray = null;
  }
}

// 销毁托盘图标并释放防休眠句柄
function destroyTray() {
  if (tray) {
    try {
      tray.destroy();
    } catch (e) {
      /* 忽略 */
    }
    tray = null;
  }
  if (powerSaveId !== null) {
    try {
      powerSaveBlocker.stop(powerSaveId);
    } catch (e) {
      /* 忽略 */
    }
    powerSaveId = null;
  }
}

app.whenReady().then(async () => {
  store.ensureSeedData();
  Menu.setApplicationMenu(null);

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });

  // 界面资源协议
  protocol.handle(APP_SCHEME, (request) => {
    try {
      const u = new URL(request.url);
      let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      if (!rel) rel = 'index.html';
      const filePath = path.normalize(path.join(RENDERER_DIR, rel));
      if (filePath !== RENDERER_DIR && !filePath.startsWith(RENDERER_DIR + path.sep)) {
        return new Response('Forbidden', { status: 403 });
      }
      return net.fetch(pathToFileURL(filePath).toString());
    } catch (e) {
      return new Response('Bad Request', { status: 400 });
    }
  });

  // 照片协议：服务端模式读本地，客户端模式从远程拉取
  protocol.handle(PHOTO_SCHEME, async (request) => {
    try {
      const fileName = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ''));
      const filePath = store.resolvePhotoFile(fileName);
      if (!fileName || !filePath) {
        return new Response('Forbidden', { status: 403 });
      }
      const cfg = store.loadConfig();
      if (cfg.mode === 'client') {
        const photoUrl = cfg.serverUrl + '/photo?f=' + encodeURIComponent(fileName) + '&token=' + encodeURIComponent(cfg.serverToken);
        return net.fetch(photoUrl);
      }
      return net.fetch(pathToFileURL(filePath).toString());
    } catch (e) {
      return new Response('Bad Request', { status: 400 });
    }
  });

  // 服务端模式：启动 HTTP 服务
  const cfg = store.loadConfig();
  if (cfg.mode === 'server') {
    try {
      httpServer = await startServer(store, { port: cfg.port });
      // 服务端后台常驻（需求13）：创建托盘图标，并阻止系统休眠导致服务中断
      createTray();
      if (powerSaveId === null) {
        try {
          powerSaveId = powerSaveBlocker.start('prevent-app-suspension');
        } catch (e) {
          /* 忽略 */
        }
      }
    } catch (e) {
      console.error('[server] 启动失败：' + (e.message || e));
    }
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 服务端后台常驻（需求13）：服务仍在运行时不退出，保持托盘常驻，
  // 避免店员客户端因服务端进程退出而连接失效；客户端模式维持原有「关窗即退出」。
  if (isServerRunning()) return;
  app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  destroyTray();
  if (httpServer) {
    try {
      httpServer.close();
    } catch (e) {
      /* 忽略 */
    }
    httpServer = null;
  }
});
