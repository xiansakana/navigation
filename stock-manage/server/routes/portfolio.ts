import { Router } from 'express';
import type { DataStore, StoredData, UserSettings } from '../storage';

function normalizeSettings(raw: unknown): UserSettings {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  const settings: UserSettings = {};
  if (o.columnVisibility && typeof o.columnVisibility === 'object') {
    settings.columnVisibility = o.columnVisibility as Record<string, boolean>;
  }
  if (typeof o.dashboardSummaryVisible === 'boolean') {
    settings.dashboardSummaryVisible = o.dashboardSummaryVisible;
  }
  if (o.finnhubUnderlyingEq && typeof o.finnhubUnderlyingEq === 'object') {
    settings.finnhubUnderlyingEq = o.finnhubUnderlyingEq as Record<string, string>;
  }
  return settings;
}

export function createPortfolioRouter(store: DataStore): Router {
  const router = Router();

  router.get('/data', (_req, res) => {
    res.json(store.read());
  });

  router.put('/data', (req, res) => {
    const body = req.body as Partial<StoredData> | undefined;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: '请求体无效' });
      return;
    }

    const portfolio = body.portfolio;
    const trades = body.trades;
    const next: StoredData = {
      version: 1,
      portfolio: {
        stocks: Array.isArray(portfolio?.stocks) ? portfolio.stocks : [],
        cash: typeof portfolio?.cash === 'number' && Number.isFinite(portfolio.cash) ? portfolio.cash : 0,
      },
      trades: Array.isArray(trades) ? trades : [],
      settings: normalizeSettings(body.settings),
      updatedAt: new Date().toISOString(),
    };

    store.write(next);
    res.json({ ok: true, updatedAt: next.updatedAt });
  });

  return router;
}
