import fs from 'node:fs';
import path from 'node:path';

export interface PortfolioSnapshot {
  stocks: unknown[];
  cash: number;
}

export interface UserSettings {
  columnVisibility?: Record<string, boolean>;
  dashboardSummaryVisible?: boolean;
  finnhubUnderlyingEq?: Record<string, string>;
}

export interface StoredData {
  version: number;
  portfolio: PortfolioSnapshot;
  trades: unknown[];
  settings: UserSettings;
  updatedAt: string;
}

const EMPTY: StoredData = {
  version: 1,
  portfolio: { stocks: [], cash: 0 },
  trades: [],
  settings: {},
  updatedAt: new Date(0).toISOString(),
};

export class DataStore {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      this.write(EMPTY);
    }
  }

  read(): StoredData {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoredData>;
      return {
        version: parsed.version || 1,
        portfolio: {
          stocks: Array.isArray(parsed.portfolio?.stocks) ? parsed.portfolio.stocks : [],
          cash: typeof parsed.portfolio?.cash === 'number' ? parsed.portfolio.cash : 0,
        },
        trades: Array.isArray(parsed.trades) ? parsed.trades : [],
        settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {},
        updatedAt: parsed.updatedAt || new Date().toISOString(),
      };
    } catch (err) {
      console.error('读取数据文件失败，使用空数据:', err);
      return { ...EMPTY, updatedAt: new Date().toISOString() };
    }
  }

  write(data: StoredData): void {
    const tmp = this.filePath + '.tmp';
    const payload = {
      ...data,
      version: 1,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}
