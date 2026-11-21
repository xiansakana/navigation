import { ensureFundHoldings, fundCode, fundIdentifier, hongKongFundIsin, fundHoldings, fundValuation, openingFundTrades } from '../../shared/fund-holdings.js';
import { completeChinaAmcMovement, hkFundInfo } from './hk-fund-nav.js';
import { Decimal } from '../../shared/portfolio-decimal.js';
import { estimatedReinvestmentIncome, tradesWithReinvestmentIncome } from '../../shared/fund-reinvestment.js';
import { findInternationalStockName, findMainlandInstruments, findReinvestmentNav, getFundNav } from './fund-nav.js';
import { TRADE_ASSET_TYPES, tradeAssetType } from '../public/js/trade-asset-type.js';
import { serveUiAsset } from '../../shared/ui-assets.js';
import { portfolioIdentityMiddleware } from '../../shared/portfolio-user.js';
import { currentPortfolioUserId, runWithPortfolioUser } from '../../shared/portfolio-user.js';
import { getDatabase } from '../../shared/db/index.js';
import { investmentRows, saveInvestmentAccount, unlinkInvestmentAccount } from '../../shared/investment-accounts.js';
import { dipCashFunds, setDipCashReserve } from '../../shared/dip-cash-funds.js';
import { createBookkeepingStore } from '../../portal/src/bookkeeping-store.js';
import { queueSavedTradeHistory } from '../../portal/src/bookkeeping-security-history.js';
import { configureQuoteNetwork } from '../../shared/quote-network.js';
import express from 'express';
import path from 'node:path';
import XLSX from 'xlsx';
import { fileURLToPath } from 'node:url';
import { loadConfig, createStore } from './storage.js';
import { createQuantStore, resetPaper } from './quant-store.js';
import { createQuantBacktestStore } from './quant-backtest-store.js';
import { createQuoteService } from './quotes.js';
import { parseImportBuffer } from './import-moomoo.js';
import { decodeImportHistory, importHistoryMetaLimit, importHistoryPlan, selectHistoricalImports } from './import-history.js';
import { changedHoldingSymbols } from './import-quote-targets.js';
import { mergeEastmoneyTrades } from './import-eastmoney.js';
import { mergeBbaeTrades } from './import-bbae.js';
import { backfillTradeName, knownTradeNames, needsTradeName, normalizeNamedTrade } from './trade-name.js';
import { computeTradeReview } from './trade-review.js';
import {
  deriveHoldings,
  computePnl,
  computeSymbolSummaries,
  buildDailyCumulativeSeries,
  enrichHoldings,
  computeDailySummary,
  recalcCashFromTrades,
  roundMoney,
  roundPrice,
  applyCashDelta,
  undoCashDelta,
  cashUsdEquivalent,
  tradeCalendarDate,
  formatZonedDateTime
} from './trades.js';
import { holdingTypeForSymbol, inferCurrency, inferMarket, normalizeSymbol } from './markets.js';
import { DEFAULT_USD_CNY_RATE, ensureUserPortfolioSchema } from '../../shared/db/portfolio-store.js';
import { analyzeCandles, backtestCandles, DEFAULT_QUANT_CONFIG, normalizeQuantConfig } from './quant-analysis.js';
import { redactPortfolioCash } from './portfolio-visibility.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
console.info('行情网络策略:', JSON.stringify(configureQuoteNetwork()));

let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const store = createStore(config);
const portfolioDb = getDatabase({ dbPath: config.dbPath });
ensureUserPortfolioSchema(portfolioDb);
ensureFundHoldings(portfolioDb);
const quantStore = createQuantStore(config);
const quantBacktestStore = createQuantBacktestStore(config);
const quotes = createQuoteService(config);
const app = express();
app.use((req, res, next) => { if (!serveUiAsset(req, res)) next(); });

if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));
app.use(portfolioIdentityMiddleware);

function quantUserId(req) {
  const value = String(req.headers['x-portal-user-id'] || 'local').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : 'local';
}

