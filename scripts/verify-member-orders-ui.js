'use strict';
/* =============================================================================
 * verify-member-orders-ui.js —— 会员订单页面实机验证（真实 Chromium / Electron）
 *
 * 目的：确认新页面在真实渲染引擎里能挂载、菜单入口可见、导入流程可用，
 *       而不是只在纯函数层面自洽。
 *
 * 做法：加载产品真实 renderer/index.html（真 Vue + 真 styles.css），
 *       用桩 window.api 注入会员订单相关接口，
 *       然后：
 *         1) 登录 → 断言左侧菜单出现「会员订单」
 *         2) 点击进入 → 断言页面标题 / 导入卡片 / 列表空态渲染出来
 *         3) 模拟「选择文件并预览」→ 断言预览统计、字段映射表、异常清单出现
 *         4) 模拟「确认导入」→ 断言列表出现导入的订单
 *         5) 断言查询账号看不到导入入口（权限隔离在 UI 层的体现）
 *
 * 运行：unset ELECTRON_RUN_AS_NODE && node_modules/electron/dist/electron.exe \
 *         scripts/verify-member-orders-ui.js --disable-gpu-compositing \
 *         --disable-software-rasterizer --no-sandbox --in-process-gpu
 * ========================================================================== */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer', 'index.html');

let pass = 0;
let fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('    ✓ ' + name); }
  else { fail++; console.log('    ✗ ' + name + (extra ? ' —— ' + extra : '')); fails.push(name); }
}

// 会员订单的桩数据：与真实解析结果同构
const STUB_PREVIEW = {
  format: 'csv',
  fileName: '会员导出_20261101.csv',
  stats: { total: 3, valid: 2, invalid: 1, duplicates: 0 },
  dbDuplicate: 0,
  issues: [
    { row: 4, field: 'amount', message: '金额缺失或格式异常，已置空' },
    { row: 4, field: 'orderNo', message: '订单号缺失，无法映射为条码，已跳过该行' }
  ],
  orders: [
    { rowIndex: 2, orderNo: 'XY-2026-00123', barcode: 'XY-2026-00123', customer: '张女士', phone: '13800001111', items: ['羽绒服', '皮靴'], amount: 128.5, createdAt: '2026-11-01T06:32:00.000Z', status: '待取', extra: {} },
    { rowIndex: 3, orderNo: 'XY-2026-00124', barcode: 'XY-2026-00124', customer: '李先生', phone: '13900002222', items: ['西服'], amount: 88, createdAt: '2026-11-02T01:00:00.000Z', status: '已取', extra: {} }
  ],
  truncated: false
};

const STUB_ROWS = [
  { id: 'm1', orderNo: 'XY-2026-00123', barcode: 'XY-2026-00123', customer: '张女士', phone: '13800001111', items: ['羽绒服', '皮靴'], amount: 128.5, createdAt: '2026-11-01T06:32:00.000Z', status: '待取', username: 'admin' },
  { id: 'm2', orderNo: 'XY-2026-00124', barcode: 'XY-2026-00124', customer: '李先生', phone: '13900002222', items: ['西服'], amount: 88, createdAt: '2026-11-02T01:00:00.000Z', status: '已取', username: 'admin' }
];

// 注入渲染层的桩 API（在任何页面脚本之前执行）
const STUB = `
(function () {
  const preview = ${JSON.stringify(STUB_PREVIEW)};
  const rows = ${JSON.stringify(STUB_ROWS)};
  const state = { user: { id: 'u1', username: 'admin', name: '系统管理员', role: 'sysadmin', permissions: { capture: true, query: true }, store: '' } };
  let imported = false;
  const noop = () => Promise.resolve({ ok: true, data: {} });
  window.api = {
    version: () => Promise.resolve({ ok: true, data: { version: '1.2.21' } }),
    checkUpdate: () => Promise.resolve({ ok: true, data: { hasUpdate: false } }),
    systemInfo: () => Promise.resolve({ ok: true, data: { version: '1.2.21', mode: 'server', token: 't', port: 17521 } }),
    login: () => Promise.resolve({ ok: true, data: { sessionToken: 'tok', user: state.user } }),
    currentUser: () => Promise.resolve({ ok: true, data: { sessionToken: 'tok', user: state.user } }),
    listCredentials: () => Promise.resolve({ ok: true, data: [] }),
    saveCredential: noop,
    removeCredential: noop,
    clearCredentials: noop,
    licenseStatus: () => Promise.resolve({ ok: true, data: { activated: true } }),
    offlineStatus: () => Promise.resolve({ ok: true, data: { online: true, pending: 0 } }),
    listMemberOrders: () => Promise.resolve({ ok: true, data: { items: imported ? rows : [], total: imported ? rows.length : 0, page: 1, pageSize: 12 } }),
    previewMemberOrders: () => Promise.resolve({ ok: true, data: preview }),
    importMemberOrders: () => { imported = true; return Promise.resolve({ ok: true, data: { imported: 2, skipped: 0, duplicated: 0, invalid: 1, matchedPhoto: 0, issues: preview.issues, orders: rows } }); },
    deleteMemberOrders: () => Promise.resolve({ ok: true, data: { deleted: 1 } }),
    chooseMemberOrderFile: () => Promise.resolve({ ok: true, data: { content: 'x', format: 'csv', fileName: '会员导出_20261101.csv' } }),
    readMemberOrderFile: () => Promise.resolve({ ok: true, data: { content: 'x', format: 'csv', fileName: 'x.csv' } })
  };
  // 测试钩子：切换角色以验证权限隔离在 UI 层的体现
  window.__setUser = (u) => { state.user = u; };
  window.__resetImported = () => { imported = false; };
})();
`;

