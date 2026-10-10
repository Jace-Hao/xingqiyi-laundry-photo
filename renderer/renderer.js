'use strict';

/* 星期衣精致洗衣衣物照片系统 · 渲染进程（Vue 3 全局构建，无需构建工具） */

const { createApp } = Vue;

/* ---------- 通用工具 ---------- */
const toastState = { timer: null };

function toast(msg, type) {
  let el = document.getElementById('app-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-toast';
    el.className = 'toast';
    // 读屏器播报：role=status + aria-live=polite（不打断当前输入）。
    // 播报文本必须放在子元素里，且显隐用 classList 切换 —— 整体覆写 className 会抹掉 show 类导致不播报。
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    const span = document.createElement('span');
    el.appendChild(span);
    document.body.appendChild(el);
  }
  const text = el.firstElementChild || el;
  if (text.textContent !== msg) text.textContent = msg;
  el.classList.add('show');
  el.classList.remove('success', 'error', 'warn');
  el.classList.add(type || 'success');
  clearTimeout(toastState.timer);
  toastState.timer = setTimeout(() => {
    el.classList.remove('show');
  }, 2600);
}

/* ---------- 通用确认对话框（替代 window.confirm：按钮可写动词、支持危险态、Esc/Enter/遮罩关闭） ---------- */
// 单例状态：全应用共享同一个确认弹窗。为防止「弹窗未关闭时再次调用 showConfirm 覆盖
// confirmState.resolve，导致前一次 await 永久挂死（静默消失）」，这里用队列保存待确认项，逐个弹出。
const confirmState = Vue.reactive({
  open: false,
  title: '提示',
  message: '',
  confirmText: '确定',
  cancelText: '取消',
  danger: false,
  resolve: null
});

// 等待确认的项队列：每项 { opts, resolve }。并发调用 showConfirm 时入队，按序弹出。
const confirmQueue = [];

// 取队首渲染到 confirmState；队列空则不开弹窗（close 已负责置 open=false）。
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

// 返回 Promise<boolean>：用户点确认解析为 true，取消 / Esc / 点遮罩解析为 false。
// 若弹窗已打开，本次请求进入队列，待当前弹窗关闭后自动弹出，避免覆盖 resolve 导致挂死。
function showConfirm(opts) {
  return new Promise((resolve) => {
    confirmQueue.push({ opts, resolve });
    if (!confirmState.open) flushConfirmQueue();
  });
}

const ConfirmModal = {
  setup() {
    const s = confirmState;
    const confirmBtn = Vue.ref(null);
    const cancelBtn = Vue.ref(null);
    function close(val) {
      const r = s.resolve;
      s.open = false;
      s.resolve = null;
      if (r) r(val);
      // 当前弹窗关闭后立即弹出队列中的下一个待确认项（若有），实现并发确认按序处理。
      flushConfirmQueue();
    }
    function onKey(e) {
      if (!s.open) return;
      // 输入法组字中的 Enter 是「选词确认」，绝不能当作确认弹窗。
      // 与灯箱键盘处理（onKeydown）保持同一套守卫写法。
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(false);
      } else if (e.key === 'Enter') {
        // Enter 必须遵循「激活当前焦点按钮」的原生语义，不能无条件确认。
        // 危险态（danger:true）打开时焦点落在「取消」上，若此处仍 close(true)，
        // 用户看到焦点框在「取消」却执行了删除，视觉提示与实际行为直接矛盾，比不做焦点分流更糟。
        // 焦点在取消按钮上时直接返回，交给该按钮自身的 @click="close(false)" 处理。
        if (e.target === cancelBtn.value) return;
        e.preventDefault();
        e.stopPropagation();
        close(true);
      }
    }
    // keydown 绑在弹窗根节点（.modal-mask）而非 window：
    // 弹窗打开时只接管自身范围内的按键，背后的输入框用中文输入法按 Enter 选词不会误触确认。
    Vue.watch(
      () => s.open,
      (v) => {
        if (v) Vue.nextTick(() => {
          // 危险态（删除类）默认焦点落在「取消」上，Enter 不会直接执行破坏性操作。
          const target = s.danger ? cancelBtn.value : confirmBtn.value;
          if (target && target.focus) target.focus();
        });
      }
    );
    return { s, close, confirmBtn, cancelBtn, onKey };
  },
  template: `
    <div v-if="s.open" class="modal-mask" @click.self="close(false)" @keydown="onKey">
      <div class="modal modal-sm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <div class="modal-head">
          <h3 id="confirm-title">{{ s.title }}</h3>
        </div>
        <div class="modal-body">
          <p class="confirm-msg">{{ s.message }}</p>
        </div>
        <div class="modal-foot">
          <button ref="cancelBtn" class="btn btn-ghost" @click="close(false)">{{ s.cancelText }}</button>
          <button ref="confirmBtn" class="btn" :class="s.danger ? 'btn-danger' : 'btn-primary'" @click="close(true)">{{ s.confirmText }}</button>
        </div>
      </div>
    </div>
  `
};

/* ---------- 条码纠错工具 ---------- */
// 限定深度的编辑距离（> cap 提前退出，返回 cap+1），用于扫码误读比对
function barcodeEditDistance(a, b, cap) {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > cap) return cap + 1;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= n; j++) {
      const c = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur[j] = c;
      if (c < best) best = c;
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[n];
}

// 求与当前条码相似的已有条码：前缀包含（截断/多读）或编辑距离 ≤2（漏读/误读字符），
// 双方长度 ≥6 才参与比对，避免短码误报；最多返回 5 条
// 判断条码是否含「可疑字符」（合法集：字母/数字/下划线/连字符/中文之外的都算）
function hasBarcodeSuspicious(s) {
  for (const ch of String(s || '')) {
    if (/[0-9A-Za-z_\-]/.test(ch) || /[\u4e00-\u9fa5]/.test(ch)) continue;
    return true;
  }
  return false;
}

function barcodeSimilarList(target, known) {
  const s = String(target || '').trim();
  const out = [];
  if (s.length < 6) return out;
  for (const raw of known || []) {
    const k = String(raw || '').trim();
    if (!k || k === s || k.length < 6) continue;
    if (s.startsWith(k) || k.startsWith(s)) { out.push(k); continue; }
    const d = barcodeEditDistance(s, k, 2);
    if (d <= 2 && Math.abs(s.length - k.length) <= 2) out.push(k);
  }
  return out.slice(0, 5);
}

// 从库中条码提取「格式画像」：出现最多的长度为主长度，字符集取并集。
// 样本 <2 条时返回 null（无规律可参照，不做格式判定）。
function barcodeFormatProfile(known) {
  const list = (known || []).map((x) => String(x || '').trim()).filter((x) => x.length >= 6);
  // 需 10 条以上干净条码才总结规律：样本太少时长度/字符集规律不可靠，
  // 宁可只报可疑字符与相似条码，避免小样本误判（现场要求：十条以上）
  if (list.length < 10) return null;
  const lenCount = new Map();
  let chars = '';
  for (const s of list) {
    lenCount.set(s.length, (lenCount.get(s.length) || 0) + 1);
  }
  let mainLen = 0, mainCount = 0;
  for (const [len, c] of lenCount) { if (c > mainCount || (c === mainCount && len > mainLen)) { mainLen = len; mainCount = c; } }
  if (mainCount < Math.max(2, Math.ceil(list.length / 2))) return null;
  for (const s of list) {
    for (const ch of s) { if (!chars.includes(ch)) chars += ch; }
  }
  return { mainLen, charset: chars, sample: list.length };
}

// 扫码枪近形误读映射：字母/符号 → 数字（仅当库内字符集确实含该数字时才启用）
const BARCODE_NEAR_MISS = {
  O: '0', Q: '0', D: '0', o: '0',
  I: '1', L: '1', l: '1', i: '1',
  Z: '2', z: '2',
  A: '4',
  S: '5', s: '5',
  B: '6', b: '6', G: '6',
  T: '7',
  E: '8',
  g: '9', q: '9'
};

// 修复式纠错：把当前条码中不在库内字符集里的字符按近形映射修正，
// 返回 { value, note }；value 是否可用由调用方按格式画像校验后决定
function barcodeRepair(s, profile) {
  const src = String(s || '');
  const chars = [];
  const fixes = [];
  for (const ch of src) {
    if (profile.charset.includes(ch)) { chars.push(ch); continue; }
    const mapped = BARCODE_NEAR_MISS[ch];
    if (mapped && profile.charset.includes(mapped)) {
      chars.push(mapped);
      fixes.push(ch + '→' + mapped);
    }
    // 无法映射的字符直接丢弃：位数/字符集规则会在后续校验中暴露问题
  }
  return { value: chars.join(''), note: fixes.length ? '近形字符 ' + fixes.join('、') + ' 已按库内字符集修正' : '' };
}

// 当前条码对格式画像的偏差说明（无偏差返回空数组）
function barcodeFormatIssues(target, profile) {
  const s = String(target || '').trim();
  const out = [];
  if (!s || !profile) return out;
  if (s.length !== profile.mainLen) out.push(`长度 ${s.length} 位（应为 ${profile.mainLen} 位）`);
  for (const ch of s) {
    if (!profile.charset.includes(ch)) { out.push(`含历史条码中未出现过的字符「${ch}」`); break; }
  }
  return out;
}

function fmt(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  );
}

function fmtSize(n) {
  if (!n || n <= 0) return '';
  return (n / 1048576).toFixed(1) + ' MB';
}

// 四级角色中文标签（单一数据源，供各页面共用）。
// 同时兼容 v1.0.0 的旧角色值（admin/client），升级后旧数据也能正常显示。
const ROLE_LABELS = {
  sysadmin: '系统管理员',
  storeadmin: '门店管理员',
  capture: '拍照账号',
  query: '查询账号',
  // 旧值兼容
  admin: '系统管理员',
  client: '拍照账号'
};

function roleLabel(role) {
  const r = String(role || '').trim();
  return ROLE_LABELS[r] || r || '-';
}

// 是否系统管理员（兼容旧 admin 值）
function isSysAdminRole(role) {
  return role === 'sysadmin' || role === 'admin';
}

// 角色标签配色：系统管理员沿用原「管理员」的橙色，门店管理员用主色蓝，
// 拍照账号用绿色（可录入），查询账号用灰色（只读）。
// 不用红色——红色在本系统中表示「停用/失败」，混用会造成误读。
function roleTagClass(role) {
  if (isSysAdminRole(role)) return 'tag-orange';
  if (role === 'storeadmin') return '';
  if (role === 'capture') return 'tag-green';
  return 'tag-gray';
}

/** 水印用的拍照时间文本，如 2026-09-20 14:05 */
function watermarkTimeText(d) {
  const dt = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate()) +
    ' ' + p(dt.getHours()) + ':' + p(dt.getMinutes())
  );
}

/**
 * 在照片右上角绘制「拍照时间」水印。
 *
 * 设计要点：
 * - 字号按图像短边比例缩放（约 2.2%），摄像头可能是 4000×3000，
 *   固定像素字号在高分辨率下会小到无法辨认；
 * - 半透明深色底 + 白字，兼顾浅色衣物与深色衣物背景下的可读性；
 * - 水印在拍照时就烧录进 JPEG，因此导出/打印的照片同样带有存证时间。
 */
function drawTimeWatermark(ctx, width, height, timeText) {
  if (!ctx || !width || !height) return;
  const shortSide = Math.min(width, height);
  const fontSize = Math.max(12, Math.round(shortSide * 0.022));
  const padX = Math.round(fontSize * 0.7);
  const padY = Math.round(fontSize * 0.42);
  const margin = Math.round(shortSide * 0.018);

  ctx.save();
  ctx.font = '600 ' + fontSize + 'px "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  const textWidth = ctx.measureText(timeText).width;
  const boxW = Math.ceil(textWidth + padX * 2);
  const boxH = Math.ceil(fontSize + padY * 2);
  const boxX = Math.max(0, width - boxW - margin);
  const boxY = Math.max(0, margin);

  // 半透明深色底，保证在浅色衣物上也能看清
  ctx.fillStyle = 'rgba(0, 0, 0, 0.52)';
  const radius = Math.max(2, Math.round(fontSize * 0.22));
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(boxX, boxY, boxW, boxH, radius);
  } else {
    // 老版本 Chromium 没有 roundRect，退回直角矩形
    ctx.rect(boxX, boxY, boxW, boxH);
  }
  ctx.fill();

  ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
  ctx.fillText(timeText, boxX + padX, boxY + boxH / 2);
  ctx.restore();
}

/**
 * 内置操作手册的轻量 Markdown 渲染器（零依赖）。
 *
 * 为什么自写而不用 marked 之类：本项目是「零运行时依赖 + 本地 vendor」风格
 * （Vue 也是 vendor 进 renderer/assets 的），且手册只用到很小的语法子集
 * （标题、段落、无序列表、表格、粗体）。自写解析器避免为几 KB 文档引入依赖，
 * 也让「支持哪些语法」与 scripts/sync-manual.js 的校验清单严格对齐。
 *
 * 安全：所有文本先 HTML 转义再拼装标签，手册内容不会作为 HTML 执行。
 * 手册虽然是本地可信文件，但不依赖这一点——转义是默认动作，没有例外分支。
 *
 * 支持的语法（超出范围的写法会被 sync-manual.js 在构建期拦截）：
 *   # ~ #### 标题、- 无序列表、| 表格 |、**粗体**、普通段落、<!-- roles:xxx --> 标记
 */
