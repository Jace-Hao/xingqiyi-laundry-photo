'use strict';

/**
 * 无头验证脚本：直接调用数据层，覆盖登录、会话令牌、条码编号连拍、
 * 权限、用户管理、日志、照片路径迁移等核心流程。
 * 运行：node scripts/verify-store.js
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { createStore } = require('../main/store');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xqy-test-'));
const store = createStore({
  dataDir: path.join(tmpDir, 'data'),
  defaultPhotoDir: path.join(tmpDir, 'photos'),
  updateDir: path.join(tmpDir, 'updates'),
  appVersion: '0.1.0',
  photoScheme: 'xqy-photo'
});

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.log('  ✗ ' + name + ' —— ' + e.message);
  }
}

function expectThrow(fn, keyword) {
  try {
    fn();
  } catch (e) {
    if (!keyword || e.message.includes(keyword)) return;
    throw new Error('抛出了错误的异常：' + e.message);
  }
  throw new Error('本应抛出异常但没有');
}

const tinyJpeg =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';

let adminToken = '';
let clerkToken = '';
let clerk = null;

console.log('== 初始化 ==');
check('首次启动创建默认管理员与配置', () => {
  store.ensureSeedData();
  const info = store.systemInfo();
  if (!info.token || !info.port) throw new Error('配置缺失');
});

console.log('== 认证与会话 ==');
check('错误密码登录失败', () => expectThrow(() => store.login({ username: 'admin', password: 'wrong' }), '密码错误'));
check('无令牌访问被拒绝', () => expectThrow(() => store.listUsers(''), '未登录'));
check('伪造令牌被拒绝', () => expectThrow(() => store.listUsers('fake-token'), '未登录'));
check('管理员登录返回会话令牌', () => {
  const r = store.login({ username: 'admin', password: 'admin123' });
  if (!r.sessionToken || !r.user || r.user.role !== 'admin') throw new Error('返回数据异常');
  if (r.user.passwordHash !== undefined) throw new Error('泄露了密码哈希');
  adminToken = r.sessionToken;
});
check('修改密码后旧密码失效', () => {
  store.changePassword(adminToken, { oldPassword: 'admin123', newPassword: 'admin888' });
  expectThrow(() => store.changePassword(adminToken, { oldPassword: 'admin123', newPassword: 'abcdef' }), '原密码不正确');
});
check('退出登录后令牌立即失效', () => {
  const r = store.login({ username: 'admin', password: 'admin888' });
  store.logout(r.sessionToken);
  expectThrow(() => store.listUsers(r.sessionToken), '未登录');
  adminToken = store.login({ username: 'admin', password: 'admin888' }).sessionToken;
});

console.log('== 用户管理与权限 ==');
check('创建客户端账号', () => {
  clerk = store.createUser(adminToken, { username: 'clerk01', name: '店员小王', password: 'clerk123', permissions: { capture: true, query: true } });
  if (clerk.role !== 'client') throw new Error('角色错误');
});
check('重复用户名被拒绝', () => expectThrow(() => store.createUser(adminToken, { username: 'CLERK01', password: '123456' }), '已存在'));
check('客户端账号登录获得独立令牌', () => {
  clerkToken = store.login({ username: 'clerk01', password: 'clerk123' }).sessionToken;
});
check('多令牌并发：两个会话同时有效', () => {
  if (!store.current(adminToken) || !store.current(clerkToken)) throw new Error('会话未共存');
});
check('客户端账号无权查看用户列表', () => expectThrow(() => store.listUsers(clerkToken), '仅管理员'));
check('停用账号后其会话立即失效', () => {
  const limited = store.createUser(adminToken, { username: 'temp01', name: '临时', password: 'temp123' });
  const tk = store.login({ username: 'temp01', password: 'temp123' }).sessionToken;
  store.updateUser(adminToken, { id: limited.id, active: false });
  expectThrow(() => store.listRecords(tk, { silent: true }), '未登录');
  expectThrow(() => store.login({ username: 'temp01', password: 'temp123' }), '停用');
});
check('关闭拍照权限后该账号无法存档', () => {
  store.updateUser(adminToken, { id: clerk.id, permissions: { capture: false, query: true } });
  expectThrow(() => store.addRecord(clerkToken, { imageData: tinyJpeg, barcode: 'B000' }), '无权限');
  store.updateUser(adminToken, { id: clerk.id, permissions: { capture: true, query: true } });
});
check('管理员不能删除自己的账号', () => {
  const me = store.current(adminToken);
  expectThrow(() => store.deleteUser(adminToken, me.id), '不能删除自己');
});

console.log('== 衣物照片存档（条形码索引） ==');
let rec1;
check('缺少条形码无法存档', () =>
  expectThrow(() => store.addRecord(clerkToken, { imageData: tinyJpeg, barcode: '  ' }), '条形码'));
check('同一码第一张存档成功且编号为 1', () => {
  rec1 = store.addRecord(clerkToken, { imageData: tinyJpeg, barcode: 'XQ20260901001', note: '袖口有污渍' });
  if (rec1.seq !== 1) throw new Error('编号应为 1，实际 ' + rec1.seq);
  if (!fs.existsSync(path.join(tmpDir, 'photos', rec1.photoFile))) throw new Error('照片文件未写入');
});
check('照片按条码建文件夹、文件名为拍摄时间精确到分钟', () => {
  const r = store.addRecord(clerkToken, { imageData: tinyJpeg, barcode: 'FOLDERTEST01' });
  try {
    if (!r.photoFile.startsWith('FOLDERTEST01/')) throw new Error('应保存在条码子文件夹：' + r.photoFile);
    const base = r.photoFile.split('/')[1];
    if (!/^\d{12}(-\d+)?\.jpg$/.test(base)) throw new Error('文件名应为12位年月日时分（同分钟加序号）：' + r.photoFile);
    if (!fs.existsSync(path.join(tmpDir, 'photos', r.photoFile))) throw new Error('照片文件未写入');
    const r2 = store.addRecord(clerkToken, { imageData: tinyJpeg, barcode: 'FOLDERTEST01' });
    if (r2.photoFile === r.photoFile) throw new Error('同分钟文件名应加序号区分');
    store.deleteRecord(clerkToken, r2.id);
    store.deleteRecord(clerkToken, r.id);
  } catch (e) {
    try { store.deleteRecord(clerkToken, r.id); } catch (e2) { /* 忽略清理失败 */ }
    throw e;
  }
});
check('同一码连拍第二张编号为 2', () => {
  const r2 = store.addRecord(clerkToken, { imageData: tinyJpeg, barcode: 'XQ20260901001', note: '背面' });
  if (r2.seq !== 2) throw new Error('编号应为 2，实际 ' + r2.seq);
});
check('不同条码独立编号', () => {
  const r3 = store.addRecord(clerkToken, { imageData: tinyJpeg, barcode: 'XQ20260901002' });
  if (r3.seq !== 1) throw new Error('编号应为 1，实际 ' + r3.seq);
});
check('存档记录不含类别字段', () => {
  if (rec1.category !== undefined) throw new Error('类别字段应已移除');
});
check('按条码精确查询命中 2 张', () => {
  const r = store.listRecords(clerkToken, { barcode: 'XQ20260901001', silent: true });
  if (r.total !== 2) throw new Error('应命中 2 条，实际 ' + r.total);
  if (!r.items.every((x) => x.barcode === 'XQ20260901001')) throw new Error('结果不精确');
});
check('关键词模糊查询命中条码', () => {
  const r = store.listRecords(clerkToken, { keyword: '20260901', silent: true });
  if (r.total !== 3) throw new Error('应命中 3 条，实际 ' + r.total);
});
check('客户端只能看到自己的记录', () => {
  store.addRecord(adminToken, { imageData: tinyJpeg, barcode: 'ADMIN001' });
  const r = store.listRecords(clerkToken, { silent: true });
  if (r.total !== 3) throw new Error('客户端应只有 3 条，实际 ' + r.total);
});
check('管理员可查看全部记录', () => {
  const r = store.listRecords(adminToken, { silent: true });
  if (r.total !== 4) throw new Error('管理员应有 4 条，实际 ' + r.total);
});
check('客户端无法查看他人记录', () => {
  const all = store.listRecords(adminToken, { silent: true });
  const others = all.items.filter((x) => x.username !== 'clerk01')[0];
  expectThrow(() => store.getRecord(clerkToken, others.id), '无权限');
});
check('删除存档同时删除照片文件', () => {
  store.deleteRecord(clerkToken, rec1.id);
  if (fs.existsSync(path.join(tmpDir, 'photos', rec1.photoFile))) throw new Error('照片文件未删除');
});

