import { progressResponse } from './progress-response.js';
import express from 'express';
import { mapWithConcurrency } from '../../shared/map-with-concurrency.js';
import { currentPortfolioUserId, runWithPortfolioUser } from '../../shared/portfolio-user.js';
import { investmentRows } from '../../shared/investment-accounts.js';
import { fundIdentifier, openingFundTrades } from '../../shared/fund-holdings.js';
import { DEFAULT_USD_CNY_RATE } from '../../shared/db/portfolio-store.js';
import { deriveHoldings, recalcCashFromTrades } from './trades.js';
import { inferCurrency, inferMarket, normalizeSymbol } from './markets.js';
import { parseImportBuffer } from './import-moomoo.js';
import { decodeImportHistory, importHistoryMetaLimit, importHistoryPlan, selectHistoricalImports } from './import-history.js';
import { changedHoldingSymbols } from './import-quote-targets.js';
import { mergeEastmoneyTrades } from './import-eastmoney.js';
import { mergeBbaeTrades } from './import-bbae.js';
import { isBrokerPdf, parseBrokerPdf, matchesPdfTrade, combinePdfTrade } from './import-broker-pdf.js';
import { backfillTradeName, knownTradeNames, needsTradeName } from './trade-name.js';

export function registerTradeImportRoutes(app, {
  config, store, portfolioDb, quotes, requireStockPermission, lookupInstrumentName,
  openingFundsForAccount, completePortfolioFundQuote, describeReinvestment, backfillSavedTrades, portfolioForRequest
}) {
  function brokerImportPlan(req, trades, data) {
    if (trades.pdfImportInfo) {
      const { currencies, ...info } = trades.pdfImportInfo;
      const owned = investmentRows(portfolioDb, currentPortfolioUserId());
      const accounts = [], missingCurrencies = [];
      for (const cur of currencies) {
        const id = req.query[cur === 'USD' ? 'usdAccountId' : 'hkdAccountId'] || req.query.accountId;
        const account = owned.find(row => row.id === id && row.currency === cur);
        if (account) accounts.push(account);
        else missingCurrencies.push(cur);
      }
      const summary = { ...info, currencies, missingCurrencies, added: 0, updated: 0, skipped: 0, unassigned: 0 };
      const preview = [];
      let merged = data.trades;
      if (missingCurrencies.length) return { accounts, summary, preview, trades: merged };
      for (const account of accounts) {
        const plan = mergeBbaeTrades(merged, trades.filter(row => row.currency === account.currency), account.id, {
          matchManualTrade: matchesPdfTrade,
          combineTrade: combinePdfTrade
        });
        merged = plan.trades;
        preview.push(...plan.preview);
        for (const key of ['added', 'updated', 'skipped', 'unassigned']) summary[key] += plan.summary[key] || 0;
      }
      preview.sort((a, b) => Date.parse(a.trade_date) - Date.parse(b.trade_date) || a.id.localeCompare(b.id));
      return { accounts, summary, preview, trades: merged };
    }
    if (trades.fundImportInfo) {
      const account = investmentRows(portfolioDb, currentPortfolioUserId()).find(a => a.id === req.query.accountId && a.currency === 'CNY');
      if (!account) throw new Error('基金交割单请选择本人名下的人民币证券账户');
      const plan = mergeBbaeTrades(data.trades, trades, account.id);
      return { ...plan, summary: { ...plan.summary, ...trades.fundImportInfo } };
    }
    const eastmoney = !!trades.importInfo;
    const account = investmentRows(portfolioDb, currentPortfolioUserId()).find(a => a.id === req.query.accountId && a.currency === (eastmoney ? 'CNY' : 'USD'));
    if (!account) throw new Error(eastmoney ? '东方财富导入请选择本人名下的人民币证券账户' : 'BBAE 导入请选择本人名下的美元证券账户');
    return eastmoney ? mergeEastmoneyTrades(data.trades, trades, account.id, { repoInterestStart: req.query.repoInterestStart || new Date(Date.parse(account.baseline_at) + 8 * 3600000).toISOString().slice(0,10), baselineAt: account.baseline_at, baselineExcluded: req.query.repoInterestBaselineExcluded === '1' }) : mergeBbaeTrades(data.trades, trades, account.id);
  }

  async function fillImportedNames(trades, data) {
    const names = knownTradeNames(data.trades, data.quotes);
    for (const [symbol, name] of knownTradeNames(trades)) {
      if (!names.has(symbol)) names.set(symbol, name);
    }
    const symbols = [...new Set(trades.filter(needsTradeName).map(t => normalizeSymbol(t.symbol)))];
    const lookup = symbols.filter(symbol => !names.has(symbol) && inferMarket(symbol) !== 'OPTION');
    await mapWithConcurrency(lookup, 4, async symbol => {
      try {
        const name = await lookupInstrumentName(symbol);
        if (name) names.set(symbol, name);
      } catch { /* Keep the import usable during a name-provider outage. */ }
    });
    for (let i = 0; i < trades.length; i++) trades[i] = backfillTradeName(trades[i], names);
  }

  const importAccount = req => investmentRows(portfolioDb, currentPortfolioUserId()).find(a => a.id === req.query.accountId);
  const importFileLimit = 20 * 1024 * 1024;
  const isBrokerImport = trades => !!(trades.pdfImportInfo || trades.importInfo || trades.fundImportInfo || trades[0]?.broker === 'bbae');
  const importContentTypes = ['application/octet-stream', 'application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];

  function importRequestTrades(file, req, progress) {
    const parsing = (completed, total) => progress('parse', { completed, total });
    if (!isBrokerPdf(file)) {
      parsing(0, 1);
      const trades = parseImportBuffer(file);
      parsing(1, 1);
      return trades;
    }
    const header = String(req.get('Password') || '');
    if (header.length > 512) throw new Error('PDF 密码过长');
    const userId = currentPortfolioUserId();
    const defaultPassword = Object.hasOwn(config.chiefPdfPasswordsByUser, userId) ? config.chiefPdfPasswordsByUser[userId] : '';
    return parseBrokerPdf(file, header ? decodeURIComponent(header) : String(defaultPassword || ''), parsing);
  }

  function stillHeldSymbols(data, candidates) {
    if (!candidates.size) return [];
    const trades = [...openingFundTrades(openingFundsForAccount()), ...data.trades].filter(t => candidates.has(t.symbol));
    return [...new Set(deriveHoldings(trades).map(h => h.symbol))];
  }

  const importQuoteQueue = new Map();
  let importQuoteWorkerRunning = false;

  const missingHkdRate = data => !(data.usdHkdRate > 0)
    && (data.cashHkd || data.investmentAccounts?.some(account => account.currency === 'HKD')
      || data.trades.some(trade => inferCurrency(trade.symbol, trade.currency) === 'HKD'));

  function queueImportedHoldingQuotes(symbols, refreshHkdRate) {
    if (!symbols.length && !refreshHkdRate) return;
    const userId = currentPortfolioUserId();
    const pending = importQuoteQueue.get(userId) || new Set();
    symbols.forEach(symbol => pending.add(symbol));
    importQuoteQueue.set(userId, pending);
    if (importQuoteWorkerRunning) return;
    importQuoteWorkerRunning = true;
    setImmediate(async () => {
      try {
        while (importQuoteQueue.size) {
          const [user, candidates] = importQuoteQueue.entries().next().value;
          importQuoteQueue.delete(user);
          await runWithPortfolioUser(user, async () => {
            try {
              const before = store.read();
              const started = stillHeldSymbols(before, candidates);
              const [fetched, hkdRate] = await Promise.all([
                mapWithConcurrency(started, 3, async symbol => {
                  try { return [symbol, await quotes.getQuote(symbol)]; }
                  catch (error) { console.warn('导入后行情刷新失败:', symbol, error.message); return [symbol, null]; }
                }),
                missingHkdRate(before) ? quotes.getUsdHkd().then(({ rate }) => rate).catch(error => {
                  console.warn('导入后港币汇率补查失败:', error.message);
                  return null;
                }) : null
              ]);
              if (!fetched.some(([, quote]) => quote?.price > 0) && !(hkdRate > 0)) return;
              const latest = store.read();
              const held = new Set(stillHeldSymbols(latest, candidates));
              const updated = fetched.filter(([symbol, quote]) => held.has(symbol) && quote?.price > 0
                && JSON.stringify(latest.quotes[symbol]) === JSON.stringify(before.quotes[symbol])
                && !(fundIdentifier(symbol) && latest.quotes[symbol]?.asOf > quote.asOf));
              const rates = missingHkdRate(latest) && Number.isFinite(hkdRate) && hkdRate > 0 ? { usdHkdRate: hkdRate } : {};
              for (const entry of updated) entry[1] = completePortfolioFundQuote(entry[1], latest.quotes[entry[0]]);
              if (updated.length || rates.usdHkdRate) {
                store.write({ ...latest, ...rates, quotes: { ...latest.quotes, ...Object.fromEntries(updated) } }, { externalSync: true });
              }
            } catch (error) {
              console.warn('导入后行情更新失败:', error.message);
            }
          });
        }
      } finally {
        importQuoteWorkerRunning = false;
      }
    });
  }

  app.post('/api/trades/import/preview', express.raw({
    type: importContentTypes,
    limit: '20mb'
  }), async (req, res) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
    if (!buf.length) return res.status(400).json({ error: '空文件' });
    const reply = progressResponse(req, res, true);
    try {
      if (isBrokerPdf(buf) && !requireStockPermission(req, res, 'import', 'edit')) return;
      const trades = await importRequestTrades(buf, req, reply.progress);
      if (!trades.length && !isBrokerImport(trades)) return reply.finish({ error: '未解析到有效记录' }, 400);
      reply.progress('match');
      const data = store.read();
      await fillImportedNames(trades, data);
      const plan = isBrokerImport(trades) ? brokerImportPlan(req, trades, data) : null;
      const rows = plan?.preview || trades;
      const history = importHistoryPlan(buf, rows, plan?.accounts ?? importAccount(req), plan ? 'merge' : String(req.query.mode || 'merge'));
      const pageSize = 50;
      const pages = Math.max(1, Math.ceil(rows.length / pageSize));
      const page = Math.min(pages, Math.max(1, Math.trunc(Number(req.query.page) || 1)));
      const start = (page - 1) * pageSize;
      const preview = rows.slice(start, start + pageSize).map((row, i) => ({
        ...describeReinvestment(row), ...(history.eligible.has(start + i) ? { historicalIndex: start + i } : {})
      }));
      reply.finish({ count: rows.length, format: trades.pdfImportInfo?.broker || (trades.fundImportInfo ? 'fund' : trades.importInfo ? 'eastmoney' : plan ? 'bbae' : 'other'),
        summary: plan?.summary, trades: trades.slice(0, 5).map(describeReinvestment), preview, page, pages,
        history: { snapshot: history.snapshot, count: history.eligible.size } });
    } catch (e) {
      reply.finish({ error: e.message }, 400);
    }
  });

  app.post('/api/trades/import', express.raw({
    type: importContentTypes,
    limit: importFileLimit + importHistoryMetaLimit + 4
  }), async (req, res) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
    if (!buf.length) return res.status(400).json({ error: '空文件' });
    const reply = progressResponse(req, res);
    try {
      const { file, selection } = decodeImportHistory(buf, req.query.historicalSelection === '1');
      if (file.length > importFileLimit) throw new Error('文件不能超过 20 MB');
      if (isBrokerPdf(file) && !requireStockPermission(req, res, 'import', 'edit')) return;
      const imported = await importRequestTrades(file, req, reply.progress);
      if (!imported.length) return reply.finish({ error: isBrokerImport(imported) ? '单据没有本次支持的可导入交易，请查看预览中的未导入原因' : '未解析到有效记录' }, 400);
      reply.progress('match');
      await fillImportedNames(imported, store.read());
      const mode = String(req.query.mode || 'merge');
      const build = () => {
        const data = store.read();
        const account = importAccount(req);
        const broker = isBrokerImport(imported);
        if (broker && mode !== 'merge') throw new Error('券商导出可能只含部分日期，请使用合并模式，避免删除其他交易');
        const plan = broker ? brokerImportPlan(req, imported, data) : null;
        if (plan?.summary.missingCurrencies?.length) {
          throw new Error(`请选择本人名下 ${plan.summary.missingCurrencies.join('、')} 对应币种的证券账户`);
        }
        if (plan?.summary.unassigned) throw new Error('存在可能重复的未归属历史，请先核对并设置账户归属，未导入');
        if (plan?.summary.updated && req.query.allowUpdates !== '1') throw new Error('存在待更新记录，请先预览并明确勾选允许更新匹配记录');
        const rows = plan?.preview || imported;
        const historyAccounts = plan?.accounts ?? account;
        const indexes = selection ? selectHistoricalImports(importHistoryPlan(file, rows, historyAccounts, mode), selection) : new Set();
        const selected = [...indexes].map(i => rows[i].account_id ? rows[i] : { ...rows[i], account_id: account?.id });
        const ids = new Set(selected.map(row => row.id));
        const next = imported.map(t => req.query.accountId ? { ...t, account_id: req.query.accountId } : t);
        const base = mode === 'replace' ? req.query.accountId ? data.trades.filter(t => t.account_id !== req.query.accountId) : [] : data.trades;
        const merged = plan?.trades || base.concat(next);
        const trades = ids.size ? merged.map(t => ids.has(t.id) ? { ...t, historicalBackfill: true } : t) : merged;
        const linkedAccounts = new Set((plan?.accounts ?? [account]).filter(row => row?.bookkeeping_id).map(row => row.id));
        return { data, trades, selected, linkedAccounts, importSummary: plan?.summary };
      };
      let result = build();
      const needed = [...new Set(result.selected.filter(t => t.type !== 'other' && result.linkedAccounts.has(t.account_id))
        .map(t => t.symbol).filter(s => !(result.data.quotes[s]?.price > 0)))];
      if (needed.length) {
        reply.progress('quotes');
        const fetched = await mapWithConcurrency(needed, 4, async symbol => [symbol, await quotes.getQuote(symbol).catch(() => null)]);
        result = build();
        for (const [symbol, quote] of fetched) if (quote?.price > 0 && !(result.data.quotes[symbol]?.price > 0)) result.data.quotes[symbol] = quote;
      }
      const { data, trades, selected, importSummary } = result;
      reply.progress('save');
      const quoteCandidates = changedHoldingSymbols(data.trades, trades);
      const previous = new Map(data.trades.map(trade => [trade.id, trade]));
      const changed = trades.filter(trade => {
        const old = previous.get(trade.id);
        return !old || ['symbol', 'trade_date', 'account_id', 'type', 'shares', 'historicalBackfill'].some(field => trade[field] !== old[field]);
      });
      data.trades = trades;
      const recalc = recalcCashFromTrades(data.trades, {
        cashUsd: 0,
        cashCny: 0,
        usdCnyRate: data.usdCnyRate || DEFAULT_USD_CNY_RATE,
        usdHkdRate: data.usdHkdRate
      });
      Object.assign(data, recalc);
      const saved = store.write(data, { externalSync: true });
      backfillSavedTrades(changed);
      for (const account of saved.investmentAccounts || []) {
        for (const symbol of account.missingQuotes) quoteCandidates.add(symbol);
      }
      const refreshSymbols = stillHeldSymbols(saved, quoteCandidates);
      const importHkdRatePending = Boolean(missingHkdRate(saved));
      queueImportedHoldingQuotes(refreshSymbols, importHkdRatePending);
      reply.finish({ ...portfolioForRequest(req, saved), importSummary, historicalBackfillCount: selected.length,
        importQuoteRefreshCount: refreshSymbols.length, importHkdRatePending });
    } catch (e) {
      reply.finish({ error: e.message }, 400);
    }
  });
}
