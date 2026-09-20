// 渲染层模板校验：node scripts/verify-templates.js
//
// 做两层检查：
//   1. 用 @vue/compiler-dom 真实编译每个组件模板，捕获模板语法错误；
//   2. 提取编译产物里的 _ctx.xxx 引用，与该组件 setup 的 return 键名 + props 声明比对，
//      找出「模板引用了但 setup 没返回」的标识符。
//
// 第 2 层很关键：模板字符串里引用未注册变量不会有语法错误，node --check 也查不出来，
// 只会在运行时静默渲染成空白（例如角色标签、按钮 v-if 条件失效）。
const fs = require('fs');
const path = require('path');

let compile;
try {
  compile = require('@vue/compiler-dom').compile;
} catch (e) {
  console.log('SKIP: @vue/compiler-dom 不可用');
  process.exit(0);
}

const SRC = path.join(__dirname, '..', 'renderer', 'renderer.js');
const src = fs.readFileSync(SRC, 'utf8');
const lines = src.split('\n');

let pass = 0;
let fail = 0;
const problems = [];
function ok(msg) {
  pass++;
  console.log('  ✓ ' + msg);
}
function bad(msg) {
  fail++;
  problems.push(msg);
  console.log('  ✗ ' + msg);
}

/** 模板中可直接使用、无需 setup 返回的标识符（Vue 实例属性） */
const INSTANCE_PROPS = new Set(['$emit', '$props', '$slots', '$attrs', '$el', '$refs', '$event', '$options', '$parent', '$root']);

/** 按反引号配对提取模板字面量；startIdx 为含 "template: `" 的行号 */
function extractTemplate(startIdx) {
  const btIdx = lines[startIdx].indexOf('`', lines[startIdx].indexOf('template:'));
  if (btIdx === -1) return null;
  let depth = 0;
  const out = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = i === startIdx ? lines[startIdx].slice(btIdx) : lines[i];
    let buf = '';
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '\\' && c + 1 < line.length) {
        buf += ch + line[c + 1];
        c++;
        continue;
      }
      if (ch === '`') {
        depth++;
        if (depth === 2) {
          out.push(buf);
          return out.join('\n');
        }
        continue;
      }
      buf += ch;
    }
    out.push(buf);
  }
  return null;
}

/** 从某位置的花括号开始，按配对提取对象字面量内部文本（不含最外层花括号） */
function extractBraceBody(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(openIdx + 1, i);
    }
  }
  return null;
}

/** 剥离行注释与块注释（保留字符串字面量内容） */
function stripComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    // 字符串：原样保留
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      while (i < text.length) {
        if (text[i] === '\\') {
          out += text[i] + (text[i + 1] || '');
          i += 2;
          continue;
        }
        out += text[i];
        if (text[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** 解析对象字面量内部文本的顶层键名（支持简写 a、映射 a: b） */
function parseKeys(inner) {
  const clean = stripComments(inner);
  const names = new Set();
  let buf = '';
  let depth = 0;
  const push = (raw) => {
    const entry = raw.trim();
    if (!entry) return;
    const mapped = entry.match(/^([A-Za-z_$][\w$]*)\s*:/);
    if (mapped) {
      names.add(mapped[1]);
      return;
    }
    const simple = entry.match(/^([A-Za-z_$][\w$]*)$/);
    if (simple) names.add(simple[1]);
  };
  for (const ch of clean) {
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  push(buf);
  return names;
}

// 组件定义：const XxxPage = { / const Shell = {
const components = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^const ([A-Z][A-Za-z0-9]*) = \{/);
  if (m) components.push({ name: m[1], start: i, end: lines.length });
}
for (let k = 0; k + 1 < components.length; k++) components[k].end = components[k + 1].start;

console.log('=== 渲染层模板校验 ===');
console.log('发现组件 ' + components.length + ' 个：' + components.map((c) => c.name).join(', '));
console.log('');

let compiled = 0;
let checkedVars = 0;
for (const comp of components) {
  // 定位 template 行
  let tIdx = -1;
  for (let i = comp.start; i < comp.end; i++) {
    if (/^\s*template:\s*`/.test(lines[i])) {
      tIdx = i;
      break;
    }
  }
  if (tIdx === -1) continue; // 无模板的逻辑组件

  const tplBody = extractTemplate(tIdx);
  if (tplBody === null) {
    bad(comp.name + '：模板字符串反引号未正确配对');
    continue;
  }

  // ---- 第 1 层：真实编译模板 ----
  let result;
  try {
    result = compile(tplBody, { mode: 'function', prefixIdentifiers: true, whitespace: 'condense' });
    compiled++;
  } catch (e) {
    bad(comp.name + '：模板编译失败 -> ' + e.message);
    continue;
  }

  // ---- 第 2 层：核对模板引用的变量是否都已注册 ----
  const used = new Set();
  const addRefs = (re) => {
    let mm;
    while ((mm = re.exec(result.code)) !== null) used.add(mm[1]);
  };
  addRefs(/_ctx\.([A-Za-z_$][\w$]*)/g);
  addRefs(/\$setup\.([A-Za-z_$][\w$]*)/g);

  if (!used.size) {
    ok(comp.name + '：模板编译通过（无外部变量引用）');
    continue;
  }

  const seg = lines.slice(comp.start, tIdx).join('\n');

  // setup 返回的键名：取 template 之前最后一个 return { ... }
  let retKeys = null;
  const retIdx = seg.lastIndexOf('return {');
  if (retIdx !== -1) {
    const inner = extractBraceBody(seg, retIdx + 'return '.length);
    if (inner !== null) retKeys = parseKeys(inner);
  }

  // props 声明的名字也可在模板中直接使用
  let propsNames = new Set();
  const pIdx = seg.indexOf('props:');
  if (pIdx !== -1) {
    const brace = seg.indexOf('{', pIdx);
    if (brace !== -1) {
      const inner = extractBraceBody(seg, brace);
      if (inner !== null) propsNames = parseKeys(inner);
    }
  }

  if (retKeys === null) {
    ok(comp.name + '：模板编译通过（未解析到 setup return，跳过变量核对）');
    continue;
  }

  const missing = [...used].filter((n) => !retKeys.has(n) && !propsNames.has(n) && !INSTANCE_PROPS.has(n)).sort();
  checkedVars += used.size;
  if (missing.length) {
    bad(comp.name + '：模板引用了 setup 未返回的变量 -> ' + missing.join(', '));
  } else {
    ok(comp.name + '：模板编译通过，' + used.size + ' 个引用均已注册');
  }
}

console.log('');
console.log('成功编译模板 ' + compiled + ' 个，核对模板变量引用 ' + checkedVars + ' 处');
console.log('结果：' + pass + ' 通过，' + fail + ' 失败');
if (fail) {
  console.log('问题清单：');
  problems.forEach((p) => console.log('  - ' + p));
}
process.exit(fail ? 1 : 0);
