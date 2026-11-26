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
  const postgres = !!db.query;
  if (!postgres) db.exec(`CREATE TABLE IF NOT EXISTS knowledge_bilibili_accounts (
    user_id TEXT PRIMARY KEY,credential_cipher TEXT NOT NULL DEFAULT '',nickname TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'unbound',last_checked INTEGER NOT NULL DEFAULT 0,
    quality INTEGER NOT NULL DEFAULT 80,strict INTEGER NOT NULL DEFAULT 1);`);
  const sessions = new Map();
  const credentialsWrites = new Map();
  const row = (uid, client = db) => postgres
    ? client.query('SELECT * FROM navigation.knowledge_bilibili_accounts WHERE user_id=$1', [uid]).then(result => result.rows[0])
    : db.prepare('SELECT * FROM knowledge_bilibili_accounts WHERE user_id=?').get(uid);
  const ensure = uid => db.prepare('INSERT OR IGNORE INTO knowledge_bilibili_accounts(user_id) VALUES (?)').run(uid);
  const publicFields = r => ({ bound: !!r?.credential_cipher, state: r?.state || 'unbound', nickname: r?.nickname || '', lastChecked: Number(r?.last_checked || 0),
    ...qualitySettings({}, r ? { quality: Number(r.quality), strict: !!Number(r.strict) } : {}) });
  const readCookie = (uid, r) => {
    if (!r?.credential_cipher) return '';
    if (r.state === 'expired') throw new Error('B站登录已失效，请在处理设置中重新扫码绑定');
    return unseal(uid, r.credential_cipher, key());
  };
  function writeCredential(uid, write) {
    const pending = (credentialsWrites.get(uid) || Promise.resolve()).catch(() => {}).then(write);
    credentialsWrites.set(uid, pending);
    return pending.finally(() => { if (credentialsWrites.get(uid) === pending) credentialsWrites.delete(uid); });
  }
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
      return postgres ? row(uid).then(publicFields) : publicFields(row(uid));
    },
    saveSettings(uid, raw) {
      if (postgres) return db.transaction(async client => {
        await client.query('INSERT INTO navigation.knowledge_bilibili_accounts(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING', [uid]);
        const { rows: [previous] } = await client.query('SELECT * FROM navigation.knowledge_bilibili_accounts WHERE user_id=$1 FOR UPDATE', [uid]);
        const s = qualitySettings(raw, publicFields(previous));
        const { rows: [saved] } = await client.query('UPDATE navigation.knowledge_bilibili_accounts SET quality=$2,strict=$3 WHERE user_id=$1 RETURNING *',
          [uid, s.quality, s.strict ? 1 : 0]);
        return publicFields(saved);
      });
      const s = qualitySettings(raw, this.public(uid)); ensure(uid);
      db.prepare('UPDATE knowledge_bilibili_accounts SET quality=?,strict=? WHERE user_id=?').run(s.quality, s.strict ? 1 : 0, uid);
      return this.public(uid);
    },
    cookie(uid) {
      return postgres ? row(uid).then(r => readCookie(uid, r)) : readCookie(uid, row(uid));
    },
    async check(uid, force = true) {
      const r = await row(uid); if (!r?.credential_cipher) return publicFields(r);
      if (!force && Number(r.last_checked) > clock() - 60000) { readCookie(uid, r); return publicFields(r); }
      const cookie = unseal(uid, r.credential_cipher, key());
      const { data } = await request('https://api.bilibili.com', '/x/web-interface/nav', cookie);
      // Never revive credentials if a concurrent unlink/rebind has replaced them.
      const update = [data?.isLogin === true ? 'connected' : 'expired',
        data?.isLogin === true ? String(data.uname || '').slice(0, 100) : r.nickname, clock(), uid, r.credential_cipher];
      if (postgres) await db.query('UPDATE navigation.knowledge_bilibili_accounts SET state=$1,nickname=$2,last_checked=$3 WHERE user_id=$4 AND credential_cipher=$5', update);
      else db.prepare('UPDATE knowledge_bilibili_accounts SET state=?,nickname=?,last_checked=? WHERE user_id=? AND credential_cipher=?').run(...update);
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
        const cipher = seal(uid, cookie, key()), nickname = String(account.uname || '').slice(0, 100);
        if (postgres) {
          const saved = await writeCredential(uid, async () => {
            if (sessions.get(uid) !== pending) return false;
            await db.query(`INSERT INTO navigation.knowledge_bilibili_accounts(user_id,credential_cipher,nickname,state,last_checked)
              VALUES($1,$2,$3,'connected',$4) ON CONFLICT(user_id) DO UPDATE SET
              credential_cipher=excluded.credential_cipher,nickname=excluded.nickname,state=excluded.state,last_checked=excluded.last_checked`,
            [uid, cipher, nickname, clock()]);
            return true;
          });
          if (!saved || sessions.get(uid) !== pending) return { status: 'cancelled' };
        } else {
          ensure(uid);
          db.prepare("UPDATE knowledge_bilibili_accounts SET credential_cipher=?,nickname=?,state='connected',last_checked=? WHERE user_id=?")
            .run(cipher, nickname, clock(), uid);
        }
        sessions.delete(uid); return { status: 'connected', account: await this.public(uid) };
      } finally { pending.busy = false; }
    },
    unlink(uid) {
      sessions.delete(uid);
      if (postgres) return writeCredential(uid, async () => {
        await db.query("UPDATE navigation.knowledge_bilibili_accounts SET credential_cipher='',nickname='',state='unbound',last_checked=0 WHERE user_id=$1", [uid]);
        return this.public(uid);
      });
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
