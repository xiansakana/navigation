import { currentPortfolioUserId, requirePortfolioUserId } from '../portfolio-user.js';
import { createPortfolioBackend } from './portfolio-runtime.js';
import { DEFAULT_USD_CNY_RATE } from './portfolio-store.js';
import {
  normalizeTrade,
  applyCashDelta,
  roundMoney
} from '../../stock-manage/src/trades.js';

let configuredBackend = null;

export function configurePortfolioBackend(backend) {
  configuredBackend = backend;
  return backend;
}

export function resetPortfolioBridge() {
  configuredBackend = null;
}

async function backendFor(options = {}) {
  if (!configuredBackend) configuredBackend = await createPortfolioBackend({ dbPath: options.dbPath });
  return configuredBackend;
}

async function resolveUser(backend, explicit) {
  return requirePortfolioUserId(explicit ?? currentPortfolioUserId() ?? await backend.defaultUserId());
}

export async function getPortfolioStore(options = {}) {
  const backend = await backendFor(options);
  return backend.storeFor(await resolveUser(backend, options.userId));
}

async function readFxMeta(backend, userId) {
  const [fxSource, fxUpdatedAt] = await Promise.all([
    backend.meta(userId, 'fxSource'),
    backend.meta(userId, 'fxUpdatedAt')
  ]);
  return { fxSource: fxSource || null, fxUpdatedAt: fxUpdatedAt || null };
}

/** Shared cash: cashUsd / cashCny / usdCnyRate (+ optional FX metadata). */
export async function getPortfolioCash(options = {}) {
  const backend = await backendFor(options);
  const store = backend.storeFor(await resolveUser(backend, options.userId));
  const data = await store.read();
  const [fx, funds] = await Promise.all([
    readFxMeta(backend, store.userId),
    backend.dipFunds(store.userId, data)
  ]);
  const strategyCash = (cur) => funds.filter((f) => f.currency === cur && !f.deficit).reduce((sum, f) => sum + f.strategyAvailable, 0);
  return {
    strategyCashUsd: strategyCash('USD'), strategyCashCny: strategyCash('CNY'), strategyFunds: funds,
    cashUsd: Number(data.cashUsd) || 0,
    ...(data.accountCashEnabled ? { accountCashEnabled: true } : {}),
    cashCny: Number(data.cashCny) || 0,
    usdCnyRate: Number(data.usdCnyRate) > 0 ? Number(data.usdCnyRate) : DEFAULT_USD_CNY_RATE,
    fxSource: fx.fxSource,
    fxUpdatedAt: fx.fxUpdatedAt
  };
}

export async function setPortfolioCash(patch = {}, options = {}) {
  const backend = await backendFor(options);
  const store = backend.storeFor(await resolveUser(backend, options.userId));
  const data = await store.read();
  if (data.accountCashEnabled && (('cashUsd' in patch && Number(patch.cashUsd) !== data.cashUsd) || ('cashCny' in patch && Number(patch.cashCny) !== data.cashCny))) throw new Error('账户现金已自动汇总，请在证券账户中核对现金');
  if (patch.cashUsd != null) data.cashUsd = roundMoney(Number(patch.cashUsd) || 0);
  if (patch.cashCny != null) data.cashCny = roundMoney(Number(patch.cashCny) || 0);
  if (patch.usdCnyRate != null && Number(patch.usdCnyRate) > 0) {
    data.usdCnyRate = Number(patch.usdCnyRate);
  }
  await store.write(data);

  if (patch.fxSource !== undefined) await backend.setMeta(store.userId, 'fxSource', patch.fxSource);
  if (patch.fxUpdatedAt !== undefined) await backend.setMeta(store.userId, 'fxUpdatedAt', patch.fxUpdatedAt);
  return getPortfolioCash(options);
}

/**
 * One-time migrate: for each pocket, if portfolio is 0 and dip > 0, copy dip.
 * Holdings page wins when portfolio already has balances.
 */
export async function migrateDipCashOnce(dipCash = {}, options = {}) {
  const backend = await backendFor(options);
  const store = backend.storeFor(await resolveUser(backend, options.userId));
  const flag = await backend.meta(store.userId, 'dip_cash_migrated');
  if (flag === '1') {
    return { migrated: false, cash: await getPortfolioCash(options) };
  }

  const data = await store.read();
  let cashUsd = Number(data.cashUsd) || 0;
  let cashCny = Number(data.cashCny) || 0;
  let usdCnyRate = Number(data.usdCnyRate) > 0 ? Number(data.usdCnyRate) : DEFAULT_USD_CNY_RATE;
  const dipUsd = Number(dipCash.cashUsd) || 0;
  const dipCny = Number(dipCash.cashCny) || 0;
  const dipRate = Number(dipCash.usdCnyRate) || 0;

  let changed = false;
  if (cashUsd === 0 && dipUsd > 0) {
    cashUsd = roundMoney(dipUsd);
    changed = true;
  }
  if (cashCny === 0 && dipCny > 0) {
    cashCny = roundMoney(dipCny);
    changed = true;
  }
  if (dipRate > 0 && (dipCash.fxUpdatedAt || changed)) {
    usdCnyRate = dipRate;
    if (dipRate !== Number(data.usdCnyRate)) changed = true;
  }

  if (changed) {
    data.cashUsd = cashUsd;
    data.cashCny = cashCny;
    data.usdCnyRate = usdCnyRate;
    await store.write(data);
    if (dipCash.fxSource != null) await backend.setMeta(store.userId, 'fxSource', String(dipCash.fxSource));
    if (dipCash.fxUpdatedAt != null) await backend.setMeta(store.userId, 'fxUpdatedAt', String(dipCash.fxUpdatedAt));
  }
  await backend.setMeta(store.userId, 'dip_cash_migrated', '1');
  return { migrated: changed, cash: await getPortfolioCash(options) };
}