function escapeHtml(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 行内格式：目前只需 **粗体**（先转义，再在转义后的文本上匹配，避免标记被转义破坏） */
function inlineMd(escaped) {
  return escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/** 把标题文本转成安全的锚点 id（用于目录跳转） */
function slugify(text) {
  const s = String(text || '').trim().toLowerCase();
  // 只保留中文、字母、数字，其余转为短横线；避免空格与标点破坏 id
  return 'md-' + (s.replace(/[^\u4e00-\u9fa5a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sec');
}

/**
 * 解析手册文本为「章节块」列表，供按角色裁剪与目录生成。
 *
 * 每个块：{ level, title, roles, content }
 *   - roles 来自紧随标题的 <!-- roles:xxx --> 标记；无标记则为 null
 *   - 子章节继承父章节 roles：这样只需标注少数章节，避免大量重复标记
 *
 * 返回扁平数组，渲染时按 level 自行组装层级。
 */
function parseManualSections(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const sections = [];
  let current = null;
  let expectRoles = false; // 标记：下一个非空行若是 roles 注释则归给当前标题

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');

    const hm = line.match(/^(#{1,4})\s+(.*)$/);
    if (hm) {
      current = { level: hm[1].length, title: hm[2].trim(), roles: null, content: [] };
      sections.push(current);
      expectRoles = true;
      continue;
    }

    // roles 标记必须紧跟标题（中间只允许空行），避免误关联到正文
    const rm = line.match(/^<!--\s*roles:\s*([^>]*?)\s*-->$/);
    if (rm && expectRoles && current) {
      current.roles = rm[1].split(',').map((s) => s.trim()).filter(Boolean);
      continue;
    }
    if (line.trim()) expectRoles = false;

    // 标题之前的前言：用 level 0 的合成块承载，避免被静默丢弃。
    // 渲染时该块只输出正文、不输出标题，也不进目录。
    if (!current) {
      if (!line.trim()) continue; // 前言的前导空行无需保留
      current = { level: 0, title: '', roles: null, content: [], preamble: true };
      sections.push(current);
    }
    current.content.push(line);
  }

  // 子章节继承父章节的 roles（仅在自己没有标记时）
  const stack = [];
  for (const s of sections) {
    while (stack.length && stack[stack.length - 1].level >= s.level) stack.pop();
    if (s.roles === null && stack.length) s.roles = stack[stack.length - 1].roles;
    stack.push(s);
  }
  return sections;
}

/**
 * 判断某章节对指定角色是否可见；roles 为 null 表示所有角色可见。
 *
 * 系统管理员一律可见全部章节：它是搭建与排障角色，对软件有完整访问权，
 * 需要能查阅店员端操作文档才能指导门店使用与定位问题。
 * 这也避免手册作者在每处 roles 标记里都要补写 sysadmin（漏写就会造成
 * 「系统管理员反而比门店管理员看到的章节少」这类反直觉结果）。
 */
function sectionVisible(roles, role) {
  if (!roles || !roles.length) return true;
  if (!role) return false;
  if (isSysAdminRole(role)) return true;
  return roles.includes(role);
}

/** 把章节的正文（不含标题）渲染为 HTML */
function renderSectionBody(contentLines) {
  const out = [];
  let i = 0;
  let listOpen = false;

  const closeList = () => {
    if (listOpen) {
      out.push('</ul>');
      listOpen = false;
    }
  };

  while (i < contentLines.length) {
    const line = contentLines[i];
    const trimmed = line.trim();

    // 空行：结束列表，段落之间自然分隔
    if (!trimmed) {
      closeList();
      i++;
      continue;
    }

    // 表格：表头行 + 分隔行（| --- | --- |）+ 若干数据行
    if (trimmed.startsWith('|') && i + 1 < contentLines.length) {
      const sep = contentLines[i + 1].trim();
      if (/^\|?[\s:|-]+\|[\s:|-]*$/.test(sep) && sep.includes('-')) {
        closeList();
        const parseRow = (r) =>
          r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
        const head = parseRow(trimmed);
        i += 2; // 跳过表头与分隔行
        const rows = [];
        while (i < contentLines.length && contentLines[i].trim().startsWith('|')) {
          rows.push(parseRow(contentLines[i].trim()));
          i++;
        }
        let html = '<table class="md-table"><thead><tr>';
        for (const h of head) html += '<th>' + inlineMd(escapeHtml(h)) + '</th>';
        html += '</tr></thead><tbody>';
        for (const r of rows) {
          html += '<tr>';
          // 单元格数与表头对齐：多的截断、少的补空，避免表格错位
          for (let c = 0; c < head.length; c++) {
            html += '<td>' + inlineMd(escapeHtml(r[c] === undefined ? '' : r[c])) + '</td>';
          }
          html += '</tr>';
        }
        html += '</tbody></table>';
        out.push(html);
        continue;
      }
    }

    // 无序列表
    const lm = trimmed.match(/^-\s+(.*)$/);
    if (lm) {
      if (!listOpen) {
        out.push('<ul class="md-list">');
        listOpen = true;
      }
      out.push('<li>' + inlineMd(escapeHtml(lm[1])) + '</li>');
      i++;
      continue;
    }

    // 普通段落：连续的文本行合并为一段
    closeList();
    const para = [trimmed];
    i++;
    while (i < contentLines.length) {
      const nx = contentLines[i].trim();
      if (!nx || nx.startsWith('#') || nx.startsWith('|') || nx.startsWith('- ') || nx.startsWith('<!--')) break;
      para.push(nx);
      i++;
    }
    out.push('<p>' + inlineMd(escapeHtml(para.join(' '))) + '</p>');
  }

  closeList();
  return out.join('\n');
}

/**
 * 渲染整篇手册为 HTML（已按角色裁剪）。
 * @param {string} text 手册 Markdown 原文
 * @param {string} role 当前登录角色（sysadmin/storeadmin/capture/query）
 * @returns {{ html:string, toc:Array<{id,title,level}> }}
 */
function renderManual(text, role) {
  const sections = parseManualSections(text);
  const html = [];
  const toc = [];
  const usedIds = new Set();

  for (const s of sections) {
    if (!sectionVisible(s.roles, role)) continue;

    // 前言块（标题之前的正文）：只输出正文，不生成标题、不占目录、不参与 id 分配
    if (s.preamble) {
      const preBody = renderSectionBody(s.content);
      if (preBody) html.push('<div class="md-preamble">' + preBody + '</div>');
      continue;
    }

    // 标题可能重复（如多个「说明」小节），追加序号保证 id 唯一，否则目录跳转会错
    let id = slugify(s.title);
    if (usedIds.has(id)) {
      let n = 2;
      while (usedIds.has(id + '-' + n)) n++;
      id = id + '-' + n;
    }
    usedIds.add(id);

    const tag = 'h' + Math.min(4, Math.max(1, s.level));
    html.push('<' + tag + ' id="' + id + '" class="md-' + tag + '">' + inlineMd(escapeHtml(s.title)) + '</' + tag + '>');
    const body = renderSectionBody(s.content);
    if (body) html.push(body);

    // 目录只收 h2/h3，h1 是手册标题、h4 过细，收进来会太长
    if (s.level === 2 || s.level === 3) toc.push({ id, title: s.title, level: s.level });
  }

  return { html: html.join('\n'), toc };
}

/**
 * 共用的「版本与安装包下载」逻辑。
 * 登录页、客户端设置页、管理端系统设置页都要展示当前版本并支持一键下载安装包，
 * 统一在此实现，避免多份拷贝出现行为不一致。
 *
 * 说明：checkUpdate 即使没有新版本也会返回下载地址，因此始终可以下载最新安装包。
 */
function useUpdater() {
  const version = Vue.ref('');
  const updateInfo = Vue.ref(null);
  const downloading = Vue.ref(false);
  const dlProgress = Vue.ref({ received: 0, total: 0 });
  let removeProgress = null;

  const canAutoDownload = Vue.computed(
    () => !!(updateInfo.value && updateInfo.value.source === 'github' && updateInfo.value.downloadUrl)
  );
  const progressPercent = Vue.computed(() => {
    const { received, total } = dlProgress.value || {};
    if (!total || total <= 0) return 0;
    return Math.min(100, Math.round((received / total) * 100));
  });
  const progressText = Vue.computed(() => {
    const { received, total } = dlProgress.value || {};
    const base = total > 0 ? fmtSize(received) + ' / ' + fmtSize(total) + '（' + progressPercent.value + '%）' : fmtSize(received);
    const ch = dlProgress.value && dlProgress.value.channel;
    return base + (ch === 'accel' ? ' · 国内加速' : ch === 'direct' ? ' · 直连' : '');
  });

  // 组件销毁时必须注销进度监听，否则反复进出页面会累积回调
  function dispose() {
    if (removeProgress) {
      removeProgress();
      removeProgress = null;
    }
  }

  async function loadVersion() {
    const r = await window.api.version();
    if (r.ok && r.data) version.value = r.data.version;
  }

  async function refreshUpdateInfo() {
    const u = await window.api.checkUpdate();
    if (u.ok && u.data) updateInfo.value = u.data;
    return updateInfo.value;
  }

  async function downloadPackage() {
    const info = updateInfo.value;
    if (!info || !info.downloadUrl || downloading.value) return;
    if (!canAutoDownload.value) {
      // 无法访问 GitHub 时回退为打开下载页
      window.api.openUpdatePage();
      return;
    }
    downloading.value = true;
    dlProgress.value = { received: 0, total: 0 };
    removeProgress = window.api.onDownloadProgress((p) => {
      dlProgress.value = p;
    });
    try {
      const r = await window.api.downloadUpdate(info.downloadUrl, info.assetName);
      if (r.ok) {
        toast('安装包下载完成' + (r.data && r.data.channel === 'accel' ? '（经国内加速通道）' : '') + '，已打开文件夹，双击安装即可覆盖升级', 'success');
      } else if (!r.canceled) {
        toast(r.message || '下载失败', 'error');
      } else {
        toast('已取消下载', 'success');
      }
    } catch (e) {
      toast('下载失败：' + (e.message || e), 'error');
    } finally {
      downloading.value = false;
      dispose();
    }
  }

  function cancelDownload() {
    window.api.cancelDownload();
  }

  Vue.onUnmounted(dispose);

  return {
    version, updateInfo, downloading, dlProgress,
    canAutoDownload, progressPercent, progressText,
    loadVersion, refreshUpdateInfo, downloadPackage, cancelDownload
  };
}

/* ---------- 启动设置页（首次使用 / 切换运行模式） ---------- */
const SetupPage = {
  emits: ['done'],
  setup(props, { emit }) {
    const info = Vue.ref(null);
    const localIp = Vue.ref('');
    const tab = Vue.ref('server');
    const serverUrl = Vue.ref('');
    const serverToken = Vue.ref('');
    const testing = Vue.ref(false);
    const testMsg = Vue.ref('');

    async function load() {
      const r = await window.api.systemInfo();
      if (r.ok) {
        info.value = r.data;
        tab.value = r.data.mode === 'client' ? 'client' : 'server';
        if (r.data.serverUrl) serverUrl.value = r.data.serverUrl;
      }
      const ip = await window.api.localIp();
      if (ip.ok) localIp.value = ip.data;
    }

    async function asServer() {
      const r = await window.api.setMode('server');
      if (r.ok) {
        toast('已配置为服务端，请重启应用生效', 'success');
        emit('done');
      } else {
        toast(r.message || '保存失败', 'error');
      }
    }

    async function testConn() {
      testing.value = true;
      testMsg.value = '';
      const r = await window.api.testServer(serverUrl.value, serverToken.value);
      testing.value = false;
      testMsg.value = r.ok ? '✓ 连接成功，服务器在线' : '✗ ' + (r.message || '连接失败');
      return r.ok;
    }

    async function asClient() {
      const ok = await testConn();
      if (!ok) return;
      const r = await window.api.setClientConfig(serverUrl.value, serverToken.value);
      if (r.ok) {
        toast('已配置为客户端，请重启应用生效', 'success');
        emit('done');
      } else {
        toast(r.message || '保存失败', 'error');
      }
    }

    Vue.onMounted(load);
    return { info, localIp, tab, serverUrl, serverToken, testing, testMsg, asServer, asClient, testConn };
  },
  template: `
    <div class="setup-wrap">
      <div class="setup-card">
        <img class="logo-login" src="./assets/logo.png" alt="星期衣" />
        <h1>星期衣精致洗衣 · 衣物照片系统</h1>
        <div class="login-sub">首次使用，请选择本机的运行模式</div>

        <div class="setup-tabs">
          <div class="setup-tab" :class="{ active: tab === 'server' }" @click="tab = 'server'">🖥️ 作为服务端</div>
          <div class="setup-tab" :class="{ active: tab === 'client' }" @click="tab = 'client'">💻 作为客户端</div>
        </div>

        <div v-if="tab === 'server'" class="setup-body">
          <p class="setup-desc">
            本电脑作为数据中枢：账号、存档记录、操作日志与照片全部保存在本机，
            并开启局域网服务供其他电脑连接。跨城市使用时请配合异地组网或内网穿透工具。
          </p>
          <div v-if="info" class="setup-info">
            <div class="info-row"><span>服务端口</span><b>{{ info.port }}</b></div>
            <div class="info-row"><span>连接码</span><b class="code">{{ info.token }}</b></div>
            <div class="info-row"><span>本机局域网 IP</span><b>{{ localIp }}</b></div>
          </div>
          <button class="btn btn-primary btn-block" @click="asServer">保存并作为服务端运行</button>
        </div>

        <div v-else class="setup-body">
          <p class="setup-desc">
            本电脑作为工作站：连接到已有的服务端，拍照与查询都实时读写服务器数据。
            请先向服务端管理员获取服务器地址与连接码。
          </p>
          <label>服务器地址</label>
          <input v-model="serverUrl" placeholder="例如 http://192.168.1.10:17521" />
          <label>连接码</label>
          <input v-model="serverToken" placeholder="服务端「系统设置」页中的连接码" />
          <div v-if="testMsg" class="setup-test" :class="{ ok: testMsg.indexOf('✓') === 0 }">{{ testMsg }}</div>
          <div style="display:flex;gap:10px">
            <button class="btn btn-ghost" style="flex:1" :disabled="testing" @click="testConn">
              {{ testing ? '测试中…' : '测试连接' }}
            </button>
            <button class="btn btn-primary" style="flex:1" :disabled="testing" @click="asClient">保存并连接</button>
          </div>
        </div>

        <div class="login-hint">配置保存后需重启应用生效；之后可在管理端「系统设置」中重新切换</div>
      </div>
    </div>
  `
};

/* ---------- 登录页 ---------- */
const LoginPage = {
  props: {
    sysInfo: { type: Object, default: null },
    // 被顶下线（唯一登录）时由根应用传入的原因文案；普通进入登录页为空
    revokedMsg: { type: String, default: '' }
  },
  emits: ['login', 'server-saved'],
  setup(props, { emit }) {
    const username = Vue.ref('');
    const password = Vue.ref('');
    const passwordInput = Vue.ref(null);
    const error = Vue.ref('');
    const loading = Vue.ref(false);

    // ---------- 记住账号 / 记住密码 ----------
    // 凭据由主进程用 Electron safeStorage（系统级凭据保护）加密后保存，密码不明文落盘。
    // 默认只记住账号名、不记住密码：记住密码需用户显式勾选（每个账号各自记住）。
    const savedAccounts = Vue.ref([]); // [{ username, name, store, role, hasPassword }]
    const passwordSupported = Vue.ref(false); // 系统是否支持加密保存密码
    const rememberUser = Vue.ref(true);
    const rememberPass = Vue.ref(false);
    const credNotice = Vue.ref(''); // 密码未能保存时的原因
    const showSavedPanel = Vue.ref(false);

    // 兼容旧版本：把 localStorage 里记住的最后账号迁移到凭据存储，避免升级后丢失
    const LEGACY_USER_KEY = 'xqy.lastUsername';
    function migrateLegacyLastUser() {
      try {
        const legacy = localStorage.getItem(LEGACY_USER_KEY);
        if (!legacy) return '';
        localStorage.removeItem(LEGACY_USER_KEY);
        return String(legacy).trim();
      } catch (e) {
        return '';
      }
    }

    async function loadSavedAccounts() {
      try {
        const r = await window.api.listCredentials();
        if (r.ok && r.data) {
          savedAccounts.value = r.data.accounts || [];
          passwordSupported.value = !!r.data.passwordSupported;
          return savedAccounts.value;
        }
      } catch (e) {
        /* 读取失败时退化为不记忆，不影响登录 */
      }
      savedAccounts.value = [];
      return [];
    }

    /** 当前输入的账号名对应的已保存条目（不区分大小写） */
    function findSaved(name) {
      const u = String(name || '').trim().toLowerCase();
      return savedAccounts.value.find((a) => String(a.username).toLowerCase() === u) || null;
    }

    /**
     * 按账号名填充已保存的密码。
     * 切换账号时必须清掉上一个账号的密码：否则会把 A 账号的密码显示在 B 账号的
     * 输入框里，既是凭据泄露也会导致用 A 的密码登 B 而失败。
     */
    async function fillPasswordFor(name) {
      const saved = findSaved(name);
      if (!saved || !saved.hasPassword) {
        password.value = '';
        rememberPass.value = false;
        return;
      }
      try {
        const r = await window.api.getCredential(saved.username);
        if (r.ok && r.data && r.data.password) {
          password.value = r.data.password;
          rememberPass.value = true;
          credNotice.value = r.data.error || '';
        } else {
          password.value = '';
          rememberPass.value = false;
          credNotice.value = (r.ok && r.data && r.data.error) || '';
        }
      } catch (e) {
        password.value = '';
        rememberPass.value = false;
      }
    }

    /**
     * 账号输入框失焦时按账号名填充已保存的密码。
     *
     * 刻意不用 Vue.watch(username)：那会在用户手动输入的**每一次按键**都触发，
     * 而输入中途的账号名往往匹配不到已保存条目，会把已填好的密码清空
     * （例如自动填充了账号 A 和密码，用户想改成 B，删掉一个字符的瞬间密码就没了）。
     * 改为失焦时填充：输入过程中绝不动密码框。
     */
    function onUsernameBlur() {
      const name = String(username.value || '').trim();
      if (!name) {
        rememberPass.value = false;
        return;
      }
      const saved = findSaved(name);
      rememberPass.value = !!(saved && saved.hasPassword);
      if (saved && saved.hasPassword && !password.value) {
        // 仅在密码框为空时填充，不覆盖用户已经手动输入的密码
        fillPasswordFor(name);
      }
    }

    /** 登录成功后保存凭据；保存失败不影响登录，只提示 */
    async function saveCredentialAfterLogin(user) {
      const name = String((user && (user.username || user.name)) || username.value || '').trim();
      if (!name) return;
      if (!rememberUser.value && !rememberPass.value) {
        // 两个都不勾：清掉该账号已保存的凭据，符合用户预期
        try {
          await window.api.removeCredential(name);
        } catch (e) {
          /* 忽略 */
        }
        await loadSavedAccounts();
        return;
      }
      try {
        const r = await window.api.saveCredential({
          username: name,
          password: rememberPass.value ? password.value : '',
          rememberPassword: rememberPass.value,
          name: (user && user.name) || '',
          store: (user && user.store) || '',
          role: (user && user.role) || ''
        });
        if (r.ok) {
          credNotice.value = r.data.notice || '';
          if (r.data.notice) toast(r.data.notice, 'error');
        } else if (r.message) {
          toast(r.message, 'error');
        }
      } catch (e) {
        /* 保存凭据失败不影响已成功的登录 */
      }
      await loadSavedAccounts();
    }

    /** 从下拉中选定账号 */
    async function pickAccount(name) {
      username.value = String(name || '').trim();
      // 显式关闭面板：下拉项用 mousedown.prevent 阻止了默认行为（也阻止了输入框失焦），
      // 若不主动关闭，面板会滞留，不能依赖 blur 的副作用顺序
      showSavedPanel.value = false;
      await fillPasswordFor(username.value);
      // 有密码则直接聚焦登录按钮所在区域，无密码则聚焦密码框等待输入
      if (passwordInput.value && passwordInput.value.focus) passwordInput.value.focus();
    }

    /** 删除单个已保存账号 */
    async function removeSaved(name) {
      const ok = await showConfirm({ title: '移除保存的账号', message: '不再记住账号『' + name + '』？\n已保存的密码会一并清除。', confirmText: '不再记住', danger: true });
      if (!ok) return;
      try {
        const r = await window.api.removeCredential(name);
        if (r.ok) {
          toast('已移除该账号的保存记录', 'success');
          await loadSavedAccounts();
          // 删到最后一个时关掉面板，避免残留一个空框
          if (!savedAccounts.value.length) showSavedPanel.value = false;
        } else {
          toast(r.message || '移除失败', 'error');
        }
      } catch (e) {
        toast('移除失败：' + (e.message || e), 'error');
      }
    }

    /** 清空全部已保存凭据 */
    async function clearSaved() {
      const ok = await showConfirm({ title: '清空本机凭据', message: '清空本机保存的全部账号与密码？\n此操作不可恢复。', confirmText: '清空', danger: true });
      if (!ok) return;
      try {
        const r = await window.api.clearCredentials();
        if (r.ok) {
          toast('已清空本机保存的登录凭据', 'success');
          await loadSavedAccounts();
          // 列表已空，关闭面板避免残留一个空框
          showSavedPanel.value = false;
        } else {
          toast(r.message || '清空失败', 'error');
        }
      } catch (e) {
        toast('清空失败：' + (e.message || e), 'error');
      }
    }

    const showServer = Vue.ref(false);
    const serverUrl = Vue.ref('');
    const serverToken = Vue.ref('');
    const testing = Vue.ref(false);
    const testMsg = Vue.ref('');
    const savingServer = Vue.ref(false);

    // 激活与试用状态
    const license = Vue.ref(null);
    const showActivate = Vue.ref(false);
    const activateCode = Vue.ref('');
    const activateMsg = Vue.ref('');
    const activating = Vue.ref(false);

    // 版本与安装包下载：登录页即可下载最新版安装包，店员未登录时也能升级
    const {
      version, updateInfo, downloading, canAutoDownload, progressPercent, progressText,
      loadVersion, refreshUpdateInfo, downloadPackage, cancelDownload
    } = useUpdater();

    async function loadAll() {
      loadLicense();
      await loadVersion();
      refreshUpdateInfo();
    }

    async function loadLicense() {
      const r = await window.api.licenseStatus();
      if (r.ok) {
        license.value = r.data;
        // 试用到期时强制显示激活弹窗
        if (r.data.state === 'expired') showActivate.value = true;
      }
    }

    async function doActivate() {
      if (activating.value) return;
      activateMsg.value = '';
      if (!activateCode.value.trim()) {
        activateMsg.value = '请输入激活码';
        return;
      }
      activating.value = true;
      const r = await window.api.activate(activateCode.value.trim());
      activating.value = false;
      if (r.ok) {
        toast('激活成功，感谢使用', 'success');
        license.value = r.data;
        showActivate.value = false;
        activateCode.value = '';
      } else {
        activateMsg.value = r.message || '激活失败';
      }
    }

    function copyMachineCode() {
      if (license.value && license.value.machineCode) {
        window.api.copyText(license.value.machineCode);
        toast('机器码已复制，请发送给管理员获取激活码', 'success');
      }
    }

    // 挂载时加载激活状态、版本信息，并恢复已保存的登录凭据
    Vue.onMounted(async () => {
      loadAll();

      const accounts = await loadSavedAccounts();

      // 兼容旧版本：把 localStorage 记住的最后账号迁移到凭据存储（只迁账号名，不含密码）
      const legacy = migrateLegacyLastUser();
      if (legacy && !findSaved(legacy)) {
        try {
          await window.api.saveCredential({
            username: legacy,
            password: '',
            rememberPassword: false
          });
          await loadSavedAccounts();
        } catch (e) {
          /* 迁移失败不影响登录，用户手动输入即可 */
        }
      }

      // 自动填充最近登录的账号：有保存密码则连密码一起填，否则聚焦密码框
      const list = accounts.length ? accounts : savedAccounts.value;
      const first = list[0];
      if (first) {
        username.value = first.username;
        rememberUser.value = true;
        await fillPasswordFor(first.username);
      }
      Vue.nextTick(() => {
        if (passwordInput.value && passwordInput.value.focus) passwordInput.value.focus();
      });
    });

    function openServer() {
      showServer.value = !showServer.value;
      if (showServer.value && props.sysInfo) {
        serverUrl.value = props.sysInfo.serverUrl || '';
      }
      testMsg.value = '';
    }

    async function testConn() {
      testing.value = true;
      testMsg.value = '';
      const r = await window.api.testServer(serverUrl.value, serverToken.value);
      testing.value = false;
      testMsg.value = r.ok ? '✓ 连接成功，服务器在线' : '✗ ' + (r.message || '连接失败');
      return r.ok;
    }

    async function saveServer() {
      savingServer.value = true;
      try {
        const ok = await testConn();
        if (!ok) return;
        const r = await window.api.setClientConfig(serverUrl.value, serverToken.value);
        if (r.ok) {
          toast('服务器设置已保存并生效', 'success');
          showServer.value = false;
          emit('server-saved');
        } else {
          toast(r.message || '保存失败', 'error');
        }
      } finally {
        savingServer.value = false;
      }
    }

    async function submit() {
      if (loading.value) return;
      error.value = '';
      if (!username.value.trim() || !password.value) {
        error.value = '请输入账号和密码';
        return;
      }
      loading.value = true;
      try {
        const r = await window.api.login(username.value.trim(), password.value);
        if (r.ok) {
          // 按「记住账号 / 记住密码」勾选状态保存凭据。
          // 用 await：保存失败需要把原因提示出来（例如系统不支持加密保存密码），
          // 且不保存就 emit 会导致界面切走、toast 无处展示。
          await saveCredentialAfterLogin(r.data.user);
          toast('登录成功，欢迎 ' + (r.data.user.name || r.data.user.username), 'success');
          emit('login', r.data);
        } else if (r.expired) {
          // 试用到期：提示并弹出激活框
          error.value = r.message || '试用期已结束，请输入激活码';
          if (r.license) license.value = r.license;
          showActivate.value = true;
        } else {
          error.value = r.message || '登录失败';
        }
      } catch (e) {
        error.value = '登录失败：' + (e.message || e);
      } finally {
        loading.value = false;
      }
    }

    return {
      username, password, passwordInput, error, loading, submit,
      showServer, serverUrl, serverToken, testing, testMsg, savingServer,
      openServer, testConn, saveServer, sysInfo: props.sysInfo,
      license, showActivate, activateCode, activateMsg, activating,
      doActivate, copyMachineCode,
      version, updateInfo, downloading, canAutoDownload, progressPercent, progressText,
      downloadPackage, cancelDownload,
      // 记住账号 / 记住密码
      savedAccounts, passwordSupported, rememberUser, rememberPass, credNotice,
      showSavedPanel, pickAccount, removeSaved, clearSaved, roleLabel, onUsernameBlur,
      revokedMsg: Vue.computed(() => props.revokedMsg || '')
    };
  },
  template: `
    <div class="login-wrap">
      <div class="login-card">
        <img class="logo-login" src="./assets/logo.png" alt="星期衣" />
        <h1>星期衣精致洗衣</h1>
        <div class="login-sub">衣物照片系统</div>
        <form @submit.prevent="submit">
          <label>账号</label>
          <div class="login-user-field">
            <input
              v-model="username"
              placeholder="请输入账号"
              autocomplete="username"
              @focus="showSavedPanel = savedAccounts.length > 0"
              @blur="onUsernameBlur(); showSavedPanel = false"
            />
            <!-- 已保存账号下拉：面板项用 mousedown.prevent，
                 否则输入框 blur 会先关闭面板，导致 click 永远不触发 -->
            <div v-if="showSavedPanel && savedAccounts.length" class="login-user-list">
              <div
                v-for="a in savedAccounts"
                :key="a.username"
                class="login-user-item"
                @mousedown.prevent="pickAccount(a.username)"
              >
                <div class="lui-main">
                  <div class="lui-name">
                    {{ a.username }}
                    <span v-if="a.name && a.name !== a.username" class="lui-sub">（{{ a.name }}）</span>
                    <span v-if="a.hasPassword" class="tag tag-green lui-key" title="已保存密码">🔑</span>
                  </div>
                  <div class="lui-meta">
                    <span v-if="a.role" class="tag tag-gray">{{ roleLabel(a.role) }}</span>
                    <span v-if="a.store" class="tag" style="margin-left:4px">{{ a.store }}</span>
                  </div>
                </div>
                <button
                  type="button"
                  class="lui-del"
                  title="不再记住该账号"
                  @mousedown.prevent.stop="removeSaved(a.username)"
                >✕</button>
              </div>
              <div class="login-user-foot">
                <button type="button" class="btn btn-ghost btn-sm" @mousedown.prevent.stop="clearSaved">
                  清空全部保存记录
                </button>
              </div>
            </div>
          </div>

          <label>密码</label>
          <input ref="passwordInput" v-model="password" type="password" placeholder="请输入密码" autocomplete="current-password" />

          <div class="check-row login-remember">
            <label><input type="checkbox" v-model="rememberUser" />记住账号</label>
            <label :title="passwordSupported ? '' : '本机系统凭据保护不可用，无法加密保存密码'">
              <input type="checkbox" v-model="rememberPass" :disabled="!passwordSupported" />记住密码
            </label>
          </div>
          <div v-if="!passwordSupported" class="login-cred-tip warn">
            本机系统凭据保护不可用，密码无法加密保存，「记住密码」已禁用（仅记住账号名）。
          </div>
          <!-- 共用电脑风险必须明确告知：记住密码后，任何能打开本软件的人
               从下拉选中该账号即可登录，因此默认不勾选，需用户主动开启 -->
          <div v-else-if="rememberPass" class="login-cred-tip warn">
            ⚠️ 共用电脑请谨慎勾选「记住密码」：开启后，任何能打开本软件的人
            从账号下拉中选中该账号即可直接登录。建议仅在个人专用电脑上开启。
          </div>
          <div v-else class="login-cred-tip">
            密码经系统凭据保护加密后保存在本机，不会明文存储，也不会上传到服务器。
          </div>
          <div v-if="credNotice" class="login-cred-tip warn">{{ credNotice }}</div>

          <div v-if="error" class="form-error">{{ error }}</div>
          <button class="btn btn-primary btn-block" type="submit" :disabled="loading">
            {{ loading ? '登录中…' : '登 录' }}
          </button>
        </form>

        <!-- 被顶下线（唯一登录）的醒目提示：放在表单外，避免与普通登录失败混淆 -->
        <div v-if="revokedMsg" class="login-revoked">
          🔒 {{ revokedMsg }}
        </div>

        <div class="login-server-toggle" @click="openServer">
          ⚙️ 服务器设置
          <span v-if="sysInfo && sysInfo.mode === 'client'" class="tag tag-green" style="margin-left:6px">客户端</span>
          <span v-else-if="sysInfo && sysInfo.mode === 'server'" class="tag tag-orange" style="margin-left:6px">本机服务端</span>
        </div>

        <div v-if="showServer" class="login-server-panel">
          <template v-if="sysInfo && sysInfo.mode === 'server'">
            <div class="setup-desc">
              本机正在以服务端模式运行，账号与照片数据存储在本机，无需连接其他服务器。
              如需改为连接远程服务器，请在下方填写后保存。
            </div>
          </template>
          <label>服务器地址</label>
          <input v-model="serverUrl" placeholder="例如 http://192.168.1.10:17521" />
          <label>连接码</label>
          <input v-model="serverToken" placeholder="服务端「系统设置」页中的连接码" />
          <div v-if="testMsg" class="setup-test" :class="{ ok: testMsg.indexOf('✓') === 0 }">{{ testMsg }}</div>
          <div style="display:flex;gap:10px;margin-top:12px">
            <button class="btn btn-ghost" style="flex:1" :disabled="testing || savingServer" @click="testConn">
              {{ testing ? '测试中…' : '测试连接' }}
            </button>
            <button class="btn btn-primary" style="flex:1" :disabled="testing || savingServer" @click="saveServer">
              {{ savingServer ? '保存中…' : '保存并生效' }}
            </button>
          </div>
        </div>

        <div class="login-hint">
          首次使用默认管理员账号：admin / admin123<br />
          登录后请及时修改密码并创建店员账号
        </div>

        <div v-if="license" class="license-tip" :class="license.state">
          <template v-if="license.state === 'activated'">
            ✅ 已激活
          </template>
          <template v-else-if="license.state === 'trial'">
            试用中，剩余 <b>{{ license.trialDaysLeft }}</b> 天（共 {{ license.trialDays }} 天）
            <a href="#" @click.prevent="showActivate = true">输入激活码</a>
          </template>
          <template v-else-if="license.state === 'unavailable'">
            ⚠️ 激活组件不完整，无法验证授权：请重新安装完整安装包，或联系软件维护者
          </template>
          <template v-else>
            ⚠️ 试用期已结束，请输入激活码后继续使用
          </template>
        </div>

        <!-- 当前版本 + 一键下载安装包 -->
        <div class="login-version">
          <span class="login-version-text">当前版本 <b>v{{ version || '-' }}</b></span>
          <span v-if="updateInfo && updateInfo.latestVersion" class="login-version-latest">
            最新版本 <b>v{{ updateInfo.latestVersion }}</b>
            <span v-if="updateInfo.hasUpdate" class="tag tag-orange" style="margin-left:4px;vertical-align:middle">有更新</span>
          </span>
          <template v-if="downloading">
            <div class="login-dl-progress">
              <div class="login-dl-bar"><i :style="{ width: progressPercent + '%' }"></i></div>
              <span>{{ progressText }}</span>
            </div>
            <button class="btn btn-ghost btn-sm" @click="cancelDownload">取消下载</button>
          </template>
          <template v-else>
            <button v-if="canAutoDownload" class="btn btn-ghost btn-sm" @click="downloadPackage">
              ⬇️ 一键下载安装包
            </button>
            <button v-else-if="updateInfo" class="btn btn-ghost btn-sm" @click="downloadPackage">
              ⬇️ 打开下载页
            </button>
          </template>
        </div>
      </div>

      <div v-if="showActivate" class="modal-mask" @click.self="license && license.state === 'expired' ? null : (showActivate = false)">
        <div class="modal modal-sm">
          <div class="modal-head">
            <h3>软件激活</h3>
            <button class="modal-close" :disabled="license && license.state === 'expired'" @click="showActivate = false">✕</button>
          </div>
          <div class="modal-body">
            <div v-if="license && license.copiedFromOtherMachine" class="form-error" style="margin:0 0 10px">
              检测到本机曾使用其他电脑的激活码，激活码与机器码一一绑定，请为本机重新获取激活码。
            </div>
            <div class="info-row">
              <span>本机机器码</span>
              <b class="code">{{ license ? license.machineCode : '-' }}</b>
            </div>
            <p class="setup-desc" style="margin:10px 0 0">
              把机器码发送给管理员，由管理员使用「激活码计算工具」生成对应的激活码。
              激活码与本机绑定，更换电脑需重新获取。
            </p>
            <label>激活码</label>
            <input v-model="activateCode" placeholder="例如 XQY-XXXX-XXXX-XXXX" @keyup.enter="doActivate" />
            <div v-if="activateMsg" class="form-error">{{ activateMsg }}</div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="copyMachineCode">复制机器码</button>
            <button class="btn btn-primary" :disabled="activating" @click="doActivate">
              {{ activating ? '激活中…' : '立即激活' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  `
};

/* ---------- 客户端 · 首页 ---------- */
const HomePage = {
  props: { user: { type: Object, required: true }, token: { type: String, required: true } },
  emits: ['goto'],
  setup(props) {
    const stats = Vue.ref({ myCount: 0, todayCount: 0 });
    const recent = Vue.ref([]);
    const detail = Vue.ref(null);

    // 拍照能力由角色派生：查询账号与门店管理员没有拍照入口，
    // 首页不能显示会跳转到不存在页面的快捷卡片
    const canCapture = Vue.computed(() => !!(props.user && props.user.permissions && props.user.permissions.capture));
    const isStoreAdmin = Vue.computed(() => props.user && props.user.role === 'storeadmin');
    // 门店管理员看到的是本店全部订单，统计口径文案需据实说明
    const countLabel = Vue.computed(() => (isStoreAdmin.value ? '本店订单总数' : '我的存档总数'));

    async function load() {
      const r = await window.api.listRecords(props.token, { page: 1, pageSize: 100, silent: true });
      if (r.ok) {
        recent.value = r.data.items.slice(0, 6);
        const today = new Date().toISOString().slice(0, 10);
        stats.value.todayCount = r.data.items.filter((x) => x.createdAt.slice(0, 10) === today).length;
        stats.value.myCount = r.data.total;
      }
    }

    async function openDetail(r) {
      const res = await window.api.getRecord(props.token, r.id);
      if (res.ok) detail.value = res.data;
      else toast(res.message || '打开失败', 'error');
    }

    Vue.onMounted(load);
    return {
      user: props.user, stats, recent, detail, openDetail, fmt,
      canCapture, isStoreAdmin, countLabel, roleLabel
    };
  },
  template: `
    <div>
      <div class="page-head">
        <h2>你好，{{ user.name || user.username }}</h2>
        <p>{{ roleLabel(user.role) }} · 欢迎使用星期衣精致洗衣衣物照片系统</p>
      </div>

      <div class="stat-row">
        <div class="stat-card"><div class="lbl">{{ countLabel }}</div><div class="num">{{ stats.myCount }}</div></div>
        <div class="stat-card"><div class="lbl">今日新增（最近 100 条内）</div><div class="num">{{ stats.todayCount }}</div></div>
        <div class="stat-card"><div class="lbl">当前账号</div><div class="num" style="font-size:19px;padding-top:10px">{{ user.username }}</div></div>
      </div>

      <div class="quick-row">
        <button v-if="canCapture" class="quick-card" @click="$emit('goto', 'capture')">
          <div class="t">📷 衣物拍照</div>
          <div class="d">扫描或输入衣物条形码，拍摄最大分辨率照片存档</div>
        </button>
        <button class="quick-card" @click="$emit('goto', 'query')">
          <div class="t">{{ isStoreAdmin ? '🗂️ 本店订单' : '🔍 记录查询' }}</div>
          <div class="d">{{ isStoreAdmin ? '查看本门店所有账号登记的衣物存档数据' : '按条形码、备注、日期查找已存档的照片' }}</div>
        </button>
      </div>

      <h3 class="section-title">最近存档</h3>
      <div v-if="!recent.length" class="card empty">
        <div class="empty-icon" aria-hidden="true"></div>
        <div class="empty-title">{{ canCapture ? '还没有存档记录' : '暂无存档记录' }}</div>
        <div class="empty-desc">{{ canCapture ? '去「衣物拍照」添加本店第一张衣物照片' : '本店暂时还没有衣物照片存档' }}</div>
      </div>
      <div v-else class="record-grid">
        <div v-for="r in recent" :key="r.id" class="record-card" @click="openDetail(r)">
          <div class="record-photo"><img :src="r.thumbUrl || r.photoUrl" loading="lazy" decoding="async" /></div>
          <div class="record-meta">
            <div class="record-customer">{{ r.barcode }}</div>
            <div class="record-tags">
              <span class="tag tag-orange">第 {{ r.seq }} 张</span>
            </div>
            <div class="record-time">{{ fmt(r.createdAt) }}</div>
          </div>
        </div>
      </div>

      <div v-if="detail" class="modal-mask" @click.self="detail = null">
        <div class="modal">
          <div class="modal-head"><h3>存档详情</h3><button class="modal-close" @click="detail = null">✕</button></div>
          <div class="modal-body">
            <img class="modal-photo" :src="detail.photoUrl" />
            <div class="info-row"><span>条形码</span><b>{{ detail.barcode }}</b></div>
            <div class="info-row"><span>照片编号</span><b>第 {{ detail.seq }} 张</b></div>
            <div class="info-row"><span>备注</span><b>{{ detail.note || '无' }}</b></div>
            <div class="info-row"><span>拍摄时间</span><b>{{ fmt(detail.createdAt) }}</b></div>
          </div>
          <div class="modal-foot"><button class="btn btn-ghost" @click="detail = null">关闭</button></div>
        </div>
      </div>
    </div>
  `
};

/* ---------- 摄像头错误态 UI 映射 ----------
   键取自 renderer/camera-controller.js 各 setError() 调用点产出的 error.code（已逐项核实）。
   渲染层只按 code 决定「标题 / 次级说明 / 按钮组合」，controller 里不得出现任何中文 UI 文案。

   为什么不用 error.fatal / error.recoverable：
     - fatal 到不了渲染层 —— failOpen() / abandon() 在 setError() 时只透传
       {code, message, recoverable}，fatal 字段被丢弃；
     - recoverable 语义与 UI 需求不一致 —— PERMISSION_DENIED 在 classifyError 路径下
       recoverable:false，但用户改完系统权限后**必须**能点「重试」，否则只能重启软件。
   因此不可重试的集合由本表的 showRetry 显式表达，目前只有 SECURITY / UNSUPPORTED。 */
const CAM_ERR_UI = {
  PERMISSION_DENIED: {
    title: '摄像头权限被拒绝，无法取景',
    sub: '请到 Windows「设置 → 隐私和安全性 → 相机」允许本程序访问摄像头，保存后回到本页点「重试」。',
    showRetry: true,
    showPrivacy: true
  },
  NO_DEVICE: {
    title: '未检测到摄像头设备',
    sub: '请确认摄像头已插好、在「设备管理器」中未被禁用；外接摄像头请换一个 USB 口后再试。',
    showRetry: true,
    showPrivacy: false
  },
  DEVICE_BUSY: {
    title: '摄像头被其他程序占用或未就绪',
    sub: '相机、企业微信、钉钉、腾讯会议等可能正在使用它；请关闭后重试，也可换一个摄像头。',
    showRetry: true,
    showPrivacy: false
  },
  OPEN_TIMEOUT: {
    title: '摄像头初始化超时（超过 8 秒没有响应）',
    sub: '多为设备被占用或驱动未就绪，请重试；反复失败请重启本程序或电脑。',
    showRetry: true,
    showPrivacy: false
  },
  PLAY_TIMEOUT: {
    title: '摄像头画面播放超时',
    sub: '取流成功但画面迟迟未出，通常是驱动未就绪或被其他程序占用，请关闭占用程序后重试。',
    showRetry: true,
    showPrivacy: false
  },
  PLAY_FAIL: {
    title: '摄像头画面播放失败',
    sub: '画面未能启动，可能被其他程序抢占，请关闭占用程序或换一个摄像头后重试。',
    showRetry: true,
    showPrivacy: false
  },
  NO_FRAME: {
    title: '摄像头未输出画面',
    sub: '设备已连接但没有帧数据，请检查连接线与 USB 供电后重试。',
    showRetry: true,
    showPrivacy: false
  },
  NO_TRACK: {
    title: '摄像头未返回视频轨道',
    sub: '设备可能被禁用或驱动异常，请在「设备管理器」中确认后重试。',
    showRetry: true,
    showPrivacy: false
  },
  RETRY_EXHAUSTED: {
    title: '摄像头信号中断，自动重连未成功',
    sub: '请检查摄像头连接线与 USB 供电，然后重试；长期失败请联系维护并提供摄像头日志。',
    showRetry: true,
    showPrivacy: false
  },
  FLAP_STORM: {
    title: '摄像头反复中断，已停止自动重连',
    sub: '短时间内多次闪断，多为接触不良或供电不足，请检查线路后手动重试。',
    showRetry: true,
    showPrivacy: false
  },
  OVERCONSTRAINED: {
    title: '当前摄像头不支持所选参数，已自动降级重试',
    sub: '若仍失败，请在上方的设备下拉中换一个摄像头试试。',
    showRetry: true,
    showPrivacy: false
  },
  SECURITY: {
    title: '当前环境不允许调用摄像头',
    sub: '通常是运行环境的版本或安全策略限制，请联系设备安装方处理。',
    showRetry: false,
    showPrivacy: false
  },
  UNSUPPORTED: {
    title: '当前环境不支持摄像头调用',
    sub: '缺少必要的浏览器接口，请联系设备安装方升级运行环境。',
    showRetry: false,
    showPrivacy: false
  },
  UNKNOWN: {
    title: '无法打开摄像头',
    sub: '请重试；若持续失败请联系维护并提供摄像头日志路径。',
    showRetry: true,
    showPrivacy: false
  }
};

/* ---------- 客户端 · 拍照页（最大分辨率 + 空格拍摄 + 连拍批量保存） ---------- */
const CapturePage = {
  props: { token: { type: String, required: true } },
  setup(props) {
    const stream = Vue.ref(null);
    const devices = Vue.ref([]);
    const deviceId = Vue.ref('');
    const cameraError = Vue.ref('');
    const resolution = Vue.ref('');
    const shots = Vue.ref([]); // 待保存的照片队列（dataURL）
    const barcode = Vue.ref('');
    const note = Vue.ref('');
    const saving = Vue.ref(false);
    const barcodeCount = Vue.ref(null);
    const videoEl = Vue.ref(null);
    const barcodeEl = Vue.ref(null);
    const ready = Vue.ref(false); // 条码已就绪、处于可拍摄状态
    // 摄像头按需占用：空闲自动休眠释放设备，扫码/按键/点击时唤醒。
    // 默认空闲 3 分钟释放；测试可通过 window.__xqyCamIdleMs 覆盖时长。
    const sleeping = Vue.ref(false); // 摄像头已休眠（已释放占用）
    const camState = Vue.ref('UNINIT'); // UNINIT / STARTING / LIVE / DEGRADED / SLEEPING / ERROR
    const camHint = Vue.ref('摄像头准备中…'); // 非错误态的取景区提示
    const camPrivacy = Vue.ref(false); // 权限类错误：显示「去系统设置开启摄像头」
    // 错误码（controller.getError().code），驱动错误态 UI 的按钮组合（见 CAM_ERR_UI）
    const camErrCode = Vue.ref('');
    const CAM_IDLE_DEFAULT_MS = 180000;
    // 取景区几何自适应：由 JS 实测后写入 .camera-box 的行内 CSS 变量，
    // 取代原来写死的 aspect-ratio:4/3 与 max-height:68vh
    const camAr = Vue.ref(''); // --cam-ar，形如 '1280 / 720'
    const camMaxH = Vue.ref(0); // --cam-max-h，单位 px

    // 错误态 UI：按错误码取为我们预先定义好的文案与按钮组合，取不到时一律回退 UNKNOWN
    const camErr = Vue.computed(() => {
      const c = camErrCode.value;
      return (c && CAM_ERR_UI[c]) || null;
    });

    function camIdleMs() {
      const v = Number(window.__xqyCamIdleMs);
      return v >= 1000 ? v : CAM_IDLE_DEFAULT_MS;
    }

    // ---------- 摄像头日志：优先落盘到主进程，IPC 不可用时静默降级 ----------
    // 写日志失败绝不能影响拍照，因此整段包在 try 里
    function camLog(level, event, fields) {
      try {
        if (window.api && typeof window.api.cameraLog === 'function') {
          const p = window.api.cameraLog({ level, event, fields: fields || {} });
          if (p && typeof p.catch === 'function') p.catch(() => {});
          return;
        }
      } catch (e) {
        /* 主进程日志通道不可用时静默降级，不抛错 */
      }
      try {
        console.log('[camera]', level, event, fields || {});
      } catch (e2) { /* 忽略 */ }
    }

    // 黑帧采样：把画面中心 size×size 画到离屏 canvas 取灰度样本（不改动出图链路）
    function sampleFrame(video, size) {
      try {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (!vw || !vh) return null;
        const side = Math.max(1, Math.min(size || 64, vw, vh));
        const canvas = document.createElement('canvas');
        canvas.width = side;
        canvas.height = side;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, Math.floor((vw - side) / 2), Math.floor((vh - side) / 2), side, side, 0, 0, side, side);
        return window.CameraController
          ? window.CameraController.sampleCenterGray(ctx.getImageData(0, 0, side, side), side)
          : null;
      } catch (e) {
        return null;
      }
    }

    // ---------- 摄像头生命周期控制器（renderer/camera-controller.js）----------
    // 取流 / 释放 / 重连 / 拍照闸门全部收敛到 controller：
    // 7 个并发入口（mount、重试、切换设备、空格、扫码、窗口可见、拍照）都只是转发，
    // 由 controller 用 startSeq 令牌保证「至多一条活跃流」（RC-1a / RC-1b）
    const controller =
      window.CameraController && typeof window.CameraController.createCameraController === 'function'
        ? window.CameraController.createCameraController({
            mediaDevices: navigator.mediaDevices,
            videoGetter: () => videoEl.value,
            frameSampler: sampleFrame,
            blackFrameEnabled: () => window.__xqyBlackFrame !== false,
            // 系统授权预检（R10）：接口不存在时不注入，controller 一律放行
            checkAccess:
              window.api && typeof window.api.cameraAccess === 'function'
                ? () => window.api.cameraAccess()
                : null,
            openPrivacy:
              window.api && typeof window.api.openCameraPrivacy === 'function'
                ? () => window.api.openCameraPrivacy()
                : null,
            // 分辨率记忆：controller 是纯逻辑模块（要能在 Node 下用假对象单测），
            // 不碰 localStorage，读写由这里注入；存档按 deviceId 分开，切换摄像头不串档
            loadResolutionPref: (id) => readResPref(id),
            saveResolutionPref: (id, val) => writeResPref(id, val),
            log: camLog
          })
        : null;

    let idleTimer = null;
    let wasRunningWhenHidden = false; // 因窗口隐藏而释放时，回到前台自动恢复
    let devicesAfterAuthLoaded = false; // 授权后需重枚举一次才能拿到真实 deviceId（RC-4）
    let offWindowState = null; // 主进程窗口可见性订阅的取消函数

    const CAM_HINTS = {
      UNINIT: '摄像头未启动',
      STARTING: '摄像头准备中…',
      DEGRADED: '画面中断，正在自动恢复…',
      LIVE: '',
      SLEEPING: '摄像头已休眠（已释放占用）',
      ERROR: '摄像头不可用'
    };

    // ---------- 取景区几何自适应 ----------
    // 可用高度 = 视口底 − 取景区顶 − 操作条 − 卡片内边距 − 呼吸余量。
    // 之所以用 rect.top 而不是把上面各元素高度累加：rect.top 由前置兄弟元素决定，
    // 与本元素自身高度无关，因此可以反复调用而自洽（不会自我放大）。
    // 全部量都是 CSS px(=DIP)，DPI 缩放由浏览器自动换算，无需乘除任何系数。
    function measureCameraMaxH() {
      const v = videoEl.value;
      if (!v) return 0;
      const box = v.closest('.camera-box');
      const card = box ? box.closest('.card') : null;
      // .camera-bar 是 .camera-box 的兄弟节点（同在 .capture-main / .card 内）
      const bar = card ? card.querySelector('.camera-bar') : null;
      if (!box || !bar) return 0;
      const RESERVE = 16; // 下方呼吸余量，避免操作条紧贴视口底部
      const barH = bar.offsetHeight; // ≈48（.btn-shutter min-height:48）
      const barMt = parseFloat(getComputedStyle(bar).marginTop) || 12; // .camera-bar margin-top:12
      const padB = card ? parseFloat(getComputedStyle(card).paddingBottom) || 20 : 20; // .card padding:20
      const h = window.innerHeight - box.getBoundingClientRect().top - barH - barMt - padB - RESERVE;
      // 下限 300：再矮就没有取景意义，宁可让 .main 出现纵向滚动
      return Math.max(300, Math.round(h));
    }

    // DOM 变更后要在下一帧测量，否则拿到的是改动前的布局
    function syncCamMetrics() {
      Vue.nextTick(() => {
        try {
          camMaxH.value = measureCameraMaxH();
        } catch (e) {
          camMaxH.value = 0; // 测量失败时退回 var() 的 68vh 兜底
        }
      });
    }

    // 摄像头真实宽高比：必须在 loadedmetadata（或流就绪）之后才能读到 videoWidth/videoHeight
    function onVideoMeta() {
      const v = videoEl.value;
      if (!v || !v.videoWidth || !v.videoHeight) return;
      camAr.value = v.videoWidth + ' / ' + v.videoHeight;
      syncCamMetrics();
    }

    let camResizeTimer = null;
    function onWindowResize() {
      if (camResizeTimer) clearTimeout(camResizeTimer);
      camResizeTimer = setTimeout(() => {
        camResizeTimer = null;
        syncCamMetrics();
      }, 120);
    }
    let camRO = null; // ResizeObserver：侧栏折叠 / 主题切换 / 双栏断档切换等回流
    let camPostTimer = null; // 最大化 / 还原后 Chromium 尺寸稳定需要若干帧，延后再测一次

    // 同一错误码只弹一次 toast，避免摄像头闪断（FLAP_STORM 类）时反复打扰
    let lastToastCode = '';

    // controller 状态 → Vue 响应式状态：模板只消费这些 ref
    function syncCameraState() {
      if (!controller) return;
      const s = controller.getState();
      const err = controller.getError();
      camState.value = s;
      cameraError.value = err ? err.message : '';
      camErrCode.value = err && err.code ? err.code : '';
      camHint.value = err ? '' : CAM_HINTS[s] || '';
      // 错误首次出现时额外弹一次 toast：取景区可能因窗口较小而滚出视口，
      // 用户看不到覆盖层就不知道为什么拍不了照（同一错误码幂等，避免闪断风暴反复弹窗）
      if (camErrCode.value && s === 'ERROR') {
        if (lastToastCode !== camErrCode.value) {
          lastToastCode = camErrCode.value;
          const ui = CAM_ERR_UI[camErrCode.value] || CAM_ERR_UI.UNKNOWN;
          toast(ui.title + '｜' + ui.sub, 'error');
        }
      } else if (s === 'LIVE') {
        lastToastCode = ''; // 恢复正常后解除幂等锁，下次同类错误仍能提示
      }
      sleeping.value = s === 'SLEEPING';
      // 权限被拒（系统预检判死或 gUM 报 NotAllowed）时才给出系统设置入口
      camPrivacy.value = !!(err && (err.code === 'PERMISSION_DENIED' || err.privacy === true));
      // stream 仅用于「画面确实在显示」的判断，与 video.srcObject 始终同一对象
      stream.value = s === 'LIVE' || s === 'DEGRADED' ? controller.getStream() : null;
      const res = controller.getResolution();
      if (res && res.width) resolution.value = res.width + ' × ' + res.height;
      if (s === 'LIVE') {
        applyFocus(controller.getTrack());
        startFocusPulse(controller.getTrack());
        if (!devicesAfterAuthLoaded) {
          devicesAfterAuthLoaded = true;
          loadDevices(); // 授权后再枚举，deviceId / label 才有值
        }
        scheduleIdleSleep();
      } else {
        stopFocusPulse();
      }
    }

    if (controller) {
      controller.onStateChange(syncCameraState);
      controller.onError(syncCameraState);
      controller.onDevicesChange(() => {
        loadDevices();
      });
    }

    async function loadDevices() {
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        // 未授权时 deviceId/label 为空串，必须过滤，否则切换设备会 OverconstrainedError（RC-4）
        devices.value = list.filter((d) => d.kind === 'videoinput' && d.deviceId);
        if (devices.value.length && !devices.value.some((d) => d.deviceId === deviceId.value)) {
          deviceId.value = devices.value[0].deviceId;
        }
      } catch (e) {
        /* 忽略枚举失败 */
      }
    }

    // 应用连续自动对焦 + 近距对焦（拍衣物多为近景），不支持的设备静默忽略。
    // 支持焦点坐标的设备额外把焦点锁定在画面中心，并周期性触发一次单点对焦，
    // 防止摄像头对焦漂移或被意外切到手动模式导致偶发失焦。
    let focusTimer = null;

    async function applyFocus(track) {
      if (!track || !track.getCapabilities || !track.applyConstraints) return;
      let cap = {};
      try {
        cap = track.getCapabilities();
      } catch (e) {
        return;
      }
      const adv = {};
      if (cap.focusMode && cap.focusMode.includes('continuous')) adv.focusMode = 'continuous';
      // 不再无条件取 min：多数设备 min 为 0（最近对焦距离），拍远景会永久失焦（RC-8）
      if (cap.focusDistance && typeof cap.focusDistance.min === 'number' && cap.focusDistance.min > 0) {
        adv.focusDistance = cap.focusDistance.min;
      }
      if (cap.pointsOfInterest) {
        adv.pointsOfInterest = [
          {
            x: Math.round((cap.pointsOfInterest.width || 1000) / 2),
            y: Math.round((cap.pointsOfInterest.height || 1000) / 2)
          }
        ];
      }
      if (Object.keys(adv).length) {
        try {
          // 部分 UVC 摄像头 applyConstraints 会永不 settle，必须加超时，避免对焦流程卡死
          await Promise.race([
            track.applyConstraints({ advanced: [adv] }),
            new Promise((r) => setTimeout(r, 1500))
          ]);
        } catch (e) {
          /* 部分设备不支持，保持默认对焦 */
        }
      }
    }

    // 周期对焦脉冲：定时触发一次单点对焦后恢复连续对焦，
    // 纠正部分摄像头长时间待机后出现的对焦漂移。
    // RC-8：仅在真正出画（LIVE）且窗口可见时执行，连续失败 2 次即停，
    // 避免部分 UVC 摄像头在 single-shot 期间停输出造成周期黑帧。
    let focusFail = 0;
    // 对焦脉冲进行中标记：部分 UVC 摄像头在 single-shot 期间会停输出（周期黑帧），
    // 拍照前必须等这个窗口过去再采样，否则把「脉冲黑帧」误判成「镜头被遮挡」而拒拍
    let focusPulseBusy = false;

    function startFocusPulse(track) {
      stopFocusPulse();
      if (!track) return; // 只依赖 track，不再依赖 videoEl 是否已挂载
      focusFail = 0;
      focusTimer = setInterval(async () => {
        if (!captureAlive || !track || track.readyState !== 'live') {
          stopFocusPulse();
          return;
        }
        if (document.hidden || camState.value !== 'LIVE') return;
        focusPulseBusy = true;
        try {
          // 对焦脉冲同样可能永不 settle，加超时跳过，避免周期黑帧或卡死
          await Promise.race([
            track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] }),
            new Promise((r) => setTimeout(r, 1500))
          ]);
          await new Promise((r) => setTimeout(r, 350));
          await Promise.race([
            track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }),
            new Promise((r) => setTimeout(r, 1500))
          ]);
          focusFail = 0;
        } catch (e) {
          focusFail++;
          if (focusFail >= 2) stopFocusPulse();
        } finally {
          // 无论成功失败都要解除：否则一次异常会把后续所有拍照永久卡在等待里
          focusPulseBusy = false;
        }
      }, 20000);
    }

    // 拍照前等对焦脉冲结束，最多等 maxMs。
    // 超时不再等——宁可采到黑帧再走复采，也不能把拍照入口卡死。
    function waitPulseClear(maxMs) {
      if (!focusPulseBusy) return Promise.resolve(false);
      const t0 = Date.now();
      return new Promise((resolve) => {
        const tick = () => {
          if (!focusPulseBusy || Date.now() - t0 >= maxMs) return resolve(focusPulseBusy);
          setTimeout(tick, 60);
        };
        setTimeout(tick, 60);
      });
    }

    function stopFocusPulse() {
      if (focusTimer) {
        clearInterval(focusTimer);
        focusTimer = null;
      }
    }

    function clearIdleTimer() {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    }

    // 空闲计时：超时且未休眠时释放摄像头；有操作时重新计时
    function scheduleIdleSleep() {
      clearIdleTimer();
      if (!captureAlive || !controller) return;
      const s = controller.getState();
      if (s === 'SLEEPING' || s === 'UNINIT' || s === 'ERROR') return;
      idleTimer = setTimeout(() => {
        if (!captureAlive || document.hidden) return;
        const st = controller.getState();
        if (st !== 'LIVE' && st !== 'DEGRADED' && st !== 'STARTING') return;
        if (controller.sleep('idle')) {
          toast('摄像头空闲超时，已释放占用；扫码或按空格即可继续拍', 'info');
        }
      }, camIdleMs());
    }

    function bumpActivity() {
      if (!captureAlive || !controller || sleeping.value) return;
      scheduleIdleSleep();
    }

    // 释放摄像头：停止取流并进入休眠态（空闲超时 / 窗口隐藏 / 手动释放）
    // controller.sleep() 会作废在途 gUM，休眠期间到达的流会被 stop（RC-1a）
    function sleepCamera(reason) {
      if (!controller) return;
      controller.sleep(reason || 'manual');
    }

    // 窗口最小化 / 隐藏时释放，回到前台自动恢复
    function onVisibilityChange() {
      if (!captureAlive || !controller) return;
      if (document.hidden) {
        const s = controller.getState();
        if (s === 'LIVE' || s === 'DEGRADED' || s === 'STARTING') {
          wasRunningWhenHidden = true;
          controller.sleep('hidden');
        }
      } else if (wasRunningWhenHidden) {
        wasRunningWhenHidden = false;
        controller.wake();
      } else {
        wasRunningWhenHidden = false;
      }
    }

    // 主进程推送的窗口可见性（比 document.hidden 可靠；未接通时该函数不会被调用）
    function onWindowState(ws) {
      if (!captureAlive || !controller || !ws) return;
      camLog('info', 'CAM_WINDOW_STATE', { reason: ws.visible === false ? 'hidden' : 'visible' });
      if (ws.visible === false) {
        const s = controller.getState();
        if (s === 'LIVE' || s === 'DEGRADED' || s === 'STARTING') {
          wasRunningWhenHidden = true;
          controller.sleep('hidden');
        }
      } else if (wasRunningWhenHidden) {
        wasRunningWhenHidden = false;
        controller.wake();
      }
    }

    // 打开摄像头：所有入口（mount / 重试 / 切换设备）都只是转发给 controller。
    // controller 内部用 startSeq 令牌保证并发只保留 1 条活跃流（RC-1b）
    function startCamera(id) {
      if (!controller) return Promise.resolve(false);
      return controller.open(typeof id === 'string' ? id : deviceId.value || '');
    }

    // 覆盖层「重试」：人工介入，attempt 归零后重开
    function retryCamera() {
      if (!controller) return;
      camHint.value = '摄像头准备中…';
      controller.open(deviceId.value || '');
    }

    // R10：跳转系统摄像头隐私设置；平台不支持（ok:false）时降级为文案引导
    function openPrivacySettings() {
      const done = controller ? controller.openPrivacySettings() : Promise.resolve(false);
      Promise.resolve(done)
        .then((ok) => {
          if (!ok) toast('请在系统「隐私和安全性 → 相机」中允许本程序使用摄像头，再点「重试」', 'info');
        })
        .catch(() => {
          toast('请在系统「隐私和安全性 → 相机」中允许本程序使用摄像头，再点「重试」', 'info');
        });
    }

    // 切换摄像头：先清掉降级标志再按新 deviceId 取流
    function switchDevice(id) {
      if (!controller) return;
      controller.open(id || '');
    }

    // 唤醒：扫码 / 空格 / 点击 / 窗口恢复可见都会走到这里，controller 幂等
    function wakeCamera() {
      if (!controller) return;
      controller.wake();
    }

    // 拍照闸门被拦时的可执行提示（I5）
    const CAPTURE_BLOCK_MSG = {
      UNINIT: '摄像头未启动，请稍候或点「重试」',
      STARTING: '摄像头正在启动，画面就绪后再拍',
      DEGRADED: '画面中断，正在自动恢复，请稍候',
      SLEEPING: '摄像头已休眠，正在唤醒，请稍候再按空格拍摄',
      ERROR: '摄像头不可用，请检查设备后点「重试」',
      LIVE: '画面未就绪，请稍候'
    };

    // 拍照进行中标记：复采/等脉冲期间禁止重入，否则连拍按空格会并发进入同一张照片流程
    let capturing = false;

    async function capture() {
      if (saving.value || capturing) return;
      if (!controller) {
        toast('摄像头模块未加载，请重启程序', 'error');
        return;
      }
      const st = controller.getState();
      if (st === 'SLEEPING') {
        controller.wake();
        toast(CAPTURE_BLOCK_MSG.SLEEPING, 'info');
        return;
      }
      capturing = true;
      try {
        // I5：仅 LIVE 允许拍照；STARTING / DEGRADED / ERROR 一律拒绝并给出可执行提示。
        // 先复检一次再拒绝：track 短暂 mute（对焦脉冲 / 分辨率重协商期间常见）是一次性的，
        // 立刻判死会让用户觉得「明明看得见画面却拍不了」。
        if (!controller.canCapture()) {
          await new Promise((r) => setTimeout(r, 260));
          if (!controller.canCapture()) {
            // 复检后重新取状态：canCapture() 内部可能已把 LIVE 降级为 DEGRADED，
            // 用入口处那个 st 会选错文案（旧实现正是拿过期状态提示）
            const st2 = controller.getState();
            const err = controller.getError();
            const msg = st2 === 'ERROR' && err ? '摄像头不可用：' + err.message : CAPTURE_BLOCK_MSG[st2] || CAPTURE_BLOCK_MSG.LIVE;
            camLog('warn', 'CAM_CAPTURE_REJECT', { reason: st2, state: st2, retried: true });
            toast(msg, 'error');
            return;
          }
        }
        // 对焦脉冲期间部分 UVC 摄像头会停输出（周期黑帧），等它结束再采样
        await waitPulseClear(1200);
        const v = videoEl.value;
        if (!v || !v.videoWidth) {
          toast('摄像头画面未就绪', 'error');
          return;
        }
        // 黑帧检测：镜头被遮挡 / 信号中断时拒收，杜绝黑照片入库（可用 window.__xqyBlackFrame=false 关闭）。
        // 用带复采的 confirmBlackFrame：只有「持续全黑」才拒，瞬时黑帧（脉冲/自动曝光）自动放行。
        const black = controller.confirmBlackFrame
          ? await controller.confirmBlackFrame(v)
          : controller.isBlackFrame(v);
        if (black) {
          // 拒收明细（复采次数、预算）由 controller 侧 CAM_CAPTURE_REJECT 记录，此处只做界面提示
          toast('画面持续全黑：请检查镜头是否被遮挡或光线不足，调整后再拍', 'error');
          return;
        }
        // 拍摄操作说明用户正在使用摄像头，重置空闲计时，防止键盘操作路径下误休眠
        bumpActivity();
        // 时间取拍摄这一刻：连拍时每张各自记录自己的拍摄时间，
        // 不能等到统一保存时才取时间，否则连拍的多张会显示同一时刻
        const shotAt = new Date();
        // 按摄像头当前（最大）分辨率绘制，不做缩放
        const canvas = document.createElement('canvas');
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(v, 0, 0);
        // 右上角烧录拍照时间水印：存进照片本身，导出/打印后依然可见
        drawTimeWatermark(ctx, canvas.width, canvas.height, watermarkTimeText(shotAt));
        shots.value.push(canvas.toDataURL('image/jpeg', 0.92));
        if (!resolution.value) resolution.value = v.videoWidth + ' × ' + v.videoHeight;
        camLog('info', 'CAM_CAPTURE_OK', { res: { w: canvas.width, h: canvas.height }, queue: shots.value.length });
      } finally {
        // 任何出口都要解锁：否则一次拒拍会把拍照入口永久锁死
        capturing = false;
      }
    }

    function removeShot(i) {
      shots.value.splice(i, 1);
    }

    function clearShots() {
      shots.value = [];
    }

    async function checkBarcodeCount() {
      if (!barcode.value.trim()) {
        barcodeCount.value = null;
        return;
      }
      const r = await window.api.listRecords(props.token, { barcode: barcode.value.trim(), silent: true, pageSize: 1 });
      if (r.ok) barcodeCount.value = r.data.total;
    }

    // ---------- 条码纠错（扫码枪误读防护） ----------
    // barcodeWarn：{ suspicious:[可疑字符], cleaned:清洗建议, similar:[相似已有条码] } 或 null
    const barcodeWarn = Vue.ref(null);
    // 扫码锁定：回车确认条码后锁住输入框（防误触/误扫改码），保存全部照片后自动解锁，也可手动解锁
    const barcodeLocked = Vue.ref(false);
    let similarTimer = null;
    async function refreshBarcodeWarn(val) {
      const v = String(val || '').trim();
      if (!v) { barcodeWarn.value = null; return; }
      // 可疑字符：条码合法集（字母/数字/下划线/连字符/中文）之外的都算，例如误读插入的「:」
      const suspicious = [];
      let stripped = '';
      // cleaned 专指「通过格式校验的修复建议」，不是简单的去字符结果
      let cleaned = '';
      for (const ch of v) {
        if (/[0-9A-Za-z_\-]/.test(ch) || /[\u4e00-\u9fa5]/.test(ch)) stripped += ch;
        else if (!suspicious.includes(ch)) suspicious.push(ch);
      }
      // 相似条码 + 格式画像：与库中已有条码比对（离线/接口失败时静默跳过）
      let formatIssues = [];
      let repairNote = '';
      try {
        if (v.length >= 6 && window.api && window.api.listBarcodes) {
          const r = await window.api.listBarcodes(props.token);
          if (r && r.ok && Array.isArray(r.data)) {
            // 参照集只用「干净」条码：含可疑字符的历史条码本身大概率是误存错码，
            // 不配当格式/相似的参照（否则错码存过一次就把自己洗白）
            const cleanKnown = r.data.filter((k) => !hasBarcodeSuspicious(k));
            const vClean = hasBarcodeSuspicious(v) ? stripped : v;
            // 条码（清洗后）已精确存在于库中且本身无可疑字符：不做相似/格式预警
            // （重复存档自有「已存档 N 张」提示；顺序连号天然编辑距离 1，逐条预警只是噪声）。
            // 带可疑字符的条码不受此豁免——永远预警。
            if (!cleanKnown.includes(vClean)) {
              // 格式画像纠错：只对照库中历史条码的规律（长度 + 字符集）
              const profile = barcodeFormatProfile(cleanKnown);
              formatIssues = barcodeFormatIssues(vClean, profile);
              // 修复式纠错：按库内字符集做近形修正（b→6、O→0…），
              // 修复值必须通过长度/字符集校验才作为建议，绝不推荐明知不合规的值
              //（如「应为 12 位」时绝不建议 11 位码）
              if (profile) {
                const rep = barcodeRepair(vClean, profile);
                if (rep.value !== vClean && !barcodeFormatIssues(rep.value, profile).length) {
                  cleaned = rep.value;
                  repairNote = rep.note;
                }
              } else if (suspicious.length) {
                // 库中样本不足、无可靠规律时沿用旧行为：仅去除可疑字符，不承诺符合规律
                cleaned = stripped;
              }
            }
          }
        }
      } catch (e) { /* 忽略 */ }
      barcodeWarn.value = (suspicious.length || formatIssues.length)
        ? { suspicious, cleaned, repairNote, formatIssues }
        : null;
      // 锁定状态下扫入了带可疑字符的错码：自动解锁，让用户能直接改码，无需先点解锁
      if (barcodeWarn.value && barcodeWarn.value.suspicious.length && barcodeLocked.value) {
        barcodeLocked.value = false;
      }
    }
    function applyCleaned() {
      if (barcodeWarn.value && barcodeWarn.value.cleaned) barcode.value = barcodeWarn.value.cleaned;
    }
    function applySimilar(code) {
      if (code) barcode.value = String(code);
    }
    function unlockBarcode() {
      barcodeLocked.value = false;
    }

    // 扫码枪扫入后会自动发送回车：核对条码并退出输入框，立即进入拍摄状态
    function onBarcodeDone(onlyLock) {
      checkBarcodeCount();
      ready.value = !!barcode.value.trim();
      // v1.1.15：不再自动锁定——锁定曾导致扫码一次后无法输入（现场判定为严重 bug）；
      if (barcodeEl.value && document.activeElement === barcodeEl.value) barcodeEl.value.blur();
      // 扫码/确认条码说明用户正在操作，重置空闲计时防止键盘路径下误休眠
      bumpActivity();
    }

    async function saveAll() {
      if (saving.value) return;
      if (!barcode.value.trim()) {
        toast('请填写衣物条形码', 'error');
        return;
      }
      // 保存操作说明用户正在使用系统，重置空闲计时防止保存过程中摄像头误休眠
      bumpActivity();
      // 保存前条码纠错确认：有可疑字符或相似条码时必须过一道人工确认，防止误读条码入库
      const warn = barcodeWarn.value;
      if (warn) {
        const probs = [];
        if (warn.suspicious.length) probs.push('含有可疑字符 ' + warn.suspicious.join(' '));
        if (warn.formatIssues && warn.formatIssues.length) probs.push('不符合历史条码格式：' + warn.formatIssues.join('、'));
        if (warn.cleaned) {
          const useClean = await showConfirm({
            title: '条码纠错提醒',
            message: '当前条码' + probs.join('，且') + '。\n\n建议条码：' + warn.cleaned,
            confirmText: '使用清洗后条码',
            cancelText: '返回修改'
          });
          if (!useClean) return;
          barcode.value = warn.cleaned;
        } else {
          const go = await showConfirm({
            title: '条码纠错提醒',
            message: '当前条码' + probs.join('，且') + '。',
            confirmText: '仍按当前条码保存',
            cancelText: '返回修改'
          });
          if (!go) return;
        }
      }
      if (!shots.value.length) {
        toast('请先拍摄照片（空格键或点击「📸 拍照」）', 'error');
        return;
      }
      saving.value = true;
      try {
        let ok = 0;
        let lastSeq = 0;
        for (const s of shots.value) {
          const r = await window.api.addRecord(props.token, {
            imageData: s,
            barcode: barcode.value.trim(),
            note: note.value.trim()
          });
          if (r.ok) {
            ok++;
            lastSeq = r.data.seq;
          } else {
            break;
          }
        }
        if (ok === shots.value.length) {
          toast('已保存 ' + ok + ' 张：条码 ' + barcode.value.trim() + '，编至第 ' + lastSeq + ' 张', 'success');
          shots.value = [];
          note.value = '';
          // 保存完成后清空条码、解锁输入框，焦点回到条码框等待扫下一件
          barcode.value = '';
          ready.value = false;
          barcodeCount.value = null;
          barcodeLocked.value = false;
          focusBarcode();
        } else if (ok > 0) {
          shots.value = shots.value.slice(ok);
          barcodeCount.value = lastSeq;
          toast('已保存 ' + ok + ' 张，剩余照片保存失败，请重试', 'error');
        } else {
          toast('保存失败，请重试', 'error');
          barcodeLocked.value = false;
        }
      } catch (e) {
        toast('保存失败：' + (e.message || e), 'error');
      } finally {
        saving.value = false;
      }
    }

    // 快捷键：空格拍摄、回车保存；条码框内回车 = 确认条码并进入拍摄状态
    function onKeydown(e) {
      // 输入法组合态（拼音候选确认等）一律放行：拦截 Enter 会强杀组合并失焦，
      // 之后打字失灵，表现为「删掉内容后再也打不出字」（keyCode 229 为组合态 keydown 兼容标志）。
      if (e.isComposing || e.keyCode === 229) return;
      const t = e.target;
      const inBarcode = t === barcodeEl.value;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
        if (inBarcode && e.key === 'Enter') {
          e.preventDefault();
          onBarcodeDone();
        }
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) capture();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        saveAll();
      }
    }

    // 组件是否仍在页面上：卸载后定时器不能再抢焦点
    let captureAlive = true;

    function focusBarcode() {
      Vue.nextTick().then(() => {
        if (!captureAlive || !barcodeEl.value || !document.contains(barcodeEl.value)) return;
        barcodeEl.value.focus();
        // 个别环境下一次聚焦会被抢占，短延时再补一次。
        // 只在「当前没有任何输入框获得焦点」时才补，
        // 否则会把用户刚点开的备注框等焦点抢回条码框，表现为其他输入框点不动。
        setTimeout(() => {
          if (!captureAlive) return;
          const el = barcodeEl.value;
          if (!el || !document.contains(el)) return;
          const active = document.activeElement;
          const nothingFocused =
            !active || active === document.body || active === document.documentElement || !document.contains(active);
          if (nothingFocused) el.focus();
        }, 80);
      });
    }

    Vue.watch(barcode, (v) => {
      const s = String(v == null ? '' : v);
      // 自动清理：仅去除空白与控制字符（扫码枪常见尾部噪声），不改动其它字符
      const cleanedSpace = s.replace(/[\x00-\x1f\x7f\s]+/g, '');
      if (cleanedSpace !== s) {
        barcode.value = cleanedSpace;
        return;
      }
      if (!s.trim()) {
        ready.value = false;
        barcodeCount.value = null;
        barcodeWarn.value = null;
      } else if (sleeping.value) {
        // 扫码/输入条码代表马上要拍：静默唤醒摄像头
        wakeCamera();
      }
      // 条码纠错检查防抖（避免逐键触发接口比对）
      if (similarTimer) clearTimeout(similarTimer);
      similarTimer = setTimeout(() => refreshBarcodeWarn(barcode.value), 250);
    });

    Vue.onMounted(() => {
      captureAlive = true;
      window.addEventListener('keydown', onKeydown);
      window.addEventListener('pointerdown', bumpActivity, true);
      document.addEventListener('visibilitychange', onVisibilityChange);
      // 主进程窗口可见性推送（未接通该 IPC 时静默跳过，继续依赖 document.hidden）
      if (window.api && typeof window.api.onWindowState === 'function') {
        try {
          offWindowState = window.api.onWindowState(onWindowState);
        } catch (e) {
          offWindowState = null;
        }
      }
      focusBarcode();
      if (!controller) {
        cameraError.value = '摄像头模块未加载，请重启程序';
        camState.value = 'ERROR';
        return;
      }
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        // mount 内部即以 startSeq 令牌发起取流；设备列表等出画（授权后）再枚举
        controller.mount(() => videoEl.value);
      } else {
        cameraError.value = '当前环境不支持摄像头调用';
        camState.value = 'ERROR';
        camHint.value = '';
        camErrCode.value = 'UNSUPPORTED';
      }
      // ---------- 取景区尺寸实测：挂载后立即首测 + 注册三个重算时机 ----------
      syncCamMetrics();
      if (videoEl.value && typeof videoEl.value.addEventListener === 'function') {
        videoEl.value.addEventListener('loadedmetadata', onVideoMeta);
      }
      window.addEventListener('resize', onWindowResize);
      // ResizeObserver 覆盖 resize 事件不触发的回流（侧栏折叠、主题切换、断点切换）
      if (typeof ResizeObserver === 'function') {
        try {
          camRO = new ResizeObserver(() => syncCamMetrics());
          const mainEl = videoEl.value && videoEl.value.closest ? videoEl.value.closest('.capture-main') : null;
          if (mainEl) camRO.observe(mainEl);
          else camRO.observe(document.body);
        } catch (e) {
          camRO = null;
        }
      }
      // 最大化 / 还原后 Chromium 的视口尺寸要过几帧才稳定，补测一次修正 --cam-max-h
      camPostTimer = setTimeout(syncCamMetrics, 260);
    });

    Vue.onUnmounted(() => {
      captureAlive = false;
      window.removeEventListener('keydown', onKeydown);
      window.removeEventListener('pointerdown', bumpActivity, true);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      clearIdleTimer();
      if (similarTimer) clearTimeout(similarTimer);
      stopFocusPulse();
      if (offWindowState) {
        try { offWindowState(); } catch (e) { /* 忽略 */ }
        offWindowState = null;
      }
      // 取景区几何自适应监听器必须全部回收，否则卸载后继续测量会拿到已移除的节点
      if (videoEl.value && typeof videoEl.value.removeEventListener === 'function') {
        videoEl.value.removeEventListener('loadedmetadata', onVideoMeta);
      }
      window.removeEventListener('resize', onWindowResize);
      if (camResizeTimer) {
        clearTimeout(camResizeTimer);
        camResizeTimer = null;
      }
      if (camPostTimer) {
        clearTimeout(camPostTimer);
        camPostTimer = null;
      }
      if (camRO) {
        try { camRO.disconnect(); } catch (e) { /* 忽略 */ }
        camRO = null;
      }
      // I7：controller.unmount() 返回后不存在任何 live track，
      // 在途 gUM 的结果也会因令牌作废被 stop 并记 CAM_LEAK_GUARD
      if (controller) controller.unmount();
    });

    return {
      stream, devices, deviceId, cameraError, resolution, shots,
      barcode, note, saving, barcodeCount, videoEl, barcodeEl, ready,
      barcodeWarn, applyCleaned, applySimilar, barcodeLocked, unlockBarcode,
      sleeping, camState, camHint, camPrivacy, camErr, camErrCode, camAr, camMaxH,
      startCamera, retryCamera, switchDevice, wakeCamera, sleepCamera, capture, removeShot, clearShots, saveAll, checkBarcodeCount, onBarcodeDone, openPrivacySettings
    };
  },
  template: `
    <div>
      <div class="page-head">
        <h2>衣物拍照</h2>
        <p>扫码后自动进入拍摄状态，可连续拍多张、全部保存后自动编号；快捷键：<b>空格 = 拍照</b>，<b>回车 = 保存</b></p>
      </div>

      <div class="capture-layout">
        <div class="card capture-main">
          <div class="card-title">
            📷 摄像头取景
            <span v-if="resolution && !sleeping" class="tag tag-green" style="margin-left:8px">分辨率 {{ resolution }}</span>
          </div>
          <!-- --cam-ar / --cam-max-h 由 JS 实测后写入（见 setup 的 measureCameraMaxH / onVideoMeta）。
               --cam-ar 必须始终输出合法值：空字符串会让整条 aspect-ratio 声明变成
               invalid at computed-value time，var() 的 fallback 也救不回来，会退化成 auto。 -->
          <div class="camera-box"
               :style="{ '--cam-ar': camAr || '4 / 3', '--cam-max-h': (camMaxH > 0 ? camMaxH + 'px' : '68vh') }">
            <video ref="videoEl" autoplay playsinline muted></video>
            <div v-if="camState !== 'LIVE'" class="camera-overlay" :class="{ error: !!cameraError }">
              <template v-if="camState === 'SLEEPING'">
                <div class="camera-sleep-title">摄像头已休眠（已释放占用）</div>
                <div class="camera-sleep-sub">空闲超时或窗口最小化时自动释放设备</div>
                <button class="btn btn-primary" @click="wakeCamera">唤醒拍摄</button>
              </template>
              <template v-else>
                <div class="camera-overlay-title">{{ camErr ? camErr.title : (cameraError || camHint) }}</div>
                <div v-if="camErr" class="camera-sleep-sub">{{ camErr.sub }}</div>
                <div v-else class="camera-sleep-sub">扫码或按空格键也会自动唤醒</div>
                <div class="camera-overlay-actions">
                  <button v-if="camErr && camErr.showPrivacy" class="btn btn-primary" @click="openPrivacySettings">去系统设置开启摄像头</button>
                  <button v-if="camErr && camErr.showRetry" class="btn btn-primary" @click="retryCamera">重试</button>
                  <select v-if="camErr && camErr.showRetry && devices.length > 1"
                          class="camera-dev-switch"
                          :value="deviceId"
                          @change="switchDevice($event.target.value)">
                    <option v-for="(d, i) in devices" :key="d.deviceId || i" :value="d.deviceId">{{ d.label || ('摄像头 ' + (i + 1)) }}</option>
                  </select>
                </div>
              </template>
            </div>
          </div>
          <div class="camera-bar">
            <select v-if="devices.length > 1" v-model="deviceId" @change="switchDevice(deviceId)">
              <option v-for="(d, i) in devices" :key="d.deviceId || i" :value="d.deviceId">
                {{ d.label || ('摄像头 ' + (i + 1)) }}
              </option>
            </select>
            <button class="btn btn-primary btn-shutter" :disabled="camState !== 'LIVE'" @click="capture">📸 拍照（空格）</button>
            <button v-if="camState !== 'SLEEPING' && camState !== 'UNINIT'" class="btn btn-ghost" @click="sleepCamera('manual')">释放摄像头</button>
          </div>
        </div>

        <div class="card capture-side">
          <div class="card-title">🧾 存档信息</div>

          <label>衣物条形码 *</label>
          <div style="display:flex;gap:8px;align-items:center">
            <input v-model="barcode" ref="barcodeEl" :disabled="barcodeLocked" placeholder="扫码枪扫入或手动输入条形码，回车确认" @keyup.enter="onBarcodeDone(true)" @change="onBarcodeDone(false)" />
            <button v-if="barcodeLocked" class="btn btn-ghost btn-sm" style="flex-shrink:0" @click="unlockBarcode">🔓 解锁修改</button>
          </div>
          <div v-if="ready && stream" class="barcode-count ok">条码已就绪，按空格键拍摄、回车保存全部</div>
          <div v-if="barcodeCount" class="barcode-count">该条码已存档 {{ barcodeCount }} 张，本次保存将接着编号</div>
          <div v-if="barcodeWarn" class="barcode-warn">
            <div class="bw-line">
              ⚠ 条码纠错：
              <template v-if="barcodeWarn.suspicious.length">检测到可疑字符（{{ barcodeWarn.suspicious.join(' ') }}），可能为扫码枪误读</template>
              <template v-if="barcodeWarn.suspicious.length && barcodeWarn.formatIssues.length">；</template>
              <template v-if="barcodeWarn.formatIssues && barcodeWarn.formatIssues.length">{{ barcodeWarn.formatIssues.join('，') }}</template>
              <template v-if="barcodeWarn.repairNote">{{ barcodeWarn.repairNote }}</template>
            </div>
            <div v-if="barcodeWarn.cleaned" class="bw-actions">
              <button class="btn btn-ghost btn-sm" @click="applyCleaned">使用建议条码：{{ barcodeWarn.cleaned }}</button>
            </div>

          </div>

          <label>备注</label>
          <textarea v-model="note" rows="2" placeholder="已有瑕疵、特殊洗护要求等（可选）"></textarea>

          <label>已拍照片（{{ shots.length }} 张）</label>
          <div v-if="shots.length" class="shot-queue">
            <div v-for="(s, i) in shots" :key="i" class="shot-thumb">
              <img :src="s" />
              <span class="shot-no">第 {{ i + 1 }} 张</span>
              <button class="shot-remove" title="移除" @click="removeShot(i)">✕</button>
            </div>
          </div>
          <div v-else class="capture-placeholder">按空格键连续拍摄，照片缩略图会出现在这里</div>

          <div style="display:flex;gap:10px;margin-top:16px">
            <button v-if="shots.length" class="btn btn-ghost" :disabled="saving" @click="clearShots">清空</button>
            <button class="btn btn-primary" style="flex:1" :disabled="saving" @click="saveAll">
              {{ saving ? '保存中…' : '保存全部（回车，共 ' + shots.length + ' 张）' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  `
};

