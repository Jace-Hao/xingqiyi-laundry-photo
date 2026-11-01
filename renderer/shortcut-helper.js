'use strict';

/* ---------- 快捷键目标判定（纯函数模块） ----------
 * 仅做「空格键是否应触发全局拍照」的纯判定，不引用 Vue / 除参数外任何 DOM 状态。
 * DOM 元素通过参数传入，因此可在 Node 下用假对象单测。
 *
 * 规则（与 renderer.js 的 onKeydown 共享契约）：
 *   R1 自由文本字段（备注 textarea、搜索框等文本型 INPUT）= false：空格按原生输入，不拍照；
 *   R2 条码框（t === barcodeEl）= true：扫码枪场景空格无意义，归入全局拍照；
 *   R3 其余控件（亮度滑块 range / 下拉 select / 按钮 button / 页面空白 body 等）= true：空格一律拍照。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.ShortcutHelper = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null), function () {
  'use strict';

  // 文本型 INPUT 的 type 清单：这些类型空格用于输入字符，不应触发拍照。
  var TEXT_LIKE_TYPES = ['text', 'search', 'email', 'url', 'tel', 'number', 'password'];

  // 判定空格键是否应触发全局拍照。
  //   t         事件 target（获焦的元素）
  //   barcodeEl 条码输入框 DOM 元素（用于识别条码框）；可为空
  // 返回 true=拍照，false=按原生输入处理（不拍照）。
  function isSpaceCaptureTarget(t, barcodeEl) {
    if (!t) return true; // 无 target（理论上不会，保守按「拍照」处理）
    if (t.tagName === 'TEXTAREA' || t.isContentEditable) return false; // R1：备注等文本块
    if (t.tagName === 'INPUT') {
      if (barcodeEl && t === barcodeEl) return true; // R2：条码框
      var type = (t.getAttribute && t.getAttribute('type')) || 'text';
      if (typeof type === 'string') type = type.toLowerCase();
      var textLike = TEXT_LIKE_TYPES.indexOf(type) >= 0;
      return !textLike; // 文本型输入框（搜索等）→ false；range/checkbox 等 → true
    }
    return true; // R3：SELECT / BUTTON / BODY / DIV 等
  }

  return {
    isSpaceCaptureTarget: isSpaceCaptureTarget,
    TEXT_LIKE_TYPES: TEXT_LIKE_TYPES
  };
});
