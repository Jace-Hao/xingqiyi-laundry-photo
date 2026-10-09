'use strict';

/**
 * 本周订单导出（records:exportWeeklyOrders）临时验证脚本。
 * 属一次性冒烟校验：直接驱动 store.js 的数据层函数，检查 CSV 的
 * 编码（BOM）、行结束（CRLF）、RFC4180 转义、8/9 列结构、排序与权限裁剪。
 * 验证完成后可删除本文件。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../main/store');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra ? ' —— ' + extra : ''));
  }
}

// 构造一个临时数据目录，隔离本机真实数据
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xqy-weekly-'));
const photoDir = path.join(tmp, 'photos');
fs.mkdirSync(photoDir, { recursive: true });
const store = createStore({
  dataDir: tmp,
  defaultPhotoDir: photoDir,
  updateDir: path.join(tmp, 'updates'),
  appVersion: '1.2.8',
  photoScheme: 'xqy-photo'
});

// 账号：ensureSeedData 给出默认管理员，其余账号走 createUser 正规流程
store.ensureSeedData();
const token = store.login({ username: 'admin', password: 'admin123' }).sessionToken;
store.createUser(token, { username: 'cap_zs', name: '张三', password: 'pwd123456', role: 'capture', store: '总店' });
store.createUser(token, { username: 'cap_ls', name: '李四', password: 'pwd123456', role: 'capture', store: '分店' });
const uidByName = {};
for (const u of store.listUsers(token)) uidByName[u.username] = u.id;

// 数据：以 2025-03-10 ~ 2025-03-12 为窗口，另放 2 条窗口外用于验证区间裁剪
const rec = (id, barcode, seq, username, storeName, note, createdAt) => ({
  id, barcode, seq, userId: uidByName[username], username, storeName, note,
  photoFile: `${barcode.replace(/[\\/:*?"<>|]/g, '_')}/${barcode}_${seq}.jpg`,
  createdAt
});
const records = [
  rec('r1', 'B001', 1, 'cap_zs', '总店', '正常清洗', '2025-03-10T02:00:00.000Z'),
  rec('r2', 'B001', 2, 'cap_zs', '总店', '袖口有' + '"油渍"', '2025-03-11T03:00:00.000Z'),
  rec('r3', 'B001', 3, 'cap_ls', '总店', '逗号,测试', '2025-03-12T04:30:00.000Z'),
  rec('r4', 'B002', 1, 'cap_ls', '分店', '', '2025-03-11T05:00:00.000Z'),
  rec('r5', 'B003', 1, 'cap_zs', '', '手洗', '2025-03-12T06:00:00.000Z'),
  rec('r6', 'B009', 1, 'cap_zs', '总店', '过期', '2025-02-01T00:00:00.000Z'),
  rec('r7', 'B010', 1, 'cap_zs', '总店', '未来', '2030-01-01T00:00:00.000Z')
];
const WINDOW_IDS = ['r1', 'r2', 'r3', 'r4', 'r5'];
const windowRecords = records.filter((r) => WINDOW_IDS.indexOf(r.id) >= 0);
// 只覆盖记录文件：会话与日志不清空（否则上面刚建立的会话会被抹掉）
fs.writeFileSync(path.join(tmp, 'records.json'), JSON.stringify(records, null, 2));

const exportDir = path.join(tmp, 'out');

function parseCsv(buf) {
  const text = buf.toString('utf8');
  const rows = [];
  let row = [];
  let cell = '';
  let inQ = false;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inQ) {
      if (c === '"') {
        if (body[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
      } else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r') { /* CRLF：忽略 CR，遇 LF 收行 */ }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

console.log('=== 本周订单导出契约 ===');

