'use strict';

/**
 * 手册同步校验有效性验证：node scripts/verify-manual-sync.js
 *
 * 验证 sync-manual.js 的三道校验（版本一致性、语法覆盖、角色标记合法性）
 * 是否真的会拦截问题输入——只测「应当失败」的用例，
 * 因为如果校验对坏输入也放行，那它就只是装饰，起不到构建期把关的作用。
 *
 * 全部用例在隔离的临时目录中运行，不触碰真实的 docs/manual.md 与 renderer/assets/。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'sync-manual.js');

let pass = 0;
let fail = 0;

/** 在隔离副本仓库中跑同步脚本，返回 { code, stdout, stderr } */
function runInSandbox(manualText, pkgVersion) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xqy-sync-'));
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'renderer', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'manual.md'), manualText, 'utf8');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'x', version: pkgVersion || '1.1.0' }),
    'utf8'
  );
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'sync-manual.js'));
  try {
    const out = execFileSync(process.execPath, [path.join(dir, 'scripts', 'sync-manual.js')], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const result = { code: 0, out, err: '' };
    fs.rmSync(dir, { recursive: true, force: true });
    return result;
  } catch (e) {
    const result = { code: e.status === undefined ? 1 : e.status, out: e.stdout || '', err: e.stderr || '' };
    fs.rmSync(dir, { recursive: true, force: true });
    return result;
  }
}

function expectReject(name, text, keyword, pkgVersion) {
  const r = runInSandbox(text, pkgVersion);
  if (r.code === 0) {
    fail++;
    console.log('  ✗ ' + name + ' —— 校验未拦截（脚本正常退出）');
    return;
  }
  const msg = (r.err + r.out).replace(/\s+/g, ' ');
  if (keyword && !msg.includes(keyword)) {
    fail++;
    console.log('  ✗ ' + name + ' —— 拦截了但原因不符：' + msg.slice(0, 160));
    return;
  }
  pass++;
  console.log('  ✓ ' + name);
}

function expectAccept(name, text, pkgVersion) {
  const r = runInSandbox(text, pkgVersion);
  if (r.code !== 0) {
    fail++;
    console.log('  ✗ ' + name + ' —— 本应通过却被拒：' + (r.err + r.out).replace(/\s+/g, ' ').slice(0, 160));
    return;
  }
  pass++;
  console.log('  ✓ ' + name);
}

const GOOD = '# 手册-v1.1.0\n\n版本：v1.1.0\n\n## 一、章节\n<!-- roles:sysadmin -->\n\n正文 **粗体**\n\n- 项目一\n- 项目二\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n';

console.log('=== sync-manual 校验有效性验证 ===');

console.log('\n[1] 基线：合法手册应通过');
expectAccept('合法手册通过', GOOD);

console.log('\n[2] 版本不一致必须拦截');
expectReject('手册缺少当前版本号', '# 手册-v1.0.9\n\n版本：v1.0.9\n\n## 章节\n', '未包含当前版本号');
expectReject('版本号被改后旧手册被拦', GOOD, '未包含当前版本号', '2.0.0');

console.log('\n[3] 不支持的语法必须拦截');
expectReject('围栏代码块', GOOD + '\n```\ncode\n```\n', '围栏代码块');
expectReject('有序列表', GOOD + '\n1. 第一步\n2. 第二步\n', '有序列表');
expectReject('图片语法', GOOD + '\n![图](a.png)\n', '图片');
expectReject('链接语法', GOOD + '\n[文档](http://a)\n', '链接');
expectReject('引用块', GOOD + '\n> 引用内容\n', '引用块');
expectReject('五级标题', GOOD + '\n##### 五级\n', '五级及以上标题');
expectReject('分隔线', GOOD + '\n---\n', '分隔线');

console.log('\n[4] 非法角色标记必须拦截');
expectReject('角色名拼错', GOOD + '\n## 二、节\n<!-- roles:admin -->\n', '未知角色');
expectReject('角色名为空', GOOD + '\n## 二、节\n<!-- roles: -->\n', '空的 roles 标记');
expectReject('角色列表含非法项', GOOD + '\n## 二、节\n<!-- roles:sysadmin,manager -->\n', '未知角色');
expectAccept('四种合法角色均通过', GOOD + '\n## 二、节\n<!-- roles:sysadmin,storeadmin,capture,query -->\n');

console.log('\n[5] 边界：空文件 / 缺文件');
expectReject('空手册被拦', '   \n\n  ', '手册源文件为空');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xqy-nofile-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.1.0' }), 'utf8');
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'sync-manual.js'));
  let code = 0;
  let msg = '';
  try {
    msg = execFileSync(process.execPath, [path.join(dir, 'scripts', 'sync-manual.js')], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    code = e.status === undefined ? 1 : e.status;
    msg = (e.stderr || '') + (e.stdout || '');
  }
  fs.rmSync(dir, { recursive: true, force: true });
  const ok = code !== 0 && msg.includes('未找到手册源文件');
  ok ? pass++ : fail++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + '手册文件缺失被拦');
}

console.log('\n[6] 产物正确性：同步后文件内容与源一致');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xqy-out-'));
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'manual.md'), GOOD, 'utf8');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.1.0' }), 'utf8');
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'sync-manual.js'));
  execFileSync(process.execPath, [path.join(dir, 'scripts', 'sync-manual.js')], { cwd: dir, encoding: 'utf8' });
  const dest = path.join(dir, 'renderer', 'assets', 'manual.md');
  const okExists = fs.existsSync(dest);
  const okSame = okExists && fs.readFileSync(dest, 'utf8') === GOOD;
  okExists && okSame ? pass++ : fail++;
  console.log((okExists && okSame ? '  ✓ ' : '  ✗ ') + '产物路径正确且内容与源一致');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== 结果 ===');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
