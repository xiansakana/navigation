import { integrationConfig } from '../../shared/runtime-config.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function resolveRoot() {
  return ROOT;
}

export function loadConfig() {
  const configPath = process.env.QQQ_DIP_CONFIG_PATH || path.join(ROOT, 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error('缺少 config.json，请复制 config.example.json');
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const host = raw.server?.host || '127.0.0.1';
  const port = Number(raw.server?.port) || 5001;
  const integrations = integrationConfig();
  let stockQuotes = {};
  try { stockQuotes = JSON.parse(fs.readFileSync(path.join(ROOT, '../stock-manage/config.json'), 'utf8')); }
  catch { /* This service may be installed separately. */ }
  return {
    server: { host, port },
    dbPath: raw.dbPath || 'data/qqq-dip.db',
    finnhubApiKey: raw.finnhubApiKey || process.env.FINNHUB_API_KEY || integrations.finnhubApiKey || '',
    polygonApiKey: raw.polygonApiKey || process.env.POLYGON_API_KEY || integrations.polygonApiKey || '',
    alpacaApiKeyId: raw.alpacaApiKeyId || process.env.ALPACA_API_KEY_ID || stockQuotes.alpacaApiKeyId,
    alpacaApiSecretKey: raw.alpacaApiSecretKey || process.env.ALPACA_API_SECRET_KEY || stockQuotes.alpacaApiSecretKey,
    alpacaOvernightFeed: raw.alpacaOvernightFeed || process.env.ALPACA_OVERNIGHT_FEED || stockQuotes.alpacaOvernightFeed,
    notify: {
      desktop: raw.notify?.desktop === true,
      qq: {
        enabled: raw.notify?.qq?.enabled !== false,
        url: raw.notify?.qq?.url || 'http://127.0.0.1:8787/notify',
        token: raw.notify?.qq?.token || process.env.QQ_NOTIFY_TOKEN || integrations.notifyToken || ''
      }
    }
  };
}
