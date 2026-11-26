import { progressResponse } from './progress-response.js';
import { registerTradeImportRoutes } from './trade-import-routes.js';
import { mapWithConcurrency } from '../../shared/map-with-concurrency.js';
import { registerQuantRoutes } from './quant-routes.js';
import { registerTradeRoutes } from './trade-routes.js';
import { ensureFundHoldings, fundCode, fundIdentifier, hongKongFundIsin, fundHoldings, fundValuation, openingFundTrades } from '../../shared/fund-holdings.js';
import { completeChinaAmcMovement, hkFundInfo } from './hk-fund-nav.js';
import { Decimal } from '../../shared/portfolio-decimal.js';
import { estimatedReinvestmentIncome, tradesWithReinvestmentIncome } from '../../shared/fund-reinvestment.js';
import { findInternationalStockName, findMainlandInstruments, findReinvestmentNav, getFundNav } from './fund-nav.js';
import { TRADE_ASSET_TYPES, tradeAssetType } from '../public/js/trade-asset-type.js';
import { serveUiAsset } from '../../shared/ui-assets.js';
import { portfolioIdentityMiddleware } from '../../shared/portfolio-user.js';
import { currentPortfolioUserId } from '../../shared/portfolio-user.js';
import { getDatabase } from '../../shared/db/index.js';
import { investmentRows, projectInvestments, saveInvestmentAccount, unlinkInvestmentAccount } from '../../shared/investment-accounts.js';
import { dipCashFunds, setDipCashReserve } from '../../shared/dip-cash-funds.js';
import { createBookkeepingStore } from '../../portal/src/bookkeeping-store.js';
import { queueSavedTradeHistory } from '../../portal/src/bookkeeping-security-history.js';
import { configureQuoteNetwork } from '../../shared/quote-network.js';
import express from 'express';
import path from 'node:path';
import XLSX from 'xlsx';
import { fileURLToPath } from 'node:url';
import { loadConfig, createStore } from './storage.js';
import { createQuoteService } from './quotes.js';
import { knownTradeNames, normalizeNamedTrade } from './trade-name.js';
import { computeTradeReview } from './trade-review.js';
import {
  deriveHoldings,
  computePnl,
  computeSymbolSummaries,
  buildDailyCumulativeSeries,
  enrichHoldings,
  computeDailySummary,
  roundMoney,
  roundPrice,
  cashUsdEquivalent,
  tradeCalendarDate,
  formatZonedDateTime
} from './trades.js';
import { holdingTypeForSymbol, inferCurrency, inferMarket, normalizeSymbol } from './markets.js';
import { DEFAULT_USD_CNY_RATE, ensureUserPortfolioSchema } from '../../shared/db/portfolio-store.js';
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
  const { valuationOnly } = pnlOpts;
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
  const pnl = valuationOnly ? undefined : computePnl(calculationTrades, fxOpts);
  const sparse = valuationOnly ? undefined : buildDailyCumulativeSeries(calculationTrades, fxOpts);
  const daily = computeDailySummary(enriched.rows, calculationTrades, fxOpts);
  const cashEq = enriched.cashUsdEq;
  return {
    cash: cashEq,
    cashUsd: cashState.cashUsd,
    cashCny: cashState.cashCny,
    cashHkd: cashState.cashHkd,
    usdHkdRate: data.usdHkdRate,
    usdCnyRate: rate,
    trades: valuationOnly ? undefined : data.trades.map(describeReinvestment),
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

function portfolioForRequest(req, data = store.read(), { valuationOnly = false } = {}) {
  const accounts = data.investmentAccounts || [];
  const accountsVisible = hasStockPermission(req, 'accounts');
  const pnlOptions = pnlOptsFromReq(req);
  if (!accountsVisible) delete pnlOptions.accountId;
  const { accountId } = pnlOptions;
  if (accountId) {
    const selected = accounts.find((a) => a.id === accountId);
    data = { ...data, trades: data.trades.filter((t) => (t.account_id || 'unassigned') === accountId), cashUsd: selected?.currency === 'USD' ? selected.cash : 0, cashCny: selected?.currency === 'CNY' ? selected.cash : 0, cashHkd: selected?.currency === 'HKD' ? selected.cash : 0 };
  }
  const portfolio = buildPortfolio(data, { ...pnlOptions, valuationOnly });
  if (hasStockPermission(req, 'col-note')) {
    for (const holding of [...portfolio.holdings, ...portfolio.fundHoldings]) {
      const notes = data.holdingsMeta?.[holding.tradeSymbol || holding.symbol]?.notes;
      holding.note = notes?.[holding.accountId || 'unassigned'] || '';
    }
  }
  portfolio.holdingsMeta = Object.fromEntries(Object.entries(data.holdingsMeta || {}).map(([symbol, value]) => {
    const { notes, ...meta } = value || {};
    return [symbol, meta];
  }));
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

app.put('/api/holdings-note/:symbol', (req, res) => {
  if (!requireStockPermission(req, res, 'col-note') || !requireStockPermission(req, res, 'holding-note', 'edit')) return;
  const symbol = normalizeSymbol(req.params.symbol);
  const { accountId, note } = req.body || {};
  if (typeof accountId !== 'string' || typeof note !== 'string' || note.length > 500) {
    return res.status(400).json({ error: '请选择有效持仓，备注最多 500 字' });
  }
  const data = store.read();
  const trades = data.trades.filter(trade => trade.symbol === symbol && (trade.account_id || '') === accountId);
  const openings = openingFundTrades(openingFundsForAccount(accountId || 'unassigned')).filter(trade => trade.symbol === symbol);
  if (!deriveHoldings([...openings, ...trades]).some(row => row.symbol === symbol)) {
    return res.status(404).json({ error: '找不到对应持仓' });
  }
  const meta = data.holdingsMeta[symbol] || {};
  const notes = { ...meta.notes };
  const key = accountId || 'unassigned';
  if (note.trim()) notes[key] = note.trim();
  else delete notes[key];
  data.holdingsMeta[symbol] = { ...meta, notes };
  store.write(data);
  res.json({ ok: true });
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

registerTradeRoutes(app, {
  store, hasStockPermission, requireStockPermission, recordNamedTrade, backfillSavedTrades, sendPortfolio
});

registerTradeImportRoutes(app, {
  config, store, portfolioDb, quotes, requireStockPermission, lookupInstrumentName,
  openingFundsForAccount, completePortfolioFundQuote, describeReinvestment, backfillSavedTrades, portfolioForRequest
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

registerQuantRoutes(app, { config, store, quotes, quantUserId, requireQuantPermission });

app.get('/api/option/:symbol', async (req, res) => {
  try {
    res.json(await quotes.getOption(req.params.symbol));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/quotes/refresh', async (req, res) => {
  if (!requireStockPermission(req, res, 'refresh', 'edit')) return;
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
  const reply = progressResponse(req, res);
  const streaming = req.query.progress === '1';
  const active = new Set();
  const total = symbols.length;
  let completed = 0;
  let ok = 0;
  let nextStart = 0;
  let lastSnapshot = 0;
  const report = (phase, details) => reply.progress(phase, { completed, total, ok, failed: errors.length, active: [...active], ...details });
  const withRefreshedQuotes = (latest) => {
    const merged = { ...latest.quotes };
    for (const [sym, quote] of Object.entries(updated)) {
      if (fundIdentifier(sym) && merged[sym]?.asOf > quote.asOf) continue;
      merged[sym] = completePortfolioFundQuote(quote, merged[sym]);
    }
    return { ...latest, quotes: merged };
  };
  report('quotes');
  let phase = 'quotes';
  const heartbeat = streaming ? setInterval(() => report(phase), 8000) : null;
  try {
    // Pace starts to avoid bursts against providers while overlapping slow requests.
    await mapWithConcurrency(symbols, 3, async (sym) => {
      const now = Date.now();
      const delay = Math.max(0, nextStart - now);
      nextStart = now + delay + 1000;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      active.add(sym);
      report('quotes');
      let received = false;
      try {
        updated[sym] = await quotes.getQuote(sym);
        ok++;
        received = true;
      } catch (error) {
        errors.push({ symbol: sym, error: error.message || '失败' });
      }
      completed++;
      active.delete(sym);
      let valuation;
      if (received && streaming && !res.destroyed && Date.now() - lastSnapshot >= 750) {
        const live = withRefreshedQuotes(store.read());
        live.investmentAccounts = projectInvestments(portfolioDb, currentPortfolioUserId(), live);
        const { holdings, fundHoldings, summary, missingQuotes } = portfolioForRequest(req, live, { valuationOnly: true });
        valuation = { holdings, fundHoldings, summary, missingQuotes };
        lastSnapshot = Date.now();
      }
      report('quotes', { symbol: sym, valuation });
    });
    phase = 'fx';
    report(phase);
    const refreshFx = async (symbol, field, getRate) => {
      try {
        const { rate } = await getRate();
        if (rate > 0) rates[field] = rate;
      } catch (error) {
        errors.push({ symbol, error: error.message || '汇率失败' });
      }
    };
    const fx = [refreshFx('USDCNY', 'usdCnyRate', quotes.getUsdCny)];
    if (data.investmentAccounts?.some(account => account.currency === 'HKD')) {
      fx.push(refreshFx('USDHKD', 'usdHkdRate', quotes.getUsdHkd));
    }
    await Promise.all(fx);
    const saved = store.write({ ...withRefreshedQuotes(store.read()), ...rates });
    const payload = portfolioForRequest(req, saved);
    payload.refresh = { ok, failed: errors.length, errors };
    if (!ok && errors.length) {
      if (streaming) return reply.finish(payload);
      return reply.finish({ error: '行情刷新全部失败', ...payload }, 502);
    }
    reply.finish(payload);
  } catch (error) {
    reply.finish({ error: error.message || '行情刷新失败' }, 500);
  } finally {
    clearInterval(heartbeat);
  }
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
