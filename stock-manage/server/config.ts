import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CONFIG_PATH = path.resolve(ROOT, 'config.json');

export interface StockManageConfig {
  server: {
    host: string;
    port: number;
  };
  dataDir: string;
}

const DEFAULT_CONFIG: StockManageConfig = {
  server: { host: '127.0.0.1', port: 5000 },
  dataDir: 'data',
};

export function loadConfig(): StockManageConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    return DEFAULT_CONFIG;
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<StockManageConfig>;
  return {
    server: {
      host: raw.server?.host || DEFAULT_CONFIG.server.host,
      port: raw.server?.port || DEFAULT_CONFIG.server.port,
    },
    dataDir: raw.dataDir || DEFAULT_CONFIG.dataDir,
  };
}

export function resolveDataFile(config: StockManageConfig): string {
  const dir = path.isAbsolute(config.dataDir)
    ? config.dataDir
    : path.resolve(ROOT, config.dataDir);
  return path.join(dir, 'portfolio.json');
}

export { ROOT };
