'use strict';

/**
 * 拍照时间水印验证：node scripts/verify-watermark.js
 *
 * canvas 逻辑 node --check 与模板编译都覆盖不到：字号算错会让水印糊成一团，
 * 定位算错会让水印跑出画面外。本脚本从 renderer.js 中**提取真实函数源码**
 * 执行（不是复制一份，避免测了副本却漏掉真实代码的偏差），
 * 用 mock 的 2D context 记录绘制调用，校验几何参数与视觉样式。
 */

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

/** 从源码中按函数名提取完整函数体（含注释之外的全部内容） */
function extractFunction(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('未找到函数 ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i + 1);
}

const fnText = extractFunction('watermarkTimeText') + '\n\n' + extractFunction('drawTimeWatermark');

// 用 Function 构造出真实函数的可调用版本
const factory = new Function(fnText + '\nreturn { watermarkTimeText, drawTimeWatermark };');
const { watermarkTimeText, drawTimeWatermark } = factory();

let pass = 0;
let fail = 0;
const problems = [];
function ck(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    problems.push(name + (extra !== undefined ? ' -> ' + extra : ''));
    console.log('  ✗ ' + name + (extra !== undefined ? ' -> ' + extra : ''));
  }
}

/** 记录调用参数的 mock 2D context */
function mockCtx(textWidthPx, opts) {
  const calls = { font: [], fillStyle: [], rects: [], fillText: [] };
  return {
    calls,
    save() {},
    restore() {},
    beginPath() {},
    fill() {},
    set font(v) {
      calls.font.push(v);
    },
    get font() {
      return calls.font[calls.font.length - 1] || '';
    },
    set textBaseline(v) {},
    set textAlign(v) {},
    measureText(t) {
      return { width: textWidthPx };
    },
    roundRect(x, y, w, h, r) {
      calls.rects.push({ x, y, w, h, r, kind: 'round' });
    },
    rect(x, y, w, h) {
      calls.rects.push({ x, y, w, h, kind: 'plain' });
    },
    set fillStyle(v) {
      calls.fillStyle.push(v);
    },
    fillText(text, x, y) {
      calls.fillText.push({ text, x, y });
    }
  };
}

console.log('=== 拍照时间水印验证 ===');

console.log('\n[1] 时间文本格式');
const d = new Date(2026, 8, 20, 9, 5, 30); // 2026-09-20 09:05:30（本地时区）
ck('格式为 YYYY-MM-DD HH:mm（补零）', watermarkTimeText(d) === '2026-09-20 09:05', watermarkTimeText(d));
const d2 = new Date(2026, 11, 31, 23, 59, 0);
ck('月末与 23:59 正确', watermarkTimeText(d2) === '2026-12-31 23:59', watermarkTimeText(d2));
ck('不传参时返回当前时间字符串', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(watermarkTimeText()));

console.log('\n[2] 字号随分辨率缩放（高分辨率下必须可辨认）');
const cases = [
  { w: 4000, h: 3000, label: '4000×3000 高分辨率' },
  { w: 1920, h: 1080, label: '1920×1080' },
  { w: 1280, h: 720, label: '1280×720' },
  { w: 640, h: 480, label: '640×480 低分辨率' },
  { w: 320, h: 240, label: '320×240 极小' }
];
const TEXT_PX = 120; // measureText 返回的文本宽度（固定，便于比较字号）
for (const c of cases) {
  const ctx = mockCtx(TEXT_PX);
  drawTimeWatermark(ctx, c.w, c.h, '2026-09-20 14:05');
  const fontStr = ctx.calls.font[0] || '';
  const m = fontStr.match(/(\d+(?:\.\d+)?)px/);
  const fontSize = m ? Number(m[1]) : 0;
  const expectApprox = Math.max(12, Math.round(Math.min(c.w, c.h) * 0.022));
  ck(c.label + ' 字号=' + fontSize + 'px', fontSize === expectApprox, '期望 ' + expectApprox);
  ck(c.label + ' 字号 ≥ 12px 可辨认', fontSize >= 12, fontSize);
  ck(c.label + ' 只绘制了一次水印', ctx.calls.fillText.length === 1 && ctx.calls.rects.length === 1);
}

