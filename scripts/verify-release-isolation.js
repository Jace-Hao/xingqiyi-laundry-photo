'use strict';

/**
 * 发布隔离自检：node scripts/verify-release-isolation.js
 *
 * 校验「桌面端仓库只发桌面端产物」这条约定没被破坏。
 * 历史上两端共库同号，移动端发 v1.3.1 时桌面端把它判成新版本、
 * 并把 APK 当安装包推给电脑用户。拆库之后仍需要有人盯住边界，
 * 因此把这些约定写成会红的断言，而不是靠人记住。
 *
 * 检查项：
 *   1. 仓库内不存在 android/ 目录与任何 APK（移动端产物不许混进来）
 *   2. main.js 的 GITHUB_REPO 指向**桌面端**仓库，不是移动端仓库
 *   3. main.js 的更新选版逻辑带桌面产物过滤（.exe/.msi），不回退到「第一个附件」
 *   4. package.json 的 version 是唯一的桌面端版本号来源，且手册版本与之匹配
 *   5. .gitignore 已不再声明 Android 构建产物（拆库后无需再忽略）
 *
 * 退出码 0 = 全部通过；非 0 = 有问题（会打印具体是哪一条）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DESKTOP_REPO = 'Jace-Hao/xingqiyi-laundry-photo';
const MOBILE_REPO = 'Jace-Hao/xingqiyi-laundry-photo-android';

const problems = [];
function check(ok, desc, detail) {
  if (ok) {
    console.log('  ✓ ' + desc);
  } else {
    console.log('  ✗ ' + desc + (detail ? '\n      ' + detail : ''));
    problems.push(desc);
  }
}

function walk(dir, out, depth) {
  if (depth > 6) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else out.push(p);
  }
  return out;
}

console.log('[release-isolation] 桌面端发布隔离自检\n');

// ---------- 1. 仓库里不得有移动端源码或产物 ----------
const allFiles = walk(ROOT, [], 0);
const apkFiles = allFiles.filter((f) => /\.aab$/i.test(f) || /\.apk$/i.test(f));
check(
  !fs.existsSync(path.join(ROOT, 'android')),
  '仓库内不存在 android/ 目录',
  '移动端源码在 ' + MOBILE_REPO + '，不要放回桌面端仓库'
);
check(
  apkFiles.length === 0,
  '仓库内不存在 APK/AAB 产物',
  '发现：' + apkFiles.map((f) => path.relative(ROOT, f)).join('、')
);

// ---------- 2 & 3. 更新源与选版过滤 ----------
const mainSrc = fs.readFileSync(path.join(ROOT, 'main', 'main.js'), 'utf8');
const repoMatch = mainSrc.match(/const\s+GITHUB_REPO\s*=\s*'([^']+)'/);
check(
  !!repoMatch && repoMatch[1] === DESKTOP_REPO,
  'main.js 的 GITHUB_REPO 指向桌面端仓库（' + DESKTOP_REPO + '）',
  '实际为：' + (repoMatch ? repoMatch[1] : '<未找到>')
);
check(
  !mainSrc.includes(MOBILE_REPO.split('/')[1] + "'") || mainSrc.indexOf("'" + MOBILE_REPO + "'") === -1,
  'main.js 未把更新源指向移动端仓库'
);
check(
  /const\s+DESKTOP_ASSET_RE\s*=/.test(mainSrc) && /DESKTOP_ASSET_RE\.test/.test(mainSrc),
  '更新选版带桌面产物过滤（DESKTOP_ASSET_RE）',
  '缺少过滤会让 APK 之类的附件被当成安装包下载'
);
check(
  !/assets\.find\(\(a\) => \/\\\.exe\$\/i\.test\(a\.name \|\| ''\)\) \|\| assets\[0\]/.test(mainSrc) &&
    !/\|\|\s*assets\[0\]/.test(mainSrc),
  '选版不再回退到「第一个附件」',
  '回退到 assets[0] 会把 APK 当安装包，正是历史故障的直接原因'
);

// ---------- 4. 版本号唯一来源 ----------
const pkg = require(path.join(ROOT, 'package.json'));
const version = String(pkg.version || '');
check(
  /^\d+\.\d+\.\d+$/.test(version),
  'package.json 的 version 是合法语义化版本（当前 ' + version + '）'
);
const manual = fs.readFileSync(path.join(ROOT, 'docs', 'manual.md'), 'utf8');
check(
  manual.includes('v' + version),
  'docs/manual.md 含当前版本号 v' + version,
  'prebuild 的 sync-manual.js 也会拦这一条，这里提前暴露'
);
// 桌面端版本线为 1.2.x：跳到 1.3.x 说明又踩了当年的编号失误
check(
  /^1\.2\.\d+$/.test(version),
  '桌面端版本号处于 1.2.x 版本线（1.2.3 起递增）',
  '当前为 ' + version + '。桌面端上一正式版是 v1.2.2，1.3.0 是曾发生的编号失误'
);

// ---------- 5. .gitignore 不再声明 Android 产物 ----------
const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
check(
  !/^android\//m.test(ignore) && !/^release-apk\//m.test(ignore),
  '.gitignore 不再声明 android/ 与 release-apk/（移动端已迁出）'
);

console.log('');
if (problems.length) {
  console.error('[release-isolation] ' + problems.length + ' 项未通过');
  process.exit(1);
}
console.log('[release-isolation] 全部通过');
