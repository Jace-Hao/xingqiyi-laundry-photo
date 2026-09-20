'use strict';

/**
 * 登录凭据保存验证：node scripts/verify-credentials.js
 *
 * 重点验证**安全属性**而非仅功能可用：
 *   1. 密码绝不明文落盘（保存后直接读原始 JSON 检查）
 *   2. 系统加密不可用时不降级为明文，只记住账号名
 *   3. 解密失败返回空密码 + 可读原因，不猜测兜底值
 *   4. 列表接口不返回密文（密文不得流到界面层）
 *   5. 取消记住密码会真正清除已存密文
 *   6. 账号数上限裁剪、脏数据容错、原子写入
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { createCredentialStore, MAX_SAVED } = require('../main/credentials');

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
function expectThrow(name, fn, keyword) {
  try {
    fn();
    ck(name, false, '未抛出异常');
  } catch (e) {
    const msg = String((e && e.message) || e);
    ck(name, !keyword || msg.includes(keyword), '异常=' + msg);
  }
}

/** 模拟 safeStorage：记录被加密过的明文，便于验证「明文未落盘」 */
function mockSafeStorage({ available = true } = {}) {
  const PREFIX = 'ENC::';
  return {
    encryptedPlain: [],
    isEncryptionAvailable: () => available,
    encryptString(s) {
      this.encryptedPlain.push(s);
      return Buffer.from(PREFIX + s, 'utf8');
    },
    decryptString(buf) {
      const s = buf.toString('utf8');
      if (!s.startsWith(PREFIX)) throw new Error('bad ciphertext');
      return s.slice(PREFIX.length);
    }
  };
}

