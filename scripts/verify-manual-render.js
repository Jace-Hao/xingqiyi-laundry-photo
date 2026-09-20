'use strict';

/**
 * 内置手册 Markdown 渲染器验证：node scripts/verify-manual-render.js
 *
 * 与 verify-watermark.js 同样的做法：从 renderer.js **提取真实函数源码**执行，
 * 而不是复制一份——避免测了副本却漏掉真实代码的偏差。
 *
 * 重点验证：
 *   1. 安全：任何 HTML/脚本都被转义，不作为标签输出（默认动作，无例外分支）
 *   2. 语法子集：标题 / 段落合并 / 无序列表 / 表格 / **粗体** 渲染正确
 *   3. 角色裁剪：<!-- roles:xxx --> 生效，且子章节继承父章节可见性
 *   4. 目录：只收 h2/h3、id 唯一（重复标题不冲突）
 *   5. 真实手册能完整渲染，且不残留未解析的 markdown 源码
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'renderer', 'renderer.js');
const src = fs.readFileSync(SRC, 'utf8');

/** 从源码提取顶层函数（含完整花括号配对） */
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

// 注意：必须包含被这些函数调用的依赖（sectionVisible 用到 isSysAdminRole），
// 否则在 new Function 沙箱内会 ReferenceError。新增依赖时要同步登记到这里。
const NAMES = ['escapeHtml', 'inlineMd', 'slugify', 'isSysAdminRole', 'parseManualSections', 'sectionVisible', 'renderSectionBody', 'renderManual'];
const code = NAMES.map(extractFunction).join('\n\n');
const api = new Function(code + '\nreturn { ' + NAMES.join(', ') + ' };')();

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

console.log('=== 内置手册渲染器验证 ===');

console.log('\n[1] 安全：HTML 与脚本一律转义');
{
  const esc = api.escapeHtml('<script>alert(1)</script>');
  ck('< > 被转义', !esc.includes('<') && !esc.includes('>'), esc);
  ck('& 被转义', api.escapeHtml('a & b').includes('&amp;'));
  ck('引号被转义', api.escapeHtml('"x"').includes('&quot;'));

  const evil = '# 标题\n\n<script>alert("xss")</script>\n\n<img src=x onerror=alert(1)>\n\n<iframe src="//evil"></iframe>\n';
  const { html } = api.renderManual(evil, 'sysadmin');
  ck('渲染结果不含 <script>', !html.includes('<script'), html.slice(0, 200));
  ck('渲染结果不含 <img', !html.includes('<img'), html.slice(0, 200));
  ck('渲染结果不含 <iframe', !html.includes('<iframe'), html.slice(0, 200));
  // onerror 作为纯文本出现是安全的（已被转义），危险的是它成为标签属性。
  // 因此断言的是「没有任何标签含 onerror 属性」，而不是「不含该字符串」。
  ck('onerror 未成为标签属性', !/<[^>]*onerror/i.test(html), html.slice(0, 200));
  // 转义后的文本应当可见（用户能看到原文，而不是被执行）
  ck('恶意内容以文本形式呈现', html.includes('&lt;script&gt;'));

  // 粗体标记里夹带 HTML 也必须转义
  const boldEvil = api.renderManual('# T\n\n**<b>x</b>**\n', 'sysadmin').html;
  ck('粗体内 HTML 被转义', !boldEvil.includes('<b>x</b>') && boldEvil.includes('&lt;b&gt;'), boldEvil.slice(0, 160));
  ck('粗体本身仍生效', boldEvil.includes('<strong>'));
}

