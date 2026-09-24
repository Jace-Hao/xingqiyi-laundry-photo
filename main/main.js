'use strict';

const { app, BrowserWindow, ipcMain, session, Menu, protocol, net, Tray, nativeImage, powerSaveBlocker, safeStorage } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const { pathToFileURL } = require('url');
const { createStore, SESSION_REVOKED_CODE } = require('./store');
const { startServer } = require('./server');
const { createCredentialStore } = require('./credentials');
const { createThumbService, normalizeThumbSize } = require('./thumb');
const { downloadWithFallback } = require('./update-download');

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
const PKG_NAME = require('../package.json').name;
// 统一的软件更新文件夹：更新下载、备用更新扫描、强制推送三处共用这一个目录。
// 正式安装后位于软件安装目录下（…\星期衣精致洗衣衣物照片系统\软件更新）；
// 若安装目录不可写（例如装到 Program Files 且无写权限），自动退回用户数据目录。
// 开发运行（npm start）时 Electron 可执行文件在 node_modules 里，不往那里写，直接用用户数据目录。
const UPDATE_DIR = (() => {
  const candidates = app.isPackaged
    ? [path.join(path.dirname(app.getPath('exe')), '软件更新'), path.join(app.getPath('userData'), '软件更新')]
    : [path.join(app.getPath('userData'), '软件更新')];
  for (const dir of candidates) {
    try {
      const fsProbe = require('fs');
      fsProbe.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.write-test-' + process.pid);
      fsProbe.writeFileSync(probe, '');
      fsProbe.unlinkSync(probe);
      return dir;
    } catch (e) {
      /* 该目录不可用，尝试下一个 */
    }
  }
  return candidates[candidates.length - 1];
})();

// 旧版本曾把安装包分散在「系统下载目录\xingqiyi-laundry-photo」与用户数据目录的 updates 下。
// 启动时做一次尽力而为的搬迁：只复制安装包文件（不删除原文件、不覆盖新目录同名文件），
// 让历史下载的安装包继续可用（强制推送的同名缓存检查也因此能命中）。
function migrateLegacyUpdateDirs() {
  try {
    const fs = require('fs');
    const olds = [
      path.join(app.getPath('downloads'), 'xingqiyi-laundry-photo'),
      path.join(app.getPath('userData'), 'updates')
    ];
    for (const old of olds) {
      if (path.resolve(old) === path.resolve(UPDATE_DIR)) continue;
      if (!fs.existsSync(old)) continue;
      for (const name of fs.readdirSync(old)) {
        if (!/\.exe$/i.test(name)) continue;
        const dst = path.join(UPDATE_DIR, name);
        if (fs.existsSync(dst)) continue;
        try {
          fs.copyFileSync(path.join(old, name), dst);
        } catch (e) {
          /* 单个文件失败不影响其余 */
        }
      }
    }
  } catch (e) {
    /* 搬迁失败不影响启动 */
  }
}

// 缩略图缓存目录：放在 userData 下而非照片目录内。
// 照片目录是用户数据，往里写生成文件会扩大备份范围，也可能被同步盘反复上传。
const THUMBS_DIR = path.join(app.getPath('userData'), 'thumbs');

// 更新分发：通过 GitHub Releases 发布安装包，应用从这里检查最新版本。
// 仓库地址须与 package.json 的 repository 保持一致。
const GITHUB_REPO = 'Jace-Hao/xingqiyi-laundry-photo';
const GITHUB_RELEASES_PAGE = 'https://github.com/' + GITHUB_REPO + '/releases/latest';

// 国内加速通道：GitHub 直连不稳定时自动改用（下载安装包 / 检查更新共用）。
// 如某个镜像失效，调整此列表即可（列表内保留至少一个可用镜像）。
const GH_ACCEL = [
  'https://gh-proxy.com/',
  'https://ghproxy.net/',
  'https://gh.ddlc.top/'
];
// 检查更新接口的加速前缀（仅使用已验证可代理 api.github.com 的镜像）
const GH_ACCEL_API = ['https://gh-proxy.com/'];