console.log('== 操作日志 ==');
check('日志记录了登录与操作', () => {
  const r = store.listLogs(adminToken, { silent: true });
  if (r.total < 10) throw new Error('日志条数异常：' + r.total);
  if (!r.items.some((l) => l.action === '登录失败')) throw new Error('缺少登录失败日志');
});
check('日志按账号筛选', () => {
  const r = store.listLogs(adminToken, { userId: clerk.id, silent: true });
  if (!r.items.every((l) => l.userId === clerk.id)) throw new Error('筛选结果错误');
});
check('日志按操作类型筛选', () => {
  const r = store.listLogs(adminToken, { action: '新增存档', silent: true });
  if (!r.items.every((l) => l.action === '新增存档')) throw new Error('筛选结果错误');
});

console.log('== 数据总览 ==');
check('总览数据正确', () => {
  const o = store.overview(adminToken);
  if (o.userCount !== 3 || o.recordCount !== 3 || o.adminCount !== 1) {
    throw new Error(JSON.stringify({ userCount: o.userCount, recordCount: o.recordCount, adminCount: o.adminCount }));
  }
});

console.log('== 系统配置 ==');
check('修改端口需管理员权限', () => {
  expectThrow(() => store.updateSystemSettings(clerkToken, { port: 8080 }), '仅管理员');
});
check('非法端口被拒绝', () => {
  expectThrow(() => store.updateSystemSettings(adminToken, { port: 0 }), '端口');
  expectThrow(() => store.updateSystemSettings(adminToken, { port: 70000 }), '端口');
});
check('修改端口成功', () => {
  store.updateSystemSettings(adminToken, { port: 18080 });
  if (store.loadConfig().port !== 18080) throw new Error('端口未保存');
});
check('重置连接码后旧码变化', () => {
  const old = store.loadConfig().token;
  const next = store.resetApiToken(adminToken);
  if (!next || next === old) throw new Error('连接码未更新');
});
check('客户端配置保存与地址规范化', () => {
  const r = store.setClientConfig('192.168.1.10:17521', 'abc123');
  if (r.serverUrl !== 'http://192.168.1.10:17521' || r.mode !== 'client') throw new Error('配置异常：' + JSON.stringify(r));
  store.setMode('server'); // 恢复
});
function collectJpgs(dir, rel) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const en of entries) {
    if (en.isDirectory()) out.push(...collectJpgs(path.join(dir, en.name), rel ? rel + '/' + en.name : en.name));
    else if (en.isFile() && en.name.endsWith('.jpg')) out.push(rel ? rel + '/' + en.name : en.name);
  }
  return out;
}

