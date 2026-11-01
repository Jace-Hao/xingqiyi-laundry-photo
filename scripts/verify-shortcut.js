'use strict';
// 空格拍照快捷键：目标判定纯函数回归测试 + 变异负向对照
// 运行：node scripts/verify-shortcut.js
const path = require('path');
const helper = require(path.join(__dirname, '..', 'renderer', 'shortcut-helper.js'));
const isSpaceCaptureTarget = helper.isSpaceCaptureTarget;

let pass = 0;
let fail = 0;
const fails = [];
function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; fails.push(name); }
}

// ---- 构造假 DOM 元素（仅实现判定所需的最小接口）----
function el(tag, opts) {
  opts = opts || {};
  return {
    tagName: String(tag).toUpperCase(),
    isContentEditable: !!opts.contentEditable,
    _type: (opts.type || '').toLowerCase(),
    getAttribute(name) { return name === 'type' ? this._type : null; }
  };
}
const barcodeEl = el('input', { type: 'text' });

// ---- P 组：正向断言（期望的契约行为）----
check('P1 亮度滑块(range)获焦→拍照', isSpaceCaptureTarget(el('input', { type: 'range' }), barcodeEl) === true);
check('P2 下拉(select)获焦→拍照', isSpaceCaptureTarget(el('select'), barcodeEl) === true);
check('P3 按钮(button)获焦→拍照', isSpaceCaptureTarget(el('button'), barcodeEl) === true);
check('P4 页面空白(body)→拍照', isSpaceCaptureTarget(el('body'), barcodeEl) === true);
check('P5 普通div→拍照', isSpaceCaptureTarget(el('div'), barcodeEl) === true);
check('P6 条码框获焦→拍照', isSpaceCaptureTarget(barcodeEl, barcodeEl) === true);
check('P7 备注(textarea)→不拍照', isSpaceCaptureTarget(el('textarea'), barcodeEl) === false);
check('P8 contentEditable→不拍照', isSpaceCaptureTarget(el('div', { contentEditable: true }), barcodeEl) === false);
check('P9 搜索框(search)→不拍照', isSpaceCaptureTarget(el('input', { type: 'search' }), barcodeEl) === false);
check('P10 文本输入框(text)→不拍照', isSpaceCaptureTarget(el('input', { type: 'text' }), barcodeEl) === false);
check('P11 数字框(number)→不拍照', isSpaceCaptureTarget(el('input', { type: 'number' }), barcodeEl) === false);
check('P12 无target→拍照(保守)', isSpaceCaptureTarget(null, barcodeEl) === true);
check('P13 其它文本INPUT非条码框→不拍照', isSpaceCaptureTarget(el('input', { type: 'text' }), barcodeEl) === false);

// ---- Q 组：变异负向对照（把同一组主检断言复跑在变异体上，确认判别力）----
function runMainChecks(fn) {
  const r = [];
  r.push(fn(el('input', { type: 'range' }), barcodeEl) === true);   // P1
  r.push(fn(el('select'), barcodeEl) === true);                     // P2
  r.push(fn(el('button'), barcodeEl) === true);                     // P3
  r.push(fn(el('body'), barcodeEl) === true);                       // P4
  r.push(fn(barcodeEl, barcodeEl) === true);                       // P6
  r.push(fn(el('textarea'), barcodeEl) === false);                 // P7
  r.push(fn(el('input', { type: 'search' }), barcodeEl) === false); // P9
  r.push(fn(el('input', { type: 'text' }), barcodeEl) === false);   // P10
  return r;
}

// Q1 变异：把 range 错当文本型（在文本清单里混入 range），主检应至少一项失败
function mutantTreatRangeAsText(t, be) {
  if (!t) return true;
  if (t.tagName === 'TEXTAREA' || t.isContentEditable) return false;
  if (t.tagName === 'INPUT') {
    if (be && t === be) return true;
    const type = (t.getAttribute && t.getAttribute('type')) || 'text';
    const textLike = ['text', 'search', 'email', 'url', 'tel', 'number', 'password', 'range'].indexOf(type) >= 0;
    return !textLike;
  }
  return true;
}

// Q2 变异：任何 INPUT 都不拍照（含条码框），主检应至少一项失败
function mutantNoInputCapture(t) {
  if (!t) return true;
  if (t.tagName === 'TEXTAREA' || t.isContentEditable) return false;
  if (t.tagName === 'INPUT') return false;
  return true;
}

const real = runMainChecks(isSpaceCaptureTarget);
check('Q-real 主检实现全绿', real.every(Boolean));
check('Q1 变异(range当文本)被主检抓到', !runMainChecks(mutantTreatRangeAsText).every(Boolean));
check('Q2 变异(INPUT全不拍)被主检抓到', !runMainChecks(mutantNoInputCapture).every(Boolean));

console.log('verify-shortcut: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) {
  console.error('FAILED: ' + fails.join('; '));
  process.exit(1);
}
console.log('verify-shortcut: ALL GREEN');
