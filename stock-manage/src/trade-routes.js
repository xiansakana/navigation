import { applyCashDelta, undoCashDelta } from './trades.js';

export function registerTradeRoutes(app, {
  store, hasStockPermission, requireStockPermission, recordNamedTrade, backfillSavedTrades, sendPortfolio
}) {
  app.post('/api/trades', async (req, res) => {
    if (!hasStockPermission(req, 'trade', 'edit') && !requireStockPermission(req, res, 'row-trade', 'edit')) return;
    try {
      const { trade, quote } = await recordNamedTrade(req.body || {});
      const strategyFundId = req.body.funding === 'dip' ? trade.account_id : undefined;
      if (req.body.funding === 'dip') {
        if (trade.reinvestedDividend) return res.status(400).json({ error: '红利再投资不使用现金资金' });
        if (!requireStockPermission(req, res, 'dip-spend', 'edit')) return;
        if (!strategyFundId) return res.status(400).json({ error: '抄底成交须明确选择证券账户' });
      }
      const data = store.read();
      if (quote && !data.quotes[trade.symbol]) data.quotes[trade.symbol] = quote;
      data.trades.push(trade);
      Object.assign(data, applyCashDelta(data, trade));
      store.write(data, { strategyFundId });
      backfillSavedTrades([trade]);
      sendPortfolio(res, req);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.put('/api/trades/:id', async (req, res) => {
    if (!requireStockPermission(req, res, 'trade', 'edit')) return;
    try {
      const { trade, quote } = await recordNamedTrade({ ...req.body, id: req.params.id });
      const data = store.read();
      const i = data.trades.findIndex((t) => t.id === req.params.id);
      if (i < 0) return res.status(404).json({ error: '未找到' });
      const old = data.trades[i];
      if (old.dip_fund_account && !requireStockPermission(req, res, 'dip-spend', 'edit')) return;
      if (quote && !data.quotes[trade.symbol]) data.quotes[trade.symbol] = quote;
      const brokerFields = old.broker_order_key ? {
        ...Object.fromEntries(Object.entries(old).filter(([key]) => key.startsWith('broker_'))),
        broker: old.broker, cash_effective_at: old.cash_effective_at, repo_principal: old.repo_principal,
        source_trade_date: old.source_trade_date, settlement_date: old.settlement_date, security_received_at: old.security_received_at
      } : {};
      if (old.broker_category === 'Stockback 回赠' && old.total_amount === 0 && old.symbol === trade.symbol && trade.type === 'buy') trade.total_amount = 0;
      data.trades[i] = { ...trade, ...brokerFields, id: req.params.id, created_at: old.created_at || trade.created_at };
      Object.assign(data, applyCashDelta(undoCashDelta(data, old), data.trades[i]));
      store.write(data);
      backfillSavedTrades([old, data.trades[i]]);
      sendPortfolio(res, req);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/trades/:id', (req, res) => {
    if (!requireStockPermission(req, res, 'trade', 'edit')) return;
    const data = store.read();
    const i = data.trades.findIndex((t) => t.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: '未找到' });
    const old = data.trades[i];
    if (old.dip_fund_account && !requireStockPermission(req, res, 'dip-spend', 'edit')) return;
    data.trades.splice(i, 1);
    Object.assign(data, undoCashDelta(data, old));
    try { store.write(data); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    sendPortfolio(res, req);
  });
}
