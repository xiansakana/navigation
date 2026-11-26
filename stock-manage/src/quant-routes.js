import { mapWithConcurrency } from '../../shared/map-with-concurrency.js';
import { analyzeCandles, backtestCandles, DEFAULT_QUANT_CONFIG, normalizeQuantConfig } from './quant-analysis.js';
import { createPostgresQuantStore, createQuantStore, resetPaper } from './quant-store.js';
import { createPostgresQuantBacktestStore, createQuantBacktestStore } from './quant-backtest-store.js';
import { inferMarket, normalizeSymbol } from './markets.js';
import { deriveHoldings } from './trades.js';

function quantSymbols(raw, fallback = []) {
  const source = typeof raw === 'string' && raw.trim() ? raw.split(',') : fallback;
  return [...new Set(source
    .map((symbol) => normalizeSymbol(symbol))
    .filter((symbol) => /^[A-Z0-9][A-Z0-9.-]{0,23}$/.test(symbol)))]
    .slice(0, 30);
}

function quantPeriod(raw) {
  const periods = {
    '3m': 120,
    '6m': 220,
    '1y': 370,
    '2y': 740,
    '5y': 1825
  };
  const key = Object.hasOwn(periods, raw) ? raw : '1y';
  return { key, days: periods[key] };
}

function quantConfig(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ...DEFAULT_QUANT_CONFIG };
  try {
    return normalizeQuantConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_QUANT_CONFIG };
  }
}

function unavailableQuantSignal({ symbol, name, price, changePercent, status, message, config }) {
  return {
    ...analyzeCandles({ symbol, name, price, changePercent, candles: [], config }),
    status,
    message
  };
}

function quantRoute(handler) {
  return async (req, res) => {
    try { await handler(req, res); }
    catch (error) {
      res.status(error.status || 500).json({ error: error.status ? error.message : '量化数据暂不可用' });
    }
  };
}

