/*
 * verify-confirm-queue.js
 * 验证「通用确认对话框 showConfirm 并发安全」修复：把弹窗从「单例 resolve 覆盖」
 * 改为「FIFO 队列按序弹出」，杜绝第二次调用覆盖 confirmState.resolve 导致前一次
 * await 永久挂死（静默消失）的逻辑缺陷。
 *
 * 本测试以与 renderer/renderer.js 中完全一致的算法实现（确认对话框区域）作契约级
 * 回归守护——renderer.js 在加载时会 app.mount('#app')，无法在纯 Node 下直接 require，
 * 故在此逐行镜像其逻辑；若将来该段逻辑改动，需同步更新此处断言。
 */

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.log('  ✗ ' + msg); }
}

// ---- 以下为 renderer.js 中确认对话框逻辑的逐行镜像 ----
const confirmState = {
  open: false, title: '提示', message: '', confirmText: '确定',
  cancelText: '取消', danger: false, resolve: null
};
const confirmQueue = [];
function flushConfirmQueue() {
  const next = confirmQueue.shift();
  if (!next) return;
  const opts = next.opts || {};
  confirmState.title = opts.title || '提示';
  confirmState.message = opts.message || '';
  confirmState.confirmText = opts.confirmText || '确定';
  confirmState.cancelText = opts.cancelText || '取消';
  confirmState.danger = !!opts.danger;
  confirmState.resolve = next.resolve;
  confirmState.open = true;
}
function showConfirm(opts) {
  return new Promise((resolve) => {
    confirmQueue.push({ opts, resolve });
    if (!confirmState.open) flushConfirmQueue();
  });
}
function close(val) {
  const r = confirmState.resolve;
  confirmState.open = false;
  confirmState.resolve = null;
  if (r) r(val);
  flushConfirmQueue();
}
// ----------------------------------------------------

function reset() {
  confirmQueue.length = 0;
  confirmState.open = false;
  confirmState.title = '提示';
  confirmState.resolve = null;
}

(async () => {
  console.log('=== showConfirm 并发队列验证 ===\n');

  // [1] 单次调用：打开即渲染，关闭后按值解析
  reset();
  console.log('[1] 单次调用解析');
  const p1 = showConfirm({ title: '删除记录' });
  assert(confirmState.open === true, '弹窗已打开');
  assert(confirmState.title === '删除记录', '标题已渲染');
  close(true);
  const r1 = await p1;
  assert(r1 === true, 'Promise 解析为 true');
  assert(confirmState.open === false, '关闭后弹窗收起');

  // [2] 核心回归：弹窗开启时再次调用不得覆盖 resolve（旧缺陷会挂死首个 await）
  reset();
  console.log('[2] 并发调用 FIFO —— 旧缺陷复现对照');
  const a = showConfirm({ title: 'A' });
  assert(confirmState.title === 'A', '首个弹窗渲染 A');
  const b = showConfirm({ title: 'B' }); // 此时弹窗仍开，旧实现会覆盖 resolve
  assert(confirmState.title === 'A', '第二个请求入队，未覆盖当前显示的 A（修复点）');
  assert(confirmState.open === true, '弹窗保持打开');
  // 关闭当前 A
  close(false);
  const ra = await a;
  assert(ra === false, '首个 Promise 解析为 false（未挂死）');
  assert(confirmState.title === 'B', '队列自动弹出下一个 B');
  assert(confirmState.open === true, '下一个弹窗自动打开');
  // 关闭 B，使其 Promise 解析并清空队列（模拟用户关闭第二个弹窗）
  close(false);
  const rb = await b;
  assert(rb === false, '第二个 Promise 也解析（按序）');
  assert(confirmState.open === false, '全部处理完弹窗收起');
  assert(confirmQueue.length === 0, '队列已清空');

  // [3] 三连发：保证按调用顺序解析且互不覆盖
  reset();
  console.log('[3] 三连发顺序解析');
  const c1 = showConfirm({ title: 'C1' });
  const c2 = showConfirm({ title: 'C2' });
  const c3 = showConfirm({ title: 'C3' });
  const order = [];
  c1.then((v) => order.push('C1:' + v));
  c2.then((v) => order.push('C2:' + v));
  c3.then((v) => order.push('C3:' + v));
  close(true);  // 关 C1
  close(true);  // 关 C2
  close(false); // 关 C3
  await Promise.all([c1, c2, c3]);
  assert(order.join(',') === 'C1:true,C2:true,C3:false', '三连发按 FIFO 顺序解析：' + order.join(','));

  // [4] 无挂死守护：任何 await 必须在 200ms 内 resolve（旧缺陷会超时）
  reset();
  console.log('[4] 无挂死守护（超时即失败）');
  const d = showConfirm({ title: 'D' });
  const e = showConfirm({ title: 'E' });
  close(true);
  const guard = await Promise.race([d.then(() => 'ok'), new Promise((res) => setTimeout(() => res('timeout'), 200))]);
  assert(guard === 'ok', '首个 await 在 200ms 内解析（无挂死）');
  close(true);
  await e;

  console.log('\n结果：通过 ' + passed + ' / 失败 ' + failed);
  process.exitCode = failed ? 1 : 0;
})();
