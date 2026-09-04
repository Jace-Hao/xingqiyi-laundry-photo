/**
 * 将 node_modules 中的 Vue 全局构建版本复制到渲染进程资源目录，
 * 使 Electron 离线环境下无需构建工具即可使用 Vue。
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'vue', 'dist', 'vue.global.prod.js');
const dest = path.join(__dirname, '..', 'renderer', 'assets', 'vue.global.prod.js');

if (!fs.existsSync(src)) {
  console.error('[copy-vue] 未找到 Vue 构建文件，请先执行 npm install');
  process.exit(1);
}

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
console.log('[copy-vue] Vue 已复制到 renderer/assets/vue.global.prod.js');