export function registerQuantRoutes(app, { config, store, quotes, quantUserId, requireQuantPermission, database }) {
  const quantStore = database ? createPostgresQuantStore(config, database) : createQuantStore(config);
  const quantBacktestStore = database ? createPostgresQuantBacktestStore(database) : createQuantBacktestStore(config);

  async function analyzeQuantSymbols(rawSymbols, rawPeriod, rawConfig, userId = 'local') {
      const data = store.read();
      const holdings = deriveHoldings(data.trades);
      const holdingMap = new Map(holdings.map((holding) => [normalizeSymbol(holding.symbol), holding]));
      const saved = (await quantStore.read(userId)).settings;
      const symbols = quantSymbols(rawSymbols, saved.symbols);
      const strategyConfig = typeof rawConfig === 'string' ? quantConfig(rawConfig) : normalizeQuantConfig(rawConfig || saved.config);
      const period = quantPeriod(rawPeriod || saved.period);

      const signals = await mapWithConcurrency(symbols, 4, async (symbol) => {
        const holding = holdingMap.get(symbol);
        const storedQuote = data.quotes?.[symbol] || {};
        const name = holding?.name || storedQuote.name || symbol;
        if (inferMarket(symbol) !== 'US') {
          return unavailableQuantSignal({
            symbol,
            name,
            price: Number(storedQuote.price),
            changePercent: Number(storedQuote.changePercent),
            status: 'unsupported',
            message: '当前仅支持美股正股，A 股与期权暂不参与量化分析',
            config: strategyConfig
          });
        }

        const [quoteResult, historyResult] = await Promise.allSettled([
          quotes.getStock(symbol),
          quotes.getStockHistory(symbol, { days: period.days })
        ]);
        const quote = quoteResult.status === 'fulfilled' ? quoteResult.value : storedQuote;
        if (historyResult.status === 'rejected') {
          return unavailableQuantSignal({
            symbol,
            name: quote.name || name,
            price: Number(quote.price),
            changePercent: Number(quote.changePercent),
            status: 'error',
            message: historyResult.reason?.message || '获取历史行情失败',
            config: strategyConfig
          });
        }
        return {
          ...analyzeCandles({
          symbol,
          name: quote.name && quote.name !== symbol ? quote.name : name,
          price: Number(quote.price),
          changePercent: Number(quote.changePercent),
          candles: historyResult.value.candles,
          config: strategyConfig,
          historySource: historyResult.value.source,
          quoteSource: quote.source || null
          }),
          adjustedForSplits: historyResult.value.adjustedForSplits === true
        };
      });

      signals.sort((a, b) => {
        const rank = (signal) => signal.signal === 'BUY'
          ? signal.strength + 100
          : signal.signal === 'HOLD' ? 0 : -signal.strength - 100;
        return rank(b) - rank(a);
      });
      return {
        signals,
        config: strategyConfig,
        period: period.key,
        days: period.days,
        timestamp: Date.now()
      };
  }

  app.get('/api/analysis', async (req, res) => {
    if (!requireQuantPermission(req, res, 'quant-analysis-run', 'edit')) return;
    try {
      res.json(await analyzeQuantSymbols(req.query.symbols, req.query.period, req.query.config, quantUserId(req)));
    } catch (e) {
      res.status(500).json({ error: e.message || '量化分析失败' });
    }
  });

  app.get('/api/quant/settings', quantRoute(async (req, res) => {
    if (!requireQuantPermission(req, res, 'quant-settings')) return;
    res.json((await quantStore.read(quantUserId(req))).settings);
  }));

  app.get('/api/quant/history/:symbol', async (req, res) => {
    if (!requireQuantPermission(req, res, 'quant-history')) return;
    const symbol = quantSymbols(req.params.symbol)[0];
    if (!symbol || inferMarket(symbol) !== 'US') {
      return res.status(400).json({ error: 'K 线当前仅支持美股正股' });
    }
    try {
      const before = Number(req.query.before);
      const period = quantPeriod(req.query.period);
      const days = Number.isFinite(Number(req.query.days))
        ? Math.min(1825, Math.max(90, Number(req.query.days)))
        : period.days;
      const history = await quotes.getStockHistory(symbol, {
        days,
        endTimestamp: Number.isFinite(before) ? before - 86400000 : undefined
      });
      const candles = Number.isFinite(before)
        ? history.candles.filter((candle) => candle.timestamp < before)
        : history.candles;
      res.json({
        symbol,
        period: period.key,
        source: history.source,
        adjustedForSplits: history.adjustedForSplits === true,
        candles,
        hasMore: candles.length >= Math.floor(days * 0.35),
        timestamp: Date.now()
      });
    } catch (error) {
      res.status(502).json({ error: error.message || '获取 K 线失败' });
    }
  });

  app.put('/api/quant/settings', quantRoute(async (req, res) => {
    const scope = ['watchlist', 'config', 'paper'].includes(req.body?.scope) ? req.body.scope : 'watchlist';
    const scopeFeature = {
      watchlist: 'quant-watchlist',
      config: 'quant-config',
      paper: 'quant-paper-settings'
    }[scope];
    if (!requireQuantPermission(req, res, scopeFeature, 'edit')) return;
    const userId = quantUserId(req);
    const body = req.body || {};
    let symbols;
    if (scope === 'watchlist') {
      const rawSymbols = Array.isArray(body.symbols) ? body.symbols.join(',') : String(body.symbols || '');
      symbols = quantSymbols(rawSymbols);
      if (!symbols.length) return res.status(400).json({ error: '请至少保存一个有效的美股代码' });
    }
    const updated = await quantStore.update(userId, ({ settings }) => {
      if (scope === 'watchlist') {
        settings.symbols = symbols;
        settings.period = quantPeriod(body.period).key;
      } else if (scope === 'config') {
        settings.config = normalizeQuantConfig(body.config || settings.config);
      } else {
        settings.paperInitialCapital = Math.max(1000, Math.min(100000000, Number(body.paperInitialCapital) || settings.paperInitialCapital));
        settings.paperPositionPct = Math.max(0.01, Math.min(1, Number(body.paperPositionPct) || settings.paperPositionPct));
      }
    });
    res.json(updated.settings);
  }));

  app.get('/api/quant/backtests', quantRoute(async (req, res) => {
    if (!requireQuantPermission(req, res, 'quant-backtest')) return;
    res.json({ items: await quantBacktestStore.list(quantUserId(req), req.query.limit) });
  }));

  app.get('/api/quant/backtests/:id', quantRoute(async (req, res) => {
    if (!requireQuantPermission(req, res, 'quant-backtest')) return;
    const result = await quantBacktestStore.get(quantUserId(req), req.params.id);
    if (!result) return res.status(404).json({ error: '回测记录不存在' });
    res.json(result);
  }));

  app.delete('/api/quant/backtests/:id', quantRoute(async (req, res) => {
    if (!requireQuantPermission(req, res, 'quant-backtest-delete', 'edit')) return;
    const removed = await quantBacktestStore.remove(quantUserId(req), req.params.id);
    if (!removed) return res.status(404).json({ error: '回测记录不存在' });
    res.json({ ok: true });
  }));

  app.post('/api/quant/backtest', async (req, res) => {
    if (!requireQuantPermission(req, res, 'quant-backtest-run', 'edit')) return;
    try {
      const userId = quantUserId(req);
      const saved = (await quantStore.read(userId)).settings;
      const rawSymbols = Array.isArray(req.body?.symbols) ? req.body.symbols.join(',') : String(req.body?.symbols || '');
      const symbols = quantSymbols(rawSymbols, saved.symbols);
      if (!symbols.length) return res.status(400).json({ error: '请选择回测标的' });
      const period = quantPeriod(req.body?.period || saved.period);
      const strategyConfig = normalizeQuantConfig(req.body?.config || saved.config);
      const initialCapital = Math.max(1000, Math.min(100000000, Number(req.body?.initialCapital) || 100000));
      await quantStore.update(userId, ({ settings }) => {
        settings.backtestPeriod = period.key === '3m' ? '6m' : period.key;
        settings.backtestInitialCapital = initialCapital;
      });
      const allocation = initialCapital / symbols.length;
      const backtestStart = Date.now() - period.days * 86400000;
      const results = await mapWithConcurrency(symbols, 2, async (symbol) => {
        try {
          const history = await quotes.getStockHistory(symbol, { days: period.days + 120 });
          return {
            ...backtestCandles({ symbol, candles: history.candles, config: strategyConfig, initialCapital: allocation, startTimestamp: backtestStart }),
            historySource: history.source,
            adjustedForSplits: history.adjustedForSplits === true
          };
        } catch (error) {
          return { symbol, status: 'error', message: error.message || '获取历史行情失败' };
        }
      });
      const valid = results.filter((item) => item.status === 'ok');
      if (!valid.length) return res.status(502).json({ error: '没有可用于回测的历史行情', results });
      const allocatedCapital = allocation * valid.length;
      const finalEquity = valid.reduce((sum, item) => sum + item.finalEquity, 0);
      const completedTrades = valid.reduce((sum, item) => sum + item.completedTrades, 0);
      const weightedWins = valid.reduce((sum, item) => sum + item.winRate * item.completedTrades, 0);
      const curveMaps = valid.map((item) => new Map(item.equityCurve.map((point) => [point.timestamp, point])));
      const commonTimestamps = valid[0].equityCurve
        .map((point) => point.timestamp)
        .filter((timestamp) => curveMaps.every((map) => map.has(timestamp)));
      const equityCurve = commonTimestamps.map((timestamp) => {
        const points = curveMaps.map((map) => map.get(timestamp));
        const strategyEquity = points.reduce((sum, point) => sum + point.equity, 0);
        const buyHoldEquity = points.reduce((sum, point) => sum + point.buyHoldEquity, 0);
        return {
          timestamp,
          strategyEquity,
          buyHoldEquity,
          strategyReturn: (strategyEquity - allocatedCapital) / allocatedCapital,
          buyHoldReturn: (buyHoldEquity - allocatedCapital) / allocatedCapital
        };
      });
      const response = {
        period: period.key,
        initialCapital: allocatedCapital,
        finalEquity,
        totalReturn: (finalEquity - allocatedCapital) / allocatedCapital,
        buyHoldReturn: valid.reduce((sum, item) => sum + item.buyHoldReturn, 0) / valid.length,
        maxDrawdown: Math.max(...valid.map((item) => item.maxDrawdown)),
        winRate: completedTrades ? weightedWins / completedTrades : 0,
        completedTrades,
        equityCurve,
        results,
        from: equityCurve[0]?.timestamp || null,
        to: equityCurve.at(-1)?.timestamp || null,
        timestamp: Date.now()
      };
      res.json(await quantBacktestStore.save(userId, response));
    } catch (error) {
      res.status(500).json({ error: error.message || '回测失败' });
    }
  });

  function paperView(saved, signals = []) {
    const signalMap = new Map(signals.map((signal) => [signal.symbol, signal]));
    const holdings = Object.entries(saved.paper.holdings).map(([symbol, holding]) => {
      const latest = signalMap.get(symbol);
      const price = Number(latest?.price) > 0 ? Number(latest.price) : Number(holding.lastPrice) || Number(holding.avgCost);
      return {
        symbol,
        shares: Number(holding.shares),
        avgCost: Number(holding.avgCost),
        price,
        marketValue: Number(holding.shares) * price,
        pnl: Number(holding.shares) * (price - Number(holding.avgCost)),
        signal: latest?.signal || 'HOLD'
      };
    });
    const holdingsValue = holdings.reduce((sum, item) => sum + item.marketValue, 0);
    return {
      ...saved.paper,
      holdings,
      holdingsValue,
      totalEquity: saved.paper.cash + holdingsValue,
      totalReturn: (saved.paper.cash + holdingsValue - saved.paper.initialCapital) / saved.paper.initialCapital
    };
  }

  app.get('/api/quant/paper', quantRoute(async (req, res) => {
    if (!requireQuantPermission(req, res, 'quant-paper')) return;
    res.json(paperView(await quantStore.read(quantUserId(req))));
  }));

  app.post('/api/quant/paper/reset', quantRoute(async (req, res) => {
    if (!requireQuantPermission(req, res, 'quant-paper-reset', 'edit')) return;
    const userId = quantUserId(req);
    const updated = await quantStore.update(userId, saved => {
      if (Number(req.body?.initialCapital) >= 1000) saved.settings.paperInitialCapital = Number(req.body.initialCapital);
      saved.paper = resetPaper(saved.settings);
    });
    res.json(paperView(updated));
  }));

  app.post('/api/quant/paper/sync', async (req, res) => {
    if (!requireQuantPermission(req, res, 'quant-paper-sync', 'edit')) return;
    try {
      const userId = quantUserId(req);
      const { settings } = await quantStore.read(userId);
      const analysis = await analyzeQuantSymbols(settings.symbols.join(','), settings.period, settings.config, userId);
      const now = Date.now();
      const trades = [];
      const updated = await quantStore.update(userId, saved => {
        const current = saved.settings;
        if (current.period !== settings.period || JSON.stringify(current.symbols) !== JSON.stringify(settings.symbols)
            || JSON.stringify(current.config) !== JSON.stringify(settings.config)) {
          throw Object.assign(new Error('分析设置已变更，请重新同步'), { status: 409 });
        }
        for (const signal of analysis.signals) {
          if (signal.status !== 'ok' || !(Number(signal.price) > 0)) continue;
          const holding = saved.paper.holdings[signal.symbol];
          if (holding) holding.lastPrice = Number(signal.price);
          const signalKey = `${signal.asOf || now}:${signal.signal}`;
          if (saved.paper.processedSignals[signal.symbol] === signalKey) continue;
          if (signal.signal === 'BUY' && !holding) {
            const current = paperView(saved, analysis.signals);
            const budget = Math.min(saved.paper.cash, current.totalEquity * saved.settings.paperPositionPct);
            const shares = Math.floor((budget / Number(signal.price)) * 10000) / 10000;
            if (shares > 0) {
              const cost = shares * Number(signal.price);
              saved.paper.cash -= cost;
              saved.paper.holdings[signal.symbol] = { shares, avgCost: Number(signal.price), lastPrice: Number(signal.price) };
              trades.push({ timestamp: now, symbol: signal.symbol, side: 'BUY', shares, price: Number(signal.price), amount: cost });
            }
          } else if (signal.signal === 'SELL' && holding) {
            const amount = Number(holding.shares) * Number(signal.price);
            saved.paper.cash += amount;
            trades.push({
              timestamp: now,
              symbol: signal.symbol,
              side: 'SELL',
              shares: Number(holding.shares),
              price: Number(signal.price),
              amount,
              pnl: Number(holding.shares) * (Number(signal.price) - Number(holding.avgCost))
            });
            delete saved.paper.holdings[signal.symbol];
          }
          saved.paper.processedSignals[signal.symbol] = signalKey;
        }
        saved.paper.trades = saved.paper.trades.concat(trades).slice(-500);
        saved.paper.updatedAt = now;
      });
      res.json({ ...paperView(updated, analysis.signals), executed: trades, signals: analysis.signals });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message || '模拟盘同步失败' });
    }
  });
}