function portalPermissions(req) {
  const encoded = String(req.headers['x-portal-permissions'] || '');
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function hasStockPermission(req, feature, action = 'view') {
  const permissions = portalPermissions(req);
  if (permissions === null) return true;
  const exact = `service:stock-manage:${feature}:${action}`;
  const edit = `service:stock-manage:${feature}:edit`;
  return permissions.includes('*')
    || permissions.includes('service:stock-manage:edit')
    || permissions.includes(exact)
    || (action === 'view' && permissions.includes(edit));
}

function hasQuantPermission(req, feature, action = 'view') {
  return hasStockPermission(req, feature, action);
}

function requireStockPermission(req, res, feature, action = 'view') {
  if (hasStockPermission(req, feature, action)) return true;
  res.status(403).json({ error: '无权使用该持仓功能' });
  return false;
}

function requireQuantPermission(req, res, feature, action = 'view') {
  if (hasQuantPermission(req, feature, action)) return true;
  res.status(403).json({ error: '无权使用该量化分析功能' });
  return false;
}

function openingFundsForAccount(accountId) {
  return fundHoldings(portfolioDb, currentPortfolioUserId())
    .filter(fund => !accountId || fund.account_id === accountId);
}

function tradesForCalculations(req, trades) {
  return [...openingFundTrades(openingFundsForAccount(req.query.accountId)), ...tradesWithReinvestmentIncome(scopedTrades(req, trades))];
}

function describeReinvestment(trade) {
  return trade.reinvestedDividend && trade.reinvestmentNav > 0
    ? { ...trade, estimatedReinvestmentIncome: estimatedReinvestmentIncome(trade) } : trade;
}

function completePortfolioFundQuote(quote, saved) {
  return completeChinaAmcMovement(quote, (symbol, date) => {
    if (!portfolioDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bookkeeping_security_prices'").get()) return null;
    return portfolioDb.prepare(`SELECT close FROM bookkeeping_security_prices
      WHERE user_id=? AND symbol=? AND date=? AND source='chinaamc-hk-fund-nav'`)
      .get(currentPortfolioUserId(), symbol, date)?.close;
  }, saved);
}

function buildPortfolio(data, pnlOpts = {}) {
  const rate = Number(data.usdCnyRate) > 0 ? Number(data.usdCnyRate) : DEFAULT_USD_CNY_RATE;
  const fxOpts = { ...pnlOpts, usdCnyRate: rate, usdHkdRate: data.usdHkdRate };
  const openings = openingFundsForAccount(pnlOpts.accountId);
  const calculationTrades = [...openingFundTrades(openings), ...tradesWithReinvestmentIncome(data.trades)];
  const holdings = deriveHoldings(calculationTrades);
  const cashState = {
    cashUsd: Number(data.cashUsd) || 0,
    cashCny: Number(data.cashCny) || 0,
    cashHkd: Number(data.cashHkd) || 0,
    usdHkdRate: data.usdHkdRate,
    usdCnyRate: rate
  };
  const openingByKey = new Map(openings.map(fund => [JSON.stringify([fund.account_id, fund.code]), fund]));
  const fundTrades = new Set(data.trades.filter(t => t.type !== 'other' && fundIdentifier(t.symbol))
    .map(t => JSON.stringify([t.account_id, fundIdentifier(t.symbol)])));
  // Each account can have a different legacy NAV for the same fund.
  const fundQuotes = {};
  const fundRows = holdings.filter(h => h.type === 'fund').map(holding => {
    const code = fundIdentifier(holding.symbol);
    const key = JSON.stringify([holding.accountId, code]);
    const opening = openingByKey.get(key);
    const quote = completePortfolioFundQuote(fundValuation(data.quotes[holding.symbol], opening));
    const valuationSymbol = `FUND:${holding.accountId}:${code}`;
    if (quote) fundQuotes[valuationSymbol] = quote;
    const accountName = data.investmentAccounts?.find(a => a.id === holding.accountId)?.name || '待归属';
    const cost = roundMoney(holding.costBasisNative);
    const marketValue = quote ? roundMoney(new Decimal(holding.shares).times(quote.price)) : null;
    const { symbol, ...row } = holding;
    return { ...row, symbol: code, tradeSymbol: symbol, accountName, cost, marketValue, price: quote?.price ?? null,
      quoteAsOf: quote?.asOf ?? null, editableSnapshot: !!opening && !fundTrades.has(key),
      pnl: marketValue == null ? null : roundMoney(new Decimal(marketValue).minus(cost)) };
  });
  const valuedHoldings = holdings.filter(h => h.type !== 'fund');
  for (const fund of fundRows) {
    const symbol = `FUND:${fund.accountId}:${fund.symbol}`;
    valuedHoldings.push({ ...fund, symbol });
  }
  const enriched = enrichHoldings(valuedHoldings, { ...data.quotes, ...fundQuotes }, cashState, data.holdingsMeta);
  const enrichedFunds = enriched.rows.filter(row => row.type === 'fund');
  const pnl = computePnl(calculationTrades, fxOpts);
  const sparse = buildDailyCumulativeSeries(calculationTrades, fxOpts);
  const daily = computeDailySummary(enriched.rows, calculationTrades, fxOpts);
  const cashEq = enriched.cashUsdEq;
  return {
    cash: cashEq,
    cashUsd: cashState.cashUsd,
    cashCny: cashState.cashCny,
    cashHkd: cashState.cashHkd,
    usdHkdRate: data.usdHkdRate,
    usdCnyRate: rate,
    trades: data.trades.map(describeReinvestment),
    quotes: data.quotes,
    holdingsMeta: data.holdingsMeta,
    holdings: enriched.rows.filter(row => row.type !== 'fund'),
    fundHoldings: fundRows.map((fund, index) => ({ ...fund,
      marketValueUsd: fund.marketValue == null ? null : enrichedFunds[index].marketValue,
      dailyPnl: enrichedFunds[index].dailyPnl,
      dailyPnlPct: enrichedFunds[index].dailyPnlPct,
      groupWith: enrichedFunds[index].groupWith,
      groupMarketValue: enrichedFunds[index].groupMarketValue,
      weight: fund.marketValue == null && !enrichedFunds[index].groupMarketValue ? null : enrichedFunds[index].weight
    })),
    chartSparse: sparse,
    summary: {
      stockMv: enriched.stockMv,
      optionMv: enriched.optionMv,
      ashareMv: enriched.ashareMv,
      ashareMvNative: enriched.ashareMvNative,
      totalMv: enriched.totalMv,
      totalAssets: enriched.totalAssets,
      totalAssetsCny: enriched.totalAssetsCny,
      assetsUsd: enriched.assetsUsd,
      assetsCny: enriched.assetsCny,
      assetsHkd: enriched.assetsHkd,
      hkMv: enriched.hkMv,
      totalPnlHkd: enriched.unrealizedHkd,
      unrealized: enriched.unrealized,
      unrealizedUsd: enriched.unrealizedUsd,
      unrealizedCny: enriched.unrealizedCny,
      totalPnl: enriched.unrealized,
      totalPnlUsd: enriched.unrealizedUsd,
      totalPnlCny: enriched.unrealizedCny,
      cashUsdEq: cashEq,
      ...pnl,
      ...daily
    }
  };
}

function pnlOptsFromReq(req) {
  return {
    accountId: req.query?.accountId,
    startDate: req.query?.start || undefined,
    endDate: req.query?.end || undefined
  };
}

function orderedInvestmentAccounts(accounts) {
  const row = portfolioDb.prepare('SELECT value FROM portfolio_user_meta WHERE user_id=? AND key=?')
    .get(currentPortfolioUserId(), 'investment_account_order');
  if (!row) return accounts;
  const byId = new Map(accounts.map(account => [account.id, account]));
  const ordered = [];
  for (const id of JSON.parse(row.value)) {
    if (byId.has(id)) {
      ordered.push(byId.get(id));
      byId.delete(id);
    }
  }
  return [...ordered, ...byId.values()];
}

function portfolioForRequest(req, data = store.read()) {
  const accounts = data.investmentAccounts || [];
  const accountsVisible = hasStockPermission(req, 'accounts');
  const pnlOptions = pnlOptsFromReq(req);
  if (!accountsVisible) delete pnlOptions.accountId;
  const { accountId } = pnlOptions;
  if (accountId) {
    const selected = accounts.find((a) => a.id === accountId);
    data = { ...data, trades: data.trades.filter((t) => (t.account_id || 'unassigned') === accountId), cashUsd: selected?.currency === 'USD' ? selected.cash : 0, cashCny: selected?.currency === 'CNY' ? selected.cash : 0, cashHkd: selected?.currency === 'HKD' ? selected.cash : 0 };
  }
  const portfolio = buildPortfolio(data, pnlOptions);
  if (!hasStockPermission(req, 'pnl')) {
    delete portfolio.chartSparse;
    for (const field of ['totalBuy', 'totalSell', 'commission', 'otherAmount', 'realizedPL', 'netPL',
      'tradeDailyPnl', 'dailyTotalPnl', 'dailyTotalPnlUsd', 'dailyTotalPnlCny', 'dailyTotalPnlHkd']) {
      delete portfolio.summary[field];
    }
  }
  portfolio.investmentAccounts = accountsVisible ? orderedInvestmentAccounts(accounts).map(({ id, name, currency }) => ({ id, name, currency })) : [];
  if (!hasStockPermission(req, 'trades')) portfolio.trades = [];
  portfolio.accountCashEnabled = !!data.accountCashEnabled;
  const incomplete = accounts.filter((a) => (!accountId || accountId === a.id) && a.missingQuotes.length);
  portfolio.missingQuotes = [...new Set(incomplete.flatMap(a => a.missingQuotes))];
  if (incomplete.length) {
    portfolio.summary.totalAssets = null; portfolio.summary.totalAssetsCny = null; portfolio.summary.totalMv = null;
    if (incomplete.some((a) => a.currency === 'USD')) portfolio.summary.assetsUsd = null;
    if (incomplete.some((a) => a.currency === 'CNY')) portfolio.summary.assetsCny = null;
    if (incomplete.some((a) => a.currency === 'HKD')) portfolio.summary.assetsHkd = null;
  }
  for (const holding of portfolio.holdings) {
    if (accountsVisible) holding.accountName = accounts.find(a => a.id === holding.accountId)?.name || '待归属';
    else delete holding.accountName;
  }
  if (!accountsVisible) for (const fund of portfolio.fundHoldings) delete fund.accountName;
  return hasStockPermission(req, 'cash') ? { ...portfolio, cashVisible: true } : redactPortfolioCash(portfolio);
}

function scopedTrades(req, trades) {
  return req.query.accountId ? trades.filter((t) => (t.account_id || 'unassigned') === req.query.accountId) : trades;
}

function accountEditor(req, res, binding = false) {
  if (!requireStockPermission(req, res, 'accounts', 'edit') || !requireStockPermission(req, res, 'cash', 'edit')) return false;
  const permissions = portalPermissions(req) || [];
  if (binding && !permissions.includes('*') && !permissions.includes('bookkeeping:accounts:edit')) {
    res.status(403).json({ error: '绑定需要记账账户编辑权限' }); return false;
  }
  return true;
}

function hasFundTrades(accountId, code) {
  return store.read().trades.some(t => t.account_id === accountId && fundCode(t.symbol) === code && t.type !== 'other');
}

app.put('/api/fund-holdings/:accountId/:code', async (req, res) => {
  if (!requireStockPermission(req, res, 'fund-holdings', 'edit')) return;
  const user = currentPortfolioUserId();
  const { accountId, code } = req.params;
  const name = String(req.body?.name || '').trim();
  const shares = Number(req.body?.shares);
  const cost = Number(req.body?.cost);
  if (!investmentRows(portfolioDb, user).some(a => a.id === accountId && a.currency === 'CNY')) {
    return res.status(400).json({ error: '请选择本人名下的人民币渠道账户' });
  }
  if (!/^\d{6}$/.test(code) || !name || name.length > 100 || !Number.isFinite(shares) || shares <= 0 || shares > 1e12 ||
    req.body?.cost == null || req.body.cost === '' || !Number.isFinite(cost) || cost < 0 || cost > 1e12) {
    return res.status(400).json({ error: '请填写有效的基金代码、名称、份额和成本' });
  }
  const previous = portfolioDb.prepare('SELECT nav,nav_date FROM fund_holdings WHERE user_id=? AND account_id=? AND code=?').get(user, accountId, code);
  try {
    if (hasFundTrades(accountId, code)) return res.status(409).json({ error: '此基金已有交易记录，期初份额与成本已用于交易核算' });
    if (req.body.edit === true) {
      if (!previous) return res.status(404).json({ error: '基金持仓不存在' });
      portfolioDb.prepare('UPDATE fund_holdings SET name=?,shares=?,cost=? WHERE user_id=? AND account_id=? AND code=?')
        .run(name, shares, roundMoney(cost), user, accountId, code);
    } else {
      if (previous) return res.status(409).json({ error: '该账户已录入此基金，请使用编辑' });
      const quote = await getFundNav(code);
      if (hasFundTrades(accountId, code)) return res.status(409).json({ error: '此基金已有交易记录，请从记一笔录入' });
      const inserted = portfolioDb.prepare('INSERT OR IGNORE INTO fund_holdings(user_id,account_id,code,name,shares,cost,nav,nav_date) VALUES(?,?,?,?,?,?,?,?)')
        .run(user, accountId, code, name, shares, roundMoney(cost), quote.nav, quote.date);
      if (!inserted.changes) return res.status(409).json({ error: '该账户已录入此基金，请使用编辑' });
    }
    res.json({ ok: true });
  } catch (error) {
    const unsupported = error.message.includes('按万份收益');
    res.status(unsupported ? 400 : 502).json({ error: unsupported ? error.message : '无法获取该基金的公布净值，请核对代码后重试' });
  }
});

app.post('/api/fund-holdings/:accountId/:code/refresh', async (req, res) => {
  if (!requireStockPermission(req, res, 'fund-holdings', 'edit')) return;
  const { accountId, code } = req.params;
  const symbol = `${code}.OF`;
  const account = store.read().investmentAccounts?.find(a => a.id === accountId);
  if (!account?.positions.some(p => p.symbol === symbol && p.type === 'fund')) {
    return res.status(404).json({ error: '基金持仓不存在' });
  }
  try {
    const quote = await quotes.getQuote(symbol);
    const data = store.read();
    if (!(data.quotes[symbol]?.asOf > quote.asOf)) store.write({ ...data, quotes: { ...data.quotes, [symbol]: quote } });
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: '净值更新失败，已保留上次净值' });
  }
});

