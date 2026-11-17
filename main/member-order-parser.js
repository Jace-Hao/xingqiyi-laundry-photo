'use strict';

/**
 * 会员导出软件订单解析器（纯函数模块，与 Electron 解耦）。
 *
 * 用途：把第三方「会员/CRM 导出软件」导出的订单数据（CSV / JSON）解析成
 * 本系统可用的订单对象，并映射到本系统的订单语义（条码为订单主键）。
 *
 * 设计要点：
 * - 纯函数、无 IO、无 Electron 依赖 → 可被 scripts/verify-member-orders.js 直接单测；
 * - 字段名不固定（各导出软件表头不同）→ 用「别名表」做宽容匹配，命中任一别名即可；
 * - 会员订单本身没有照片，与本系统「每条记录=一张照片」的 records 表语义不同，
 *   因此这里只产出订单对象，落库由 store.js 负责（会员订单单独存一张表）。
 *
 * 映射到本系统订单模型：
 *   orderNo    → barcode   （订单号即条码，是本系统订单的唯一键）
 *   customer   → customer  （会员姓名）
 *   phone      → phone     （会员手机号）
 *   items      → items     （商品明细数组）
 *   amount     → amount    （金额，单位元）
 *   createdAt  → createdAt （下单时间，ISO 字符串）
 *   status     → status    （订单状态原文）
 *   其它       → extra     （保留未识别的原始列，便于追溯，不丢数据）
 */

const MAX_BARCODE = 64;        // 与 store.addRecord 的条码长度上限保持一致
const MAX_TEXT = 200;          // 与 store.setRecordNote 的备注长度上限保持一致
const MAX_ITEMS = 50;          // 单订单商品明细条数上限，防止异常文件撑爆内存
const MAX_ROWS = 5000;         // 单次导入解析的最大行数

/**
 * 字段别名表：键为本系统标准字段，值为该字段在各种导出软件里可能出现的表头写法。
 * 匹配时先做「归一化表头」（去空格/全角符号/大小写/常见分隔符）再比对。
 * 数组内顺序即优先级——先命中的别名优先，保证多表头同时存在时行为确定。
 */
const FIELD_ALIASES = {
  orderNo: [
    '订单号', '订单编号', '订单id', '订单ID', '单号', '流水号', '订单流水号',
    'orderno', 'orderid', 'ordernumber', 'tradeno', 'serialno'
  ],
  customer: [
    '会员姓名', '会员名称', '会员', '顾客姓名', '顾客', '客户姓名', '客户',
    '姓名', '联系人', '取件人',
    'membername', 'customername', 'customer', 'name', 'contactname'
  ],
  phone: [
    '会员手机', '会员电话', '手机号', '手机', '联系电话', '电话', '联系方式',
    'phonenumber', 'phone', 'mobile', 'tel', 'telephone'
  ],
  items: [
    '商品', '商品名称', '商品明细', '服务项目', '服务项目名称', '洗衣项目',
    'items', 'goods', 'product', 'productname', 'servicename'
  ],
  amount: [
    '订单金额', '金额', '实付金额', '应付金额', '实收金额', '总价', '合计',
    '消费金额', 'paidamount', 'amount', 'total', 'price', 'payamount'
  ],
  createdAt: [
    '下单时间', '创建时间', '订单时间', '成交时间', '付款时间', '交易时间', '时间', '日期',
    'createtime', 'createdat', 'ordertime', 'paytime', 'time', 'date'
  ],
  status: [
    '订单状态', '状态', '交易状态', '会员状态', '服务状态',
    'status', 'orderstatus', 'state'
  ]
};

// 反查表：归一化表头 → 标准字段名。构建时即完成归一化，匹配时零额外开销。
const HEADER_INDEX = buildHeaderIndex(FIELD_ALIASES);

/** 表头归一化：去空白/换行/全角空格、去常见分隔符、小写。用于宽容匹配表头。 */
function normalizeHeader(raw) {
  return String(raw === null || raw === undefined ? '' : raw)
    .replace(/[\s\u3000]+/g, '')
    .replace(/[_\-.:：()（）[\]【】/\\]/g, '')
    .toLowerCase();
}

