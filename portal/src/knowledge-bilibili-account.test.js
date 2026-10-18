import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createBilibiliAccount, qualitySettings } from './knowledge-bilibili-account.js';

const secret = 'session-private-value';
const key = Buffer.alloc(32, 7);
function fixture() {
  const db = new Database(':memory:'); let time = 1000000, loggedIn = true, code = 0;
  const calls = [];
  const service = createBilibiliAccount(db, { key: () => key, clock: () => time, qr: async () => 'data:image/png;base64,cXJjb2Rl',
    async fetcher(url, options) {
      calls.push({ url, headers: options.headers });
      if (url.endsWith('/generate')) return new Response(JSON.stringify({ code: 0, data: { url: 'https://account.bilibili.com/h5-app/passport/login/scan?foo=qr', qrcode_key: 'a'.repeat(32) } }));
      if (url.includes('/poll?')) {
        const headers = new Headers(); headers.append('Set-Cookie', 'SESSDATA=' + secret + '; Path=/; Secure; HttpOnly'); headers.append('Set-Cookie', 'DedeUserID=123; Path=/');
        return new Response(JSON.stringify({ code: 0, data: { code } }), { headers });
      }
      assert.equal(url, 'https://api.bilibili.com/x/web-interface/nav');
      return new Response(JSON.stringify({ code: 0, data: { isLogin: loggedIn, uname: '测试账号' } }));
    }
  });
  return { db, service, calls, advance: n => { time += n; }, login: value => { loggedIn = value; }, code: value => { code = value; } };
}
test('QR confirmation encrypts cookies with owner AAD, only public metadata leaves the server, unlink preserves defaults', async () => {
  const { db, service: s, calls } = fixture();
  try {
    assert.deepEqual(qualitySettings(), { quality: 80, strict: true });
    await s.start('a'); assert.equal((await s.poll('b')).status, 'expired');
    assert.equal((await s.poll('a')).status, 'connected');
    const row = db.prepare('select * from knowledge_bilibili_accounts where user_id=?').get('a');
    assert.ok(!JSON.stringify(row).includes(secret)); assert.ok(s.cookie('a').includes(secret));
    assert.doesNotMatch(JSON.stringify(s.public('a')), /SESSDATA|credential|session-private/);
    assert.equal(s.public('b').bound, false); assert.equal(s.cookie('b'), '');
    db.prepare('insert into knowledge_bilibili_accounts(user_id,credential_cipher) values (?,?)').run('b', row.credential_cipher);
    assert.throws(() => s.cookie('b'), /重新扫码/);
    assert.ok(calls.filter(c => c.headers.Cookie).every(c => c.url.startsWith('https://api.bilibili.com/')));
    s.saveSettings('a', { quality: 64, strict: false }); s.unlink('a');
    assert.equal(s.cookie('a'), ''); assert.equal(s.public('a').quality, 64); assert.equal(s.public('a').strict, false);
  } finally { db.close(); }
});
test('waiting, scanned, expired and invalidated credentials are distinct; checks do not silently download anonymously', async () => {
  const { db, service: s, advance, code, login } = fixture();
  try {
    code(86101); await s.start('a'); assert.equal((await s.poll('a')).status, 'waiting');
    advance(3001); code(86090); assert.equal((await s.poll('a')).status, 'scanned');
    advance(180001); assert.equal((await s.poll('a')).status, 'expired');
    code(0); await s.start('a'); await s.poll('a');
    login(false); advance(61000); assert.equal((await s.check('a')).state, 'expired');
    await assert.rejects(s.credentials('a'), /失效/);
    assert.throws(() => s.saveSettings('a', { strict: 'false' }), /请选择/);
  } finally { db.close(); }
});
test('an unlink while QR confirmation is in flight cannot restore the credentials', async () => {
  const db = new Database(':memory:'); let navResolve;
  const s = createBilibiliAccount(db, { key: () => key, qr: async () => 'data:image/png;base64,cg==', fetcher: async url => {
    if (url.endsWith('/generate')) return new Response(JSON.stringify({ code: 0, data: { url: 'https://passport.bilibili.com/scan', qrcode_key: 'b'.repeat(32) } }));
    if (url.includes('/poll?')) {
      const headers = new Headers(); headers.append('Set-Cookie', 'SESSDATA=' + secret + '; Secure'); headers.append('Set-Cookie', 'DedeUserID=123');
      return new Response(JSON.stringify({ code: 0, data: { code: 0 } }), { headers });
    }
    return new Promise(resolve => { navResolve = resolve; });
  } });
  try {
    await s.start('a'); const pending = s.poll('a');
    while (!navResolve) await new Promise(resolve => setImmediate(resolve));
    s.unlink('a'); navResolve(new Response(JSON.stringify({ code: 0, data: { isLogin: true, uname: '用户' } })));
    assert.equal((await pending).status, 'cancelled'); assert.equal(s.public('a').bound, false);
  } finally { db.close(); }
});
