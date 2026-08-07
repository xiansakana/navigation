import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

export function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  const example = path.join(ROOT, 'config.example.json');
  if (!fs.existsSync(file)) {
    if (fs.existsSync(example)) {
      fs.copyFileSync(example, file);
      throw new Error('已创建 config.json，请确认配置后重启');
    }
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const defaultFinnhub = 'd7sa5a1r01qorsvhvrlgd7sa5a1r01qorsvhvrm0';
  const defaultPolygon = 'ksTLCk4yRwmpfGycHMVKdvYIWyoAuCsb';
  return {
    server: {
      host: raw.server?.host || '127.0.0.1',
      port: Number(raw.server?.port) || 5000
    },
    dataFile: raw.dataFile || 'data/portfolio.json',
    finnhubApiKey: raw.finnhubApiKey || process.env.FINNHUB_API_KEY || defaultFinnhub,
    polygonApiKey: raw.polygonApiKey || process.env.POLYGON_API_KEY || defaultPolygon
  };
}

export function resolveDataPath(config) {
  const p = config.dataFile;
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

const EMPTY = { cash: 0, trades: [], quotes: {}, holdingsMeta: {} };

export function createStore(dataPath) {
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  if (!fs.existsSync(dataPath)) {
    fs.writeFileSync(dataPath, JSON.stringify(EMPTY, null, 2) + '\n');
  }

  function read() {
    try {
      const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      return {
        cash: Number(raw.cash) || 0,
        trades: Array.isArray(raw.trades) ? raw.trades : [],
        quotes: raw.quotes && typeof raw.quotes === 'object' ? raw.quotes : {},
        holdingsMeta: raw.holdingsMeta && typeof raw.holdingsMeta === 'object' ? raw.holdingsMeta : {}
      };
    } catch {
      return { cash: 0, trades: [], quotes: {}, holdingsMeta: {} };
    }
  }

  function write(data) {
    const tmp = dataPath + '.tmp';
    const payload = {
      cash: Number(data.cash) || 0,
      trades: Array.isArray(data.trades) ? data.trades : [],
      quotes: data.quotes && typeof data.quotes === 'object' ? data.quotes : {},
      holdingsMeta: data.holdingsMeta && typeof data.holdingsMeta === 'object' ? data.holdingsMeta : {},
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
    fs.renameSync(tmp, dataPath);
    return payload;
  }

  return { read, write };
}