check('照片路径迁移', () => {
  const before = collectJpgs(path.join(tmpDir, 'photos'), '').length;
  const newDir = path.join(tmpDir, 'photos2');
  const r = store.setPhotoPath(adminToken, newDir);
  if (r.moved !== before) throw new Error('迁移数量不符：期望 ' + before + '，实际 ' + r.moved);
  const after = collectJpgs(newDir, '').length;
  if (after !== before) throw new Error('新目录文件数不符');
  if (store.getPhotoDir() !== path.resolve(newDir)) throw new Error('配置未更新');
});
check('照片路径冲突时拒绝迁移', () => {
  const conflictDir = path.join(tmpDir, 'conflict');
  fs.mkdirSync(conflictDir, { recursive: true });
  const existing = collectJpgs(store.getPhotoDir(), '')[0];
  if (!existing) throw new Error('无可用照片文件做冲突测试');
  fs.mkdirSync(path.dirname(path.join(conflictDir, existing)), { recursive: true });
  fs.writeFileSync(path.join(conflictDir, existing), 'x');
  expectThrow(() => store.setPhotoPath(adminToken, conflictDir), '同名');
});
check('迁移后新照片写入新路径', () => {
  const r = store.addRecord(adminToken, { imageData: tinyJpeg, barcode: 'NEWPATH01' });
  if (!fs.existsSync(path.join(store.getPhotoDir(), r.photoFile))) throw new Error('新照片未写入新路径');
});

