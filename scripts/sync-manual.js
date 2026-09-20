'use strict';

/**
 * 同步操作手册到渲染进程资源目录：node scripts/sync-manual.js
 *
 * 为什么需要同步（而不是直接读 docs/manual.md）：
 *   package.json 的 build.files 只包含 main/**、renderer/**、package.json，
 *   docs/ 目录不会被打包进 app.asar。安装包内直接读 docs/manual.md 会失败，
 *   导致内置手册页面白屏。因此把手册复制进 renderer/assets/，
 *   由 renderer/** 一并打包；主进程用 fs 读取（Electron 对 asar 内文件透明支持）。
 *
 * 同时承担「每个版本更新时自动更新操作手册」的机械校验：
 *   手册标题/版本行必须包含 package.json 的当前版本号，否则报错退出。
 *   这样忘记更新手册会在构建阶段就被拦住，而不是发布后才发现文档与版本不符。
 *
 * 运行时机：npm run build 之前自动执行（见 package.json 的 prebuild），
 * 也可在改完 docs/manual.md 后手动执行。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'docs', 'manual.md');
const DEST = path.join(ROOT, 'renderer', 'assets', 'manual.md');
const PKG = require(path.join(ROOT, 'package.json'));

const version = String(PKG.version || '').trim();

function fail(msg) {
  console.error('[sync-manual] ' + msg);
  process.exit(1);
}

if (!version) fail('package.json 缺少 version 字段，无法校验手册版本');
if (!fs.existsSync(SRC)) fail('未找到手册源文件：' + SRC);

const text = fs.readFileSync(SRC, 'utf8');
if (!text.trim()) fail('手册源文件为空：' + SRC);

// ---------- 版本一致性校验 ----------
// 要求手册中出现当前版本号（标题行与版本行都带 v 前缀）。
// 只在版本不匹配时拦截；不自动改写手册内容，避免脚本静默篡改文档措辞。
const versionToken = 'v' + version;
if (!text.includes(versionToken)) {
  fail(
    `手册未包含当前版本号 ${versionToken}。\n` +
      '  请在 ' + path.relative(ROOT, SRC) + ' 的标题与版本行中更新版本号，\n' +
      '  并核对本版变更是否已写入手册（见 CHANGELOG.md），然后重新执行本脚本。'
  );
}

// ---------- 语法覆盖检查 ----------
// 内置渲染器只支持手册实际用到的语法子集。若将来手册引入了渲染器不支持的写法，
// 在这里就报错，避免内置页面出现「原样输出源码」的破版。
const UNSUPPORTED = [
  { name: '围栏代码块', re: /^```/m },
  { name: '有序列表', re: /^\s*\d+\.\s+/m },
  { name: '图片', re: /!\[[^\]]*\]\(/ },
  { name: '链接', re: /(?<!!)\[[^\]]+\]\([^)]*\)/ },
  { name: '引用块', re: /^>\s+/m },
  { name: '五级及以上标题', re: /^#####\s+/m },
  { name: '分隔线', re: /^(-{3,}|\*{3,}|_{3,})\s*$/m }
];
const unsupportedFound = UNSUPPORTED.filter((u) => u.re.test(text)).map((u) => u.name);
if (unsupportedFound.length) {
  fail(
    '手册使用了内置渲染器尚不支持的语法：' + unsupportedFound.join('、') + '。\n' +
      '  请改用受支持的写法（# ~ #### 标题、无序列表、表格、**粗体**、普通段落），\n' +
      '  或在 renderer.js 的解析器中补充支持后同步更新本清单。'
  );
}

// ---------- 角色可见性标记检查 ----------
// 内置手册按登录角色裁剪章节，依赖 <!-- roles:xxx --> 标记。
// 标记写错（角色名拼错）会导致章节对所有人都隐藏或都显示，因此校验取值合法。
const VALID_ROLES = ['sysadmin', 'storeadmin', 'capture', 'query'];
const roleMarkers = [...text.matchAll(/<!--\s*roles:\s*([^>]*?)\s*-->/g)];
for (const m of roleMarkers) {
  const roles = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  if (!roles.length) fail('存在空的 roles 标记：' + m[0]);
  const bad = roles.filter((r) => !VALID_ROLES.includes(r));
  if (bad.length) {
    fail(
      '角色标记含未知角色：' + bad.join('、') + '（' + m[0] + '）\n' +
        '  可用角色：' + VALID_ROLES.join(', ')
    );
  }
}

// ---------- 写入渲染进程资源目录 ----------
fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.writeFileSync(DEST, text, 'utf8');

const sizeKb = (Buffer.byteLength(text, 'utf8') / 1024).toFixed(1);
console.log(
  '[sync-manual] 已同步手册 v' + version + ' → renderer/assets/manual.md' +
    '（' + sizeKb + ' KB，角色标记 ' + roleMarkers.length + ' 处）'
);
