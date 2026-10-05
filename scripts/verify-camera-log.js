'use strict';

/**
 * 摄像头日志模块（main/camera-log.js）纯逻辑验证。
 *
 * 与既有 verify-*.js 风格一致：node 直跑、不依赖 Electron、不依赖真实摄像头。
 * 覆盖：字段完整性、单行 JSON 可解析、deviceId 截断、err/res 归一、轮转、
 *       跨天/7 天清理、目录不可写静默降级、队列上限、退出冲刷。
 *
 * 用法：node scripts/verify-camera-log.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCameraLog, buildLine, MAX_FILE_BYTES } = require('../main/camera-log');

let pass = 0;
const failures = [];

function ok(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    failures.push(name + '：' + (e && e.message ? e.message : e));
  }
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'camlog-' + tag + '-'));
}

/** 让异步落盘有机会完成：轮询等待条件成立，超时返回最后一次判定 */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 3000);
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

function readLines(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length)
    .map((l) => JSON.parse(l));
}

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

function todayName(dir, base) {
  const d = base || new Date();
  return path.join(dir, 'camera-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.log');
}

// ---------- 1. 行格式：固定 9 字段、单行 JSON、缺项写 null ----------
ok('固定 9 字段恒存在且顺序固定', () => {
  const line = JSON.parse(buildLine('info', 'CAM_GUM_OK', {}));
  assert.deepStrictEqual(Object.keys(line).slice(0, 9), [
    'ts', 'level', 'event', 'seq', 'device', 'attempt', 'reason', 'err', 'res'
  ]);
  assert.strictEqual(line.seq, null);
  assert.strictEqual(line.device, null);
  assert.strictEqual(line.attempt, null);
  assert.strictEqual(line.reason, null);
  assert.strictEqual(line.err, null);
  assert.strictEqual(line.res, null);
});

ok('单行 JSON：不含换行，ts 为可解析时间戳', () => {
  const s = buildLine('warn', 'CAM_RETRY', { attempt: 2 });
  assert.strictEqual(s.indexOf('\n'), -1, '单行不能含换行');
  const o = JSON.parse(s);
  assert.ok(!isNaN(Date.parse(o.ts)), 'ts 必须可解析为时间');
  assert.strictEqual(o.level, 'warn');
  assert.strictEqual(o.event, 'CAM_RETRY');
  assert.strictEqual(o.attempt, 2);
});

ok('deviceId 只记前 8 位（不落完整设备标识）', () => {
  const o = JSON.parse(buildLine('info', 'CAM_LIVE', { device: 'abcdefghijklmnop' }));
  assert.strictEqual(o.device, 'abcdefgh');
});

ok('err 归一为 { name, message }；原始 Error 与字符串都能收', () => {
  const o = JSON.parse(buildLine('error', 'CAM_GUM_FAIL', { err: new Error('设备被占用') }));
  assert.deepStrictEqual(o.err, { name: 'Error', message: '设备被占用' });
  const s = JSON.parse(buildLine('error', 'CAM_GUM_FAIL', { err: 'NotReadableError' }));
  assert.deepStrictEqual(s.err, { name: null, message: 'NotReadableError' });
});

ok('res 归一为 { w, h }；两个数都取不到时为 null', () => {
  assert.deepStrictEqual(JSON.parse(buildLine('info', 'CAM_LIVE', { res: { w: 1280, h: 720 } })).res, { w: 1280, h: 720 });
  assert.strictEqual(JSON.parse(buildLine('info', 'CAM_LIVE', { res: {} })).res, null);
});

ok('非法 level 归 info，空 event 归 CAM_UNKNOWN', () => {
  const o = JSON.parse(buildLine('verbose', '', {}));
  assert.strictEqual(o.level, 'info');
  assert.strictEqual(o.event, 'CAM_UNKNOWN');
});

ok('非有限数一律归 null，不产生 NaN/Infinity', () => {
  const o = JSON.parse(buildLine('info', 'CAM_LIVE', { seq: NaN, attempt: Infinity }));
  assert.strictEqual(o.seq, null);
  assert.strictEqual(o.attempt, null);
  assert.strictEqual(JSON.stringify(o).indexOf('NaN'), -1);
});

ok('对象/数组附加字段被丢弃，原始类型保留', () => {
  const o = JSON.parse(
    buildLine('info', 'CAM_LIVE', { state: 'LIVE', muted: false, extra: { a: 1 }, list: [1, 2] })
  );
  assert.strictEqual(o.state, 'LIVE');
  assert.strictEqual(o.muted, false);
  assert.strictEqual(o.extra, undefined);
  assert.strictEqual(o.list, undefined);
});

ok('__proto__ 等危险键被跳过，不污染原型', () => {
  const o = JSON.parse(buildLine('info', 'CAM_LIVE', JSON.parse('{"__proto__":{"polluted":1}}')));
  assert.strictEqual({}.polluted, undefined);
  assert.strictEqual(o.polluted, undefined);
});

ok('超长错误文案被截断', () => {
  const o = JSON.parse(buildLine('error', 'CAM_GUM_FAIL', { err: { name: 'E', message: 'x'.repeat(5000) } }));
  assert.ok(o.err.message.length <= 300, 'message 应被截断到 300 以内');
});

