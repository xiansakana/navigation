import fs from 'node:fs';
import path from 'node:path';
import { resolveDataPath } from './storage.js';
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

function normalize(raw = {}) {
  const savedSymbols = symbols(raw.settings?.symbols);
  const initialCapital = Math.max(1000, Math.min(100000000, Number(raw.settings?.paperInitialCapital) || 100000));
  const positionPct = Math.max(0.01, Math.min(1, Number(raw.settings?.paperPositionPct) || 0.1));
  const paper = raw.paper && typeof raw.paper === 'object' ? raw.paper : {};
  return {
    settings: {
      symbols: savedSymbols.length ? savedSymbols : [...DEFAULT_QUANT_SYMBOLS],
      period: ['3m', '6m', '1y', '2y', '5y'].includes(raw.settings?.period) ? raw.settings.period : '1y',
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

export function createQuantStore(config, fileOverride = '') {
  const file = fileOverride || path.join(path.dirname(resolveDataPath(config)), 'quant.json');

  function read() {
    try {
      return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn(`读取量化配置失败: ${error.message}`);
      return normalize();
    }
  }

  function write(value) {
    const payload = normalize(value);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, file);
    return payload;
  }

  return { read, write, file };
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