/** Map dip buyPreview / sell legs to stock-manage trade inputs. */
export function legsToTradeInputs(legs = [], extras = {}) {
  const out = [];
  const note = extras.note || '';
  const tier = extras.tier || '';
  const ts = extras.trade_date || new Date().toISOString();

  for (const leg of legs || []) {
    if (!leg || typeof leg !== 'object') continue;
    const side = String(leg.side || 'buy').toLowerCase() === 'sell' ? 'sell' : 'buy';
    const currency = String(leg.currency || 'USD').toUpperCase() === 'CNY' ? 'CNY' : 'USD';
    const kind = leg.kind || 'equity';

    if (kind === 'call' || kind === 'option') {
      const symbol = String(leg.occSymbol || leg.symbol || '').trim();
      if (!symbol) continue;
      const price = Number(leg.price);
      let shares = Number(leg.contracts ?? leg.shares);
      if (!(shares > 0) && Number(leg.usd) > 0 && price > 0) {
        shares = Math.floor(Number(leg.usd) / (price * 100));
      }
      if (!(shares > 0) || !(price > 0)) continue;
      out.push({
        type: side,
        symbol,
        name: leg.name || `${leg.symbol || 'QQQ'} Call`,
        currency: 'USD',
        shares,
        price,
        commission: Number(leg.commission) || 0,
        trade_date: ts,
        source: 'qqq-dip',
        tier,
        note: [note, leg.note].filter(Boolean).join('；')
      });
      continue;
    }

    const symbol = String(leg.symbol || '').trim();
    if (!symbol) continue;
    const price = Number(leg.price);
    let shares = Number(leg.shares);
    if (!(shares > 0) && price > 0) {
      if (currency === 'CNY' && Number(leg.cny) > 0) shares = Math.floor(Number(leg.cny) / price);
      else if (Number(leg.usd) > 0) shares = Math.floor(Number(leg.usd) / price);
    }
    if (!(shares > 0) || !(price > 0)) continue;
    out.push({
      type: side,
      symbol,
      name: leg.name || ({ '159509': '纳指科技ETF景顺', '513850': '美国50ETF易方达', '161128': '标普信息科技LOF' }[symbol] || symbol),
      currency,
      shares,
      price,
      commission: Number(leg.commission) || 0,
      trade_date: ts,
      source: 'qqq-dip',
      tier,
      note: [note, leg.note].filter(Boolean).join('；')
    });
  }
  return out;
}

/**
 * Append trades WITHOUT applying per-trade cash deltas, then deduct form cash once.
 * Form amounts are the cash truth (plan default).
 */
export async function appendTradesDeductFormCash({
  trades = [],
  deductCashUsd = 0,
  deductCashCny = 0,
  options = {}
} = {}) {
  const store = await getPortfolioStore(options);
  const data = await store.read();
  if (data.accountCashEnabled) throw new Error('已启用证券账户，请在股票管理中选择账户记录抄底交易，避免计划金额与实际成交重复扣款');
  const created = [];

  for (const raw of trades) {
    try {
      const trade = normalizeTrade(raw);
      if (raw.source) trade.source = raw.source;
      if (raw.tier) trade.tier = raw.tier;
      if (raw.note) trade.note = raw.note;
      data.trades.push(trade);
      created.push(trade);
    } catch {
      // skip invalid legs
    }
  }

  const usdSpend = Math.max(0, roundMoney(Number(deductCashUsd) || 0));
  const cnySpend = Math.max(0, roundMoney(Number(deductCashCny) || 0));
  data.cashUsd = Math.max(0, roundMoney((Number(data.cashUsd) || 0) - usdSpend));
  data.cashCny = Math.max(0, roundMoney((Number(data.cashCny) || 0) - cnySpend));
  await store.write(data);

  return {
    trades: created,
    cash: await getPortfolioCash(options)
  };
}

/**
 * Manual sell/buy: apply cash via each trade's native delta.
 */
export async function appendTradesApplyCash(tradeInputs = [], options = {}) {
  const store = await getPortfolioStore(options);
  const data = await store.read();
  const created = [];
  let cashState = {
    cashUsd: Number(data.cashUsd) || 0,
    cashCny: Number(data.cashCny) || 0,
    usdCnyRate: Number(data.usdCnyRate) > 0 ? Number(data.usdCnyRate) : DEFAULT_USD_CNY_RATE
  };

  for (const raw of tradeInputs) {
    try {
      const trade = normalizeTrade(raw);
      if (raw.source) trade.source = raw.source;
      if (raw.tier) trade.tier = raw.tier;
      if (raw.note) trade.note = raw.note;
      data.trades.push(trade);
      created.push(trade);
      cashState = applyCashDelta(cashState, trade);
    } catch {
      // skip
    }
  }
  data.cashUsd = cashState.cashUsd;
  data.cashCny = cashState.cashCny;
  data.usdCnyRate = cashState.usdCnyRate;
  await store.write(data, { strategyFundId: options.strategyFundId });
  return { trades: created, cash: await getPortfolioCash(options) };
}
