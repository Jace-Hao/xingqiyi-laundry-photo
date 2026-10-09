'use strict';
/**
 * 实机端到端冒烟：拉起真实 main/main.js（真实 preload.js + 真实 renderer/index.html），
 * 用真实 IPC 通道走完「启动 → 登录 → 拍照页 → 本周订单页 → 导出」全链路。
 *
 * 必须用 Electron 跑（主进程需要真实 app / BrowserWindow）：
 *   unset ELECTRON_RUN_AS_NODE && ./node_modules/electron/dist/electron.exe \
 *     scripts/verify-app-smoke.js --disable-gpu-compositing --disable-software-rasterizer \
 *     --no-sandbox --in-process-gpu
 *
 * 覆盖：
 *   A 主进程窗口几何（PRD R1-4）
 *   B 登录与 Shell
 *   C 拍照页 --cam-ar / --cam-max-h 自适应 + measureCameraMaxH 重算（R2-2 / R2-5）
 *   D 拍照页错误态：逐个错误码驱动真实 UI（R2-4）
 *   E 本周订单页筛选条 / 导出按钮三态 / busy 互斥锁
 *   F 服务端模式导出（IPC 往返）
 *   G 客户端模式导出（cfg.mode==='client'，离线降级分支）
 *
 * 用独立 userData 拉起，绝不碰本机真实数据；结束自行清理临时目录。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, screen } = require('electron');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else {
    fail++;
    const line = name + (extra ? ' —— ' + extra : '');
    failures.push(line);
    console.log('  ✗ ' + line);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 20000, interval = 250) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(interval);
  }
}

const USER_DATA = path.join(os.tmpdir(), 'xqy-smoke-userdata-' + Date.now());
const DATA_DIR = path.join(USER_DATA, 'data');
const PHOTO_DIR = path.join(USER_DATA, 'photos');
const EXPORT_DIR = path.join(USER_DATA, 'exports');

let win = null;
const js = (code) => win.webContents.executeJavaScript(code);

/** 在渲染层注入一个「按指定错误名失败」的 getUserMedia，然后重开摄像头 */
async function injectGumFailure(errorName) {
  await js(`
    (function () {
      var name = ${JSON.stringify(errorName)};
      var md = navigator.mediaDevices || {};
      window.__xqyGumCalls = 0;
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: function () {
            window.__xqyGumCalls++;
            if (name === '__HANG__') return new Promise(function () {});
            if (name === '__UNSUPPORTED__') throw new Error('no md');
            var e = new Error('injected ' + name);
            e.name = name;
            return Promise.reject(e);
          },
          enumerateDevices: function () { return Promise.resolve([]); },
          addEventListener: function () {},
          removeEventListener: function () {}
        }
      });
      return true;
    })()
  `);
  if (errorName === '__UNSUPPORTED__') {
    // 注意：不能用 delete —— mediaDevices 是 Navigator.prototype 上的访问器，
    // 删掉自有属性会重新露出原型 getter，拿回真实的 mediaDevices。
    // 正确做法是把自有属性定义成 undefined 把它「遮蔽」掉。
    await js(`
      (function () {
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
        return String(typeof navigator.mediaDevices);
      })()
    `);
  }
}

/** 读取拍照页覆盖层当前的错误态 UI */
async function readCameraOverlay() {
  const raw = await js(`
    (function () {
      var box = document.querySelector('.camera-box');
      if (!box) return JSON.stringify({ ok: false });
      var ov = box.querySelector('.camera-overlay');
      var acts = ov ? [...ov.querySelectorAll('.camera-overlay-actions button, .camera-overlay-actions select')] : [];
      var video = box.querySelector('video');
      return JSON.stringify({
        ok: true,
        // .camera-overlay 带 .error 类才代表「已落到错误态」；
        // 可重试错误在自动重连期间仍是「摄像头准备中…」，不能当作错误态读取
        isError: !!(ov && ov.classList.contains('error')),
        title: ov ? ((ov.querySelector('.camera-overlay-title') || {}).textContent || '').trim() : '',
        sub: ov ? ((ov.querySelector('.camera-sleep-sub') || {}).textContent || '').trim() : '',
        actions: acts.map(function (b) {
          return (b.tagName === 'SELECT' ? 'SELECT:' : '') + (b.textContent || '').trim();
        }),
        camAr: box.style.getPropertyValue('--cam-ar') || '',
        camMaxH: box.style.getPropertyValue('--cam-max-h') || '',
        boxH: Math.round(box.getBoundingClientRect().height),
        objectFit: video ? getComputedStyle(video).objectFit : 'no-video',
        gumCalls: window.__xqyGumCalls || 0
      });
    })()
  `);
  return JSON.parse(raw);
}

/** 点击侧栏「退出登录」并等待回到登录页 */
async function uiLogout() {
  await js(`
    (function () {
      var btns = [...document.querySelectorAll('.sidebar-foot button')];
      var b = btns.find(function (x) { return (x.textContent || '').indexOf('退出登录') >= 0; });
      if (b) { b.click(); return true; }
      return false;
    })()
  `);
  // 必须等侧栏真的消失再判登录页：否则会拿到「过渡中」的旧 DOM，
  // 后续 waitFor(sidebar) 立刻返回，导致后续用例跑在尚未完成登录的界面上
  await waitFor(async () =>
    js('!document.querySelector(".sidebar") && !!document.querySelector(".login-user-field input")'), 15000);
}

/** 从已登录态切换到另一个账号：退出 → 重新填表登录 */
async function relogin(username, password) {
  await uiLogout();
  const r = await waitFor(async () => {
    const v = await js(`
      (function () {
        var u = document.querySelector('.login-user-field input');
        var p = document.querySelector('input[type=password]');
        if (!u || !p) return 'NO-FORM';
        var set = function (el, val) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); };
        set(u, ${JSON.stringify(username)}); set(p, ${JSON.stringify(password)});
        var btn = document.querySelector('form .btn-block');
        if (!btn) return 'NO-BTN';
        btn.click();
        return 'CLICKED';
      })()
    `);
    return v === 'CLICKED' ? v : null;
  }, 20000);
  if (r !== 'CLICKED') throw new Error('切换账号失败：未找到登录表单（' + r + '）');
  // 必须等「登录卡片消失 且 侧栏出现」：只看侧栏会命中点击后尚未卸载的旧侧栏
  const shell = await waitFor(async () =>
    js('!document.querySelector(".login-card") && !!document.querySelector(".sidebar")'), 20000);
  if (!shell) throw new Error('切换账号失败：' + username + ' 登录后未进入主界面');
  await sleep(1200);
}

