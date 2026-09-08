import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function keysFromStockManage() {
  const storagePath = path.resolve(ROOT, '..', 'stock-manage', 'src', 'storage.js');
  if (!fs.existsSync(storagePath)) return { finnhub: '', polygon: '' };
  const text = fs.readFileSync(storagePath, 'utf8');
  const fh = text.match(/defaultFinnhub\s*=\s*'([^']+)'/);
  const pg = text.match(/defaultPolygon\s*=\s*'([^']+)'/);
  return { finnhub: fh?.[1] || '', polygon: pg?.[1] || '' };
}

export function resolveRoot() {
  return ROOT;
}

export function loadConfig() {
  const configPath = path.join(ROOT, 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error('缺少 config.json，请复制 config.example.json');
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const host = raw.server?.host || '127.0.0.1';
  const port = Number(raw.server?.port) || 5001;
  const fallback = keysFromStockManage();
  return {
    server: { host, port },
    dbPath: raw.dbPath || 'data/qqq-dip.db',
    finnhubApiKey: raw.finnhubApiKey || process.env.FINNHUB_API_KEY || fallback.finnhub,
    polygonApiKey: raw.polygonApiKey || process.env.POLYGON_API_KEY || fallback.polygon,
    notify: {
      desktop: raw.notify?.desktop === true,
      qq: {
        enabled: raw.notify?.qq?.enabled !== false,
        url: raw.notify?.qq?.url || 'http://127.0.0.1:8787/notify',
        token: raw.notify?.qq?.token || process.env.QQ_NOTIFY_TOKEN || ''
      }
    }
  };
}
