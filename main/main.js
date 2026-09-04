'use strict';

const { app, BrowserWindow, ipcMain, session, Menu, protocol, net } = require('electron');
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

// ---------- 统一分发：按运行模式决定本地执行或远程转发 ----------
async function dispatch(route, body, sessionToken) {
  try {
    const cfg = store.loadConfig();
    if (cfg.mode === 'client') {
      return await remoteCall(route, body, sessionToken);
    }
    return await localCall(route, body, sessionToken);
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
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

handle('auth:login', (p) => dispatch('auth/login', p));
handle('auth:logout', (_p, token) => dispatch('auth/logout', undefined, token));
handle('auth:current', (_p, token) => dispatch('auth/current', undefined, token));
handle('auth:changePassword', (p, token) => dispatch('auth/changePassword', p, token));

handle('records:add', (p, token) => dispatch('records/add', p, token));
handle('records:list', (p, token) => dispatch('records/list', p, token));
handle('records:get', (p, token) => dispatch('records/get', p, token));
handle('records:delete', (p, token) => dispatch('records/delete', p, token));
handle('records:deleteBatch', (p, token) => dispatch('records/deleteBatch', p, token));

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

handle('system:setMode', async (mode) => {
  const data = store.setMode(mode);
  if (data.mode === 'server') {
    await restartServerIfNeeded();
  } else if (httpServer) {
    await httpServer.close();
    httpServer = null;
  }
  return { ok: true, data };
});

handle('system:setClientConfig', async ({ serverUrl, serverToken } = {}) => {
  try {
    const data = store.setClientConfig(serverUrl, serverToken);
    if (httpServer) {
      await httpServer.close();
      httpServer = null;
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

handle('system:choosePhotoDir', () => {
  const { dialog } = require('electron');
  return dialog
    .showOpenDialog(mainWindow, {
      title: '选择照片保存目录',
      properties: ['openDirectory', 'createDirectory']
    })
    .then((r) => (r.canceled || !r.filePaths.length ? { ok: false, message: '已取消' } : { ok: true, data: r.filePaths[0] }));
});

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
      downloadUrl: (asset && asset.browser_download_url) || best.rel.html_url || GITHUB_RELEASES_PAGE
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
  } catch (e) {
    console.error('[server] 启动失败：' + (e.message || e));
  }
}

// ---------- 窗口 ----------
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    title: '星期衣精致洗衣衣物照片系统',
    backgroundColor: '#f2f6fc',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.on('console-message', (_e, _level, message) => {
    console.log('[renderer] ' + message);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[main] 页面加载失败: ' + code + ' ' + desc);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] 渲染进程异常退出: ' + details.reason);
  });

  mainWindow.loadURL(APP_SCHEME + '://renderer/index.html');
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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
  app.quit();
});

app.on('before-quit', () => {
  if (httpServer) {
    try {
      httpServer.close();
    } catch (e) {
      /* 忽略 */
    }
  }
});