async function clickNav(text) {
  await js(`
    (function () {
      var items = [...document.querySelectorAll('.nav-item')];
      var t = items.find(function (el) { return (el.textContent || '').indexOf(${JSON.stringify(text)}) >= 0; });
      if (t) { t.click(); return true; }
      return false;
    })()
  `);
}

async function phaseA() {
  console.log('\n=== A 主进程窗口几何（PRD R1-4）===');
  const wa = screen.getPrimaryDisplay().workArea;
  const expectW = Math.min(Math.max(Math.round(wa.width * 0.86), 1024), Math.min(wa.width, 2560));
  const expectH = Math.min(Math.max(Math.round(wa.height * 0.90), 680), wa.height);
  console.log('  主屏 workArea ' + JSON.stringify(wa) + ' → 期望还原态 ' + expectW + '×' + expectH);

  ok('应用启动后窗口仍处于最大化（「打开即最大化」语义未变）', win.isMaximized() === true, String(win.isMaximized()));

  // 容差 10px：Windows 的 WS_MAXIMIZE 会沿四周各外扩 8px（隐藏缩放边框），
  // Electron 的 getBounds() 返回的是含这圈的几何矩形，属操作系统既定行为。
  const maxB = win.getBounds();
  ok('最大化窗口完全落在主屏 workArea 内（±10，Windows 最大化外扩 8px 属系统行为）',
    maxB.x >= wa.x - 10 && maxB.y >= wa.y - 10 &&
    maxB.x + maxB.width <= wa.x + wa.width + 10 &&
    maxB.y + maxB.height <= wa.y + wa.height + 10,
    JSON.stringify(maxB) + ' vs ' + JSON.stringify(wa));

  // 还原 → 量还原态 → 再最大化
  win.unmaximize();
  await sleep(400);
  const nb = win.getNormalBounds();
  console.log('  实际还原态 ' + nb.width + '×' + nb.height + ' @ ' + nb.x + ',' + nb.y);
  ok('还原态宽 == clamp(round(wa.width×0.86),1024,min(wa.width,2560))（±2）',
    Math.abs(nb.width - expectW) <= 2, nb.width + ' vs ' + expectW);
  ok('还原态高 == clamp(round(wa.height×0.90),680,wa.height)（±2）',
    Math.abs(nb.height - expectH) <= 2, nb.height + ' vs ' + expectH);
  ok('还原态水平居中于主屏 workArea（±2）',
    Math.abs(nb.x - Math.round(wa.x + (wa.width - nb.width) / 2)) <= 2, String(nb.x));
  ok('还原态垂直居中于主屏 workArea（±2）',
    Math.abs(nb.y - Math.round(wa.y + (wa.height - nb.height) / 2)) <= 2, String(nb.y));
  win.maximize();
  await sleep(400);
}

async function phaseB() {
  console.log('\n=== B 登录与 Shell ===');
  const logged = await waitFor(async () => {
    const r = await js(`
      (function () {
        var u = document.querySelector('.login-user-field input');
        var p = document.querySelector('input[type=password]');
        if (!u || !p) return 'NO-FORM';
        var set = function (el, v) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
        set(u, 'admin'); set(p, 'admin123');
        var btn = document.querySelector('form .btn-block');
        if (!btn) return 'NO-BTN';
        btn.click();
        return 'CLICKED';
      })()
    `);
    return r === 'CLICKED' ? r : null;
  }, 20000);
  ok('真实登录表单已提交', logged === 'CLICKED', String(logged));

  const shell = await waitFor(async () => js('!!document.querySelector(".sidebar")'), 20000);
  ok('登录后主界面 Shell 已渲染', !!shell, String(shell));
  if (!shell) throw new Error('登录未进入主界面，后续阶段无法进行');
}

/**
 * 建两个账号，专供 IPC 调用使用：
 *   cap_smoke —— 拍照员。管理员菜单里没有拍照页，拍照相关阶段必须换这个账号登录。
 *   qa_admin  —— 第二个系统管理员。store 的「唯一登录」会让同一账号的新会话把旧会话顶下线，
 *                若直接复用界面正在使用的 admin 会话去做 window.api.login，
 *                界面会被自己的 IPC 登录顶回登录页（表现为侧栏/页面整片消失）。
 *                因此所有 IPC 调用一律用这个独立账号，与界面会话互不干扰。
 */
async function phaseB2() {
  console.log('\n=== B2 建专用账号（拍照员 + 独立管理员，避开「唯一登录」互顶）===');
  const r = await js(`
    window.api.login('admin', 'admin123').then(function (lg) {
      if (!lg.ok) return JSON.stringify(lg);
      var t = lg.data.sessionToken;
      return window.api.createUser(t, 'cap_smoke', '拍照员', 'capture', 'pwd123456', true, false, '总店')
        .then(function () {
          return window.api.createUser(t, 'cap_b', '拍照员B', 'capture', 'pwd123456', true, false, '分店');
        })
        .then(function () {
          return window.api.createUser(t, 'qa_admin', 'QA管理员', 'sysadmin', 'pwd123456', true, true, '');
        })
        .then(function (c) { return JSON.stringify({ ok: !!c.ok, message: c.message || '' }); });
    }).catch(function (e) { return JSON.stringify({ ok: false, message: String(e && e.message || e) }); })
  `);
  const res = JSON.parse(r);
  ok('专用账号创建成功（或已存在）', res.ok === true || /已存在|存在/.test(res.message || ''), JSON.stringify(res));
}

