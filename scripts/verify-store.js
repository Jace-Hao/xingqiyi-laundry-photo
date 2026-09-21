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
check('系统管理员登录返回会话令牌', () => {
  const r = store.login({ username: 'admin', password: 'admin123' });
  if (!r.sessionToken || !r.user) throw new Error('返回数据异常');
  if (r.user.role !== 'sysadmin') throw new Error('角色应为 sysadmin，实际 ' + r.user.role);
  if (r.user.roleLabel !== '系统管理员') throw new Error('角色标签错误：' + r.user.roleLabel);
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
check('创建客户端账号（旧值 client 自动映射为拍照账号）', () => {
  clerk = store.createUser(adminToken, { username: 'clerk01', name: '店员小王', password: 'clerk123', permissions: { capture: true, query: true } });
  if (clerk.role !== 'capture') throw new Error('角色应为 capture，实际 ' + clerk.role);
  if (clerk.roleLabel !== '拍照账号') throw new Error('角色标签错误：' + clerk.roleLabel);
});
check('重复用户名被拒绝', () => expectThrow(() => store.createUser(adminToken, { username: 'CLERK01', password: '123456' }), '已存在'));
check('客户端账号登录获得独立令牌', () => {
  clerkToken = store.login({ username: 'clerk01', password: 'clerk123' }).sessionToken;
});
// 注意：这里验证的是「不同账号」可并发在线（admin 与 clerk 各自持有令牌），
// 与「同一账号不可多地登录」不冲突，见下方唯一登录专项用例
check('不同账号可同时在线（多账号并发）', () => {
  if (!store.current(adminToken) || !store.current(clerkToken)) throw new Error('会话未共存');
});
check('同一账号不可多地登录（唯一登录）', () => {
  const t1 = store.login({ username: 'clerk01', password: 'clerk123' }).sessionToken;
  // 第一次登录的令牌此时有效
  if (!store.current(t1)) throw new Error('首次登录令牌应有效');
  // 异地再次登录：新令牌生效，旧令牌立即失效
  const t2 = store.login({ username: 'clerk01', password: 'clerk123' }).sessionToken;
  if (!store.current(t2)) throw new Error('新登录令牌应有效');
  if (store.current(t1)) throw new Error('旧令牌应已失效，但仍可用');
  // 被顶下线的旧令牌再操作时，要能拿到「已在其他设备登录」这一明确原因，
  // 而不是笼统的「未登录」——否则店员会误以为是密码过期而反复重试
  let msg = '';
  try {
    store.listRecords(t1, { silent: true });
    throw new Error('旧令牌不应能查询');
  } catch (e) {
    msg = e.message || '';
  }
  if (!/其他设备登录/.test(msg)) throw new Error('被顶下线的提示不明确：' + msg);
  // 恢复为后续用例可用的令牌
  clerkToken = store.login({ username: 'clerk01', password: 'clerk123' }).sessionToken;
});
check('被顶下线的会话不影响其他账号', () => {
  if (!store.current(adminToken)) throw new Error('系统管理员会话不应被其他人的登录顶掉');
});
check('重新登录后新令牌可用、旧令牌全部失效', () => {
  const a = store.login({ username: 'clerk01', password: 'clerk123' }).sessionToken;
  const b = store.login({ username: 'clerk01', password: 'clerk123' }).sessionToken;
  const c = store.login({ username: 'clerk01', password: 'clerk123' }).sessionToken;
  if (!store.current(c)) throw new Error('最新令牌应有效');
  if (store.current(a) || store.current(b)) throw new Error('更早的令牌都应已失效');
  clerkToken = c;
});
check('已失效会话按保留期与数量上限清理（防止 sessions.json 无限膨胀）', () => {
  // 清理逻辑失效不会让功能出错，只会让会话文件无限增长，
  // 因此必须单独验证：超过保留期的失效会话要被删掉，数量要压到上限以内，
  // 且绝不能误删任何有效会话。
  const sessionsPath = path.join(tmpDir, 'data', 'sessions.json');
  const backup = fs.readFileSync(sessionsPath, 'utf8');
  try {
    const real = JSON.parse(backup);
    const fake = [];
    // 250 条「刚失效」：超过 200 条上限，应被裁剪
    for (let i = 0; i < 250; i++) {
      fake.push({
        token: 'fake-revoked-' + i,
        userId: clerk.id,
        createdAt: new Date().toISOString(),
        revoked: true,
        revokedAt: new Date().toISOString(),
        revokedReason: '测试用失效会话'
      });
    }
    // 1 条「10 天前失效」：超过 7 天保留期，应被清理
    fake.push({
      token: 'fake-expired',
      userId: clerk.id,
      createdAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
      revoked: true,
      revokedAt: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(),
      revokedReason: '测试用过期会话'
    });
    fs.writeFileSync(sessionsPath, JSON.stringify([...real, ...fake], null, 2), 'utf8');

    // 登录会 createSession → pruneRevokedSessions，借此触发清理
    const t = store.login({ username: 'clerk01', password: 'clerk123' }).sessionToken;
    clerkToken = t;

    const after = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    const revokedAfter = after.filter((s) => s.revoked);
    if (revokedAfter.length > 200) throw new Error('失效会话未裁剪到上限内：' + revokedAfter.length + ' 条');
    if (after.some((s) => s.token === 'fake-expired')) throw new Error('超过保留期的失效会话未被清理');
    if (!after.some((s) => s.token === t)) throw new Error('新建的有效会话被误删');
    if (!after.some((s) => s.token === adminToken)) throw new Error('其他账号的有效会话被误删');
  } finally {
    // 还原会话文件，避免污染后续用例（其中包含它们依赖的有效令牌）
    fs.writeFileSync(sessionsPath, backup, 'utf8');
  }
  // 还原后旧 clerkToken 已作废，重新登录拿到有效令牌供后续用例使用
  clerkToken = store.login({ username: 'clerk01', password: 'clerk123' }).sessionToken;
});
check('镜像离线会话同样受唯一登录约束（不能绕过顶下线）', () => {
  // 客户端远程登录成功后会用同一令牌在本机建立镜像会话，供服务器失联时降级使用。
  // 账号被顶下线后，旧的镜像会话必须一并失效，
  // 否则用户可以靠旧令牌继续离线操作，绕过唯一登录。
  const u = store.createUser(adminToken, {
    username: 'mirror01', name: '镜像测试', password: 'pass123456', role: 'capture', store: '人民路店'
  });
  const mirrorUser = { id: u.id, username: 'mirror01' };

  try {
    store.mirrorLogin(mirrorUser, 'mirror-token-A');
    if (!store.current('mirror-token-A')) throw new Error('首个镜像会话应有效');

    store.mirrorLogin(mirrorUser, 'mirror-token-B');
    if (!store.current('mirror-token-B')) throw new Error('新的镜像会话应有效');
    if (store.current('mirror-token-A')) throw new Error('旧的镜像会话应已失效，否则可绕过唯一登录');

    let msg = '';
    try {
      store.listRecords('mirror-token-A', { silent: true });
      throw new Error('失效的镜像会话不应能查询');
    } catch (e) {
      msg = e.message || '';
    }
    if (!/其他设备登录/.test(msg)) throw new Error('镜像会话失效提示不明确：' + msg);
  } finally {
    // 清理本用例创建的账号：后续「数据总览」用例对账号总数有精确断言，
    // 测试之间不能有副作用，否则会连带把不相关的用例搞失败
    store.deleteUser(adminToken, u.id);
  }
});
check('非系统管理员无权查看用户列表', () => expectThrow(() => store.listUsers(clerkToken), '仅系统管理员'));
check('停用账号后其会话立即失效', () => {
  const limited = store.createUser(adminToken, { username: 'temp01', name: '临时', password: 'temp123' });
  const tk = store.login({ username: 'temp01', password: 'temp123' }).sessionToken;
  store.updateUser(adminToken, { id: limited.id, active: false });
  expectThrow(() => store.listRecords(tk, { silent: true }), '未登录');
  expectThrow(() => store.login({ username: 'temp01', password: 'temp123' }), '停用');
});
check('改为查询账号后不能拍照，改回拍照账号后恢复', () => {
  // 新模型下权限由角色派生，不再单独配置 permissions
  store.updateUser(adminToken, { id: clerk.id, role: 'query' });
  const asQuery = store.current(clerkToken);
  if (asQuery.role !== 'query' || asQuery.permissions.capture) throw new Error('查询账号仍带拍照权限：' + JSON.stringify(asQuery));
  expectThrow(() => store.addRecord(clerkToken, { imageData: tinyJpeg, barcode: 'B000' }), '无权限');
  store.updateUser(adminToken, { id: clerk.id, role: 'capture' });
  const asCapture = store.current(clerkToken);
  if (asCapture.role !== 'capture' || !asCapture.permissions.capture) throw new Error('拍照账号缺少拍照权限：' + JSON.stringify(asCapture));
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
  // 用真实存在的类型筛选（此前误用「新增存档」这一后端从不写入的值，
  // 空结果集使 every 恒为真，断言形同虚设）
  const r = store.listLogs(adminToken, { action: '新增条码', silent: true });
  if (!r.items.length) throw new Error('筛选「新增条码」应有结果，实际 0 条');
  if (!r.items.every((l) => l.action === '新增条码')) throw new Error('筛选结果错误');
});
check('操作类型筛选清单覆盖日志中实际出现的全部类型', () => {
  const options = store.logActionOptions(adminToken);
  const r = store.listLogs(adminToken, { silent: true, pageSize: 200 });
  const used = [...new Set(r.items.map((l) => l.action))];
  const missing = used.filter((a) => !options.includes(a));
  if (missing.length) throw new Error('以下类型无法在下拉中选择：' + missing.join('、'));
  if (!options.includes('新增条码')) throw new Error('清单缺少「新增条码」（历史 BUG 复现）');
  if (options.includes('新增存档')) throw new Error('清单含后端从不写入的「新增存档」');
  // 每个清单选项都能作为筛选值使用且不报错
  for (const a of options) {
    const rr = store.listLogs(adminToken, { action: a, silent: true, pageSize: 5 });
    if (!rr.items.every((l) => l.action === a)) throw new Error('按「' + a + '」筛选结果不纯');
  }
});

check('源码中所有日志动作均已登记（防止将来漂移）', () => {
  // 动态测试只能覆盖被触发到的分支，离线存档/强制推送等类型需静态扫描兜底
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'store.js'), 'utf8');
  const found = new Set();
  const re = /action:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) found.add(m[1]);
  const options = store.logActionOptions(adminToken);
  const unregistered = [...found].filter((a) => !options.includes(a));
  if (unregistered.length) throw new Error('源码写入但未登记：' + unregistered.join('、'));
  if (found.size < 15) throw new Error('扫描到的动作类型异常偏少：' + found.size + '，正则可能失效');
});