function buildHeaderIndex(aliases) {
  const idx = new Map();
  for (const [field, list] of Object.entries(aliases)) {
    for (const alias of list) {
      const key = normalizeHeader(alias);
      if (!key) continue;
      // 先到先得：aliases 的书写顺序即优先级
      if (!idx.has(key)) idx.set(key, field);
    }
  }
  return idx;
}

/**
 * 猜测一行数据里各标准字段的列位置。
 * 优先用别名表精确匹配表头；表头不可用时退化为「按位置猜」——
 * 会员导出软件常常没有稳定表头（导出的是数据行而非带表头的表格）。
 *
 * @param {string[]} headers 表头单元格（可为空数组，表示无表头）
 * @returns {{index:Object<string,number>, matched:boolean, unmapped:string[]}}
 */
function mapColumns(headers) {
  const index = {};
  const used = new Set();
  const cells = Array.isArray(headers) ? headers : [];

  cells.forEach((h, i) => {
    const key = normalizeHeader(h);
    if (!key) return;
    const field = HEADER_INDEX.get(key);
    if (field && !(field in index)) {
      index[field] = i;
      used.add(i);
    }
  });

  // 未命中的表头原样保留，供 extra 使用
  const unmapped = cells
    .map((h, i) => ({ h, i }))
    .filter(({ h, i }) => !used.has(i) && String(h || '').trim())
    .map(({ h }) => String(h).trim());

  return { index, matched: Object.keys(index).length > 0, unmapped };
}

/**
 * 常见订单状态词表：无表头推断时用于识别「状态」列。
 * 只认这些词，避免把「王女士」这类姓名误判成状态（早期版本用「含中文且短」的
 * 判据，结果把人名列当成了状态列，导致客户名与商品整体错位）。
 */
const STATUS_WORDS = [
  '待付款', '已付款', '未付款', '待支付', '已支付', '待取', '已取', '取件中',
  '待取件', '已取件', '处理中', '待处理', '制作中', '已完成', '完成', '已取消',
  '已退款', '退款中', '配送中', '待发货', '已发货', '已签收', '已收货', '取消'
];

/**
 * 解析 CSV 文本为二维数组。
 * 遵循 RFC4180：双引号包裹、内部 "" 转义、逗号/换行分隔；容忍 BOM 与 CRLF/LF 混用。
 * 引号未闭合时按「读到结尾」处理，不抛异常（异常数据不应中断整批导入）。
 *
 * @param {string} text
 * @returns {string[][]}
 */
function parseCsv(text) {
  let s = String(text === null || text === undefined ? '' : text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // 去 BOM
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = s.length;

  while (i < len) {
    const ch = s[i];

    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; } // 转义的双引号
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') {
      // CRLF 或孤立 CR 都算行结束
      row.push(field); field = ''; rows.push(row); row = [];
      i += (s[i + 1] === '\n') ? 2 : 1;
      continue;
    }
    if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; i++; continue; }

    field += ch; i++;
  }
  // 收尾：最后一行可能没有换行符
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * 把商品明细单元格切成数组。
 * 支持多种导出软件的写法：
 *   - 逗号 / 顿号 / 顿号分隔：'羽绒服,皮靴'
 *   - 数量后缀：'羽绒服 x2'
 *   - JSON 数组文本：'["羽绒服","皮靴"]'
 *   - 换行分隔（单元格内含真实换行）
 * @param {string} raw
 * @returns {string[]}
 */
function parseItems(raw) {
  let s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!s) return [];

  // JSON 数组文本
  if (s.charAt(0) === '[' && s.charAt(s.length - 1) === ']') {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) {
        return arr.map((v) => String(v === null || v === undefined ? '' : v).trim()).filter(Boolean).slice(0, MAX_ITEMS);
      }
    } catch (e) {
      /* 非法 JSON 退回普通分隔符解析 */
    }
  }

  return s
    .split(/[\n,，、;；|]/)
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => v.replace(/\s*[xX×*]\s*\d+\s*$/, '').trim()) // 去掉 'x2' 这样的数量后缀
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
}