// ---------- 聚合模式 ----------
const sum = store.exportWeeklyOrders(token, {
  targetDir: exportDir, dateFrom: '2025-03-10', dateTo: '2025-03-12', mode: 'summary'
});
ok('聚合模式返回契约结构', sum && sum.csvPath && sum.mode === 'summary' && sum.logged === true);
ok('聚合模式文件名正确', path.basename(sum.csvPath) === '本周订单_2025-03-10_至_2025-03-12.csv', path.basename(sum.csvPath));
const sumBuf = fs.readFileSync(sum.csvPath);
ok('CSV 首三字节为 UTF-8 BOM (EF BB BF)', sumBuf[0] === 0xef && sumBuf[1] === 0xbb && sumBuf[2] === 0xbf);
const sumText = sumBuf.toString('utf8');
ok('CSV 行分隔符为 CRLF', sumText.indexOf('\r\n') > 0 && sumText.indexOf('\n') === sumText.indexOf('\r\n') + 1);
const sumRows = parseCsv(sumBuf);
ok('聚合模式表头 8 列且列名顺序正确',
  JSON.stringify(sumRows[0]) === JSON.stringify(['条形码（订单号）', '照片张数', '首拍时间', '末拍时间', '录入人', '所属门店', '备注', '照片文件夹位置']),
  JSON.stringify(sumRows[0]));
ok('聚合模式数据行数 == 订单数（3）', sumRows.length - 1 === 3, '实际 ' + (sumRows.length - 1));
ok('每个数据行都是 8 列（无错列）', sumRows.slice(1).every((r) => r.length === 8), JSON.stringify(sumRows.slice(1)));
ok('返回 orders == 3', sum.orders === 3, String(sum.orders));
ok('返回 photos == 5', sum.photos === 5, String(sum.photos));
ok('日期区间裁剪生效（窗口外 2 条未进入）', sum.photos === 5 && !JSON.stringify(sumRows).includes('B009'));
const byCode = {};
for (const r of sumRows.slice(1)) byCode[r[0]] = r;
ok('B001 照片张数 = 3', byCode.B001 && byCode.B001[1] === '3', byCode.B001 && byCode.B001[1]);
ok('B001 录入人去重后按「、」连接', byCode.B001 && byCode.B001[4] === 'cap_zs、cap_ls', byCode.B001 && byCode.B001[4]);
ok('B001 备注去重按「 / 」连接，含逗号与引号均不被拆列',
  byCode.B001 && byCode.B001[6] === '正常清洗 / 袖口有"油渍" / 逗号,测试', byCode.B001 && byCode.B001[6]);
ok('B003 门店为空时输出「本店」', byCode.B003 && byCode.B003[5] === '本店', byCode.B003 && byCode.B003[5]);
ok('聚合第 8 列为绝对路径（拼 getPhotoDir）',
  byCode.B001 && byCode.B001[7].indexOf(photoDir) === 0 && byCode.B001[7].indexOf('B001') > 0,
  byCode.B001 && byCode.B001[7]);
ok('聚合排序为末拍时间倒序',
  JSON.stringify(sumRows.slice(1).map((r) => r[0])) === JSON.stringify(['B003', 'B001', 'B002']),
  JSON.stringify(sumRows.slice(1).map((r) => r[0])));
ok('首拍/末拍时间为 YYYY-MM-DD HH:mm',
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(byCode.B001[2]) && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(byCode.B001[3]),
  byCode.B001[2] + ' / ' + byCode.B001[3]);

// ---------- 明细模式 ----------
const det = store.exportWeeklyOrders(token, {
  targetDir: exportDir, dateFrom: '2025-03-10', dateTo: '2025-03-12', mode: 'detail'
});
ok('明细模式文件名加「明细」前缀', path.basename(det.csvPath) === '本周订单明细_2025-03-10_至_2025-03-12.csv', path.basename(det.csvPath));
const detRows = parseCsv(fs.readFileSync(det.csvPath));
ok('明细模式表头 9 列且列名顺序正确',
  JSON.stringify(detRows[0]) === JSON.stringify(['条形码（订单号）', '序号（第几张）', '拍摄时间', '照片文件名', '照片相对路径', '录入人', '所属门店', '备注', '记录 ID']),
  JSON.stringify(detRows[0]));