/** 取一个独立于界面会话的 IPC 令牌（唯一登录：绝不能用界面正在用的 admin） */
async function ipcToken() {
  const r = await js(`
    window.api.login('qa_admin', 'pwd123456').then(function (lg) {
      return JSON.stringify(lg.ok ? { ok: true, token: lg.data.sessionToken } : lg);
    }).catch(function (e) { return JSON.stringify({ ok: false, message: String(e && e.message || e) }); })
  `);
  return JSON.parse(r);
}

async function phaseC() {
  console.log('\n=== C 拍照页取景区自适应（R2-2 / R2-5）===');
  await relogin('cap_smoke', 'pwd123456');
  const navs = await js(`
    JSON.stringify([...document.querySelectorAll('.nav-item')].map(function (b) { return (b.textContent || '').trim(); }))
  `);
  ok('拍照员账号侧栏含「衣物拍照」入口', JSON.parse(navs).some((t) => t.indexOf('拍照') >= 0), navs);
  await injectGumFailure('NotAllowedError');
  await clickNav('拍照');
  const ready = await waitFor(async () => js('!!document.querySelector(".camera-box")'), 20000);
  ok('拍照页 .camera-box 已渲染', !!ready, String(ready));
  if (!ready) return;
  await sleep(1500);

  const geo = JSON.parse(await js(`
    (function () {
      var box = document.querySelector('.camera-box');
      var video = box.querySelector('video');
      var layout = document.querySelector('.capture-layout');
      var main = document.querySelector('.main').getBoundingClientRect();
      var r = box.getBoundingClientRect();
      var cols = getComputedStyle(layout).gridTemplateColumns.trim().split(/\\s+/);
      return JSON.stringify({
        innerWidth: window.innerWidth, innerHeight: window.innerHeight,
        colCount: cols.length, cols: cols,
        boxW: Math.round(r.width), boxH: Math.round(r.height),
        mainRightGap: Math.round(window.innerWidth - main.right),
        contentW: Math.round(main.width - 48),
        camAr: box.style.getPropertyValue('--cam-ar') || '',
        camMaxH: box.style.getPropertyValue('--cam-max-h') || '',
        arCss: getComputedStyle(box).aspectRatio,
        objectFit: video ? getComputedStyle(video).objectFit : 'no-video',
        barBottom: Math.round(document.querySelector('.camera-bar').getBoundingClientRect().bottom)
      });
    })()
  `));
  console.log('  实测 ' + JSON.stringify(geo));

  ok('.main 右侧留白 ≤2px（实机）', Math.abs(geo.mainRightGap) <= 2, String(geo.mainRightGap));
  const expectDual = geo.innerWidth >= 1440 && geo.innerHeight >= 780;
  ok('.capture-layout 解析为 ' + (expectDual ? '双栏' : '单列') + '（实机 ' + geo.colCount + ' 列）',
    geo.colCount === (expectDual ? 2 : 1), geo.cols.join(' | '));
  const ratio = geo.boxW / geo.contentW;
  ok('取景区占内容宽 ' + Math.round(ratio * 1000) / 1000 + ' ≥ ' + (expectDual ? '0.65' : '0.90'),
    expectDual ? ratio >= 0.65 : ratio >= 0.90, String(ratio));
  ok('video object-fit == contain', geo.objectFit === 'contain', geo.objectFit);
  // 未取到流时 --cam-ar 应为模板兜底的 '4 / 3'（不得为空串，否则整条声明失效）
  ok('--cam-ar 恒为合法值（未取到流时为兜底 4 / 3）', geo.camAr === '4 / 3', JSON.stringify(geo.camAr));
  ok('aspect-ratio 计算值 == --cam-ar', geo.arCss === '4 / 3', geo.arCss);
  ok('--cam-max-h 已被 measureCameraMaxH() 写入 px 值', /^\d+px$/.test(geo.camMaxH), JSON.stringify(geo.camMaxH));
  ok('取景区高度 ≤ --cam-max-h 且 ≥300px',
    geo.boxH <= parseInt(geo.camMaxH, 10) + 2 && geo.boxH >= 300, geo.boxH + ' vs ' + geo.camMaxH);
  ok('.camera-bar 底边落在首屏内（无需滚动即可操作）', geo.barBottom <= geo.innerHeight + 2,
    geo.barBottom + ' vs ' + geo.innerHeight);

  // ---------- measureCameraMaxH 重算：最大化 → 还原 → 手动 resize ----------
  const maxH1 = geo.camMaxH;
  win.unmaximize();
  await sleep(600);
  const maxH2 = await js('document.querySelector(".camera-box").style.getPropertyValue("--cam-max-h")');
  ok('还原窗口后 --cam-max-h 被重算（' + maxH1 + ' → ' + maxH2 + '）', maxH2 !== maxH1, maxH1 + ' / ' + maxH2);
  win.setBounds({ x: 0, y: 0, width: 1300, height: 700 });
  await sleep(700);
  const maxH3 = await js('document.querySelector(".camera-box").style.getPropertyValue("--cam-max-h")');
  ok('手动 resize 后 --cam-max-h 再次重算（→ ' + maxH3 + '）', maxH3 !== maxH2, maxH2 + ' / ' + maxH3);
  const barOk = await js(`
    (function () {
      var bar = document.querySelector('.camera-bar');
      var box = document.querySelector('.camera-box');
      return JSON.stringify({
        barBottom: Math.round(bar.getBoundingClientRect().bottom),
        boxH: Math.round(box.getBoundingClientRect().height),
        innerHeight: window.innerHeight
      });
    })()
  `);
  const b = JSON.parse(barOk);
  ok('resize 后 .camera-bar 仍在首屏内且取景区 ≥300px',
    b.barBottom <= b.innerHeight + 2 && b.boxH >= 300, JSON.stringify(b));
  win.maximize();
  await sleep(600);
  const maxH4 = await js('document.querySelector(".camera-box").style.getPropertyValue("--cam-max-h")');
  ok('重新最大化后 --cam-max-h 回到最大化态的值（' + maxH1 + ' → ' + maxH4 + '）',
    maxH4 === maxH1, maxH1 + ' / ' + maxH4);
}

