'use strict';

/**
 * 桌面端发布脚本：node scripts/release-desktop.js [--dry-run] [--draft] [--insecure]
 *
 * **只处理桌面端**：只认 dist/ 下的 Windows 安装包（.exe），只上传到桌面端仓库
 * Jace-Hao/xingqiyi-laundry-photo。移动端有自己的仓库与工作流，两端互不干涉。
 *
 * 流程：
 *   1. 以 package.json 的 version 为唯一版本号来源，tag 固定为 v<version>
 *   2. 校验 dist/ 下存在该版本的安装包（先跑 npm run build）
 *   3. 校验 tag 在远端不存在（避免重复发布）
 *   4. 创建 Release 并上传附件，最后打印 SHA-256 供人工核对
 *
 * 需要环境变量 GH_TOKEN（PAT，需 repo 作用域）。
 * --insecure：跳过 TLS 证书校验。本机代理做 SSL 中间人拦截时必须加，
 *   否则报 UNABLE_TO_VERIFY_LEAF_SIGNATURE（这是本机网络环境问题，不是 GitHub 拒绝）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const AS_DRAFT = args.includes('--draft');
if (args.includes('--insecure')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const ROOT = path.join(__dirname, '..');
const REPO = 'Jace-Hao/xingqiyi-laundry-photo'; // 桌面端仓库，不要改成移动端仓库
const NOTES_DIR = path.join(ROOT, 'docs', 'desktop-release');

const pkg = require(path.join(ROOT, 'package.json'));
const version = String(pkg.version || '').trim();
const tag = 'v' + version;

function fail(msg) {
  console.error('[release] ' + msg);
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+$/.test(version)) fail('package.json 的 version 不是语义化版本：' + version);

// ---------- 1. 找安装包 ----------
const distDir = path.join(ROOT, 'dist');
if (!fs.existsSync(distDir)) fail('未找到 dist/，请先执行 npm run build');

const assets = fs
  .readdirSync(distDir)
  .filter((f) => /\.exe$/i.test(f) && f.includes(version))
  .map((f) => path.join(distDir, f));

if (!assets.length) {
  fail(
    'dist/ 下没有版本为 ' + version + ' 的安装包。\n' +
      '  请先确认 package.json 的 version 已升到目标版本，再执行 npm run build。\n' +
      '  当前 dist/ 内容：' + (fs.readdirSync(distDir).join('、') || '<空>')
  );
}
// 附带 blockmap 便于增量更新（electron-builder 生成，缺了也不影响安装）
const blockmaps = assets
  .map((f) => f + '.blockmap')
  .filter((f) => fs.existsSync(f));

const files = assets.concat(blockmaps);
const shaOf = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').toUpperCase();

console.log('[release] 桌面端 ' + tag + '（仓库 ' + REPO + '）');
for (const f of files) {
  console.log('  ' + path.basename(f));
  console.log('    ' + fs.statSync(f).size.toLocaleString() + ' B  SHA-256 ' + shaOf(f));
}

// ---------- 2. 发布说明 ----------
const notesFile = path.join(NOTES_DIR, tag + '-notes.md');
let body = '';
if (fs.existsSync(notesFile)) {
  const raw = fs.readFileSync(notesFile, 'utf8');
  // 去掉标题行与附件校验表（校验值在上传后由脚本统一打印）
  body = raw.split(/^##\s*附件校验/m)[0].replace(/^#.*\n/, '').trim();
} else {
  body = '';
  console.log('  ⚠ 未找到发布说明 ' + path.relative(ROOT, notesFile) + '，Release 正文将为空');
}

// ---------- 3. 干跑 ----------
const token = process.env.GH_TOKEN;
if (DRY_RUN || !token) {
  console.log('\n[release] ' + (DRY_RUN ? '干跑模式' : '未设置 GH_TOKEN') + '，未执行上传。');
  console.log('  正式发布：设置 GH_TOKEN 后重跑（本机需加 --insecure 绕过代理的 SSL 拦截）');
  console.log('  说明文件：' + path.relative(ROOT, notesFile));
  process.exit(0);
}

// ---------- 4. 创建 Release ----------
const API = 'https://api.github.com/repos/' + REPO;
const headers = {
  Authorization: 'Bearer ' + token,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'xingqiyi-laundry-photo-release'
};

async function main() {
  const existed = await fetch(API + '/releases/tags/' + tag, { headers });
  if (existed.ok) fail('远端已存在 Release ' + tag + '，如需重传请先删除该 Release');

  const created = await fetch(API + '/releases', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    body: JSON.stringify({
      tag_name: tag,
      name: '桌面端 ' + tag,
      body,
      draft: AS_DRAFT,
      prerelease: false
    })
  });
  const rel = await created.json();
  if (!created.ok || !rel.id) {
    fail('创建 Release 失败：' + JSON.stringify(rel).slice(0, 400));
  }
  console.log('\n[release] Release 已创建：' + rel.html_url + (AS_DRAFT ? '（草稿）' : ''));

  // 上传附件：URL 必须带 name 参数，否则中文名会被 GitHub 剥离
  const uploadBase = 'https://uploads.github.com/repos/' + REPO + '/releases/' + rel.id + '/assets';
  for (const f of files) {
    const name = path.basename(f);
    const ct = /\.blockmap$/i.test(name) ? 'application/octet-stream' : 'application/octet-stream';
    const up = await fetch(uploadBase + '?name=' + encodeURIComponent(name), {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': ct, 'Content-Length': fs.statSync(f).size }, headers),
      body: fs.readFileSync(f)
    });
    const upJson = await up.json().catch(() => ({}));
    if (!up.ok || !upJson.id) {
      console.error('  上传失败 ' + name + '：' + JSON.stringify(upJson).slice(0, 300));
      process.exitCode = 1;
    } else {
      console.log('  已上传 ' + upJson.name + '（' + upJson.size.toLocaleString() + ' B）');
    }
  }

  console.log('\n[release] 完成。请核对附件 SHA-256 与上方本地计算值一致。');
}

main().catch((e) => fail(e && e.message ? e.message : String(e)));
