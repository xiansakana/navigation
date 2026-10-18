import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const headers = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' };
const cookieNames = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];
const instances = new WeakMap();
export function qualitySettings(raw = {}, previous = {}) {
  const quality = raw.quality === undefined ? previous.quality ?? 80 : Number(raw.quality);
  const strict = raw.strict === undefined ? previous.strict ?? true : raw.strict;
  if (![80, 64, 32, 16].includes(quality) || typeof strict !== 'boolean') throw new Error('请选择1080p/720p/480p/360p，以及严格或自动降级模式');
  return { quality, strict };
}
function masterKey() {
  const file = path.resolve(process.env.KNOWLEDGE_BILIBILI_KEY_FILE || fileURLToPath(new URL('../data/knowledge-bilibili.key', import.meta.url)));
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try { fs.writeFileSync(file, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const key = fs.readFileSync(file); if (key.length !== 32) throw new Error('B站登录加密密钥无效'); return key;
}
function seal(uid, cookie, key) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(uid));
  const encrypted = Buffer.concat([cipher.update(cookie, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}
function unseal(uid, text, key) {
  try {
    const bytes = Buffer.from(text, 'base64'), cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(uid)); cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
  } catch { throw new Error('B站凭据无法读取，请重新扫码绑定'); }
}
export function loginCookies(response) {
  const entries = new Map();
  for (const line of response.headers.getSetCookie?.() || []) {
    const first = line.split(';')[0], index = first.indexOf('=');
    const name = first.slice(0, index), value = first.slice(index + 1);
    if (cookieNames.includes(name) && value && !/[\r\n;]/.test(value)) entries.set(name, value);
  }
  if (!entries.has('SESSDATA') || !entries.has('DedeUserID')) throw new Error('B站未返回有效登录凭据，请重新扫码');
  return [...entries].map(([k, v]) => k + '=' + v).join('; ');
}
export function createBilibiliAccount(db, { fetcher = fetch, key = masterKey, clock = Date.now, qr = value => QRCode.toDataURL(value, { width: 240, margin: 2 }) } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_bilibili_accounts (
    user_id TEXT PRIMARY KEY,credential_cipher TEXT NOT NULL DEFAULT '',nickname TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'unbound',last_checked INTEGER NOT NULL DEFAULT 0,
    quality INTEGER NOT NULL DEFAULT 80,strict INTEGER NOT NULL DEFAULT 1);`);
  const sessions = new Map();
  const row = uid => db.prepare('SELECT * FROM knowledge_bilibili_accounts WHERE user_id=?').get(uid);
  const ensure = uid => db.prepare('INSERT OR IGNORE INTO knowledge_bilibili_accounts(user_id) VALUES (?)').run(uid);
  async function request(origin, route, cookie = '') {
    let response;
    try { response = await fetcher(origin + route, { headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) }, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error('B站登录服务连接失败，请稍后重试'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error('B站登录服务暂时不可用（HTTP ' + response.status + '）'); }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 1024 ** 2) throw new Error('B站登录响应异常'); chunks.push(Buffer.from(chunk)); }
    let result;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('B站登录响应无效'); }
    if (result.code !== 0 && !(origin === 'https://api.bilibili.com' && result.code === -101)) throw new Error('B站登录请求失败，请稍后重试');
    return { data: result.data, response };
  }
  const service = {
    public(uid) {
      const r = row(uid);
      return { bound: !!r?.credential_cipher, state: r?.state || 'unbound', nickname: r?.nickname || '', lastChecked: r?.last_checked || 0,
        ...qualitySettings({}, r ? { quality: r.quality, strict: !!r.strict } : {}) };
    },
    saveSettings(uid, raw) {
      const s = qualitySettings(raw, this.public(uid)); ensure(uid);
      db.prepare('UPDATE knowledge_bilibili_accounts SET quality=?,strict=? WHERE user_id=?').run(s.quality, s.strict ? 1 : 0, uid);
      return this.public(uid);
    },
    cookie(uid) {
      const r = row(uid);
      if (!r?.credential_cipher) return '';
      if (r.state === 'expired') throw new Error('B站登录已失效，请在处理设置中重新扫码绑定');
      return unseal(uid, r.credential_cipher, key());
    },
    async check(uid, force = true) {
      const r = row(uid); if (!r?.credential_cipher) return this.public(uid);
      if (!force && r.last_checked > clock() - 60000) { this.cookie(uid); return this.public(uid); }
      const cookie = unseal(uid, r.credential_cipher, key());
      const { data } = await request('https://api.bilibili.com', '/x/web-interface/nav', cookie);
      // Never revive credentials if a concurrent unlink/rebind has replaced them.
      db.prepare('UPDATE knowledge_bilibili_accounts SET state=?,nickname=?,last_checked=? WHERE user_id=? AND credential_cipher=?')
        .run(data?.isLogin === true ? 'connected' : 'expired', data?.isLogin === true ? String(data.uname || '').slice(0, 100) : r.nickname, clock(), uid, r.credential_cipher);
      return this.public(uid);
    },
    async credentials(uid) { await this.check(uid, false); return this.cookie(uid); },
    async start(uid) {
      for (const [owner, pending] of sessions) if (pending.expiresAt < clock()) sessions.delete(owner);
      const previous = sessions.get(uid);
      if (previous?.starting) throw new Error('二维码正在生成，请稍候');
      if (previous && previous.expiresAt > clock()) return { qrImage: previous.qrImage, expiresAt: previous.expiresAt };
      if (sessions.size > 10000) throw new Error('扫码请求过多，请稍后重试');
      const pending = { expiresAt: clock() + 180000, starting: true }; sessions.set(uid, pending);
      try {
        const { data } = await request('https://passport.bilibili.com', '/x/passport-login/web/qrcode/generate');
        const u = new URL(data?.url);
        if (u.protocol !== 'https:' || !['passport.bilibili.com', 'account.bilibili.com'].includes(u.hostname) || u.username || u.password || u.port || u.href.length > 4096 || !/^[a-zA-Z0-9_-]{16,256}$/.test(data?.qrcode_key || '')) throw new Error('B站二维码无效');
        pending.key = data.qrcode_key; pending.qrImage = await qr(u.href); pending.starting = false;
        if (sessions.get(uid) !== pending) throw new Error('扫码已取消');
        return { qrImage: pending.qrImage, expiresAt: pending.expiresAt };
      } catch (e) { if (sessions.get(uid) === pending) sessions.delete(uid); throw e; }
    },
    async poll(uid) {
      const pending = sessions.get(uid);
      if (!pending || pending.expiresAt < clock()) { sessions.delete(uid); return { status: 'expired' }; }
      if (pending.starting || pending.busy || pending.nextPoll > clock()) return { status: 'waiting' };
      pending.busy = true; pending.nextPoll = clock() + 3000;
      try {
        const { data, response } = await request('https://passport.bilibili.com', '/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(pending.key));
        if (sessions.get(uid) !== pending) return { status: 'cancelled' };
        if (data?.code === 86038) { sessions.delete(uid); return { status: 'expired' }; }
        if (data?.code === 86090) return { status: 'scanned' };
        if (data?.code === 86101) return { status: 'waiting' };
        if (data?.code !== 0) throw new Error('B站扫码状态异常，请重新扫码');
        const cookie = loginCookies(response);
        const { data: account } = await request('https://api.bilibili.com', '/x/web-interface/nav', cookie);
        if (sessions.get(uid) !== pending) return { status: 'cancelled' };
        if (account?.isLogin !== true) throw new Error('B站登录未生效，请重新扫码');
        ensure(uid);
        db.prepare("UPDATE knowledge_bilibili_accounts SET credential_cipher=?,nickname=?,state='connected',last_checked=? WHERE user_id=?")
          .run(seal(uid, cookie, key()), String(account.uname || '').slice(0, 100), clock(), uid);
        sessions.delete(uid); return { status: 'connected', account: this.public(uid) };
      } finally { pending.busy = false; }
    },
    unlink(uid) {
      sessions.delete(uid);
      db.prepare("UPDATE knowledge_bilibili_accounts SET credential_cipher='',nickname='',state='unbound',last_checked=0 WHERE user_id=?").run(uid);
      return this.public(uid);
    }
  };
  return service;
}
export function bilibiliAccount(db) {
  if (!instances.has(db)) instances.set(db, createBilibiliAccount(db));
  return instances.get(db);
}