console.log('\n[3] 高分辨率下字号必须明显大于低分辨率（否则等于没缩放）');
const ctxBig = mockCtx(TEXT_PX);
drawTimeWatermark(ctxBig, 4000, 3000, 'X');
const ctxSmall = mockCtx(TEXT_PX);
drawTimeWatermark(ctxSmall, 640, 480, 'X');
const sizeBig = Number(ctxBig.calls.font[0].match(/(\d+)px/)[1]);
const sizeSmall = Number(ctxSmall.calls.font[0].match(/(\d+)px/)[1]);
ck('4000×3000 字号 > 640×480 字号', sizeBig > sizeSmall, sizeBig + ' vs ' + sizeSmall);
ck('高分辨率字号按短边约 2.2%', sizeBig === Math.round(3000 * 0.022), sizeBig);

console.log('\n[4] 水印必须落在画面内且靠右上角');
for (const c of cases) {
  const ctx = mockCtx(TEXT_PX);
  drawTimeWatermark(ctx, c.w, c.h, '2026-09-20 14:05');
  const box = ctx.calls.rects[0];
  const t = ctx.calls.fillText[0];
  ck(c.label + ' 水印框在画面内', box.x >= 0 && box.y >= 0 && box.x + box.w <= c.w && box.y + box.h <= c.h,
    'box=(' + box.x + ',' + box.y + ',' + box.w + ',' + box.h + ') 画面=' + c.w + 'x' + c.h);
  ck(c.label + ' 水印靠右（右边缘贴近画面右边）', box.x + box.w >= c.w - c.w * 0.05, 'x+w=' + (box.x + box.w) + ' 宽=' + c.w);
  ck(c.label + ' 水印靠上（y 在顶部区域内）', box.y <= c.h * 0.1, 'y=' + box.y);
  ck(c.label + ' 文字绘制在水印框内部', t.x >= box.x && t.x <= box.x + box.w && t.y >= box.y && t.y <= box.y + box.h,
    'text=(' + t.x + ',' + t.y + ')');
}

console.log('\n[5] 极端情况：文本极长也不能溢出画面');
const ctxLong = mockCtx(9000); // 文本宽度远大于画面宽度
drawTimeWatermark(ctxLong, 640, 480, 'X'.repeat(200));
const boxLong = ctxLong.calls.rects[0];
ck('超长文本时 x 被钳制为 ≥ 0', boxLong.x >= 0, 'x=' + boxLong.x);
ck('超长文本不会画到负坐标', ctxLong.calls.fillText[0].x >= 0, 'textX=' + ctxLong.calls.fillText[0].x);

console.log('\n[6] 无效入参不抛异常（防御性）');
let threw = false;
try {
  drawTimeWatermark(null, 100, 100, 'X');
  drawTimeWatermark(mockCtx(10), 0, 0, 'X');
  drawTimeWatermark(mockCtx(10), 100, 100, '');
} catch (e) {
  threw = true;
}
ck('无效入参不抛异常', !threw);

console.log('\n[7] 兼容无 roundRect 的老内核（回退直角矩形）');
const ctxNoRound = mockCtx(TEXT_PX);
ctxNoRound.roundRect = undefined; // 模拟老版本 Chromium
drawTimeWatermark(ctxNoRound, 1280, 720, '2026-09-20 14:05');
ck('无 roundRect 时回退用 rect 绘制底框', ctxNoRound.calls.rects.length === 1 && ctxNoRound.calls.rects[0].kind === 'plain',
  JSON.stringify(ctxNoRound.calls.rects[0]));
ck('回退路径下文字仍然绘制', ctxNoRound.calls.fillText.length === 1);

console.log('\n[8] 视觉样式：半透明底 + 白字（深浅色衣物都可读）');
const ctxStyle = mockCtx(TEXT_PX);
drawTimeWatermark(ctxStyle, 1920, 1080, '2026-09-20 14:05');
ck('底框使用半透明黑色', /^rgba\(0, 0, 0, 0\.\d+\)$/.test(ctxStyle.calls.fillStyle[0]), ctxStyle.calls.fillStyle[0]);
ck('文字使用白色', /rgba?\(255, 255, 255/.test(ctxStyle.calls.fillStyle[1]), ctxStyle.calls.fillStyle[1]);
ck('字体指定中文可用字族', /Microsoft YaHei|PingFang SC/.test(ctxStyle.calls.font[0]), ctxStyle.calls.font[0]);

console.log('\n=== 结果 ===');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('失败项：');
  problems.forEach((p) => console.log('  - ' + p));
}
process.exit(fail ? 1 : 0);
