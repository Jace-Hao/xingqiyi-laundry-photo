'use strict';

/**
 * 缩略图生成 / 缓存 / 清理与 /photo 缩略图接口的无头验证。
 * 运行：node scripts/verify-thumb.js
 *
 * 三个层次：
 * - 模块层：真实文件系统 + 假 nativeImage，覆盖 宽度参数 / 缓存路径 /
 *   mtime 失效规则 / 生成与缓存命中 / 失败回退 / 精确清理；
 * - 集成层：真实 store（记录输出字段、删除与保留期清理同步清缓存）
 *   与真实 HTTP 服务（/photo?w= 的命中、回退、未注入三种路径）；
 * - 接线静态检查：Electron 协议处理器无法在脚本中运行，只能以源码形态
 *   检查关键调用已接线（缩略图服务创建、注入与 ?w= 解析）。
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { createStore } = require('../main/store');
const { startServer } = require('../main/server');
const {
  createThumbService,
  normalizeThumbSize,
  thumbFilePath,
  DEFAULT_THUMB_WIDTH,
  MAX_THUMB_SIZE
} = require('../main/thumb');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xqy-thumb-'));

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.log('  ✗ ' + name + ' —— ' + e.message);
  }
}

const tinyJpeg =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';

/** 记录缩放参数的假 nativeImage（生成阶段使用；不依赖 Electron） */
let lastResizeArgs = null;
function fakeNativeImage(opts = {}) {
  const calls = { load: 0, resize: 0 };
  const img = {
    calls,
    createFromFile() {
      calls.load++;
      if (opts.loadThrows) throw new Error('decode failed');
      if (opts.loadEmpty) return { isEmpty: () => true };
      return {
        isEmpty: () => false,
        getSize: () => ({ width: opts.width === undefined ? 4000 : opts.width, height: 3000 }),
        resize(args) {
          calls.resize++;
          lastResizeArgs = args;
          if (opts.resizeEmpty) return { isEmpty: () => true };
          return {
            isEmpty: () => false,
            toJPEG() {
              return Buffer.from(opts.jpeg || 'FAKE-THUMB');
            }
          };
        }
      };
    }
  };
  return img;
}