console.log('\n[2] 基础语法渲染');
{
  const md = '# 一级标题\n\n## 二级标题\n\n### 三级标题\n\n#### 四级标题\n';
  const { html } = api.renderManual(md, 'sysadmin');
  ck('h1~h4 正确渲染', /<h1 [^>]*>一级标题<\/h1>/.test(html) && /<h2 [^>]*>二级标题<\/h2>/.test(html) &&
    /<h3 [^>]*>三级标题<\/h3>/.test(html) && /<h4 [^>]*>四级标题<\/h4>/.test(html), html.replace(/\n/g, ' ').slice(0, 200));

  const p = api.renderManual('# T\n\n第一段第一行\n第一段第二行\n\n第二段\n', 'sysadmin').html;
  ck('连续文本行合并为一段', p.includes('<p>第一段第一行 第一段第二行</p>'), p.replace(/\n/g, ' '));
  ck('空行分段', (p.match(/<p>/g) || []).length === 2, '段落数=' + (p.match(/<p>/g) || []).length);

  const b = api.renderManual('# T\n\n这是**粗体**文本\n', 'sysadmin').html;
  ck('粗体渲染', b.includes('这是<strong>粗体</strong>文本'), b);

  const l = api.renderManual('# T\n\n- 项目一\n- 项目二\n- 项目三\n', 'sysadmin').html;
  ck('无序列表渲染', l.includes('<ul') && (l.match(/<li>/g) || []).length === 3, l.replace(/\n/g, ' '));
  ck('列表后正确闭合', l.includes('</ul>'));

  const t = api.renderManual('# T\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n', 'sysadmin').html;
  ck('表格渲染', t.includes('<table') && t.includes('<thead>') && t.includes('<tbody>'));
  ck('表头单元格数正确', (t.match(/<th>/g) || []).length === 2, 'th=' + (t.match(/<th>/g) || []).length);
  ck('数据行数正确', (t.match(/<tr>/g) || []).length === 3, 'tr=' + (t.match(/<tr>/g) || []).length);

  // 单元格数与表头不一致时不能错位
  const t2 = api.renderManual('# T\n\n| A | B | C |\n| --- | --- | --- |\n| 1 |\n', 'sysadmin').html;
  const tds = (t2.match(/<td>/g) || []).length;
  ck('缺列补空，不错位', tds === 3, 'td=' + tds);
}

console.log('\n[3] 角色裁剪与子章节继承');
{
  const md = [
    '# 手册',
    '',
    '## 公开章节',
    '',
    '所有人可见',
    '',
    '## 管理章节',
    '<!-- roles:sysadmin -->',
    '',
    '### 管理子节（应继承 sysadmin）',
    '',
    '继承内容',
    '',
    '## 门店章节',
    '<!-- roles:sysadmin,storeadmin -->',
    '',
    '### 门店子节A（继承）',
    '',
    'A 内容',
    '',
    '### 门店子节B（收窄）',
    '<!-- roles:sysadmin -->',
    '',
    'B 内容',
    '',
    '## 店员章节',
    '<!-- roles:capture,query -->',
    '',
    '店员内容'
  ].join('\n');

  const vis = (role) => api.renderManual(md, role).toc.map((t) => t.title);

  const sys = vis('sysadmin');
  ck('系统管理员可见公开+管理+门店（含收窄子节）',
    sys.includes('公开章节') && sys.includes('管理章节') && sys.includes('管理子节（应继承 sysadmin）') &&
    sys.includes('门店章节') && sys.includes('门店子节A（继承）') && sys.includes('门店子节B（收窄）'),
    sys.join(','));
  // 系统管理员是搭建与排障角色，对软件有完整访问权，可见全部章节——
  // 包括店员端操作文档（需要能指导门店使用与定位问题）。
  // 这同时避免手册作者在每处 roles 标记里都要补写 sysadmin，漏写就会出现
  // 「系统管理员反而比门店管理员看到的章节少」这类反直觉结果。
  ck('系统管理员可见店员章节（全量可见）', sys.includes('店员章节'), sys.join(','));
  ck('系统管理员可见全部 7 个章节（无任何裁剪）', sys.length === 7, '实际 ' + sys.length + '：' + sys.join(','));

  const sm = vis('storeadmin');
  ck('门店管理员可见门店章节及继承子节',
    sm.includes('公开章节') && sm.includes('门店章节') && sm.includes('门店子节A（继承）'), sm.join(','));
  ck('门店管理员看不到收窄为 sysadmin 的子节', !sm.includes('门店子节B（收窄）'), sm.join(','));
  ck('门店管理员看不到管理章节', !sm.includes('管理章节'), sm.join(','));
  ck('门店管理员看不到店员章节', !sm.includes('店员章节'), sm.join(','));

  const cap = vis('capture');
  ck('拍照账号可见公开与店员章节', cap.includes('公开章节') && cap.includes('店员章节'), cap.join(','));
  ck('拍照账号看不到管理/门店章节', !cap.includes('管理章节') && !cap.includes('门店章节'), cap.join(','));
  ck('拍照账号看不到收窄子节', !cap.includes('门店子节B（收窄）'), cap.join(','));

  const qry = vis('query');
  ck('查询账号可见店员章节', qry.includes('店员章节'), qry.join(','));

  // 裁剪必须真的移除内容，而不只是隐藏标题
  const capHtml = api.renderManual(md, 'capture').html;
  ck('被裁章节的正文不输出', !capHtml.includes('A 内容') && !capHtml.includes('B 内容') && !capHtml.includes('继承内容'),
    capHtml.slice(0, 200));

  // 未知角色：只能看无标记的公开章节（不放开为全部）
  const unknown = vis('hacker');
  ck('未知角色仅可见公开章节', unknown.length === 1 && unknown[0] === '公开章节', unknown.join(','));
  ck('角色为空时仅可见公开章节', vis('').length === 1);

  // roles 标记不紧跟标题时不应误关联到正文
  const loose = api.renderManual('# T\n\n## A\n\n正文\n\n<!-- roles:sysadmin -->\n\n## B\n\nB 内容\n', 'capture').toc.map((t) => t.title);
  ck('游离的 roles 标记不被误关联', loose.includes('A') && loose.includes('B'), loose.join(','));
}

