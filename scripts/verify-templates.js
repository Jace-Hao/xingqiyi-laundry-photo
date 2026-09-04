// 用 Vue 编译器校验渲染层全部模板语法：node scripts/verify-templates.js
const fs = require('fs');
const path = require('path');

let compile;
try {
  compile = require('@vue/compiler-dom').compile;
} catch (e) {
  console.log('SKIP: @vue/compiler-dom 不可用');
  process.exit(0);
}

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const templates = [];
const re = /template:\s*`([\s\S]*?)`\s*\n/g;
let m;
while ((m = re.exec(src)) !== null) templates.push(m[1]);

console.log('共找到 ' + templates.length + ' 个模板');
let failed = 0;
templates.forEach((t, i) => {
  try {
    compile(t, { whitespace: 'condense' });
    console.log('  ✓ 模板 ' + (i + 1));
  } catch (e) {
    failed++;
    console.log('  ✗ 模板 ' + (i + 1) + ' 错误：' + e.message);
  }
});
console.log(failed ? '存在模板错误' : '全部模板编译通过');
process.exit(failed ? 1 : 0);
