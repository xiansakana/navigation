import fs from 'node:fs';
import path from 'node:path';
import { resolveDataPath } from './storage.js';
import { getDatabase } from '../../shared/db/index.js';
import { DEFAULT_QUANT_CONFIG, normalizeQuantConfig } from './quant-analysis.js';

export const DEFAULT_QUANT_SYMBOLS = Object.freeze([
  'AAPL', 'MSFT', 'NVDA', 'GOOG', 'AMZN', 'META', 'TSM', 'AVGO', 'SOXX', 'SOXL'
]);

function symbols(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((symbol) => String(symbol || '').trim().toUpperCase())
    .filter((symbol) => /^[A-Z0-9][A-Z0-9.-]{0,23}$/.test(symbol)))]
    .slice(0, 30);
}

export function normalizeQuantState(raw = {}) {
  const savedSymbols = symbols(raw.settings?.symbols);
  const initialCapital = Math.max(1000, Math.min(100000000, Number(raw.settings?.paperInitialCapital) || 100000));
  const positionPct = Math.max(0.01, Math.min(1, Number(raw.settings?.paperPositionPct) || 0.1));
  const paper = raw.paper && typeof raw.paper === 'object' ? raw.paper : {};
  return {
    settings: {
      symbols: savedSymbols.length ? savedSymbols : [...DEFAULT_QUANT_SYMBOLS],
      period: ['3m', '6m', '1y', '2y', '5y'].includes(raw.settings?.period) ? raw.settings.period : '1y',
      backtestPeriod: ['6m', '1y', '2y', '5y'].includes(raw.settings?.backtestPeriod) ? raw.settings.backtestPeriod : '1y',
      backtestInitialCapital: Math.max(1000, Math.min(100000000, Number(raw.settings?.backtestInitialCapital) || 100000)),
      config: normalizeQuantConfig(raw.settings?.config || DEFAULT_QUANT_CONFIG),
      paperInitialCapital: initialCapital,
      paperPositionPct: positionPct
    },
    paper: {
      initialCapital: Number(paper.initialCapital) > 0 ? Number(paper.initialCapital) : initialCapital,
      cash: Number.isFinite(Number(paper.cash)) ? Number(paper.cash) : initialCapital,
      holdings: paper.holdings && typeof paper.holdings === 'object' ? paper.holdings : {},
      trades: Array.isArray(paper.trades) ? paper.trades.slice(-500) : [],
      processedSignals: paper.processedSignals && typeof paper.processedSignals === 'object' ? paper.processedSignals : {},
      updatedAt: Number(paper.updatedAt) || null
    }
  };
}

export function createQuantStore(config, databaseOverride = null) {
  const database = databaseOverride || getDatabase({ dbPath: config.dbPath });
  const legacyFile = path.join(path.dirname(resolveDataPath(config)), 'quant.json');
  const select = database.prepare('SELECT data FROM quant_user_state WHERE user_id = ?');
  const upsert = database.prepare(`
    INSERT INTO quant_user_state (user_id, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `);

  function safeUserId(userId) {
    const value = String(userId || 'local').trim();
    return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : 'local';
  }

  function legacyState(userId) {
    if (userId !== 'usr_admin' && userId !== 'local') return null;
    try {
      return normalizeQuantState(JSON.parse(fs.readFileSync(legacyFile, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn(`读取旧量化配置失败: ${error.message}`);
      return null;
    }
  }

  function read(userId = 'local') {
    const owner = safeUserId(userId);
    try {
      const row = select.get(owner);
      if (row?.data) return normalizeQuantState(JSON.parse(row.data));
    } catch (error) {
      console.warn(`读取用户量化配置失败: ${error.message}`);
    }
    const migrated = legacyState(owner);
    if (migrated) return write(owner, migrated);
    return normalizeQuantState();
  }

  function write(userId = 'local', value) {
    const owner = safeUserId(userId);
    const payload = normalizeQuantState(value);
    upsert.run(owner, JSON.stringify(payload), new Date().toISOString());
    return payload;
  }

  return { read, write };
}

export function resetPaper(settings) {
  const initialCapital = Math.max(1000, Number(settings?.paperInitialCapital) || 100000);
  return {
    initialCapital,
    cash: initialCapital,
    holdings: {},
    trades: [],
    processedSignals: {},
    updatedAt: Date.now()
  };
}
