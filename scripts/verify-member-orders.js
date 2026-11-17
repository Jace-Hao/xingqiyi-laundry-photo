'use strict';
/* =============================================================================
 * verify-member-orders.js —— 会员导出软件订单导入专项验证
 *
 * 覆盖三层：
 *   A 组：解析器纯函数（CSV/JSON 解析、字段别名映射、金额/时间规范化、商品拆分）
 *   B 组：数据层（导入落库、字段映射到订单模型、缺失字段、格式异常、重复订单、权限裁剪）
 *   C 组：变异负向对照（把同一组断言复跑在变异实现上，确认断言真的有判别力）
 *
 * 运行：node scripts/verify-member-orders.js
 * ========================================================================== */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createStore } = require('../main/store');
const parser = require('../main/member-order-parser');

let pass = 0;
let fail = 0;
const fails = [];
function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; fails.push(name); }
}

function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok);
  if (!ok) {
    console.log('    期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}

// ---------------------------------------------------------------- 测试数据
const CSV_HEADER = '订单号,会员姓名,会员手机,商品名称,订单金额,下单时间,订单状态';
const CSV_BODY =
  'XY-2026-00123,张女士,13800001111,"羽绒服,皮靴",128.50,2026-11-01 14:32,待取\n' +
  'XY-2026-00124,李先生,13900002222,西服,88,2026/11/02 09:00,已取';

function freshStore() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xqy-mo-test-'));
  const store = createStore({
    dataDir: path.join(tmpDir, 'data'),
    defaultPhotoDir: path.join(tmpDir, 'photos'),
    updateDir: path.join(tmpDir, 'updates'),
    appVersion: '0.1.0',
    photoScheme: 'xqy-photo'
  });
  store.ensureSeedData();
  return store;
}

// ================================================================= A 组：解析器
console.log('== A 组：解析器纯函数 ==');

check('A1 CSV 带表头：解析出 2 条有效订单', (() => {
  const r = parser.parseMemberOrders(CSV_HEADER + '\n' + CSV_BODY);
  return r.ok === true && r.stats.valid === 2 && r.stats.invalid === 0;
})());

check('A2 字段映射：订单号→barcode / 会员→customer / 金额→amount / 状态→status', (() => {
  const r = parser.parseMemberOrders(CSV_HEADER + '\n' + CSV_BODY);
  const o = r.orders[0];
  return o.barcode === 'XY-2026-00123' &&
    o.customer === '张女士' &&
    o.phone === '13800001111' &&
    o.amount === 128.5 &&
    o.status === '待取';
})());

check('A3 商品明细：带逗号的引号字段被正确拆分为两项', (() => {
  const r = parser.parseMemberOrders(CSV_HEADER + '\n' + CSV_BODY);
  return JSON.stringify(r.orders[0].items) === JSON.stringify(['羽绒服', '皮靴']);
})());

check('A4 时间规范化：本地时间转 UTC ISO', (() => {
  const r = parser.parseMemberOrders(CSV_HEADER + '\n' + CSV_BODY);
  // 2026-11-01 14:32 本地（Asia/Shanghai, +8）→ 06:32Z
  return r.orders[0].createdAt === '2026-11-01T06:32:00.000Z';
})());

check('A5 无表头时按内容特征推断列位（标记 inferred）', (() => {
  const r = parser.parseMemberOrders('XY-003,王女士,13700003333,大衣,¥260.00,2026-11-03 10:00,待取');
  const o = r.orders[0];
  return o.inferred === true &&
    o.orderNo === 'XY-003' &&
    o.customer === '王女士' &&
    o.phone === '13700003333' &&
    o.items[0] === '大衣' &&
    o.amount === 260 &&
    o.status === '待取';
})());

check('A6 缺失订单号：该行判为无效并记 issue', (() => {
  const r = parser.parseMemberOrders('订单号,会员姓名,金额\n,张女士,10');
  return r.stats.valid === 0 && r.stats.invalid === 1 &&
    r.issues.some((i) => i.field === 'orderNo');
})());

check('A7 金额格式异常：置 null（不填 0 冒充有效金额）并记 issue', (() => {
  const r = parser.parseMemberOrders('订单号,金额\nXY-1,abc');
  return r.orders[0].amount === null &&
    r.issues.some((i) => i.field === 'amount');
})());

check('A8 时间格式异常：置 null 并记 issue', (() => {
  const r = parser.parseMemberOrders('订单号,下单时间\nXY-1,不是时间');
  return r.orders[0].createdAt === null &&
    r.issues.some((i) => i.field === 'createdAt');
})());

check('A9 会员信息缺失：记 issue 但不丢弃整行', (() => {
  const r = parser.parseMemberOrders('订单号,会员姓名,金额\nXY-1,,10');
  return r.stats.valid === 1 &&
    r.orders[0].customer === '' &&
    r.issues.some((i) => i.field === 'customer');
})());

check('A10 文件内重复订单号：保留首条，其余计为 duplicate', (() => {
  const r = parser.parseMemberOrders('订单号,金额\nXY-1,10\nxy-1,20\nXY-2,30');
  return r.stats.valid === 2 && r.stats.duplicates === 1 &&
    r.orders[0].amount === 10;
})());

check('A11 CSV 转义：字段内双引号与逗号不破坏列位', (() => {
  const csv = '订单号,商品,金额\nXY-1,"皮""靴, 羽绒服",10';
  const r = parser.parseMemberOrders(csv);
  return r.orders.length === 1 && r.orders[0].amount === 10 &&
    r.orders[0].items.length === 2;
})());

check('A12 CSV 解析：BOM 不污染首个表头', (() => {
  const r = parser.parseMemberOrders('﻿' + CSV_HEADER + '\n' + CSV_BODY);
  return r.stats.valid === 2 && r.orders[0].orderNo === 'XY-2026-00123';
})());

check('A13 JSON 数组：字段名按别名匹配', (() => {
  const r = parser.parseMemberOrders(JSON.stringify([
    { 订单号: 'XY-J1', 会员: '赵女士', 金额: '￥99.9', 时间: '20261101120000' }
  ]));
  return r.ok === true && r.orders[0].orderNo === 'XY-J1' &&
    r.orders[0].customer === '赵女士' && r.orders[0].amount === 99.9 &&
    r.orders[0].createdAt === '2026-11-01T04:00:00.000Z';
})());

check('A14 JSON 包装对象：data/list/orders/records 任一均可', (() => {
  const r = parser.parseMemberOrders(JSON.stringify({ data: [{ 订单号: 'XY-J2', 金额: 5 }] }));
  return r.ok === true && r.orders.length === 1 && r.orders[0].orderNo === 'XY-J2';
})());

check('A15 JSON 非法：返回可读错误而不是抛异常', (() => {
  const r = parser.parseMemberOrders('{ 这不是 json');
  return r.ok === false && r.issues.length > 0;
})());

check('A16 未识别列保留到 extra（不丢数据）', (() => {
  const r = parser.parseMemberOrders('订单号,金额,会员备注\nXY-1,10,加急');
  return r.orders[0].extra['会员备注'] === '加急';
})());

check('A17 金额解析：千分位/货币符号/会计负数', (() => {
  return parser.parseAmount('¥1,234.50') === 1234.5 &&
    parser.parseAmount('(88)') === -88 &&
    parser.parseAmount('-20') === -20 &&
    parser.parseAmount('') === null &&
    parser.parseAmount('abc') === null;
})());

check('A18 时间解析：多种写法均可识别', (() => {
  return parser.parseDateTime('2026-11-01') !== null &&
    parser.parseDateTime('20261101') !== null &&
    parser.parseDateTime('20261101143000') !== null &&
    parser.parseDateTime('2026/11/01 14:30') !== null &&
    parser.parseDateTime('乱码') === null;
})());

check('A19 商品拆分：数量后缀与多种分隔符', (() => {
  return JSON.stringify(parser.parseItems('羽绒服 x2,皮靴')) === JSON.stringify(['羽绒服', '皮靴']) &&
    JSON.stringify(parser.parseItems('["A","B"]')) === JSON.stringify(['A', 'B']);
})());

check('A20 空文件：返回空结果而非抛异常', (() => {
  const r = parser.parseMemberOrders('');
  return r.ok === false && r.orders.length === 0 && r.stats.total === 0;
})());

check('A21 splitDuplicates：与库内已有订单比对分出重复/新增', (() => {
  const d = parser.splitDuplicates(
    [{ orderNo: 'XY-1' }, { orderNo: 'XY-2' }],
    [{ orderNo: 'xy-1' }]
  );
  return d.duplicateOrders.length === 1 && d.duplicateOrders[0].orderNo === 'XY-1' &&
    d.uniqueOrders.length === 1 && d.uniqueOrders[0].orderNo === 'XY-2';
})());

check('A22 订单号超长：截断到 64 位并记 issue', (() => {
  const long = 'X'.repeat(80);
  const r = parser.parseMemberOrders('订单号\n' + long);
  return r.orders[0].barcode.length === 64 &&
    r.issues.some((i) => i.field === 'orderNo' && i.message.includes('截断'));
})());

// ================================================================= B 组：数据层
console.log('== B 组：数据层 ==');

const store = freshStore();
const adminToken = store.login({ username: 'admin', password: 'admin123' }).sessionToken;

let importResult = null;
check('B1 导入会员订单：2 条落库', (() => {
  importResult = store.importMemberOrders(adminToken, {
    content: CSV_HEADER + '\n' + CSV_BODY,
    fileName: 'member.csv'
  });
  return importResult.imported === 2 && importResult.skipped === 0 && importResult.invalid === 0;
})());

check('B2 订单模型映射：条码/会员/金额/时间/状态全部落到会员订单记录', (() => {
  const list = store.listMemberOrders(adminToken, { silent: true });
  const o = list.items.find((x) => x.orderNo === 'XY-2026-00123');
  return !!o &&
    o.barcode === 'XY-2026-00123' &&
    o.customer === '张女士' &&
    o.phone === '13800001111' &&
    o.amount === 128.5 &&
    o.status === '待取' &&
    o.items[0] === '羽绒服' &&
    !!o.createdAt &&
    o.source === '会员导出软件' &&
    o.sourceFile === 'member.csv';
})());

check('B3 会员订单独立存储，不污染照片存档 records', (() => {
  // 照片存档列表不应出现会员订单；且 records 数量仍为 0
  const photos = store.listRecords(adminToken, { silent: true });
  return photos.total === 0;
})());

check('B4 重复导入：同订单号被跳过且不覆盖原记录', (() => {
  const again = store.importMemberOrders(adminToken, {
    content: CSV_HEADER + '\n' + CSV_BODY,
    fileName: 'member.csv'
  });
  const list = store.listMemberOrders(adminToken, { silent: true });
  const o = list.items.find((x) => x.orderNo === 'XY-2026-00123');
  return again.imported === 0 && again.skipped === 2 && again.duplicated === 2 &&
    list.total === 2 && o.amount === 128.5;
})());

check('B5 重复订单大小写不敏感', (() => {
  const r = store.importMemberOrders(adminToken, {
    content: '订单号,金额\nxy-2026-00123,999',
    fileName: 'm2.csv'
  });
  return r.imported === 0 && r.skipped === 1;
})());

check('B6 预览：可算���与库内重复的条数（导入前即可知）', (() => {
  const p = store.previewMemberOrders(adminToken, {
    content: CSV_HEADER + '\n' + CSV_BODY,
    fileName: 'member.csv'
  });
  return p.stats.valid === 2 && p.dbDuplicate === 2 && p.orders.length === 2;
})());

check('B7 预览不落库', (() => {
  const before = store.listMemberOrders(adminToken, { silent: true }).total;
  store.previewMemberOrders(adminToken, {
    content: '订单号,金额\nXY-NEW-1,10',
    fileName: 'n.csv'
  });
  const after = store.listMemberOrders(adminToken, { silent: true }).total;
  return before === after;
})());

check('B8 缺失字段入库：金额/时间/会员留空但记录仍建立', (() => {
  const r = store.importMemberOrders(adminToken, {
    content: '订单号,会员姓名,订单金额,下单时间\nXY-MISS-1,,abc,不是时间',
    fileName: 'miss.csv'
  });
  const list = store.listMemberOrders(adminToken, { silent: true });
  const o = list.items.find((x) => x.orderNo === 'XY-MISS-1');
  return r.imported === 1 && !!o &&
    o.amount === null &&
    o.customer === '' &&
    !!o.createdAt;   // 时间缺失时以导入时刻兜底，保证可排序
})());

check('B9 异常订单（无订单号）不入库', (() => {
  const r = store.importMemberOrders(adminToken, {
    content: '订单号,金额\n,10',
    fileName: 'bad.csv'
  });
  return r.imported === 0 && r.invalid === 1;
})());

check('B10 关键词检索覆盖订单号/会员/商品/状态', (() => {
  const a = store.listMemberOrders(adminToken, { keyword: '张女士', silent: true });
  const b = store.listMemberOrders(adminToken, { keyword: '皮靴', silent: true });
  const c = store.listMemberOrders(adminToken, { keyword: '已取', silent: true });
  return a.total >= 1 && b.total >= 1 && c.total >= 1;
})());

check('B11 操作日志记录了导入动作', (() => {
  const logs = store.listLogs(adminToken, { silent: true });
  return logs.items.some((l) => l.action === '导入会员订单');
})());

// 权限隔离
let clerkToken = '';
let clerk = null;
check('B12 查询账号不能导入（无「衣物拍照」权限）', (() => {
  clerk = store.createUser(adminToken, {
    username: 'mo_clerk', name: '李婷', role: 'query', password: 'pw123456', store: '南京西路旗舰店'
  });
  clerkToken = store.login({ username: 'mo_clerk', password: 'pw123456' }).sessionToken;
  let threw = '';
  try {
    store.importMemberOrders(clerkToken, { content: CSV_HEADER + '\n' + CSV_BODY, fileName: 'x.csv' });
  } catch (e) {
    threw = e.message || String(e);
  }
  return threw.includes('无权限');
})());

check('B13 查询账号可查询会员订单（只读）', (() => {
  const r = store.listMemberOrders(clerkToken, { silent: true });
  return r.ok === undefined && r.total >= 0;
})());

check('B14 门店隔离：非系统管理员看不到其它门店的会员订单', (() => {
  const store2 = freshStore();
  const t2 = store2.login({ username: 'admin', password: 'admin123' }).sessionToken;
  // 管理员无门店 → 导入的订单门店为空
  store2.importMemberOrders(t2, {
    content: '订单号,会员姓名\nXY-S1,张女士',
    fileName: 'a.csv'
  });
  store2.createUser(t2, {
    username: 'mo_other', name: '王强', role: 'capture', password: 'pw123456', store: '南京西路旗舰店'
  });
  const otherToken = store2.login({ username: 'mo_other', password: 'pw123456' }).sessionToken;
  // 对方门店订单：管理员先切到有门店的账号导入
  store2.importMemberOrders(otherToken, {
    content: '订单号,会员姓名\nXY-S2,李先生',
    fileName: 'b.csv'
  });
  const otherSees = store2.listMemberOrders(otherToken, { silent: true });
  const adminSees = store2.listMemberOrders(t2, { silent: true });
  // 管理员可见全部；门店账号只看到本店
  return adminSees.total === 2 && otherSees.total === 1 &&
    otherSees.items[0].orderNo === 'XY-S2';
})());

check('B15 删除会员订单：仅本人或管理员可删', (() => {
  const store3 = freshStore();
  const t3 = store3.login({ username: 'admin', password: 'admin123' }).sessionToken;
  store3.createUser(t3, {
    username: 'mo_cap', name: '王强', role: 'capture', password: 'pw123456', store: '南京西路旗舰店'
  });
  const capToken = store3.login({ username: 'mo_cap', password: 'pw123456' }).sessionToken;
  store3.importMemberOrders(capToken, { content: '订单号,金额\nXY-D1,10', fileName: 'a.csv' });
  const list = store3.listMemberOrders(capToken, { silent: true });
  const id = list.items[0].id;
  // 本人可删
  const ok = store3.deleteMemberOrders(capToken, [id]);
  // 管理员再导入一条并尝试删除（管理员权限）
  store3.importMemberOrders(t3, { content: '订单号,金额\nXY-D2,20', fileName: 'b.csv' });
  const l2 = store3.listMemberOrders(t3, { silent: true });
  store3.deleteMemberOrders(t3, [l2.items[0].id]);
  return ok.deleted === 1 && store3.listMemberOrders(capToken, { silent: true }).total === 0;
})());

// ================================================================= C 组：变异负向对照
console.log('== C 组：变异负向对照 ==');

// C 组复用 A 组的判别逻辑：把同一组断言复跑在变异实现上。
// 注意：变异体必须真正改变行为，否则断言恒真、测试形同虚设。
function runMainChecks(p) {
  const r = [];
  const csv = p.parseMemberOrders(CSV_HEADER + '\n' + CSV_BODY);
  // 字段映射
  r.push(csv.stats.valid === 2);
  r.push(csv.orders[0] && csv.orders[0].barcode === 'XY-2026-00123');
  r.push(csv.orders[0] && csv.orders[0].customer === '张女士');
  r.push(csv.orders[0] && csv.orders[0].amount === 128.5);
  r.push(csv.orders[0] && csv.orders[0].status === '待取');
  r.push(csv.orders[0] && csv.orders[0].items.length === 2);
  // 缺失/异常
  const miss = p.parseMemberOrders('订单号,金额,下单时间\nXY-1,abc,不是时间');
  r.push(miss.orders[0] && miss.orders[0].amount === null);
  r.push(miss.orders[0] && miss.orders[0].createdAt === null);
  r.push(miss.issues.length > 0);
  // 重复
  const dup = p.parseMemberOrders('订单号,金额\nXY-1,10\nxy-1,20');
  r.push(dup.stats.valid === 1 && dup.stats.duplicates === 1);
  return r;
}

// ---------------------------------------------------------------- 源码级变异框架
// 为什么必须用源码级变异：去重、缺失校验等逻辑发生在解析器内部（finalize），
// 若只在外部包一层 mock，真实解析器已经把重复行删掉了，变异体无法复现缺陷 →
// 等价变异，断言恒真、测试形同虚设。
// 故复制源码 → 注入缺陷 → 重新 require，让变异真正发生在缺陷点上。
const PARSER_SRC = path.join(__dirname, '..', 'main', 'member-order-parser.js');
const MUT_FILE = path.join(__dirname, '.mutant-member-order-parser.js');

function loadMutant(replacements) {
  const raw = fs.readFileSync(PARSER_SRC, 'utf8');
  let src = raw.replace(/\r\n/g, '\n');
  for (const [from, to] of replacements) {
    if (src.indexOf(from) === -1) throw new Error('变异锚点未命中：' + JSON.stringify(from));
    src = src.replace(from, to);
  }
  fs.writeFileSync(MUT_FILE, src, 'utf8');
  delete require.cache[require.resolve(MUT_FILE)];
  return require(MUT_FILE);
}

function cleanupMutant() {
  try { fs.unlinkSync(MUT_FILE); } catch (e) { /* 清理失败不影响判定 */ }
}

// C1 变异：金额解析失败时返回 0（把缺失当 0 元冒充有效金额）
// 锚点 = parseAmount 的失败分支（真正的缺陷点）
let mutantC1 = null;
try {
  mutantC1 = loadMutant([
    ['  if (!/^\\d*\\.?\\d+$/.test(s)) return null;', '  if (!/^\\d*\\.?\\d+$/.test(s)) return 0;']
  ]);
} catch (e) {
  console.log('  ! C1 变异构建失败：' + e.message);
}

// C2 变异：文件内重复订单不去重（保留全部重复行）
// 锚点 = finalize 里的重复判定（真正的缺陷点）
let mutantC2 = null;
try {
  mutantC2 = loadMutant([
    ['    if (seen.has(key)) {', '    if (false) {']
  ]);
} catch (e) {
  console.log('  ! C2 变异构建失败：' + e.message);
}

// C3 变异：缺失订单号不再判为无效行
// 锚点 = finalize 里的订单号缺失判定（真正的缺陷点）
let mutantC3 = null;
try {
  mutantC3 = loadMutant([
    ['    if (!o.orderNo) {', '    if (false) {']
  ]);
} catch (e) {
  console.log('  ! C3 变异构建失败：' + e.message);
}

// C4 变异：字段映射错位（customer 取到手机号列）
let mutantC4 = null;
try {
  mutantC4 = loadMutant([
    ["  const customer = String(pick('customer') || '').trim();", "  const customer = String(pick('phone') || '').trim();"]
  ]);
} catch (e) {
  console.log('  ! C4 变异构建失败：' + e.message);
}

// C5 变异：时间解析失败时兜底成当前时间（掩盖格式异常）
let mutantC5 = null;
try {
  mutantC5 = loadMutant([
    ['  const fallback = new Date(s);\n  return isNaN(fallback.getTime()) ? null : fallback.toISOString();',
     '  const fallback = new Date(s);\n  return isNaN(fallback.getTime()) ? new Date().toISOString() : fallback.toISOString();']
  ]);
} catch (e) {
  console.log('  ! C5 变异构建失败：' + e.message);
}

// 主检断言：既用于真实实现（全绿），也复跑在每个变异体上（须变红）
function runMainChecks(p) {
  const r = [];
  const csv = p.parseMemberOrders(CSV_HEADER + '\n' + CSV_BODY);
  // 字段映射
  r.push(csv.stats.valid === 2);
  r.push(csv.orders[0] && csv.orders[0].barcode === 'XY-2026-00123');
  r.push(csv.orders[0] && csv.orders[0].customer === '张女士');
  r.push(csv.orders[0] && csv.orders[0].phone === '13800001111');
  r.push(csv.orders[0] && csv.orders[0].amount === 128.5);
  r.push(csv.orders[0] && csv.orders[0].status === '待取');
  r.push(csv.orders[0] && csv.orders[0].items.length === 2);
  // 缺失 / 格式异常
  const miss = p.parseMemberOrders('订单号,金额,下单时间\nXY-1,abc,不是时间');
  r.push(miss.orders[0] && miss.orders[0].amount === null);
  r.push(miss.orders[0] && miss.orders[0].createdAt === null);
  r.push(miss.issues.length > 0);
  // 订单号缺失 → 判为无效行
  const noId = p.parseMemberOrders('订单号,金额\n,10');
  r.push(noId.stats.valid === 0 && noId.stats.invalid === 1);
  // 重复
  const dup = p.parseMemberOrders('订单号,金额\nXY-1,10\nxy-1,20');
  r.push(dup.stats.valid === 1 && dup.stats.duplicates === 1);
  return r;
}

check('C-real 主检实现全绿', runMainChecks(parser).every(Boolean));
check('C1 变异(金额缺失填0)被主检抓到', !!mutantC1 && !runMainChecks(mutantC1).every(Boolean));
check('C2 变异(去重失效)被主检抓到', !!mutantC2 && !runMainChecks(mutantC2).every(Boolean));
check('C3 变异(订单号缺失不判无效)被主检抓到', !!mutantC3 && !runMainChecks(mutantC3).every(Boolean));
check('C4 变异(字段映射错位)被主检抓到', !!mutantC4 && !runMainChecks(mutantC4).every(Boolean));
check('C5 变异(时间异常兜底当前时间)被主检抓到', !!mutantC5 && !runMainChecks(mutantC5).every(Boolean));
cleanupMutant();

console.log('verify-member-orders: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) {
  console.error('FAILED: ' + fails.join('; '));
  process.exit(1);
}
console.log('verify-member-orders: ALL GREEN');