console.log('\n[4] 目录与锚点 id');
{
  const md = '# 手册\n\n## 说明\n\na\n\n## 说明\n\nb\n\n### 子说明\n\nc\n\n#### 四级不入目录\n\nd\n';
  const { toc } = api.renderManual(md, 'sysadmin');
  ck('目录只收 h2/h3', toc.every((t) => t.level === 2 || t.level === 3) && !toc.some((t) => t.level === 4),
    JSON.stringify(toc));
  ck('h1 不入目录', !toc.some((t) => t.level === 1));
  ck('目录条数正确（2 个 h2 + 1 个 h3）', toc.length === 3, '实际 ' + toc.length);

  const { html } = api.renderManual(md, 'sysadmin');
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  ck('重复标题生成唯一 id', new Set(ids).size === ids.length, JSON.stringify(ids));
  ck('目录 id 都能在正文找到对应锚点',
    toc.every((t) => html.includes('id="' + t.id + '"')), JSON.stringify(toc.map((t) => t.id)));
  ck('id 为合法标识（无空格与标点）', ids.every((i) => /^[A-Za-z0-9\u4e00-\u9fa5_-]+$/.test(i)), JSON.stringify(ids));
}

console.log('\n[5] 边界与异常输入');
{
  ck('空文本不抛异常', api.renderManual('', 'sysadmin').html === '');
  ck('undefined 不抛异常', api.renderManual(undefined, 'sysadmin').html === '');
  ck('null 角色不抛异常', typeof api.renderManual('# T\n\n## A\n\nx\n', null).html === 'string');
  ck('只有正文没有标题也能渲染', api.renderManual('纯文本无标题\n', 'sysadmin').html.includes('纯文本无标题'));
  ck('CRLF 换行正常解析', api.renderManual('# T\r\n\r\n## A\r\n\r\n内容\r\n', 'sysadmin').toc.length === 1);
  ck('表格缺少分隔行时按段落处理', api.renderManual('# T\n\n| a | b |\n', 'sysadmin').html.includes('<p>'));
}

