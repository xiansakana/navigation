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
  return {
    server: {
      host: raw.server?.host || '127.0.0.1',
      port: Number(raw.server?.port) || 5000
    },
    dataFile: raw.dataFile || 'data/portfolio.json',
    finnhubApiKey: raw.finnhubApiKey || process.env.FINNHUB_API_KEY || '',
    polygonApiKey: raw.polygonApiKey || process.env.POLYGON_API_KEY || ''
  };
}

export function resolveDataPath(config) {
  const p = config.dataFile;
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

const EMPTY = { cash: 0, trades: [], quotes: {} };

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
        quotes: raw.quotes && typeof raw.quotes === 'object' ? raw.quotes : {}
      };
    } catch {
      return { ...EMPTY };
    }
  }

  function write(data) {
    const tmp = dataPath + '.tmp';
    const payload = {
      cash: Number(data.cash) || 0,
      trades: Array.isArray(data.trades) ? data.trades : [],
      quotes: data.quotes && typeof data.quotes === 'object' ? data.quotes : {},
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
    fs.renameSync(tmp, dataPath);
    return payload;
  }

  return { read, write };
}
