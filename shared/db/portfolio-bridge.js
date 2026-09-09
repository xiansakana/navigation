import { getDatabase, closeDatabase } from './connection.js';
import { createPortfolioStore, DEFAULT_USD_CNY_RATE } from './portfolio-store.js';
import {
  normalizeTrade,
  applyCashDelta,
  roundMoney
} from '../../stock-manage/src/trades.js';

let storeSingleton = null;
let dbSingleton = null;

function metaApi(db) {
  return {
    get: db.prepare('SELECT value FROM meta WHERE key = ?'),
    set: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
  };
}

export function getPortfolioStore(options = {}) {
  const db = getDatabase({ dbPath: options.dbPath });
  if (storeSingleton && dbSingleton === db) return storeSingleton;
  dbSingleton = db;
  storeSingleton = createPortfolioStore(db);
  return storeSingleton;
}

/** Reset singleton (tests). */
export function resetPortfolioBridge() {
  storeSingleton = null;
  dbSingleton = null;
  closeDatabase();
}

function readFxMeta(db) {
  const get = db.prepare('SELECT value FROM meta WHERE key = ?');
  const fxSource = get.get('fxSource')?.value || null;
  const fxUpdatedAt = get.get('fxUpdatedAt')?.value || null;
  return {
    fxSource: fxSource || null,
    fxUpdatedAt: fxUpdatedAt || null
  };
}

/** Shared cash: cashUsd / cashCny / usdCnyRate (+ optional FX metadata). */
export function getPortfolioCash(options = {}) {
  const store = getPortfolioStore(options);
  const data = store.read();
  const fx = readFxMeta(dbSingleton);
  return {
    cashUsd: Number(data.cashUsd) || 0,
    cashCny: Number(data.cashCny) || 0,
    usdCnyRate: Number(data.usdCnyRate) > 0 ? Number(data.usdCnyRate) : DEFAULT_USD_CNY_RATE,
    fxSource: fx.fxSource,
    fxUpdatedAt: fx.fxUpdatedAt
  };
}

export function setPortfolioCash(patch = {}, options = {}) {
  const store = getPortfolioStore(options);
  const data = store.read();
  if (patch.cashUsd != null) data.cashUsd = roundMoney(Number(patch.cashUsd) || 0);
  if (patch.cashCny != null) data.cashCny = roundMoney(Number(patch.cashCny) || 0);
  if (patch.usdCnyRate != null && Number(patch.usdCnyRate) > 0) {
    data.usdCnyRate = Number(patch.usdCnyRate);
  }
  store.write(data);

  const meta = metaApi(dbSingleton);
  if (patch.fxSource !== undefined) {
    meta.set.run('fxSource', patch.fxSource == null ? '' : String(patch.fxSource));
  }
  if (patch.fxUpdatedAt !== undefined) {
    meta.set.run('fxUpdatedAt', patch.fxUpdatedAt == null ? '' : String(patch.fxUpdatedAt));
  }
  return getPortfolioCash(options);
}

/**
 * One-time migrate: for each pocket, if portfolio is 0 and dip > 0, copy dip.
 * Holdings page wins when portfolio already has balances.
 */
export function migrateDipCashOnce(dipCash = {}, options = {}) {
  const store = getPortfolioStore(options);
  const meta = metaApi(dbSingleton);
  const flag = meta.get.get('dip_cash_migrated');
  if (flag?.value === '1') {
    return { migrated: false, cash: getPortfolioCash(options) };
  }

  const data = store.read();
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
    store.write(data);
    if (dipCash.fxSource != null) meta.set.run('fxSource', String(dipCash.fxSource));
    if (dipCash.fxUpdatedAt != null) meta.set.run('fxUpdatedAt', String(dipCash.fxUpdatedAt));
  }
  meta.set.run('dip_cash_migrated', '1');
  return { migrated: changed, cash: getPortfolioCash(options) };
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
        name: leg.note || `${leg.symbol || 'QQQ'} Call`,
        currency: 'USD',
        shares,
        price,
        commission: Number(leg.commission) || 0,
        trade_date: ts,
        source: 'qqq-dip',
        tier,
        note
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
      name: leg.note || symbol,
      currency,
      shares,
      price,
      commission: Number(leg.commission) || 0,
      trade_date: ts,
      source: 'qqq-dip',
      tier,
      note
    });
  }
  return out;
}

/**
 * Append trades WITHOUT applying per-trade cash deltas, then deduct form cash once.
 * Form amounts are the cash truth (plan default).
 */
export function appendTradesDeductFormCash({
  trades = [],
  deductCashUsd = 0,
  deductCashCny = 0,
  options = {}
} = {}) {
  const store = getPortfolioStore(options);
  const data = store.read();
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
  store.write(data);

  return {
    trades: created,
    cash: getPortfolioCash(options)
  };
}

/**
 * Manual sell/buy: apply cash via each trade's native delta.
 */
export function appendTradesApplyCash(tradeInputs = [], options = {}) {
  const store = getPortfolioStore(options);
  const data = store.read();
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
  store.write(data);
  return { trades: created, cash: getPortfolioCash(options) };
}