function newStore({ available = true, name = 'cred' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xqy-cred-'));
  const filePath = path.join(dir, name + '.json');
  const safeStorage = mockSafeStorage({ available });
  const store = createCredentialStore({ filePath, safeStorage, now: () => '2026-09-20T10:00:00.000Z' });
  return { dir, filePath, safeStorage, store };
}

/** 直接读取原始 JSON 文件（绕过 store API），用于验证落盘内容 */
function readRaw(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

console.log('=== 登录凭据保存验证 ===');

console.log('\n[1] 密码不以明文落盘');
{
  const { filePath, store, safeStorage } = newStore();
  const r = store.save({ username: 'clerk01', password: 'Sup3rSecret!', rememberPassword: true, name: '小王', store: '人民路店', role: 'capture' });
  ck('保存返回成功且标记 hasPassword', r.saved === true && r.hasPassword === true, JSON.stringify(r));
  ck('无「密码未能保存」提示', r.notice === '', r.notice);

  const raw = fs.readFileSync(filePath, 'utf8');
  ck('原始文件不含明文密码', !raw.includes('Sup3rSecret!'));
  const obj = readRaw(filePath);
  const acct = obj.accounts[0];
  // 实现会对 safeStorage 返回的 Buffer 做 base64 编码后落盘，
  // 因此这里要先 base64 解码，才能还原出 mock 写入的「ENC::」前缀
  ck('落盘字段为 base64 编码的密文', typeof acct.encPassword === 'string' && /^[A-Za-z0-9+/]+=*$/.test(acct.encPassword), acct.encPassword);
  ck('密文解码后带 mock 加密前缀（证明确实经过加密通道）',
    Buffer.from(acct.encPassword, 'base64').toString('utf8').startsWith('ENC::'),
    Buffer.from(acct.encPassword, 'base64').toString('utf8'));
  ck('落盘不含 password 明文字段', acct.password === undefined && !('plainPassword' in acct));
  // 真实校验加密路径被走到：mock 记录了每次加密收到的明文
  ck('密码确实经过 safeStorage 加密', safeStorage.encryptedPlain.length === 1 && safeStorage.encryptedPlain[0] === 'Sup3rSecret!',
    JSON.stringify(safeStorage.encryptedPlain));
  ck('元信息（姓名/门店/角色）一并落盘', acct.name === '小王' && acct.store === '人民路店' && acct.role === 'capture');
}

console.log('\n[2] 系统加密不可用时不降级为明文');
{
  const { filePath, store } = newStore({ available: false });
  const r = store.save({ username: 'clerk02', password: 'Sup3rSecret!', rememberPassword: true });
  ck('仍保存成功（只记账号名）', r.saved === true, JSON.stringify(r));
  ck('hasPassword 为 false', r.hasPassword === false);
  ck('给出明确不可用原因', /凭据保护不可用/.test(r.notice), r.notice);

  const raw = fs.readFileSync(filePath, 'utf8');
  ck('密码未以明文落盘', !raw.includes('Sup3rSecret!'));
  ck('encPassword 为空（未存任何密文/明文）', readRaw(filePath).accounts[0].encPassword === null);

  const got = store.get('clerk02');
  ck('读取时返回空密码', got && got.password === '');
  ck('账号名仍可读出', got && got.username === 'clerk02');
}

console.log('\n[3] passwordSupported 反映系统能力');
{
  const okStore = newStore();
  ck('加密可用时 supported=true', okStore.store.passwordSupported() === true);
  const noStore = newStore({ available: false });
  ck('加密不可用时 supported=false', noStore.store.passwordSupported() === false);
  // safeStorage 抛异常时也应安全返回 false
  const throwing = createCredentialStore({
    filePath: path.join(os.tmpdir(), 'xqy-throw-' + Date.now() + '.json'),
    safeStorage: { isEncryptionAvailable: () => { throw new Error('boom'); } }
  });
  ck('safeStorage 抛异常时 supported=false（不崩溃）', throwing.passwordSupported() === false);
}

console.log('\n[4] 解密失败：返回空密码与原因，不猜测兜底值');
{
  const { filePath, store } = newStore();
  store.save({ username: 'clerk03', password: 'Sup3rSecret!', rememberPassword: true });
  // 篡改密文，模拟系统凭据变更 / 文件被改
  const obj = readRaw(filePath);
  obj.accounts[0].encPassword = 'ENC::' + Buffer.from('tampered').toString('base64');
  fs.writeFileSync(filePath, JSON.stringify(obj), 'utf8');

  const got = store.get('clerk03');
  ck('返回空密码而非报错崩溃', got.password === '');
  ck('给出可读原因（提示手动输入）', /无法解密/.test(got.error), got.error);
  ck('不返回任何猜测的密码值', got.password !== 'Sup3rSecret!');
}

console.log('\n[5] 列表接口不返回密文');
{
  const { store } = newStore();
  store.save({ username: 'clerk04', password: 'Sup3rSecret!', rememberPassword: true, role: 'capture', store: '人民路店', name: '小李' });
  const list = store.list();
  ck('列表含该账号', list.length === 1 && list[0].username === 'clerk04');
  ck('列表不返回 encPassword', list[0].encPassword === undefined);
  ck('列表以 hasPassword 标记代替密文', list[0].hasPassword === true);
  ck('列表不含明文密码', list[0].password === undefined);
  ck('列表带角色与门店元信息', list[0].role === 'capture' && list[0].store === '人民路店' && list[0].name === '小李');
  ck('序列化后不含明文密码', !JSON.stringify(list).includes('Sup3rSecret!'));
}

console.log('\n[6] 切换账号不会串密码（各自独立）');
{
  const { store } = newStore();
  store.save({ username: 'alice', password: 'alice-pass', rememberPassword: true });
  store.save({ username: 'bob', password: 'bob-pass', rememberPassword: true });
  ck('alice 读出 alice 的密码', store.get('alice').password === 'alice-pass');
  ck('bob 读出 bob 的密码', store.get('bob').password === 'bob-pass');
  ck('未保存密码的账号读出空', store.save({ username: 'carol', password: '', rememberPassword: true }) && store.get('carol').password === '');
}

console.log('\n[7] 取消记住密码会清除已存密文');
{
  const { filePath, store } = newStore();
  store.save({ username: 'dave', password: 'dave-pass', rememberPassword: true });
  ck('先确认已存密文', readRaw(filePath).accounts[0].encPassword !== null);

  // 之后登录时取消勾选：密码留空且 rememberPassword=false
  const r = store.save({ username: 'dave', password: '', rememberPassword: false });
  ck('保存返回 hasPassword=false', r.hasPassword === false);
  ck('密文已从文件清除', readRaw(filePath).accounts[0].encPassword === null);
  ck('读取返回空密码', store.get('dave').password === '');
  ck('账号名仍保留', store.list().some((a) => a.username === 'dave'));
}

console.log('\n[8] 密码为空时保留原有密码（不误清除）');
{
  const { store } = newStore();
  store.save({ username: 'erin', password: 'erin-pass', rememberPassword: true });
  // 下次登录未输入新密码但仍勾选记住：不应把已存密码清掉
  store.save({ username: 'erin', password: '', rememberPassword: true });
  ck('原有密码被保留', store.get('erin').password === 'erin-pass');
}

console.log('\n[9] 账号名大小写不敏感（避免同一账号存两份）');
{
  const { store } = newStore();
  store.save({ username: 'Frank', password: 'p1', rememberPassword: true });
  store.save({ username: 'frank', password: 'p2', rememberPassword: true });
  const list = store.list();
  ck('大小写不同视为同一账号', list.length === 1, '实际 ' + list.length + ' 个');
  ck('后写入的密码覆盖前者', store.get('FRANK').password === 'p2');
}

console.log('\n[10] 账号数量上限裁剪（保留最近使用）');
{
  const { store } = newStore();
  let clockIdx = 0;
  const store2 = createCredentialStore({
    filePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xqy-cap-')), 'c.json'),
    safeStorage: mockSafeStorage(),
    now: () => new Date(Date.UTC(2026, 0, 1) + clockIdx * 60000).toISOString()
  });
  for (let i = 0; i < MAX_SAVED + 5; i++) {
    clockIdx++;
    store2.save({ username: 'user' + i, password: 'pw' + i, rememberPassword: true });
  }
  const list = store2.list();
  ck('数量不超过上限', list.length === MAX_SAVED, '实际 ' + list.length + ' 上限 ' + MAX_SAVED);
  ck('被裁掉的是最久未用的账号', !list.some((a) => a.username === 'user0') && !list.some((a) => a.username === 'user4'));
  ck('最近使用的账号保留', list.some((a) => a.username === 'user' + (MAX_SAVED + 4)));
  ck('store 常量未变（与实现一致）', store.MAX_SAVED === MAX_SAVED);
}

console.log('\n[11] 脏数据与损坏文件容错');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xqy-dirty-'));
  const fp = path.join(dir, 'c.json');

  // 完全损坏的 JSON
  fs.writeFileSync(fp, '{ not valid json', 'utf8');
  let s = createCredentialStore({ filePath: fp, safeStorage: mockSafeStorage() });
  ck('损坏文件不抛异常，列表为空', Array.isArray(s.list()) && s.list().length === 0);
  ck('损坏文件可继续保存', s.save({ username: 'g', password: 'p', rememberPassword: true }).saved === true);
  ck('保存后能读回', s.get('g').password === 'p');

  // 含非法条目（缺 username / 非字符串）
  fs.writeFileSync(fp, JSON.stringify({ version: 1, accounts: [null, { username: '' }, { username: 123 }, { username: 'ok1', encPassword: null }] }), 'utf8');
  const s2 = createCredentialStore({ filePath: fp, safeStorage: mockSafeStorage() });
  const l2 = s2.list();
  ck('非法条目被丢弃，仅保留合法账号', l2.length === 1 && l2[0].username === 'ok1', JSON.stringify(l2));

  // 文件不存在
  const s3 = createCredentialStore({ filePath: path.join(dir, 'nonexistent.json'), safeStorage: mockSafeStorage() });
  ck('文件不存在时列表为空', s3.list().length === 0);
  ck('文件不存在时 get 返回 null', s3.get('nobody') === null);
}

console.log('\n[12] 缺少账号名时拒绝保存');
{
  const { store } = newStore();
  expectThrow('空账号名被拒绝', () => store.save({ username: '  ', password: 'p' }), '缺少账号名');
  expectThrow('未传账号名被拒绝', () => store.save({ password: 'p' }), '缺少账号名');
}

console.log('\n[13] 删除与清空');
{
  const { store } = newStore();
  store.save({ username: 'h1', password: 'p1', rememberPassword: true });
  store.save({ username: 'h2', password: 'p2', rememberPassword: true });
  ck('删除已存在账号返回 true', store.remove('h1') === true);
  ck('删除后读不到该账号', store.get('h1') === null);
  ck('其他账号不受影响', store.get('h2').password === 'p2');
  ck('删除不存在的账号返回 false（不抛错）', store.remove('nobody') === false);
  ck('清空后列表为空', store.clear() === true && store.list().length === 0);
  ck('清空后已存密码不可读', store.get('h2') === null);
}

console.log('\n[14] 原子写入：不残留临时文件、目录自动创建');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xqy-atomic-'));
  const fp = path.join(dir, 'sub', 'deep', 'c.json'); // 目录不存在
  const s = createCredentialStore({ filePath: fp, safeStorage: mockSafeStorage() });
  s.save({ username: 'i1', password: 'p', rememberPassword: true });
  ck('多级目录被自动创建且文件存在', fs.existsSync(fp));
  const leftover = fs.readdirSync(path.dirname(fp)).filter((f) => f.endsWith('.tmp'));
  ck('无 .tmp 临时文件残留', leftover.length === 0, leftover.join(','));
  ck('文件内容为合法 JSON', readRaw(fp).accounts.length === 1);
}

console.log('\n[15] 账号名首尾空格被清理');
{
  const { store } = newStore();
  store.save({ username: '  jane  ', password: 'p', rememberPassword: true });
  ck('保存时去除首尾空格', store.list()[0].username === 'jane', store.list()[0].username);
  ck('读取时大小写与空格均容错', store.get('  JANE ').password === 'p');
}

console.log('\n=== 结果 ===');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('失败项：');
  problems.forEach((p) => console.log('  - ' + p));
}
process.exit(fail ? 1 : 0);