console.log('\n[6] 真实手册渲染');
{
  const manualPath = path.join(__dirname, '..', 'renderer', 'assets', 'manual.md');
  if (!fs.existsSync(manualPath)) {
    ck('同步产物存在', false, '未找到 ' + manualPath + '，请先执行 npm run sync-manual');
  } else {
    const text = fs.readFileSync(manualPath, 'utf8');
    ck('手册非空', text.length > 1000, '大小=' + text.length);

    for (const role of ['sysadmin', 'storeadmin', 'capture', 'query']) {
      const r = api.renderManual(text, role);
      ck(role + ' 渲染出内容', r.html.length > 2000, 'html=' + r.html.length);
      ck(role + ' 生成目录', r.toc.length > 5, 'toc=' + r.toc.length);
      // 残留未解析的 markdown 源码 = 渲染器有缺口
      const leftover = [];
      if (/<h2 [^>]*>[^<]*\*\*/.test(r.html)) leftover.push('标题中残留 **');
      if (/^\|/m.test(r.html)) leftover.push('残留表格竖线');
      if (/<!--\s*roles:/.test(r.html)) leftover.push('残留 roles 注释');
      if (/<p>- /.test(r.html)) leftover.push('残留未解析列表');
      ck(role + ' 无未解析的 markdown 残留', leftover.length === 0, leftover.join('；'));
      ck(role + ' 目录 id 唯一', new Set(r.toc.map((t) => t.id)).size === r.toc.length);
    }

    // 角色裁剪在真实手册上确实生效
    const sysToc = api.renderManual(text, 'sysadmin').toc.map((t) => t.title).join(',');
    const capToc = api.renderManual(text, 'capture').toc.map((t) => t.title).join(',');
    const smToc = api.renderManual(text, 'storeadmin').toc.map((t) => t.title).join(',');
    ck('系统管理员可见「用户与权限」', sysToc.includes('用户与权限'));
    ck('拍照账号看不到「用户与权限」', !capToc.includes('用户与权限'), capToc);
    ck('拍照账号看不到「系统设置」', !capToc.includes('系统设置'));
    ck('拍照账号可见「衣物拍照」', capToc.includes('衣物拍照'), capToc);
    ck('查询账号看不到「衣物拍照」', !api.renderManual(text, 'query').toc.map((t) => t.title).join(',').includes('衣物拍照'));
    ck('门店管理员可见「系统设置」以外，含「操作日志」', smToc.includes('操作日志') && !smToc.includes('系统设置'), smToc);
    ck('门店管理员看不到「用户与权限」', !smToc.includes('用户与权限'), smToc);
    // 系统管理员必须看到不少于任何角色的章节数（此前曾出现 sm > sys，
    // 原因是店员章节的 roles 标记未包含 sysadmin，现已在 sectionVisible 统一放行）
    const nSys = api.renderManual(text, 'sysadmin').toc.length;
    const nSm = api.renderManual(text, 'storeadmin').toc.length;
    const nCap = api.renderManual(text, 'capture').toc.length;
    const nQry = api.renderManual(text, 'query').toc.length;
    ck('系统管理员章节数不少于其他任何角色',
      nSys >= nSm && nSys >= nCap && nSys >= nQry,
      'sys=' + nSys + ' sm=' + nSm + ' cap=' + nCap + ' qry=' + nQry);
    ck('系统管理员可见范围最广（严格多于门店管理员）', nSys > nSm, 'sys=' + nSys + ' sm=' + nSm);
    ck('门店管理员可见范围多于拍照账号', nSm > nCap, 'sm=' + nSm + ' cap=' + nCap);

    // 表格渲染数量：手册含多张表，必须都渲染成 <table>
    const sysHtml = api.renderManual(text, 'sysadmin').html;
    const srcTables = (text.match(/^\|.*\|$/gm) || []).length;
    const outTables = (sysHtml.match(/<table/g) || []).length;
    ck('手册表格全部渲染为 table', outTables >= 4, '源表格行=' + srcTables + ' 渲染表格数=' + outTables);
  }
}

console.log('\n=== 结果 ===');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('失败项：');
  problems.forEach((p) => console.log('  - ' + p));
}
process.exit(fail ? 1 : 0);
