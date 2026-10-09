'use strict';

/**
 * 布局实机验证脚本（临时）——用真实 Chromium（Electron）加载产品真实 styles.css，
 * 在 1366 / 1920 / 2560 / 3440 四种视口下测量 .main / .modal / .modal-sm / .capture-layout。
 * 验证完成后可删除（与 scripts/layout-probe.html 配套）。
 */

const path = require('path');
const { app, BrowserWindow } = require('electron');

const VIEWPORTS = [
  { w: 1366, h: 768, label: '1366×768' },
  { w: 1920, h: 1080, label: '1920×1080' },
  { w: 2560, h: 1440, label: '2560×1440' },
  { w: 3440, h: 1440, label: '3440×1440' },
  { w: 1024, h: 768, label: '1024×768（最小窗口）' }
];

// 期望值全部按「实测 innerWidth / 侧栏实宽」反推，避免窗口边框（16px）与侧栏折叠导致误判。
// 窗口带系统边框，Electron 报告的 innerWidth = 请求宽 − 16；侧栏在 @media(max-width:1023px) 下折叠为 64px。
// 设计文档 §3.1 / §3.2 / §4.1 给出的「标称视口 → 宽度」映射可据此还原：
//   .main 外框宽 = innerWidth − 侧栏实宽
//   .modal 宽   = clamp(680, 0.56·innerWidth, 1200)
//   .modal-sm   = clamp(440, 0.34·innerWidth, 520)
function expectMain(iw, sw) { return iw - sw; }
function expectModal(iw) { return Math.min(1200, Math.max(680, Math.round(iw * 0.56))); }
function expectModalSm(iw) { return Math.min(520, Math.max(440, Math.round(iw * 0.34))); }
const TOL = 3;

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('    ✓ ' + name); }
  else { fail++; console.log('    ✗ ' + name + (extra ? ' —— ' + extra : '')); }
}

async function run() {
  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  await win.loadFile(path.join(__dirname, 'layout-probe.html'));

  for (const v of VIEWPORTS) {
    win.setBounds({ x: 0, y: 0, width: v.w, height: v.h });
    await new Promise((r) => setTimeout(r, 250));
    const m = await win.webContents.executeJavaScript('window.measure()');
    console.log('\n  【' + v.label + '】实际视口 ' + m.innerWidth + '×' + m.innerHeight);
    console.log('    ' + JSON.stringify(m));

    const eMain = expectMain(m.innerWidth, m.sidebarW);
    const eModal = expectModal(m.innerWidth);
    const eModalSm = expectModalSm(m.innerWidth);
    ok('.main 外框宽 == ' + eMain + '（±3）',
      Math.abs(m.mainOuterW - eMain) <= TOL, '实测 ' + m.mainOuterW + '（innerWidth=' + m.innerWidth + ', 侧栏=' + m.sidebarW + '）');
    ok('.main 右侧留白 ≤2px', m.mainRightGap <= 2 && m.mainRightGap >= -2, '实测 ' + m.mainRightGap);
    ok('文档横向无溢出（scrollWidth ≤ innerWidth+2）',
      m.docScrollWidth <= m.innerWidth + 2, m.docScrollWidth + ' vs ' + m.innerWidth);
    ok('.main 自身无横向滚动（宽表格由 .table-wrap 消化）', !m.mainHasHScroll);
    ok('.modal 宽 == ' + eModal + '（±3）',
      Math.abs(m.modalW - eModal) <= TOL, '实测 ' + m.modalW);
    ok('.modal-sm 宽 == ' + eModalSm + '（±3）',
      Math.abs(m.modalSmW - eModalSm) <= TOL, '实测 ' + m.modalSmW);
    ok('.modal 高度 ≤ 88vh', m.modalH <= Math.round(m.innerHeight * 0.88) + 2, m.modalH + ' vs ' + Math.round(m.innerHeight * 0.88));
    ok('.modal 顶 ≥0 且底 ≤视口高（不贴边不被切）',
      m.modalTop >= -1 && m.modalBottom <= m.innerHeight + 1, m.modalTop + '~' + m.modalBottom);
    ok('超高内容由 .modal-body 内部滚动吸收',
      m.modalBodyScrollable && m.modalFootBottom <= m.innerHeight + 1,
      'body滚动=' + m.modalBodyScrollable + ' foot底=' + m.modalFootBottom);
    ok('层叠契约 .lightbox<' + '.modal-mask<' + '.toast 保持 200/300/999',
      m.zLightbox === '200' && m.zMask === '300' && m.zToast === '999',
      [m.zLightbox, m.zMask, m.zToast].join('/'));
    ok('遮罩中心的元素命中测试落在 .modal 子树内（未被灯箱遮住）',
      m.hitInsideModal === true, String(m.hitInsideModal));

    // 卡片集合：窄屏（≤1219px）降级为 2 列，宽屏 3 列；任一项卡片宽都必须在 [300,480]
    const expectStatCols = m.innerWidth <= 1219 ? 2 : 3;
    ok('.stat-row 列数符合断点（≤1219→2 列，否则 3 列）', m.statRowCols === expectStatCols, String(m.statRowCols));
    ok('.stat-row 轨道宽 ∈ [300,480]', m.statTrackW >= 300 && m.statTrackW <= 480, String(m.statTrackW));
    ok('.settings-grid 恒为 2 列', m.settingsCols === 2, String(m.settingsCols));

    // 拍照页
    const expectDual = m.innerWidth >= 1440 && m.innerHeight >= 780;
    ok('.capture-layout ' + (expectDual ? '双栏' : '单列') + '（解析出 ' + m.captureColCount + ' 列）',
      expectDual ? m.captureColCount === 2 : m.captureColCount === 1, m.captureCols.join(' | '));
    if (expectDual) {
      ok('取景区占内容宽 ≥0.65', m.captureRatio >= 0.65, String(m.captureRatio));
      ok('.capture-side ≥320px', parseFloat(m.captureCols[1]) >= 320, String(m.captureCols[1]));
    } else {
      ok('单列时取景区占内容宽 ≥0.90', m.captureRatio >= 0.90, String(m.captureRatio));
    }
    ok('video object-fit 仍为 contain（不变形不裁切）', m.cameraObjectFit === 'contain', m.cameraObjectFit);
    // 声明的 aspect-ratio 必须严格等于 --cam-ar（1280 / 720）；高度裁剪导致的渲染盒比例失真属设计 §4.2 既定取舍，此处不断言。
    ok('取景区声明的 aspect-ratio == --cam-ar（1280 / 720）',
      m.cameraAspectCss === '1280 / 720', m.cameraAspectCss);
    ok('取景区 max-height 已生效（非 none）',
      m.cameraMaxHCss && m.cameraMaxHCss !== 'none' && m.cameraMaxHCss !== 'auto', m.cameraMaxHCss);
  }

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
}

app.whenReady().then(async () => {
  try {
    await run();
  } catch (e) {
    console.error('执行失败：' + (e && e.stack ? e.stack : e));
    fail++;
  }
  app.quit();
});