// CAM_ERR_UI 的全部标题（用于校验「渲染出来的标题一定来自这张表」）。
// 从 renderer/renderer.js 实时抽取，避免脚本里再抄一份导致两边漂移。
const CAM_ERR_TITLES = (() => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const out = [];
  const re = /title:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
})();

async function phaseD() {
  console.log('\n=== D 拍照页错误态（驱动真实 UI）===');
  // 组一：fatal 错误，controller 立即置 ERROR，可精确断言标题与按钮组合。
  //   （可重试错误会被 controller 自动重连 5 次后落到 RETRY_EXHAUSTED，
  //     无法稳定映射到注入的那个 code，故只做「最终态契约」断言，见组二。）
  const FATAL = [
    { code: 'PERMISSION_DENIED', name: 'NotAllowedError', want: ['去系统设置开启摄像头', '重试'], hide: [] },
    { code: 'NO_DEVICE', name: 'NotFoundError', want: ['重试'], hide: ['去系统设置开启摄像头'] },
    { code: 'SECURITY', name: 'SecurityError', want: [], hide: ['重试', '去系统设置开启摄像头'] },
    { code: 'UNSUPPORTED', name: '__UNSUPPORTED__', want: [], hide: ['重试', '去系统设置开启摄像头'] }
  ];
  // 组二：recoverable 错误（自动重连耗尽后的最终态）
  const RECOVERABLE = ['NotReadableError', 'OverconstrainedError', 'NotSupportedError'];

  for (const c of FATAL) {
    // controller 在 CapturePage setup() 里把 navigator.mediaDevices 快照进配置，
    // 挂载后再替换 navigator.mediaDevices 对已存在的 controller 无效 ——
    // 因此每个用例都必须「先注入 → 再切走 → 切回」强制重新挂载，让新桩生效。
    await injectGumFailure(c.name);
    await clickNav('首页');
    await sleep(600);
    await clickNav('拍照');
    await sleep(600);
    const st = await waitFor(async () => {
      const s = await readCameraOverlay();
      return s.ok && s.isError && s.title ? s : null;
    }, 15000, 400);
    if (!st) {
      const dbg = await js(`
        JSON.stringify({
          mdType: typeof navigator.mediaDevices,
          gum: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
          title: ((document.querySelector('.camera-overlay-title') || {}).textContent || '').trim(),
          isError: !!(document.querySelector('.camera-overlay') || {}).classList &&
                   document.querySelector('.camera-overlay').classList.contains('error'),
          hasBox: !!document.querySelector('.camera-box')
        })
      `);
      ok('错误码 ' + c.code + ' 驱动出错误态 UI', false, '覆盖层未进入 error 态，诊断 ' + dbg);
      continue;
    }
    const joined = (st.title + st.sub).replace(/\s/g, '');
    console.log('  · ' + c.code + '：标题「' + st.title + '」次级「' + st.sub + '」按钮 ' + JSON.stringify(st.actions));
    ok(c.code + '：标题非空', st.title.length >= 6, st.title);
    ok(c.code + '：主+次级说明合计 ≥20 字', joined.length >= 20, st.title + ' | ' + st.sub);
    ok(c.code + '：次级说明含可执行动作词',
      /重试|检查|关闭|确认|联系|换|允许|开启|升级|保存/.test(st.sub), st.sub);
    ok(c.code + '：标题来自 CAM_ERR_UI 表', CAM_ERR_TITLES.indexOf(st.title) >= 0, st.title);
    for (const w of c.want) {
      ok(c.code + '：出现「' + w + '」按钮', st.actions.indexOf(w) >= 0, JSON.stringify(st.actions));
    }
    for (const h of c.hide) {
      ok(c.code + '：不出现「' + h + '」', st.actions.indexOf(h) < 0, JSON.stringify(st.actions));
    }
  }

  for (const name of RECOVERABLE) {
    await injectGumFailure(name);
    await clickNav('首页');
    await sleep(600);
    await clickNav('拍照');
    await sleep(600);
    // 自动重连 backoff 400/800/1600/3200ms × 最多 5 次，最长约 6s 后落到 ERROR
    const st = await waitFor(async () => {
      const s = await readCameraOverlay();
      return s.ok && s.isError && s.title ? s : null;
    }, 25000, 500);
    if (!st) {
      ok('可重试错误（' + name + '）最终落到可见 ERROR 态（不卡在「准备中」）', false, '25s 内未进入 error 态');
      continue;
    }
    const joined = (st.title + st.sub).replace(/\s/g, '');
    console.log('  · 可重试 ' + name + ' → 最终态「' + st.title + '」次级「' + st.sub + '」按钮 ' + JSON.stringify(st.actions));
    ok('可重试错误（' + name + '）最终落到可见 ERROR 态（不卡在「准备中」）', true);
    ok('可重试错误最终态标题来自 CAM_ERR_UI 表', CAM_ERR_TITLES.indexOf(st.title) >= 0, st.title);
    ok('可重试错误最终态主+次 ≥20 字', joined.length >= 20, st.title + ' | ' + st.sub);
    ok('可重试错误最终态仍给出「重试」入口', st.actions.indexOf('重试') >= 0, JSON.stringify(st.actions));
  }
}

// 1×1 PNG：addRecord 校验 imageData 必须以 data:image/ 开头，其余不做解码校验
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wFbBQAAAAAASUVORK5CYII=';

/**
 * 造 3 个订单 / 5 张照片（createdAt 由 store 取当前时间，必落在「近 7 天」窗口内）。
 * 刻意用两个不同门店的拍照账号录入：
 *   门店选项 >1 时模板才会渲染「所属门店」下拉，录入人下拉也才有 >1 个选项，
 *   否则筛选条永远只有 2 个字段，门店筛选这条路径测不到。
 */