// 生成下载候选地址：GitHub 链接 → [直连, 加速1, 加速2, …]；其他链接（内网服务端推送）→ [直连]
function buildDownloadCandidates(rawUrl) {
  const u = String(rawUrl || '');
  if (!/^https?:\/\//i.test(u)) return [];
  const isGh = /^https?:\/\/(github\.com|objects\.githubusercontent\.com|codeload\.github\.com)\//i.test(u);
  const already = GH_ACCEL.some((p) => u.startsWith(p));
  const list = [{ url: u, channel: isGh ? 'direct' : 'lan' }];
  if (isGh && !already) {
    for (const p of GH_ACCEL) list.push({ url: p + u, channel: 'accel' });
  }
  return list;
}

const store = createStore({
  dataDir: DATA_DIR,
  defaultPhotoDir: DEFAULT_PHOTO_DIR,
  updateDir: UPDATE_DIR,
  appVersion: APP_VERSION,
  photoScheme: PHOTO_SCHEME,
  // 照片删除 / 批量删除 / 保留期清理时同步清理缩略图缓存
  thumbsDir: THUMBS_DIR
});

// 缩略图缓存服务：网格图片以 ?w=<宽度> 请求缩略图，生成一次后缓存复用，
// 避免每次为约 180px 的显示区加载数 MB 的原图。nativeImage 由 Electron 注入，
// 模块在纯 Node 下也可加载（验证脚本用假实现测试其余逻辑）。
const thumbService = createThumbService({ thumbsDir: THUMBS_DIR, nativeImage });

// 登录凭据保存（记住账号 / 记住密码）：
// 文件位于本机用户数据目录，密码经 Electron safeStorage 系统级加密后保存，
// 明文密码只存在于内存中的输入框，绝不写入磁盘或日志。
const credentials = createCredentialStore({
  filePath: path.join(DATA_DIR, 'credentials.json'),
  safeStorage
});

let httpServer = null;

// 服务端后台常驻（需求13）：托盘图标、真正退出标志、防休眠句柄
let tray = null;
let isQuitting = false;
let powerSaveId = null;

// ---------- 开机自动启动 ----------
// 通过 Electron 登录项（Windows 下写入注册表 Run 键）实现，并附带 --hidden 参数，
// 使自启时静默驻留托盘、不弹窗打扰开机。用户手动启动不带该参数，行为与以前一致。
const AUTO_LAUNCH_FLAG = '--hidden';
// 本次进程是否由开机自启拉起。用于界面如实显示「本次启动方式」，创建后不再改动。
const launchedHidden = process.argv.includes(AUTO_LAUNCH_FLAG);
// 一次性静默标记：仅「自启后创建的第一个窗口」静默驻留，被 createWindow 消费。
// 与 launchedHidden 分开，是为了窗口重建、以及界面报告启动方式时互不干扰。
let pendingHiddenStart = launchedHidden;

/** 读取当前开机自启状态（以系统登录项的真实值为准，不依赖配置缓存） */
function getAutoLaunch() {
  try {
    const s = app.getLoginItemSettings({ args: [AUTO_LAUNCH_FLAG] });
    return {
      enabled: !!s.openAtLogin,
      // 开机时系统是否已登记该登录项但当前进程并非由它启动（少见，用于界面提示）
      willLaunchAtLogin: !!s.executableWillLaunchAtLogin,
      restoreState: !!s.restoreState
    };
  } catch (e) {
    return { enabled: false, willLaunchAtLogin: false, restoreState: false, error: e.message || String(e) };
  }
}

/**
 * 设置或取消开机自启。
 * 仅服务端模式允许开启：客户端是工位机，无需常驻，默认不应开机启动。
 * 关闭时同时清掉 --hidden 参数，避免残留无效登录项配置。
 */
function setAutoLaunch(enable) {
  const cfg = store.loadConfig();
  if (enable && cfg.mode !== 'server') {
    throw new Error('开机自动启动仅服务端模式可用；如需常驻服务，请先在系统设置中切换为服务端模式');
  }
  app.setLoginItemSettings({
    openAtLogin: !!enable,
    args: enable ? [AUTO_LAUNCH_FLAG] : [],
    // 开机自启时不需要恢复上次窗口状态，静默驻留托盘即可
    openAsHidden: false
  });
  const after = getAutoLaunch();
  if (!!enable !== after.enabled) {
    // 系统未接受设置（如被组策略禁止），必须如实告知，不能假装成功
    throw new Error('系统未接受开机自启设置，可能被组策略或权限限制');
  }
  return after;
}

/**
 * 进入客户端模式时回收开机自启登录项。
 *
 * 开机自启仅服务端模式允许。本机改为客户端后若仍保留登录项，工位机会每次开机
 * 自启并常驻，因此切换路径（setMode / setClientConfig）都要调用本函数回收。
 * 返回是否真的清除了，供界面如实告知；清除失败只记录日志，不阻塞模式切换。
 */
function clearAutoLaunchForClient() {
  try {
    if (getAutoLaunch().enabled) {
      setAutoLaunch(false);
      return true;
    }
  } catch (e) {
    console.error('[autoLaunch] 切换为客户端时清除开机自启失败：' + (e.message || e));
  }
  return false;
}

// ---------- 单实例锁 ----------
// 开机自启后用户仍可能手动双击图标启动第二个实例，两个实例会争抢同一服务端口，
// 导致后启动者报端口占用、或客户端连到错误实例。这里强制单实例：
// 已存在实例时直接退出，并唤起已有窗口。
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // 不是首个实例：必须立即退出，且绝不能执行任何初始化。
  //
  // 注意这里不能用 app.quit()：quit 在 app ready 之前调用会被推迟到 ready 之后，
  // 因此下方 whenReady 回调仍会执行完，导致第二个实例照样初始化数据库、
  // 注册协议并监听同一端口——两个进程同时读写同一 data 目录还可能损坏数据文件。
  // app.exit() 立即结束进程，不触发 before-quit / will-quit，也不会等 ready。
  app.exit(0);
} else {
  app.on('second-instance', () => {
    // 用户再次启动时把已有窗口唤到前台，而不是毫无反应
    showMainWindow();
  });
}

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
    'logs/actionOptions': () => store.logActionOptions(token),
    'logs/filterUsers': () => store.logFilterUsers(token),
    'stats/overview': () => store.overview(token)
  };
  const fn = routes[route];
  if (!fn) return Promise.resolve({ ok: false, message: '接口不存在' });
  try {
    return Promise.resolve({ ok: true, data: fn() });
  } catch (e) {
    // 这一层最先捕获数据层抛出的异常，必须把会话失效的错误码转成 revoked 标志带上：
    // err.code 无法跨 IPC 传递，若在此丢弃，界面就再也分不清
    // 「被顶下线」与普通的「未登录」，被踢的店员会误以为是密码问题
    const revoked = e && e.code === SESSION_REVOKED_CODE;
    return Promise.resolve({ ok: false, message: e.message || String(e), ...(revoked ? { revoked: true } : {}) });
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
    // 必须在此透传 revoked 标志：dispatch 会先于 handle 捕获异常并正常返回，
    // 若不带上，服务端模式下被顶下线的用户只会看到笼统的失败提示，
    // 界面无法识别该强制退回登录页
    const revoked = e && e.code === SESSION_REVOKED_CODE;
    return { ok: false, message: e.message || String(e), ...(revoked ? { revoked: true } : {}) };
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
  let remoteKey = '';
  for (const [k, s] of offlineSessions.entries()) {
    if (s.serverToken) {
      remoteToken = s.serverToken;
      remoteKey = k;
      break;
    }
  }
  if (!remoteToken) return { synced: 0, failed: 0, reason: '缺少可用的登录会话，暂不同步' };

  let synced = 0;
  let failed = 0;
  let tokenRevoked = false;
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
        // 令牌被顶下线：这个会话条目已经废了，留着只会让后续每一轮同步都
        // 先撞上它然后中断，离线数据永远补传不上去。主动清理，
        // 让下一轮能选到其他有效会话，或明确提示需要重新登录。
        // 注意不清理队列本身——数据要留到用户重新登录后再传。
        if (r.revoked) {
          tokenRevoked = true;
          if (remoteKey) offlineSessions.delete(remoteKey);
        }
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
  return {
    synced,
    failed,
    remaining: store.pendingSyncCount(),
    ...(tokenRevoked ? { reason: '登录会话已在其他设备失效，请重新登录后再同步离线存档' } : {})
  };
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
      // 被顶下线（唯一登录）时额外给出 revoked 标志：
      // err.code 无法经结构化克隆传到渲染进程，必须显式放进返回对象，
      // 界面据此强制退回登录页，而不是当成普通操作失败弹个 toast 了事
      const revoked = e && e.code === SESSION_REVOKED_CODE;
      return { ok: false, message: e.message || String(e), ...(revoked ? { revoked: true } : {}) };
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
      // 清理该账号此前的会话条目。
      //
      // 必须做：offlineSessions 是 Map（插入序），而离线同步会遍历取第一个带
      // serverToken 的条目。唯一登录开启后，账号在其他设备登录会把本机旧令牌
      // 顶下线；若旧条目残留且排在新条目之前，同步就会先拿失效令牌去请求，
      // 服务端返回失败后同步中断（break），每次重试都撞同一个死令牌，
      // 导致离线录入的数据永远补传不上去、队列无限堆积。
      const username = r.data.user.username;
      for (const [k, v] of [...offlineSessions.entries()]) {
        if (k !== r.data.sessionToken && v && v.username === username) offlineSessions.delete(k);
      }
      offlineSessions.set(r.data.sessionToken, {
        username,
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
  // 激活拦截：试用到期或激活密钥缺失时，必须先解决授权问题才能继续使用
  const lic = store.licenseStatus();
  if (lic.state === 'expired') {
    return { ok: false, expired: true, message: '试用期已结束，请在本机输入激活码后继续使用（机器码：' + lic.machineCode + '）', license: lic };
  }
  if (lic.state === 'unavailable') {
    return {
      ok: false,
      license: lic,
      message: '激活组件不完整（缺少激活密钥文件），无法验证授权。请重新安装完整安装包，或联系软件维护者获取。'
    };
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
handle('logs:actionOptions', (_p, token) => dispatch('logs/actionOptions', undefined, token));
handle('logs:filterUsers', (_p, token) => dispatch('logs/filterUsers', undefined, token));
handle('stats:overview', (_p, token) => dispatch('stats/overview', undefined, token));

// ---------- 系统配置类（本地，不随客户端转发） ----------
handle('system:info', () => {
  const info = store.systemInfo();
  return { ok: true, data: info };
});

// 四级角色清单与能力矩阵：静态元数据，取数据层单一数据源，
// 供前端渲染角色下拉与能力提示，避免前端再硬编码一份而与后端脱节
handle('system:roles', () => {
  return { ok: true, data: { roles: store.roleOptions, defs: store.roleDefs } };
});

// ---------- 内置操作手册 ----------
// 读取的是 scripts/sync-manual.js 同步到 renderer/assets/manual.md 的副本：
// 该文件由 electron-builder 的 files: renderer/**/* 打进 app.asar，
// 而 docs/manual.md 不在打包范围内（打包后读不到），故不能直接读 docs 下的源文件。
// Electron 的 fs 对 asar 内文件透明支持，readFileSync 可直接读取。
const MANUAL_FILE = path.join(RENDERER_DIR, 'assets', 'manual.md');

handle('system:manual', () => {
  const fs = require('fs');
  try {
    if (!fs.existsSync(MANUAL_FILE)) {
      return {
        ok: false,
        // 明确区分「没打包进来」与「文件损坏」，便于排查发布遗漏
        message: '未找到内置手册文件（renderer/assets/manual.md）。请执行 npm run sync-manual 后重新打包。'
      };
    }
    const text = fs.readFileSync(MANUAL_FILE, 'utf8');
    if (!text.trim()) return { ok: false, message: '内置手册文件为空' };
    // 从标题行提取手册版本号，供界面显示「手册与软件版本是否一致」
    const m = text.match(/^#\s+.*?v(\d+\.\d+\.\d+)/m) || text.match(/版本：\s*v(\d+\.\d+\.\d+)/);
    return {
      ok: true,
      data: { text, manualVersion: m ? m[1] : '', appVersion: APP_VERSION }
    };
  } catch (e) {
    return { ok: false, message: '读取手册失败：' + (e.message || String(e)) };
  }
});

// ---------- 开机自动启动 ----------
// 读取状态无需登录（设置页会展示当前状态）；修改必须是系统管理员，
// 避免工位机被普通账号改成开机常驻。执行顺序：先鉴权 → 再改系统登录项 → 成功后记审计日志。
handle('system:autoLaunch', () => {
  try {
    const data = getAutoLaunch();
    return {
      ok: true,
      data: {
        ...data,
        supported: process.platform === 'win32' || process.platform === 'darwin',
        platform: process.platform,
        launchedHidden,
        // 仅服务端可开启：前端据此禁用开关并说明原因
        serverMode: store.loadConfig().mode === 'server'
      }
    };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
});

handle('system:setAutoLaunch', (p, token) => {
  const enabled = !!(p && p.enabled);
  try {
    // 先鉴权（数据层统一口径），未通过则不会改动系统任何状态
    store.requireSystemSettings(token);
    // 执行系统调用；失败会抛错，此时不记日志，避免留下「设置成功」的假记录
    const data = setAutoLaunch(enabled);
    // 成功后补记审计日志
    store.logSystemChange(
      token,
      enabled ? '开启开机自启' : '取消开机自启',
      `开机自动启动：${enabled ? '已开启（登录后静默驻留托盘）' : '已取消'}`
    );
    return { ok: true, data: { ...data, enabled } };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
});

// ---------- 登录凭据保存（记住账号 / 记住密码） ----------
// 这些接口在登录之前就要可用（登录页需要读取已保存账号来自动填充），因此不校验会话令牌。
// 安全约束：密码经 safeStorage 系统级加密后才落盘；明文密码只在内存中传给输入框，
// 不写入日志、不打印、不随网络传输。列表接口刻意不返回密文，避免密文流到界面层。
handle('credentials:list', () => {
  try {
    return { ok: true, data: { accounts: credentials.list(), passwordSupported: credentials.passwordSupported() } };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
});

// 取出某账号已保存的密码用于自动填充；解密失败时返回空密码并给出可读原因
handle('credentials:get', (p) => {
  try {
    const data = credentials.get((p && p.username) || '');
    return { ok: true, data };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
});

// 保存账号（登录成功后调用）。rememberPassword=false 时会清除该账号已保存的密文
handle('credentials:save', (p) => {
  try {
    const data = credentials.save(p || {});
    return { ok: true, data };
  } catch (e) {
    // 保存凭据失败不应影响登录本身，错误只回传给界面提示
    return { ok: false, message: e.message || String(e) };
  }
});

handle('credentials:remove', (p) => {
  try {
    return { ok: true, data: { removed: credentials.remove((p && p.username) || '') } };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
});

handle('credentials:clear', () => {
  try {
    return { ok: true, data: { cleared: credentials.clear() } };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
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
  let autoLaunchCleared = false;
  if (data.mode === 'server') {
    await restartServerIfNeeded();
    // 切换为服务端：数据以本机为准，启用订单自动清理调度
    scheduleAutoPurge();
  } else {
    // 开机自启仅服务端允许，切到客户端时回收残留登录项，维持该不变量
    autoLaunchCleared = clearAutoLaunchForClient();
    // 客户端本机存档只是镜像，停止清理调度，避免删掉与服务端不一致的数据
    stopAutoPurge();
    if (httpServer) {
      await httpServer.close();
      httpServer = null;
      destroyTray();
    }
  }
  return { ok: true, data: { ...data, autoLaunchCleared } };
});

handle('system:setClientConfig', async ({ serverUrl, serverToken } = {}) => {
  try {
    const data = store.setClientConfig(serverUrl, serverToken);
    // 与 setMode 一致：配置为客户端同样要回收开机自启登录项，
    // 否则服务端改配为客户端后仍会每次开机自启并常驻
    const autoLaunchCleared = clearAutoLaunchForClient();
    // 已配置为客户端，停止订单自动清理调度
    stopAutoPurge();
    if (httpServer) {
      await httpServer.close();
      httpServer = null;
      destroyTray();
    }
    return { ok: true, data: { ...data, autoLaunchCleared } };
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
  const apiPath = 'https://api.github.com/repos/' + GITHUB_REPO + '/releases?per_page=20';
  // 直连超时/失败后，经国内加速镜像重试（镜像转发 api.github.com 的 JSON）
  const apiCandidates = [apiPath].concat(GH_ACCEL_API.map((p) => p + apiPath));
  const fetchOnce = async (url, timeoutMs) => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    try {
      return await net.fetch(url, {
        signal: c.signal,
        headers: {
          'User-Agent': 'xingqiyi-laundry-photo',
          Accept: 'application/vnd.github+json'
        }
      });
    } finally {
      clearTimeout(t);
    }
  };
  const fetchAll = async () => {
    let lastMessage = '无法连接 GitHub';
    let list = null;
    for (const url of apiCandidates) {
      try {
        const resp = await fetchOnce(url, 10000);
        if (!resp.ok) { lastMessage = 'GitHub 返回状态 ' + resp.status; continue; }
        const data = await resp.json();
        if (Array.isArray(data)) { list = data; break; }
        lastMessage = 'GitHub 返回数据异常';
      } catch (e) {
        lastMessage = '无法连接 GitHub：' + (e.message || e.code);
      }
    }
    if (!list) return { ok: false, message: lastMessage };
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
  // 超时兜底：避免网络异常时界面长时间卡在「检查中」（已含一次加速重试，整体放宽到 24 秒）
  return Promise.race([
    fetchAll().catch((e) => ({ ok: false, message: '无法连接 GitHub：' + (e.message || e.code) })),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, message: '连接 GitHub 超时' }), 24000))
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
// 从 GitHub Releases 或服务端强制推送地址下载安装包到统一的「软件更新」文件夹（安装目录下），
// GitHub 直连不稳定时自动降级到国内加速通道重试；边下边报进度，完成后自动打开文件夹定位文件。
// 手动下载与强制推送自动下载共用此实现。
let activeDownload = null;

async function downloadInstaller(url, name, opts = {}) {
  const fs = require('fs');
  const openFolder = opts.openFolder !== false;
  if (activeDownload) return { ok: false, message: '正在下载中，请稍候…' };
  const candidates = buildDownloadCandidates(url);
  if (!candidates.length) return { ok: false, message: '下载地址无效' };
  if (!mainWindow) return { ok: false, message: '窗口未就绪' };

  const dir = UPDATE_DIR;
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
  activeDownload = { url: String(url), cancel: () => controller.abort() };
  let lastSent = 0;
  try {
    // 多地址自动降级：GitHub 直连不稳定时依次切换国内加速通道（实现见 update-download.js）
    const res = await downloadWithFallback({
      candidates,
      destPart: tmp,
      fetchImpl: (u, o) => net.fetch(u, o),
      signal: controller.signal,
      onAttempt: (index, count, cand) => {
        lastSent = 0;
        // 尝试开始先推一条进度（0%），让界面及时显示当前通道
        send('update:download-progress', { received: 0, total: 0, channel: cand.channel });
      },
      onProgress: (received, total, channel) => {
        const t = Date.now();
        if (t - lastSent >= 400 || (total > 0 && received >= total)) {
          lastSent = t;
          send('update:download-progress', { received, total, channel });
        }
      }
    });
    if (!res.ok) {
      try {
        fs.unlinkSync(tmp);
      } catch (e) {
        /* 忽略 */
      }
      return { ok: false, canceled: !!res.canceled, message: res.message || (res.canceled ? '已取消下载' : '下载失败') };
    }

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
    return { ok: true, data: { file: finalTarget, size: res.bytes, channel: res.channel } };
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      /* 忽略 */
    }
    if (controller.signal.aborted) return { ok: false, canceled: true, message: '已取消下载' };
    return { ok: false, message: '下载失败：' + (e.message || String(e)) };
  } finally {
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

// ---------- 订单数据保留期与自动清理 ----------
// 属于服务端本机设置（与照片保存路径同理）：数据以服务端为准，
// 客户端机器上的存档只是镜像，因此不做远程转发，客户端模式下界面禁用该项。
handle('system:retention', (_p, token) => {
  try {
    return { ok: true, data: store.getRetention(token) };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
});

handle('system:setRetention', (p, token) => {
  try {
    // days 为 null / 空字符串表示取消自动删除；数字则须通过数据层的严格校验
    const data = store.setRetention(token, p ? p.days : null);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
});

// 手动执行清理。dryRun=true 时只统计不删除，供管理员在真删前预览影响面。
// 设置保留期本身不会立即删数据——删除只发生在自动任务或这里的显式操作，
// 避免管理员改个数字就意外触发不可逆的批量删除。
handle('system:purgeExpired', (p, token) => {
  try {
    const data = store.purgeExpiredRecords({ token, dryRun: !!(p && p.dryRun) });
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
  const dir = UPDATE_DIR;
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
    startUpdaterCoExitWatcher();
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
    httpServer = await startServer(store, { port: cfg.port, thumbs: thumbService });
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

// 窗口状态持久化：记录手动调整过的尺寸与位置（作为最大化前的过渡参数）。
// 「打开即最大化」：无论上次是否手动还原过窗口，启动/唤出都会最大化显示，
// 满足「打开软件即全屏显示」的要求（开机自启静默驻留、从托盘唤出的场景见 showMainWindow）。
const WINDOW_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
const DEFAULT_WINDOW = { width: 1300, height: 860, isMaximized: true };

function loadWindowState() {
  try {
    const fs = require('fs');
    const state = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf8'));
    // 尺寸需落在合理范围内，避免显示器变化后窗口过小或跑出屏幕
    const width = Number(state.width) >= 800 ? Number(state.width) : DEFAULT_WINDOW.width;
    const height = Number(state.height) >= 600 ? Number(state.height) : DEFAULT_WINDOW.height;
    // 打开即最大化：固定为最大化（不再区分上次是否手动还原过；
    // 如需恢复「记住手动还原状态」的旧行为，改为解析 state.isMaximized 即可）
    const isMaximized = true;
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
  // 一次性消费：仅自启后创建的第一个窗口静默驻留，之后的窗口重建都正常显示
  const startHidden = pendingHiddenStart;
  pendingHiddenStart = false;

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
      // 开机自启时静默驻留托盘，不弹窗打扰开机。
      // 前提是本机确实在跑服务并有托盘可回来（服务端模式）：
      // 若模式已被改成客户端（没有托盘），隐藏窗口会导致软件完全无法访问，
      // 因此这种情况一律正常显示窗口。
      //
      // startHidden 取自 createWindow 开头一次性消费的值，只有「开机自启后创建的第一个窗口」
      // 才会静默；此后任何窗口重建（activate、托盘唤出时窗口已销毁等）都正常显示。
      if (startHidden && isServerRunning() && tray) {
        // 不 show，也不抢焦点；窗口保留在后台，随时可从托盘唤出
        return;
      }
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
    // v1.1.6 修复：检测到本应用的更新安装器/卸载器正在运行时，点关闭=真正退出，
    // 让升级流程顺利完成（此前服务端模式会隐藏到托盘，安装器只能反复强杀；
    // 旧版安装器还会因路径前缀误判把安装器自己一起关掉，导致安装中断）。
    if (isUpdaterProcessRunningSync()) return;
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

// ---------- 更新安装器协同退出（v1.1.6） ----------
// 安装包固定存放在 安装目录\软件更新\ 内。electron-builder 默认的「关闭正在运行的应用」
// 逻辑按 $INSTDIR 路径前缀匹配进程，会把位于该目录内的安装器自己也匹配进去：
// 温和阶段向安装器发 WM_CLOSE（安装器直接消失），强制阶段直接结束自身进程
// （安装中断、临时目录残留）——即用户反馈的「软件关闭的同时安装程序也被关闭」。
// 安装器侧已改为按进程名精准关闭（build/installer.nsh），这里让软件侧配合：
// 检测到安装器/卸载器运行时真正退出，而不是隐藏到托盘。

// 从 tasklist 输出解析进程名列表（中文 Windows 下 tasklist 输出为 GBK 编码）
function parseProcessNamesFromTasklist(buf) {
  let text = '';
  try {
    text = new TextDecoder('gbk').decode(buf);
  } catch (e) {
    text = buf.toString('utf8');
  }
  const names = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^"([^"]+)"/);
    if (m) names.push(m[1].toLowerCase());
  }
  return names;
}

function isUpdaterProcessName(name) {
  // 安装包：{包名}-setup-{版本}.exe（文件名含版本号，按前缀匹配）
  if (name.startsWith(PKG_NAME + '-setup')) return true;
  // 卸载器：Uninstall {产品名}.exe
  if (name.startsWith('uninstall ' + app.getName().toLowerCase())) return true;
  return false;
}

// 同步版本：关闭事件里必须立刻决定是否 preventDefault，容许一次性几百毫秒的检测耗时
function isUpdaterProcessRunningSync() {
  try {
    const { execFileSync } = require('child_process');
    const buf = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5000
    });
    return parseProcessNamesFromTasklist(buf).some(isUpdaterProcessName);
  } catch (e) {
    // 检测失败按未运行处理，回退到原有隐藏逻辑
    return false;
  }
}

// 异步版本：安装器启动后的轮询监视用
function isUpdaterProcessRunning() {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    execFile('tasklist', ['/FO', 'CSV', '/NH'], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5000
    }, (err, stdout) => {
      try {
        if (err && !stdout) return resolve(false);
        resolve(parseProcessNamesFromTasklist(stdout).some(isUpdaterProcessName));
      } catch (e) {
        resolve(false);
      }
    });
  });
}

// 「立即安装」启动安装器后：轮询等待安装器进程出现，出现即自动退出软件，
// 把升级流程完整让给安装器（数据均已即时落盘，退出走正常清理）。
let updaterCoExitTimer = null;
function startUpdaterCoExitWatcher() {
  if (updaterCoExitTimer) return; // 已在监视中
  let tries = 0;
  updaterCoExitTimer = setInterval(() => {
    tries += 1;
    if (tries > 240) { // 最多监视 8 分钟，超时放弃（例如安装包被取消）
      clearInterval(updaterCoExitTimer);
      updaterCoExitTimer = null;
      return;
    }
    isUpdaterProcessRunning().then((running) => {
      if (!running) return;
      clearInterval(updaterCoExitTimer);
      updaterCoExitTimer = null;
      app.quit();
    }).catch(() => {});
  }, 2000);
}

// 显示并聚焦主窗口（托盘菜单 / 双击托盘图标 / 窗口已销毁时重建）
function showMainWindow() {
  // 静默标记已在 createWindow 中一次性消费，这里无需再处理：
  // 用户主动唤出时重建的窗口必然正常显示，不会被藏起来
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  // 唤出即最大化：开机自启静默驻留的窗口在创建时不能执行最大化
  // （Electron 的 maximize() 会把隐藏窗口一并显示出来，破坏静默驻留），
  // 因此统一在唤出路径补齐，保证「从托盘/快捷方式打开」与直接启动一致。
  try {
    if (!mainWindow.isMaximized()) mainWindow.maximize();
  } catch (e) {
    /* 忽略 */
  }
  // 复用统一的焦点恢复逻辑（含 restore 与 webContents.focus）：
  // 静默驻留后首次唤出若缺少 webContents.focus()，会重现 v0.1.7 那个
  // 「窗口显示出来但所有输入框点不动、必须重启软件」的问题
  ensureWindowFocus();
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

// ---------- 订单数据自动清理调度 ----------
// 仅服务端模式执行；实际删除逻辑与全部安全闸（未配置禁用、非服务端跳过、
// 全删熔断）都在数据层 purgeExpiredRecords 内，这里只负责「何时触发」。
let purgeStartupTimer = null;
let purgeIntervalTimer = null;
// 启动后延迟 90 秒再首次清理：避开开机与服务启动的高峰，
// 也给系统时钟留出与时间服务器同步的余地（时钟未同步时全删熔断会兜底）
const PURGE_STARTUP_DELAY_MS = 90 * 1000;
// 每 6 小时检查一次：服务端通常长期开机，按小时级轮询即可及时清理，
// 又不必每分钟空转
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;

function runAutoPurge() {
  try {
    // 每次执行前重新判断模式：运行中可能已从服务端切到客户端
    if (store.loadConfig().mode !== 'server') return;
    // 不带 token 即自动执行：数据层据此启用「全删熔断」，
    // 时钟异常导致将删光全部订单时会拒绝删除并告警
    const r = store.purgeExpiredRecords({});
    if (r && r.deleted > 0) {
      console.log('[auto-purge] 已清理超期订单 ' + r.deleted + ' 条：' + r.reason);
    }
  } catch (e) {
    // 自动任务绝不能因异常中断主进程或服务
    console.error('[auto-purge] 自动清理异常：' + (e.message || e));
  }
}

// 幂等：重复调用（启动时、运行中切换到服务端时）会先清掉旧定时器再重排，
// 避免叠加出多个并行定时器导致重复清理
function scheduleAutoPurge() {
  if (purgeStartupTimer) clearTimeout(purgeStartupTimer);
  if (purgeIntervalTimer) clearInterval(purgeIntervalTimer);
  purgeStartupTimer = setTimeout(() => {
    purgeStartupTimer = null;
    runAutoPurge();
  }, PURGE_STARTUP_DELAY_MS);
  purgeIntervalTimer = setInterval(runAutoPurge, PURGE_INTERVAL_MS);
}

function stopAutoPurge() {
  if (purgeStartupTimer) {
    clearTimeout(purgeStartupTimer);
    purgeStartupTimer = null;
  }
  if (purgeIntervalTimer) {
    clearInterval(purgeIntervalTimer);
    purgeIntervalTimer = null;
  }
}

app.whenReady().then(async () => {
  // 第二道单实例守卫：正常情况下未获锁的实例早已 app.exit(0)，不会走到这里。
  // 保留这层判断是防止将来重构时（例如改动退出方式）让重复实例重新初始化，
  // 造成两个进程同时读写同一 data 目录、争抢同一服务端口。
  if (!gotSingleInstanceLock) return;

  store.ensureSeedData();
  // 把旧位置（系统下载目录 / 用户数据目录）里的历史安装包搬进统一的「软件更新」文件夹
  migrateLegacyUpdateDirs();
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

  // 照片协议：服务端模式读本地，客户端模式从远程拉取；带 ?w= 时返回缩略图（失败回退原图）
  protocol.handle(PHOTO_SCHEME, async (request) => {
    try {
      const u = new URL(request.url);
      const fileName = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
      // 网格缩略图参数 ?w=：非法值返回 null，按「无参数」处理、回退原图
      const width = normalizeThumbSize(u.searchParams.get('w'));
      const filePath = store.resolvePhotoFile(fileName);
      if (!fileName || !filePath) {
        return new Response('Forbidden', { status: 403 });
      }
      const cfg = store.loadConfig();
      if (cfg.mode === 'client') {
        const photoUrl = cfg.serverUrl + '/photo?f=' + encodeURIComponent(fileName) + (width ? '&w=' + width : '') + '&token=' + encodeURIComponent(cfg.serverToken);
        return net.fetch(photoUrl);
      }
      if (width) {
        // 缩略图：命中缓存或生成成功时返回缓存文件；失败回退原图
        const thumbPath = thumbService.getOrCreate(filePath, fileName, width);
        if (thumbPath) return net.fetch(pathToFileURL(thumbPath).toString());
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
      httpServer = await startServer(store, { port: cfg.port, thumbs: thumbService });
      // 服务端后台常驻（需求13）：创建托盘图标，并阻止系统休眠导致服务中断
      createTray();
      if (powerSaveId === null) {
        try {
          powerSaveId = powerSaveBlocker.start('prevent-app-suspension');
        } catch (e) {
          /* 忽略 */
        }
      }
      // 服务端以本机数据为准，启用订单自动清理调度
      // （未配置保留期时数据层会直接跳过，不会删任何数据）
      scheduleAutoPurge();
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
  // 先停掉自动清理定时器：避免退出过程中刚好触发清理，
  // 与关闭流程并发读写 records.json 和照片文件
  stopAutoPurge();
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
