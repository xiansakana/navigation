import fs from 'node:fs';
import path from 'node:path';
import {
  getDatabase,
  resolveDbPath,
  createPortfolioStore,
  defaultPortfolioJsonPath
} from '../../shared/db/index.js';

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
    dbPath: raw.dbPath || 'data/navigation.db',
    dataFile: raw.dataFile || 'data/portfolio.json',
    finnhubApiKey: raw.finnhubApiKey || process.env.FINNHUB_API_KEY || defaultFinnhub,
    polygonApiKey: raw.polygonApiKey || process.env.POLYGON_API_KEY || defaultPolygon
  };
}

export function resolveDataPath(config) {
  const p = config.dataFile || 'data/portfolio.json';
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

export function createStore(config) {
  const legacyJsonPath = resolveDataPath(config);
  const dbPath = resolveDbPath(config.dbPath);
  const db = getDatabase({
    dbPath: dbPath,
    portfolioJsonPath: legacyJsonPath
  });
  return createPortfolioStore(db);
}

export { defaultPortfolioJsonPath };