check('主进程调用 logSystemChange 的动作类型均已登记（跨文件扫描）', () => {
  // store.js 的扫描管不到 main.js：主进程执行系统级操作（如开机自启）后
  // 通过 logSystemChange 补记审计，若传入未登记的动作名会被拒绝，导致设置成功却无日志。
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf8');
  const options = store.logActionOptions(adminToken);

  /** 从 idx 处的左括号开始，按括号配对返回参数数组（仅按顶层逗号切分） */
  function splitArgs(text, openIdx) {
    let depth = 0;
    let buf = '';
    const args = [];
    for (let i = openIdx; i < text.length; i++) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          if (buf.trim()) args.push(buf);
          return args;
        }
      }
      // 只按顶层逗号切分，嵌套调用内的逗号不算
      if (ch === ',' && depth === 1) {
        args.push(buf);
        buf = '';
        continue;
      }
      if (depth >= 1) buf += ch;
    }
    return args;
  }

  // 只取第二个实参（动作名）中的字符串字面量，忽略第三个实参（detail 文案），
  // 否则会误把 detail 里三元表达式的文案当成动作类型
  const found = new Set();
  const callRe = /logSystemChange\s*\(/g;
  let cm;
  let callCount = 0;
  while ((cm = callRe.exec(src)) !== null) {
    const args = splitArgs(src, cm.index + 'logSystemChange'.length);
    if (args.length < 3) throw new Error('logSystemChange 调用参数不足 3 个，签名可能已变更');
    callCount++;
    const strRe = /'([^']+)'/g;
    let sm;
    while ((sm = strRe.exec(args[1])) !== null) found.add(sm[1]);
  }
  if (!callCount) throw new Error('未在 main.js 中找到 logSystemChange 调用，扫描可能失效');
  if (!found.size) throw new Error('未从调用中提取到任何动作名，解析可能失效');

  const unregistered = [...found].filter((a) => !options.includes(a));
  if (unregistered.length) throw new Error('主进程使用了未登记的动作类型：' + unregistered.join('、'));
});

check('logSystemChange 记录系统变更并拒绝未登记动作', () => {
  // 需要系统设置权限
  expectThrow(() => store.logSystemChange(clerkToken, '开启开机自启', '测试'), '系统管理员');
  // 未登记的动作必须被拒，避免产生筛选不到的孤儿日志
  expectThrow(() => store.logSystemChange(adminToken, '随手写的动作', '测试'), '未登记的操作类型');
  expectThrow(() => store.logSystemChange(adminToken, '', '测试'), '未登记的操作类型');

  const before = store.listLogs(adminToken, { silent: true, pageSize: 500 }).total;
  store.logSystemChange(adminToken, '开启开机自启', '开机自动启动：已开启（登录后静默驻留托盘）');
  store.logSystemChange(adminToken, '取消开机自启', '开机自动启动：已取消');
  const r = store.listLogs(adminToken, { silent: true, pageSize: 500 });
  if (r.total !== before + 2) throw new Error('日志条数应增加 2，实际增加 ' + (r.total - before));

  const on = store.listLogs(adminToken, { silent: true, action: '开启开机自启', pageSize: 10 });
  if (on.total !== 1) throw new Error('「开启开机自启」应可按类型筛出 1 条，实际 ' + on.total);
  if (on.items[0].module !== '系统设置') throw new Error('模块应为「系统设置」，实际 ' + on.items[0].module);
  if (on.items[0].userId !== store.current(adminToken).id) throw new Error('日志未记录操作人');
  if (on.items[0].result !== '成功') throw new Error('结果应为成功');

  // 两个动作都必须出现在筛选清单里，否则管理员无法按类型查这类审计
  const options = store.logActionOptions(adminToken);
  if (!options.includes('开启开机自启') || !options.includes('取消开机自启')) {
    throw new Error('筛选清单缺少开机自启动作类型');
  }
});