// ---------- 2. 落盘行为 ----------
(async () => {
  // 2.1 正常写入：文件创建、每行可 JSON.parse
  {
    const dir = tmpDir('basic');
    const log = createCameraLog({ dir });
    assert.strictEqual(log.init(), true, 'init 应成功');
    log.write('info', 'CAM_MOUNT', { reason: 'mount' });
    log.write('info', 'CAM_GUM_OK', { device: 'dev-0001-xyz', seq: 1 });
    const file = todayName(dir);
    assert.ok(await waitFor(() => fs.existsSync(file), 3000), '日志文件应已创建');
    await waitFor(() => readLines(file).length === 2, 3000);
    const lines = readLines(file);
    assert.strictEqual(lines[0].event, 'CAM_MOUNT');
    assert.strictEqual(lines[1].device, 'dev-0001');
    pass++;
  }

  // 2.2 路径与契约一致：<dir>/camera-YYYYMMDD.log
  {
    const dir = tmpDir('path');
    const log = createCameraLog({ dir });
    assert.strictEqual(log.currentPath(), todayName(dir));
    pass++;
  }

  // 2.3 目录不可写 → 静默降级：write 不抛、不落文件、主流程可继续
  {
    // 用文件冒充目录，mkdirSync 必然失败
    const blocked = path.join(tmpDir('bad'), 'occupied');
    fs.writeFileSync(blocked, '');
    const log = createCameraLog({ dir: blocked });
    assert.strictEqual(log.init(), false, 'init 应返回 false');
    assert.strictEqual(log.isDisabled(), true, '应标记为已停用');
    let threw = false;
    try {
      log.write('info', 'CAM_MOUNT', {});
    } catch (e) {
      threw = true;
    }
    assert.strictEqual(threw, false, 'write 绝不能抛异常（否则会打断拍照）');
    assert.strictEqual(log.write('info', 'CAM_MOUNT', {}), false);
    pass++;
  }

  // 2.4 轮转：超过 2 MB 把当前文件另存 .1 并重建
  {
    const dir = tmpDir('rotate');
    const log = createCameraLog({ dir });
    log.init();
    const file = todayName(dir);
    const backup = file + '.1';
    const padding = 'capture-ok-padding-padding-padding-padding-padding';
    for (let i = 0; i < 16000; i++) {
      log.write('info', 'CAM_CAPTURE_OK', { seq: i, reason: padding });
      if (i % 200 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    assert.ok(await waitFor(() => fs.existsSync(backup), 8000), '超过 2 MB 应触发轮转并生成 .1');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(fs.existsSync(file), '轮转后应重建当日文件');
    const cur = fs.statSync(file).size;
    const old = fs.statSync(backup).size;
    assert.ok(cur + old > 1024 * 1024, '应确实写入了大量内容');
    assert.ok(cur <= MAX_FILE_BYTES, '当前文件不应超过轮转阈值');
    for (const l of readLines(file)) assert.strictEqual(l.event, 'CAM_CAPTURE_OK');
    pass++;
  }

  // 2.5 7 天清理：过期历史被删，近期与非日志文件保留
  {
    const dir = tmpDir('retain');
    fs.writeFileSync(path.join(dir, 'camera-20200101.log'), 'old\n');
    fs.writeFileSync(path.join(dir, 'camera-20200101.log.1'), 'old\n');
    const recent = todayName(dir, new Date(Date.now() - 2 * 24 * 3600 * 1000));
    fs.writeFileSync(recent, 'recent\n');
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'keep\n');
    const log = createCameraLog({ dir });
    log.init();
    assert.strictEqual(fs.existsSync(path.join(dir, 'camera-20200101.log')), false, '过期日志应被清理');
    assert.strictEqual(fs.existsSync(path.join(dir, 'camera-20200101.log.1')), false, '过期备份应被清理');
    assert.strictEqual(fs.existsSync(recent), true, '2 天前的日志应保留');
    assert.strictEqual(fs.existsSync(path.join(dir, 'unrelated.txt')), true, '非日志文件不应被动');
    pass++;
  }

  // 2.6 退出冲刷：队列中的行在 flushSync 后同步落盘
  {
    const dir = tmpDir('flush');
    const log = createCameraLog({ dir });
    log.init();
    log.write('info', 'CAM_UNMOUNT', { reason: 'unmount' });
    log.write('info', 'CAM_LEAK_GUARD', { reason: 'stale-token', seq: 3 });
    log.flushSync(); // 不等事件循环，立即落盘
    const lines = readLines(todayName(dir));
    assert.strictEqual(lines.length, 2, 'flushSync 后应有 2 行');
    assert.strictEqual(lines[1].event, 'CAM_LEAK_GUARD');
    pass++;
  }

  // 2.7 队列上限：极端积压时不无限增长（丢最旧、保最新）
  {
    const dir = tmpDir('cap');
    const log = createCameraLog({ dir });
    log.init();
    for (let i = 0; i < 5000; i++) log.write('info', 'CAM_RETRY', { attempt: i });
    log.flushSync();
    const lines = readLines(todayName(dir));
    assert.ok(lines.length <= 400, '队列上限 400，实际 ' + lines.length);
    assert.strictEqual(lines[lines.length - 1].attempt, 4999, '应保留最新的一条');
    pass++;
  }

  // 2.8 未 init 直接 write 也能懒初始化
  {
    const dir = tmpDir('lazy');
    const log = createCameraLog({ dir });
    log.write('info', 'CAM_MOUNT', {});
    assert.ok(await waitFor(() => fs.existsSync(todayName(dir)), 3000), '懒初始化应自动建目录');
    pass++;
  }

  // 2.9 未给 dir 时彻底停用且不抛
  {
    const log = createCameraLog({});
    assert.strictEqual(log.isDisabled(), true);
    assert.strictEqual(log.write('info', 'CAM_MOUNT', {}), false);
    assert.strictEqual(log.currentPath(), '');
    pass++;
  }

  console.log('');
  console.log('摄像头日志模块验证：通过 ' + pass + ' 项，失败 ' + failures.length + ' 项');
  if (failures.length) {
    for (const f of failures) console.error('  ✗ ' + f);
    process.exit(1);
  }
  console.log('全部通过');
})().catch((e) => {
  console.error('验证脚本异常：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
