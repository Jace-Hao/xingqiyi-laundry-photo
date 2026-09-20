'use strict';

/**
 * HTTP API 服务：把数据层能力暴露给网络上的客户端节点。
 * 仅使用 Node 内置模块，无需第三方依赖。
 *
 * 安全说明：
 * - 服务默认绑定 0.0.0.0（局域网可见），所有请求必须携带 x-api-token（连接码）；
 * - 跨电脑/跨网段使用时建议通过异地组网工具（如 Tailscale/ZeroTier）组成虚拟局域网，
 *   或通过内网穿透工具映射端口，不要直接把端口暴露在公网。
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { withRequestIp, SESSION_REVOKED_CODE } = require('./store');

function startServer(store, opts = {}) {
  const port = opts.port || 17521;
  const host = opts.host || '0.0.0.0';

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
        // 限制请求体 30MB（最大分辨率照片的 base64 约 20MB 以内）
        if (data.length > 30 * 1024 * 1024) {
          reject(new Error('请求数据过大'));
          req.destroy();
        }
      });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }

  function json(res, code, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(body);
  }

  async function handleApi(req, res, route, query) {
    const cfg = store.loadConfig();
    const apiToken = req.headers['x-api-token'];
    if (!apiToken || apiToken !== cfg.token) {
      return json(res, 401, { ok: false, message: '连接码无效，请检查服务器连接码配置' });
    }
    const sessionToken = req.headers['x-session-token'] || '';

    let body = {};
    if (req.method === 'POST') {
      const raw = await readBody(req);
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch (e) {
          return json(res, 400, { ok: false, message: '请求数据格式错误' });
        }
      }
    }

    const routes = {
      // 认证
      'auth/login': () => store.login(body),
      'auth/logout': () => store.logout(sessionToken),
      'auth/current': () => store.current(sessionToken),
      'auth/changePassword': () => store.changePassword(sessionToken, body),
      // 存档
      'records/add': () => store.addRecord(sessionToken, body),
      'records/list': () => store.listRecords(sessionToken, body),
      'records/get': () => store.getRecord(sessionToken, body.id),
      'records/delete': () => store.deleteRecord(sessionToken, body.id),
      'records/deleteBatch': () => store.deleteRecords(sessionToken, body.ids),
      'records/exportPhotos': () => store.exportPhotos(sessionToken, body),
      // 用户管理
      'users/list': () => store.listUsers(sessionToken),
      'users/create': () => store.createUser(sessionToken, body),
      'users/update': () => store.updateUser(sessionToken, body),
      'users/delete': () => store.deleteUser(sessionToken, body.id),
      // 日志与总览
      'logs/list': () => store.listLogs(sessionToken, body),
      'logs/actionOptions': () => store.logActionOptions(sessionToken),
      'logs/filterUsers': () => store.logFilterUsers(sessionToken),
      'stats/overview': () => store.overview(sessionToken),
      // 系统设置（仅服务端本机管理员使用）
      'system/info': () => ({ ...store.systemInfo(), localOnly: true }),
      'system/checkUpdate': () => store.checkUpdates(),
      'system/settings': () => store.updateSystemSettings(sessionToken, body),
      'system/resetToken': () => store.resetApiToken(sessionToken),
      'system/photoPath': () => store.setPhotoPath(sessionToken, body.path),
      // 强制推送安装包：客户端登录后查询，服务端管理员设置
      'system/forceUpdate': () => store.getForceUpdate(),
      'system/setForceUpdate': () => store.setForceUpdate(sessionToken, body)
    };

    const fn = routes[route];
    if (!fn) return json(res, 404, { ok: false, message: '接口不存在' });

    try {
      const data = await fn();
      return json(res, 200, { ok: true, data });
    } catch (e) {
      // 被顶下线（唯一登录）时带上 revoked 标志：
      // 客户端模式下界面靠这个字段判断该强制退回登录页，
      // 而不是把「已在其他设备登录」当成普通业务失败提示
      const revoked = e && e.code === SESSION_REVOKED_CODE;
      return json(res, 200, { ok: false, message: e.message || String(e), ...(revoked ? { revoked: true } : {}) });
    }
  }

  function handlePhoto(req, res, query) {
    const cfg = store.loadConfig();
    const apiToken = req.headers['x-api-token'] || (query.get ? query.get('token') : '');
    if (!apiToken || apiToken !== cfg.token) {
      res.writeHead(401);
      return res.end('Unauthorized');
    }
    const fileName = decodeURIComponent((query.get && query.get('f')) || '');
    const filePath = store.resolvePhotoFile(fileName);
    if (!fileName || !filePath) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    fs.readFile(filePath, (err, buf) => {
      if (err) {
        res.writeHead(404);
        return res.end('Not Found');
      }
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'private, max-age=31536000'
      });
      res.end(buf);
    });
  }

  // 强制推送的安装包分发：客户端下载安装包走 net.fetch，无法附加自定义请求头，
  // 因此沿用 /photo 的方式通过查询参数传递连接码。文件名已在数据层做路径穿越防护。
  function handleUpdateFile(req, res, query) {
    const cfg = store.loadConfig();
    const apiToken = req.headers['x-api-token'] || (query.get ? query.get('token') : '');
    if (!apiToken || apiToken !== cfg.token) {
      res.writeHead(401);
      return res.end('Unauthorized');
    }
    const fileName = decodeURIComponent((query.get && query.get('f')) || '');
    const filePath = store.resolveUpdateFile(fileName);
    if (!fileName || !filePath) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    let size = 0;
    try {
      size = fs.statSync(filePath).size;
    } catch (e) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    // 文件名只取 ASCII 可见字符（安装包名固定为英文），并用 RFC 5987 的 filename* 兼容中文
    const asciiName = fileName.replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '_');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size),
      'Content-Disposition': "attachment; filename=\"" + asciiName + "\"; filename*=UTF-8''" + encodeURIComponent(fileName),
      'Cache-Control': 'no-store'
    });
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      try {
        res.destroy();
      } catch (e) {
        /* 已断开时忽略 */
      }
    });
    // 客户端中途取消下载时停止读文件，避免无谓磁盘 IO
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    // 取客户端来源 IP（req.socket.remoteAddress），包裹整个请求处理过程，
    // 期间数据层写入的每条操作日志都会自动带上该 IP。
    const clientIp = (req.socket && req.socket.remoteAddress) || '';
    return withRequestIp(clientIp, async () => {
      try {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname.startsWith('/api/')) {
          await handleApi(req, res, url.pathname.slice(5), url.searchParams);
        } else if (url.pathname === '/photo') {
          handlePhoto(req, res, url.searchParams);
        } else if (url.pathname === '/update-file') {
          handleUpdateFile(req, res, url.searchParams);
        } else if (url.pathname === '/ping') {
          json(res, 200, { ok: true, data: { app: 'xingqiyi' } });
        } else {
          json(res, 404, { ok: false, message: 'Not Found' });
        }
      } catch (e) {
        json(res, 500, { ok: false, message: e.message || String(e) });
      }
    });
  });

  // 上传大照片时可能耗时较长
  server.timeout = 120000;

  return new Promise((resolve, reject) => {
    server.once('error', (err) => reject(err));
    server.listen(port, host, () => {
      console.log(`[server] 星期衣照片系统服务已启动：http://${host}:${port}`);
      resolve({
        port,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

module.exports = { startServer };