/* ---------- 客户端查询 / 管理端数据查看（共用） ---------- */
const QueryPage = {
  props: {
    token: { type: String, required: true },
    adminMode: { type: Boolean, default: false },
    // 门店管理员视图：可见本店全部订单，但无账号管理与全店筛选能力
    storeMode: { type: Boolean, default: false },
    user: { type: Object, default: null },
    // 「本周订单」等页面的带参跳转：非空时填入条码并自动搜索一次
    prefillBarcode: { type: String, default: '' }
  },
  setup(props) {
    const keyword = Vue.ref('');
    const barcodeFilter = Vue.ref('');
    const dateFrom = Vue.ref('');
    const dateTo = Vue.ref('');
    const userIdFilter = Vue.ref('all');
    const storeFilter = Vue.ref('all');
    const users = Vue.ref([]);
    const items = Vue.ref([]);
    const total = Vue.ref(0);
    const page = Vue.ref(1);
    // 每页显示数量随窗口可视区域自适应（需求：不再固定），下限/上限见 recalcPageSize
    const pageSize = Vue.ref(12);
    const loading = Vue.ref(false);
    const detail = Vue.ref(null);
    const detailIndex = Vue.ref(-1); // 当前预览照片在本页列表中的下标，用于左右切换
    const selected = Vue.ref([]); // 已勾选的记录 id
    const batchDeleting = Vue.ref(false);
    // 导出/下载互斥锁：4 个入口都会先弹系统目录选择框，并发会导致原生对话框竞态。
    // 用操作 key 而非布尔量，按钮才能只显示自己的 loading 文案（不串台）。
    // '' | 'today' | 'byBarcode' | 'download' | 'byDate'
    const busy = Vue.ref('');
    // 「弹窗待确认」窗口的互斥锁：busy 要到确认弹窗与目录选择之后才置位，
    // 而 showConfirm 是模块级单例（第二次调用会覆盖 confirmState.resolve，
    // 令前一个 Promise 永不 resolve、其函数体永久挂在 await 上，表现为点击被静默丢弃）。
    // 故用这个与 busy 分离的标志，覆盖「弹窗待确认 → 选目录 → 执行」整段窗口。
    const confirming = Vue.ref(false);
    const downloadingPhoto = Vue.ref(false);

    // 照片网格容器引用，用于测量可用宽高以计算每页数量
    const gridEl = Vue.ref(null);

    // ---------- 图片灯箱：原尺寸预览 + 缩放平移 + 左右切换 ----------
    const zoomScale = Vue.ref(1);
    const panX = Vue.ref(0);
    const panY = Vue.ref(0);
    const imgLoaded = Vue.ref(false);
    const imgNatural = Vue.ref({ w: 0, h: 0 });
    let dragging = false;
    let dragStart = { x: 0, y: 0, panX: 0, panY: 0 };

    const ZOOM_MIN = 0.2;
    const ZOOM_MAX = 8;

    function resetZoom() {
      zoomScale.value = 1;
      panX.value = 0;
      panY.value = 0;
      imgLoaded.value = false;
    }

    // 以某点为中心缩放：保持鼠标位置对应的图像点不动
    function applyZoom(nextScale, cx, cy) {
      const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nextScale));
      if (clamped === zoomScale.value) return;
      const ratio = clamped / zoomScale.value;
      if (typeof cx === 'number' && typeof cy === 'number') {
        panX.value = cx - (cx - panX.value) * ratio;
        panY.value = cy - (cy - panY.value) * ratio;
      }
      zoomScale.value = clamped;
    }

    function zoomIn() {
      applyZoom(zoomScale.value * 1.25);
    }

    function zoomOut() {
      applyZoom(zoomScale.value / 1.25);
    }

    function zoomReset() {
      zoomScale.value = 1;
      panX.value = 0;
      panY.value = 0;
    }

    // 滚轮缩放（以光标位置为锚点）
    function onWheel(e) {
      if (!detail.value) return;
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      applyZoom(zoomScale.value * factor, cx, cy);
    }

    function onImgMouseDown(e) {
      if (e.button !== 0) return;
      dragging = true;
      dragStart = { x: e.clientX, y: e.clientY, panX: panX.value, panY: panY.value };
      e.preventDefault();
    }

    function onDocMouseMove(e) {
      if (!dragging) return;
      panX.value = dragStart.panX + (e.clientX - dragStart.x);
      panY.value = dragStart.panY + (e.clientY - dragStart.y);
    }

    function onDocMouseUp() {
      dragging = false;
    }

    // 双击在 1x 与 2.5x 之间切换，便于快速看细节
    function onImgDblClick(e) {
      if (zoomScale.value > 1.01) {
        zoomReset();
      } else {
        const rect = e.currentTarget.getBoundingClientRect();
        applyZoom(2.5, e.clientX - rect.left - rect.width / 2, e.clientY - rect.top - rect.height / 2);
      }
    }

    function onImgLoad(e) {
      imgLoaded.value = true;
      const el = e && e.target;
      if (el) imgNatural.value = { w: el.naturalWidth || 0, h: el.naturalHeight || 0 };
    }

    // 关闭灯箱并清理键盘/鼠标监听
    function closeDetail() {
      detail.value = null;
      detailIndex.value = -1;
      resetZoom();
    }

    // 左右切换：本页内移动；到达边界时自动翻页并定位到首/尾张
    async function stepPhoto(delta) {
      if (!items.value.length) return;
      const idx = detailIndex.value;
      let nextIdx = idx + delta;

      if (nextIdx < 0) {
        if (page.value <= 1) return; // 已是全部记录的第一张
        page.value--;
        await search(false);
        if (!items.value.length) return;
        nextIdx = items.value.length - 1;
      } else if (nextIdx >= items.value.length) {
        if (page.value >= totalPages.value) return; // 已是最后一张
        page.value++;
        await search(false);
        if (!items.value.length) return;
        nextIdx = 0;
      }

      detailIndex.value = nextIdx;
      detail.value = items.value[nextIdx];
      resetZoom();
    }

    function prevPhoto() {
      stepPhoto(-1);
    }

    function nextPhoto() {
      stepPhoto(1);
    }

    // 灯箱打开期间监听键盘：←/→ 切换，+/- 缩放，0 复位，Esc 关闭
    function onKeydown(e) {
      if (e.isComposing || e.keyCode === 229) return; // 输入法组合态放行，避免打断候选确认
      if (!detail.value) return;
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          prevPhoto();
          break;
        case 'ArrowRight':
          e.preventDefault();
          nextPhoto();
          break;
        case 'Escape':
          e.preventDefault();
          closeDetail();
          break;
        case '+':
        case '=':
          e.preventDefault();
          zoomIn();
          break;
        case '-':
        case '_':
          e.preventDefault();
          zoomOut();
          break;
        case '0':
          e.preventDefault();
          zoomReset();
          break;
        default:
          break;
      }
    }

    // 按条码（订单号）批量下载照片：勾选了则导出勾选记录涉及的条码，未勾选则导出当前列表全部条码
    async function exportByBarcode() {
      if (busy.value || confirming.value) return;
      const source = selected.value.length
        ? items.value.filter((r) => selected.value.includes(r.id))
        : items.value.slice();
      const barcodes = [...new Set(source.map((r) => r.barcode).filter(Boolean))];
      if (!barcodes.length) {
        toast('没有可导出的记录', 'error');
        return;
      }
      const scope = selected.value.length
        ? '已勾选记录涉及的 ' + barcodes.length + ' 个条码'
        : '当前列表中的全部 ' + barcodes.length + ' 个条码';
      // 从这里开始直到函数结束统一由 try/finally 收口：
      // 用户取消、目录选择失败、接口异常等所有返回路径都必须复位 confirming，
      // 否则按钮会永久置灰（与 busy 复位是同一类陷阱）。
      confirming.value = true;
      try {
        const ok = await showConfirm({ title: '导出照片', message: '将按条码（订单号）分文件夹导出照片到本地目录。\n导出范围：' + scope + '。', confirmText: '继续导出' });
        if (!ok) return;
        const d = await window.api.chooseExportDir();
        if (!d.ok) {
          if (d.message && d.message !== '已取消') toast(d.message, 'error');
          return;
        }
        busy.value = 'byBarcode';
        toast('正在导出照片，数量较多时请稍候…', 'success');
        try {
          const res = await window.api.exportPhotos(props.token, { targetDir: d.data, barcodes });
          if (res.ok) {
            toast(
              '导出完成：' + res.data.folders + ' 个文件夹、' + res.data.exported + ' 张照片' +
              (res.data.skipped ? '，缺失跳过 ' + res.data.skipped + ' 张' : '') +
              (res.data.failed ? '，失败 ' + res.data.failed + ' 张' : ''),
              'success'
            );
          } else {
            toast(res.message || '导出失败', 'error');
          }
        } catch (e) {
          toast('导出失败：' + (e.message || e), 'error');
        } finally {
          busy.value = '';
        }
      } finally {
        confirming.value = false;
      }
    }

    // 按日期范围导出照片：按条码分文件夹归档，并生成「条码+文件位置」表格
    async function exportByDate() {
      if (busy.value || confirming.value) return;
      if (!dateFrom.value || !dateTo.value) {
        toast('请先在上方选择开始日期与结束日期', 'error');
        return;
      }
      if (dateFrom.value > dateTo.value) {
        toast('开始日期不能晚于结束日期', 'error');
        return;
      }
      confirming.value = true;
      try {
        const ok = await showConfirm({ title: '按日期导出', message: '导出 ' + dateFrom.value + ' 至 ' + dateTo.value + ' 期间的照片，按条码分文件夹归档，并生成归档表格。', confirmText: '继续导出' });
        if (!ok) return;
        const d = await window.api.chooseExportDir();
        if (!d.ok) {
          if (d.message && d.message !== '已取消') toast(d.message, 'error');
          return;
        }
        busy.value = 'byDate';
        toast('正在按日期导出照片，数量较多时请稍候…', 'success');
        try {
          const res = await window.api.exportPhotosByDate(props.token, {
            targetDir: d.data,
            dateFrom: dateFrom.value,
            dateTo: dateTo.value
          });
          if (res.ok) {
            toast(
              '导出完成：' + res.data.folders + ' 个条码文件夹、' + res.data.exported + ' 张照片，表格已生成' +
              (res.data.skipped ? '，缺失跳过 ' + res.data.skipped + ' 张' : '') +
              (res.data.failed ? '，失败 ' + res.data.failed + ' 张' : ''),
              'success'
            );
          } else {
            toast(res.message || '导出失败', 'error');
          }
        } catch (e) {
          toast('导出失败：' + (e.message || e), 'error');
        } finally {
          busy.value = '';
        }
      } finally {
        confirming.value = false;
      }
    }

    // 一键导出当日订单表格：今天录入的全部订单（不复制照片，供洗衣管家上传助手同步使用）
    async function exportToday() {
      if (busy.value || confirming.value) return;
      const now = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const day = now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate());
      confirming.value = true;
      try {
        const ok = await showConfirm({ title: '下载当日订单表', message: '生成今天（' + day + '）全部订单的「条码 + 照片位置」表格（不包含照片文件），供洗衣管家上传助手同步照片使用。', confirmText: '生成表格' });
        if (!ok) return;
        const d = await window.api.chooseExportDir();
        if (!d.ok) {
          if (d.message && d.message !== '已取消') toast(d.message, 'error');
          return;
        }
        busy.value = 'today';
        toast('正在生成当日订单表格，请稍候…', 'success');
        try {
          const res = await window.api.exportPhotosByDate(props.token, { targetDir: d.data, dateFrom: day, dateTo: day, tableOnly: true });
          if (res.ok) {
            if (res.data.tableOnly) {
              toast('当日订单表格已生成：' + res.data.barcodes + ' 个条码、' + res.data.photos + ' 张照片记录，已保存到所选目录', 'success');
            } else {
              // 旧版服务端不支持仅表格模式：回退为完整导出
              toast(
                '导出完成：' + res.data.folders + ' 个条码文件夹、' + res.data.exported + ' 张照片，表格已生成' +
                (res.data.skipped ? '，缺失跳过 ' + res.data.skipped + ' 张' : '') +
                (res.data.failed ? '，失败 ' + res.data.failed + ' 张' : ''),
                'success'
              );
            }
          } else {
            toast(res.message || '导出失败', 'error');
          }
        } catch (e) {
          toast('导出失败：' + (e.message || e), 'error');
        } finally {
          busy.value = '';
        }
      } finally {
        confirming.value = false;
      }
    }

    // 下载单张原始照片：经后端（服务端模式直接复制 / 客户端模式经 /photo 接口拉取）落盘到用户选定目录
    async function downloadPhoto(r) {
      if (downloadingPhoto.value) return;
      const d = await window.api.chooseExportDir();
      if (!d.ok) {
        if (d.message && d.message !== '已取消') toast(d.message, 'error');
        return;
      }
      downloadingPhoto.value = true;
      toast('正在下载原片…', 'success');
      try {
        const res = await window.api.downloadPhoto(props.token, { photoFile: r.photoFile, targetDir: d.data });
        if (res.ok) toast('原片已保存到所选目录', 'success');
        else toast(res.message || '下载失败', 'error');
      } catch (e) {
        toast('下载失败：' + (e.message || e), 'error');
      } finally {
        downloadingPhoto.value = false;
      }
    }

    // 批量下载原始照片：按条码（订单号）分文件夹落盘，不生成任何清单文件（与导出区分）
    async function downloadSelected() {
      if (busy.value || confirming.value) return;
      const source = selected.value.length
        ? items.value.filter((r) => selected.value.includes(r.id))
        : items.value.slice();
      const barcodes = [...new Set(source.map((r) => r.barcode).filter(Boolean))];
      if (!barcodes.length) {
        toast('没有可下载的记录', 'error');
        return;
      }
      const scope = selected.value.length
        ? '已勾选记录涉及的 ' + barcodes.length + ' 个条码'
        : '当前列表中的全部 ' + barcodes.length + ' 个条码';
      confirming.value = true;
      try {
        const ok = await showConfirm({
          title: '下载原片',
          message: '将按条码（订单号）分文件夹下载原始照片到本地目录（不生成任何清单文件）。\n下载范围：' + scope + '。',
          confirmText: '下载原片'
        });
        if (!ok) return;
        const d = await window.api.chooseExportDir();
        if (!d.ok) {
          if (d.message && d.message !== '已取消') toast(d.message, 'error');
          return;
        }
        busy.value = 'download';
        toast('正在下载原片，数量较多时请稍候…', 'success');
        try {
          const res = await window.api.downloadPhotos(props.token, { targetDir: d.data, barcodes });
          if (res.ok) {
            toast(
              '下载完成：' + res.data.folders + ' 个文件夹、' + res.data.exported + ' 张原片' +
              (res.data.skipped ? '，缺失跳过 ' + res.data.skipped + ' 张' : '') +
              (res.data.failed ? '，失败 ' + res.data.failed + ' 张' : ''),
              'success'
            );
          } else {
            toast(res.message || '下载失败', 'error');
          }
        } catch (e) {
          toast('下载失败：' + (e.message || e), 'error');
        } finally {
          busy.value = '';
        }
      } finally {
        confirming.value = false;
      }
    }

    function toggleSelect(r) {
      const i = selected.value.indexOf(r.id);
      if (i === -1) selected.value.push(r.id);
      else selected.value.splice(i, 1);
    }

    function selectAll() {
      if (selected.value.length === items.value.length) {
        selected.value = [];
      } else {
        selected.value = items.value.map((r) => r.id);
      }
    }

    async function batchDelete() {
      if (!selected.value.length) {
        toast('请先勾选要删除的记录', 'error');
        return;
      }
      // 附上前 3 个条码预览：删除不可恢复，用户按确认前必须能自查有没有删错范围
      const picked = items.value.filter((r) => selected.value.includes(r.id));
      const codes = [...new Set(picked.map((r) => r.barcode).filter(Boolean))];
      const preview = codes.length
        ? codes.slice(0, 3).join('、') + (codes.length > 3 ? '…' : '')
        : '（所选记录没有条码）';
      // 只选 1 条时「，等共 1 条」是冗余的，直接以条码结尾即可
      const scopeLine = selected.value.length === 1
        ? '涉及条码：' + preview + '。'
        : '涉及条码：' + preview + '，等共 ' + selected.value.length + ' 条。';
      const ok = await showConfirm({
        title: '批量删除记录',
        message: '删除选中的 ' + selected.value.length + ' 条记录？\n' + scopeLine + '\n照片将一并删除，不可恢复。',
        confirmText: '删除这 ' + selected.value.length + ' 条记录',
        danger: true
      });
      if (!ok) return;
      batchDeleting.value = true;
      try {
        const res = await window.api.deleteRecords(props.token, selected.value.slice());
        if (res.ok) {
          toast('已删除 ' + res.data.deleted + ' 条' + (res.data.skipped ? '，跳过无权限 ' + res.data.skipped + ' 条' : ''), 'success');
          selected.value = [];
          search(false);
        } else {
          toast(res.message || '批量删除失败', 'error');
        }
      } catch (e) {
        toast('批量删除失败：' + (e.message || e), 'error');
      } finally {
        batchDeleting.value = false;
      }
    }
    // ---------- 条码改号（录入纠错） ----------
    const rename = Vue.ref(null); // { id, barcode, newBarcode, saving }
    function openRename(r) {
      rename.value = { id: r.id, barcode: r.barcode, newBarcode: r.barcode, saving: false };
    }
    async function submitRename() {
      const st = rename.value;
      if (!st || st.saving) return;
      const nb = String(st.newBarcode || '').trim();
      if (!nb) { toast('请输入新条码', 'error'); return; }
      if (nb === st.barcode) { toast('新条码与原条码相同', 'error'); return; }
      const ok = await showConfirm({ title: '修改条码', message: '把条码『' + st.barcode + '』改为『' + nb + '』？\n照片将移入新条码文件夹，编号重新排列，操作会记入日志。', confirmText: '修改条码' });
      if (!ok) return;
      st.saving = true;
      try {
        const res = await window.api.renameBarcode(props.token, st.id, nb);
        if (res.ok) {
          toast('条码已改为 ' + nb + '，照片已随迁并重新编号', 'success');
          rename.value = null;
          search(false);
        } else {
          toast(res.message || '修改失败', 'error');
          st.saving = false;
        }
      } catch (e) {
        toast('修改失败：' + (e.message || e), 'error');
        st.saving = false;
      }
    }
    // ---------- 批量改码（整批误扫一次修正） ----------
    const renameBatch = Vue.ref(null); // { newBarcode, saving }
    function openRenameBatch() {
      if (!selected.value.length) { toast('请先勾选要改码的记录', 'error'); return; }
      renameBatch.value = { newBarcode: '', saving: false };
    }
    async function submitRenameBatch() {
      const st = renameBatch.value;
      if (!st || st.saving) return;
      const nb = String(st.newBarcode || '').trim();
      if (!nb) { toast('请输入新条码', 'error'); return; }
      const ok = await showConfirm({ title: '批量改码', message: '把选中的 ' + selected.value.length + ' 条记录统一改为『' + nb + '』？\n照片将移入新条码文件夹并重新编号，操作记入日志。', confirmText: '批量改码' });
      if (!ok) return;
      st.saving = true;
      try {
        const res = await window.api.renameBarcodeBatch(props.token, selected.value.slice(), nb);
        if (res.ok) {
          const d = res.data || {};
          toast('已改码 ' + d.renamed + ' 条' + (d.denied ? '，跳过无权限 ' + d.denied + ' 条' : ''), 'success');
          renameBatch.value = null;
          selected.value = [];
          search(false);
        } else {
          toast(res.message || '批量改码失败', 'error');
          st.saving = false;
        }
      } catch (e) {
        toast('批量改码失败：' + (e.message || e), 'error');
        st.saving = false;
      }
    }

    async function loadUsers() {
      if (!props.adminMode) return;
      const r = await window.api.listUsers(props.token);
      if (r.ok) users.value = r.data;
    }

    // 门店筛选候选：从账号列表汇总已用过的门店名（仅管理端可见）
    const storeOptions = Vue.computed(() => {
      const set = new Set();
      for (const u of users.value) {
        const s = String(u.store || '').trim();
        if (s) set.add(s);
      }
      return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    });

    // 客户端模式下区分「本人录入」与「同店他人录入」，避免误删他人订单
    const myId = Vue.computed(() => (props.user && props.user.id) || '');
    function isMine(r) {
      return !!r && !!myId.value && r.userId === myId.value;
    }

    // 能否删除：系统管理员可删任意记录；能拍照录入的账号（拍照账号）才有自己的记录可删。
    // 门店管理员与查询账号不录入订单，永远没有本人记录，批量删除对其无意义且必然失败，
    // 因此不显示勾选框与批量删除按钮（后端同样会逐条拦截越权删除）。
    const canDelete = Vue.computed(() => {
      if (props.adminMode) return true;
      const u = props.user || {};
      return !!(u.permissions && u.permissions.capture);
    });

    async function search(reset) {
      if (reset) page.value = 1;
      loading.value = true;
      try {
        const r = await window.api.listRecords(props.token, {
          keyword: keyword.value,
          barcode: barcodeFilter.value,
          dateFrom: dateFrom.value,
          dateTo: dateTo.value,
          userId: userIdFilter.value,
          storeFilter: storeFilter.value,
          page: page.value,
          pageSize: pageSize.value
        });
        if (r.ok) {
          items.value = r.data.items;
          total.value = r.data.total;
          selected.value = [];
        } else {
          toast(r.message || '查询失败', 'error');
        }
      } catch (e) {
        toast('查询失败：' + (e.message || e), 'error');
      } finally {
        loading.value = false;
      }
    }

    function reset() {
      keyword.value = '';
      barcodeFilter.value = '';
      dateFrom.value = '';
      dateTo.value = '';
      userIdFilter.value = 'all';
      storeFilter.value = 'all';
      search(true);
    }

    async function openDetail(r) {
      // 列表记录已含完整字段与原图 photoUrl，直接用于灯箱预览，切换时零延迟且不额外产生「查看记录」日志
      const idx = items.value.findIndex((x) => x.id === r.id);
      detailIndex.value = idx >= 0 ? idx : -1;
      detail.value = r;
      resetZoom();
    }

    async function remove(r) {
      const ok = await showConfirm({ title: '删除记录', message: '删除该存档记录？\n照片将一并删除，不可恢复。', confirmText: '删除该记录', danger: true });
      if (!ok) return;
      const res = await window.api.deleteRecord(props.token, r.id);
      if (res.ok) {
        toast('已删除', 'success');
        if (detail.value && detail.value.id === r.id) closeDetail();
        search(false);
      } else {
        toast(res.message || '删除失败', 'error');
      }
    }

    const totalPages = Vue.computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

    // 根据网格容器可视宽高估算每页应显示的照片数量：
    // 先按最小卡宽 180px + 间距 14px 算出每行列数，再按可用高度算出可容纳的行数。
    function recalcPageSize() {
      const el = gridEl.value;
      if (!el) return;
      const CARD_MIN_W = 180;
      const GAP = 14;
      const CARD_H = 232; // 卡片高度：4:3 图(≈135) + meta(≈80) + 边框间距
      const width = el.clientWidth || el.offsetWidth || 0;
      if (width <= 0) return;
      const cols = Math.max(1, Math.floor((width + GAP) / (CARD_MIN_W + GAP)));
      // 可用高度：视口高度减去顶栏/筛选栏/分页等固定占位（约 320px），至少 1 行
      const mainEl = el.closest('.main');
      const viewportH = mainEl ? mainEl.clientHeight : window.innerHeight;
      const availH = Math.max(CARD_H, viewportH - 320);
      const rows = Math.max(1, Math.floor((availH + GAP) / (CARD_H + GAP)));
      const next = Math.min(100, Math.max(6, cols * rows));
      if (next !== pageSize.value) {
        pageSize.value = next;
      }
    }

    // 尺寸变化时重新计算每页数量并回到第一页重查，避免半屏空白或溢出
    let resizeRaf = null;
    function onResize() {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null;
        const before = pageSize.value;
        recalcPageSize();
        if (pageSize.value !== before) search(true);
      });
    }

    function prev() {
      if (page.value > 1) {
        page.value--;
        search(false);
      }
    }

    function next() {
      if (page.value < totalPages.value) {
        page.value++;
        search(false);
      }
    }

    // 页码选择：跳到指定页（越界自动收敛到合法范围；同页不重复查询）
    function goPage(n) {
      const t = Math.max(1, Math.min(totalPages.value, Math.floor(Number(n) || 1)));
      if (t !== page.value) {
        page.value = t;
        search(false);
      }
    }

    // 带参跳转消费：填入条码并立即搜一次。
    // onMounted 处理「从别的页跳进来」的首次挂载；watch 处理「已在查询页时再次跳转」
    // （管理员的 data 与 query 指向同一个 QueryPage，key 相同时组件不会重新挂载）。
    function applyPrefill(code) {
      const v = String(code || '').trim();
      if (!v) return false;
      keyword.value = '';
      barcodeFilter.value = v;
      dateFrom.value = '';
      dateTo.value = '';
      userIdFilter.value = 'all';
      storeFilter.value = 'all';
      page.value = 1;
      return true;
    }

    Vue.onMounted(() => {
      loadUsers();
      // 首屏必须先按容器尺寸算出每页数量再查询。
      // 此前的写法把 recalcPageSize 放在 nextTick 里、而 search 同步执行，
      // 导致首次查询仍用初始的 12 张，之后虽改了 pageSize 却不再重查（页面大小变化不生效）。
      recalcPageSize();
      // 带参跳转优先：填入条码后搜这一次，避免先搜一遍全量再被覆盖（闪一次无关结果）
      if (!applyPrefill(props.prefillBarcode)) search(true);
      // 布局可能在挂载后才稳定，补算一次；数量有变化则重新查询
      Vue.nextTick(() => {
        const before = pageSize.value;
        recalcPageSize();
        if (pageSize.value !== before) search(true);
      });
      window.addEventListener('resize', onResize);
      window.addEventListener('keydown', onKeydown);
      document.addEventListener('mousemove', onDocMouseMove);
      document.addEventListener('mouseup', onDocMouseUp);
    });

    // 组件未卸载时再次收到带参跳转（Shell 的 prefill 每次跳转都是新对象）
    Vue.watch(
      () => props.prefillBarcode,
      (v) => {
        if (applyPrefill(v)) search(true);
      }
    );

    Vue.onBeforeUnmount(() => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKeydown);
      document.removeEventListener('mousemove', onDocMouseMove);
      document.removeEventListener('mouseup', onDocMouseUp);
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
    });

    return {
      keyword, barcodeFilter, dateFrom, dateTo, userIdFilter, users, items, total,
      storeFilter, storeOptions, isMine, canDelete,
      page, pageSize, totalPages, loading, detail, detailIndex, gridEl,
      selected, batchDeleting, toggleSelect, selectAll, batchDelete,
      busy, confirming, exportByBarcode, exportByDate, exportToday,
      downloadingPhoto, downloadPhoto, downloadSelected,
      search, reset, openDetail, remove, prev, next, goPage, fmt, rename, openRename, submitRename, renameBatch, openRenameBatch, submitRenameBatch,
      // 灯箱预览：缩放、平移、切换
      zoomScale, panX, panY, imgLoaded, imgNatural,
      closeDetail, prevPhoto, nextPhoto, zoomIn, zoomOut, zoomReset,
      onWheel, onImgMouseDown, onImgDblClick, onImgLoad,
      adminMode: props.adminMode, storeMode: props.storeMode
    };
  },
  template: `
    <div>
      <div class="page-head">
        <h2>{{ adminMode ? '数据查看' : (storeMode ? '本店订单' : '记录查询') }}</h2>
        <p>{{ adminMode ? '查看系统中所有门店账号登记的衣物存档数据' : (storeMode ? '查看本门店所有账号登记的衣物存档数据' : '按条形码、备注、日期查找本店存档的照片') }}</p>
      </div>

      <div class="card">
        <div class="filter-bar">
          <div class="f-item f-keyword">
            <label>条形码</label>
            <input v-model="barcodeFilter" placeholder="精确匹配条形码" @keyup.enter="search(true)" />
          </div>
          <div class="f-item f-keyword">
            <label>关键词</label>
            <input v-model="keyword" placeholder="条码 / 备注模糊搜索" @keyup.enter="search(true)" />
          </div>
          <div class="f-item f-date">
            <label>开始日期</label>
            <input type="date" v-model="dateFrom" />
          </div>
          <div class="f-item f-date">
            <label>结束日期</label>
            <input type="date" v-model="dateTo" />
          </div>
          <div v-if="adminMode" class="f-item f-user">
            <label>所属账号</label>
            <select v-model="userIdFilter">
              <option value="all">全部账号</option>
              <option v-for="u in users" :key="u.id" :value="u.id">{{ u.username }}（{{ u.name }}）</option>
            </select>
          </div>
          <div v-if="adminMode" class="f-item f-user">
            <label>所属门店</label>
            <select v-model="storeFilter">
              <option value="all">全部门店</option>
              <option v-for="s in storeOptions" :key="s" :value="s">{{ s }}</option>
            </select>
          </div>
          <button class="btn btn-primary" @click="search(true)">查询</button>
          <button class="btn btn-ghost" @click="reset">重置</button>
          <button class="btn btn-ghost" :disabled="!!busy || confirming" @click="exportToday" title="生成今天全部订单的「条码+照片位置」表格（不含照片），供洗衣管家上传助手同步使用">
            {{ busy === 'today' ? '生成中…' : '⬇ 下载当日订单' }}
          </button>
        </div>

        <div class="batch-bar" v-if="items.length" :aria-busy="(busy || confirming) ? 'true' : 'false'">
          <label v-if="canDelete" class="batch-check"><input type="checkbox" :checked="selected.length === items.length && items.length > 0" @change="selectAll" />全选本页</label>
          <span v-if="canDelete" class="pager-info">已选 {{ selected.length }} 条</span>
          <button class="btn btn-ghost btn-sm" :disabled="!!busy || confirming" @click="exportByBarcode" title="生成条码+照片位置清单表">
            {{ busy === 'byBarcode' ? '导出中…' : '⬇ 导出照片 + 清单表' }}
          </button>
          <button class="btn btn-ghost btn-sm" :disabled="!!busy || confirming" @click="downloadSelected" title="只落原始照片文件，不生成任何清单">
            {{ busy === 'download' ? '下载中…' : '⬇ 只下载原片（无清单）' }}
          </button>
          <button class="btn btn-ghost btn-sm" :disabled="!!busy || confirming" @click="exportByDate" title="按上方日期范围导出照片，并生成条码+文件位置表格">
            {{ busy === 'byDate' ? '导出中…' : '⬇ 按日期导出' }}
          </button>
          <button v-if="adminMode || canDelete" class="btn btn-ghost btn-sm" :disabled="!selected.length" @click="openRenameBatch" title="把选中的多条记录统一改为同一个正确条码（照片随迁并重新编号）">
            ⇄ 批量改码
          </button>
          <button v-if="canDelete" class="btn btn-danger btn-sm" :disabled="!selected.length || batchDeleting" @click="batchDelete">
            {{ batchDeleting ? '删除中…' : '批量删除' }}
          </button>
        </div>

        <div ref="gridEl" class="query-results">
          <div v-if="loading" class="skeleton-grid" aria-busy="true">
            <div v-for="n in 8" :key="n" class="skeleton skeleton-card"></div>
          </div>
          <div v-else-if="!items.length" class="empty">
            <div class="empty-icon" aria-hidden="true"></div>
            <div class="empty-title">没有符合条件的存档记录</div>
            <div class="empty-desc">调整时间范围或条码关键词再试一次；刚拍完照可先刷新列表。</div>
            <button class="btn btn-ghost" @click="reset">清空筛选条件</button>
          </div>
          <div v-else class="record-grid">
            <!-- 保留 div：内含 label.card-check 与 button.btn-rename，改成 button 会产生嵌套可交互元素的非法 HTML。
                 补 tabindex/role/键盘事件让纯键盘用户也能走通「查询→打开→下载原片」主路径。 -->
            <div
              v-for="r in items"
              :key="r.id"
              class="record-card"
              tabindex="0"
              role="button"
              :aria-label="'打开订单 ' + r.barcode"
              @click="openDetail(r)"
              @keydown.enter="openDetail(r)"
              @keydown.space.prevent="openDetail(r)"
            >
              <div class="record-photo"><img :src="r.thumbUrl || r.photoUrl" loading="lazy" decoding="async" /></div>
              <div class="record-meta">
                <div class="record-customer">{{ r.barcode }}<button v-if="adminMode || isMine(r)" class="btn-rename" title="修改此记录的条码" @click.stop="openRename(r)">改码</button></div>
                <div class="record-tags">
                  <span class="tag tag-orange">第 {{ r.seq }} 张</span>
                  <span
                    v-if="adminMode || !isMine(r)"
                    class="tag tag-owner"
                    :title="isMine(r) ? '本人录入' : '同门店同事录入'"
                  >{{ r.username }}</span>
                  <span v-if="adminMode && r.storeName" class="tag">{{ r.storeName }}</span>
                </div>
                <div class="record-time">{{ fmt(r.createdAt) }}</div>
              </div>
              <label v-if="canDelete" class="card-check" :class="{ on: selected.includes(r.id) }" @click.stop>
                <input type="checkbox" :checked="selected.includes(r.id)" @change="toggleSelect(r)" />
              </label>
            </div>
          </div>
        </div>

        <div class="pager">
          <span class="pager-info">共 {{ total }} 条 · 第 {{ page }}/{{ totalPages }} 页</span>
          <button class="btn btn-ghost btn-sm" :disabled="page <= 1" @click="prev">上一页</button>
          <span class="pager-jump" title="选择页码直达">
            <select class="pager-select" :value="page" :disabled="totalPages <= 1" @change="goPage($event.target.value)" aria-label="选择页码">
              <option v-for="p in totalPages" :key="p" :value="p">{{ p }} / {{ totalPages }}</option>
            </select>
          </span>
          <button class="btn btn-ghost btn-sm" :disabled="page >= totalPages" @click="next">下一页</button>
        </div>
      </div>

      <div v-if="rename" class="modal-mask" @click.self="rename = null">
        <div class="modal" style="max-width:420px">
          <div class="modal-head">
            <h3>修改条码</h3>
            <button class="modal-close" title="关闭" @click="rename = null">✕</button>
          </div>
          <div class="modal-body">
            <div class="form-row">
              <label>原条码</label>
              <input :value="rename.barcode" disabled />
            </div>
            <div class="form-row">
              <label>新条码 *</label>
              <input v-model="rename.newBarcode" placeholder="输入正确条码，扫码枪可直接扫入" @keyup.enter="submitRename" />
              <p class="form-tip">照片将移入新条码文件夹并重新编号，操作记入日志；仅系统管理员与本人存档可改。</p>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="rename = null">取消</button>
            <button class="btn btn-primary" :disabled="rename.saving" @click="submitRename">{{ rename.saving ? '保存中…' : '确认修改' }}</button>
          </div>
        </div>
      </div>

      <div v-if="renameBatch" class="modal-mask" @click.self="renameBatch = null">
        <div class="modal" style="max-width:420px">
          <div class="modal-head">
            <h3>批量改码</h3>
            <button class="modal-close" title="关闭" @click="renameBatch = null">✕</button>
          </div>
          <div class="modal-body">
            <div class="form-row">
              <label>已选 {{ selected.length }} 条记录，统一改为新条码 *</label>
              <input v-model="renameBatch.newBarcode" placeholder="输入正确条码，扫码枪可直接扫入" @keyup.enter="submitRenameBatch" />
              <p class="form-tip">所有选中记录的照片将移入新条码文件夹并重新编号，操作记入日志；无权限的记录自动跳过。</p>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="renameBatch = null">取消</button>
            <button class="btn btn-primary" :disabled="renameBatch.saving" @click="submitRenameBatch">{{ renameBatch.saving ? '保存中…' : '确认修改' }}</button>
          </div>
        </div>
      </div>

      <div v-if="detail" class="lightbox" @click.self="closeDetail" @wheel="onWheel">
        <!-- 左：看图区（顶部条 + 舞台 + 底部工具，保持原有缩放/平移/切换行为） -->
        <div class="lightbox-main">
        <!-- 顶部信息条：只留舞台相关（条码/时间等已移至右侧信息面板） -->
        <div class="lightbox-top">
          <div class="lightbox-info">
            <span class="lightbox-barcode only-narrow">{{ detail.barcode }}</span>
            <span v-if="imgNatural.w" class="lightbox-dim">{{ imgNatural.w }}×{{ imgNatural.h }}</span>
            <span class="lightbox-zoom">{{ Math.round(zoomScale * 100) }}%</span>
            <span v-if="detailIndex >= 0" class="lightbox-pos">{{ detailIndex + 1 }} / {{ items.length }}</span>
          </div>
          <button class="lightbox-close" title="关闭（Esc）" @click="closeDetail">✕</button>
        </div>

        <!-- 左切换 -->
        <button
          class="lightbox-nav lightbox-prev"
          title="上一张（←）"
          :disabled="detailIndex <= 0 && page <= 1"
          @click.stop="prevPhoto"
        >‹</button>

        <!-- 图片舞台 -->
        <div class="lightbox-stage" @click.self="closeDetail">
          <img
            class="lightbox-img"
            :class="{ loaded: imgLoaded, grab: zoomScale > 1.01 }"
            :src="detail.photoUrl"
            :style="{ transform: 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoomScale + ')' }"
            draggable="false"
            @load="onImgLoad"
            @mousedown="onImgMouseDown"
            @dblclick="onImgDblClick"
            alt="衣物照片"
          />
        </div>

        <!-- 右切换 -->
        <button
          class="lightbox-nav lightbox-next"
          title="下一张（→）"
          :disabled="detailIndex >= items.length - 1 && page >= totalPages"
          @click.stop="nextPhoto"
        >›</button>

        <!-- 底部工具条：只留缩放控制（删除与权限提示已移至右侧信息面板操作区） -->
        <div class="lightbox-bottom">
          <button class="lightbox-btn" title="缩小（-）" @click="zoomOut">－</button>
          <button class="lightbox-btn" title="实际大小（0）" @click="zoomReset">1:1</button>
          <button class="lightbox-btn" title="放大（+）" @click="zoomIn">＋</button>
          <span class="lightbox-hint">滚轮缩放 · 拖拽平移 · 双击放大 · ←/→ 切换 · Esc 关闭</span>
        </div>
        </div>

        <!-- 右：信息面板 360px（<1024 隐藏，条码回落顶部条） -->
        <aside class="lightbox-panel" @wheel.stop>
          <div class="panel-barcode" :title="detail.barcode">{{ detail.barcode }}</div>
          <div class="panel-tags">
            <span class="tag tag-orange">第 {{ detail.seq }} 张</span>
            <span v-if="adminMode || !isMine(detail)" class="tag tag-owner">{{ detail.username }}</span>
            <span v-if="adminMode && detail.storeName" class="tag">{{ detail.storeName }}</span>
          </div>
          <div class="panel-rows">
            <div class="info-row"><span>拍摄时间</span><b class="code">{{ fmt(detail.createdAt) }}</b></div>
            <div class="info-row"><span>录入人</span><b>{{ detail.username }}</b></div>
            <div class="info-row"><span>所属门店</span><b>{{ detail.storeName || '本店' }}</b></div>
            <div class="info-row"><span>照片尺寸</span><b class="code">{{ imgNatural.w && imgNatural.h ? imgNatural.w + '×' + imgNatural.h : '—' }}</b></div>
            <div v-if="detail.note" class="info-row"><span>备注</span><b :title="detail.note">{{ detail.note }}</b></div>
          </div>
          <div class="panel-actions">
            <button
              class="btn btn-primary"
              :disabled="downloadingPhoto"
              @click.stop="downloadPhoto(detail)"
              title="经后端取回本张原始照片，保存到本地目录"
            >下载原片</button>
            <button
              v-if="adminMode || isMine(detail)"
              class="btn btn-ghost"
              @click.stop="openRename(detail)"
            >修改条码</button>
            <button
              v-if="adminMode || isMine(detail)"
              class="btn btn-danger-outline"
              @click.stop="remove(detail)"
            >删除记录</button>
            <span v-else class="panel-hint">该记录由同门店同事录入，仅可查看，不可删除或修改</span>
          </div>
        </aside>
      </div>
    </div>
  `
};

