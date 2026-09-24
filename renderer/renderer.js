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
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'toast show ' + (type || 'success');
  clearTimeout(toastState.timer);
  toastState.timer = setTimeout(() => {
    el.className = 'toast';
  }, 2600);
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
      if (!window.confirm('确定不再记住账号 ' + name + '？已保存的密码会一并清除。')) return;
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
      if (!window.confirm('确定清空本机保存的全部账号与密码？此操作不可恢复。')) return;
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
        {{ canCapture ? '还没有存档记录，去「衣物拍照」添加第一张照片吧' : '还没有存档记录' }}
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
    const CAM_IDLE_DEFAULT_MS = 180000;

    function camIdleMs() {
      const v = Number(window.__xqyCamIdleMs);
      return v >= 1000 ? v : CAM_IDLE_DEFAULT_MS;
    }

    let idleTimer = null;
    let waking = false; // 唤醒进行中，防重复触发
    let wasRunningWhenHidden = false; // 因窗口隐藏而释放时，回到前台自动恢复

    async function loadDevices() {
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        devices.value = list.filter((d) => d.kind === 'videoinput');
        if (devices.value.length && !deviceId.value) deviceId.value = devices.value[0].deviceId;
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
      if (cap.focusDistance) adv.focusDistance = cap.focusDistance.min || undefined;
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
          await track.applyConstraints({ advanced: [adv] });
        } catch (e) {
          /* 部分设备不支持，保持默认对焦 */
        }
      }
    }

    // 周期对焦脉冲：定时触发一次单点对焦后恢复连续对焦，
    // 纠正部分摄像头长时间待机后出现的对焦漂移
    function startFocusPulse(track) {
      stopFocusPulse();
      focusTimer = setInterval(async () => {
        if (!track || track.readyState !== 'live') {
          stopFocusPulse();
          return;
        }
        try {
          await track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] });
          await new Promise((r) => setTimeout(r, 350));
          await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
        } catch (e) {
          /* 设备不支持时静默忽略 */
        }
      }, 20000);
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
      if (!captureAlive || sleeping.value || !stream.value) return;
      idleTimer = setTimeout(() => {
        if (captureAlive && stream.value && !document.hidden) sleepCamera('idle');
      }, camIdleMs());
    }

    function bumpActivity() {
      if (!captureAlive || sleeping.value) return;
      scheduleIdleSleep();
    }

    // 释放摄像头：停止取流并进入休眠态（空闲超时 / 窗口隐藏 / 手动释放）
    function sleepCamera(reason) {
      if (!captureAlive || sleeping.value || !stream.value) return;
      stopCamera();
      sleeping.value = true;
      clearIdleTimer();
      if (reason === 'idle') toast('摄像头空闲超时，已释放占用；扫码或按空格即可继续拍', 'info');
    }

    // 窗口最小化/隐藏时释放，回到前台自动恢复
    function onVisibilityChange() {
      if (!captureAlive) return;
      if (document.hidden) {
        if (stream.value) {
          wasRunningWhenHidden = true;
          sleepCamera('hidden');
        }
      } else if (wasRunningWhenHidden && sleeping.value) {
        wasRunningWhenHidden = false;
        wakeCamera();
      } else {
        wasRunningWhenHidden = false;
      }
    }

    async function startCamera(id) {
      cameraError.value = '';
      sleeping.value = false;
      if (stream.value) {
        stream.value.getTracks().forEach((t) => t.stop());
        stream.value = null;
      }
      try {
        const constraints = { video: id ? { deviceId: { exact: id } } : true, audio: false };
        const s = await navigator.mediaDevices.getUserMedia(constraints);
        const track = s.getVideoTracks()[0];
        // 读取摄像头能力上限，按最大分辨率重新应用约束
        const cap = track.getCapabilities ? track.getCapabilities() : {};
        const maxW = cap.width && cap.width.max;
        const maxH = cap.height && cap.height.max;
        if (maxW && maxH && track.applyConstraints) {
          try {
            await track.applyConstraints({ width: { ideal: maxW }, height: { ideal: maxH } });
          } catch (e) {
            /* 部分摄像头不支持调整，保持当前分辨率 */
          }
        }
        const settings = track.getSettings();
        resolution.value = (settings.width || 0) + ' × ' + (settings.height || 0);
        stream.value = s;
        await Vue.nextTick();
        if (videoEl.value) {
          videoEl.value.srcObject = s;
          await videoEl.value.play();
          // 画面就绪后再次应用对焦，避免初始虚焦；并开启周期对焦脉冲
          applyFocus(track);
          startFocusPulse(track);
        }
      } catch (e) {
        cameraError.value = '无法打开摄像头：' + (e.message || e.name);
      }
      // 取流成功后重新开始空闲计时
      if (stream.value) scheduleIdleSleep();
    }

    async function wakeCamera() {
      if (waking || !sleeping.value) return;
      waking = true;
      try {
        await startCamera(deviceId.value || '');
      } finally {
        waking = false;
      }
    }

    function capture() {
      if (saving.value) return;
      if (sleeping.value) {
        wakeCamera();
        toast('摄像头已休眠，正在唤醒，请稍候再按空格拍摄', 'info');
        return;
      }
      const v = videoEl.value;
      if (!v || !v.videoWidth) {
        toast('摄像头画面未就绪', 'error');
        return;
      }
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

    // 扫码枪扫入后会自动发送回车：核对条码并退出输入框，立即进入拍摄状态
    function onBarcodeDone() {
      checkBarcodeCount();
      ready.value = !!barcode.value.trim();
      if (barcodeEl.value && document.activeElement === barcodeEl.value) barcodeEl.value.blur();
    }

    async function saveAll() {
      if (saving.value) return;
      if (!barcode.value.trim()) {
        toast('请填写衣物条形码', 'error');
        return;
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
          // 保存完成后清空条码、重置状态，焦点回到条码框等待扫下一件
          barcode.value = '';
          ready.value = false;
          barcodeCount.value = null;
          focusBarcode();
        } else if (ok > 0) {
          shots.value = shots.value.slice(ok);
          barcodeCount.value = lastSeq;
          toast('已保存 ' + ok + ' 张，剩余照片保存失败，请重试', 'error');
        } else {
          toast('保存失败，请重试', 'error');
        }
      } catch (e) {
        toast('保存失败：' + (e.message || e), 'error');
      } finally {
        saving.value = false;
      }
    }

    // 快捷键：空格拍摄、回车保存；条码框内回车 = 确认条码并进入拍摄状态
    function onKeydown(e) {
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
      if (!String(v || '').trim()) {
        ready.value = false;
        barcodeCount.value = null;
      } else if (sleeping.value) {
        // 扫码/输入条码代表马上要拍：静默唤醒摄像头
        wakeCamera();
      }
    });

    function stopCamera() {
      stopFocusPulse();
      if (stream.value) {
        stream.value.getTracks().forEach((t) => t.stop());
        stream.value = null;
      }
    }

    Vue.onMounted(() => {
      captureAlive = true;
      window.addEventListener('keydown', onKeydown);
      window.addEventListener('pointerdown', bumpActivity, true);
      document.addEventListener('visibilitychange', onVisibilityChange);
      focusBarcode();
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        loadDevices().then(() => startCamera(''));
      } else {
        cameraError.value = '当前环境不支持摄像头调用';
      }
    });

    Vue.onUnmounted(() => {
      captureAlive = false;
      window.removeEventListener('keydown', onKeydown);
      window.removeEventListener('pointerdown', bumpActivity, true);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      clearIdleTimer();
      stopCamera();
    });

    return {
      stream, devices, deviceId, cameraError, resolution, shots,
      barcode, note, saving, barcodeCount, videoEl, barcodeEl, ready,
      sleeping, startCamera, wakeCamera, sleepCamera, capture, removeShot, clearShots, saveAll, checkBarcodeCount, onBarcodeDone
    };
  },
  template: `
    <div>
      <div class="page-head">
        <h2>衣物拍照</h2>
        <p>扫码后自动进入拍摄状态，可连续拍多张、全部保存后自动编号；快捷键：<b>空格 = 拍照</b>，<b>回车 = 保存</b></p>
      </div>

      <div class="capture-layout">
        <div class="card">
          <div class="card-title">
            📷 摄像头取景
            <span v-if="resolution && !sleeping" class="tag tag-green" style="margin-left:8px">分辨率 {{ resolution }}</span>
          </div>
          <div class="camera-box">
            <video v-if="stream" ref="videoEl" autoplay playsinline muted></video>
            <div v-else-if="sleeping" class="camera-tip camera-sleep">
              <div class="camera-sleep-title">摄像头已休眠（已释放占用）</div>
              <div class="camera-sleep-sub">空闲超时或窗口最小化时自动释放设备</div>
              <button class="btn btn-primary" @click="wakeCamera">唤醒拍摄</button>
              <div class="camera-sleep-sub">扫码或按空格键也会自动唤醒</div>
            </div>
            <div v-else class="camera-tip" :class="{ error: !!cameraError }">
              {{ cameraError || '摄像头准备中…' }}
              <div v-if="cameraError">
                <button class="btn btn-primary" @click="startCamera(deviceId)">重试</button>
              </div>
            </div>
          </div>
          <div class="camera-bar">
            <select v-if="devices.length > 1" v-model="deviceId" @change="startCamera(deviceId)">
              <option v-for="(d, i) in devices" :key="d.deviceId || i" :value="d.deviceId">
                {{ d.label || ('摄像头 ' + (i + 1)) }}
              </option>
            </select>
            <button class="btn btn-primary" :disabled="!stream" @click="capture">📸 拍照（空格）</button>
            <button v-if="stream" class="btn btn-ghost" @click="sleepCamera('manual')">释放摄像头</button>
          </div>
        </div>

        <div class="card">
          <div class="card-title">🧾 存档信息</div>

          <label>衣物条形码 *</label>
          <input v-model="barcode" ref="barcodeEl" placeholder="扫码枪扫入或手动输入条形码，回车确认" @keyup.enter="onBarcodeDone" @change="onBarcodeDone" />
          <div v-if="ready && stream" class="barcode-count ok">条码已就绪，按空格键拍摄、回车保存全部</div>
          <div v-if="barcodeCount" class="barcode-count">该条码已存档 {{ barcodeCount }} 张，本次保存将接着编号</div>

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
    user: { type: Object, default: null }
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
    const exporting = Vue.ref(false);

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
      if (exporting.value) return;
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
      if (!window.confirm('将按条码（订单号）分文件夹导出照片到本地目录。\n导出范围：' + scope + '。\n下一步请选择保存目录。')) return;
      const d = await window.api.chooseExportDir();
      if (!d.ok) {
        if (d.message && d.message !== '已取消') toast(d.message, 'error');
        return;
      }
      exporting.value = true;
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
        exporting.value = false;
      }
    }

    // 按日期范围导出照片：按条码分文件夹归档，并生成「条码+文件位置」表格
    async function exportByDate() {
      if (exporting.value) return;
      if (!dateFrom.value || !dateTo.value) {
        toast('请先在上方选择开始日期与结束日期', 'error');
        return;
      }
      if (dateFrom.value > dateTo.value) {
        toast('开始日期不能晚于结束日期', 'error');
        return;
      }
      if (!window.confirm('将导出 ' + dateFrom.value + ' 至 ' + dateTo.value + ' 期间的照片，按条码分文件夹归档，并生成归档表格。下一步请选择保存目录。')) return;
      const d = await window.api.chooseExportDir();
      if (!d.ok) {
        if (d.message && d.message !== '已取消') toast(d.message, 'error');
        return;
      }
      exporting.value = true;
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
        exporting.value = false;
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
      if (!window.confirm('确定批量删除选中的 ' + selected.value.length + ' 条记录？照片将一并删除，不可恢复。')) return;
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
      if (!window.confirm('确定删除该存档记录？照片将一并删除，不可恢复。')) return;
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

    Vue.onMounted(() => {
      loadUsers();
      // 首屏必须先按容器尺寸算出每页数量再查询。
      // 此前的写法把 recalcPageSize 放在 nextTick 里、而 search 同步执行，
      // 导致首次查询仍用初始的 12 张，之后虽改了 pageSize 却不再重查（页面大小变化不生效）。
      recalcPageSize();
      search(true);
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
      exporting, exportByBarcode, exportByDate,
      search, reset, openDetail, remove, prev, next, goPage, fmt,
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
        </div>

        <div class="batch-bar" v-if="items.length">
          <label v-if="canDelete" class="batch-check"><input type="checkbox" :checked="selected.length === items.length && items.length > 0" @change="selectAll" />全选本页</label>
          <span v-if="canDelete" class="pager-info">已选 {{ selected.length }} 条</span>
          <button class="btn btn-ghost btn-sm" :disabled="exporting" @click="exportByBarcode">
            {{ exporting ? '导出中…' : '⬇ 按订单号批量下载' }}
          </button>
          <button class="btn btn-ghost btn-sm" :disabled="exporting" @click="exportByDate" title="按上方日期范围导出照片，并生成条码+文件位置表格">
            ⬇ 按日期导出
          </button>
          <button v-if="canDelete" class="btn btn-danger btn-sm" :disabled="!selected.length || batchDeleting" @click="batchDelete">
            {{ batchDeleting ? '删除中…' : '批量删除' }}
          </button>
        </div>

        <div ref="gridEl" class="query-results">
          <div v-if="loading" class="empty">加载中…</div>
          <div v-else-if="!items.length" class="empty">暂无符合条件的存档记录</div>
          <div v-else class="record-grid">
            <div v-for="r in items" :key="r.id" class="record-card" @click="openDetail(r)">
              <div class="record-photo"><img :src="r.thumbUrl || r.photoUrl" loading="lazy" decoding="async" /></div>
              <div class="record-meta">
                <div class="record-customer">{{ r.barcode }}</div>
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

      <div v-if="detail" class="lightbox" @click.self="closeDetail" @wheel="onWheel">
        <!-- 顶部信息条 -->
        <div class="lightbox-top">
          <div class="lightbox-info">
            <span class="lightbox-barcode">{{ detail.barcode }}</span>
            <span class="lightbox-seq">第 {{ detail.seq }} 张</span>
            <span v-if="adminMode || !isMine(detail)" class="lightbox-owner">{{ detail.username }}</span>
            <span v-if="adminMode && detail.storeName" class="lightbox-owner">门店：{{ detail.storeName }}</span>
            <span class="lightbox-time">{{ fmt(detail.createdAt) }}</span>
            <span v-if="detail.note" class="lightbox-note" :title="detail.note">备注：{{ detail.note }}</span>
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

        <!-- 底部工具条 -->
        <div class="lightbox-bottom">
          <button class="lightbox-btn" title="缩小（-）" @click="zoomOut">－</button>
          <button class="lightbox-btn" title="实际大小（0）" @click="zoomReset">1:1</button>
          <button class="lightbox-btn" title="放大（+）" @click="zoomIn">＋</button>
          <span class="lightbox-hint">滚轮缩放 · 拖拽平移 · 双击放大 · ←/→ 切换 · Esc 关闭</span>
          <button
            v-if="adminMode || isMine(detail)"
            class="lightbox-btn lightbox-danger"
            @click="remove(detail)"
          >删除记录</button>
          <span v-else class="lightbox-hint">该记录由同门店同事录入，仅可查看与导出，不可删除</span>
        </div>
      </div>
    </div>
  `
};