console.log('== 批量删除 ==');
check('批量删除空列表被拒绝', () => {
  expectThrow(() => store.deleteRecords(adminToken, []), '未选择');
});
check('批量删除只删除权限内的记录', () => {
  const b1 = store.addRecord(clerkToken, { imageData: tinyJpeg, barcode: 'BATCH01' });
  const b2 = store.addRecord(clerkToken, { imageData: tinyJpeg, barcode: 'BATCH02' });
  const r = store.deleteRecords(clerkToken, [b1.id, b2.id]);
  if (r.deleted !== 2) throw new Error('应删除 2 条，实际 ' + r.deleted);
  const list = store.listRecords(clerkToken, { keyword: 'BATCH0', silent: true });
  if (list.total !== 0) throw new Error('删除后仍有残留：' + list.total);
});
check('客户端批量删除不能删除他人记录', () => {
  const others = store.listRecords(adminToken, { silent: true });
  const adminRec = others.items.filter((x) => x.username !== 'clerk01')[0];
  if (!adminRec) throw new Error('缺少他人记录');
  expectThrow(() => store.deleteRecords(clerkToken, [adminRec.id]), '没有可删除');
});
check('批量删除不存在的记录返回失败', () => {
  expectThrow(() => store.deleteRecords(adminToken, ['no-such-id']), '没有可删除');
});

console.log('== 版本与更新 ==');
check('版本号比较正确', () => {
  if (store.compareVersions('2.0.0', '1.9.9') !== 1) throw new Error('2.0.0 应大于 1.9.9');
  if (store.compareVersions('1.0.0', '1.0.0') !== 0) throw new Error('相等版本应返回 0');
  if (store.compareVersions('v2.0.1', '2.0.0') !== 1) throw new Error('v2.0.1 应大于 2.0.0');
});
check('更新文件夹为空时无更新', () => {
  const u = store.checkUpdates();
  if (u.latestVersion !== null || u.hasUpdate) throw new Error('空文件夹不应有更新');
  if (u.currentVersion !== '0.1.0') throw new Error('当前版本应为 0.1.0');
});
check('放入新版本安装包后检测到更新', () => {
  fs.mkdirSync(path.join(tmpDir, 'updates'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'updates', 'xingqiyi-0.2.0.zip'), 'x');
  fs.writeFileSync(path.join(tmpDir, 'updates', 'xingqiyi-0.0.5.zip'), 'x');
  const u = store.checkUpdates();
  if (u.latestVersion !== '0.2.0') throw new Error('应识别最高版本 0.2.0，实际 ' + u.latestVersion);
  if (u.latestFile !== 'xingqiyi-0.2.0.zip') throw new Error('文件名应取最新版本');
  if (!u.hasUpdate) throw new Error('0.2.0 > 0.1.0 应提示更新');
});
check('版本号不大于当前时不提示更新', () => {
  fs.writeFileSync(path.join(tmpDir, 'updates', 'xingqiyi-0.1.0.zip'), 'x');
  fs.rmSync(path.join(tmpDir, 'updates', 'xingqiyi-0.2.0.zip'));
  fs.rmSync(path.join(tmpDir, 'updates', 'xingqiyi-0.0.5.zip'));
  const u = store.checkUpdates();
  if (u.hasUpdate) throw new Error('相同版本不应提示更新');
});
check('非安装包文件被忽略', () => {
  fs.writeFileSync(path.join(tmpDir, 'updates', 'readme.txt'), 'x');
  const u = store.checkUpdates();
  if (u.latestFile === 'readme.txt') throw new Error('无版本号文件应被忽略');
});

console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);