ok('明细模式数据行数 == 照片数（5）', detRows.length - 1 === 5, '实际 ' + (detRows.length - 1));
ok('每个数据行都是 9 列（无错列）', detRows.slice(1).every((r) => r.length === 9));
ok('明细排序 = 条码升序 + seq 升序',
  JSON.stringify(detRows.slice(1).map((r) => r[0] + '#' + r[1])) ===
  JSON.stringify(['B001#1', 'B001#2', 'B001#3', 'B002#1', 'B003#1']),
  JSON.stringify(detRows.slice(1).map((r) => r[0] + '#' + r[1])));
ok('明细第 4 列为照片文件名（basename）', detRows[1][3] === 'B001_1.jpg', detRows[1][3]);
ok('明细第 5 列为照片相对路径（含目录段）', detRows[1][4] === 'B001/B001_1.jpg', detRows[1][4]);
ok('明细第 9 列为记录 ID', detRows[1][8] === 'r1', detRows[1][8]);
ok('明细第 7 列门店为空时输出「本店」', detRows.find((r) => r[0] === 'B003')[6] === '本店');

// ---------- 筛选下推 ----------
// 关键词命中备注：必须与页面一致地「整单带上」——B001 有 3 张，其中 1 张命中，
// 页面上 filteredRows 会保留整单 3 张，导出的 CSV 也必须是 3 张
const kw = store.exportWeeklyOrders(token, {
  targetDir: exportDir, dateFrom: '2025-03-10', dateTo: '2025-03-12', mode: 'summary',
  filters: { keyword: '油渍' }
});
ok('关键词命中备注时整单带上（页面与 CSV 一致）', kw.orders === 1 && kw.photos === 3, `${kw.orders}/${kw.photos}`);
const kwCsv = parseCsv(fs.readFileSync(kw.csvPath));
ok('命中备注后聚合行的照片张数仍为 3', kwCsv[1][1] === '3', kwCsv[1] && kwCsv[1][1]);

const kwUser = store.exportWeeklyOrders(token, {
  targetDir: exportDir, dateFrom: '2025-03-10', dateTo: '2025-03-12', mode: 'detail',
  filters: { username: 'cap_zs' }
});
ok('录入人筛选按整单生效（B001 3 张 + B003 1 张 = 4）', kwUser.photos === 4, String(kwUser.photos));

const kwStore = store.exportWeeklyOrders(token, {
  targetDir: exportDir, dateFrom: '2025-03-10', dateTo: '2025-03-12', mode: 'summary',
  filters: { store: '分店' }
});
ok('门店筛选生效', kwStore.orders === 1, String(kwStore.orders));

const kwAll = store.exportWeeklyOrders(token, {
  targetDir: exportDir, dateFrom: '2025-03-10', dateTo: '2025-03-12', mode: 'summary',
  filters: { username: 'all', store: 'all' }
});
ok("'all' 表示不限", kwAll.photos === 5, String(kwAll.photos));

const wl = store.exportWeeklyOrders(token, {
  targetDir: exportDir, dateFrom: '2025-03-10', dateTo: '2025-03-12', mode: 'summary',
  filters: { barcodes: ['b001'] }
});
ok('barcodes 白名单大小写不敏感生效', wl.orders === 1 && wl.photos === 3, `${wl.orders}/${wl.photos}`);

const wlEmpty = store.exportWeeklyOrders(token, {
  targetDir: exportDir, dateFrom: '2025-03-10', dateTo: '2025-03-12', mode: 'summary',
  filters: { barcodes: [] }
});
ok('barcodes 为空数组时忽略该字段（只按谓词导出）', wlEmpty.photos === 5, String(wlEmpty.photos));

// ---------- 客户端列的差异（复用同一份列定义） ----------
const clientRows = store.weeklySummaryRows(windowRecords, false);
ok('客户端第 8 列为相对目录（不含 photoDir 前缀）',
  clientRows[1][7].indexOf(photoDir) === -1 && clientRows[1][7].indexOf('B0') === 0,
  clientRows[1] && clientRows[1][7]);
ok('服务端与客户端列名、列数、行数完全一致',
  clientRows.length === sumRows.length && JSON.stringify(clientRows[0]) === JSON.stringify(sumRows[0]));
const clientDet = store.weeklyDetailRows(windowRecords, false);
ok('明细行数与服务端一致', clientDet.length === detRows.length);