/* ---------- 设计体系 v2：外观主题状态（模块级单例） ----------
   主题只写 <html data-theme>，深浅色切换只换一组 CSS 变量，不触碰业务组件。
   状态放在模块级，是为了让「设置页 · 外观」与「侧栏外观按钮」始终读到同一份值，
   同时避免外壳反复挂载时重复注册 matchMedia 监听。 */
const THEME_KEYS = ['system', 'light', 'dark'];
const THEME_LABEL = { system: '跟随系统', light: '浅色', dark: '深色' };

function readPref(key, fallback) {
  try {
    const v = window.localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function writePref(key, val) {
  try {
    window.localStorage.setItem(key, val);
  } catch (e) {
    /* 无痕模式 / 存储不可用时静默降级为单次生效 */
  }
}

/* ---------- 摄像头分辨率记忆（按 deviceId 分别存档）----------
 * 场景：门店现场多是 UVC 免驱摄像头，同一台机器重启 / 换 USB 口后浏览器默认档位
 * 常常掉回 640×480。这里把「上一次真正锁定成功」的档位存档，下次开流前由 controller
 * 直接以 exact 写进 getUserMedia 约束，一次到位（不用等开流后再提）。
 * 存档带版本号 v 与时间戳 ts，controller 侧 parseResolutionPref() 会校验，
 * 版本不认或字段非法一律当「没存过」→ 退回全量枚举，绝不会被脏存档锁死。 */
const CAM_RES_PREFIX = 'xqy-cam-res:';

function readResPref(deviceId) {
  // deviceId 为空串是合法的「默认设备」档位键（启动时还没枚举出 deviceId 就靠它），
  // 只有 null/undefined 才拒绝
  if (deviceId === null || deviceId === undefined) return null;
  const raw = readPref(CAM_RES_PREFIX + deviceId, '');
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch (e) {
    return null; // 存档损坏：当作没有记忆
  }
}

function writeResPref(deviceId, val) {
  if (deviceId === null || deviceId === undefined) return;
  try {
    if (!val) window.localStorage.removeItem(CAM_RES_PREFIX + deviceId);
    else writePref(CAM_RES_PREFIX + deviceId, JSON.stringify(val));
  } catch (e) {
    /* 无痕模式 / 存储不可用时静默降级为单次生效（本次会话内仍然有效） */
  }
}

let themeStore = null;
function useTheme() {
  if (themeStore) return themeStore;

  const theme = Vue.ref(readPref('xqy-theme', 'system'));
  if (!THEME_KEYS.includes(theme.value)) theme.value = 'system';

  function isDark() {
    if (theme.value === 'dark') return true;
    if (theme.value === 'light') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function applyTheme() {
    const root = document.documentElement;
    // system 需要显式标记，确保 CSS 变量切换到浅色分支
    root.setAttribute('data-theme', theme.value === 'system' ? (isDark() ? 'dark' : 'light') : theme.value);
  }

  function setTheme(next) {
    if (!THEME_KEYS.includes(next)) return;
    theme.value = next;
    writePref('xqy-theme', next);
    applyTheme();
  }

  function cycleTheme() {
    setTheme(THEME_KEYS[(THEME_KEYS.indexOf(theme.value) + 1) % THEME_KEYS.length]);
  }

  applyTheme();
  // 跟随系统时监听系统主题变化，避免运行中不跟随
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', applyTheme);
    else if (mq.addListener) mq.addListener(applyTheme);
  } catch (e) {
    /* 环境不支持时忽略，主题退化为手动切换 */
  }

  const themeLabel = Vue.computed(() => THEME_LABEL[theme.value] || '跟随系统');
  const themeIcon = Vue.computed(
    () =>
      ({
        system: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/></svg>',
        light: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.8v2.2M12 19v2.2M2.8 12h2.2M19 12h2.2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/></svg>',
        dark: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 7 7 0 1 0 20 14.5Z"/></svg>'
      }[theme.value] || '')
  );

  themeStore = { theme, themeLabel, themeIcon, cycleTheme, setTheme };
  return themeStore;
}

/* ---------- 客户端 · 设置页 ---------- */
const SettingsPage = {
  props: { user: { type: Object, required: true }, token: { type: String, required: true } },
  // 危险区「退出登录」只发事件，登录态重置统一交给外壳/App，避免本页直接调用接口导致界面状态不同步
  emits: ['logout'],
  setup(props, { emit }) {
    const oldPassword = Vue.ref('');
    const newPassword = Vue.ref('');
    const confirmPassword = Vue.ref('');
    const saving = Vue.ref(false);

    // 版本与安装包下载：登录后可在设置页一键下载最新版安装包（需求10）
    const {
      version, updateInfo, downloading, canAutoDownload, progressPercent, progressText,
      loadVersion, refreshUpdateInfo, downloadPackage, cancelDownload
    } = useUpdater();

    Vue.onMounted(() => {
      loadVersion();
      refreshUpdateInfo();
    });

    async function submit() {
      if (!oldPassword.value || !newPassword.value) {
        toast('请填写完整的密码信息', 'error');
        return;
      }
      if (newPassword.value !== confirmPassword.value) {
        toast('两次输入的新密码不一致', 'error');
        return;
      }
      saving.value = true;
      try {
        const r = await window.api.changePassword(props.token, oldPassword.value, newPassword.value);
        if (r.ok) {
          toast('密码修改成功', 'success');
          oldPassword.value = '';
          newPassword.value = '';
          confirmPassword.value = '';
        } else {
          toast(r.message || '修改失败', 'error');
        }
      } catch (e) {
        toast('修改失败：' + (e.message || e), 'error');
      } finally {
        saving.value = false;
      }
    }

    // 所属门店：只读展示，由系统管理员在「用户与权限管理」中分配
    const storeLabel = Vue.computed(() => {
      const u = props.user || {};
      if (isSysAdminRole(u.role)) return '不限（可查看全部记录）';
      const s = String(u.store || '').trim();
      if (!s) return u.role === 'storeadmin' ? '未分配（异常配置，请联系系统管理员）' : '未分配（仅可见本人记录）';
      return s + (u.role === 'storeadmin' ? '（可见本店全部记录）' : '（可见同店记录）');
    });

    // ---------- 设计体系 v2：外观分区 + 二级导航 ----------
    // 主题状态为模块级单例，与侧栏「外观」按钮共用同一份值，两处改动实时一致
    const { theme, setTheme } = useTheme();
    const themeOptions = [
      { key: 'system', label: '跟随系统', desc: '随操作系统深浅色自动切换' },
      { key: 'light', label: '浅色', desc: '门店明亮环境推荐' },
      { key: 'dark', label: '深色', desc: '夜间或低照度环境' }
    ];

    // 二级导航：点击滚动到对应分区。不做滚动监听，省掉长列表的滚动计算开销
    const activeSection = Vue.ref('account');
    function goSection(key) {
      activeSection.value = key;
      const el = document.getElementById('sec-' + key);
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function logout() {
      emit('logout');
    }

    return {
      user: props.user, oldPassword, newPassword, confirmPassword, saving, submit, fmt, storeLabel, roleLabel,
      version, updateInfo, downloading, canAutoDownload, progressPercent, progressText,
      downloadPackage, cancelDownload,
      theme, themeOptions, setTheme, activeSection, goSection, logout
    };
  },
  template: `
    <div>
      <div class="page-head">
        <h2>设置</h2>
        <p>查看账号信息、调整外观并修改登录密码</p>
      </div>

      <div class="settings-layout">
        <!-- 左侧二级导航 200px（sticky） -->
        <aside class="settings-nav">
          <button class="settings-nav-item" :class="{ on: activeSection === 'account' }" @click="goSection('account')">账户与安全</button>
          <button class="settings-nav-item" :class="{ on: activeSection === 'appearance' }" @click="goSection('appearance')">外观</button>
          <button class="settings-nav-item" :class="{ on: activeSection === 'version' }" @click="goSection('version')">版本与更新</button>
          <button class="settings-nav-item" :class="{ on: activeSection === 'about' }" @click="goSection('about')">关于</button>
        </aside>

        <!-- 右侧：每分区一张卡，危险区独立红描边卡 -->
        <div class="settings-sections">
          <section id="sec-account" class="card">
            <div class="card-title">👤 账号信息</div>
            <div class="info-row"><span>账号</span><b>{{ user.username }}</b></div>
            <div class="info-row"><span>姓名</span><b>{{ user.name }}</b></div>
            <div class="info-row"><span>角色</span><b>{{ roleLabel(user.role) }}</b></div>
            <div class="info-row"><span>所属门店</span><b>{{ storeLabel }}</b></div>
            <div class="info-row"><span>拍照权限</span><b>{{ user.permissions && user.permissions.capture ? '已开通' : '未开通' }}</b></div>
            <div class="info-row"><span>查询权限</span><b>{{ user.permissions && user.permissions.query ? '已开通' : '未开通' }}</b></div>
            <div class="info-row"><span>创建时间</span><b>{{ fmt(user.createdAt) }}</b></div>
            <div class="info-row"><span>最近登录</span><b>{{ user.lastLoginAt ? fmt(user.lastLoginAt) : '-' }}</b></div>
          </section>

          <section class="card">
            <div class="card-title">🔒 修改密码</div>
            <label>原密码</label>
            <input v-model="oldPassword" type="password" placeholder="请输入原密码" />
            <label>新密码（至少 6 位）</label>
            <input v-model="newPassword" type="password" placeholder="请输入新密码" />
            <label>确认新密码</label>
            <input v-model="confirmPassword" type="password" placeholder="请再次输入新密码" />
            <button class="btn btn-primary" :disabled="saving" @click="submit">
              {{ saving ? '保存中…' : '保存修改' }}
            </button>
          </section>

          <section id="sec-appearance" class="card">
            <div class="card-title">🎨 外观</div>
            <div class="theme-choices">
              <button
                v-for="t in themeOptions"
                :key="t.key"
                class="theme-choice"
                :class="{ on: theme === t.key }"
                @click="setTheme(t.key)"
              >
                <span class="theme-swatch" :class="t.key"></span>
                <b>{{ t.label }}</b>
                <span class="theme-desc">{{ t.desc }}</span>
              </button>
            </div>
            <p class="settings-version-tip">与侧栏「外观」按钮共用同一份设置，两处改动实时一致。</p>
          </section>

          <section id="sec-version" class="card">
            <div class="card-title">⬇️ 版本与更新</div>
            <div class="settings-version">
              <span class="login-version-text">当前版本 <b>v{{ version || '-' }}</b></span>
              <template v-if="downloading">
                <div class="login-dl-progress">
                  <div class="login-dl-bar"><i :style="{ width: progressPercent + '%' }"></i></div>
                  <span>{{ progressText }}</span>
                </div>
                <button class="btn btn-ghost btn-sm" @click="cancelDownload">取消下载</button>
              </template>
              <template v-else>
                <button v-if="canAutoDownload" class="btn btn-primary btn-sm" @click="downloadPackage">
                  ⬇️ 一键下载安装包
                </button>
                <button v-else-if="updateInfo" class="btn btn-ghost btn-sm" @click="downloadPackage">
                  ⬇️ 打开下载页
                </button>
                <p class="settings-version-tip">下载完成后会打开安装包所在文件夹，双击安装即可覆盖升级。</p>
              </template>
            </div>
          </section>

          <section id="sec-about" class="card">
            <div class="card-title">ℹ️ 关于</div>
            <div class="info-row"><span>软件名称</span><b>星期衣精致洗衣 · 衣物照片系统</b></div>
            <div class="info-row"><span>当前版本</span><b class="code">v{{ version || '-' }}</b></div>
            <div class="info-row"><span>所属门店</span><b>{{ storeLabel }}</b></div>
            <div class="info-row"><span>登录账号</span><b>{{ user.username }}</b></div>
          </section>

          <!-- 危险区：独立红描边卡，与其他设置物理隔离 -->
          <section class="card danger-zone">
            <div class="card-title">⚠️ 危险区</div>
            <div class="danger-row">
              <div>
                <b>退出登录</b>
                <p>退出后需要重新输入账号密码；离线未同步的照片会保留在本机。</p>
              </div>
              <button class="btn btn-danger-outline" @click="logout">退出登录</button>
            </div>
          </section>
        </div>
      </div>
    </div>
  `
};

/* ---------- 管理端 · 数据总览 ---------- */
const AdminOverviewPage = {
  props: { token: { type: String, required: true } },
  setup(props) {
    const o = Vue.ref(null);

    async function load() {
      const r = await window.api.overview(props.token);
      if (r.ok) o.value = r.data;
      else toast(r.message || '加载失败', 'error');
    }

    Vue.onMounted(load);

    // 四级角色构成：按固定顺序展示，后端 overview 返回 roleCount；
    // 旧版后端未返回该字段时退化为 0，避免模板渲染 undefined
    const ROLE_ORDER = ['sysadmin', 'storeadmin', 'capture', 'query'];
    const roleBreakdown = Vue.computed(() => {
      const counts = (o.value && o.value.roleCount) || {};
      return ROLE_ORDER.map((key) => ({
        key,
        label: roleLabel(key),
        count: Number(counts[key]) || 0
      }));
    });

    return { o, fmt, roleBreakdown };
  },
  template: `
    <div>
      <div class="page-head">
        <h2>数据总览</h2>
        <p>账号、存档与操作日志的整体情况</p>
      </div>

      <div v-if="o" class="overview-grid">
        <div class="stat-card"><div class="lbl">账号总数</div><div class="num">{{ o.userCount }}</div></div>
        <div class="stat-card"><div class="lbl">启用中账号</div><div class="num">{{ o.activeUserCount }}</div></div>
        <div class="stat-card"><div class="lbl">存档照片总数</div><div class="num">{{ o.recordCount }}</div></div>
        <div class="stat-card"><div class="lbl">今日新增存档</div><div class="num">{{ o.todayRecordCount }}</div></div>
      </div>

      <!-- 四级角色构成：让系统管理员掌握账号分布（后端 overview 的 roleCount） -->
      <h3 class="section-title">账号角色构成</h3>
      <div v-if="o" class="overview-grid">
        <div v-for="r in roleBreakdown" :key="r.key" class="stat-card">
          <div class="lbl">{{ r.label }}</div>
          <div class="num">{{ r.count }}</div>
        </div>
      </div>

      <h3 class="section-title">最近存档</h3>
      <div class="card">
        <div v-if="o && !o.recentRecords.length" class="empty">
          <div class="empty-icon" aria-hidden="true"></div>
          <div class="empty-title">暂无存档记录</div>
          <div class="empty-desc">本店还没有衣物照片入库</div>
        </div>
        <div v-else-if="o" class="record-grid">
          <div v-for="r in o.recentRecords" :key="r.id" class="record-card" style="cursor:default">
            <div class="record-photo"><img :src="r.thumbUrl || r.photoUrl" loading="lazy" decoding="async" /></div>
            <div class="record-meta">
              <div class="record-customer">{{ r.barcode }}</div>
              <div class="record-tags">
                <span class="tag tag-orange">第 {{ r.seq }} 张</span>
                <span class="tag tag-owner">{{ r.username }}</span>
              </div>
              <div class="record-time">{{ fmt(r.createdAt) }}</div>
            </div>
          </div>
        </div>
      </div>

      <h3 class="section-title">最近操作日志</h3>
      <div class="card table-wrap">
        <table v-if="o">
          <thead>
            <tr><th>时间</th><th>账号</th><th>IP</th><th>模块</th><th>操作</th><th class="wrap">详情</th></tr>
          </thead>
          <tbody>
            <tr v-for="l in o.recentLogs" :key="l.id">
              <td>{{ fmt(l.time) }}</td>
              <td>{{ l.username }}</td>
              <td class="ip-cell">{{ l.ip || '-' }}</td>
              <td>{{ l.module }}</td>
              <td><span class="tag" :class="l.result === '失败' ? 'tag-red' : 'tag-green'">{{ l.action }}</span></td>
              <td class="wrap">{{ l.detail }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `
};

/* ---------- 管理端 · 用户与权限 ---------- */
const AdminUsersPage = {
  props: { token: { type: String, required: true } },
  setup(props) {
    const users = Vue.ref([]);
    const modal = Vue.ref(null); // 'create' | 'edit'
    const form = Vue.ref(emptyForm());
    const saving = Vue.ref(false);

    // 四级角色清单与能力矩阵：从后端取（单一数据源），
    // 避免前端硬编码一份而与后端权限判定脱节
    const roleOptions = Vue.ref([
      { value: 'sysadmin', label: '系统管理员' },
      { value: 'storeadmin', label: '门店管理员' },
      { value: 'capture', label: '拍照账号' },
      { value: 'query', label: '查询账号' }
    ]);
    const roleDefs = Vue.ref({});

    async function loadRoles() {
      try {
        const r = await window.api.roleOptions();
        if (r.ok && r.data) {
          if (Array.isArray(r.data.roles) && r.data.roles.length) roleOptions.value = r.data.roles;
          if (r.data.defs) roleDefs.value = r.data.defs;
        }
      } catch (e) {
        /* 拉取失败时退回内置清单，不影响账号管理 */
      }
    }

    // 当前所选角色的派生权限（只读展示用）
    const derivedPermissions = Vue.computed(() => {
      const def = roleDefs.value[form.value.role];
      if (def) return { capture: !!def.capture, query: !!def.query };
      // 后端能力矩阵未加载到时的兜底，与后端 ROLES 定义保持一致
      if (isSysAdminRole(form.value.role)) return { capture: true, query: true };
      if (form.value.role === 'query') return { capture: false, query: true };
      if (form.value.role === 'storeadmin') return { capture: false, query: true };
      return { capture: true, query: true };
    });

    // 角色能力说明：让管理员在选择时就明白各角色能做什么
    const roleHint = Vue.computed(() => {
      const hints = {
        sysadmin: '可查看全部与全部门店的订单、设置账号与权限、查看所有门店操作日志、修改系统设置。无需分配门店。',
        storeadmin: '可查看本门店全部订单与本门店操作日志，不能拍照录入、不能管理账号、不能删除订单。必须分配门店。',
        capture: '可拍照录入订单，并查询本人与同门店同事的订单。不能查看操作日志、不能管理账号。',
        query: '仅可查询本人与同门店同事的订单，不能拍照录入。不能查看操作日志、不能管理账号。'
      };
      return hints[form.value.role] || '权限由角色决定。';
    });

    function emptyForm() {
      return {
        id: '', username: '', name: '', role: 'capture',
        password: '', newPassword: '', active: true, store: '',
        permissions: { capture: true, query: true }
      };
    }

    async function load() {
      const r = await window.api.listUsers(props.token);
      if (r.ok) users.value = r.data;
      else toast(r.message || '加载失败', 'error');
    }

    function openCreate() {
      form.value = emptyForm();
      modal.value = 'create';
    }

    function openEdit(u) {
      form.value = {
        id: u.id,
        username: u.username,
        name: u.name,
        role: u.role,
        password: '',
        newPassword: '',
        active: u.active,
        store: u.store || '',
        permissions: { capture: !!u.permissions.capture, query: !!u.permissions.query }
      };
      modal.value = 'edit';
    }

    async function submit() {
      const f = form.value;
      // 门店管理员必须分配门店：先在前端拦住，给出明确提示（后端同样校验）
      if (f.role === 'storeadmin' && !String(f.store || '').trim()) {
        toast('门店管理员必须分配门店', 'error');
        return;
      }
      // 权限由角色决定，提交派生值而不是表单勾选值（表单已不再提供勾选）
      const perms = derivedPermissions.value;
      saving.value = true;
      try {
        let r;
        if (modal.value === 'create') {
          r = await window.api.createUser(
            props.token,
            f.username,
            f.name,
            f.role,
            f.password,
            perms.capture,
            perms.query,
            f.store
          );
        } else {
          r = await window.api.updateUser(
            props.token,
            f.id,
            f.name,
            f.role,
            f.active,
            perms.capture,
            perms.query,
            f.newPassword,
            f.store
          );
        }
        if (r.ok) {
          toast(modal.value === 'create' ? '账号已创建' : '已保存修改', 'success');
          modal.value = null;
          load();
        } else {
          toast(r.message || '操作失败', 'error');
        }
      } catch (e) {
        toast('操作失败：' + (e.message || e), 'error');
      } finally {
        saving.value = false;
      }
    }

    async function toggleActive(u) {
      try {
        const r = await window.api.updateUser(props.token, u.id, u.name, u.role, !u.active, null, null, '');
        if (r.ok) {
          toast(u.active ? '账号已停用' : '账号已启用', 'success');
          load();
        } else {
          toast(r.message || '操作失败', 'error');
        }
      } catch (e) {
        toast('操作失败：' + (e.message || e), 'error');
      }
    }

    async function remove(u) {
      const ok = await showConfirm({ title: '删除账号', message: '删除账号『' + u.username + '』？\n该操作不可恢复。', confirmText: '删除账号', danger: true });
      if (!ok) return;
      const r = await window.api.deleteUser(props.token, u.id);
      if (r.ok) {
        toast('账号已删除', 'success');
        load();
      } else {
        toast(r.message || '删除失败', 'error');
      }
    }

    // 门店候选：从现有账号中汇总已用过的门店名，便于选择、减少拼写不一致
    const storeOptions = Vue.computed(() => {
      const set = new Set();
      for (const u of users.value) {
        const s = String(u.store || '').trim();
        if (s) set.add(s);
      }
      return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    });

    Vue.onMounted(() => {
      loadRoles();
      load();
    });
    return {
      users, modal, form, saving, storeOptions,
      roleOptions, derivedPermissions, roleHint,
      openCreate, openEdit, submit, toggleActive, remove,
      fmt, roleLabel, roleTagClass, isSysAdminRole
    };
  },
  template: `
    <div>
      <div class="page-head">
        <h2>用户与权限管理</h2>
        <p>创建、编辑、停用或删除系统账号，并为每个账号分配功能权限</p>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <div class="card-title" style="margin:0;border:none;padding:0">账号列表（{{ users.length }}）</div>
          <button class="btn btn-primary" @click="openCreate">＋ 新增账号</button>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>用户名</th><th>姓名</th><th>角色</th><th>门店</th><th>功能权限</th>
                <th>状态</th><th>创建时间</th><th>最近登录</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in users" :key="u.id">
                <td><b>{{ u.username }}</b></td>
                <td>{{ u.name }}</td>
                <td><span class="tag" :class="roleTagClass(u.role)">{{ roleLabel(u.role) }}</span></td>
                <td>
                  <span v-if="u.store" class="tag">{{ u.store }}</span>
                  <span v-else-if="isSysAdminRole(u.role)" class="tag tag-gray">不限（可见全部）</span>
                  <span v-else-if="u.role === 'storeadmin'" class="tag tag-red">未分配（异常）</span>
                  <span v-else style="color:#9aa0a6">未分配</span>
                </td>
                <td>
                  <!-- 权限由角色派生，此处仅做只读展示，不可单独勾选 -->
                  <span v-if="isSysAdminRole(u.role)" class="tag tag-gray">全部功能</span>
                  <template v-else>
                    <span class="tag" :class="u.permissions.capture ? 'tag-green' : 'tag-gray'">拍照 {{ u.permissions.capture ? '开' : '关' }}</span>
                    <span class="tag" :class="u.permissions.query ? 'tag-green' : 'tag-gray'" style="margin-left:4px">查询 {{ u.permissions.query ? '开' : '关' }}</span>
                    <span v-if="u.role === 'storeadmin'" class="tag tag-orange" style="margin-left:4px">本店日志</span>
                  </template>
                </td>
                <td><span class="tag" :class="u.active ? 'tag-green' : 'tag-red'">{{ u.active ? '启用' : '停用' }}</span></td>
                <td>{{ fmt(u.createdAt) }}</td>
                <td>{{ u.lastLoginAt ? fmt(u.lastLoginAt) : '-' }}</td>
                <td>
                  <div class="td-actions">
                    <button class="btn btn-ghost btn-sm" @click="openEdit(u)">编辑</button>
                    <button class="btn btn-ghost btn-sm" @click="toggleActive(u)">{{ u.active ? '停用' : '启用' }}</button>
                    <button class="btn btn-danger btn-sm" @click="remove(u)">删除</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="modal" class="modal-mask" @click.self="modal = null">
        <div class="modal modal-sm">
          <div class="modal-head">
            <h3>{{ modal === 'create' ? '新增账号' : '编辑账号' }}</h3>
            <button class="modal-close" @click="modal = null">✕</button>
          </div>
          <div class="modal-body">
            <label>用户名</label>
            <input v-model="form.username" :disabled="modal === 'edit'" placeholder="3-20 位字母、数字或下划线" />
            <label>姓名</label>
            <input v-model="form.name" placeholder="用于界面显示" />
            <label>角色</label>
            <select v-model="form.role">
              <option v-for="r in roleOptions" :key="r.value" :value="r.value">{{ r.label }}</option>
            </select>
            <div class="form-hint">{{ roleHint }}</div>
            <label>所属门店{{ form.role === 'storeadmin' ? '（必填）' : '' }}</label>
            <input
              v-model="form.store"
              list="store-options"
              maxlength="40"
              :placeholder="form.role === 'storeadmin' ? '如：人民路店（门店管理员必须分配）' : '如：人民路店（留空表示不归属任何门店）'"
            />
            <datalist id="store-options">
              <option v-for="s in storeOptions" :key="s" :value="s"></option>
            </datalist>
            <div class="form-hint">
              同一门店的账号可互相查询彼此的订单照片；门店名称必须完全一致才会归为同店。
              系统管理员可查看全部记录，无需分配门店。
            </div>
            <template v-if="modal === 'create'">
              <label>初始密码（至少 6 位）</label>
              <input v-model="form.password" type="password" placeholder="请设置初始密码" />
            </template>
            <template v-else>
              <label>重置密码（留空表示不修改）</label>
              <input v-model="form.newPassword" type="password" placeholder="如需重置请输入新密码" />
              <div class="check-row" style="margin-top:14px">
                <label><input type="checkbox" v-model="form.active" />账号启用</label>
              </div>
            </template>
            <!-- 权限由角色固定派生，不再提供勾选：避免出现「门店管理员可拍照」这类与角色矛盾的账号 -->
            <label>功能权限（由角色决定，不可单独修改）</label>
            <div class="check-row">
              <span class="tag" :class="derivedPermissions.capture ? 'tag-green' : 'tag-gray'">
                拍照 {{ derivedPermissions.capture ? '开' : '关' }}
              </span>
              <span class="tag" :class="derivedPermissions.query ? 'tag-green' : 'tag-gray'" style="margin-left:4px">
                查询 {{ derivedPermissions.query ? '开' : '关' }}
              </span>
              <span v-if="form.role === 'storeadmin'" class="tag tag-orange" style="margin-left:4px">本店日志</span>
              <span v-if="isSysAdminRole(form.role)" class="tag tag-gray" style="margin-left:4px">账号与系统设置</span>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="modal = null">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="submit">
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  `
};

/* ---------- 管理端 · 操作日志 ---------- */
const AdminLogsPage = {
  props: {
    token: { type: String, required: true },
    // Shell 统一向各页面传入 user；日志页用其角色区分「本店日志」与「全部日志」的范围说明
    user: { type: Object, default: null }
  },
  setup(props) {
    const keyword = Vue.ref('');
    const action = Vue.ref('all');
    const userIdFilter = Vue.ref('all');
    const dateFrom = Vue.ref('');
    const dateTo = Vue.ref('');
    const users = Vue.ref([]);
    const items = Vue.ref([]);
    const total = Vue.ref(0);
    const page = Vue.ref(1);
    const pageSize = 20;
    const loading = Vue.ref(false);
    // 操作类型清单由后端提供（登记清单 ∪ 日志中实际出现过的类型），
    // 前端不再硬编码，避免出现「新增条码」这类选项缺失的问题
    const actions = Vue.ref([]);

    async function loadActions() {
      try {
        const r = await window.api.logActionOptions(props.token);
        if (r.ok && Array.isArray(r.data)) actions.value = r.data;
      } catch (e) {
        /* 拉取失败时下拉仅保留「全部操作」，不影响日志查询本身 */
      }
    }

    async function loadUsers() {
      // 用日志专用接口而非 listUsers：门店管理员无账号管理权限，
      // 且该接口已按角色收窄（系统管理员=全部，门店管理员=仅本店账号）
      try {
        const r = await window.api.logFilterUsers(props.token);
        if (r.ok && Array.isArray(r.data)) users.value = r.data;
      } catch (e) {
        users.value = [];
      }
    }

    async function search(reset) {
      if (reset) page.value = 1;
      loading.value = true;
      try {
        const r = await window.api.listLogs(props.token, {
          keyword: keyword.value,
          action: action.value,
          userId: userIdFilter.value,
          dateFrom: dateFrom.value,
          dateTo: dateTo.value,
          page: page.value,
          pageSize
        });
        if (r.ok) {
          items.value = r.data.items;
          total.value = r.data.total;
        } else {
          toast(r.message || '查询失败', 'error');
        }
      } catch (e) {
        toast('查询失败：' + (e.message || e), 'error');
      } finally {
        loading.value = false;
      }
    }

    function reset() {
      keyword.value = '';
      action.value = 'all';
      userIdFilter.value = 'all';
      dateFrom.value = '';
      dateTo.value = '';
      search(true);
    }

    const totalPages = Vue.computed(() => Math.max(1, Math.ceil(total.value / pageSize)));

    function prev() {
      if (page.value > 1) {
        page.value--;
        search(false);
      }
    }

    function next() {
      if (page.value < totalPages.value) {
        page.value++;
        search(false);
      }
    }

    Vue.onMounted(() => {
      loadActions();
      loadUsers();
      search(true);
    });

    // 门店管理员只能看本店日志，标题据实说明范围，避免误以为在看全部
    const isStoreAdmin = String((props.user && props.user.role) || '') === 'storeadmin';
    const scopeText = isStoreAdmin ? '本门店账号' : '所有账号';

    return {
      keyword, action, userIdFilter, dateFrom, dateTo, users, items, total,
      page, pageSize, totalPages, loading, actions,
      search, reset, prev, next, fmt, roleLabel, scopeText
    };
  },
  template: `
    <div>
      <div class="page-head">
        <h2>操作日志查询</h2>
        <p>查询{{ scopeText }}的登录与操作记录，支持按账号、操作类型、关键词和日期筛选</p>
      </div>

      <div class="card">
        <div class="filter-bar">
          <div class="f-item f-keyword">
            <label>关键词</label>
            <input v-model="keyword" placeholder="账号 / 模块 / 详情" @keyup.enter="search(true)" />
          </div>
          <div class="f-item f-user">
            <label>账号</label>
            <select v-model="userIdFilter">
              <option value="all">全部账号</option>
              <option v-for="u in users" :key="u.id" :value="u.id">{{ u.username }}（{{ u.name }}）</option>
            </select>
          </div>
          <div class="f-item f-select">
            <label>操作类型</label>
            <select v-model="action">
              <option value="all">全部操作</option>
              <option v-for="a in actions" :key="a" :value="a">{{ a }}</option>
            </select>
          </div>
          <div class="f-item f-date">
            <label>开始日期</label>
            <input type="date" v-model="dateFrom" />
          </div>
          <div class="f-item f-date">
            <label>结束日期</label>
            <input type="date" v-model="dateTo" />
          </div>
          <button class="btn btn-primary" @click="search(true)">查询</button>
          <button class="btn btn-ghost" @click="reset">重置</button>
        </div>

        <div v-if="loading" class="skeleton-grid" aria-busy="true">
          <div v-for="n in 6" :key="n" class="skeleton skeleton-row"></div>
        </div>
        <div v-else-if="!items.length" class="empty">
          <div class="empty-icon" aria-hidden="true"></div>
          <div class="empty-title">没有符合条件的操作日志</div>
          <div class="empty-desc">调整账号或操作类型再试一次。</div>
          <button class="btn btn-ghost" @click="reset">清空筛选条件</button>
        </div>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th><th>账号</th><th>IP</th><th>角色</th><th>模块</th>
                <th>操作</th><th>结果</th><th class="wrap">详情</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in items" :key="l.id">
                <td>{{ fmt(l.time) }}</td>
                <td><b>{{ l.username }}</b></td>
                <td class="ip-cell">{{ l.ip || '-' }}</td>
                <td>{{ roleLabel(l.role) }}</td>
                <td>{{ l.module }}</td>
                <td>{{ l.action }}</td>
                <td><span class="tag" :class="l.result === '失败' ? 'tag-red' : 'tag-green'">{{ l.result }}</span></td>
                <td class="wrap">{{ l.detail }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="pager">
          <span class="pager-info">共 {{ total }} 条 · 第 {{ page }}/{{ totalPages }} 页</span>
          <button class="btn btn-ghost btn-sm" :disabled="page <= 1" @click="prev">上一页</button>
          <button class="btn btn-ghost btn-sm" :disabled="page >= totalPages" @click="next">下一页</button>
        </div>
      </div>
    </div>
  `
};

/* ---------- 管理端 · 系统设置 ---------- */
const AdminSystemPage = {
  props: { token: { type: String, required: true } },
  setup(props) {
    const info = Vue.ref(null);
    const localIp = Vue.ref('');
    const portInput = Vue.ref('');
    const savingPort = Vue.ref(false);
    const photoPathInput = Vue.ref('');
    const savingPath = Vue.ref(false);
    const resettingToken = Vue.ref(false);
    const version = Vue.ref('');
    const updateInfo = Vue.ref(null);
    const checking = Vue.ref(false);
    const downloading = Vue.ref(false);
    const dlProgress = Vue.ref({ received: 0, total: 0 });
    let removeProgress = null;

    // ---------- 强制推送安装包（仅服务端可设置） ----------
    const forceInfo = Vue.ref(null); // { enabled, version, fileName, fileExists, files:[{name,size,version}] }
    const forceFile = Vue.ref(''); // 下拉选中的安装包文件名
    const savingForce = Vue.ref(false);

    // ---------- 开机自动启动（仅服务端可设置） ----------
    // autoLaunchInfo: { enabled, supported, platform, serverMode, launchedHidden }
    const autoLaunchInfo = Vue.ref(null);
    const savingAutoLaunch = Vue.ref(false);

    async function loadAutoLaunch() {
      try {
        const r = await window.api.autoLaunch();
        if (r.ok && r.data) autoLaunchInfo.value = r.data;
      } catch (e) {
        /* 读取失败时保持 null，界面显示为「未知」并禁用开关 */
      }
    }

    // 仅「服务端模式 + 系统支持 + 状态读取成功」时可设置，避免客户端工位机被误设为常驻
    const canSetAutoLaunch = Vue.computed(() => {
      const a = autoLaunchInfo.value;
      return !!(a && a.supported && a.serverMode);
    });
    const autoLaunchDisabledReason = Vue.computed(() => {
      const a = autoLaunchInfo.value;
      if (!a) return '当前无法读取系统登录项状态，请点击「刷新状态」重试；若仍失败，可能是系统策略限制了该功能。';
      if (!a.supported) return '当前操作系统不支持开机自动启动（仅 Windows 与 macOS 可用）。';
      if (!a.serverMode) return '仅服务端模式可开启开机自动启动。客户端为工位机、无需常驻；如需本机提供照片服务，请先在启动设置中切换为服务端模式。';
      return '';
    });

    async function toggleAutoLaunch(enable) {
      savingAutoLaunch.value = true;
      try {
        const r = await window.api.setAutoLaunch(props.token, enable);
        if (r.ok) {
          // 以主进程返回的真实系统状态为准，而不是直接采信本次请求值
          await loadAutoLaunch();
          toast(
            enable
              ? '已开启开机自动启动：开机后静默驻留托盘提供服务，需要界面时从托盘图标打开'
              : '已取消开机自动启动',
            'success'
          );
        } else {
          // 设置被拒绝（权限或系统策略）：同步回读真实状态，避免开关显示与实际不一致
          await loadAutoLaunch();
          toast(r.message || '设置失败', 'error');
        }
      } catch (e) {
        await loadAutoLaunch();
        toast('设置失败：' + (e.message || e), 'error');
      } finally {
        savingAutoLaunch.value = false;
      }
    }

    // ---------- 订单数据保留期与自动清理（仅服务端生效） ----------
    // retentionInfo: { retentionDays, enabled, runnable, mode, recordCount, wouldDelete,
    //                  cutoffIso, lastAutoPurgeAt }
    const retentionInfo = Vue.ref(null);
    const savingRetention = Vue.ref(false);
    const purging = Vue.ref(false);
    // 输入框用字符串：空串表示「取消自动删除」，避免用 null 与 0 混淆
    // （0 会被数据层拒绝——那等于删光全部订单）
    const retentionInput = Vue.ref('');
    const purgeResult = Vue.ref(''); // 最近一次试算/清理的结果文案

    async function loadRetention() {
      try {
        const r = await window.api.retention(props.token);
        if (r.ok && r.data) {
          retentionInfo.value = r.data;
          // 仅在未编辑时回填，避免覆盖管理员正在输入的值
          if (!savingRetention.value) {
            retentionInput.value = r.data.retentionDays === null ? '' : String(r.data.retentionDays);
          }
        } else if (r.message) {
          // 无权限（非系统管理员）或读取失败时不弹错，交给下方提示区说明
          retentionInfo.value = null;
        }
      } catch (e) {
        retentionInfo.value = null;
      }
    }

    // 仅服务端模式可设置与执行：客户端本机存档只是镜像，删了会造成两端不一致
    const canSetRetention = Vue.computed(() => !!(retentionInfo.value && retentionInfo.value.runnable));
    const retentionDisabledReason = Vue.computed(() => {
      const r = retentionInfo.value;
      if (!r) return '无法读取保留期设置：请确认已用系统管理员账号登录。';
      if (!r.runnable) return '仅服务端模式可设置订单保留期。客户端本机存档只是服务端的镜像，删除会造成两端不一致；请在服务端电脑上设置。';
      return '';
    });

    /** 校验输入，返回数字或 null（取消）；非法时返回 { error } */
    function parseRetentionInput() {
      const raw = String(retentionInput.value || '').trim();
      if (raw === '') return { value: null };
      if (!/^\d+$/.test(raw)) return { error: '请输入整数天数，或留空表示不自动删除' };
      const n = Number(raw);
      if (n === 0) return { error: '保留天数不能为 0（那等于删除全部订单）；如需关闭自动删除请清空后保存' };
      if (n > 3650) return { error: '保留天数过大（最多 3650 天）' };
      return { value: n };
    }

    async function saveRetention() {
      const parsed = parseRetentionInput();
      if (parsed.error) {
        toast(parsed.error, 'error');
        return;
      }
      // 缩短保留期会让更多订单变成「超期」，保存前必须让管理员知道影响面
      if (parsed.value !== null && retentionInfo.value) {
        const cur = retentionInfo.value.retentionDays;
        const shrinking = cur === null || parsed.value < cur;
        if (shrinking) {
          const ok = await showConfirm({
            title: '设置订单保留期',
            danger: true,
            message:
              `将订单保留期设为 ${parsed.value} 天后，超过该期限的订单及其照片将被自动删除，且不可恢复。\n\n` +
              `保存本身不会立即删除数据（自动清理按计划在后台执行），你也可以点「试算」先看看会影响多少条。`,
            confirmText: '保存保留期'
          });
          if (!ok) return;
        }
      }
      savingRetention.value = true;
      try {
        const r = await window.api.setRetention(props.token, parsed.value);
        if (r.ok) {
          toast(parsed.value === null ? '已取消订单自动删除' : `已设置订单保留期为 ${parsed.value} 天`, 'success');
          purgeResult.value = '';
          await loadRetention();
          retentionInput.value = r.data.retentionDays === null ? '' : String(r.data.retentionDays);
        } else {
          toast(r.message || '设置失败', 'error');
        }
      } catch (e) {
        toast('设置失败：' + (e.message || e), 'error');
      } finally {
        savingRetention.value = false;
      }
    }

    /** 试算：只统计不删除，让管理员在真删之前看到确切影响面 */
    async function previewPurge() {
      purging.value = true;
      try {
        const r = await window.api.purgeExpired(props.token, true);
        if (r.ok && r.data) {
          purgeResult.value = r.data.skipped
            ? '未执行：' + r.data.reason
            : `试算结果：将删除 ${r.data.deleted} 条超期订单（截止时间点 ${fmt(r.data.cutoffIso)}），保留 ${r.data.kept} 条。尚未删除任何数据。`;
        } else {
          purgeResult.value = '';
          toast(r.message || '试算失败', 'error');
        }
      } catch (e) {
        toast('试算失败：' + (e.message || e), 'error');
      } finally {
        purging.value = false;
      }
    }

    /** 立即清理：不可逆，先试算拿确切条数，再二次确认 */
    async function purgeNow() {
      purging.value = true;
      try {
        // 先取一次真实条数，避免用界面上可能已过期的 wouldDelete 去确认
        const pre = await window.api.purgeExpired(props.token, true);
        if (!pre.ok) throw new Error(pre.message || '试算失败');
        if (pre.data.skipped) {
          purgeResult.value = '未执行：' + pre.data.reason;
          toast(pre.data.reason, 'error');
          return;
        }
        const n = pre.data.deleted;
        if (!n) {
          purgeResult.value = '没有超过保留期的订单，无需清理。';
          toast('没有超过保留期的订单', 'success');
          return;
        }
        // 手动清理是刻意绕过「全删熔断」的（熔断只防无人值守的自动误删），
        // 因此当本次会清空全部订单时，单独给出更醒目的警示，避免管理员误点。
        const wipingAll = pre.data.kept === 0;
        const ok = await showConfirm({
          title: '清理超期订单',
          danger: true,
          message:
            (wipingAll
              ? '⚠️ 警告：本次清理将删除【全部】订单数据，清理后系统将没有任何订单记录！\n\n'
              : '') +
            `即将永久删除 ${n} 条超期订单及其照片文件，此操作不可恢复。\n\n` +
            `保留期：${pre.data.retentionDays} 天\n截止时间点：${fmt(pre.data.cutoffIso)}\n删除后剩余：${pre.data.kept} 条\n\n` +
            (wipingAll ? '请先确认保留期设置正确，并务必先导出备份。' : '建议先导出备份。'),
          confirmText: '立即删除'
        });
        if (!ok) {
          purgeResult.value = '已取消，未删除任何数据。';
          return;
        }
        const r = await window.api.purgeExpired(props.token, false);
        if (r.ok && r.data) {
          purgeResult.value =
            `已删除 ${r.data.deleted} 条超期订单，删除照片 ${r.data.photosRemoved} 张` +
            (r.data.photosMissing ? `（照片文件缺失 ${r.data.photosMissing} 张）` : '') +
            `，剩余 ${r.data.kept} 条。`;
          toast('清理完成：' + purgeResult.value, 'success');
          await loadRetention();
        } else {
          toast(r.message || '清理失败', 'error');
        }
      } catch (e) {
        toast('清理失败：' + (e.message || e), 'error');
      } finally {
        purging.value = false;
      }
    }

    async function loadForceUpdate() {
      const r = await window.api.forceUpdate();
      if (r.ok && r.data) {
        forceInfo.value = r.data;
        const files = r.data.files || [];
        if (r.data.enabled && r.data.fileName) {
          forceFile.value = r.data.fileName;
        } else if (!forceFile.value) {
          // 默认选中版本号最高的安装包，减少一次手动选择
          forceFile.value = files.length ? files[0].name : '';
        }
      }
    }

    async function setForceUpdate(enabled) {
      if (enabled && !forceFile.value) {
        toast('请先选择要推送的安装包文件', 'error');
        return;
      }
      savingForce.value = true;
      try {
        const r = await window.api.setForceUpdate(props.token, enabled, forceFile.value);
        if (r.ok) {
          forceInfo.value = r.data;
          toast(enabled ? '已开启强制推送：客户端下次登录将自动下载并提示安装' : '已取消强制推送', 'success');
        } else {
          toast(r.message || '设置失败', 'error');
        }
      } catch (e) {
        toast('设置失败：' + (e.message || e), 'error');
      } finally {
        savingForce.value = false;
      }
    }

    async function loadVersion() {
      const r = await window.api.version();
      if (r.ok) version.value = r.data.version;
    }

    async function checkUpdate(manual) {
      checking.value = true;
      try {
        const r = await window.api.checkUpdate();
        if (r.ok) {
          updateInfo.value = r.data;
          if (manual) {
            toast(
              r.data.hasUpdate
                ? '发现新版本 ' + r.data.latestVersion + '（当前 ' + r.data.currentVersion + '）'
                : '当前已是最新版本 ' + r.data.currentVersion,
              r.data.hasUpdate ? 'success' : 'success'
            );
          }
        } else if (manual) {
          toast(r.message || '检查更新失败', 'error');
        }
      } catch (e) {
        if (manual) toast('检查更新失败：' + (e.message || e), 'error');
      } finally {
        checking.value = false;
      }
    }

    async function openUpdateFolder() {
      const r = await window.api.openUpdateDir();
      if (!r.ok) toast(r.message || '打开失败', 'error');
    }

    async function openUpdatePage() {
      const r = await window.api.openUpdatePage();
      if (!r.ok) toast(r.message || '打开失败', 'error');
    }

    const canAutoDownload = Vue.computed(
      () => !!(updateInfo.value && updateInfo.value.source === 'github' && updateInfo.value.downloadUrl)
    );
    // 远程连接服务器时照片由服务端统一管理，本机不可修改保存路径
    const remoteLocked = Vue.computed(() => !!(info.value && info.value.remoteClient));
    const progressPercent = Vue.computed(() => {
      const { received, total } = dlProgress.value || {};
      if (!total || total <= 0) return 0;
      return Math.min(100, Math.round((received / total) * 100));
    });
    const progressText = Vue.computed(() => {
      const { received, total } = dlProgress.value || {};
      const base = total > 0 ? fmtSize(received) + ' / ' + fmtSize(total) + '（' + progressPercent.value + '%）' : fmtSize(received);
      const ch = dlProgress.value && dlProgress.value.channel;
      return base + (ch === 'accel' ? ' · 国内加速' : ch === 'direct' ? ' · 直连' : '');
    });

    async function downloadUpdateNow() {
      const info = updateInfo.value;
      if (!info || !info.downloadUrl || downloading.value) return;
      downloading.value = true;
      dlProgress.value = { received: 0, total: 0 };
      removeProgress = window.api.onDownloadProgress((p) => {
        dlProgress.value = p;
      });
      try {
        const r = await window.api.downloadUpdate(info.downloadUrl, info.assetName);
        if (r.ok) {
          toast('安装包下载完成' + (r.data && r.data.channel === 'accel' ? '（经国内加速通道）' : '') + '，已打开文件夹，双击安装即可覆盖升级', 'success');
        } else if (!r.canceled) {
          toast(r.message || '下载失败', 'error');
        } else {
          toast('已取消下载', 'success');
        }
      } catch (e) {
        toast('下载失败：' + (e.message || e), 'error');
      } finally {
        downloading.value = false;
        if (removeProgress) {
          removeProgress();
          removeProgress = null;
        }
      }
    }

    function cancelUpdateDownload() {
      window.api.cancelDownload();
    }

    // 防火墙排查助手：复制放行命令，管理员在「管理员终端」中粘贴执行即可放行端口
    async function copyFirewallCmd() {
      const cmd =
        'netsh advfirewall firewall add rule name="星期衣衣物照片系统" dir=in action=allow protocol=TCP localport=' +
        (portInput.value || '17521');
      const r = await window.api.copyText(cmd);
      if (r.ok) toast('放行命令已复制：请右键「开始」菜单→「终端（管理员）」，粘贴并回车执行', 'success');
      else toast(r.message || '复制失败', 'error');
    }

    async function load() {
      const r = await window.api.systemInfo();
      if (r.ok) {
        info.value = r.data;
        portInput.value = String(r.data.port);
        photoPathInput.value = r.data.photoDir;
      }
      const ip = await window.api.localIp();
      if (ip.ok) localIp.value = ip.data;
      loadVersion();
      checkUpdate(false);
      loadForceUpdate();
      loadAutoLaunch();
      loadRetention();
    }

    async function savePort() {
      savingPort.value = true;
      try {
        const r = await window.api.updateSettings(props.token, Number(portInput.value));
        if (r.ok) {
          toast('端口已保存，服务已按新端口重启', 'success');
          await load();
        } else {
          toast(r.message || '保存失败', 'error');
        }
      } catch (e) {
        toast('保存失败：' + (e.message || e), 'error');
      } finally {
        savingPort.value = false;
      }
    }

    async function resetToken() {
      const ok = await showConfirm({ title: '重置连接配置', message: '重置后，所有客户端需使用新连接码重新配置。', confirmText: '重置连接码', danger: true });
      if (!ok) return;
      resettingToken.value = true;
      try {
        const r = await window.api.resetApiToken(props.token);
        if (r.ok) {
          toast('连接码已重置', 'success');
          await load();
        } else {
          toast(r.message || '重置失败', 'error');
        }
      } finally {
        resettingToken.value = false;
      }
    }

    async function chooseDir() {
      if (remoteLocked.value) {
        toast('远程连接服务器状态下不可修改照片保存位置，请在服务端电脑上修改', 'error');
        return;
      }
      const r = await window.api.choosePhotoDir();
      if (r.ok) photoPathInput.value = r.data;
    }

    async function savePath() {
      if (remoteLocked.value) {
        toast('远程连接服务器状态下不可修改照片保存位置，请在服务端电脑上修改', 'error');
        return;
      }
      savingPath.value = true;
      try {
        const r = await window.api.setPhotoPath(props.token, photoPathInput.value);
        if (r.ok) {
          toast('照片保存路径已更新，迁移照片 ' + r.data.moved + ' 张', 'success');
          await load();
        } else {
          toast(r.message || '保存失败', 'error');
        }
      } catch (e) {
        toast('保存失败：' + (e.message || e), 'error');
      } finally {
        savingPath.value = false;
      }
    }

    Vue.onMounted(load);

    // 设计 v2：二级导航（点击滚动到对应分区，不做滚动监听）
    const activeSection = Vue.ref('service');
    function goSection(key) {
      activeSection.value = key;
      const el = document.getElementById('sec-' + key);
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    return {
      info, localIp, portInput, savingPort, savePort,
      resettingToken, resetToken,
      photoPathInput, savingPath, chooseDir, savePath, remoteLocked,
      version, updateInfo, checking, checkUpdate, openUpdateFolder, openUpdatePage, copyFirewallCmd,
      downloading, downloadUpdateNow, cancelUpdateDownload, canAutoDownload, progressPercent, progressText, fmtSize,
      forceInfo, forceFile, savingForce, setForceUpdate, loadForceUpdate,
      autoLaunchInfo, savingAutoLaunch, toggleAutoLaunch,
      loadAutoLaunch, canSetAutoLaunch, autoLaunchDisabledReason,
      // 订单保留期与自动清理
      retentionInfo, retentionInput, savingRetention, purging, purgeResult,
      loadRetention, saveRetention, previewPurge, purgeNow,
      canSetRetention, retentionDisabledReason, fmt,
      // 设计 v2：二级导航（点击滚动到对应分区，不做滚动监听）
      activeSection, goSection
    };
  },
  template: `
    <div>
      <div class="page-head">
        <h2>系统设置</h2>
        <p>服务端口、连接码与照片保存路径（仅服务端生效）</p>
      </div>

      <div v-if="info" class="settings-layout">
        <!-- 左侧二级导航 200px（sticky） -->
        <aside class="settings-nav">
          <button class="settings-nav-item" :class="{ on: activeSection === 'service' }" @click="goSection('service')">服务信息</button>
          <button class="settings-nav-item" :class="{ on: activeSection === 'storage' }" @click="goSection('storage')">存储与同步</button>
          <button class="settings-nav-item" :class="{ on: activeSection === 'autolaunch' }" @click="goSection('autolaunch')">开机自启</button>
          <button class="settings-nav-item" :class="{ on: activeSection === 'version' }" @click="goSection('version')">版本与更新</button>
          <button class="settings-nav-item" :class="{ on: activeSection === 'retention' }" @click="goSection('retention')">数据保留期</button>
        </aside>

        <div class="settings-sections">
        <section id="sec-service" class="card">
          <div class="card-title">🌐 服务信息</div>
          <div class="info-row"><span>运行模式</span><b>{{ info.mode === 'server' ? '服务端' : '客户端' }}</b></div>
          <div class="info-row"><span>本机局域网 IP</span><b>{{ localIp }}</b></div>
          <div class="info-row"><span>连接码</span><b class="code">{{ info.token }}</b></div>
          <div v-if="info.mode === 'client'" class="info-row"><span>服务器地址</span><b>{{ info.serverUrl }}</b></div>

          <div v-if="info.mode === 'server'">
            <label>服务端口（修改后自动重启服务）</label>
            <input v-model="portInput" type="number" min="1" max="65535" />
            <div style="display:flex;gap:10px;margin-top:16px">
              <button class="btn btn-primary" :disabled="savingPort" @click="savePort">
                {{ savingPort ? '保存中…' : '保存端口' }}
              </button>
              <button class="btn btn-ghost" :disabled="resettingToken" @click="resetToken">重置连接码</button>
            </div>
            <p class="setup-desc" style="margin-top:14px">
              其他电脑在本软件启动设置中选择「作为客户端」，
              填入地址 http://{{ localIp }}:{{ info.port }} 与上方连接码即可接入。
              跨城市使用时请通过异地组网或内网穿透工具打通网络。
            </p>
            <p class="setup-desc" style="margin-top:10px;padding:10px 12px;background:#fef9ec;border:1px solid #f5e0b0;border-radius:8px">
              💡 若局域网内其他电脑连不上：多为服务端电脑的防火墙拦截了入站连接。
              点击下方按钮复制放行命令，在「终端（管理员）」中粘贴执行后重试。
            </p>
            <div style="display:flex;gap:10px;margin-top:10px">
              <button class="btn btn-ghost" @click="copyFirewallCmd">复制防火墙放行命令</button>
            </div>
          </div>
        </section>

        <section id="sec-storage" class="card">
          <div class="card-title">🖼️ 存储与同步 · 照片保存路径</div>
          <label>保存目录（修改时自动迁移现有照片）</label>
          <input v-model="photoPathInput" placeholder="选择或输入目录路径" :disabled="remoteLocked" />
          <div style="display:flex;gap:10px;margin-top:16px">
            <button class="btn btn-ghost" :disabled="remoteLocked" @click="chooseDir">浏览…</button>
            <button class="btn btn-primary" style="flex:1" :disabled="savingPath || remoteLocked" @click="savePath">
              {{ savingPath ? '保存中…' : '保存路径' }}
            </button>
          </div>
          <p v-if="remoteLocked" class="setup-desc" style="margin-top:14px;padding:10px 12px;background:#fef9ec;border:1px solid #f5e0b0;border-radius:8px">
            🔒 当前为远程连接服务器状态（{{ info.serverUrl }}），照片由服务器统一保存管理，
            本机不可修改照片保存位置。如需调整，请在服务端电脑的本页面上修改。
          </p>
          <p v-else class="setup-desc" style="margin-top:14px">
            照片按原始分辨率保存为 JPG 文件；修改路径前会先校验目标目录，避免覆盖同名文件。
          </p>
        </section>

        <section v-if="info" id="sec-autolaunch" class="card">
          <div class="card-title">🚀 开机自动启动</div>
        <div class="info-row">
          <span>当前状态</span>
          <b v-if="!autoLaunchInfo">未知（读取失败，可点击刷新）</b>
          <b v-else-if="autoLaunchInfo.enabled" style="color:#16a34a">已开启</b>
          <b v-else>未开启</b>
        </div>
        <div v-if="autoLaunchInfo && autoLaunchInfo.launchedHidden" class="info-row">
          <span>本次启动方式</span>
          <b>开机自动启动（静默驻留托盘）</b>
        </div>
        <div style="display:flex;gap:10px;margin-top:16px;align-items:center">
          <button
            v-if="autoLaunchInfo && autoLaunchInfo.enabled"
            class="btn btn-ghost"
            :disabled="savingAutoLaunch"
            @click="toggleAutoLaunch(false)"
          >{{ savingAutoLaunch ? '设置中…' : '取消开机自启' }}</button>
          <button
            v-else
            class="btn btn-primary"
            :disabled="savingAutoLaunch || !canSetAutoLaunch"
            @click="toggleAutoLaunch(true)"
          >{{ savingAutoLaunch ? '设置中…' : '开启开机自启' }}</button>
          <button class="btn btn-ghost btn-sm" :disabled="savingAutoLaunch" @click="loadAutoLaunch">刷新状态</button>
        </div>
        <p v-if="!canSetAutoLaunch" class="setup-desc" style="margin-top:14px;padding:10px 12px;background:#fef9ec;border:1px solid #f5e0b0;border-radius:8px">
          ⚠️ {{ autoLaunchDisabledReason }}
        </p>
        <p v-else class="setup-desc" style="margin-top:14px">
          开启后，本机登录 Windows 时自动启动本软件并静默驻留托盘（不弹窗），
          持续为各客户端提供照片服务，避免门店断电重启后服务没起来。
          需要操作界面时点托盘图标即可打开。仅服务端电脑需要开启。
        </p>
        </section>

        <section v-if="info" id="sec-retention" class="card danger-zone">
          <div class="card-title">🗑️ 危险区 · 订单数据保留期</div>

        <div class="info-row">
          <span>当前设置</span>
          <b v-if="!retentionInfo">未知（无权限或读取失败）</b>
          <b v-else-if="retentionInfo.enabled" style="color:#d97706">
            保留 {{ retentionInfo.retentionDays }} 天（超期订单及照片自动删除）
          </b>
          <b v-else>未启用（订单永久保留，不会自动删除）</b>
        </div>
        <div v-if="retentionInfo" class="info-row"><span>当前订单总数</span><b>{{ retentionInfo.recordCount }} 条</b></div>
        <div v-if="retentionInfo && retentionInfo.lastAutoPurgeAt" class="info-row">
          <span>上次清理</span><b>{{ fmt(retentionInfo.lastAutoPurgeAt) }}</b>
        </div>
        <div v-if="retentionInfo && retentionInfo.enabled" class="info-row">
          <span>按当前时间试算</span>
          <b :style="retentionInfo.wouldDelete ? 'color:#dc2626' : ''">
            {{ retentionInfo.wouldDelete ? '将删除 ' + retentionInfo.wouldDelete + ' 条' : '暂无超期订单' }}
          </b>
        </div>

        <label style="margin-top:16px">保留天数（留空表示不自动删除）</label>
        <div style="display:flex;gap:10px;align-items:center">
          <input
            v-model="retentionInput"
            type="number"
            min="1"
            max="3650"
            step="1"
            style="max-width:160px"
            placeholder="如 365"
            :disabled="!canSetRetention || savingRetention"
          />
          <span class="setup-desc" style="margin:0">天</span>
          <button class="btn btn-primary" :disabled="!canSetRetention || savingRetention" @click="saveRetention">
            {{ savingRetention ? '保存中…' : '保存' }}
          </button>
          <button class="btn btn-ghost btn-sm" :disabled="savingRetention" @click="loadRetention">刷新</button>
        </div>

        <p v-if="!canSetRetention" class="setup-desc" style="margin-top:14px;padding:10px 12px;background:#fef9ec;border:1px solid #f5e0b0;border-radius:8px">
          ⚠️ {{ retentionDisabledReason }}
        </p>

        <template v-else>
          <p class="setup-desc" style="margin-top:14px;padding:10px 12px;background:#fef2f2;border:1px solid #f5c2c2;border-radius:8px">
            ⚠️ <b>删除不可恢复。</b>超过保留期的订单记录与照片文件会被一并永久删除。
            设置保留期后<b>不会立即删除</b>数据——自动清理在服务端启动 90 秒后执行一次，此后每 6 小时检查一次。
            建议首次设置前先用下方「试算」查看影响范围，并定期导出备份。
          </p>

          <div style="display:flex;gap:10px;margin-top:12px;align-items:center">
            <button class="btn btn-ghost" :disabled="purging || !retentionInfo || !retentionInfo.enabled" @click="previewPurge">
              {{ purging ? '处理中…' : '试算（不删除）' }}
            </button>
            <button class="btn btn-danger" :disabled="purging || !retentionInfo || !retentionInfo.enabled" @click="purgeNow">
              {{ purging ? '处理中…' : '立即清理超期订单' }}
            </button>
            <span v-if="!retentionInfo || !retentionInfo.enabled" class="setup-desc" style="margin:0">
              需先设置并保存保留天数
            </span>
          </div>

          <p v-if="purgeResult" class="setup-desc" style="margin-top:12px;padding:10px 12px;background:#f6f8fa;border:1px solid #e3e9f4;border-radius:8px">
            {{ purgeResult }}
          </p>
        </template>
        </section>

        <section v-if="info" id="sec-version" class="card">
          <div class="card-title">📦 版本与更新</div>
        <div class="info-row"><span>当前版本</span><b class="code">v{{ version || '-' }}</b></div>
        <div class="info-row">
          <span>检查结果</span>
          <b v-if="checking">检查中…</b>
          <b v-else-if="updateInfo && updateInfo.hasUpdate" style="color:#d97706">
            发现新版本 v{{ updateInfo.latestVersion }}
            <span v-if="updateInfo.source === 'local'">（来自服务端更新文件夹）</span>
          </b>
          <b v-else-if="updateInfo">已是最新版本</b>
          <b v-else>-</b>
        </div>
        <div class="info-row">
          <span>更新方式</span>
          <b>新版本通过 GitHub Releases 发布：启动或点击「检查更新」自动检测，发现新版本后点「一键下载更新」自动下载安装包到本机（GitHub 直连不稳定时自动切换国内加速通道），双击安装即可覆盖升级</b>
        </div>
        <div v-if="downloading" style="margin-top:12px">
          <div class="update-progress">
            <div class="update-progress-bar" :style="{ width: progressPercent + '%' }"></div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
            <span class="setup-desc">正在下载安装包… {{ progressText }}</span>
            <button class="btn btn-ghost btn-sm" @click="cancelUpdateDownload">取消</button>
          </div>
        </div>
        <div style="display:flex;gap:10px;margin-top:16px">
          <button class="btn btn-primary" :disabled="checking" @click="checkUpdate(true)">
            {{ checking ? '检查中…' : '检查更新' }}
          </button>
          <button class="btn btn-primary" :disabled="downloading || !canAutoDownload" @click="downloadUpdateNow">
            {{ downloading ? '下载中…' : '一键下载更新' }}
          </button>
          <button class="btn btn-ghost" @click="openUpdatePage">前往下载页</button>
          <button v-if="info.mode === 'server'" class="btn btn-ghost" @click="openUpdateFolder">打开软件更新文件夹</button>
        </div>
        </section>

        <section v-if="info && info.mode === 'server'" id="sec-force" class="card">
          <div class="card-title">📣 强制推送安装包</div>
        <div class="info-row">
          <span>当前状态</span>
          <b v-if="forceInfo && forceInfo.enabled" style="color:#d97706">
            已推送 v{{ forceInfo.version }}（{{ forceInfo.fileName }}）
          </b>
          <b v-else-if="forceInfo">未推送</b>
          <b v-else>-</b>
        </div>
        <div v-if="forceInfo && forceInfo.enabled && !forceInfo.fileExists" class="info-row">
          <span>文件状态</span>
          <b style="color:#dc2626">安装包已不在更新文件夹中，推送失效，请重新放入文件</b>
        </div>

        <label style="margin-top:14px">选择更新文件夹内的安装包</label>
        <select v-model="forceFile" :disabled="savingForce">
          <option v-if="!forceInfo || !forceInfo.files || !forceInfo.files.length" value="">
            （更新文件夹内暂无安装包）
          </option>
          <option v-for="f in (forceInfo ? forceInfo.files : [])" :key="f.name" :value="f.name">
            {{ f.name }}<template v-if="f.version">（v{{ f.version }}）</template> · {{ fmtSize(f.size) }}
          </option>
        </select>

        <div style="display:flex;gap:10px;margin-top:16px">
          <button class="btn btn-primary" :disabled="savingForce || !forceFile" @click="setForceUpdate(true)">
            {{ savingForce ? '设置中…' : '开启强制推送' }}
          </button>
          <button
            class="btn btn-ghost"
            :disabled="savingForce || !forceInfo || !forceInfo.enabled"
            @click="setForceUpdate(false)"
          >
            取消推送
          </button>
          <button class="btn btn-ghost" :disabled="savingForce" @click="loadForceUpdate">刷新列表</button>
          <button class="btn btn-ghost" @click="openUpdateFolder">打开更新文件夹</button>
        </div>

        <p class="setup-desc" style="margin-top:14px;padding:10px 12px;background:#f0f7ff;border:1px solid #cfe2f7;border-radius:8px">
          📥 使用方法：把安装包（文件名需含版本号，如 xingqiyi-laundry-photo-setup-1.2.1.exe）放入软件安装目录下的「软件更新」文件夹 →
          在上方列表选中它 → 点「开启强制推送」。客户端下次登录时会自动从服务器下载该安装包，
          下载完成后弹窗提示店员双击安装；版本号不高于客户端当前版本的不会触发。
        </p>
        </section>
        </div>
      </div>
    </div>
  `
};

/* ---------- 内置操作手册（所有角色可见，章节按角色裁剪） ---------- */
const ManualPage = {
  props: {
    token: { type: String, required: true },
    user: { type: Object, default: null }
  },
  setup(props) {
    const loading = Vue.ref(true);
    const error = Vue.ref('');
    const html = Vue.ref('');
    const toc = Vue.ref([]);
    const manualVersion = Vue.ref('');
    const appVersion = Vue.ref('');
    const activeId = Vue.ref('');
    const bodyEl = Vue.ref(null);

    async function load() {
      loading.value = true;
      error.value = '';
      try {
        const r = await window.api.manual();
        if (r.ok && r.data && r.data.text) {
          const role = String((props.user && props.user.role) || '');
          const out = renderManual(r.data.text, role);
          html.value = out.html;
          toc.value = out.toc;
          manualVersion.value = r.data.manualVersion || '';
          appVersion.value = r.data.appVersion || '';
          activeId.value = out.toc.length ? out.toc[0].id : '';
        } else {
          html.value = '';
          toc.value = [];
          error.value = (r && r.message) || '读取内置手册失败';
        }
      } catch (e) {
        html.value = '';
        toc.value = [];
        error.value = '读取内置手册失败：' + (e.message || e);
      } finally {
        loading.value = false;
      }
    }

    function goto(id) {
      activeId.value = id;
      Vue.nextTick(() => {
        const root = bodyEl.value;
        if (!root) return;
        const el = root.querySelector('[id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
        if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    // 手册版本与软件版本不一致时提示：说明发版时忘了同步手册，
    // 避免店员照着旧文档操作新版软件
    const versionMismatch = Vue.computed(() => {
      const m = manualVersion.value;
      const a = appVersion.value;
      return !!(m && a && m !== a);
    });

    Vue.onMounted(load);
    return { loading, error, html, toc, activeId, bodyEl, goto, load, manualVersion, appVersion, versionMismatch };
  },
  template: `
    <div>
      <div class="page-head">
        <h2>操作手册</h2>
        <p>软件使用与运维说明，按当前账号角色显示相关章节</p>
      </div>

      <div v-if="versionMismatch" class="manual-version-warn">
        ⚠️ 内置手册版本为 v{{ manualVersion }}，与当前软件版本 v{{ appVersion }} 不一致，
        文档可能未随本版更新，请以实际界面为准。
      </div>

      <div v-if="loading" class="card">
        <div class="skeleton skeleton-line" style="width:38%"></div>
        <div class="skeleton skeleton-line" style="width:100%"></div>
        <div class="skeleton skeleton-line" style="width:92%"></div>
        <div class="skeleton skeleton-line" style="width:76%"></div>
        <div class="empty-desc" style="margin-top:12px">正在加载操作手册…</div>
      </div>
      <div v-else-if="error" class="card">
        <div class="inline-alert err">
          <span class="grow">{{ error }}</span>
          <button class="btn btn-ghost btn-sm" @click="load">重试</button>
        </div>
      </div>
      <div v-else class="manual-wrap">
        <!-- 目录：只收 h2/h3，点击滚动到对应章节 -->
        <aside class="manual-toc">
          <div class="manual-toc-title">目录</div>
          <div class="manual-toc-list">
            <div
              v-for="t in toc"
              :key="t.id"
              class="manual-toc-item"
              :class="{ active: activeId === t.id, sub: t.level === 3 }"
              @click="goto(t.id)"
            >{{ t.title }}</div>
            <div v-if="!toc.length" class="manual-toc-empty">无目录</div>
          </div>
        </aside>

        <!-- 正文：内容由 renderManual 生成，其中所有文本均已 HTML 转义后再拼装标签，
             因此这里用 v-html 输出的是受控的静态结构，不会执行手册中的任何标记 -->
        <div ref="bodyEl" class="manual-body card">
          <div class="markdown" v-html="html"></div>
        </div>
      </div>
    </div>
  `
};

/* ---------- 本周订单（独立侧栏页面） ----------
   近 7 天（含今天）录入的订单清单，按条码（订单号）聚合展示基本信息，
   可按筛选条件导出 CSV 表格（聚合 8 列 / 明细 9 列，仅表格、不复制照片文件）。
   数据走 records:list（带日期区间），与查询页共用后端权限与可见范围裁剪。
   导出的 CSV 必须由主进程生成：页面 rows 只有聚合结果（缺 id / photoFile / 逐张 createdAt / seq），
   做不出明细模式，且权限裁剪只在主进程——故这里只下传筛选条件与条码集合。 */
const WeeklyOrdersPage = {
  props: {
    token: { type: String, required: true },
    user: { type: Object, default: null },
    adminMode: { type: Boolean, default: false },
    storeMode: { type: Boolean, default: false }
  },
  // 「去处理」跳转：把条码带给查询页，店长不必记下条码再手动重输一遍
  emits: ['goto'],
  setup(props, { emit }) {
    const loading = Vue.ref(false);
    const rows = Vue.ref([]); // 按条码聚合后的订单摘要
    const totalPhotos = Vue.ref(0);
    const rangeText = Vue.ref('');
    const errMsg = Vue.ref('');
    // 当前实际加载的日期区间：导出时必须原样下推给主进程，
    // 否则主进程会用一个不同的区间重算，导出结果与页面看到的对不上
    const curRange = Vue.ref({ from: '', to: '' });

    // ---------- 本地筛选 ----------
    const keyword = Vue.ref(''); // 条码 / 录入人 / 门店 / 备注
    const userFilter = Vue.ref('all');
    const storeFilter = Vue.ref('all');

    // ---------- 导出 ----------
    const exportMode = Vue.ref('summary'); // 'summary' 聚合 8 列 | 'detail' 明细 9 列
    // 双锁互斥，复用 QueryPage.exportToday（renderer.js exportToday）的范式：
    // busy 包住实际导出过程，confirming 包住「确认弹窗 → 选目录 → 执行」整段窗口，
    // 嵌套 try/finally 保证任何返回路径都会复位（4 个导出入口都会弹系统目录框，并发会竞态）
    const busy = Vue.ref(false);
    const confirming = Vue.ref(false);

    // 近 7 天（含今天）的日期区间：以今天 00:00 为终点，往前推 6 天
    function dateRange() {
      const now = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const to = now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate());
      const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
      const fromStr = from.getFullYear() + '-' + p2(from.getMonth() + 1) + '-' + p2(from.getDate());
      return { from: fromStr, to };
    }

    async function load() {
      loading.value = true;
      errMsg.value = '';
      try {
        const { from, to } = dateRange();
        curRange.value = { from, to };
        rangeText.value = from + ' 至 ' + to + '（近 7 天，含今天）';
        const base = { silent: true, pageSize: 100, dateFrom: from, dateTo: to };
        const all = [];
        let page = 1;
        for (;;) {
          const r = await window.api.listRecords(props.token, { ...base, page });
          if (!r.ok) {
            errMsg.value = r.message || '加载失败';
            return;
          }
          all.push(...r.data.items);
          if (r.data.items.length < base.pageSize || page > 500) break;
          page++;
        }
        // 按条码（订单号）聚合：张数、首拍/末拍时间、录入人集合、门店
        const map = new Map();
        for (const r of all) {
          const code = String(r.barcode || '未命名');
          if (!map.has(code)) {
            map.set(code, {
              barcode: code,
              count: 0,
              first: r.createdAt,
              last: r.createdAt,
              users: new Set(),
              // notes 必须保留：主进程 applyWeeklyFilters 的关键词按
              // [barcode, note, username, storeName] 匹配，这里若丢掉备注，
              // 关键词命中备注的行在页面上能筛出来、导出 CSV 里却没有，两边结果不一致
              notes: new Set(),
              store: r.storeName || '本店'
            });
          }
          const g = map.get(code);
          g.count++;
          if (r.createdAt < g.first) g.first = r.createdAt;
          if (r.createdAt > g.last) g.last = r.createdAt;
          if (r.username) g.users.add(r.username);
          if (r.note) g.notes.add(r.note);
          if (r.storeName) g.store = r.storeName;
        }
        const list = [...map.values()].sort((a, b) => b.last.localeCompare(a.last));
        for (const g of list) {
          g.userText = [...g.users].join('、');
          g.noteText = [...g.notes].join(' / ');
        }
        rows.value = list;
        totalPhotos.value = all.length;
        // 数据变了：下拉里的候选值可能已不存在，把失效的筛选项收回，避免用户看到「0 个订单」
        // 却以为真的没有数据（其实是筛选条件指向了已消失的录入人/门店）
        if (userFilter.value !== 'all' && !userOptions.value.includes(userFilter.value)) userFilter.value = 'all';
        if (storeFilter.value !== 'all' && !storeOptions.value.includes(storeFilter.value)) storeFilter.value = 'all';
      } catch (e) {
        errMsg.value = '加载失败：' + (e.message || e);
      } finally {
        loading.value = false;
      }
    }

    // 时间格式：YYYY-MM-DD HH:mm（与查询页一致）
    function fmt(iso) {
      const d = new Date(iso || '');
      if (isNaN(d.getTime())) return '—';
      const p2 = (n) => String(n).padStart(2, '0');
      return (
        d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
        ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes())
      );
    }

    // 录入人 / 门店下拉选项：取自当前可见的全量 rows（而非筛选后的，否则选了就再也选不回来）
    const userOptions = Vue.computed(() =>
      [...new Set(rows.value.flatMap((g) => [...g.users]))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-CN'))
    );
    const storeOptions = Vue.computed(() =>
      [...new Set(rows.value.map((g) => g.store))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-CN'))
    );

    // 本地筛选：字段范围必须与主进程 store.applyWeeklyFilters 对齐
    // （barcode / note / username / storeName），否则「看到的」与「导出的」会不一致
    const filteredRows = Vue.computed(() => {
      const kw = keyword.value.trim().toLowerCase();
      return rows.value.filter((g) => {
        if (kw) {
          const hit =
            String(g.barcode || '').toLowerCase().includes(kw) ||
            String(g.userText || '').toLowerCase().includes(kw) ||
            String(g.store || '').toLowerCase().includes(kw) ||
            String(g.noteText || '').toLowerCase().includes(kw);
          if (!hit) return false;
        }
        // 录入人：精确判断该录入人是否在这一单里（与主进程 applyWeeklyFilters 同口径），
        // 不用 userText.includes —— 那会让「张三」同时命中只有「张三丰」的订单
        if (userFilter.value !== 'all' && !g.users.has(userFilter.value)) return false;
        if (storeFilter.value !== 'all' && g.store !== storeFilter.value) return false;
        return true;
      });
    });
    const filteredPhotos = Vue.computed(() => filteredRows.value.reduce((n, g) => n + g.count, 0));

    // 按钮禁用条件：无数据 / 加载中 / 导出进行中都禁用（含 confirming，防止连点弹出两个目录框）
    const exportDisabled = Vue.computed(
      () => loading.value || busy.value || confirming.value || !filteredRows.value.length
    );
    const exportTitle = Vue.computed(() => {
      if (loading.value) return '正在加载本周订单…';
      if (busy.value || confirming.value) return '导出进行中…';
      if (!filteredRows.value.length) return '当前筛选条件下没有数据，无法导出';
      return '导出为 Excel 可直接打开的 CSV 表格（UTF-8 带 BOM）';
    });

    function resetFilters() {
      keyword.value = '';
      userFilter.value = 'all';
      storeFilter.value = 'all';
    }

    /**
     * 导出本周订单表格。
     * 只把「日期范围 + 筛选条件 + 筛选后的条码集合」下推给主进程，由主进程
     * 重新鉴权、重算后落盘——页面 rows 缺少明细模式需要的 id / photoFile / 逐张时间。
     */
    async function exportWeekly() {
      if (busy.value || confirming.value) return;
      if (exportDisabled.value) return;
      confirming.value = true;
      try {
        const isDetail = exportMode.value === 'detail';
        const ok = await showConfirm({
          title: isDetail ? '导出本周订单明细' : '导出本周订单表格',
          message:
            '将把当前筛选结果（' + filteredRows.value.length + ' 个订单、' + filteredPhotos.value + ' 张照片）' +
            '导出为 CSV 表格到您选择的目录。\n日期范围：' + rangeText.value +
            '\n导出类型：' + (isDetail ? '逐张照片明细（9 列）' : '订单聚合（8 列）') + '。',
          confirmText: '选择目录并导出'
        });
        if (!ok) return; // 取消：零 IPC
        const d = await window.api.chooseExportDir();
        if (!d.ok) {
          if (d.message && d.message !== '已取消') toast(d.message, 'error');
          return;
        }
        busy.value = true;
        toast('正在生成' + (isDetail ? '本周订单明细' : '本周订单表格') + '…', 'success');
        try {
          const res = await window.api.exportWeeklyOrders(props.token, {
            targetDir: d.data,
            dateFrom: curRange.value.from,
            dateTo: curRange.value.to,
            mode: exportMode.value,
            filters: {
              keyword: keyword.value.trim(),
              username: userFilter.value === 'all' ? '' : userFilter.value,
              store: storeFilter.value === 'all' ? '' : storeFilter.value,
              // 白名单：保证「所见即所得」，主进程仍会按自己的谓词与权限先过滤一遍
              barcodes: filteredRows.value.map((g) => g.barcode)
            }
          });
          if (res.ok) {
            toast(
              '导出完成：' + res.data.orders + ' 个订单、' + res.data.photos + ' 张照片 → ' + res.data.csvPath +
              (res.data.logged === false ? '（客户端模式未写入操作日志）' : '') +
              '。若条码显示为科学计数法，请将该列设为文本。',
              'success'
            );
          } else {
            toast(res.message || '导出失败', 'error');
          }
        } catch (e) {
          toast('导出失败：' + (e.message || e), 'error');
        } finally {
          busy.value = false;
        }
      } finally {
        confirming.value = false;
      }
    }

    // 「去处理」：切到记录查询页并带上本单条码。
    // 管理员角色下查询页的菜单 key 是 data（非 query），两处都指向 QueryPage，需按角色选 key。
    function goProcess(barcode) {
      emit('goto', props.adminMode ? 'data' : 'query', barcode);
    }

    Vue.onMounted(load);
    return {
      loading, rows, totalPhotos, rangeText, errMsg, load, fmt, goProcess,
      keyword, userFilter, storeFilter, userOptions, storeOptions,
      filteredRows, filteredPhotos, exportMode, exportDisabled, exportTitle,
      busy, confirming, resetFilters, exportWeekly
    };
  },
  template: `
    <div>
      <div class="page-head">
        <h2>本周订单</h2>
        <p>近 7 天（含今天）录入的订单清单；可按下方筛选条件导出为 Excel 可直接打开的 CSV 表格（仅表格，不复制照片文件）。</p>
      </div>

      <div v-if="errMsg" class="card">
        <div class="empty">
          <div class="empty-title">加载失败</div>
          <div class="empty-desc">{{ errMsg }}</div>
          <button class="btn btn-ghost" @click="load">重试</button>
        </div>
      </div>

      <div v-else-if="loading" class="card">
        <div class="empty"><div class="empty-title">正在加载本周订单…</div></div>
      </div>

      <div v-else-if="!rows.length" class="card">
        <div class="empty">
          <div class="empty-icon" aria-hidden="true"></div>
          <div class="empty-title">近 7 天没有订单</div>
          <div class="empty-desc">{{ rangeText }}，暂无符合条件的订单记录。</div>
        </div>
      </div>

      <div v-else class="table-wrap">
        <div class="filter-bar weekly-filter">
          <div class="f-item f-keyword">
            <label>关键词</label>
            <input v-model="keyword" :disabled="loading" placeholder="条码 / 录入人 / 门店 / 备注" />
          </div>
          <div class="f-item f-user">
            <label>录入人</label>
            <select v-model="userFilter" :disabled="loading">
              <option value="all">全部录入人</option>
              <option v-for="u in userOptions" :key="u" :value="u">{{ u }}</option>
            </select>
          </div>
          <div class="f-item f-store" v-if="storeOptions.length > 1">
            <label>所属门店</label>
            <select v-model="storeFilter" :disabled="loading">
              <option value="all">全部门店</option>
              <option v-for="s in storeOptions" :key="s" :value="s">{{ s }}</option>
            </select>
          </div>
          <div class="f-item">
            <label>&nbsp;</label>
            <button class="btn btn-ghost btn-sm" :disabled="loading" @click="resetFilters">重置筛选</button>
          </div>
        </div>
        <div class="weekly-summary">
          <span>共 <b>{{ filteredRows.length }}</b> 个订单 · <b>{{ filteredPhotos }}</b> 张照片 · {{ rangeText }}</span>
          <span class="weekly-export">
            <select v-model="exportMode" :disabled="exportDisabled" title="选择导出粒度">
              <option value="summary">订单聚合（8 列）</option>
              <option value="detail">逐张照片明细（9 列）</option>
            </select>
            <button
              class="btn btn-primary btn-sm"
              :disabled="exportDisabled"
              :title="exportTitle"
              @click="exportWeekly"
            >{{ busy ? '导出中…' : (filteredRows.length === rows.length ? '导出本周订单表格' : '导出筛选结果（' + filteredRows.length + '）') }}</button>
          </span>
        </div>
        <table>
          <thead>
            <tr>
              <th>条形码（订单号）</th>
              <th>照片张数</th>
              <th>首拍时间</th>
              <th>末拍时间</th>
              <th>录入人</th>
              <th>所属门店</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="g in filteredRows" :key="g.barcode">
              <td class="code">
                <button type="button" class="barcode-jump" :title="'去记录查询处理 ' + g.barcode" @click="goProcess(g.barcode)">{{ g.barcode }}</button>
              </td>
              <td class="code">{{ g.count }}</td>
              <td class="code">{{ fmt(g.first) }}</td>
              <td class="code">{{ fmt(g.last) }}</td>
              <td>{{ g.userText }}</td>
              <td>{{ g.store }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `
};

/* ---------- 主界面框架（侧边栏 + 页面切换） ---------- */
const Shell = {
  props: { user: { type: Object, required: true }, token: { type: String, required: true }, mode: { type: String, default: '' } },
  emits: ['logout'],
  setup(props, { emit }) {
    // 四级角色决定可见菜单：
    // 系统管理员=全部管理页；门店管理员=本店订单+本店日志（只查不拍）；
    // 拍照账号=拍照+查询；查询账号=仅查询
    const role = String((props.user && props.user.role) || '');
    const isAdmin = isSysAdminRole(role);
    const isStoreAdmin = role === 'storeadmin';
    const canCapture = isAdmin || !!(props.user && props.user.permissions && props.user.permissions.capture);
    const version = Vue.ref('');
    const latestVersion = Vue.ref('');
    const hasUpdate = Vue.ref(false);

    window.api.version().then((r) => {
      if (r.ok) version.value = r.data.version;
    });
    // 启动时自动从 GitHub 获取最新版本号
    window.api.checkUpdate().then((r) => {
      if (r.ok && r.data) {
        latestVersion.value = r.data.latestVersion || '';
        hasUpdate.value = !!r.data.hasUpdate;
      }
    });

    // 离线冗余：周期探测服务器连通性与待同步数量，仅客户端模式显示
    const online = Vue.ref(true);
    const pending = Vue.ref(0);
    const syncing = Vue.ref(false);
    let statusTimer = null;

    async function refreshStatus() {
      if (props.mode !== 'client') return;
      const r = await window.api.offlineStatus();
      if (r.ok) {
        online.value = r.data.online;
        pending.value = r.data.pending || 0;
        // 服务器恢复且有待同步存档时自动触发同步
        if (r.data.online && (r.data.pending || 0) > 0 && !syncing.value) doSync();
      }
    }

    async function doSync() {
      if (syncing.value) return;
      syncing.value = true;
      try {
        const r = await window.api.syncOffline();
        if (r.ok && r.data.synced > 0) {
          toast('已同步 ' + r.data.synced + ' 条离线存档到服务器', 'success');
        } else if (r.ok && (r.data.remaining || 0) > 0 && r.data.reason) {
          toast('离线存档暂未同步：' + r.data.reason, 'error');
        }
      } catch (e) {
        /* 静默失败，下次轮询重试 */
      } finally {
        syncing.value = false;
        refreshStatus();
      }
    }

    Vue.onMounted(() => {
      refreshStatus();
      statusTimer = setInterval(refreshStatus, 15000);
    });
    Vue.onUnmounted(() => {
      if (statusTimer) clearInterval(statusTimer);
    });

    // ---------- 按角色装配菜单 ----------
    // 系统管理员：数据总览 / 用户与权限 / 操作日志（全部）/ 数据查看（全部门店）/ 系统设置
    // 门店管理员：首页 / 操作日志（仅本店）/ 订单查询（仅本店）/ 设置
    // 拍照账号：首页 / 衣物拍照 / 记录查询 / 设置
    // 查询账号：首页 / 记录查询 / 设置
    const comps = {
      home: HomePage,
      capture: CapturePage,
      query: QueryPage,
      settings: SettingsPage,
      overview: AdminOverviewPage,
      users: AdminUsersPage,
      logs: AdminLogsPage,
      data: QueryPage,
      system: AdminSystemPage,
      manual: ManualPage,
      weekly: WeeklyOrdersPage
    };

    // 菜单图标为内联 SVG 常量（经 v-html 渲染；均为代码内固定字符串，无注入面）
    const pages = (() => {
      let list;
      if (isAdmin) {
        list = [
          { key: 'overview', icon: '<svg viewBox="0 0 24 24"><path d="M5 20v-7M11 20V5M17 20v-4.5"/><path d="M3.8 20h16.4"/></svg>', label: '数据总览' },
          { key: 'users', icon: '<svg viewBox="0 0 24 24"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>', label: '用户与权限' },
          { key: 'logs', icon: '<svg viewBox="0 0 24 24"><path d="M8 6.5h12M8 12h12M8 17.5h12"/><path d="M3.8 6.5h.01M3.8 12h.01M3.8 17.5h.01"/></svg>', label: '操作日志' },
          { key: 'data', icon: '<svg viewBox="0 0 24 24"><path d="M3.8 7a2 2 0 0 1 2-2h3.4l1.9 2.3h7.1a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5.8a2 2 0 0 1-2-2Z"/></svg>', label: '数据查看' },
          { key: 'weekly', icon: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 9h16M8 3v4M16 3v4"/></svg>', label: '本周订单' },
          { key: 'system', icon: '<svg viewBox="0 0 24 24"><path d="M4 7.2h9.2M18.2 7.2H20M4 12h2.2M11 12h9M4 16.8h9.2M18.2 16.8H20"/><circle cx="15.6" cy="7.2" r="2"/><circle cx="8.5" cy="12" r="2"/><circle cx="15.6" cy="16.8" r="2"/></svg>', label: '系统设置' }
        ];
      } else if (isStoreAdmin) {
        list = [
          { key: 'home', icon: '<svg viewBox="0 0 24 24"><path d="M4.6 10.8 12 4.6l7.4 6.2V19a1.6 1.6 0 0 1-1.6 1.6h-3.6v-5.4h-4.4v5.4H6.2A1.6 1.6 0 0 1 4.6 19Z"/></svg>', label: '首页' },
          { key: 'logs', icon: '<svg viewBox="0 0 24 24"><path d="M8 6.5h12M8 12h12M8 17.5h12"/><path d="M3.8 6.5h.01M3.8 12h.01M3.8 17.5h.01"/></svg>', label: '本店日志' },
          { key: 'query', icon: '<svg viewBox="0 0 24 24"><path d="M3.8 7a2 2 0 0 1 2-2h3.4l1.9 2.3h7.1a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5.8a2 2 0 0 1-2-2Z"/></svg>', label: '本店订单' },
          { key: 'weekly', icon: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 9h16M8 3v4M16 3v4"/></svg>', label: '本周订单' },
          { key: 'settings', icon: '<svg viewBox="0 0 24 24"><path d="M4 7.2h9.2M18.2 7.2H20M4 12h2.2M11 12h9M4 16.8h9.2M18.2 16.8H20"/><circle cx="15.6" cy="7.2" r="2"/><circle cx="8.5" cy="12" r="2"/><circle cx="15.6" cy="16.8" r="2"/></svg>', label: '设置' }
        ];
      } else {
        list = [{ key: 'home', icon: '<svg viewBox="0 0 24 24"><path d="M4.6 10.8 12 4.6l7.4 6.2V19a1.6 1.6 0 0 1-1.6 1.6h-3.6v-5.4h-4.4v5.4H6.2A1.6 1.6 0 0 1 4.6 19Z"/></svg>', label: '首页' }];
        // 拍照能力由角色派生，查询账号不显示拍照入口
        if (canCapture) list.push({ key: 'capture', icon: '<svg viewBox="0 0 24 24"><path d="M14.5 5h-5L7.8 7.6H4.6A1.6 1.6 0 0 0 3 9.2v8.2a1.6 1.6 0 0 0 1.6 1.6h14.8a1.6 1.6 0 0 0 1.6-1.6V9.2a1.6 1.6 0 0 0-1.6-1.6h-3.2Z"/><circle cx="12" cy="13.2" r="3.1"/></svg>', label: '衣物拍照' });
        list.push({ key: 'query', icon: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.4"/><path d="m19.8 19.8-3.2-3.2"/></svg>', label: '记录查询' });
        list.push({ key: 'weekly', icon: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 9h16M8 3v4M16 3v4"/></svg>', label: '本周订单' });
        list.push({ key: 'settings', icon: '<svg viewBox="0 0 24 24"><path d="M4 7.2h9.2M18.2 7.2H20M4 12h2.2M11 12h9M4 16.8h9.2M18.2 16.8H20"/><circle cx="15.6" cy="7.2" r="2"/><circle cx="8.5" cy="12" r="2"/><circle cx="15.6" cy="16.8" r="2"/></svg>', label: '设置' });
      }
      // 操作手册对所有角色可见，统一在末尾追加：
      // 放在这里而不是三个分支各写一次，避免将来新增角色时漏加手册入口。
      // 手册内部已按角色裁剪章节，因此同一入口对不同角色显示不同内容。
      list.push({ key: 'manual', icon: '<svg viewBox="0 0 24 24"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>', label: '操作手册' });
      return list;
    })();

    const active = Vue.ref(pages[0].key);

    // 带参跳转：本页（如「本周订单」）发 goto 时附带条码，由查询页消费后填入并搜索。
    // 只在跳转当刻有值，消费后立即清空，避免下次进入查询页又被旧条码预填。
    const prefill = Vue.ref(null);
    function onGoto(key, payload) {
      active.value = key;
      const code = typeof payload === 'string' ? payload.trim() : '';
      if (!code) return;
      prefill.value = { barcode: code };
      Vue.nextTick(() => {
        prefill.value = null;
      });
    }

    async function doLogout() {
      const r = await window.api.logout(props.token);
      emit('logout');
      toast(r.ok ? '已退出登录' : r.message || '退出失败', r.ok ? 'success' : 'error');
    }

    // ---------- 设计体系 v2：主题 / 侧栏折叠 ----------
    // 主题状态是模块级单例（与「设置页 · 外观」共用同一份值），这里只取用，
    // 不再重复注册 matchMedia 监听，避免外壳反复挂载时监听器累积。
    const { theme, themeLabel, themeIcon, cycleTheme } = useTheme();

    const collapsed = Vue.ref(readPref('xqy-sidebar-collapsed', '0') === '1');
    function toggleCollapsed() {
      collapsed.value = !collapsed.value;
      writePref('xqy-sidebar-collapsed', collapsed.value ? '1' : '0');
    }
    const collapseIcon = Vue.computed(
      () =>
        '<svg viewBox="0 0 24 24">' +
        (collapsed.value ? '<path d="M9 6l6 6-6 6"/>' : '<path d="M15 6l-6 6 6 6"/>') +
        '</svg>'
    );

    // ---------- 设计体系 v2：侧栏分组导航 ----------
    // 菜单按语义分组，避免全部平铺导致扫读困难；组内保持原有顺序。
    const GROUP_OF = {
      home: '工作区', capture: '工作区', query: '工作区',
      overview: '门店', logs: '门店', data: '门店', weekly: '门店',
      users: '账户与帮助', system: '账户与帮助', settings: '账户与帮助', manual: '账户与帮助'
    };
    const GROUP_ORDER = ['工作区', '门店', '账户与帮助'];
    const navGroups = Vue.computed(() => {
      const groups = [];
      GROUP_ORDER.forEach((name) => {
        const items = pages.filter((p) => (GROUP_OF[p.key] || '账户与帮助') === name);
        if (items.length) groups.push({ name, items });
      });
      // 兜底：GROUP_OF 未覆盖的新页面不能被丢弃，挂到「账户与帮助」之后单列
      const covered = new Set(groups.reduce((acc, g) => acc.concat(g.items.map((i) => i.key)), []));
      const rest = pages.filter((p) => !covered.has(p.key));
      if (rest.length) groups.push({ name: '其他', items: rest });
      return groups;
    });

    // ---------- 设计体系 v2：侧栏常驻状态胶囊 ----------
    // 审查项 #2：离线/待同步状态应常驻可见，不应只能进设置页才知道。
    const statusKind = Vue.computed(() => (!online.value ? 'err' : pending.value > 0 ? 'warn' : 'ok'));
    const statusText = Vue.computed(() => {
      if (!online.value) return '离线 · 待同步 ' + (pending.value || 0);
      if (syncing.value) return '同步中…';
      if (pending.value > 0) return '待同步 ' + pending.value;
      // 注意：setup 内没有局部 mode 变量，必须走 props.mode；
      // 裸写 mode 会 ReferenceError，导致整个 Shell 渲染失败（页面空白）。
      return props.mode === 'client' ? '服务端已连接' : '本机服务端';
    });

    return {
      user: props.user, mode: props.mode, isAdmin, isStoreAdmin, canCapture,
      roleText: roleLabel(role), pages, comps, active, onGoto, prefill, doLogout, version,
      latestVersion, hasUpdate,
      online, pending, syncing, doSync,
      theme, themeLabel, themeIcon, cycleTheme,
      collapsed, toggleCollapsed, collapseIcon, navGroups,
      statusKind, statusText
    };
  },
  template: `
    <div class="shell">
      <aside class="sidebar" :class="{ collapsed: collapsed }">
        <div class="brand">
          <img class="logo-brand" src="./assets/logo.png" alt="星期衣" />
          <div v-show="!collapsed">
            <div class="brand-name">星期衣精致洗衣</div>
            <div class="brand-sub">衣物照片系统 · {{ isAdmin ? '管理端' : (isStoreAdmin ? '门店管理' : '客户端') }}</div>
          </div>
        </div>
        <nav class="nav">
          <template v-for="g in navGroups" :key="g.name">
            <div class="nav-group-label" v-show="!collapsed">{{ g.name }}</div>
            <button
              v-for="p in g.items"
              :key="p.key"
              type="button"
              class="nav-item"
              :class="{ active: active === p.key }"
              :title="collapsed ? p.label : ''"
              :aria-current="active === p.key ? 'page' : null"
              @click="active = p.key"
            >
              <span class="nav-icon" v-html="p.icon"></span><span class="label">{{ p.label }}</span>
            </button>
          </template>
        </nav>
        <div class="sidebar-foot">
          <div class="status-pill" :class="statusKind" :title="statusText">
            <span class="status-dot" :class="{ pulse: syncing }"></span>
            <span class="status-text" v-show="!collapsed">{{ statusText }}</span>
          </div>
          <div class="user-chip">
            <div class="avatar">{{ (user.name || user.username).charAt(0) }}</div>
            <div class="user-meta" v-show="!collapsed">
              <div class="user-name">{{ user.name || user.username }}</div>
              <div class="user-role">{{ roleText }} · {{ mode === 'client' ? '已连接服务器' : '本机服务端' }}</div>
            </div>
          </div>
          <button class="sidebar-collapse" @click="toggleCollapsed" :title="collapsed ? '展开侧栏' : '收起侧栏'">
            <span class="nav-icon" v-html="collapseIcon"></span>
            <span class="collapse-label">{{ collapsed ? '展开侧栏' : '收起侧栏' }}</span>
          </button>
          <button class="sidebar-collapse" @click="cycleTheme" :title="'外观：' + themeLabel">
            <span class="nav-icon" v-html="themeIcon"></span>
            <span class="collapse-label">外观 · {{ themeLabel }}</span>
          </button>
          <button class="btn btn-ghost btn-block" @click="doLogout">退出登录</button>
          <div class="sidebar-version">版本 v{{ version || '-' }}<template v-if="latestVersion"> · 最新 v{{ latestVersion }}<span v-if="hasUpdate" class="tag tag-orange" style="margin-left:4px;font-size:10px">有更新</span></template></div>
        </div>
      </aside>
      <main class="main">
        <div v-if="mode === 'client' && (!online || pending > 0)" class="offline-banner" :class="{ off: !online }">
          <span v-if="!online">
            ⚠️ 服务器连接中断，已进入离线模式：拍照与查询仍可使用，存档将在服务器恢复后自动同步
          </span>
          <span v-else>
            ⏳ 有 {{ pending }} 条离线存档待同步到服务器
          </span>
          <button class="btn btn-ghost btn-sm" :disabled="syncing" @click="doSync">
            {{ syncing ? '同步中…' : '立即同步' }}
          </button>
        </div>
        <component
          :is="comps[active]"
          :user="user"
          :token="token"
          :admin-mode="isAdmin"
          :store-mode="isStoreAdmin"
          :prefill-barcode="prefill ? prefill.barcode : null"
          @goto="onGoto"
          @logout="doLogout"
        ></component>
      </main>
    </div>
  `
};

/* ---------- 根应用 ---------- */
const app = createApp({
  setup() {
    const sysInfo = Vue.ref(null);
    const user = Vue.ref(null);
    const token = Vue.ref('');
    const ready = Vue.ref(false);
    const needRestart = Vue.ref(false);
    const updateNotice = Vue.ref(null);
    const updateModal = Vue.ref(null); // 更新提示弹窗
    const downloading = Vue.ref(false);
    const dlProgress = Vue.ref({ received: 0, total: 0 });
    let removeProgress = null;

    window.api.systemInfo().then((r) => {
      if (r.ok) sysInfo.value = r.data;
      ready.value = true;
    });

    // 启动时检查更新：优先 GitHub Releases，无法访问时回退服务端更新文件夹
    window.api.checkUpdate().then((r) => {
      if (r.ok && r.data && r.data.hasUpdate) {
        updateNotice.value = r.data;
        // 检测到新版本：自动弹出更新提示，展示当前版本更新内容
        updateModal.value = r.data;
      }
    });

    const canAutoDownload = Vue.computed(
      () => !!(updateModal.value && updateModal.value.source === 'github' && updateModal.value.downloadUrl)
    );
    const progressPercent = Vue.computed(() => {
      const { received, total } = dlProgress.value || {};
      if (!total || total <= 0) return 0;
      return Math.min(100, Math.round((received / total) * 100));
    });
    const progressText = Vue.computed(() => {
      const { received, total } = dlProgress.value || {};
      const base = total > 0 ? fmtSize(received) + ' / ' + fmtSize(total) + '（' + progressPercent.value + '%）' : fmtSize(received);
      const ch = dlProgress.value && dlProgress.value.channel;
      return base + (ch === 'accel' ? ' · 国内加速' : ch === 'direct' ? ' · 直连' : '');
    });

    function openUpdateModal() {
      if (updateNotice.value) updateModal.value = updateNotice.value;
    }

    function closeUpdateNotice() {
      updateNotice.value = null;
    }

    function openReleasePage() {
      window.api.openUpdatePage();
    }

    // 一键自动下载更新安装包：下载完成后自动打开文件夹定位文件，双击安装即可覆盖升级
    async function downloadNow() {
      const info = updateModal.value || updateNotice.value;
      if (!info || !info.downloadUrl || downloading.value) return;
      downloading.value = true;
      dlProgress.value = { received: 0, total: 0 };
      removeProgress = window.api.onDownloadProgress((p) => {
        dlProgress.value = p;
      });
      try {
        const r = await window.api.downloadUpdate(info.downloadUrl, info.assetName);
        if (r.ok) {
          toast('安装包下载完成' + (r.data && r.data.channel === 'accel' ? '（经国内加速通道）' : '') + '，已打开文件夹，双击安装即可覆盖升级', 'success');
          updateModal.value = null;
          updateNotice.value = null;
        } else if (!r.canceled) {
          toast(r.message || '下载失败', 'error');
        } else {
          toast('已取消下载', 'success');
        }
      } catch (e) {
        toast('下载失败：' + (e.message || e), 'error');
      } finally {
        downloading.value = false;
        if (removeProgress) {
          removeProgress();
          removeProgress = null;
        }
      }
    }

    function cancelDownload() {
      window.api.cancelDownload();
    }

    function onSetupDone() {
      needRestart.value = true;
    }

    function onServerSaved() {
      // 服务器设置保存成功后刷新系统信息（立即生效，无需重启）
      window.api.systemInfo().then((r) => {
        if (r.ok) sysInfo.value = r.data;
      });
    }

    function onLogin(data) {
      user.value = data.user;
      token.value = data.sessionToken;
      // 重新登录成功即清除「被顶下线」提示，否则旧提示会残留在界面上误导用户
      revokedMsg.value = '';
    }

    function onLogout() {
      user.value = null;
      token.value = '';
    }

    // ---------- 服务端强制推送安装包 ----------
    // 客户端登录后主进程会自动下载推送的安装包，完成后通过 update:force 事件通知这里弹窗
    const forceModal = Vue.ref(null);
    const installing = Vue.ref(false);
    let removeForceListener = null;

    if (window.api.onForceUpdate) {
      removeForceListener = window.api.onForceUpdate((p) => {
        if (p && p.needUpdate) forceModal.value = p;
      });
    }

    // 兜底：界面自身就绪后主动查一次，避免事件在渲染进程挂载前就已发出而丢失
    if (window.api.checkForceUpdate) {
      window.api.checkForceUpdate().then((r) => {
        if (r.ok && r.data && r.data.needUpdate && !forceModal.value) forceModal.value = r.data;
      });
    }

    // ---------- 唯一登录：被顶下线时强制退回登录页 ----------
    // 桥接层在任意接口返回 revoked 时通知这里。必须清掉登录态，
    // 否则用户会停留在已失效的会话界面上，每次操作只看到一条失败提示，
    // 既不知道原因，也无法重新登录。
    const revokedMsg = Vue.ref('');
    let removeRevokedListener = null;
    if (window.api.onSessionRevoked) {
      removeRevokedListener = window.api.onSessionRevoked((message) => {
        // 未登录状态下收到通知直接忽略，避免把登录页的普通失败提示变成顶号提示
        if (!user.value) return;
        revokedMsg.value = message || '账号已在其他设备登录，当前会话已失效，请重新登录';
        user.value = null;
        token.value = '';
      });
    }

    // 弹窗打开时把背景内容设为 inert：背景内的按钮/输入框/卡片会一并移出焦点序列与 Tab 顺序，
    // 键盘用户不会在弹窗开着时「迷失」到背景（实测背景仍有 38 个可聚焦元素）。
    // inert 是「存在即生效」的属性，必须绑 null 来移除、绑 '' 来添加，不能绑 false（那会渲染成 inert="false" 反而生效）。
    // 承载容器是页面内容那一层；<confirm-modal> 与各根级弹窗是它的兄弟节点，自身不受影响。
    const bgInert = Vue.computed(() =>
      confirmState.open || updateModal.value || forceModal.value ? '' : null
    );

    Vue.onUnmounted(() => {
      if (removeForceListener) removeForceListener();
      if (removeRevokedListener) removeRevokedListener();
    });

    async function runInstaller() {
      const f = forceModal.value;
      if (!f || !f.file || installing.value) return;
      installing.value = true;
      try {
        const r = await window.api.runInstaller(f.file);
        if (r.ok) {
          toast(r.data.opened ? '已启动安装程序，请按向导完成升级' : '已定位安装包，请双击安装', 'success');
          forceModal.value = null;
        } else {
          toast(r.message || '启动安装程序失败', 'error');
        }
      } catch (e) {
        toast('启动安装程序失败：' + (e.message || e), 'error');
      } finally {
        installing.value = false;
      }
    }

    async function openInstallerFolder() {
      const f = forceModal.value;
      if (!f || !f.file) return;
      const r = await window.api.openInstaller(f.file);
      if (!r.ok) toast(r.message || '打开文件夹失败', 'error');
    }

    return {
      sysInfo, user, token, ready, needRestart, updateNotice,
      updateModal, downloading, progressPercent, progressText, canAutoDownload,
      onSetupDone, onServerSaved, onLogin, onLogout,
      openUpdateModal, closeUpdateNotice, openReleasePage, downloadNow, cancelDownload,
      forceModal, installing, runInstaller, openInstallerFolder, fmtSize,
      revokedMsg, bgInert
    };
  },
  template: `
    <div style="height:100%;display:flex;flex-direction:column">
      <div v-if="updateNotice" class="update-banner">
        <span>
          🔔 发现新版本 <b>v{{ updateNotice.latestVersion }}</b>（当前 v{{ updateNotice.currentVersion }}），点击查看更新内容与一键下载。
        </span>
        <div style="display:flex;align-items:center;gap:8px">
          <button class="update-banner-close" style="color:#9a3412;font-weight:600" @click="openUpdateModal">查看并下载</button>
          <button class="update-banner-close" @click="closeUpdateNotice">✕</button>
        </div>
      </div>

      <div v-if="updateModal" class="modal-mask" @click.self="downloading ? null : (updateModal = null)">
        <div class="modal" style="max-width:560px">
          <div class="modal-head">
            <h3>发现新版本 v{{ updateModal.latestVersion }}</h3>
            <button class="modal-close" :disabled="downloading" @click="updateModal = null">✕</button>
          </div>
          <div class="modal-body">
            <div class="info-row"><span>当前版本</span><b class="code">v{{ updateModal.currentVersion }}</b></div>
            <div class="info-row"><span>最新版本</span><b class="code">v{{ updateModal.latestVersion }}</b></div>

            <div class="card-title" style="margin-top:16px">本版本更新内容</div>
            <pre v-if="updateModal.releaseNotes" class="release-notes">{{ updateModal.releaseNotes }}</pre>
            <div v-else class="setup-desc">
              本次更新内容暂未提供，可打开下载页查看完整发布说明。
            </div>

            <div v-if="updateModal.source !== 'github'" class="setup-desc" style="margin-top:12px">
              当前运行环境无法连接 GitHub，无法使用自动下载。请联系管理员从服务端更新文件夹获取安装包。
            </div>

            <div v-if="downloading" style="margin-top:14px">
              <div class="update-progress">
                <div class="update-progress-bar" :style="{ width: progressPercent + '%' }"></div>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
                <span class="setup-desc">正在下载安装包… {{ progressText }}</span>
                <button class="btn btn-ghost btn-sm" @click="cancelDownload">取消</button>
              </div>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" :disabled="downloading" @click="updateModal = null">稍后再说</button>
            <button v-if="canAutoDownload" class="btn btn-primary" :disabled="downloading" @click="downloadNow">
              {{ downloading ? '下载中…' : '一键下载更新' }}
            </button>
            <button v-else class="btn btn-primary" :disabled="downloading" @click="openReleasePage">打开下载页</button>
          </div>
        </div>
      </div>
      <div v-if="forceModal" class="modal-mask">
        <div class="modal" style="max-width:520px">
          <div class="modal-head">
            <h3>📣 服务器推送了新版本 v{{ forceModal.version }}</h3>
          </div>
          <div class="modal-body">
            <div class="setup-desc">
              管理员已推送新版本安装包，并已自动下载到本机。请尽快完成升级，
              以保证与服务器端功能一致。
            </div>
            <div class="info-row" style="margin-top:14px">
              <span>推送版本</span><b class="code">v{{ forceModal.version }}</b>
            </div>
            <div class="info-row">
              <span>安装包</span><b>{{ forceModal.fileName }}</b>
            </div>
            <div class="info-row">
              <span>文件大小</span><b>{{ fmtSize(forceModal.size) }}</b>
            </div>
            <div class="info-row">
              <span>保存位置</span><b style="word-break:break-all">{{ forceModal.file }}</b>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" :disabled="installing" @click="openInstallerFolder">打开所在文件夹</button>
            <button class="btn btn-primary" :disabled="installing" @click="runInstaller">
              {{ installing ? '启动中…' : '立即安装' }}
            </button>
          </div>
        </div>
      </div>
      <div style="flex:1;min-height:0" :inert="bgInert">
        <div v-if="!ready" style="height:100%;display:flex;align-items:center;justify-content:center;color:#64748b">
          正在启动…
        </div>
        <div v-else-if="needRestart" class="login-wrap">
          <div class="login-card">
            <div class="login-logo">✅</div>
            <h1>配置已保存</h1>
            <div class="login-sub">请关闭应用窗口后重新运行，即可按新模式启动</div>
          </div>
        </div>
        <setup-page v-else-if="sysInfo && !sysInfo.mode" @done="onSetupDone"></setup-page>
        <shell v-else-if="user" :user="user" :token="token" :mode="sysInfo ? sysInfo.mode : ''" @logout="onLogout"></shell>
        <login-page v-else :sys-info="sysInfo" :revoked-msg="revokedMsg" @login="onLogin" @server-saved="onServerSaved"></login-page>
      </div>
      <confirm-modal></confirm-modal>
    </div>
  `
});

app.component('login-page', LoginPage);
app.component('setup-page', SetupPage);
app.component('shell', Shell);
app.component('confirm-modal', ConfirmModal);
app.mount('#app');
