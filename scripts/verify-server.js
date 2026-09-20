'use strict';

/**
 * HTTP API 无头验证：启动服务端，模拟客户端节点通过网络调用全部接口。
 * 运行：node scripts/verify-server.js
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { createStore } = require('../main/store');
const { startServer } = require('../main/server');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xqy-srv-test-'));
const store = createStore({
  dataDir: path.join(tmpDir, 'data'),
  defaultPhotoDir: path.join(tmpDir, 'photos'),
  photoScheme: 'xqy-photo'
});
store.ensureSeedData();

const PORT = 17999;
let apiToken = '';
let passed = 0;
let failed = 0;

function check(name, ok, extra) {
  if (ok) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.log('  ✗ ' + name + (extra ? ' —— ' + extra : ''));
  }
}

function call(route, body, sessionToken, tokenOverride) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body || {});
    const req = http.request(
      {
        method: 'POST',
        hostname: '127.0.0.1',
        port: PORT,
        path: '/api/' + route,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-api-token': tokenOverride !== undefined ? tokenOverride : apiToken,
          'x-session-token': sessionToken || ''
        },
        timeout: 10000
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch (e) {
            resolve({ status: res.statusCode, body: null, raw: data });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const tinyJpeg =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';

(async () => {
  const server = await startServer(store, { port: PORT, host: '127.0.0.1' });
  apiToken = store.loadConfig().token;

  // ping
  const ping = await new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: PORT, path: '/ping' }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
  check('ping 探活', ping.ok === true);

  // 连接码校验
  const bad = await call('auth/login', { username: 'admin', password: 'admin123' }, '', 'wrong-token');
  check('错误连接码被拒绝（401）', bad.status === 401);

  // 登录
  const login = await call('auth/login', { username: 'admin', password: 'admin123' });
  check('管理员远程登录', login.body.ok === true && !!login.body.data.sessionToken, JSON.stringify(login.body));
  const session = login.body.ok ? login.body.data.sessionToken : '';

  const badLogin = await call('auth/login', { username: 'admin', password: 'nope' }, '');
  check('远程登录密码错误被拒绝', badLogin.body.ok === false);

  // 创建用户 + 存档（走网络）
  const mk = await call('users/create', { username: 'clerk01', name: '店员', password: 'clerk123', permissions: { capture: true, query: true } }, session);
  check('远程创建账号', mk.body.ok === true);

  const clerkLogin = await call('auth/login', { username: 'clerk01', password: 'clerk123' }, '');
  const clerkSession = clerkLogin.body.ok ? clerkLogin.body.data.sessionToken : '';
  check('客户端账号远程登录', !!clerkSession);

  const add = await call('records/add', { imageData: tinyJpeg, barcode: 'NET001' }, clerkSession);
  check('远程拍照存档', add.body.ok === true && add.body.data.seq === 1);

  const list = await call('records/list', { barcode: 'NET001', silent: true }, clerkSession);
  check('远程条码查询', list.body.ok === true && list.body.data.total === 1);

  // 照片文件接口
  const file = add.body.ok ? add.body.data.photoFile : '';
  const photo = await new Promise((resolve, reject) => {
    http.get(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: '/photo?f=' + encodeURIComponent(file) + '&token=' + encodeURIComponent(apiToken),
        timeout: 10000
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, size: Buffer.concat(chunks).length, type: res.headers['content-type'] }));
      }
    ).on('error', reject);
  });
  check('照片文件接口返回图片', photo.status === 200 && photo.type === 'image/jpeg' && photo.size > 0);

  const photoNoToken = await new Promise((resolve) => {
    http.get({ hostname: '127.0.0.1', port: PORT, path: '/photo?f=' + encodeURIComponent(file) }, (res) => {
      resolve(res.statusCode);
      res.resume();
    });
  });
  check('照片接口无连接码被拒绝', photoNoToken === 401);

  // 越权
  const denied = await call('users/list', undefined, clerkSession);
  check('客户端远程越权被拒绝', denied.body.ok === false && /系统管理员/.test(denied.body.message || ''), denied.body.message);

  // 日志与总览
  const logs = await call('logs/list', { silent: true }, session);
  check('远程查询日志', logs.body.ok === true && logs.body.data.total > 0);
  const ov = await call('stats/overview', undefined, session);
  check('远程数据总览', ov.body.ok === true && ov.body.data.userCount === 2);

  // ---------- 强制推送安装包 ----------
  function getFile(urlPath, headers) {
    return new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: PORT, path: urlPath, headers: headers || {}, timeout: 10000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            size: Buffer.concat(chunks).length,
            type: res.headers['content-type'],
            disposition: res.headers['content-disposition'] || '',
            body: Buffer.concat(chunks).toString('utf8')
          })
        );
      }).on('error', reject);
    });
  }

  const updateDir = store.getUpdateDir();
  const INSTALLER = 'xingqiyi-laundry-photo-setup-9.9.9.exe';
  fs.mkdirSync(updateDir, { recursive: true });
  const installerBody = 'FAKE-INSTALLER-' + 'x'.repeat(2048);
  fs.writeFileSync(path.join(updateDir, INSTALLER), installerBody, 'utf8');
  // 非安装包文件不应出现在可选列表中
  fs.writeFileSync(path.join(updateDir, 'readme.txt'), 'ignore me', 'utf8');

  const fuEmpty = await call('system/forceUpdate', {}, session);
  check('查询强制推送设置', fuEmpty.body.ok === true && fuEmpty.body.data.enabled === false);
  check('推送设置返回安装包列表且过滤非安装包', Array.isArray(fuEmpty.body.data.files) &&
    fuEmpty.body.data.files.length === 1 && fuEmpty.body.data.files[0].name === INSTALLER,
    JSON.stringify(fuEmpty.body.data.files));

  const fuNoPerm = await call('system/setForceUpdate', { enabled: true, fileName: INSTALLER }, clerkSession);
  check('客户端账号无权设置强制推送', fuNoPerm.body.ok === false && /系统管理员/.test(fuNoPerm.body.message || ''),
    fuNoPerm.body.message);

  const fuBadFile = await call('system/setForceUpdate', { enabled: true, fileName: 'not-exist-9.9.9.exe' }, session);
  check('推送不存在的安装包被拒绝', fuBadFile.body.ok === false && /不存在/.test(fuBadFile.body.message || ''),
    fuBadFile.body.message);

  const fuTraversal = await call('system/setForceUpdate', { enabled: true, fileName: '../../../config.json' }, session);
  check('推送含路径穿越的文件名被拒绝', fuTraversal.body.ok === false);

  const fuSet = await call('system/setForceUpdate', { enabled: true, fileName: INSTALLER }, session);
  check('开启强制推送', fuSet.body.ok === true && fuSet.body.data.enabled === true && fuSet.body.data.version === '9.9.9',
    JSON.stringify(fuSet.body));
  check('推送版本号从文件名解析且文件存在标记正确', fuSet.body.ok === true &&
    fuSet.body.data.fileExists === true);

  const fuQuery = await call('system/forceUpdate', {}, session);
  check('客户端可查询到已推送版本', fuQuery.body.ok === true && fuQuery.body.data.enabled === true &&
    fuQuery.body.data.version === '9.9.9');

  const dl = await getFile('/update-file?f=' + encodeURIComponent(INSTALLER) + '&token=' + encodeURIComponent(apiToken));
  check('安装包下载接口返回文件', dl.status === 200 && dl.size === Buffer.byteLength(installerBody) &&
    dl.body === installerBody, 'status=' + dl.status + ' size=' + dl.size);
  check('安装包下载带附件头与长度', dl.type === 'application/octet-stream' &&
    /attachment/.test(dl.disposition));

  const dlNoToken = await getFile('/update-file?f=' + encodeURIComponent(INSTALLER));
  check('安装包下载无连接码被拒绝', dlNoToken.status === 401);

  const dlTraversal = await getFile('/update-file?f=' + encodeURIComponent('../../../config.json') + '&token=' + encodeURIComponent(apiToken));
  check('安装包下载路径穿越被拒绝', dlTraversal.status === 404);

  const dlMissing = await getFile('/update-file?f=nope.exe&token=' + encodeURIComponent(apiToken));
  check('下载不存在的安装包返回 404', dlMissing.status === 404);

  const fuOff = await call('system/setForceUpdate', { enabled: false }, session);
  check('取消强制推送', fuOff.body.ok === true && fuOff.body.data.enabled === false);

  const pushLogs = await call('logs/list', { silent: true }, session);
  check('强制推送与取消推送均记入操作日志', pushLogs.body.ok === true &&
    /强制推送安装包/.test(JSON.stringify(pushLogs.body.data)) &&
    /取消强制推送/.test(JSON.stringify(pushLogs.body.data)));

  await server.close();
  console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('验证脚本异常：' + e.message);
  process.exit(1);
});
