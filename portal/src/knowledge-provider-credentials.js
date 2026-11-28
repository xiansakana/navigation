import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProxyAgent } from 'undici';
import { summaryModelIds } from './knowledge-model.js';

const field = 'providerCredentials';
function masterKey() {
  const file = process.env.KNOWLEDGE_PROVIDER_KEY_FILE || fileURLToPath(new URL('../data/knowledge-provider.key', import.meta.url));
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try { fs.writeFileSync(file, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const key = fs.readFileSync(file);
  if (key.length !== 32) throw new Error('模型凭据加密配置无效');
  return key;
}
export function providerName(value) {
  if (!['gemini', 'openai'].includes(value)) throw new Error('请选择 Gemini 或兼容 OpenAI API');
  return value;
}
function stored(row) { return JSON.parse(row?.model_settings_json || '{}'); }
function sealed(uid, provider, secret, master) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', master(), iv);
  cipher.setAAD(Buffer.from(JSON.stringify([uid, provider])));
  const payload = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), payload]).toString('base64');
}
function unsealed(uid, provider, value, master) {
  try {
    const data = Buffer.from(value, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', master(), data.subarray(0, 12));
    decipher.setAAD(Buffer.from(JSON.stringify([uid, provider])));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  } catch { throw new Error('模型凭据无法读取，请重新保存 API Key'); }
}
export function knowledgeProviderCredentials(db, master = masterKey) {
  const pg = !!db.query;
  const row = async uid => pg
    ? (await db.query('SELECT model_settings_json FROM navigation.knowledge_settings WHERE user_id=$1', [uid])).rows[0]
    : db.prepare('SELECT model_settings_json FROM knowledge_settings WHERE user_id=?').get(uid);
  return {
    async status(uid) {
      const config = stored(await row(uid))[field] || {};
      return { gemini: !!config.gemini, openai: !!config.openai };
    },
    async read(uid, provider) {
      const value = stored(await row(uid))[field]?.[providerName(provider)];
      return value ? unsealed(uid, provider, value, master) : '';
    },
    async save(uid, provider, value) {
      providerName(provider);
      if (value !== null && (typeof value !== 'string' || !/^[!-~]{8,2048}$/.test(value.trim()))) throw new Error('请输入有效的 API Key');
      const ciphertext = value === null ? null : sealed(uid, provider, value.trim(), master);
      const update = previous => {
        const config = stored(previous);
        const providers = { ...config[field] };
        if (ciphertext) providers[provider] = ciphertext;
        else delete providers[provider];
        return JSON.stringify({ ...config, [field]: providers });
      };
      if (pg) return db.transaction(async client => {
        await client.query('INSERT INTO navigation.knowledge_settings(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING', [uid]);
        const { rows: [previous] } = await client.query('SELECT model_settings_json FROM navigation.knowledge_settings WHERE user_id=$1 FOR UPDATE', [uid]);
        await client.query('UPDATE navigation.knowledge_settings SET model_settings_json=$2 WHERE user_id=$1', [uid, update(previous)]);
      });
      return db.transaction(() => {
        db.prepare('INSERT OR IGNORE INTO knowledge_settings(user_id) VALUES(?)').run(uid);
        const previous = db.prepare('SELECT model_settings_json FROM knowledge_settings WHERE user_id=?').get(uid);
        db.prepare('UPDATE knowledge_settings SET model_settings_json=? WHERE user_id=?').run(update(previous), uid);
      }).immediate();
    },
    async geminiOwners() {
      const sql = "SELECT user_id,model_settings_json FROM TABLE_NAME WHERE model_settings_json LIKE '%\"providerCredentials\"%'";
      const rows = pg ? (await db.query(sql.replace('TABLE_NAME', 'navigation.knowledge_settings'))).rows
        : db.prepare(sql.replace('TABLE_NAME', 'knowledge_settings')).all();
      return rows.filter(row => stored(row)[field]?.gemini).map(row => row.user_id);
    }
  };
}

export function compatibleBaseUrl() {
  const url = new URL(process.env.KNOWLEDGE_OPENAI_BASE_URL || 'https://api.openai.com/v1');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('兼容 API 服务端地址必须为 HTTPS');
  return url.href.replace(/\/$/, '');
}

export async function providerModels(provider, key, { baseUrl = compatibleBaseUrl, proxyUrl, fetcher = fetch } = {}) {
  providerName(provider);
  if (!key) throw new Error('请先保存 API Key');
  const url = provider === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000' : baseUrl() + '/models';
  const headers = provider === 'gemini' ? { 'x-goog-api-key': key } : { Authorization: 'Bearer ' + key };
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  try {
    let response;
    try { response = await fetcher(url, { headers, redirect: 'error', signal: AbortSignal.timeout(12000), ...(dispatcher ? { dispatcher } : {}) }); }
    catch { throw new Error('无法连接模型服务，请检查服务地址和网络'); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('无法读取模型列表（HTTP ' + response.status + '），请检查 API Key 和服务权限');
    }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 4 * 1024 ** 2) throw new Error('模型列表超过大小限制');
      chunks.push(Buffer.from(chunk));
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const entries = provider === 'gemini'
      ? (result.models || []).filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => ({ id: String(m.name || '').replace(/^models\//, ''), name: m.displayName }))
      : (result.data || []).filter(m => m.capabilities?.chat !== false).map(m => ({ id: m.id, name: m.id }));
    const allowed = new Set(summaryModelIds(entries));
    return [...new Map(entries.filter(m => allowed.has(m.id) && (provider !== 'gemini' || /^gemini-/.test(m.id)))
      .map(m => [m.id, { id: m.id, name: String(m.name || m.id).slice(0, 160) }])).values()];
  } finally { await dispatcher?.destroy(); }
}