async function seedWeeklyData() {
  const plan = [
    { user: 'cap_smoke', pwd: 'pwd123456', rows: [
      { barcode: 'B001', note: '正常清洗' },
      { barcode: 'B001', note: '袖口油渍' },
      { barcode: 'B001', note: '' }
    ] },
    { user: 'cap_b', pwd: 'pwd123456', rows: [
      { barcode: 'B002', note: '分店单' },
      { barcode: 'B003', note: '手洗' }
    ] }
  ];
  const out = [];
  for (const blk of plan) {
    const lg = await js(`
      window.api.login(${JSON.stringify(blk.user)}, ${JSON.stringify(blk.pwd)})
        .then(function (r) { return JSON.stringify(r.ok ? { ok: true, token: r.data.sessionToken } : r); })
    `);
    const l = JSON.parse(lg);
    if (!l.ok) { out.push({ ok: false, message: '登录失败 ' + blk.user }); continue; }
    for (const row of blk.rows) {
      const r = await js(`
        window.api.addRecord(${JSON.stringify(l.token)}, {
          barcode: ${JSON.stringify(row.barcode)},
          note: ${JSON.stringify(row.note)},
          imageData: ${JSON.stringify(TINY_PNG)}
        }).then(function (r) { return JSON.stringify({ ok: !!r.ok, message: r.message || '' }); })
          .catch(function (e) { return JSON.stringify({ ok: false, message: String(e && e.message || e) }); })
      `);
      out.push(JSON.parse(r));
    }
  }
  return out;
}