async function main() {
  await app.whenReady();

  // 用 BrowserWindow 的 webPreferences.preload 注入桩（在页面脚本前执行）
  const stubPath = path.join(__dirname, '.member-orders-ui-stub.js');
  fs.writeFileSync(stubPath, STUB, 'utf8');

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      preload: stubPath
    }
  });

  await win.loadFile(RENDERER);
  await new Promise((r) => setTimeout(r, 900));

  const js = (code) => win.webContents.executeJavaScript(code);

  console.log('== 渲染层实机验证 ==');

  // 1) 登录页出现
  const loginVisible = await js(`(() => {
    const inputs = document.querySelectorAll('input');
    return Array.from(inputs).some((i) => i.type === 'text' || i.type === 'password');
  })()`);
  ok('1 登录页渲染（真实 Vue 应用已挂载）', loginVisible === true);

  // 2) 执行登录（登录按钮文案是「登 录」（中间带空格），且是表单 submit 按钮：
  //    走 form 的 submit 事件，不直接 button.click()）
  const loginDone = await js(`(async () => {
    const form = document.querySelector('form');
    const inputs = Array.from(document.querySelectorAll('input'));
    const u = inputs.find((i) => i.type === 'text');
    const p = inputs.find((i) => i.type === 'password');
    if (!u || !p || !form) return 'no-input';
    const setVal = (el, v) => {
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      desc.set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setVal(u, 'admin');
    setVal(p, 'admin123');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 900));
    return 'ok';
  })()`);
  ok('2 登录流程可完成', loginDone === 'ok', String(loginDone));

  // 3) 菜单出现「会员订单」
  const menu = await js(`(() => {
    const items = Array.from(document.querySelectorAll('.nav-item'));
    return {
      labels: items.map((e) => (e.textContent || '').trim()),
      hasMember: items.some((e) => (e.textContent || '').trim() === '会员订单')
    };
  })()`);
  ok('3 左侧菜单出现「会员订单」入口', menu.hasMember === true, JSON.stringify(menu.labels));

  // 4) 点击进入会员订单页
  const entered = await js(`(async () => {
    const el = Array.from(document.querySelectorAll('.nav-item'))
      .find((e) => (e.textContent || '').trim() === '会员订单');
    if (!el) return 'no-entry';
    el.click();
    await new Promise((r) => setTimeout(r, 700));
    return 'ok';
  })()`);
  ok('4 可进入会员订单页面', entered === 'ok', String(entered));

  // 5) 页面标题与导入卡片渲染
  const page = await js(`(() => {
    const text = document.body.innerText;
    return {
      hasTitle: /会员订单/.test(text),
      hasImportCard: !!document.querySelector('.mo-import'),
      hasEmpty: /暂无会员订单/.test(text)
    };
  })()`);
  ok('5 页面标题渲染', page.hasTitle === true);
  ok('6 导入卡片渲染（.mo-import）', page.hasImportCard === true);
  ok('7 空态提示渲染', page.hasEmpty === true);

  // 6) 触发「选择文件并预览」
  const previewed = await js(`(async () => {
    const btn = Array.from(document.querySelectorAll('.mo-import button')).find((b) => /选择文件/.test(b.textContent || ''));
    if (!btn) return 'no-btn';
    btn.click();
    await new Promise((r) => setTimeout(r, 700));
    const text = document.body.innerText;
    return {
      hasStats: /可导入订单/.test(text),
      hasFieldTable: /订单号/.test(text) && /张女士/.test(text),
      hasIssues: /字段缺失与格式异常/.test(text),
      hasIssueRow: /第 4 行/.test(text),
      hasConfirm: Array.from(document.querySelectorAll('button')).some((b) => /确认导入/.test(b.textContent || ''))
    };
  })()`);
  ok('8 预览统计卡渲染', previewed.hasStats === true, JSON.stringify(previewed));
  ok('9 字段映射预览表渲染（含解析出的会员与订单号）', previewed.hasFieldTable === true);
  ok('10 异常清单渲染（字段缺失与格式异常）', previewed.hasIssues === true);
  ok('11 异常定位到具体行号', previewed.hasIssueRow === true);
  ok('12 「确认导入」按钮出现', previewed.hasConfirm === true);

  // 7) 点击确认导入（showConfirm 弹窗需确认）
  const imported = await js(`(async () => {
    const btn = Array.from(document.querySelectorAll('.mo-import button')).find((b) => /确认导入/.test(b.textContent || ''));
    if (!btn) return 'no-btn';
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    // 确认弹窗：点「确认导入」/「确定」
    const okBtn = Array.from(document.querySelectorAll('.modal button, .modal-mask button'))
      .find((b) => /确认导入|确定/.test(b.textContent || '') && !/取消/.test(b.textContent || ''));
    if (!okBtn) return 'no-confirm';
    okBtn.click();
    await new Promise((r) => setTimeout(r, 800));
    const text = document.body.innerText;
    return { hasRow: /XY-2026-00123/.test(text) && /张女士/.test(text), hasAmount: /128\\.50|¥128/.test(text) };
  })()`);
  ok('13 确认导入后列表出现订单', imported && imported.hasRow === true, JSON.stringify(imported));
  ok('14 金额按 ¥ 两位小数展示', imported && imported.hasAmount === true);

  // 8) 权限隔离：用「查询账号」角色开一个新窗口验证
  //    （不用 location.reload() 重载当前窗口——那会销毁 JS 执行上下文，导致 await 永远挂起）
  const clerkStub = STUB
    .replace(
      "const state = { user: { id: 'u1', username: 'admin', name: '系统管理员', role: 'sysadmin', permissions: { capture: true, query: true }, store: '' } };",
      "const state = { user: { id: 'u2', username: 'clerk', name: '李婷', role: 'query', permissions: { capture: false, query: true }, store: '南京西路旗舰店' } };"
    )
    .replace(
      "login: () => Promise.resolve({ ok: true, data: { sessionToken: 'tok', user: state.user } })",
      "login: () => Promise.resolve({ ok: true, data: { sessionToken: 'tok2', user: state.user } })"
    );
  const clerkStubPath = path.join(__dirname, '.member-orders-ui-stub-clerk.js');
  fs.writeFileSync(clerkStubPath, clerkStub, 'utf8');

  const win2 = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, preload: clerkStubPath }
  });
  await win2.loadFile(RENDERER);
  await new Promise((r) => setTimeout(r, 900));
  const js2 = (code) => win2.webContents.executeJavaScript(code);

  const perm = await js2(`(async () => {
    const form = document.querySelector('form');
    const inputs = Array.from(document.querySelectorAll('input'));
    const u = inputs.find((i) => i.type === 'text');
    const p = inputs.find((i) => i.type === 'password');
    if (!u || !p || !form) return { noInput: true };
    const setVal = (el, v) => {
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      desc.set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setVal(u, 'clerk');
    setVal(p, 'pw123456');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 900));
    const el = Array.from(document.querySelectorAll('.nav-item'))
      .find((e) => (e.textContent || '').trim() === '会员订单');
    if (!el) return { noEntry: true };
    el.click();
    await new Promise((r) => setTimeout(r, 700));
    return {
      hasImportCard: !!document.querySelector('.mo-import'),
      hasNotice: /没有「衣物拍照」权限/.test(document.body.innerText),
      hasTitle: /会员订单/.test(document.body.innerText)
    };
  })()`);
  ok('15 查询账号可进入会员订单页', perm && perm.hasTitle === true, JSON.stringify(perm));
  ok('16 查询账号看不到导入卡片', perm && perm.hasImportCard === false, JSON.stringify(perm));
  ok('17 查询账号看到「无导入权限」说明', perm && perm.hasNotice === true, JSON.stringify(perm));

  try { fs.unlinkSync(stubPath); } catch (e) { /* 清理失败不影响判定 */ }
  try { fs.unlinkSync(clerkStubPath); } catch (e) { /* 清理失败不影响判定 */ }

  console.log('\nverify-member-orders-ui: ' + pass + ' passed, ' + fail + ' failed');
  if (fail > 0) {
    console.error('FAILED: ' + fails.join('; '));
    app.exit(1);
  }
  console.log('verify-member-orders-ui: ALL GREEN');
  app.exit(0);
}

app.on('window-all-closed', () => { /* 由 app.exit 收尾 */ });
main().catch((e) => {
  console.error('实机验证异常：', e && (e.stack || e.message || e));
  app.exit(1);
});