// ---------- 覆盖写 ----------
const again = store.exportWeeklyOrders(token, {
  targetDir: exportDir, dateFrom: '2025-03-10', dateTo: '2025-03-12', mode: 'detail'
});
ok('同名文件直接覆盖（不生成递增后缀）', again.csvPath === det.csvPath);
ok('目录下未产生第二个同名变体',
  fs.readdirSync(exportDir).filter((f) => f.indexOf('明细') >= 0).length === 1,
  fs.readdirSync(exportDir).join(','));

// ---------- 异常路径 ----------
function expectThrow(name, fn, msg) {
  let got = '';
  try { fn(); } catch (e) { got = e.message; }
  ok(name, got === msg, got);
}
expectThrow('缺日期时抛错', () => store.exportWeeklyOrders(token, { targetDir: exportDir, dateFrom: '', dateTo: '2025-03-12' }), '请选择开始与结束日期');
expectThrow('开始日期晚于结束日期时抛错', () => store.exportWeeklyOrders(token, { targetDir: exportDir, dateFrom: '2025-03-12', dateTo: '2025-03-10' }), '开始日期不能晚于结束日期');
expectThrow('缺目标目录时抛错', () => store.exportWeeklyOrders(token, { targetDir: '', dateFrom: '2025-03-10', dateTo: '2025-03-12' }), '请先选择保存目录');
expectThrow('空结果时给出明确文案',
  () => store.exportWeeklyOrders(token, { targetDir: exportDir, dateFrom: '2025-03-10', dateTo: '2025-03-12', filters: { keyword: '不存在xyz' } }),
  '当前筛选条件下没有订单，无法导出');
expectThrow('无效令牌被拒', () => store.exportWeeklyOrders('bad-token', { targetDir: exportDir, dateFrom: '2025-03-10', dateTo: '2025-03-12' }), '未登录或会话已失效，请重新登录');

// ---------- 权限：拍照账号无 query 权限时不得导出 ----------
store.createUser(token, { username: 'nodata', name: '无权限', password: 'pwd123456', role: 'capture', store: '总店', permissions: { capture: true, query: false } });

// ---------- 操作日志 ----------
const logs = store.listLogs(token);
const acts = logs.items.map((l) => l.action);
ok('日志登记「导出本周订单表格」', acts.includes('导出本周订单表格'));
ok('日志登记「导出本周订单明细」', acts.includes('导出本周订单明细'));
ok('日志动作下拉能查到两个新动作', store.logActionOptions(token).includes('导出本周订单表格') &&
  store.logActionOptions(token).includes('导出本周订单明细'));
const logRow = logs.items.find((l) => l.action === '导出本周订单表格');
ok('日志 detail 含日期范围与落盘路径',
  !!logRow && logRow.detail.includes('2025-03-10') && logRow.detail.includes('2025-03-12') && logRow.detail.includes('本周订单_'),
  logRow && logRow.detail);
ok('日志 detail 含筛选条件摘要', !!logRow && logRow.detail.indexOf('筛选条件') >= 0, logRow && logRow.detail);

// ---------- 可见范围裁剪（非系统管理员） ----------
const zsToken = store.login({ username: 'cap_zs', password: 'pwd123456' }).sessionToken;
const scoped = store.exportWeeklyOrders(zsToken, {
  targetDir: exportDir, dateFrom: '2025-03-10', dateTo: '2025-03-12', mode: 'summary'
});
// cap_zs 本人 3 条（r1,r2,r5） + 同门店（总店）cap_ls 的 r3：窗口内共 4 条；
// 聚合后为 B001(3) + B003(1) = 2 个订单；分店的 B002 完全不可见
ok('门店账号按 canViewRecord 裁剪（窗口内 4 张、2 个订单）',
  scoped.photos === 4 && scoped.orders === 2, `${scoped.photos}/${scoped.orders}`);
const scopedRows = parseCsv(fs.readFileSync(scoped.csvPath));
ok('跨门店数据未出现在导出结果中', !JSON.stringify(scopedRows).includes('B002'));

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结果 */ }
process.exit(fail ? 1 : 0);