async function phaseE() {
  console.log('\n=== E 本周订单页筛选条与导出按钮 ===');
  await relogin('admin', 'admin123');
  const lg = await ipcToken();
  if (!lg.ok) { ok('取得 IPC 会话令牌', false, JSON.stringify(lg)); return null; }
  const token = lg.token;
  console.log('  IPC 令牌账号：qa_admin（独立会话，不会顶掉界面的 admin 会话）');

  const seeded = await seedWeeklyData();
  ok('本周订单测试数据写入成功（5 张 / 3 个订单）',
    seeded.filter((x) => x.ok).length === 5, JSON.stringify(seeded));
  await clickNav('本周订单');
  const ready = await waitFor(async () => js('!!document.querySelector(".weekly-summary")'), 15000);
  if (!ready) {
    const diag = await js(`
      JSON.stringify({
        h2: (document.querySelector('.page-head h2') || {}).textContent || '',
        emptyTitle: (document.querySelector('.empty-title') || {}).textContent || '',
        emptyDesc: (document.querySelector('.empty-desc') || {}).textContent || '',
        navs: [...document.querySelectorAll('.nav-item')].map(function (b) { return (b.textContent || '').trim(); })
      })
    `);
    console.log('  诊断 ' + diag);
  }
  ok('本周订单页 .weekly-summary 已渲染', !!ready, String(ready));
  if (!ready) return token;
  await sleep(800);

  const wk = JSON.parse(await js(`
    (function () {
      var summary = document.querySelector('.weekly-summary');
      var filter = document.querySelector('.weekly-filter');
      var btn = summary.querySelector('.weekly-export button');
      var sel = summary.querySelector('.weekly-export select');
      var wrap = document.querySelector('.table-wrap');
      var rows = document.querySelectorAll('.table-wrap tbody tr');
      var head = document.querySelector('.page-head p');
      var sr = summary.getBoundingClientRect();
      var wr = wrap ? wrap.getBoundingClientRect() : null;
      return JSON.stringify({
        subtitle: head ? head.textContent : '',
        btnText: btn ? btn.textContent.trim() : '',
        btnDisabled: btn ? btn.disabled : null,
        btnTitle: btn ? btn.title : '',
        hasModeSelect: !!sel,
        modeOptions: sel ? [...sel.options].map(function (o) { return o.value; }) : [],
        filterFields: filter ? filter.querySelectorAll('input, select').length : 0,
        hasReset: !!(filter && [...filter.querySelectorAll('button')].some(function (b) { return (b.textContent || '').indexOf('重置') >= 0; })),
        exportBtnCount: summary.querySelectorAll('.weekly-export button').length,
        tableRows: rows.length,
        summaryText: summary.textContent.replace(/\\s+/g, ' ').trim().slice(0, 120),
        btnRight: btn ? Math.round(btn.getBoundingClientRect().right) : null,
        wrapRight: wr ? Math.round(wr.right) : null,
        // 右对齐的基准是「汇总行的内容盒右缘」= 汇总行外框右缘 − padding-right，
        // 拿外框比会恒差 16px（padding），那是正确表现而非缺陷
        summaryContentRight: Math.round(sr.right - parseFloat(getComputedStyle(summary).paddingRight || '0')),
        summaryH: Math.round(sr.height)
      });
    })()
  `));
  console.log('  实测 ' + JSON.stringify(wk));

  ok('副标题已不再写「不导出任何文件」', wk.subtitle.indexOf('不导出') < 0, wk.subtitle);
  ok('导出主按钮仅 1 个', wk.exportBtnCount === 1, String(wk.exportBtnCount));
  ok('提供「聚合 / 明细」模式下拉', wk.hasModeSelect && wk.modeOptions.join(',') === 'summary,detail',
    JSON.stringify(wk.modeOptions));
  ok('筛选条含关键词/录入人/门店输入项（≥3，门店下拉在门店数 >1 时出现）',
    wk.filterFields >= 3, String(wk.filterFields));
  ok('筛选条含「重置筛选」', wk.hasReset);
  ok('有数据时导出按钮可用', wk.btnDisabled === false, String(wk.btnDisabled));
  ok('表格行数与聚合订单数一致（3）', wk.tableRows === 3, String(wk.tableRows));
  ok('导出按钮右缘与汇总行内容盒右缘对齐 ≤2px（右对齐生效）',
    wk.btnRight !== null && Math.abs(wk.btnRight - wk.summaryContentRight) <= 2,
    wk.btnRight + ' vs ' + wk.summaryContentRight);

  // ---------- 关键词筛选：页面条数与导出条数必须一致 ----------
  await js(`
    (function () {
      var inp = document.querySelector('.weekly-filter input');
      inp.value = 'B00';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(500);
  const all = JSON.parse(await js(`
    (function () {
      var rows = document.querySelectorAll('.table-wrap tbody tr');
      var btn = document.querySelector('.weekly-export button');
      var sum = document.querySelector('.weekly-summary').textContent.replace(/\\s+/g,' ');
      return JSON.stringify({ rows: rows.length, btnText: btn ? btn.textContent.trim() : '', sum: sum.slice(0,120) });
    })()
  `));
  console.log('  关键词「B00」后 ' + JSON.stringify(all));
  ok('关键词筛选后表格行数仍为 3（B001/B002/B003 均含 B00）', all.rows === 3, String(all.rows));
  await js(`
    (function () {
      var inp = document.querySelector('.weekly-filter input');
      inp.value = 'B002';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(500);
  const one = JSON.parse(await js(`
    (function () {
      var rows = document.querySelectorAll('.table-wrap tbody tr');
      var btn = document.querySelector('.weekly-export button');
      return JSON.stringify({ rows: rows.length, btnText: btn ? btn.textContent.trim() : '' });
    })()
  `));
  console.log('  关键词「B002」后 ' + JSON.stringify(one));
  ok('关键词收窄后表格行数 == 1', one.rows === 1, String(one.rows));
  ok('按钮文案随筛选结果变化为「导出筛选结果（1）」',
    one.btnText.indexOf('导出筛选结果（1）') >= 0, one.btnText);

  // ---------- 门店 / 录入人 下拉筛选 ----------
  await js(`
    (function () {
      var inp = document.querySelector('.weekly-filter input');
      inp.value = '';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      var sels = [...document.querySelectorAll('.weekly-filter select')];
      // 第二个 select 是「所属门店」（第一个是录入人）
      var st = sels[1];
      st.value = '分店';
      st.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(500);
  const byStore = JSON.parse(await js(`
    (function () {
      var rows = document.querySelectorAll('.table-wrap tbody tr');
      var btn = document.querySelector('.weekly-export button');
      return JSON.stringify({
        rows: rows.length, btnText: btn ? btn.textContent.trim() : '',
        codes: [...rows].map(function (r) { return (r.querySelector('.barcode-jump') || {}).textContent || ''; })
      });
    })()
  `));
  console.log('  门店=分店 后 ' + JSON.stringify(byStore));
  ok('门店筛选「分店」后只剩该门店的 2 个订单', byStore.rows === 2, String(byStore.rows));
  ok('门店筛选结果与数据归属一致（集合 == B002/B003，表格按末拍倒序故不比顺序）',
    byStore.codes.slice().sort().join(',') === 'B002,B003', byStore.codes.join(','));

  // ---------- 空结果：按钮必须禁用 ----------
  await js(`
    (function () {
      var inp = document.querySelector('.weekly-filter input');
      inp.value = '不存在的条码zzz';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(500);
  const empty = JSON.parse(await js(`
    (function () {
      var btn = document.querySelector('.weekly-export button');
      var sel = document.querySelector('.weekly-export select');
      return JSON.stringify({
        disabled: btn ? btn.disabled : null,
        title: btn ? btn.title : '',
        selDisabled: sel ? sel.disabled : null
      });
    })()
  `));
  ok('无匹配数据时导出按钮禁用', empty.disabled === true, String(empty.disabled));
  ok('禁用时给出可读的 title 说明', /没有数据|无法导出/.test(empty.title), empty.title);
  ok('无匹配数据时模式下拉也禁用', empty.selDisabled === true, String(empty.selDisabled));

  // ---------- busy 互斥锁：点一次 → 确认弹窗期间按钮禁用（防并发弹两个目录框）----------
  await js(`
    (function () {
      var btn = [...document.querySelectorAll('.btn-ghost')].find(function (b) { return (b.textContent||'').indexOf('重置') >= 0; });
      if (btn) btn.click();
      return true;
    })()
  `);
  await sleep(400);
  const beforeClick = await js('(function(){var b=document.querySelector(".weekly-export button");return JSON.stringify({disabled:b.disabled});})()');
  ok('重置筛选后按钮恢复可用', JSON.parse(beforeClick).disabled === false, beforeClick);
  await js('(function(){var b=document.querySelector(".weekly-export button");b.click();return true;})()');
  await sleep(700);
  const during = JSON.parse(await js(`
    (function () {
      var mask = document.querySelector('.modal-mask');
      var btn = document.querySelector('.weekly-export button');
      var sel = document.querySelector('.weekly-export select');
      return JSON.stringify({
        hasConfirm: !!mask,
        disabled: btn ? btn.disabled : null,
        selDisabled: sel ? sel.disabled : null,
        title: btn ? btn.title : ''
      });
    })()
  `));
  console.log('  确认弹窗期间 ' + JSON.stringify(during));
  ok('点击导出后弹出确认框', during.hasConfirm === true, String(during.hasConfirm));
  ok('确认框期间导出按钮被 confirming 锁禁用（防并发弹两个目录框）',
    during.disabled === true, String(during.disabled));
  ok('确认框期间模式下拉也被禁用', during.selDisabled === true, String(during.selDisabled));
  ok('忙碌时按钮 title 提示「导出进行中…」', /导出进行中/.test(during.title), during.title);
  // 取消确认框并复位
  await js(`
    (function () {
      var btns = [...document.querySelectorAll('.modal-foot button')];
      var cancel = btns.find(function (b) { return /取消|关闭/.test((b.textContent || '').trim()); });
      if (cancel) cancel.click();
      return true;
    })()
  `);
  await sleep(600);
  const after = await js('(function(){var b=document.querySelector(".weekly-export button");return JSON.stringify({disabled:b.disabled});})()');
  ok('取消确认框后按钮锁已复位', JSON.parse(after).disabled === false, after);
  return token;
}

async function phaseF(token) {
  console.log('\n=== F 服务端模式导出（真实 IPC 往返）===');
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const today = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  const weekAgo = new Date(d.getTime() - 6 * 86400000);
  const from = weekAgo.getFullYear() + '-' + p(weekAgo.getMonth() + 1) + '-' + p(weekAgo.getDate());

  const raw = await js(`
    window.api.exportWeeklyOrders(${JSON.stringify(token)}, {
      targetDir: ${JSON.stringify(EXPORT_DIR)},
      dateFrom: ${JSON.stringify(from)},
      dateTo: ${JSON.stringify(today)},
      mode: 'summary',
      filters: {}
    }).then(function (r) { return JSON.stringify(r); }).catch(function (e) { return JSON.stringify({ ok: false, message: String(e && e.message || e) }); })
  `);
  const res = JSON.parse(raw);
  console.log('  ' + JSON.stringify(res).slice(0, 300));
  ok('服务端模式导出成功返回', res.ok === true, res.message);
  ok('返回 logged === true（服务端模式写操作日志）', res.data && res.data.logged === true, JSON.stringify(res.data && res.data.logged));
  ok('返回 3 个订单 / 5 张照片', res.data && res.data.orders === 3 && res.data.photos === 5,
    res.data ? res.data.orders + '/' + res.data.photos : 'n/a');
  ok('CSV 文件名形如 本周订单_<from>_至_<to>.csv',
    !!res.data && path.basename(res.data.csvPath) === '本周订单_' + from + '_至_' + today + '.csv',
    res.data && path.basename(res.data.csvPath));
  if (res.data && fs.existsSync(res.data.csvPath)) {
    const buf = fs.readFileSync(res.data.csvPath);
    ok('落盘 CSV 带 UTF-8 BOM', buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf);
    const text = buf.toString('utf8');
    const lines = text.split('\r\n');
    ok('落盘 CSV 使用 CRLF 换行', lines.length >= 2 && text.indexOf('\r\n') > 0);
    ok('表头为聚合 8 列',
      lines[0].replace('\ufeff', '').indexOf('"条形码（订单号）","照片张数","首拍时间","末拍时间","录入人","所属门店","备注","照片文件夹位置"') === 0,
      lines[0].slice(0, 120));
    ok('第 8 列为绝对路径（服务端模式拼照片根目录）',
      lines[1].indexOf(PHOTO_DIR) >= 0, lines[1].slice(0, 200));
  } else {
    ok('导出的 CSV 文件已落盘', false, res.data && res.data.csvPath);
  }

  // 明细模式
  const raw2 = await js(`
    window.api.exportWeeklyOrders(${JSON.stringify(token)}, {
      targetDir: ${JSON.stringify(EXPORT_DIR)},
      dateFrom: ${JSON.stringify(from)},
      dateTo: ${JSON.stringify(today)},
      mode: 'detail',
      filters: {}
    }).then(function (r) { return JSON.stringify(r); }).catch(function (e) { return JSON.stringify({ ok: false, message: String(e && e.message || e) }); })
  `);
  const res2 = JSON.parse(raw2);
  ok('明细模式导出成功返回', res2.ok === true, res2.message);
  if (res2.ok) {
    const text = fs.readFileSync(res2.data.csvPath).toString('utf8');
    ok('明细表头为 9 列',
      text.replace('\ufeff', '').split('\r\n')[0].indexOf('"条形码（订单号）","序号（第几张）","拍摄时间","照片文件名","照片相对路径","录入人","所属门店","备注","记录 ID"') === 0,
      text.split('\r\n')[0].slice(0, 140));
    ok('明细数据行 == 5（照片数）', res2.data.photos === 5, String(res2.data.photos));
  }

  // 空区间 → 业务文案而非「接口不存在」
  const raw3 = await js(`
    window.api.exportWeeklyOrders(${JSON.stringify(token)}, {
      targetDir: ${JSON.stringify(EXPORT_DIR)},
      dateFrom: '2000-01-01', dateTo: '2000-01-02', mode: 'summary', filters: {}
    }).then(function (r) { return JSON.stringify(r); }).catch(function (e) { return JSON.stringify({ ok: false, message: String(e && e.message || e) }); })
  `);
  const res3 = JSON.parse(raw3);
  ok('空区间返回确定业务文案（不是「接口不存在」）',
    res3.ok === false && res3.message === '当前筛选条件下没有订单，无法导出', res3.message);

  // 门店账号按 canViewRecord 裁剪：cap_smoke（总店）看不到分店的 B002/B003
  const scoped = JSON.parse(await js(`
    window.api.login('cap_smoke', 'pwd123456').then(function (lg) {
      if (!lg.ok) return JSON.stringify(lg);
      return window.api.exportWeeklyOrders(lg.data.sessionToken, {
        targetDir: ${JSON.stringify(EXPORT_DIR)},
        dateFrom: ${JSON.stringify(from)}, dateTo: ${JSON.stringify(today)}, mode: 'summary', filters: {}
      }).then(function (r) { return JSON.stringify(r); });
    }).catch(function (e) { return JSON.stringify({ ok: false, message: String(e && e.message || e) }); })
  `));
  console.log('  门店账号导出 ' + JSON.stringify(scoped).slice(0, 200));
  ok('门店账号导出按可见范围裁剪（只 1 个订单 / 3 张照片）',
    scoped.ok === true && scoped.data.orders === 1 && scoped.data.photos === 3,
    scoped.ok ? scoped.data.orders + '/' + scoped.data.photos : scoped.message);
  if (scoped.ok) {
    const txt = fs.readFileSync(scoped.data.csvPath).toString('utf8');
    ok('裁剪后 CSV 中不含跨门店数据（B002/B003）',
      txt.indexOf('B002') < 0 && txt.indexOf('B003') < 0, txt.split('\r\n')[1] || '');
  }

  // 无效令牌：统一走 handle() 的异常转换，返回 ok:false 而不是崩溃
  const bogus = JSON.parse(await js(`
    window.api.exportWeeklyOrders('bogus-token-xyz', {
      targetDir: ${JSON.stringify(EXPORT_DIR)},
      dateFrom: ${JSON.stringify(from)}, dateTo: ${JSON.stringify(today)}, mode: 'summary', filters: {}
    }).then(function (r) { return JSON.stringify(r); })
      .catch(function (e) { return JSON.stringify({ ok: false, message: String(e && e.message || e) }); })
  `));
  ok('无效令牌导出被拒（ok:false + 明确文案，不是崩溃 / 不是「接口不存在」）',
    bogus.ok === false && /未登录|会话/.test(bogus.message || ''), JSON.stringify(bogus).slice(0, 200));
  return { from, today };
}

async function phaseG(range) {
  console.log('\n=== G 客户端模式导出（cfg.mode === "client"）===');
  const mode = await js(`
    window.api.setMode('client')
      .then(function () { return window.api.setClientConfig('http://127.0.0.1:9/', 'test-token'); })
      .then(function () { return window.api.login('qa_admin', 'pwd123456'); })
      .then(function (r) { return JSON.stringify({ ok: !!r.ok, offline: !!r.offline }); })
      .catch(function (e) { return JSON.stringify({ ok: false, message: String(e && e.message || e) }); })
  `);
  const m = JSON.parse(mode);
  console.log('  切换到客户端模式并登录：' + JSON.stringify(m));
  ok('客户端模式下可登录（服务器不可达时降级为离线会话）', m.ok === true, JSON.stringify(m));
  if (!m.ok) return;

  const cli = JSON.parse(await js(`
    window.api.login('qa_admin', 'pwd123456').then(function (lg) {
      if (!lg.ok) return JSON.stringify(lg);
      return window.api.exportWeeklyOrders(lg.data.sessionToken, {
        targetDir: ${JSON.stringify(EXPORT_DIR)},
        dateFrom: ${JSON.stringify(range.from)},
        dateTo: ${JSON.stringify(range.today)},
        mode: 'summary',
        filters: {}
      }).then(function (r) { return JSON.stringify(r); });
    }).catch(function (e) { return JSON.stringify({ ok: false, message: String(e && e.message || e) }); })
  `));
  console.log('  客户端导出 ' + JSON.stringify(cli).slice(0, 300));
  ok('客户端模式导出成功返回', cli.ok === true, cli.message);
  ok('客户端模式 logged === false（不写服务端操作日志）',
    cli.data && cli.data.logged === false, JSON.stringify(cli.data && cli.data.logged));
  if (cli.ok) {
    const text = fs.readFileSync(cli.data.csvPath).toString('utf8');
    const lines = text.split('\r\n');
    ok('客户端模式列名 / 列数与服务端完全一致',
      lines[0].replace('\ufeff', '').indexOf('"条形码（订单号）","照片张数","首拍时间","末拍时间","录入人","所属门店","备注","照片文件夹位置"') === 0,
      lines[0].slice(0, 120));
    ok('客户端模式第 8 列为相对目录（不含本机照片根目录）',
      lines[1].indexOf(PHOTO_DIR) < 0, lines[1].slice(0, 200));
  }

  // ---------- 超大数据量保护（>20000）----------
  const recPath = path.join(DATA_DIR, 'records.json');
  const big = [];
  for (let i = 0; i < 20001; i++) {
    big.push({
      id: 'big' + i,
      barcode: 'X' + String(i).padStart(6, '0'),
      seq: 1,
      userId: 'u1',
      username: 'admin',
      storeName: '总店',
      note: '',
      photoFile: 'X' + String(i).padStart(6, '0') + '/a.jpg',
      createdAt: new Date().toISOString()
    });
  }
  fs.writeFileSync(recPath, JSON.stringify(big));
  const bigRes = JSON.parse(await js(`
    window.api.login('qa_admin', 'pwd123456').then(function (lg) {
      if (!lg.ok) return JSON.stringify(lg);
      return window.api.exportWeeklyOrders(lg.data.sessionToken, {
        targetDir: ${JSON.stringify(EXPORT_DIR)},
        dateFrom: ${JSON.stringify(range.from)},
        dateTo: ${JSON.stringify(range.today)},
        mode: 'summary',
        filters: {}
      }).then(function (r) { return JSON.stringify(r); });
    }).catch(function (e) { return JSON.stringify({ ok: false, message: String(e && e.message || e) }); })
  `));
  console.log('  >20000 条时 ' + JSON.stringify(bigRes).slice(0, 200));
  ok('超过 20000 条时被拒绝并给出明确提示',
    bigRes.ok === false && /数据量过大/.test(bigRes.message || ''), JSON.stringify(bigRes.message));
  try { fs.unlinkSync(recPath); } catch (e) { /* 忽略 */ }

  // 切回服务端模式，避免影响后续手工验证
  await js("window.api.setMode('server').catch(function(){})");
}

async function run() {
  // 预置配置：直接以服务端模式启动，跳过首次运行的「选择模式」向导
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
    mode: 'server', port: 17599, token: 'smoke-token',
    photoDir: PHOTO_DIR, serverUrl: '', serverToken: ''
  }));
  fs.mkdirSync(PHOTO_DIR, { recursive: true });

  win = await waitFor(async () => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
    return w || null;
  }, 25000);
  if (!win) throw new Error('未拿到主窗口（主进程未创建 BrowserWindow）');
  await waitFor(async () => {
    try { return await js('!!document.getElementById("app")'); } catch (e) { return false; }
  }, 25000);
  await sleep(1500);

  await phaseA();
  await phaseB();
  await phaseB2();
  await phaseC();
  await phaseD();
  const token = await phaseE();
  let range = null;
  if (token) range = await phaseF(token);
  if (range) await phaseG(range);
}

app.setPath('userData', USER_DATA);
require('../main/main.js');

app.whenReady().then(async () => {
  try {
    await run();
  } catch (e) {
    console.error('执行失败：' + (e && e.stack ? e.stack : e));
    fail++;
    failures.push('执行异常：' + (e && e.message));
  }
  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  if (failures.length) {
    console.log('\n失败明细：');
    failures.forEach((f) => console.log('  - ' + f));
  }
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ }
  app.quit();
  process.exit(fail ? 1 : 0);
});