app.delete('/api/fund-holdings/:accountId/:code', (req, res) => {
  if (!requireStockPermission(req, res, 'fund-holdings', 'edit')) return;
  if (hasFundTrades(req.params.accountId, req.params.code)) return res.status(409).json({ error: '此基金已有交易记录，不能移除期初份额' });
  portfolioDb.prepare('DELETE FROM fund_holdings WHERE user_id=? AND account_id=? AND code=?')
    .run(currentPortfolioUserId(), req.params.accountId, req.params.code);
  res.json({ ok: true });
});

app.get('/api/accounts', (req, res) => {
  if (!requireStockPermission(req, res, 'accounts')) return;
  const data = store.read();
  const full = hasStockPermission(req, 'cash');
  if (full) {
    const funds = dipCashFunds(portfolioDb, currentPortfolioUserId(), data);
    data.investmentAccounts = data.investmentAccounts?.map((a) => ({ ...a, ...funds.find((f) => f.accountId === a.id) }));
  }
  const permissions = portalPermissions(req) || [];
  const ledgerDetails = permissions.includes('*') || (permissions.includes('bookkeeping:view') && permissions.includes('bookkeeping:accounts:view'));
  res.json({ accounts: orderedInvestmentAccounts(data.investmentAccounts || []).map((a) => full ? { ...a, movements: a.movements.filter((m) => m.kind === 'stock' || ledgerDetails), ...(!ledgerDetails ? { bookkeepingName: a.bookkeepingId ? '已绑定记账账户' : null, oldLedgerBalance: null } : {}) } : { id: a.id, name: a.name, currency: a.currency }), unassigned: data.trades.filter((t) => !t.account_id).length });
});
app.put('/api/accounts/order', (req, res) => {
  if (!requireStockPermission(req, res, 'accounts')) return;
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string')) {
    return res.status(400).json({ error: '账户顺序格式无效' });
  }
  const userId = currentPortfolioUserId();
  const saved = portfolioDb.transaction(() => {
    const owned = new Set(investmentRows(portfolioDb, userId).map(account => account.id));
    if (owned.size !== ids.length || ids.some(id => !owned.has(id))) return false;
    portfolioDb.prepare('INSERT OR REPLACE INTO portfolio_user_meta(user_id,key,value) VALUES(?,?,?)')
      .run(userId, 'investment_account_order', JSON.stringify(ids));
    return true;
  }).immediate();
  if (!saved) return res.status(409).json({ error: '账户列表已变化，请重新打开账户管理后再调整顺序' });
  res.json({ ok: true });
});
app.put('/api/accounts/:id/dip-reserve', (req, res) => {
  if (!requireStockPermission(req, res, 'dip-funds', 'edit') || !requireStockPermission(req, res, 'cash', 'edit')) return;
  try { res.json({ funds: setDipCashReserve(portfolioDb, currentPortfolioUserId(), req.params.id, req.body.amount) }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.get('/api/accounts/bookkeeping-options', (req, res) => {
  if (!requireStockPermission(req, res, 'accounts') || !requireStockPermission(req, res, 'cash')) return;
  const permissions = portalPermissions(req) || [];
  if (!permissions.includes('*') && !permissions.includes('bookkeeping:accounts:view')) return res.status(403).json({ error: '需要记账账户查看权限' });
  const accounts = createBookkeepingStore(portfolioDb).accounts(currentPortfolioUserId());
  res.json(accounts.filter((a) => !a.archived && ['USD', 'CNY', 'HKD'].includes(a.currency) && a.accountType !== '信用卡').map(({ id, name, group, currency, balance, balanceSource }) => ({ id, name, group, currency, balance, balanceSource })));
});
app.post('/api/accounts', async (req, res) => {
  if (!accountEditor(req, res, !!req.body.bookkeepingId)) return;
  try {
    if (req.body.currency === 'HKD' && !store.read().usdHkdRate) {
      const { rate } = await quotes.getUsdHkd();
      store.write({ ...store.read(), usdHkdRate: rate });
    }
    const id = saveInvestmentAccount(portfolioDb, currentPortfolioUserId(), req.body);
    res.json({ id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/accounts/:id', (req, res) => {
  const old = investmentRows(portfolioDb, currentPortfolioUserId()).find((a) => a.id === req.params.id);
  if (!accountEditor(req, res, !!old?.bookkeeping_id || !!req.body.bookkeepingId)) return;
  try { const id = saveInvestmentAccount(portfolioDb, currentPortfolioUserId(), req.body, req.params.id); res.json({ id }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/accounts/:id/unlink', (req, res) => {
  if (!accountEditor(req, res, true)) return;
  try { unlinkInvestmentAccount(portfolioDb, currentPortfolioUserId(), req.params.id); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/accounts/:id/assign', (req, res) => {
  if (!accountEditor(req, res) || !requireStockPermission(req, res, 'trade', 'edit')) return;
  try {
    const account = investmentRows(portfolioDb, currentPortfolioUserId()).find((a) => a.id === req.params.id);
    if (!account) throw new Error('账户不存在');
    const data = store.read();
    let count = 0;
    data.trades = data.trades.map((t) => {
      if (!t.account_id && (t.currency || (/^\d{6}$/.test(t.symbol) ? 'CNY' : 'USD')) === account.currency) { count++; return { ...t, account_id: account.id }; }
      return t;
    });
    store.write(data); res.json({ count });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

function sendPortfolio(res, req) {
  res.json(portfolioForRequest(req));
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/portfolio', (req, res) => {
  sendPortfolio(res, req);
});

app.put('/api/cash', (req, res) => {
  if (!requireStockPermission(req, res, 'cash', 'edit')) return;
  const data = store.read();
  if (data.accountCashEnabled) return res.status(400).json({ error: '现金已按账户自动汇总，请在账户管理中核对现金' });
  const body = req.body || {};
  let cashUsd = data.cashUsd;
  let cashCny = data.cashCny;
  let usdCnyRate = data.usdCnyRate;

  if ('cashUsd' in body || 'cashCny' in body || 'usdCnyRate' in body) {
    if ('cashUsd' in body) {
      cashUsd = roundMoney(Number(body.cashUsd));
      if (!Number.isFinite(cashUsd)) return res.status(400).json({ error: '无效美元现金' });
    }
    if ('cashCny' in body) {
      cashCny = roundMoney(Number(body.cashCny));
      if (!Number.isFinite(cashCny)) return res.status(400).json({ error: '无效人民币现金' });
    }
    if ('usdCnyRate' in body && body.usdCnyRate != null && body.usdCnyRate !== '') {
      usdCnyRate = Number(body.usdCnyRate);
      if (!Number.isFinite(usdCnyRate) || usdCnyRate <= 0) {
        return res.status(400).json({ error: '无效汇率' });
      }
    }
  } else if ('cash' in body) {
    cashUsd = roundMoney(Number(body.cash));
    if (!Number.isFinite(cashUsd)) return res.status(400).json({ error: '无效现金' });
  } else {
    return res.status(400).json({ error: '无效现金' });
  }

  data.cashUsd = cashUsd;
  data.cashCny = cashCny;
  data.usdCnyRate = usdCnyRate;
  data.cash = cashUsdEquivalent(cashUsd, cashCny, usdCnyRate);
  store.write(data);
  sendPortfolio(res, req);
});

app.put('/api/holdings-meta/:symbol', (req, res) => {
  const symbol = normalizeSymbol(req.params.symbol);
  if (!symbol) return res.status(400).json({ error: '无效代码' });
  const data = store.read();
  if (!data.holdingsMeta) data.holdingsMeta = {};
  const prev = data.holdingsMeta[symbol] || {};
  const next = { ...prev };
  if ('targetPrice' in req.body) {
    const v = req.body.targetPrice;
    next.targetPrice = v === '' || v == null ? '' : roundPrice(Number(v));
  }
  if ('signal' in req.body) {
    next.signal = String(req.body.signal || '');
  }
  if ('groupWith' in req.body) {
    const v = req.body.groupWith;
    if (v === '' || v == null) delete next.groupWith;
    else next.groupWith = normalizeSymbol(v);
  }
  data.holdingsMeta[symbol] = next;
  store.write(data);
  sendPortfolio(res, req);
});

async function recordNamedTrade(input) {
  const symbol = normalizeSymbol(input.symbol);
  const code = input.type !== 'other' && fundIdentifier(symbol);
  if (!code) {
    const trade = await normalizeNamedTrade(input, async sym => ({ name: await quotes.getInstrumentName(sym) }));
    const quote = trade.historicalBackfill && trade.type !== 'other' && !store.read().quotes[symbol]?.price
      ? await quotes.getQuote(symbol).catch(() => null) : null;
    return { trade, quote };
  }
  const data = store.read();
  if (hongKongFundIsin(symbol)) {
    const info = hkFundInfo(symbol);
    if (!info) throw new Error('暂未接入此香港基金份额');
    const trade = await normalizeNamedTrade({ ...input, name: info.name, currency: info.currency });
    const quote = data.quotes[symbol] ? null : await quotes.getQuote(symbol).catch(() => null);
    return { trade, quote };
  }
  const opening = openingFundsForAccount().find(fund => fund.code === code);
  const existing = data.trades.find(t => t.symbol === symbol && t.type !== 'other');
  let name = opening?.name || existing?.name;
  if (!name) {
    const { fund } = await findMainlandInstruments(code);
    if (!fund) throw new Error('未找到该场外基金，请核对代码');
    if (fund.moneyMarket) throw new Error('此基金按万份收益估值，暂不支持录入');
    name = fund.name;
  }
  const trade = await normalizeNamedTrade({ ...input, name: String(input.name || '').trim() || name });
  const quote = data.quotes[symbol] ? null : await quotes.getQuote(symbol).catch(() => null);
  return { trade, quote };
}

function backfillSavedTrades(trades) {
  try {
    queueSavedTradeHistory(portfolioDb, currentPortfolioUserId(), trades, tradeCalendarDate(new Date().toISOString()));
  } catch (error) {
    console.warn('历史估值补查排队失败:', error.message);
  }
}

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
    data.trades[i] = { ...trade, ...(old.broker_order_key ? { broker: old.broker, broker_order_key: old.broker_order_key, broker_net: old.broker_net, cash_effective_at: old.cash_effective_at, repo_principal: old.repo_principal, broker_category: old.broker_category, source_trade_date: old.source_trade_date, settlement_date: old.settlement_date, security_received_at: old.security_received_at } : {}), id: req.params.id, created_at: old.created_at || trade.created_at };
    Object.assign(data, applyCashDelta(undoCashDelta(data, old), trade));
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

function brokerImportPlan(req, trades, data) {
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
const isBrokerImport = trades => !!(trades.importInfo || trades.fundImportInfo || trades[0]?.broker === 'bbae');

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
  type: ['application/octet-stream', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  limit: '20mb'
}), async (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
  if (!buf.length) return res.status(400).json({ error: '空文件' });
  try {
    const trades = parseImportBuffer(buf);
    if (!trades.length && !trades.importInfo && !trades.fundImportInfo) return res.status(400).json({ error: '未解析到有效记录' });
    const data = store.read();
    await fillImportedNames(trades, data);
    const plan = isBrokerImport(trades) ? brokerImportPlan(req, trades, data) : null;
    const rows = plan?.preview || trades;
    const history = importHistoryPlan(buf, rows, importAccount(req), plan ? 'merge' : String(req.query.mode || 'merge'));
    const pageSize = 50;
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    const page = Math.min(pages, Math.max(1, Math.trunc(Number(req.query.page) || 1)));
    const start = (page - 1) * pageSize;
    const preview = rows.slice(start, start + pageSize).map((row, i) => ({
      ...describeReinvestment(row), ...(history.eligible.has(start + i) ? { historicalIndex: start + i } : {})
    }));
    res.json({ count: rows.length, format: trades.fundImportInfo ? 'fund' : trades.importInfo ? 'eastmoney' : plan ? 'bbae' : 'other',
      summary: plan?.summary, trades: trades.slice(0, 5).map(describeReinvestment), preview, page, pages,
      history: { snapshot: history.snapshot, count: history.eligible.size } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/trades/import', express.raw({
  type: ['application/octet-stream', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  limit: importFileLimit + importHistoryMetaLimit + 4
}), async (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
  if (!buf.length) return res.status(400).json({ error: '空文件' });
  try {
    const { file, selection } = decodeImportHistory(buf, req.query.historicalSelection === '1');
    if (file.length > importFileLimit) throw new Error('文件不能超过 20 MB');
    const imported = parseImportBuffer(file);
    if (!imported.length) return res.status(400).json({ error: imported.importInfo ? '此交割单没有本次支持的可导入交易，请查看预览中的未导入原因' : '未解析到有效记录' });
    await fillImportedNames(imported, store.read());
    const mode = String(req.query.mode || 'merge');
    const build = () => {
      const data = store.read();
      const account = importAccount(req);
      const broker = isBrokerImport(imported);
      if (broker && mode !== 'merge') throw new Error('券商导出可能只含部分日期，请使用合并模式，避免删除其他交易');
      const plan = broker ? brokerImportPlan(req, imported, data) : null;
      if (plan?.summary.unassigned) throw new Error('存在可能重复的未归属历史，请先核对并设置账户归属，未导入');
      if (plan?.summary.updated && req.query.allowUpdates !== '1') throw new Error('存在待更新记录，请先预览并明确勾选允许更新匹配记录');
      const rows = plan?.preview || imported;
      const indexes = selection ? selectHistoricalImports(importHistoryPlan(file, rows, account, mode), selection) : new Set();
      const selected = [...indexes].map(i => rows[i]);
      const ids = new Set(selected.map(row => row.id));
      const next = imported.map(t => req.query.accountId ? { ...t, account_id: req.query.accountId } : t);
      const base = mode === 'replace' ? req.query.accountId ? data.trades.filter(t => t.account_id !== req.query.accountId) : [] : data.trades;
      const merged = plan?.trades || base.concat(next);
      const trades = ids.size ? merged.map(t => ids.has(t.id) ? { ...t, historicalBackfill: true } : t) : merged;
      return { data, trades, selected, account, importSummary: plan?.summary };
    };
    let result = build();
    const needed = result.account?.bookkeeping_id ? [...new Set(result.selected.filter(t => t.type !== 'other')
      .map(t => t.symbol).filter(s => !(result.data.quotes[s]?.price > 0)))] : [];
    if (needed.length) {
      const fetched = await mapWithConcurrency(needed, 4, async symbol => [symbol, await quotes.getQuote(symbol).catch(() => null)]);
      result = build();
      for (const [symbol, quote] of fetched) if (quote?.price > 0 && !(result.data.quotes[symbol]?.price > 0)) result.data.quotes[symbol] = quote;
    }
    const { data, trades, selected, importSummary } = result;
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
    res.json({ ...portfolioForRequest(req, saved), importSummary, historicalBackfillCount: selected.length,
      importQuoteRefreshCount: refreshSymbols.length, importHkdRatePending });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/pnl', (req, res) => {
  if (!requireStockPermission(req, res, 'pnl')) return;
  const data = store.read();
  res.json(computePnl(tradesForCalculations(req, data.trades), {
    startDate: req.query.start || undefined,
    endDate: req.query.end || undefined,
    usdCnyRate: data.usdCnyRate,
    usdHkdRate: data.usdHkdRate
  }));
});

app.get('/api/trades/review', (req, res) => {
  if (!requireStockPermission(req, res, 'trade-review') || !requireStockPermission(req, res, 'trades')) return;
  try {
    const data = store.read();
    res.json(computeTradeReview(tradesForCalculations(req, data.trades), {
      startDate: req.query.start, endDate: req.query.end,
      symbol: req.query.symbol, assetType: req.query.assetType, otherCategory: req.query.otherCategory
    }));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/trades/summary', (req, res) => {
  if (!requireStockPermission(req, res, 'trades')) return;
  const data = store.read();
  res.json(computeSymbolSummaries(tradesForCalculations(req, data.trades), {
    startDate: req.query.start || undefined,
    endDate: req.query.end || undefined,
    usdCnyRate: data.usdCnyRate,
    usdHkdRate: data.usdHkdRate,
    quotes: data.quotes,
    assetType: req.query.assetType,
    otherCategory: req.query.otherCategory,
    symbol: req.query.symbol
  }));
});

app.get('/api/trades/export', (req, res) => {
  if (!requireStockPermission(req, res, 'trades') || !requireStockPermission(req, res, 'export')) return;
  const data = store.read();
  let trades = [...scopedTrades(req, data.trades)].sort((a, b) => new Date(b.trade_date) - new Date(a.trade_date));
  const sym = String(req.query.symbol || '').trim().toUpperCase();
  const type = req.query.type;
  const start = req.query.start;
  const end = req.query.end;
  if (sym) trades = trades.filter((t) => t.symbol.toUpperCase().includes(sym));
  if (type && type !== 'all') trades = trades.filter((t) => t.type === type);
  if (req.query.assetType && req.query.assetType !== 'all') trades = trades.filter((t) => tradeAssetType(t) === req.query.assetType);
  if (req.query.otherCategory) trades = trades.filter((t) => t.type !== 'other' || (t.other_category || '').includes(req.query.otherCategory));
  if (start) trades = trades.filter((t) => (tradeCalendarDate(t.trade_date) || '') >= start);
  if (end) trades = trades.filter((t) => (tradeCalendarDate(t.trade_date) || '') <= end);

  const rows = trades.map((t) => ({
    账户ID: t.account_id || '',
    证券账户: data.investmentAccounts?.find((a) => a.id === t.account_id)?.name || '待归属',
    时间: formatZonedDateTime(t.trade_date),
    类型: TRADE_ASSET_TYPES[tradeAssetType(t)],
    交易方向: t.reinvestedDividend ? '红利再投资' : t.type === 'buy' ? '买入' : t.type === 'sell' ? '卖出' : '其它',
    其它类别: t.other_category || '',
    代码: t.symbol,
    名称: t.name || '',
    币种: t.currency || 'USD',
    股数: t.type === 'other' ? '' : t.shares,
    价格: t.reinvestedDividend ? t.reinvestmentNav ?? '' : t.type === 'other' ? '' : t.price,
    金额: t.total_amount,
    手续费: t.commission
  }));
  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(rows);
  rows.forEach((_, index) => {
    const cell = sheet[XLSX.utils.encode_cell({ r: index + 1, c: 10 })];
    if (cell?.t === 'n') cell.z = hongKongFundIsin(trades[index].symbol) ? '0.00000' : fundCode(trades[index].symbol) ? '0.0000' : '0.000';
  });
  XLSX.utils.book_append_sheet(wb, sheet, '交易记录');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=trades.xlsx');
  res.send(buf);
});

app.get('/api/search', async (req, res) => {
  try {
    res.json(await quotes.search(req.query.q));
  } catch {
    res.json([]);
  }
});

async function lookupInstrumentName(symbol) {
  const market = inferMarket(symbol);
  return await quotes.getInstrumentName(symbol).catch(() => '')
    || (['US', 'HK'].includes(market) ? await findInternationalStockName(symbol, market) : '');
}

app.get('/api/fund-reinvestment/nav', async (req, res) => {
  if (!hasStockPermission(req, 'trade', 'edit') && !requireStockPermission(req, res, 'row-trade', 'edit')) return;
  res.set('Cache-Control', 'no-store');
  try {
    const code = fundCode(req.query.symbol);
    res.json(await findReinvestmentNav(code, String(req.query.date || '')));
  } catch {
    res.status(502).json({ error: '暂时查不到折算净值，仍可按份额保存' });
  }
});

app.get('/api/instruments/resolve', async (req, res) => {
  if (!['trade', 'row-trade'].some(feature => hasStockPermission(req, feature, 'edit'))) {
    return res.status(403).json({ error: '无权录入交易' });
  }
  const raw = String(req.query.symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.\-]{0,31}$/.test(raw)) return res.json([]);
  const symbol = normalizeSymbol(raw);
  const market = inferMarket(raw);
  const candidate = (symbol, name) => ({ symbol, name, assetType: holdingTypeForSymbol(symbol), currency: inferCurrency(symbol) });
  const data = store.read();
  const names = knownTradeNames(data.trades, data.quotes);
  const storedName = symbol => {
    if (fundCode(symbol)) {
      const opening = openingFundsForAccount().find(fund => fund.code === fundCode(symbol));
      if (opening) return opening.name;
    }
    return names.get(symbol);
  };
  const listedName = async () => storedName(symbol) || await quotes.getInstrumentName(symbol).catch(() => '');
  try {
    if (hongKongFundIsin(symbol)) {
      const info = hkFundInfo(symbol);
      return res.json(info ? [candidate(symbol, info.name)] : []);
    }
    if (market === 'FUND') {
      const known = storedName(symbol);
      if (known) return res.json([candidate(symbol, known)]);
    }
    if (market === 'FUND' || (market === 'CN' && /^\d{6}$/.test(raw))) {
      const code = fundCode(symbol) || symbol;
      const [instruments, quoteName] = await Promise.all([findMainlandInstruments(code), market === 'CN' ? listedName() : '']);
      const { fund, listedName: suggestedListing } = instruments;
      const listed = market === 'CN' ? quoteName || suggestedListing : '';
      const result = listed ? [candidate(symbol, listed)] : [];
      if (fund && !fund.moneyMarket) result.push(candidate(`${code}.OF`, fund.name));
      if (!result.length && fund?.moneyMarket) return res.status(400).json({ error: '此基金按万份收益估值，暂不支持录入' });
      return res.json(result);
    }
    const name = storedName(symbol) || await lookupInstrumentName(symbol);
    res.json(name ? [candidate(symbol, name)] : []);
  } catch {
    res.status(502).json({ error: '标的识别暂时失败，请重试' });
  }
});

app.get('/api/stock/:symbol', async (req, res) => {
  try {
    res.json(await quotes.getStock(req.params.symbol));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

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

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function analyzeQuantSymbols(rawSymbols, rawPeriod, rawConfig, userId = 'local') {
    const data = store.read();
    const holdings = deriveHoldings(data.trades);
    const holdingMap = new Map(holdings.map((holding) => [normalizeSymbol(holding.symbol), holding]));
    const saved = quantStore.read(userId).settings;
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

app.get('/api/quant/settings', (req, res) => {
  if (!requireQuantPermission(req, res, 'quant-settings')) return;
  res.json(quantStore.read(quantUserId(req)).settings);
});

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

app.put('/api/quant/settings', (req, res) => {
  const scope = ['watchlist', 'config', 'paper'].includes(req.body?.scope) ? req.body.scope : 'watchlist';
  const scopeFeature = {
    watchlist: 'quant-watchlist',
    config: 'quant-config',
    paper: 'quant-paper-settings'
  }[scope];
  if (!requireQuantPermission(req, res, scopeFeature, 'edit')) return;
  const userId = quantUserId(req);
  const current = quantStore.read(userId);
  const body = req.body || {};
  if (scope === 'watchlist') {
    const rawSymbols = Array.isArray(body.symbols) ? body.symbols.join(',') : String(body.symbols || '');
    const symbols = quantSymbols(rawSymbols);
    if (!symbols.length) return res.status(400).json({ error: '请至少保存一个有效的美股代码' });
    current.settings.symbols = symbols;
    current.settings.period = quantPeriod(body.period).key;
  } else if (scope === 'config') {
    current.settings.config = normalizeQuantConfig(body.config || current.settings.config);
  } else {
    current.settings.paperInitialCapital = Math.max(1000, Math.min(100000000, Number(body.paperInitialCapital) || current.settings.paperInitialCapital));
    current.settings.paperPositionPct = Math.max(0.01, Math.min(1, Number(body.paperPositionPct) || current.settings.paperPositionPct));
  }
  res.json(quantStore.write(userId, current).settings);
});

app.get('/api/quant/backtests', (req, res) => {
  if (!requireQuantPermission(req, res, 'quant-backtest')) return;
  res.json({ items: quantBacktestStore.list(quantUserId(req), req.query.limit) });
});

app.get('/api/quant/backtests/:id', (req, res) => {
  if (!requireQuantPermission(req, res, 'quant-backtest')) return;
  const result = quantBacktestStore.get(quantUserId(req), req.params.id);
  if (!result) return res.status(404).json({ error: '回测记录不存在' });
  res.json(result);
});

app.delete('/api/quant/backtests/:id', (req, res) => {
  if (!requireQuantPermission(req, res, 'quant-backtest-delete', 'edit')) return;
  const removed = quantBacktestStore.remove(quantUserId(req), req.params.id);
  if (!removed) return res.status(404).json({ error: '回测记录不存在' });
  res.json({ ok: true });
});

app.post('/api/quant/backtest', async (req, res) => {
  if (!requireQuantPermission(req, res, 'quant-backtest-run', 'edit')) return;
  try {
    const userId = quantUserId(req);
    const savedState = quantStore.read(userId);
    const saved = savedState.settings;
    const rawSymbols = Array.isArray(req.body?.symbols) ? req.body.symbols.join(',') : String(req.body?.symbols || '');
    const symbols = quantSymbols(rawSymbols, saved.symbols);
    if (!symbols.length) return res.status(400).json({ error: '请选择回测标的' });
    const period = quantPeriod(req.body?.period || saved.period);
    const strategyConfig = normalizeQuantConfig(req.body?.config || saved.config);
    const initialCapital = Math.max(1000, Math.min(100000000, Number(req.body?.initialCapital) || 100000));
    saved.backtestPeriod = period.key === '3m' ? '6m' : period.key;
    saved.backtestInitialCapital = initialCapital;
    quantStore.write(userId, savedState);
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
    res.json(quantBacktestStore.save(userId, response));
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

app.get('/api/quant/paper', (req, res) => {
  if (!requireQuantPermission(req, res, 'quant-paper')) return;
  res.json(paperView(quantStore.read(quantUserId(req))));
});

app.post('/api/quant/paper/reset', (req, res) => {
  if (!requireQuantPermission(req, res, 'quant-paper-reset', 'edit')) return;
  const userId = quantUserId(req);
  const saved = quantStore.read(userId);
  if (Number(req.body?.initialCapital) >= 1000) saved.settings.paperInitialCapital = Number(req.body.initialCapital);
  saved.paper = resetPaper(saved.settings);
  res.json(paperView(quantStore.write(userId, saved)));
});

app.post('/api/quant/paper/sync', async (req, res) => {
  if (!requireQuantPermission(req, res, 'quant-paper-sync', 'edit')) return;
  try {
    const userId = quantUserId(req);
    const saved = quantStore.read(userId);
    const analysis = await analyzeQuantSymbols(saved.settings.symbols.join(','), saved.settings.period, saved.settings.config, userId);
    const now = Date.now();
    const trades = [];
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
    quantStore.write(userId, saved);
    res.json({ ...paperView(saved, analysis.signals), executed: trades, signals: analysis.signals });
  } catch (error) {
    res.status(500).json({ error: error.message || '模拟盘同步失败' });
  }
});

app.get('/api/option/:symbol', async (req, res) => {
  try {
    res.json(await quotes.getOption(req.params.symbol));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/quotes/refresh', async (req, res) => {
  const data = store.read();
  const symbol = req.body?.symbol;
  const symbols = symbol
    ? [normalizeSymbol(symbol)]
    : [...new Set(deriveHoldings([...openingFundTrades(openingFundsForAccount()), ...data.trades]).map(h => h.symbol))];
  if (!symbols.length) {
    return res.status(400).json({ error: '暂无持仓可刷新' });
  }
  const updated = {};
  const rates = {};
  const errors = [];
  let ok = 0;
  for (const sym of symbols) {
    try {
      updated[sym] = await quotes.getQuote(sym);
      ok += 1;
      if (!symbol) await new Promise((r) => setTimeout(r, 800));
    } catch (e) {
      errors.push({ symbol: sym, error: e.message || '失败' });
    }
  }
  try {
    const fx = await quotes.getUsdCny();
    if (fx?.rate > 0) rates.usdCnyRate = fx.rate;
  } catch (e) {
    errors.push({ symbol: 'USDCNY', error: e.message || '汇率失败' });
  }
  if (data.investmentAccounts?.some(account => account.currency === 'HKD')) {
    try { rates.usdHkdRate = (await quotes.getUsdHkd()).rate; }
    catch (e) { errors.push({ symbol: 'USDHKD', error: e.message || '汇率失败' }); }
  }
  const latest = store.read();
  for (const [sym, quote] of Object.entries(updated)) {
    if (fundIdentifier(sym) && latest.quotes[sym]?.asOf > quote.asOf) delete updated[sym];
    else updated[sym] = completePortfolioFundQuote(quote, latest.quotes[sym]);
  }
  const saved = store.write({ ...latest, ...rates, quotes: { ...latest.quotes, ...updated } });
  const payload = portfolioForRequest(req, saved);
  payload.refresh = { ok, failed: errors.length, errors };
  if (!ok && errors.length) {
    return res.status(502).json({ error: '行情刷新全部失败', ...payload });
  }
  res.json(payload);
});

app.get('/vendor/echarts.min.js', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'node_modules', 'echarts', 'dist', 'echarts.min.js'));
});
app.get('/js/dividend-tax.js', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'shared', 'dividend-tax.js'));
});
app.all(/^\/(?:api\/)?yolo(?:\/|$)/i, (_req, res) => res.sendStatus(404));
app.use(express.static(PUBLIC));
app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC, 'index.html'));
});

const { host, port } = config.server;
app.listen(port, host, () => {
  console.log(`stock-manage http://${host}:${port}`);
});