(async () => {
  console.log('=== 缩略图缓存与 /photo 接口验证 ===');

  console.log('\n== 宽度参数校验 ==');
  check('合法宽度：数字与数字字符串（含上下限）', () => {
    if (normalizeThumbSize(16) !== 16) throw new Error('16');
    if (normalizeThumbSize(360) !== 360) throw new Error('360');
    if (normalizeThumbSize('360') !== 360) throw new Error("'360'");
    if (normalizeThumbSize(MAX_THUMB_SIZE) !== MAX_THUMB_SIZE) throw new Error('上限值应放行');
  });
  check('非法宽度一律返回 null（0 / 负数 / 越界 / 小数 / 非数字 / 空值）', () => {
    const bad = [0, -1, -360, 15, MAX_THUMB_SIZE + 1, 1.5, '12.5', 'abc', NaN, Infinity, '', null, undefined, {}, []];
    for (const v of bad) {
      if (normalizeThumbSize(v) !== null) throw new Error('应拒绝：' + JSON.stringify(v));
    }
  });

  console.log('\n== 缓存路径计算 ==');
  check('确定性：同输入同路径；不同宽度 / 不同照片互不共用', () => {
    const a = thumbFilePath('BC001/202609221030.jpg', 360, tmpDir);
    const b = thumbFilePath('BC001/202609221030.jpg', 360, tmpDir);
    const c = thumbFilePath('BC001/202609221030.jpg', 720, tmpDir);
    const d = thumbFilePath('BC002/202609221030.jpg', 360, tmpDir);
    if (a !== b) throw new Error('同参数应得到同一缓存路径');
    if (a === c) throw new Error('不同宽度不应共用缓存');
    if (a === d) throw new Error('不同照片不应共用缓存');
  });
  check('缓存文件名是纯 hash（不携带路径片段）且位于缓存目录内', () => {
    const p = thumbFilePath('BC001/照 片.jpg', 360, tmpDir);
    if (!/^[0-9a-f]{24}\.jpg$/.test(path.basename(p))) throw new Error('文件名异常：' + path.basename(p));
    if (path.dirname(p) !== tmpDir) throw new Error('应位于 thumbsDir 内');
  });
  check('含目录穿越的相对路径被哈希吸收，产物仍在缓存目录内', () => {
    const p = thumbFilePath('../../evil.jpg', 360, tmpDir);
    if (path.dirname(p) !== tmpDir) throw new Error('逃出缓存目录');
  });

  console.log('\n== 缓存有效性（mtime 规则） ==');
  const svc = createThumbService({ thumbsDir: path.join(tmpDir, 'thumbs-main') });
  const srcA = path.join(tmpDir, 'src-a.jpg');
  fs.writeFileSync(srcA, 'SRC-A');
  const thumbPathA = svc.thumbFilePath('BC-A/1.jpg', DEFAULT_THUMB_WIDTH);

  check('缓存不存在 → 视为失效', () => {
    if (svc.isFresh(thumbPathA, srcA)) throw new Error('不存在应为失效');
  });
  check('缓存早于原图 → 失效（原图被替换时自动重建）', () => {
    fs.mkdirSync(path.dirname(thumbPathA), { recursive: true });
    fs.writeFileSync(thumbPathA, 'THUMB');
    const t = Date.now();
    fs.utimesSync(srcA, new Date(t), new Date(t));
    fs.utimesSync(thumbPathA, new Date(t - 5000), new Date(t - 5000));
    if (svc.isFresh(thumbPathA, srcA)) throw new Error('应失效');
  });
  check('缓存不早于原图 → 有效（后续请求走缓存，不再解码）', () => {
    const t = Date.now();
    fs.utimesSync(thumbPathA, new Date(t + 5000), new Date(t + 5000));
    if (!svc.isFresh(thumbPathA, srcA)) throw new Error('应有效');
  });
  check('空缓存文件 / 原图缺失 → 失效', () => {
    const p = svc.thumbFilePath('BC-E/empty.jpg', 360);
    fs.writeFileSync(p, '');
    if (svc.isFresh(p, srcA)) throw new Error('空文件应失效');
    if (svc.isFresh(thumbPathA, path.join(tmpDir, 'missing.jpg'))) throw new Error('原图缺失应失效');
  });

  console.log('\n== 生成与缓存（假 nativeImage） ==');
  check('缩小生成：返回缓存路径、内容为缩放产物、宽度传给 resize', () => {
    const img = fakeNativeImage({ width: 4000, jpeg: 'THUMB-360' });
    const s = createThumbService({ thumbsDir: path.join(tmpDir, 't-gen'), nativeImage: img });
    const src = path.join(tmpDir, 'big.jpg');
    fs.writeFileSync(src, 'BIG-ORIGINAL');
    const out = s.getOrCreate(src, 'G/1.jpg', 360);
    if (!out) throw new Error('应生成缩略图');
    if (fs.readFileSync(out).toString() !== 'THUMB-360') throw new Error('缓存内容应为缩放产物');
    if (img.calls.resize !== 1) throw new Error('应调用一次 resize');
    if (!lastResizeArgs || lastResizeArgs.width !== 360) throw new Error('resize 宽度应为 360：' + JSON.stringify(lastResizeArgs));
  });
  check('缓存命中：第二次请求不再解码 / 缩放', () => {
    const img = fakeNativeImage({});
    const s = createThumbService({ thumbsDir: path.join(tmpDir, 't-hit'), nativeImage: img });
    const src = path.join(tmpDir, 'hit.jpg');
    fs.writeFileSync(src, 'HIT');
    const first = s.getOrCreate(src, 'H/1.jpg', 360);
    if (!first) throw new Error('首次应生成');
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(src, past, past); // 确保原图 mtime 早于刚生成的缓存，排除同毫秒抖动
    const second = s.getOrCreate(src, 'H/1.jpg', 360);
    if (second !== first) throw new Error('第二次应返回同一缓存路径');
    if (img.calls.load !== 1 || img.calls.resize !== 1) throw new Error('命中缓存不应再解码 / 缩放');
  });
  check('原图本就更小时不放大：直接复制原文件，缓存目录自动创建', () => {
    const img = fakeNativeImage({ width: 300 });
    const freshDir = path.join(tmpDir, 't-small', 'nested'); // 故意多一层，验证自动建目录
    const s = createThumbService({ thumbsDir: freshDir, nativeImage: img });
    const src = path.join(tmpDir, 'small.jpg');
    fs.writeFileSync(src, 'SMALL-ORIGINAL');
    const out = s.getOrCreate(src, 'S/1.jpg', 360);
    if (!out || !fs.existsSync(out)) throw new Error('应落缓存文件');
    if (fs.readFileSync(out).toString() !== 'SMALL-ORIGINAL') throw new Error('内容应等于原文件');
    if (img.calls.resize !== 0) throw new Error('不应触发缩放');
  });
  check('生成失败（解码异常 / 空图 / 缩放失败）返回 null 而不抛异常', () => {
    const src = path.join(tmpDir, 'fail.jpg');
    fs.writeFileSync(src, 'FAIL');
    for (const opts of [{ loadThrows: true }, { loadEmpty: true }, { resizeEmpty: true }]) {
      const s = createThumbService({ thumbsDir: path.join(tmpDir, 't-fail'), nativeImage: fakeNativeImage(opts) });
      if (s.getOrCreate(src, 'F/1.jpg', 360) !== null) throw new Error('失败时应返回 null：' + JSON.stringify(opts));
    }
  });
  check('非法入参（宽度 / 路径缺失）返回 null', () => {
    const s = createThumbService({ thumbsDir: path.join(tmpDir, 't-bad'), nativeImage: fakeNativeImage({}) });
    const src = path.join(tmpDir, 'bad.jpg');
    fs.writeFileSync(src, 'X');
    if (s.getOrCreate(src, 'B/1.jpg', 5) !== null) throw new Error('非法宽度应 null');
    if (s.getOrCreate(src, '', 360) !== null) throw new Error('空 relPath 应 null');
    if (s.getOrCreate('', 'B/1.jpg', 360) !== null) throw new Error('空 srcPath 应 null');
  });

  console.log('\n== 缓存清理（removeFor） ==');
  check('只删指定照片的默认宽度缓存，不误伤其他照片与其他宽度', () => {
    const s = createThumbService({ thumbsDir: path.join(tmpDir, 't-rm') });
    const keepA = s.thumbFilePath('A/1.jpg', 720);
    const dropA = s.thumbFilePath('A/1.jpg', DEFAULT_THUMB_WIDTH);
    const keepB = s.thumbFilePath('B/2.jpg', DEFAULT_THUMB_WIDTH);
    for (const p of [keepA, dropA, keepB]) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, 'X');
    }
    const n = s.removeFor('A/1.jpg');
    if (n !== 1) throw new Error('应删除 1 个，实际 ' + n);
    if (fs.existsSync(dropA)) throw new Error('默认宽度缓存应被删除');
    if (!fs.existsSync(keepA)) throw new Error('其他宽度不应被删除');
    if (!fs.existsSync(keepB)) throw new Error('其他照片不应被删除');
  });
  check('可指定宽度列表；重复删除返回 0；非法尺寸跳过不报错', () => {
    const s = createThumbService({ thumbsDir: path.join(tmpDir, 't-rm') });
    const p = s.thumbFilePath('C/3.jpg', 720);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'X');
    const n = s.removeFor('C/3.jpg', [720, 0, 'bad']);
    if (n !== 1) throw new Error('应删除 1 个，实际 ' + n);
    if (s.removeFor('C/3.jpg', [720]) !== 0) throw new Error('重复删除应返回 0');
  });

  console.log('\n== 数据层集成（输出字段 / 删除清理） ==');
  const stDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xqy-thumb-store-'));
  const stThumbs = path.join(stDir, 'thumbs');
  const store = createStore({
    dataDir: path.join(stDir, 'data'),
    defaultPhotoDir: path.join(stDir, 'photos'),
    updateDir: path.join(stDir, 'updates'),
    appVersion: '0.0.0',
    photoScheme: 'xqy-photo',
    thumbsDir: stThumbs
  });
  store.ensureSeedData();
  store.setMode('server');
  const admin = store.login({ username: 'admin', password: 'admin123' }).sessionToken;
  const rec = store.addRecord(admin, { imageData: tinyJpeg, barcode: 'TH001' });

  check('新增 / 列表 / 详情接口统一携带 photoUrl 与 thumbUrl', () => {
    if (typeof rec.thumbUrl !== 'string' || !rec.thumbUrl.endsWith('?w=' + DEFAULT_THUMB_WIDTH)) {
      throw new Error('addRecord 返回缺少 thumbUrl：' + rec.thumbUrl);
    }
    const list = store.listRecords(admin, { silent: true, pageSize: 10 });
    const it = list.items.find((x) => x.id === rec.id);
    if (!it) throw new Error('列表未包含新记录');
    if (it.photoUrl !== 'xqy-photo://photo/' + encodeURIComponent(it.photoFile)) throw new Error('photoUrl 异常：' + it.photoUrl);
    if (it.thumbUrl !== it.photoUrl + '?w=' + DEFAULT_THUMB_WIDTH) throw new Error('thumbUrl 异常：' + it.thumbUrl);
    const got = store.getRecord(admin, rec.id);
    if (got.thumbUrl !== it.thumbUrl) throw new Error('getRecord 未携带 thumbUrl');
  });
  check('管理端数据总览的最近存档同样携带 thumbUrl', () => {
    const o = store.overview(admin);
    const it = o.recentRecords.find((x) => x.id === rec.id);
    if (!it || !it.thumbUrl) throw new Error('数据总览缺少 thumbUrl');
  });
  check('删除记录时同步清理该照片的缩略图缓存', () => {
    const tp = thumbFilePath(rec.photoFile, DEFAULT_THUMB_WIDTH, stThumbs);
    fs.mkdirSync(path.dirname(tp), { recursive: true });
    fs.writeFileSync(tp, 'STALE-THUMB');
    store.deleteRecord(admin, rec.id);
    if (fs.existsSync(tp)) throw new Error('缩略图缓存未随记录删除被清理');
  });
  check('批量删除时逐条清理缩略图缓存', () => {
    const r1 = store.addRecord(admin, { imageData: tinyJpeg, barcode: 'TH002' });
    const r2 = store.addRecord(admin, { imageData: tinyJpeg, barcode: 'TH002' });
    const t1 = thumbFilePath(r1.photoFile, DEFAULT_THUMB_WIDTH, stThumbs);
    const t2 = thumbFilePath(r2.photoFile, DEFAULT_THUMB_WIDTH, stThumbs);
    for (const p of [t1, t2]) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, 'X');
    }
    store.deleteRecords(admin, [r1.id, r2.id]);
    if (fs.existsSync(t1) || fs.existsSync(t2)) throw new Error('批量删除后仍有缓存残留');
  });
  check('保留期自动清理时同步清理缩略图缓存', () => {
    const r3 = store.addRecord(admin, { imageData: tinyJpeg, barcode: 'TH003' });
    const t3 = thumbFilePath(r3.photoFile, DEFAULT_THUMB_WIDTH, stThumbs);
    fs.mkdirSync(path.dirname(t3), { recursive: true });
    fs.writeFileSync(t3, 'X');
    // 把记录回拨到 3 天前，并设置 1 天保留期（服务端模式才执行清理）
    const recFile = path.join(stDir, 'data', 'records.json');
    const arr = JSON.parse(fs.readFileSync(recFile, 'utf8'));
    const target = arr.find((x) => x.id === r3.id);
    target.createdAt = new Date(Date.now() - 3 * 86400000).toISOString();
    fs.writeFileSync(recFile, JSON.stringify(arr, null, 2), 'utf8');
    store.setRetention(admin, 1);
    const pr = store.purgeExpiredRecords({ token: admin });
    if (pr.deleted < 1) throw new Error('应清理超期记录：' + JSON.stringify(pr));
    if (fs.existsSync(t3)) throw new Error('保留期清理后缩略图缓存未清理');
  });
  check('镜像合并剥掉派生的 photoUrl / thumbUrl 字段（不落盘）', () => {
    const items = [{
      id: 'MIRROR-1', barcode: 'MIR-1', seq: 1, photoFile: 'MIR-1/1.jpg',
      createdAt: new Date().toISOString(), username: 'ghost',
      photoUrl: 'xqy-photo://photo/x', thumbUrl: 'xqy-photo://photo/x?w=360'
    }];
    store.mirrorRecords(items);
    const arr = JSON.parse(fs.readFileSync(path.join(stDir, 'data', 'records.json'), 'utf8'));
    const saved = arr.find((x) => x.id === 'MIRROR-1');
    if (!saved) throw new Error('镜像记录未写入');
    if ('photoUrl' in saved || 'thumbUrl' in saved) throw new Error('派生 URL 不应落盘');
  });

  console.log('\n== HTTP 接口集成（/photo?w=） ==');
  const hDir = path.join(tmpDir, 'http');
  const httpStore = createStore({
    dataDir: path.join(hDir, 'data'),
    defaultPhotoDir: path.join(hDir, 'photos'),
    photoScheme: 'xqy-photo'
  });
  httpStore.ensureSeedData();
  httpStore.setMode('server');
  const hAdmin = httpStore.login({ username: 'admin', password: 'admin123' }).sessionToken;
  const hRec = httpStore.addRecord(hAdmin, { imageData: tinyJpeg, barcode: 'HT001' });

  const hThumbsDir = path.join(hDir, 'thumbs');
  const thumbSvc = createThumbService({ thumbsDir: hThumbsDir, nativeImage: fakeNativeImage({ width: 4000, jpeg: 'HTTP-THUMB' }) });
  const server = await startServer(httpStore, { port: 17998, host: '127.0.0.1', thumbs: thumbSvc });
  const apiToken = httpStore.loadConfig().token;

  const getPhoto = (query, port) => new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: port || 17998, path: '/photo?' + query, timeout: 10000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], buf: Buffer.concat(chunks) }));
    }).on('error', reject);
  });

  // 查询串统一用 URLSearchParams 构造：转义交给标准库，避免手工拼接出错
  const photoQuery = (width) => {
    const qs = new URLSearchParams();
    qs.set('f', hRec.photoFile);
    if (width) qs.set('w', String(width));
    qs.set('token', apiToken);
    return qs.toString();
  };

  const original = fs.readFileSync(httpStore.resolvePhotoFile(hRec.photoFile));

  const withW = await getPhoto(photoQuery(360));
  check('带 ?w 请求返回缩略图内容（非原图）', () => {
    if (withW.status !== 200 || withW.type !== 'image/jpeg' || withW.buf.toString() !== 'HTTP-THUMB') {
      throw new Error('status=' + withW.status + ' content=' + withW.buf.toString().slice(0, 40));
    }
  });

  const thumbOnDisk = thumbSvc.thumbFilePath(hRec.photoFile, 360);
  check('缩略图缓存已写入 thumbs 目录', () => {
    if (!fs.existsSync(thumbOnDisk)) throw new Error('缓存文件不存在：' + thumbOnDisk);
  });

  const badW = await getPhoto(photoQuery(5));
  check('非法 ?w 回退原图（不报错、图片始终可见）', () => {
    if (badW.status !== 200 || !badW.buf.equals(original)) throw new Error('status=' + badW.status + ' size=' + badW.buf.length);
  });

  const noW = await getPhoto(photoQuery());
  check('不带 ?w 仍返回原图（既有行为不变）', () => {
    if (noW.status !== 200 || !noW.buf.equals(original)) throw new Error('status=' + noW.status + ' size=' + noW.buf.length);
  });

  await server.close();

  // 未注入缩略图服务时（如精简部署 / 测试环境），?w 必须被忽略并回退原图
  const bare = await startServer(httpStore, { port: 17997, host: '127.0.0.1' });
  const noSvc = await getPhoto(photoQuery(360), 17997);
  check('未注入缩略图服务时 ?w 按原图处理', () => {
    if (noSvc.status !== 200 || !noSvc.buf.equals(original)) throw new Error('status=' + noSvc.status + ' size=' + noSvc.buf.length);
  });
  await bare.close();

  console.log('\n== 接线静态检查（协议处理器无法在脚本中运行，检查关键调用） ==');
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'main', 'server.js'), 'utf8');
  const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

  check('main.js：照片协议解析 ?w 并调用缩略图服务', () => {
    if (!/u\.searchParams\.get\('w'\)/.test(mainSrc)) throw new Error('未解析 w 参数');
    if (!/thumbService\.getOrCreate\(/.test(mainSrc)) throw new Error('未调用缩略图服务');
  });
  check('main.js：缩略图服务已创建并注入 store 与 HTTP 服务（含运行时切换模式）', () => {
    if ((mainSrc.match(/thumbsDir: THUMBS_DIR/g) || []).length !== 2) throw new Error('创建 / store 注入处数量不对');
    if ((mainSrc.match(/thumbs: thumbService/g) || []).length !== 2) throw new Error('startServer 两处调用都应注入缩略图服务');
  });
  check('server.js：/photo 支持 ?w（含宽度校验与缩略图服务调用）', () => {
    if (!/normalizeThumbSize\(/.test(serverSrc)) throw new Error('未引入宽度校验');
    if (!/thumbs\.getOrCreate\(/.test(serverSrc)) throw new Error('未调用缩略图服务');
  });
  check('renderer.js：三处网格改用缩略图，灯箱保留原图', () => {
    const grids = (rendererSrc.match(/:src="r\.thumbUrl \|\| r\.photoUrl"/g) || []).length;
    if (grids !== 3) throw new Error('网格缩略图引用应为 3 处，实际 ' + grids);
    if (!/:src="detail\.photoUrl"/.test(rendererSrc)) throw new Error('灯箱应继续使用原图');
  });

  console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
  // 测试目录位于系统临时目录，不做删除，交由操作系统例行清理
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('验证脚本异常：' + e.message);
  process.exit(1);
});