/* ---------- 客户端 · 设置页 ---------- */
const SettingsPage = {
  props: { user: { type: Object, required: true }, token: { type: String, required: true } },
  setup(props) {
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

    return {
      user: props.user, oldPassword, newPassword, confirmPassword, saving, submit, fmt, storeLabel, roleLabel,
      version, updateInfo, downloading, canAutoDownload, progressPercent, progressText,
      downloadPackage, cancelDownload
    };
  },
  template: `
    <div>
      <div class="page-head">
        <h2>设置</h2>
        <p>查看账号信息并修改登录密码</p>
      </div>

      <div class="settings-grid">
        <div class="card">
          <div class="card-title">👤 账号信息</div>
          <div class="info-row"><span>账号</span><b>{{ user.username }}</b></div>
          <div class="info-row"><span>姓名</span><b>{{ user.name }}</b></div>
          <div class="info-row"><span>角色</span><b>{{ roleLabel(user.role) }}</b></div>
          <div class="info-row"><span>所属门店</span><b>{{ storeLabel }}</b></div>
          <div class="info-row"><span>拍照权限</span><b>{{ user.permissions && user.permissions.capture ? '已开通' : '未开通' }}</b></div>
          <div class="info-row"><span>查询权限</span><b>{{ user.permissions && user.permissions.query ? '已开通' : '未开通' }}</b></div>
          <div class="info-row"><span>创建时间</span><b>{{ fmt(user.createdAt) }}</b></div>
          <div class="info-row"><span>最近登录</span><b>{{ user.lastLoginAt ? fmt(user.lastLoginAt) : '-' }}</b></div>
        </div>

        <div class="card">
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
        </div>

        <div class="card">
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
        <div v-if="o && !o.recentRecords.length" class="empty">暂无存档记录</div>
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
      if (!window.confirm('确定删除账号 ' + u.username + '？该操作不可恢复。')) return;
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

        <div v-if="loading" class="empty">加载中…</div>
        <div v-else-if="!items.length" class="empty">暂无符合条件的日志</div>
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
          const ok = window.confirm(
            `将订单保留期设为 ${parsed.value} 天后，超过该期限的订单及其照片将被自动删除，且不可恢复。\n\n` +
              `保存本身不会立即删除数据（自动清理按计划在后台执行），但你也可以点「试算」先看看会影响多少条。\n\n确定保存？`
          );
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
        const ok = window.confirm(
          (wipingAll
            ? '⚠️ 警告：本次清理将删除【全部】订单数据，清理后系统将没有任何订单记录！\n\n'
            : '') +
            `即将永久删除 ${n} 条超期订单及其照片文件，此操作不可恢复。\n\n` +
            `保留期：${pre.data.retentionDays} 天\n截止时间点：${fmt(pre.data.cutoffIso)}\n删除后剩余：${pre.data.kept} 条\n\n` +
            (wipingAll ? '请先确认保留期设置正确，并务必先导出备份。' : '建议先导出备份。') +
            '\n确定立即删除？'
        );
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
      if (!window.confirm('重置后，所有客户端需使用新连接码重新配置。确定重置？')) return;
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
      canSetRetention, retentionDisabledReason, fmt
    };
  },
  template: `
    <div>
      <div class="page-head">
        <h2>系统设置</h2>
        <p>服务端口、连接码与照片保存路径（仅服务端生效）</p>
      </div>

      <div v-if="info" class="settings-grid">
        <div class="card">
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
        </div>

        <div class="card">
          <div class="card-title">🖼️ 照片保存路径</div>
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
        </div>
      </div>

      <div v-if="info" class="card" style="margin-top:18px">
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
      </div>

      <div v-if="info" class="card" style="margin-top:18px">
        <div class="card-title">🗑️ 订单数据保留期</div>

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
      </div>

      <div v-if="info" class="card" style="margin-top:18px">
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
      </div>

      <div v-if="info && info.mode === 'server'" class="card" style="margin-top:18px">
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
          📥 使用方法：把安装包（文件名需含版本号，如 xingqiyi-laundry-photo-setup-1.1.7.exe）放入软件安装目录下的「软件更新」文件夹 →
          在上方列表选中它 → 点「开启强制推送」。客户端下次登录时会自动从服务器下载该安装包，
          下载完成后弹窗提示店员双击安装；版本号不高于客户端当前版本的不会触发。
        </p>
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

      <div v-if="loading" class="card empty">正在加载操作手册…</div>
      <div v-else-if="error" class="card">
        <div class="empty">{{ error }}</div>
        <div style="text-align:center;margin-top:14px">
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
      manual: ManualPage
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
          { key: 'system', icon: '<svg viewBox="0 0 24 24"><path d="M4 7.2h9.2M18.2 7.2H20M4 12h2.2M11 12h9M4 16.8h9.2M18.2 16.8H20"/><circle cx="15.6" cy="7.2" r="2"/><circle cx="8.5" cy="12" r="2"/><circle cx="15.6" cy="16.8" r="2"/></svg>', label: '系统设置' }
        ];
      } else if (isStoreAdmin) {
        list = [
          { key: 'home', icon: '<svg viewBox="0 0 24 24"><path d="M4.6 10.8 12 4.6l7.4 6.2V19a1.6 1.6 0 0 1-1.6 1.6h-3.6v-5.4h-4.4v5.4H6.2A1.6 1.6 0 0 1 4.6 19Z"/></svg>', label: '首页' },
          { key: 'logs', icon: '<svg viewBox="0 0 24 24"><path d="M8 6.5h12M8 12h12M8 17.5h12"/><path d="M3.8 6.5h.01M3.8 12h.01M3.8 17.5h.01"/></svg>', label: '本店日志' },
          { key: 'query', icon: '<svg viewBox="0 0 24 24"><path d="M3.8 7a2 2 0 0 1 2-2h3.4l1.9 2.3h7.1a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5.8a2 2 0 0 1-2-2Z"/></svg>', label: '本店订单' },
          { key: 'settings', icon: '<svg viewBox="0 0 24 24"><path d="M4 7.2h9.2M18.2 7.2H20M4 12h2.2M11 12h9M4 16.8h9.2M18.2 16.8H20"/><circle cx="15.6" cy="7.2" r="2"/><circle cx="8.5" cy="12" r="2"/><circle cx="15.6" cy="16.8" r="2"/></svg>', label: '设置' }
        ];
      } else {
        list = [{ key: 'home', icon: '<svg viewBox="0 0 24 24"><path d="M4.6 10.8 12 4.6l7.4 6.2V19a1.6 1.6 0 0 1-1.6 1.6h-3.6v-5.4h-4.4v5.4H6.2A1.6 1.6 0 0 1 4.6 19Z"/></svg>', label: '首页' }];
        // 拍照能力由角色派生，查询账号不显示拍照入口
        if (canCapture) list.push({ key: 'capture', icon: '<svg viewBox="0 0 24 24"><path d="M14.5 5h-5L7.8 7.6H4.6A1.6 1.6 0 0 0 3 9.2v8.2a1.6 1.6 0 0 0 1.6 1.6h14.8a1.6 1.6 0 0 0 1.6-1.6V9.2a1.6 1.6 0 0 0-1.6-1.6h-3.2Z"/><circle cx="12" cy="13.2" r="3.1"/></svg>', label: '衣物拍照' });
        list.push({ key: 'query', icon: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.4"/><path d="m19.8 19.8-3.2-3.2"/></svg>', label: '记录查询' });
        list.push({ key: 'settings', icon: '<svg viewBox="0 0 24 24"><path d="M4 7.2h9.2M18.2 7.2H20M4 12h2.2M11 12h9M4 16.8h9.2M18.2 16.8H20"/><circle cx="15.6" cy="7.2" r="2"/><circle cx="8.5" cy="12" r="2"/><circle cx="15.6" cy="16.8" r="2"/></svg>', label: '设置' });
      }
      // 操作手册对所有角色可见，统一在末尾追加：
      // 放在这里而不是三个分支各写一次，避免将来新增角色时漏加手册入口。
      // 手册内部已按角色裁剪章节，因此同一入口对不同角色显示不同内容。
      list.push({ key: 'manual', icon: '<svg viewBox="0 0 24 24"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>', label: '操作手册' });
      return list;
    })();

    const active = Vue.ref(pages[0].key);

    async function doLogout() {
      const r = await window.api.logout(props.token);
      emit('logout');
      toast(r.ok ? '已退出登录' : r.message || '退出失败', r.ok ? 'success' : 'error');
    }

    return {
      user: props.user, mode: props.mode, isAdmin, isStoreAdmin, canCapture,
      roleText: roleLabel(role), pages, comps, active, doLogout, version,
      latestVersion, hasUpdate,
      online, pending, syncing, doSync
    };
  },
  template: `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <img class="logo-brand" src="./assets/logo.png" alt="星期衣" />
          <div>
            <div class="brand-name">星期衣精致洗衣</div>
            <div class="brand-sub">衣物照片系统 · {{ isAdmin ? '管理端' : (isStoreAdmin ? '门店管理' : '客户端') }}</div>
          </div>
        </div>
        <nav class="nav">
          <div
            v-for="p in pages"
            :key="p.key"
            class="nav-item"
            :class="{ active: active === p.key }"
            @click="active = p.key"
          >
            <span class="nav-icon" v-html="p.icon"></span>{{ p.label }}
          </div>
        </nav>
        <div class="sidebar-foot">
          <div class="user-chip">
            <div class="avatar">{{ (user.name || user.username).charAt(0) }}</div>
            <div>
              <div class="user-name">{{ user.name || user.username }}</div>
              <div class="user-role">{{ roleText }} · {{ mode === 'client' ? '已连接服务器' : '本机服务端' }}</div>
            </div>
          </div>
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
          @goto="active = $event"
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
      revokedMsg
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
      <div style="flex:1;min-height:0">
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
    </div>
  `
});

app.component('login-page', LoginPage);
app.component('setup-page', SetupPage);
app.component('shell', Shell);
app.mount('#app');