console.log('== 数据总览 ==');
check('总览数据正确', () => {
  const o = store.overview(adminToken);
  if (o.userCount !== 3 || o.recordCount !== 3 || o.adminCount !== 1) {
    throw new Error(JSON.stringify({ userCount: o.userCount, recordCount: o.recordCount, adminCount: o.adminCount }));
  }
});

console.log('== 系统配置 ==');
check('修改端口需系统管理员权限', () => {
  expectThrow(() => store.updateSystemSettings(clerkToken, { port: 8080 }), '系统管理员');
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
check('远程客户端状态下禁止修改照片路径', () => {
  store.setClientConfig('192.168.1.10:17521', 'abc123');
  if (store.systemInfo().remoteClient !== true) throw new Error('systemInfo 未标记 remoteClient');
  const blocked = path.join(tmpDir, 'remote-block');
  expectThrow(() => store.setPhotoPath(adminToken, blocked), '远程连接服务器');
  if (fs.existsSync(blocked)) throw new Error('被拒绝时不应创建目标目录');
  store.setMode('server'); // 恢复
  if (store.systemInfo().remoteClient !== false) throw new Error('恢复服务端后仍标记为远程');
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

console.log('== 门店分组与同店互见 ==');
let sa1, sa2, sb1, sn1, sn2;
let sa1Token, sa2Token, sb1Token, sn1Token, sn2Token;

check('创建同门店/跨门店/未分配门店账号', () => {
  sa1 = store.createUser(adminToken, { username: 'store_a1', name: '人民路店甲', password: 'pass123456', store: '人民路店', permissions: { capture: true, query: true } });
  sa2 = store.createUser(adminToken, { username: 'store_a2', name: '人民路店乙', password: 'pass123456', store: '人民路店', permissions: { capture: true, query: true } });
  sb1 = store.createUser(adminToken, { username: 'store_b1', name: '解放路店甲', password: 'pass123456', store: '解放路店', permissions: { capture: true, query: true } });
  sn1 = store.createUser(adminToken, { username: 'store_n1', name: '未分配甲', password: 'pass123456', store: '', permissions: { capture: true, query: true } });
  sn2 = store.createUser(adminToken, { username: 'store_n2', name: '未分配乙', password: 'pass123456', permissions: { capture: true, query: true } });
  if (sa1.store !== '人民路店') throw new Error('门店未写入：' + JSON.stringify(sa1.store));
  if (sn2.store !== '') throw new Error('未传门店应为空字符串：' + JSON.stringify(sn2.store));
  sa1Token = store.login({ username: 'store_a1', password: 'pass123456' }).sessionToken;
  sa2Token = store.login({ username: 'store_a2', password: 'pass123456' }).sessionToken;
  sb1Token = store.login({ username: 'store_b1', password: 'pass123456' }).sessionToken;
  sn1Token = store.login({ username: 'store_n1', password: 'pass123456' }).sessionToken;
  sn2Token = store.login({ username: 'store_n2', password: 'pass123456' }).sessionToken;
});

let recSa1, recSa2, recSb1, recSn1, recSn2;
check('录入订单时写入门店快照', () => {
  recSa1 = store.addRecord(sa1Token, { imageData: tinyJpeg, barcode: 'STORE-A1-001', note: '人民路店甲的衣服' });
  recSa2 = store.addRecord(sa2Token, { imageData: tinyJpeg, barcode: 'STORE-A2-001', note: '人民路店乙的衣服' });
  recSb1 = store.addRecord(sb1Token, { imageData: tinyJpeg, barcode: 'STORE-B1-001', note: '解放路店的衣服' });
  recSn1 = store.addRecord(sn1Token, { imageData: tinyJpeg, barcode: 'STORE-N1-001' });
  recSn2 = store.addRecord(sn2Token, { imageData: tinyJpeg, barcode: 'STORE-N2-001' });
  if (recSa1.storeName !== '人民路店' || recSb1.storeName !== '解放路店') throw new Error('门店快照错误');
  if (recSn1.storeName !== '' || recSn2.storeName !== '') throw new Error('未分配门店的记录 storeName 应为空');
});

check('同门店账号可互相查看订单照片', () => {
  const list = store.listRecords(sa1Token, { silent: true, pageSize: 100 });
  const codes = list.items.map((x) => x.barcode).sort();
  if (codes.length !== 2) throw new Error('应为本人+同店共 2 条，实际 ' + codes.length + '：' + codes.join(','));
  if (!codes.includes('STORE-A1-001') || !codes.includes('STORE-A2-001')) throw new Error('同店记录缺失：' + codes.join(','));
  const list2 = store.listRecords(sa2Token, { silent: true, pageSize: 100 });
  if (!list2.items.some((x) => x.barcode === 'STORE-A1-001')) throw new Error('A2 看不到同店 A1 的记录');
  const d = store.getRecord(sa1Token, recSa2.id);
  if (d.barcode !== 'STORE-A2-001') throw new Error('同店详情读取异常');
});

check('跨门店记录相互隔离', () => {
  const list = store.listRecords(sa1Token, { silent: true, pageSize: 100 });
  if (list.items.some((x) => x.barcode === 'STORE-B1-001')) throw new Error('看到了他店记录');
  const listB = store.listRecords(sb1Token, { silent: true, pageSize: 100 });
  const codes = listB.items.map((x) => x.barcode);
  if (codes.length !== 1 || codes[0] !== 'STORE-B1-001') throw new Error('B 店可见范围错误：' + codes.join(','));
  expectThrow(() => store.getRecord(sa1Token, recSb1.id), '无权限');
  expectThrow(() => store.getRecord(sb1Token, recSa1.id), '无权限');
});

check('未分配门店的账号之间不互见', () => {
  const list = store.listRecords(sn1Token, { silent: true, pageSize: 100 });
  const codes = list.items.map((x) => x.barcode);
  if (codes.length !== 1 || codes[0] !== 'STORE-N1-001') throw new Error('空门店不应互见，实际：' + codes.join(','));
  expectThrow(() => store.getRecord(sn1Token, recSn2.id), '无权限');
});

check('管理员可按门店筛选记录', () => {
  const all = store.listRecords(adminToken, { silent: true, pageSize: 200 });
  const expect = all.items.filter((x) => x.storeName === '人民路店').length;
  if (expect !== 2) throw new Error('人民路店应有 2 条，实际 ' + expect);
  const filtered = store.listRecords(adminToken, { silent: true, pageSize: 200, storeFilter: '人民路店' });
  if (filtered.total !== expect) throw new Error('筛选数量不符：期望 ' + expect + ' 实际 ' + filtered.total);
  if (!filtered.items.every((x) => x.storeName === '人民路店')) throw new Error('筛选结果混入他店记录');
  const allFilter = store.listRecords(adminToken, { silent: true, pageSize: 200, storeFilter: 'all' });
  if (allFilter.total !== all.total) throw new Error('storeFilter=all 不应过滤');
});

check('关键词搜索可命中门店名', () => {
  const r = store.listRecords(adminToken, { silent: true, keyword: '解放路店' });
  if (r.total < 1) throw new Error('门店名搜索无结果');
  if (!r.items.every((x) => x.storeName === '解放路店' || String(x.note || '').includes('解放路'))) {
    throw new Error('门店名搜索结果混入无关记录：' + r.total);
  }
});

check('同门店可见但不扩大删除权限', () => {
  expectThrow(() => store.deleteRecord(sa1Token, recSa2.id), '无权限');
  // 批量删除对无权记录全部跳过：无可删项时抛错且不落盘，原记录保持完整
  expectThrow(() => store.deleteRecords(sa1Token, [recSa2.id, recSb1.id]), '没有可删除');
  if (!store.getRecord(sa2Token, recSa2.id)) throw new Error('同店记录被误删');
  if (!store.getRecord(sb1Token, recSb1.id)) throw new Error('他店记录被误删');
  store.deleteRecord(sa1Token, recSa1.id);
});

check('门店变更后历史记录仍归属原门店（快照语义）', () => {
  const before = store.getRecord(sa2Token, recSa2.id);
  store.updateUser(adminToken, { id: sa2.id, store: '解放路店' });
  const after = store.getRecord(adminToken, recSa2.id);
  if (after.storeName !== before.storeName) throw new Error('历史门店被改写：' + before.storeName + ' -> ' + after.storeName);
  if (after.storeName !== '人民路店') throw new Error('历史应仍为人民路店，实际 ' + after.storeName);
  const rec = store.addRecord(sa2Token, { imageData: tinyJpeg, barcode: 'STORE-A2-NEW' });
  if (rec.storeName !== '解放路店') throw new Error('调店后新记录门店错误：' + rec.storeName);
  const listB = store.listRecords(sb1Token, { silent: true, pageSize: 100 });
  if (!listB.items.some((x) => x.barcode === 'STORE-A2-NEW')) throw new Error('调店后未与新同店互见');
});

check('门店分配仅系统管理员可操作', () => {
  expectThrow(() => store.updateUser(sa1Token, { id: sa1.id, store: '解放路店' }), '系统管理员');
  expectThrow(() => store.createUser(sa1Token, { username: 'store_hack', password: 'pass123456', store: '解放路店' }), '系统管理员');
  const before = store.current(sa1Token).store;
  store.changePassword(sa1Token, { oldPassword: 'pass123456', newPassword: 'newpass123' });
  if (store.current(sa1Token).store !== before) throw new Error('改密码意外修改了门店');
});

check('用户列表返回门店且不泄露密码信息', () => {
  const users = store.listUsers(adminToken);
  const m = Object.fromEntries(users.map((u) => [u.username, u]));
  if (!m['store_a1'] || m['store_a1'].store !== '人民路店') throw new Error('门店字段缺失');
  if (m['store_a2'].store !== '解放路店') throw new Error('门店变更未生效');
  if (users.some((u) => u.passwordHash !== undefined || u.salt !== undefined)) throw new Error('泄露了密码哈希或盐值');
});

check('门店名自动去空格并截断到 40 字符', () => {
  store.updateUser(adminToken, { id: sb1.id, store: '   ' + 'X'.repeat(60) + '   ' });
  const u = store.listUsers(adminToken).find((x) => x.username === 'store_b1');
  if (u.store.length !== 40) throw new Error('未截断到 40：' + u.store.length);
  if (u.store !== 'X'.repeat(40)) throw new Error('未去除首尾空格');
});

check('客户端镜像保留门店字段', () => {
  const clientStore = createStore({
    dataDir: path.join(tmpDir, 'mirror-data'),
    defaultPhotoDir: path.join(tmpDir, 'mirror-photos'),
    updateDir: path.join(tmpDir, 'mirror-updates'),
    appVersion: '0.1.0',
    photoScheme: 'xqy-photo'
  });
  clientStore.mirrorUser(
    { id: 'mirror-id', username: 'store_m1', name: '镜像', role: 'client', permissions: { capture: true, query: true }, active: true, store: '人民路店' },
    'pass123456'
  );
  const r = clientStore.login({ username: 'store_m1', password: 'pass123456' });
  if (r.user.store !== '人民路店') throw new Error('镜像丢失门店：' + JSON.stringify(r.user.store));
  if (r.user.role !== 'capture') throw new Error('镜像未映射四级角色：' + r.user.role);
});

console.log('== 四级角色权限体系 ==');
let smgr, scap, sqry, smgr2;
let smgrToken, scapToken, sqryToken, smgr2Token;

check('角色清单为四级且标签正确', () => {
  const opts = store.roleOptions;
  if (opts.length !== 4) throw new Error('应为 4 种角色，实际 ' + opts.length);
  const m = Object.fromEntries(opts.map((o) => [o.value, o.label]));
  if (m.sysadmin !== '系统管理员' || m.storeadmin !== '门店管理员' || m.capture !== '拍照账号' || m.query !== '查询账号') {
    throw new Error('角色标签错误：' + JSON.stringify(m));
  }
});

check('创建四种角色账号，权限由角色派生', () => {
  smgr = store.createUser(adminToken, { username: 'role_smgr', name: '人民路店长', password: 'pass123456', role: 'storeadmin', store: '人民路店' });
  scap = store.createUser(adminToken, { username: 'role_cap', name: '人民路拍照员', password: 'pass123456', role: 'capture', store: '人民路店' });
  sqry = store.createUser(adminToken, { username: 'role_qry', name: '人民路查询员', password: 'pass123456', role: 'query', store: '人民路店' });
  smgr2 = store.createUser(adminToken, { username: 'role_smgr2', name: '解放路店长', password: 'pass123456', role: 'storeadmin', store: '解放路店' });
  if (smgr.permissions.capture) throw new Error('门店管理员不应有拍照权限');
  if (!smgr.permissions.query) throw new Error('门店管理员应有查询权限');
  if (!scap.permissions.capture || !scap.permissions.query) throw new Error('拍照账号应可拍照+查询');
  if (sqry.permissions.capture) throw new Error('查询账号不应有拍照权限');
  smgrToken = store.login({ username: 'role_smgr', password: 'pass123456' }).sessionToken;
  scapToken = store.login({ username: 'role_cap', password: 'pass123456' }).sessionToken;
  sqryToken = store.login({ username: 'role_qry', password: 'pass123456' }).sessionToken;
  smgr2Token = store.login({ username: 'role_smgr2', password: 'pass123456' }).sessionToken;
});

check('忽略外部传入的 permissions，防止配出与角色矛盾的账号', () => {
  const u = store.createUser(adminToken, {
    username: 'role_evil', name: '越权测试', password: 'pass123456',
    role: 'query', store: '人民路店',
    permissions: { capture: true, query: true }
  });
  if (u.permissions.capture) throw new Error('查询账号被配出了拍照权限');
  const tk = store.login({ username: 'role_evil', password: 'pass123456' }).sessionToken;
  expectThrow(() => store.addRecord(tk, { imageData: tinyJpeg, barcode: 'EVIL01' }), '无权限');
});

check('门店管理员必须分配门店', () => {
  expectThrow(() => store.createUser(adminToken, { username: 'role_nostore', password: 'pass123456', role: 'storeadmin' }), '必须分配门店');
  expectThrow(() => store.updateUser(adminToken, { id: smgr2.id, role: 'storeadmin', store: '' }), '必须分配门店');
});

check('门店管理员只查不拍', () => {
  expectThrow(() => store.addRecord(smgrToken, { imageData: tinyJpeg, barcode: 'SMGR01' }), '无权限');
  const list = store.listRecords(smgrToken, { silent: true, pageSize: 100 });
  if (!list.items.length) throw new Error('门店管理员应能查到本店订单');
  if (!list.items.every((r) => r.storeName === '人民路店' || r.userId === smgr.id)) {
    throw new Error('门店管理员看到了他店订单：' + list.items.map((r) => r.storeName).join(','));
  }
});

check('查询账号不能拍照，拍照账号可以', () => {
  expectThrow(() => store.addRecord(sqryToken, { imageData: tinyJpeg, barcode: 'QRY01' }), '无权限');
  const rec = store.addRecord(scapToken, { imageData: tinyJpeg, barcode: 'CAP01' });
  if (!rec || rec.storeName !== '人民路店') throw new Error('拍照账号存档异常：' + JSON.stringify(rec && rec.storeName));
});

check('门店管理员可见本店账号日志', () => {
  const r = store.listLogs(smgrToken, { silent: true, pageSize: 200 });
  if (!r.total) throw new Error('门店管理员查不到本店日志');
  const names = [...new Set(r.items.map((l) => l.username))];
  if (!names.includes('role_cap')) throw new Error('缺少本店拍照账号日志：' + names.join(','));
});

check('门店管理员看不到他店与未分配门店账号的日志', () => {
  const r = store.listLogs(smgrToken, { silent: true, pageSize: 500 });
  const names = new Set(r.items.map((l) => l.username));
  if (names.has('role_smgr2')) throw new Error('看到了他店门店管理员的日志');
  if (names.has('store_b1')) throw new Error('看到了他店账号的日志');
  if (names.has('admin')) throw new Error('看到了系统管理员的日志（本店账号范围之外）');
  if (names.has('store_n1') || names.has('store_n2')) throw new Error('看到了未分配门店账号的日志');
  // 本店账号日志必须完整可见
  if (!names.has('role_smgr') || !names.has('role_qry')) throw new Error('本店账号日志不完整：' + [...names].join(','));
});

check('账号调店后其日志随之归属新门店（按当前门店归属收窄）', () => {
  // sa2 已从人民路店调到解放路店，其历史日志不应再对人民路店门店管理员可见
  const r = store.listLogs(smgrToken, { silent: true, pageSize: 500 });
  if (r.items.some((l) => l.username === 'store_a2')) throw new Error('调店账号的日志仍对原门店可见');
  const r2 = store.listLogs(smgr2Token, { silent: true, pageSize: 500 });
  if (!r2.items.some((l) => l.username === 'store_a2')) throw new Error('调店账号的日志未归属新门店');
});

check('日志页账号筛选下拉对门店管理员收窄到本店', () => {
  const list = store.logFilterUsers(smgrToken);
  const names = list.map((u) => u.username);
  if (!names.includes('role_cap') || !names.includes('role_qry')) throw new Error('本店账号缺失：' + names.join(','));
  if (names.includes('admin') || names.includes('role_smgr2') || names.includes('store_b1')) {
    throw new Error('下拉泄露了他店/系统账号：' + names.join(','));
  }
  const all = store.logFilterUsers(adminToken);
  if (all.length <= list.length) throw new Error('系统管理员应能看到全部账号');
  if (all.some((u) => u.passwordHash !== undefined || u.salt !== undefined)) throw new Error('账号列表泄露密码信息');
});

check('门店管理员未分配门店时日志返回空集而非放开为全部', () => {
  // 配置异常的兜底：不能因为门店为空就变成「可见全部日志」。
  // API 路径已拦住清空门店（见上一条用例），这里直接改数据文件模拟遗留/手工编辑产生的异常状态。
  const usersPath = path.join(tmpDir, 'data', 'users.json');
  const backup = fs.readFileSync(usersPath, 'utf8');
  try {
    const users = JSON.parse(backup);
    const target = users.find((u) => u.username === 'role_smgr');
    target.store = '';
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2), 'utf8');

    const r = store.listLogs(smgrToken, { silent: true, pageSize: 200 });
    if (r.total !== 0 || r.items.length) throw new Error('应返回空集，实际 ' + r.total + ' 条');
    const users2 = store.logFilterUsers(smgrToken);
    if (users2.length !== 0) throw new Error('账号下拉应为空，实际 ' + users2.length);
    // 订单查询同样不能因此放开为全部
    const recs = store.listRecords(smgrToken, { silent: true, pageSize: 200 });
    if (recs.items.some((x) => x.userId !== smgr.id && x.storeName)) throw new Error('门店为空时订单范围被放开');
  } finally {
    fs.writeFileSync(usersPath, backup, 'utf8');
  }
  if (!store.listLogs(smgrToken, { silent: true, pageSize: 200 }).total) throw new Error('恢复门店后仍查不到日志');
});

check('拍照账号与查询账号无权查看操作日志', () => {
  expectThrow(() => store.listLogs(scapToken, { silent: true }), '无权限');
  expectThrow(() => store.listLogs(sqryToken, { silent: true }), '无权限');
  expectThrow(() => store.logFilterUsers(scapToken, { silent: true }), '无权限');
});

check('门店管理员无权管理账号与系统设置', () => {
  expectThrow(() => store.listUsers(smgrToken), '系统管理员');
  expectThrow(() => store.createUser(smgrToken, { username: 'role_x', password: 'pass123456' }), '系统管理员');
  expectThrow(() => store.updateUser(smgrToken, { id: scap.id, role: 'sysadmin' }), '系统管理员');
  expectThrow(() => store.deleteUser(smgrToken, scap.id), '系统管理员');
  expectThrow(() => store.updateSystemSettings(smgrToken, { port: 18099 }), '系统管理员');
  expectThrow(() => store.resetApiToken(smgrToken), '系统管理员');
  expectThrow(() => store.overview(smgrToken), '系统管理员');
  expectThrow(() => store.setForceUpdate(smgrToken, { enabled: true }), '系统管理员');
});

check('门店管理员不能删除订单（只查不删）', () => {
  const list = store.listRecords(smgrToken, { silent: true, pageSize: 100 });
  const target = list.items[0];
  if (!target) throw new Error('无可用订单做删除测试');
  expectThrow(() => store.deleteRecord(smgrToken, target.id), '无权限');
  if (!store.getRecord(adminToken, target.id)) throw new Error('订单被门店管理员误删');
});

check('系统管理员可见全部门店订单与日志', () => {
  const recs = store.listRecords(adminToken, { silent: true, pageSize: 500 });
  const stores = new Set(recs.items.map((r) => r.storeName));
  if (!stores.has('人民路店') || !stores.has('解放路店')) throw new Error('系统管理员未覆盖全部门店：' + [...stores].join(','));
  const logs = store.listLogs(adminToken, { silent: true, pageSize: 500 });
  const names = new Set(logs.items.map((l) => l.username));
  if (!names.has('role_smgr2') || !names.has('admin')) throw new Error('系统管理员日志范围不完整');
});

check('数据总览按四级角色统计账号数', () => {
  const o = store.overview(adminToken);
  if (!o.roleCount) throw new Error('缺少 roleCount 统计');
  if (o.roleCount.sysadmin < 1) throw new Error('系统管理员计数错误：' + o.roleCount.sysadmin);
  if (o.roleCount.storeadmin < 2) throw new Error('门店管理员计数错误：' + o.roleCount.storeadmin);
  if (o.roleCount.capture < 1 || o.roleCount.query < 1) throw new Error('拍照/查询账号计数错误：' + JSON.stringify(o.roleCount));
  const sum = Object.values(o.roleCount).reduce((a, b) => a + b, 0);
  if (sum !== o.userCount) throw new Error('各角色之和应等于账号总数：' + sum + ' vs ' + o.userCount);
  if (o.adminCount !== o.roleCount.sysadmin) throw new Error('adminCount 与 sysadmin 计数不一致');
});

check('角色变更时权限自动对齐，不能修改自己的角色', () => {
  store.updateUser(adminToken, { id: sqry.id, role: 'capture' });
  const u = store.listUsers(adminToken).find((x) => x.username === 'role_qry');
  if (u.role !== 'capture' || !u.permissions.capture) throw new Error('角色变更后权限未对齐：' + JSON.stringify(u.permissions));
  store.updateUser(adminToken, { id: sqry.id, role: 'query' });
  const back = store.listUsers(adminToken).find((x) => x.username === 'role_qry');
  if (back.permissions.capture) throw new Error('改回查询账号后拍照权限未收回');
  expectThrow(() => store.updateUser(adminToken, { id: store.current(adminToken).id, role: 'query' }), '不能修改自己的角色');
});

check('旧角色账号自动迁移为四级角色', () => {
  // 构造 v1.0.0 的旧数据：admin/client 二分 + permissions 开关，无 store 字段
  const migDir = path.join(tmpDir, 'migrate-data');
  fs.mkdirSync(migDir, { recursive: true });
  const oldUsers = [
    { id: 'u-admin', username: 'oldadmin', name: '老管理员', role: 'admin', salt: 's', passwordHash: 'h', permissions: { capture: true, query: true }, active: true, createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'u-both', username: 'oldboth', name: '拍照+查询', role: 'client', salt: 's', passwordHash: 'h', permissions: { capture: true, query: true }, active: true, createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'u-query', username: 'oldquery', name: '仅查询', role: 'client', salt: 's', passwordHash: 'h', permissions: { capture: false, query: true }, active: true, createdAt: '2026-01-03T00:00:00.000Z' },
    { id: 'u-cap', username: 'oldcap', name: '仅拍照', role: 'client', salt: 's', passwordHash: 'h', permissions: { capture: true, query: false }, active: true, createdAt: '2026-01-04T00:00:00.000Z' }
  ];
  fs.writeFileSync(path.join(migDir, 'users.json'), JSON.stringify(oldUsers, null, 2), 'utf8');
  const migStore = createStore({
    dataDir: migDir,
    defaultPhotoDir: path.join(tmpDir, 'migrate-photos'),
    updateDir: path.join(tmpDir, 'migrate-updates'),
    appVersion: '1.1.0',
    photoScheme: 'xqy-photo'
  });
  migStore.ensureSeedData();
  const after = JSON.parse(fs.readFileSync(path.join(migDir, 'users.json'), 'utf8'));
  const m = Object.fromEntries(after.map((u) => [u.username, u]));
  if (m.oldadmin.role !== 'sysadmin') throw new Error('旧 admin 未迁移为 sysadmin：' + m.oldadmin.role);
  if (m.oldboth.role !== 'capture') throw new Error('拍照+查询未迁移为 capture：' + m.oldboth.role);
  if (m.oldquery.role !== 'query') throw new Error('仅查询未迁移为 query：' + m.oldquery.role);
  if (m.oldcap.role !== 'capture') throw new Error('仅拍照未迁移为 capture：' + m.oldcap.role);
  if (!m.oldquery.permissions.capture === false) throw new Error('迁移后权限未与角色对齐');
  if (m.oldquery.permissions.capture) throw new Error('查询账号迁移后仍带拍照权限');
  if (after.some((u) => u.store === undefined)) throw new Error('迁移未补齐 store 字段');
  // 迁移是幂等的：再跑一次不应改变角色
  migStore.ensureSeedData();
  const again = JSON.parse(fs.readFileSync(path.join(migDir, 'users.json'), 'utf8'));
  const m2 = Object.fromEntries(again.map((u) => [u.username, u]));
  if (m2.oldadmin.role !== 'sysadmin' || m2.oldquery.role !== 'query') throw new Error('迁移不幂等');
});

console.log('== 按日期导出（表格按条码汇总） ==');
check('导出表格每个条码一条、照片仍完整归档', () => {
  const expDir = path.join(tmpDir, 'export-by-date');
  const today = new Date().toISOString().slice(0, 10);
  // 补三个条码形成 3/2/1 张的差异，验证汇总数量正确
  store.addRecord(scapToken, { imageData: tinyJpeg, barcode: 'EXP-A' });
  store.addRecord(scapToken, { imageData: tinyJpeg, barcode: 'EXP-A' });
  store.addRecord(scapToken, { imageData: tinyJpeg, barcode: 'EXP-A' });
  store.addRecord(scapToken, { imageData: tinyJpeg, barcode: 'EXP-B' });
  store.addRecord(scapToken, { imageData: tinyJpeg, barcode: 'EXP-B' });
  store.addRecord(scapToken, { imageData: tinyJpeg, barcode: 'EXP-C' });

  const r = store.exportPhotosByDate(adminToken, { dateFrom: today, dateTo: today, targetDir: expDir });
  if (!r.exported) throw new Error('未导出任何照片');
  if (!r.csvPath || !fs.existsSync(r.csvPath)) throw new Error('未生成导出表格');

  const csv = fs.readFileSync(r.csvPath, 'utf8').replace(/^\uFEFF/, '');
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (lines[0] !== '"条码","照片数量","文件位置"') throw new Error('表头不符：' + lines[0]);

  const rows = lines.slice(1);
  const find = (code) => rows.find((x) => x.includes(code));
  const rowA = find('EXP-A');
  const rowB = find('EXP-B');
  const rowC = find('EXP-C');
  if (!rowA || !rowA.includes('"3"')) throw new Error('EXP-A 应汇总为 3 张：' + rowA);
  if (!rowB || !rowB.includes('"2"')) throw new Error('EXP-B 应汇总为 2 张：' + rowB);
  if (!rowC || !rowC.includes('"1"')) throw new Error('EXP-C 应汇总为 1 张：' + rowC);
  if (!rowA.includes(path.join(expDir, 'EXP-A'))) throw new Error('文件位置应指向条码文件夹：' + rowA);

  // 关键口径：表格按条码汇总，不能逐张照片罗列
  const expRows = rows.filter((x) => x.includes('EXP-'));
  if (expRows.length !== 3) throw new Error('6 张照片应只汇总为 3 行，实际 ' + expRows.length + ' 行');

  // 照片本身仍须全部导出到对应文件夹
  const cnt = (code) => fs.readdirSync(path.join(expDir, code)).filter((f) => /\.(jpg|jpeg|png)$/i.test(f)).length;
  if (cnt('EXP-A') !== 3) throw new Error('EXP-A 文件夹照片数应为 3，实际 ' + cnt('EXP-A'));
  if (cnt('EXP-B') !== 2) throw new Error('EXP-B 文件夹照片数应为 2，实际 ' + cnt('EXP-B'));
  if (cnt('EXP-C') !== 1) throw new Error('EXP-C 文件夹照片数应为 1，实际 ' + cnt('EXP-C'));
});

check('门店管理员可导出本店订单、且表格不含他店条码', () => {
  const expDir = path.join(tmpDir, 'export-smgr');
  const today = new Date().toISOString().slice(0, 10);
  const r = store.exportPhotosByDate(smgrToken, { dateFrom: today, dateTo: today, targetDir: expDir });
  if (!r.exported) throw new Error('门店管理员应能导出本店订单');
  const csv = fs.readFileSync(r.csvPath, 'utf8').replace(/^\uFEFF/, '');
  if (csv.includes('STORE-B1-001')) throw new Error('导出表格混入他店条码');
  if (!csv.includes('EXP-A')) throw new Error('导出表格缺少本店条码');
});

check('查询账号（无拍照权限）也能导出本店订单', () => {
  const expDir = path.join(tmpDir, 'export-qry');
  const today = new Date().toISOString().slice(0, 10);
  const r = store.exportPhotosByDate(sqryToken, { dateFrom: today, dateTo: today, targetDir: expDir });
  if (!r.exported) throw new Error('查询账号应能导出本店订单');
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

// ========== 订单数据保留期与自动清理 ==========
// 这是不可逆的批量删除，用隔离的 store 实例测试，避免影响上面的用例数据。
console.log('== 订单保留期与自动清理 ==');
const purDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xqy-purge-'));
const purStore = createStore({
  dataDir: path.join(purDir, 'data'),
  defaultPhotoDir: path.join(purDir, 'photos'),
  updateDir: path.join(purDir, 'updates'),
  appVersion: '0.1.0',
  photoScheme: 'xqy-photo'
});
purStore.ensureSeedData();
// 强制为服务端模式（清理仅服务端执行）
purStore.setMode('server');
const purAdmin = purStore.login({ username: 'admin', password: 'admin123' }).sessionToken;
purStore.createUser(purAdmin, { username: 'clerk', name: '店员', password: 'clerk123', permissions: { capture: true, query: true } });
const purClerk = purStore.login({ username: 'clerk', password: 'clerk123' }).sessionToken;

/** 直接改写 records.json 的 createdAt，构造指定天数前的历史记录 */
function backdateRecords(daysAgoById) {
  const f = path.join(purDir, 'data', 'records.json');
  const list = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const r of list) {
    const d = daysAgoById[r.barcode];
    if (d !== undefined) r.createdAt = new Date(Date.now() - d * 86400000).toISOString();
  }
  fs.writeFileSync(f, JSON.stringify(list, null, 2), 'utf8');
}

function countPhotoFiles(dir) {
  let n = 0;
  const walk = (d) => {
    for (const en of fs.readdirSync(d, { withFileTypes: true })) {
      if (en.isDirectory()) walk(path.join(d, en.name));
      else n++;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return n;
}

check('默认未配置保留期：禁用且清理跳过，不删任何数据', () => {
  purStore.addRecord(purClerk, { imageData: tinyJpeg, barcode: 'D001' });
  const info = purStore.getRetention(purAdmin);
  if (info.retentionDays !== null) throw new Error('默认应为 null，实际 ' + info.retentionDays);
  if (info.enabled !== false) throw new Error('默认应为禁用');
  if (info.wouldDelete !== 0) throw new Error('默认 should not 预览出待删数量');
  const r = purStore.purgeExpiredRecords({});
  if (r.skipped !== true) throw new Error('未配置时应跳过');
  if (r.deleted !== 0) throw new Error('未配置时不应删除任何数据');
  if (purStore.listRecords(purAdmin, { silent: true, pageSize: 100 }).total !== 1) throw new Error('数据被误删');
});

check('保留天数非法值一律拒绝（不做静默兜底）', () => {
  // 0 天等于清空全部订单，必须显式拒绝
  expectThrow(() => purStore.setRetention(purAdmin, 0), '不能为 0');
  expectThrow(() => purStore.setRetention(purAdmin, -5), '不能为负数');
  expectThrow(() => purStore.setRetention(purAdmin, 1.5), '必须是整数');
  expectThrow(() => purStore.setRetention(purAdmin, 'abc'), '必须是数字');
  expectThrow(() => purStore.setRetention(purAdmin, 99999), '过大');
  // 拒绝后配置应保持未启用
  if (purStore.getRetention(purAdmin).enabled !== false) throw new Error('非法值竟被接受');
});

check('设置保留期后不会立即删数据，只给出预览数量', () => {
  // 造 2 条 400 天前的旧记录 + 保留 1 条今天的
  purStore.addRecord(purClerk, { imageData: tinyJpeg, barcode: 'D002' });
  purStore.addRecord(purClerk, { imageData: tinyJpeg, barcode: 'D003' });
  backdateRecords({ D001: 400, D002: 400 });
  const info = purStore.setRetention(purAdmin, 365);
  if (info.retentionDays !== 365) throw new Error('保留期未保存：' + info.retentionDays);
  if (info.enabled !== true) throw new Error('应标记为已启用');
  if (info.wouldDelete !== 2) throw new Error('预览应显示 2 条待删，实际 ' + info.wouldDelete);
  // 关键：设置动作本身不删数据
  if (purStore.listRecords(purAdmin, { silent: true, pageSize: 100 }).total !== 3) {
    throw new Error('设置保留期时不应立即删除数据');
  }
});

check('dryRun 只统计不删除', () => {
  const r = purStore.purgeExpiredRecords({ token: purAdmin, dryRun: true });
  if (r.deleted !== 2) throw new Error('试算应报告 2 条，实际 ' + r.deleted);
  if (r.dryRun !== true) throw new Error('dryRun 标志未回传');
  if (purStore.listRecords(purAdmin, { silent: true, pageSize: 100 }).total !== 3) throw new Error('试算竟真的删了数据');
  if (countPhotoFiles(path.join(purDir, 'photos')) !== 3) throw new Error('试算竟真的删了照片');
});

check('非系统管理员无权设置或执行清理', () => {
  expectThrow(() => purStore.setRetention(purClerk, 30), '系统管理员');
  expectThrow(() => purStore.getRetention(purClerk), '系统管理员');
  expectThrow(() => purStore.purgeExpiredRecords({ token: purClerk }), '系统管理员');
});

check('客户端模式不执行清理（数据以服务端为准）', () => {
  purStore.setClientConfig('192.168.1.10:17521', 'abc123');
  const r = purStore.purgeExpiredRecords({});
  if (r.skipped !== true) throw new Error('客户端模式应跳过');
  if (r.deleted !== 0) throw new Error('客户端模式不应删除数据');
  if (purStore.listRecords(purAdmin, { silent: true, pageSize: 100 }).total !== 3) throw new Error('客户端模式下数据被误删');
  purStore.setMode('server'); // 恢复
});

check('实际清理：删除超期订单与照片，保留未超期的', () => {
  const before = purStore.listRecords(purAdmin, { silent: true, pageSize: 100 }).total;
  if (before !== 3) throw new Error('前置数据异常：' + before);
  const r = purStore.purgeExpiredRecords({ token: purAdmin });
  if (r.deleted !== 2) throw new Error('应删除 2 条，实际 ' + r.deleted);
  if (r.photosRemoved !== 2) throw new Error('应删除 2 张照片，实际 ' + r.photosRemoved);
  if (r.kept !== 1) throw new Error('应保留 1 条，实际 ' + r.kept);
  const left = purStore.listRecords(purAdmin, { silent: true, pageSize: 100 });
  if (left.total !== 1) throw new Error('清理后应剩 1 条，实际 ' + left.total);
  if (left.items[0].barcode !== 'D003') throw new Error('删除的不是超期记录，剩下的是 ' + left.items[0].barcode);
  if (countPhotoFiles(path.join(purDir, 'photos')) !== 1) throw new Error('照片文件数量不符');
  // 被删记录的照片文件必须真的从磁盘消失（按文件数判定，不看目录是否还在）
  const d001dir = path.join(purDir, 'photos', 'D001');
  if (fs.existsSync(d001dir) && fs.readdirSync(d001dir).length !== 0) {
    throw new Error('D001 的照片文件未被删除：' + fs.readdirSync(d001dir).join(','));
  }
  // 空条码目录刻意保留：删目录属于超出需求范围的额外不可逆操作，
  // 需求只要求删除订单数据；残留空目录无害，故不验证目录被删除
});

check('清理具备幂等性：重复执行不会多删', () => {
  const r = purStore.purgeExpiredRecords({ token: purAdmin });
  if (r.deleted !== 0) throw new Error('第二次不应再删，实际 ' + r.deleted);
  if (purStore.listRecords(purAdmin, { silent: true, pageSize: 100 }).total !== 1) throw new Error('幂等执行后数据变了');
});

check('createdAt 缺失的记录不被清理（无法判断年龄则保留）', () => {
  const f = path.join(purDir, 'data', 'records.json');
  const list = JSON.parse(fs.readFileSync(f, 'utf8'));
  list.push({ id: 'no-date-rec', barcode: 'D-NODATE', seq: 1, userId: 'x', username: 'x', storeName: '', note: '', photoFile: '' });
  fs.writeFileSync(f, JSON.stringify(list, null, 2), 'utf8');
  const r = purStore.purgeExpiredRecords({ token: purAdmin });
  if (r.deleted !== 0) throw new Error('无时间戳的记录不应被删，实际删了 ' + r.deleted);
  const left = purStore.listRecords(purAdmin, { silent: true, pageSize: 100 });
  if (!left.items.some((x) => x.barcode === 'D-NODATE')) throw new Error('无时间戳记录被误删');
});

check('自动执行遇「将删光全部」时熔断，且不删任何数据', () => {
  // 模拟时钟异常：把保留期设成 1 天，并把仅剩的记录也改到 2 天前，
  // 使自动清理（无 token）会命中全部记录 —— 这正是时钟跳到未来时的等效后果
  purStore.setRetention(purAdmin, 1);
  backdateRecords({ 'D-NODATE': 2, D003: 2 });
  const beforeCount = purStore.listRecords(purAdmin, { silent: true, pageSize: 100 }).total;
  const r = purStore.purgeExpiredRecords({}); // 无 token = 自动执行
  if (r.skipped !== true) throw new Error('自动执行应熔断跳过');
  if (r.deleted !== 0) throw new Error('熔断后仍删除了 ' + r.deleted + ' 条');
  if (!/熔断/.test(r.reason)) throw new Error('未给出熔断原因：' + r.reason);
  if (purStore.listRecords(purAdmin, { silent: true, pageSize: 100 }).total !== beforeCount) {
    throw new Error('熔断未生效，数据被删');
  }
  // 熔断必须留痕，否则管理员不知道自动清理为什么没跑
  const logs = purStore.listLogs(purAdmin, { silent: true, action: '自动清理过期订单', pageSize: 50 });
  if (!logs.items.some((l) => /熔断/.test(l.detail))) throw new Error('熔断未记入日志');
  if (!logs.items.some((l) => l.result === '失败')) throw new Error('熔断日志应标记为失败');
});

check('手动执行（管理员明确发起）可以清空全部超期订单', () => {
  // 熔断只拦自动执行；管理员手动执行是知情操作，且界面会先展示预览数量
  const r = purStore.purgeExpiredRecords({ token: purAdmin });
  if (r.skipped === true) throw new Error('手动执行不应被熔断拦住：' + r.reason);
  if (r.deleted < 1) throw new Error('手动执行应删除超期订单，实际 ' + r.deleted);
  if (purStore.listRecords(purAdmin, { silent: true, pageSize: 100 }).total !== 0) throw new Error('手动执行后应无剩余');
});

check('取消保留期后恢复为禁用，且不再清理', () => {
  purStore.addRecord(purAdmin, { imageData: tinyJpeg, barcode: 'E001' });
  backdateRecords({ E001: 9999 });
  const info = purStore.setRetention(purAdmin, null);
  if (info.enabled !== false || info.retentionDays !== null) throw new Error('取消后仍为启用');
  const r = purStore.purgeExpiredRecords({ token: purAdmin });
  if (r.skipped !== true || r.deleted !== 0) throw new Error('取消后仍在清理');
});

check('保留期设置与清理均记入操作日志', () => {
  const opts = purStore.logActionOptions(purAdmin);
  for (const a of ['设置订单保留期', '取消订单保留期', '自动清理过期订单']) {
    if (!opts.includes(a)) throw new Error('筛选清单缺少动作类型：' + a);
  }
  const setLogs = purStore.listLogs(purAdmin, { silent: true, action: '设置订单保留期', pageSize: 50 });
  if (!setLogs.items.length) throw new Error('设置保留期未记日志');
  if (!/将删除/.test(setLogs.items[0].detail)) throw new Error('设置日志应含预览删除数量：' + setLogs.items[0].detail);
  const purgeLogs = purStore.listLogs(purAdmin, { silent: true, action: '自动清理过期订单', pageSize: 50 });
  if (!purgeLogs.items.some((l) => /剩余/.test(l.detail))) throw new Error('清理日志应含剩余条数');
});

fs.rmSync(purDir, { recursive: true, force: true });

console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);