/**
 * 金额解析：容忍千分位、货币符号、空白、全角字符、括号负数。
 * 解析不出来返回 null（表示「缺失/异常」），绝不返回 0 冒充有效金额。
 * @param {*} raw
 * @returns {number|null}
 */
function parseAmount(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let s = String(raw).trim();
  if (!s) return null;

  let negative = false;
  // 会计写法：(123.45) 表示 -123.45
  if (/^\((.*)\)$/.test(s)) { negative = true; s = s.replace(/^\(|\)$/g, '').trim(); }

  s = s.replace(/[¥￥$€£元\s,，]/g, '');
  if (!s) return null;
  if (s.startsWith('-')) { negative = true; s = s.slice(1); }
  if (!/^\d*\.?\d+$/.test(s)) return null;

  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/**
 * 时间解析：支持 ISO、'YYYY-MM-DD HH:mm:ss'、'YYYY/M/D'、'YYYYMMDD' 等常见写法，
 * 一律转成 UTC ISO 字符串（与本系统 createdAt 的存法一致）。
 * 解析不出来返回 null（缺失/异常），由上层决定用导入时刻兜底还是标记异常。
 * @param {*} raw
 * @returns {string|null}
 */
function parseDateTime(raw) {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw.toISOString();
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // 10 位=秒、13 位=毫秒
    const ms = raw > 1e11 ? raw : raw * 1000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  let s = String(raw).trim();
  if (!s) return null;

  // 紧凑数字格式 20261101143000 / 20261101
  if (/^\d{8}$/.test(s)) {
    const d = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00`);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (/^\d{14}$/.test(s)) {
    const d = new Date(
      `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T` +
      `${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`
    );
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  // 归一化分隔符：/ 和 . 与 - 等价
  s = s.replace(/[/.]/g, '-');
  // 'YYYY-M-D HH:mm:ss' → 'YYYY-MM-DDTHH:mm:ss'
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const [, y, mo, d, hh, mi, ss] = m;
    const pad = (n) => String(n).padStart(2, '0');
    const iso = `${y}-${pad(mo)}-${pad(d)}T${pad(hh || 0)}:${mi || '00'}:${ss || '00'}`;
    const dt = new Date(iso);
    return isNaN(dt.getTime()) ? null : dt.toISOString();
  }

  const fallback = new Date(s);
  return isNaN(fallback.getTime()) ? null : fallback.toISOString();
}

/**
 * 订单号规范化：去空白；统一大写？—— 保留原样大小写（条码大小写敏感，
 * 保持与人工录入的条码可精确匹配），仅去首尾空白与不可见字符。
 * @param {*} raw
 * @returns {string}
 */
function normalizeOrderNo(raw) {
  return String(raw === null || raw === undefined ? '' : raw)
    .replace(/[\x00-\x1f]/g, '')
    .trim();
}

/**
 * 把一行原始单元格转成标准订单对象（不做校验、不做去重）。
 *
 * @param {string[]} cells 该行的单元格
 * @param {Object<string,number>} index 标准字段 → 列下标
 * @param {string[]} headers 表头（用于 extra 保留未识别列）
 * @param {number} rowIndex 行号（用于错误提示，1 基）
 * @returns {object} 订单草稿对象
 */
function mapRow(cells, index, headers, rowIndex) {
  const pick = (field) => {
    const i = index[field];
    if (i === undefined || i === null || i < 0) return '';
    return cells[i] === undefined || cells[i] === null ? '' : String(cells[i]);
  };

  const orderNo = normalizeOrderNo(pick('orderNo'));
  const customer = String(pick('customer') || '').trim();
  const phone = String(pick('phone') || '').trim();
  const items = parseItems(pick('items'));
  const amount = parseAmount(pick('amount'));
  const createdAt = parseDateTime(pick('createdAt'));
  const status = String(pick('status') || '').trim();

  // extra：保留未识别的原始列，保证「不丢数据」，便于人工回查
  const extra = {};
  if (Array.isArray(headers) && headers.length) {
    headers.forEach((h, i) => {
      const name = String(h || '').trim();
      if (!name) return;
      if (Object.values(index).includes(i)) return; // 已映射的列不进 extra
      const v = cells[i];
      if (v === undefined || v === null || String(v).trim() === '') return;
      extra[name] = String(v).trim();
    });
  }

  return {
    rowIndex,
    orderNo,
    barcode: orderNo.slice(0, MAX_BARCODE),
    customer: customer.slice(0, MAX_TEXT),
    phone: phone.slice(0, 40),
    items,
    amount,
    createdAt,
    status: status.slice(0, 60),
    extra
  };
}

/**
 * 解析「会员导出软件」的订单数据（CSV 文本或 JSON 文本）。
 *
 * @param {string} text 文件内容
 * @param {{format?:string}} [opts] format 可显式指定 'csv' | 'json'；缺省按内容自动判断
 * @returns {{
 *   ok:boolean,
 *   format:string,
 *   headers:string[],
 *   orders:object[],
 *   issues:Array<{row:number,field:string,message:string}>,
 *   stats:{total:number,valid:number,invalid:number,duplicates:number}
 * }}
 */
function parseMemberOrders(text, opts) {
  const o = opts || {};
  const raw = String(text === null || text === undefined ? '' : text);
  const trimmed = raw.replace(/^\ufeff/, '').trim();

  if (!trimmed) {
    return {
      ok: false, format: 'empty', headers: [], orders: [], issues: [],
      stats: { total: 0, valid: 0, invalid: 0, duplicates: 0 }
    };
  }

  const format = o.format === 'csv' || o.format === 'json'
    ? o.format
    : (trimmed.charAt(0) === '[' || trimmed.charAt(0) === '{') ? 'json' : 'csv';

  if (format === 'json') return parseJsonOrders(trimmed);
  return parseCsvOrders(trimmed);
}

/**
 * CSV 解析入口。
 * 表头判定：首行若能命中任一字段别名 → 视为表头；否则首行也当数据行处理
 * （会员导出软件常常直接导出数据、没有表头行）。
 */
function parseCsvOrders(text) {
  const rows = parseCsv(text).filter((r) => r.some((c) => String(c === null || c === undefined ? '' : c).trim() !== ''));
  const issues = [];

  if (!rows.length) {
    return {
      ok: false, format: 'csv', headers: [], orders: [], issues,
      stats: { total: 0, valid: 0, invalid: 0, duplicates: 0 }
    };
  }

  let headers = [];
  let dataRows = rows;
  const headProbe = mapColumns(rows[0]);
  if (headProbe.matched) {
    headers = rows[0].map((h) => String(h === null || h === undefined ? '' : h).trim());
    dataRows = rows.slice(1);
  }

  // 无表头时用位置兜底（并标记为推断）
  const usingFallback = !headProbe.matched;
  const index = usingFallback ? buildFallbackIndex(rows[0]) : headProbe.index;
  if (usingFallback) {
    issues.push({
      row: 0, field: 'header',
      message: '未识别到表头，已按常见列序推断字段位置，请人工核对导入结果'
    });
  }

  const capped = dataRows.slice(0, MAX_ROWS);
  if (dataRows.length > MAX_ROWS) {
    issues.push({
      row: MAX_ROWS, field: 'rows',
      message: `数据行超过 ${MAX_ROWS} 行，超出部分已忽略`
    });
  }

  const orders = [];
  capped.forEach((cells, i) => {
    const rowIndex = i + (headers.length ? 2 : 1); // 1 基行号（有表头时表头占第 1 行）
    const o = mapRow(cells, index, headers, rowIndex);
    o.inferred = usingFallback;
    orders.push(o);
  });

  return finalize(orders, issues, 'csv');
}

/**
 * 构造位置兜底的列索引：按数据行各列的内容特征判断哪列是什么。
 * 特征优先于固定列序（不同导出软件列序不同，但「订单号是长串数字」这类特征稳定）。
 */
function buildFallbackIndex(sampleRow) {
  const cells = (sampleRow || []).map((c) => String(c === null || c === undefined ? '' : c).trim());
  const index = {};
  const used = new Set();

  const take = (field, pred) => {
    for (let i = 0; i < cells.length; i++) {
      if (used.has(i)) continue;
      if (pred(cells[i])) { index[field] = i; used.add(i); return; }
    }
  };

  // 订单号：较长的非金额串
  take('orderNo', (v) => v && v.length >= 6 && !/^\d+(\.\d+)?$/.test(v) && !/[¥￥$]/.test(v));
  // 手机号
  take('phone', (v) => /^1[3-9]\d{9}$/.test(v.replace(/\D/g, '')));
  // 金额：带货币符号或纯小数
  take('amount', (v) => /^[¥￥$]?\d+(\.\d{1,2})?$/.test(v));
  // 时间
  take('createdAt', (v) => /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(v) || /^\d{8}(\d{6})?$/.test(v));
  // 状态：只认已知状态词，避免把人名/商品误判为状态
  take('status', (v) => v && STATUS_WORDS.includes(v));

  // 剩余列按出现顺序分配给会员名、商品、状态（状态兜底取最后一个剩余列）
  const free = cells.map((_, i) => i).filter((i) => !used.has(i));
  const assignNext = (field) => {
    if (free.length) { index[field] = free.shift(); used.add(index[field]); }
  };
  assignNext('customer');
  assignNext('items');
  if (free.length) { index.status = free.pop(); used.add(index.status); }

  return index;
}

/**
 * JSON 解析入口：支持数组、单对象、以及 { data/list/orders/records: [...] } 包装。
 */
function parseJsonOrders(text) {
  const issues = [];
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return {
      ok: false, format: 'json', headers: [], orders: [],
      issues: [{ row: 0, field: 'file', message: 'JSON 格式解析失败：' + (e.message || '未知错误') }],
      stats: { total: 0, valid: 0, invalid: 0, duplicates: 0 }
    };
  }

  let rows = obj;
  if (!Array.isArray(rows)) {
    if (obj && typeof obj === 'object') {
      rows = obj.data || obj.list || obj.orders || obj.records || obj.items || null;
    }
    if (!Array.isArray(rows)) {
      return {
        ok: false, format: 'json', headers: [], orders: [],
        issues: [{ row: 0, field: 'file', message: 'JSON 顶层不是数组，且未找到 data/list/orders/records 包装字段' }],
        stats: { total: 0, valid: 0, invalid: 0, duplicates: 0 }
      };
    }
  }

  const capped = rows.slice(0, MAX_ROWS);
  if (rows.length > MAX_ROWS) {
    issues.push({ row: MAX_ROWS, field: 'rows', message: `数据行超过 ${MAX_ROWS} 行，超出部分已忽略` });
  }

  // JSON 对象的键天然就是表头，用别名表匹配；没命中的键进 extra
  const headers = [];
  const index = {};
  if (capped.length && capped[0] && typeof capped[0] === 'object' && !Array.isArray(capped[0])) {
    const keys = Object.keys(capped[0]);
    keys.forEach((k, i) => {
      headers[i] = k;
      const field = HEADER_INDEX.get(normalizeHeader(k));
      if (field && !(field in index)) index[field] = i;
    });
  }

  const orders = [];
  capped.forEach((rowObj, i) => {
    if (!rowObj || typeof rowObj !== 'object' || Array.isArray(rowObj)) {
      issues.push({ row: i + 1, field: 'row', message: '该行不是对象，已跳过' });
      return;
    }
    // JSON 行按 key 取值，不按列下标
    const cells = headers.map((h) => (h === undefined ? '' : rowObj[h]));
    const keyIndex = {};
    headers.forEach((h, ci) => {
      const field = HEADER_INDEX.get(normalizeHeader(h));
      if (field && !(field in keyIndex)) keyIndex[field] = ci;
    });
    const o = mapRow(cells, Object.keys(keyIndex).length ? keyIndex : index, headers, i + 1);
    o.inferred = !Object.keys(keyIndex).length;
    orders.push(o);
  });

  return finalize(orders, issues, 'json');
}

/**
 * 收尾：校验每行、去重、统计。
 *
 * 校验规则：
 *   - 订单号为空 → 无效（无法映射为条码，本系统订单必须有主键）
 *   - 订单号超长 → 截断并记 issue（与 addRecord 的 64 位上限一致）
 *   - 金额无法解析 → 记 issue，amount 置 null（不猜、不填 0）
 *   - 时间无法解析 → 记 issue，createdAt 置 null（上层可用导入时刻兜底）
 *   - 缺少会员名 → 记 issue（缺失字段，但不丢弃整行）
 *
 * 去重规则：同一文件内订单号重复 → 保留第一条，后面的记为 duplicate。
 */
function finalize(orders, issues, format) {
  const seen = new Map();
  const valid = [];
  let invalid = 0;
  let duplicates = 0;

  for (const o of orders) {
    if (!o.orderNo) {
      invalid++;
      issues.push({ row: o.rowIndex, field: 'orderNo', message: '订单号缺失，无法映射为条码，已跳过该行' });
      continue;
    }
    if (o.orderNo.length > MAX_BARCODE) {
      issues.push({
        row: o.rowIndex, field: 'orderNo',
        message: `订单号超长（${o.orderNo.length} 位），已截断为前 ${MAX_BARCODE} 位`
      });
    }
    if (o.amount === null) {
      issues.push({ row: o.rowIndex, field: 'amount', message: '金额缺失或格式异常，已置空' });
    }
    if (o.createdAt === null) {
      issues.push({ row: o.rowIndex, field: 'createdAt', message: '时间缺失或格式异常，已置空' });
    }
    if (!o.customer) {
      issues.push({ row: o.rowIndex, field: 'customer', message: '会员信息缺失' });
    }

    const key = o.orderNo.toLowerCase();
    if (seen.has(key)) {
      duplicates++;
      issues.push({
        row: o.rowIndex, field: 'orderNo',
        message: `订单号重复（与第 ${seen.get(key)} 行相同），已跳过重复行`
      });
      continue;
    }
    seen.set(key, o.rowIndex);
    valid.push(o);
  }

  return {
    ok: valid.length > 0,
    format,
    headers: [],
    orders: valid,
    issues,
    stats: { total: orders.length, valid: valid.length, invalid, duplicates }
  };
}

/**
 * 找出与已有会员订单重复的订单号（与库内比对用，纯函数，不碰 IO）。
 *
 * @param {object[]} incoming 待导入订单
 * @param {Array<{orderNo:string}>} existing 库内已有订单
 * @returns {{duplicateOrders:object[], uniqueOrders:object[]}}
 */
function splitDuplicates(incoming, existing) {
  const existSet = new Set(
    (Array.isArray(existing) ? existing : [])
      .map((e) => normalizeOrderNo(e && e.orderNo).toLowerCase())
      .filter(Boolean)
  );
  const duplicateOrders = [];
  const uniqueOrders = [];
  for (const o of Array.isArray(incoming) ? incoming : []) {
    const key = normalizeOrderNo(o && o.orderNo).toLowerCase();
    if (key && existSet.has(key)) duplicateOrders.push(o);
    else uniqueOrders.push(o);
  }
  return { duplicateOrders, uniqueOrders };
}

module.exports = {
  FIELD_ALIASES,
  MAX_BARCODE,
  MAX_TEXT,
  parseCsv,
  parseCsvOrders,
  parseJsonOrders,
  parseMemberOrders,
  parseItems,
  parseAmount,
  parseDateTime,
  normalizeHeader,
  normalizeOrderNo,
  mapColumns,
  mapRow,
  splitDuplicates
};
