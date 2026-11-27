import fs from 'node:fs';
import { fetchQuoteResource } from '../../shared/quote-network.js';
import { inferCurrency, isAShareSymbol, ashareExchange, hkCode, normalizeSymbol } from '../../stock-manage/src/markets.js';
import { fundCode, fundIdentifier, hongKongFundIsin } from '../../shared/fund-holdings.js';
import { getFundNavHistory } from '../../stock-manage/src/fund-nav.js';
import { getHkFundNavHistory } from '../../stock-manage/src/hk-fund-nav.js';
import { optionSymbol, tradeDay, tradeStamp } from './bookkeeping-trade-returns.js';
import { verifiedCorporateActions } from './bookkeeping-corporate-actions.js';
import { parseHistoricalFx } from './bookkeeping-historical-fx.js';
import { parseSecurityHistory, parseSinaHistory } from './bookkeeping-security-history.js';
import { isOvernightSnapshot, snapshotDay } from './bookkeeping-snapshot-replay.js';
import { investmentCashDelta, investmentRecordTime, tradeAfterCashBaseline, tradeCashBaseline } from '../../shared/investment-accounts.js';
import { assetTrends } from './bookkeeping-analysis.js';
import { SOCIAL_ACCOUNT_GROUP } from './bookkeeping-scope.js';
import { investmentReturns } from './bookkeeping-investment-returns.js';
import { effectiveBookkeepingFx } from './bookkeeping-fx.js';
import { reconstructTradeReturns } from './bookkeeping-trade-returns.js';
import { tradesWithReinvestmentIncome } from '../../shared/fund-reinvestment.js';

const usable = price => typeof price === 'number' && Number.isFinite(price) && price >= 0;
function cachedClose(point, symbol, date, actions) {
  if (!point || !usable(point.close) || point.date > date) return undefined;
  if (actions?.some(a => a.symbol === symbol && a.date <= date && (a.date > point.date || a.uncertain && a.date === point.date))) return undefined;
  if (point.date === date) {
    const sources = optionSymbol(symbol) ? ['polygon', 'yahoo'] : ['sina', 'yahoo', 'gaoteng-fund-nav', 'chinaamc-hk-fund-nav', 'eastmoney-fund-nav'];
    return sources.includes(point.source) ? point.close : undefined;
  }
  const weekend = new Date(date + 'T00:00:00Z').getUTCDay();
  const precedingFriday = Date.parse(date) - (weekend === 0 ? 2 : 1) * 86400000;
  if (isAShareSymbol(symbol) && (weekend === 0 || weekend === 6) &&
    Date.parse(point.date) === precedingFriday && ['sina', 'yahoo'].includes(point.source)) return point.close;
  return undefined;
}

const shift = (date, n) => new Date(Date.parse(date + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const series = { USD: ['DEXCHUS', false], HKD: ['DEXHKUS', false], JPY: ['DEXJPUS', false], MYR: ['DEXMAUS', false], EUR: ['DEXUSEU', true], GBP: ['DEXUSUK', true], SGD: ['DEXSIUS', false] };
const valid = n => Number.isFinite(n) && n > 0 && n < 1e6;

function polygonKey() {
  if (process.env.POLYGON_API_KEY) return process.env.POLYGON_API_KEY;
  try { return JSON.parse(fs.readFileSync(new URL('../../stock-manage/config.json', import.meta.url), 'utf8')).polygonApiKey || ''; } catch { return ''; }
}

export function createPostgresHistoricalFx(db, { request = fetchQuoteResource, clock = Date.now } = {}) {
  let pending = null, lastAttempt = 0, cache = null;
  async function loadCache() {
    if (cache) return cache;
    const rows = (await db.query('SELECT currency,date,rate,source FROM navigation.bookkeeping_fx_history')).rows;
    const byCurrency = new Map();
    for (const row of rows) {
      if (!byCurrency.has(row.currency)) byCurrency.set(row.currency, []);
      byCurrency.get(row.currency).push({ ...row, rate: Number(row.rate) });
    }
    for (const list of byCurrency.values()) list.sort((a, b) => a.date.localeCompare(b.date));
    cache = byCurrency;
    return cache;
  }
  function quote(currency, date) {
    if (currency === 'CNY') return { rate: 1, date, source: 'fixed' };
    const before = new Date(date + 'T12:00:00Z');
    if (!Number.isFinite(before.getTime())) return null;
    before.setUTCDate(before.getUTCDate() - 14);
    const from = before.toISOString().slice(0, 10);
    const list = cache?.get(currency) || [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].date <= date && list[i].date >= from) return list[i];
    }
    return null;
  }
  async function ensure(entries) {
    const needed = entries.filter(e => e.currency !== 'CNY');
    if (!needed.length) return;
    await loadCache();
    const meta = (await db.query("SELECT updated_at FROM navigation.bookkeeping_fx_history_meta WHERE key='h10'")).rows[0];
    if (needed.every(e => quote(e.currency, e.date.slice(0, 10)))
      && meta && clock() - Number(meta.updated_at) < 21600000) return;
    if (pending) return pending;
    if (clock() - lastAttempt < 60000) return;
    lastAttempt = clock();
    pending = (async () => {
      try {
        const csv = await request('https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + [...new Set(Object.values(series).map(v => v[0]))].join(','),
          { json: false, timeoutMs: 20000, retries: 0 });
        const rows = parseHistoricalFx(csv);
        if (!rows.length) throw new Error('没有历史汇率数据');
        await db.transaction(async client => {
          for (const r of rows) {
            await client.query(`INSERT INTO navigation.bookkeeping_fx_history(currency,date,rate,source) VALUES($1,$2,$3,$4)
              ON CONFLICT(currency,date) DO UPDATE SET rate=excluded.rate,source=excluded.source`, [r.currency, r.date, r.rate, r.source]);
          }
          await client.query(`INSERT INTO navigation.bookkeeping_fx_history_meta(key,updated_at) VALUES('h10',$1)
            ON CONFLICT(key) DO UPDATE SET updated_at=excluded.updated_at`, [clock()]);
        });
        cache = null;
        await loadCache();
      } catch { /* Missing history remains explicit. */ }
    })();
    try { await pending; } finally { pending = null; }
  }
  function enrich(e) {
    const q = quote(e.currency, e.date.slice(0, 10));
    return { ...e, cnyAmount: q ? Math.round(e.amount * q.rate * 100) / 100 : null,
      cnyFee: q ? Math.round((e.fee || 0) * q.rate * 100) / 100 : null,
      historicalRate: q?.rate || null, rateDate: q?.date || null, rateSource: q?.source || null, fxMissing: !q };
  }
  return { ensure, quote, enrich };
}

export function createPostgresSecurityHistory(db, { request = fetchQuoteResource, key = polygonKey(), clock = Date.now } = {}) {
  const queue = [], pending = new Map(), followups = new Map();
  let active = 0, yahooBlockedUntil = 0, polygonBlockedUntil = 0;
  async function load(symbol, start, end) {
    const mainlandFund = fundCode(symbol), hongKongFund = hongKongFundIsin(symbol), hongKongStock = hkCode(symbol);
    if (mainlandFund || hongKongFund) {
      const fetcher = (url, options) => request(url, { ...options, logger: null });
      const data = mainlandFund ? await getFundNavHistory(mainlandFund, start, end, fetcher) : await getHkFundNavHistory(hongKongFund, fetcher);
      const prices = data.filter(p => p.date >= start && p.date <= end);
      if (!prices.length) throw new Error('没有历史单位净值');
      return { prices, splits: [] };
    }
    const option = optionSymbol(symbol);
    if (option && key && clock() >= polygonBlockedUntil) {
      const ticker = 'O:' + option[1] + option[2] + option[3] + String(Math.round(Number(option[4]) * 1000)).padStart(8, '0');
      try {
        const data = await request('https://api.polygon.io/v2/aggs/ticker/' + encodeURIComponent(ticker) + '/range/1/day/' + start + '/' + end
          + '?adjusted=false&sort=asc&limit=50000&apiKey=' + encodeURIComponent(key), { timeoutMs: 6000, retries: 0, logger: null });
        const prices = (data.results || []).map(p => ({ date: shift(new Date(p.t).toISOString().slice(0, 10), 1), close: Number(p.c), source: 'polygon' }))
          .filter(p => Number.isFinite(p.close) && p.close >= 0);
        if (prices.length) return { prices, splits: [] };
      } catch (error) { if (/HTTP 429/.test(error.message)) polygonBlockedUntil = clock() + 3600000; }
    }
    if (option && '20' + option[2].slice(0, 2) + '-' + option[2].slice(2, 4) + '-' + option[2].slice(4, 6) < new Date(clock()).toISOString().slice(0, 10)) {
      throw new Error('缺少过期期权行情');
    }
    const yahoo = option ? option[1] + option[2] + option[3] + String(Math.round(Number(option[4]) * 1000)).padStart(8, '0')
      : isAShareSymbol(symbol) ? symbol + (ashareExchange(symbol) === 'sh' ? '.SS' : '.SZ')
        : hongKongStock ? String(Number(hongKongStock)).padStart(4, '0') + '.HK' : symbol.replace('/', '-');
    try {
      if (clock() < yahooBlockedUntil) throw new Error('Yahoo 暂停请求');
      const data = await request('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(yahoo)
        + '?period1=' + Math.floor(Date.parse(start + 'T00:00:00Z') / 1000)
        + '&period2=' + Math.floor(Date.parse(shift(end, 1) + 'T00:00:00Z') / 1000) + '&interval=1d&events=splits',
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeoutMs: 6000, retries: 0, logger: null });
      return parseSecurityHistory(symbol, data);
    } catch (error) {
      if (/HTTP 429/.test(error.message)) yahooBlockedUntil = clock() + 3600000;
      if (option || hongKongStock) throw error;
      const url = isAShareSymbol(symbol)
        ? 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=' + ashareExchange(symbol) + symbol + '&scale=240&ma=no&datalen=1970'
        : 'https://stock.finance.sina.com.cn/usstock/api/json.php/US_MinKService.getDailyK?symbol=' + encodeURIComponent(symbol.replace('/', '.')) + '&___qn=3';
      return parseSinaHistory(symbol, await request(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.sina.com.cn/' }, timeoutMs: 6000, retries: 0, logger: null }), start, end);
    }
  }
  function drain() {
    while (active < 2 && queue.length) {
      const job = queue.shift(); active++;
      void load(job.symbol, job.start, job.end).then(async result => {
        await db.transaction(async client => {
          for (const p of result.prices) {
            await client.query(`INSERT INTO navigation.bookkeeping_security_prices(user_id,symbol,date,close,source)
              VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,symbol,date) DO UPDATE SET close=excluded.close,source=excluded.source
              WHERE navigation.bookkeeping_security_prices.source NOT LIKE 'verified-backfill:%'`,
            [job.userId, job.symbol, p.date, p.close, p.source]);
          }
          await client.query(`INSERT INTO navigation.bookkeeping_security_history_meta(user_id,symbol,start,"end",attempted_at,status,splits)
            VALUES($1,$2,$3,$4,$5,'ready',$6) ON CONFLICT(user_id,symbol) DO UPDATE SET start=excluded.start,"end"=excluded."end",
            attempted_at=excluded.attempted_at,status=excluded.status,splits=excluded.splits`,
          [job.userId, job.symbol, job.start, job.end, clock(), JSON.stringify(result.splits)]);
        });
      }).catch(async () => {
        await db.query(`INSERT INTO navigation.bookkeeping_security_history_meta(user_id,symbol,start,"end",attempted_at,status,splits)
          VALUES($1,$2,$3,$4,$5,'unavailable','[]') ON CONFLICT(user_id,symbol) DO UPDATE SET attempted_at=excluded.attempted_at,status=excluded.status`,
        [job.userId, job.symbol, job.start, job.end, clock()]).catch(() => {});
      }).finally(() => {
        active--;
        pending.delete(job.id);
        const next = followups.get(job.id);
        followups.delete(job.id);
        if (next) void ensure(job.userId, [next]);
        else drain();
      });
    }
  }
  async function ensure(userId, requests) {
    for (const r of requests) {
      const id = JSON.stringify([userId, r.symbol]), running = pending.get(id);
      if (running) {
        const expected = followups.get(id) || running;
        if (r.start < expected.start || r.end > expected.end) {
          followups.set(id, { symbol: r.symbol, start: r.start < expected.start ? r.start : expected.start, end: r.end > expected.end ? r.end : expected.end });
        }
        continue;
      }
      const meta = (await db.query('SELECT * FROM navigation.bookkeeping_security_history_meta WHERE user_id=$1 AND symbol=$2', [userId, r.symbol])).rows[0];
      const covered = meta?.status === 'ready' && meta.start <= r.start && meta.end >= r.end;
      const retryDelay = hongKongFundIsin(r.symbol) ? 5 * 60000 : 6 * 3600000;
      if (covered || (meta && meta.status !== 'ready' && clock() - Number(meta.attempted_at) < retryDelay)) continue;
      const range = meta?.status === 'ready'
        ? { start: meta.start < r.start ? meta.start : r.start, end: meta.end > r.end ? meta.end : r.end } : r;
      const job = { ...r, ...range, userId, id };
      pending.set(id, job); queue.push(job);
    }
    drain();
    return requests.filter(r => pending.has(JSON.stringify([userId, r.symbol]))).length;
  }
  async function read(userId) {
    const bySymbol = new Map();
    for (const p of (await db.query('SELECT symbol,date,close,source FROM navigation.bookkeeping_security_prices WHERE user_id=$1 ORDER BY symbol,date', [userId])).rows) {
      if (!bySymbol.has(p.symbol)) bySymbol.set(p.symbol, []);
      bySymbol.get(p.symbol).push({ ...p, close: Number(p.close) });
    }
    const meta = (await db.query('SELECT * FROM navigation.bookkeeping_security_history_meta WHERE user_id=$1', [userId])).rows;
    const actions = new Map();
    for (const s of [...meta.flatMap(m => JSON.parse(m.splits)), ...verifiedCorporateActions]) actions.set(s.symbol + '|' + s.date, s);
    return {
      quote(symbol, date) {
        const values = bySymbol.get(symbol) || [];
        let low = 0, high = values.length;
        while (low < high) { const mid = (low + high) >> 1; if (values[mid].date <= date) low = mid + 1; else high = mid; }
        return values[low - 1] || null;
      },
      splits: [...actions.values()],
      pending: [...pending.values()].filter(job => job.userId === userId).length,
      unavailable: meta.filter(m => m.status === 'unavailable').map(m => m.symbol)
    };
  }
  return { ensure, read };
}

const securityInstances = new WeakMap();
export function postgresSecurityHistory(db) {
  if (!securityInstances.has(db)) securityInstances.set(db, createPostgresSecurityHistory(db));
  return securityInstances.get(db);
}

export async function queueSavedTradeHistoryPg(db, userId, trades, today) {
  const first = (await db.query('SELECT MIN(date) AS date FROM navigation.bookkeeping_asset_snapshots WHERE user_id=$1', [userId])).rows[0]?.date;
  if (!first) return;
  const end = shift(today, -1), starts = new Map();
  for (const trade of trades) {
    if (!['buy', 'sell'].includes(trade.type)) continue;
    const day = tradeDay(trade), symbol = normalizeSymbol(trade.symbol);
    if (!symbol || !day || day > end) continue;
    const start = day < first ? first : day;
    if (!starts.has(symbol) || start < starts.get(symbol)) starts.set(symbol, start);
  }
  if (starts.size) await postgresSecurityHistory(db).ensure(userId, [...starts].map(([symbol, start]) => ({ symbol, start: shift(start, -7), end })));
}

export async function createPostgresSnapshotReplay(db, userId, history) {
  const data = JSON.parse((await db.query('SELECT data FROM navigation.portfolio_users WHERE user_id=$1', [userId])).rows[0]?.data || '{}');
  const trades = Array.isArray(data.trades) ? data.trades : [];
  const byAccount = new Map();
  for (const trade of trades) {
    if (!byAccount.has(trade.account_id)) byAccount.set(trade.account_id, []);
    byAccount.get(trade.account_id).push(trade);
  }
  const accounts = (await db.query('SELECT * FROM navigation.investment_accounts WHERE user_id=$1', [userId])).rows;
  const byLedgerId = new Map(accounts.map(account => [account.bookkeeping_id, account]));
  const audits = (await db.query(`SELECT account_id,data FROM navigation.investment_account_audit
    WHERE user_id=$1 AND action='cash-baseline' ORDER BY at DESC,id DESC`, [userId])).rows;
  const pastBaselines = new Map();
  for (const audit of audits) {
    const prior = JSON.parse(audit.data).before;
    if (!prior?.bookkeeping_id || !prior.baseline_trade_ids || !Number.isFinite(investmentRecordTime(prior.baseline_at))) continue;
    if (!pastBaselines.has(audit.account_id)) pastBaselines.set(audit.account_id, []);
    pastBaselines.get(audit.account_id).push(prior);
  }
  const storedPrices = new Map();
  for (const row of (await db.query(`SELECT symbol,date,close FROM navigation.bookkeeping_security_prices
    WHERE user_id=$1 AND source LIKE 'verified-backfill:%'`, [userId])).rows) {
    storedPrices.set(row.symbol + '|' + row.date, { ...row, close: Number(row.close) });
  }
  return (row, details = JSON.parse(row.details)) => {
    const cutoff = Date.parse(row.captured_at);
    return details.map(account => {
      if (account.source !== 'portfolio') return account;
      const binding = account.investmentId ? accounts.find(a => a.id === account.investmentId) : byLedgerId.get(account.id);
      if (!binding) return account;
      const owned = byAccount.get(binding.id) || [];
      const late = owned.filter(t => !t.historicalBackfill && Date.parse(t.created_at) > cutoff
        && (tradeStamp(t) <= cutoff || investmentRecordTime(t.cash_effective_at || t.trade_date) <= cutoff));
      if (!late.length) return account;
      const cashBasis = account.cashBaseline || [binding, ...(pastBaselines.get(binding.id) || [])]
        .filter(b => b.bookkeeping_id === account.id && investmentRecordTime(b.baseline_at) <= cutoff)
        .sort((a, b) => investmentRecordTime(b.baseline_at) - investmentRecordTime(a.baseline_at))[0];
      const baseline = cashBasis ? tradeCashBaseline(cashBasis) : null;
      const quotes = new Map((account.quotes || []).map(q => [q.symbol, q]));
      const quantities = new Map();
      let delta = 0, pending = !baseline, changed = false;
      for (const trade of late) {
        const stamp = tradeStamp(trade);
        const cashApplied = baseline && tradeAfterCashBaseline(trade, baseline)
          && investmentRecordTime(trade.cash_effective_at || trade.trade_date) <= cutoff;
        const positionApplied = stamp <= cutoff && ['buy', 'sell'].includes(trade.type)
          && (!baseline || stamp >= baseline.at && !baseline.ids.has(trade.id));
        if (!cashApplied && !positionApplied) continue;
        changed = true;
        if (inferCurrency(trade.symbol, trade.currency) !== account.currency) { pending = true; continue; }
        if (cashApplied) delta += investmentCashDelta(trade);
        if (!positionApplied) continue;
        if (history?.splits?.some(action => action.symbol === trade.symbol && action.date > tradeDay(trade) && action.date <= row.date)) pending = true;
        const direction = trade.type === 'buy' ? 1 : -1;
        quantities.set(trade.symbol, (quantities.get(trade.symbol) || 0) + direction * Number(trade.shares));
      }
      if (!changed && !pending) return account;
      for (const [symbol, shares] of quantities) {
        if (!Number.isFinite(shares)) { pending = true; continue; }
        if (Math.abs(shares) < 1e-8) continue;
        let quote = quotes.get(symbol);
        if (!usable(quote?.price)) {
          const exact = storedPrices.get(symbol + '|' + row.date);
          const cached = history?.quote?.(symbol, row.date);
          const close = exact?.close ?? cachedClose(cached, symbol, row.date, history?.splits);
          const recent = owned.filter(t => t.symbol === symbol && ['buy', 'sell'].includes(t.type)
            && usable(Number(t.price)) && Number(t.price) > 0 && tradeStamp(t) <= cutoff && tradeStamp(t) >= cutoff - 300000)
            .sort((a, b) => tradeStamp(b) - tradeStamp(a))[0];
          if (usable(close)) quote = { symbol, price: close, asOf: exact ? row.date : cached.date, backfilled: true };
          else if (recent) quote = { symbol, price: Number(recent.price), asOf: new Date(tradeStamp(recent)).toISOString(), backfilled: true };
          else history?.request?.(symbol, row.date);
          if (quote) quotes.set(symbol, quote);
        }
        if (usable(quote?.price)) delta += shares * quote.price * (optionSymbol(symbol) ? 100 : 1);
        else pending = true;
      }
      return { ...account, balance: pending ? null : Math.round((account.balance + delta) * 100) / 100,
        quotes: [...quotes.values()], revised: !pending, revisionPending: pending };
    });
  };
}

export async function createPostgresTradeValuation(db, userId, includedIds, today, currentQuotes = {}, currentRates = {}, history) {
  const replay = await createPostgresSnapshotReplay(db, userId, history);
  const snapshots = (await db.query(`SELECT date,captured_at,details FROM navigation.bookkeeping_asset_snapshots
    WHERE user_id=$1 AND date<=$2 ORDER BY date`, [userId, today])).rows;
  const frames = snapshots.map(row => {
    const accounts = replay(row).filter(a => includedIds.has(a.id));
    const prices = new Map(), rates = new Map([['CNY', 1]]);
    for (const a of accounts) {
      if (a.rate > 0) rates.set(a.currency, a.rate);
      for (const q of a.quotes || []) if (q.price != null && Number.isFinite(Number(q.price)) && Number(q.price) >= 0) prices.set(q.symbol, q);
    }
    return { date: row.date, capturedAt: row.captured_at, prices, rates, overnight: isOvernightSnapshot(row), portfolio: accounts.some(a => a.source === 'portfolio') };
  }).filter(frame => frame.portfolio);
  const first = frames[0] || null;
  const overnightStart = frames.find(frame => frame.overnight)?.date;
  const byDay = new Map(frames.map(frame => [frame.date, frame]));
  const backfillRows = (await db.query(`SELECT symbol,date,close FROM navigation.bookkeeping_security_prices
    WHERE user_id=$1 AND source LIKE 'verified-backfill:%'`, [userId])).rows;
  const backfill = new Map(backfillRows.map(row => [row.symbol + '|' + row.date, { date: row.date, close: Number(row.close) }]));
  const at = date => { let low = 0, high = frames.length; while (low < high) { const mid = (low + high) >> 1; if (frames[mid].date <= date) low = mid + 1; else high = mid; } return frames[low - 1] || null; };
  const snapshotQuote = (frame, symbol) => {
    const quote = frame?.prices.get(symbol);
    const navDate = fundIdentifier(symbol) && /^\d{4}-\d{2}-\d{2}$/.test(quote?.asOf || '') ? quote.asOf : null;
    return quote && (!navDate || navDate <= frame.date)
      ? { date: navDate || frame.date, close: Number(quote.price), source: quote.backfilled ? 'backfill' : 'valuation' } : null;
  };
  function historicalQuote(symbol, date, saved) {
    const verified = backfill.get(symbol + '|' + date);
    if (verified && saved?.date !== date) return { ...verified, source: 'backfill' };
    const cached = history?.quote?.(symbol, date);
    if (optionSymbol(symbol)) {
      if (saved?.date === date) return saved;
      return cached?.date === date && ['polygon', 'yahoo'].includes(cached.source) ? { date, close: cached.close, source: 'backfill' } : saved;
    }
    const split = history?.splits?.filter(s => s.symbol === symbol && s.date <= date).at(-1);
    if (cached && cached.date <= date && (!split || cached.date > split.date) && (!saved || cached.date > saved.date)) {
      return { date: cached.date, close: cached.close, source: 'backfill' };
    }
    return saved;
  }
  return {
    first,
    day(trade) {
      const day = tradeDay(trade);
      if (!day || !overnightStart) return day;
      const previous = new Date(Date.parse(day + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
      if (previous < overnightStart) return day;
      const frame = byDay.get(previous);
      if (frame && !frame.overnight) return day;
      const cutoff = Date.parse(frame?.capturedAt || day + 'T04:30:00+08:00');
      return tradeStamp(trade) <= cutoff ? previous : day;
    },
    baselineQuote: symbol => first ? historicalQuote(symbol, first.date, snapshotQuote(first, symbol)) : null,
    baselineFx: currency => first?.rates.has(currency) ? { rate: first.rates.get(currency) } : null,
    quote(symbol, date) {
      if (!first || date < first.date) return null;
      const q = currentQuotes[symbol], price = q?.price, asOf = q ? Date.parse(q.asOf || q.updatedAt || q.date || '') : NaN;
      if (date === today && price != null && Number.isFinite(Number(price)) && Number(price) >= 0 && (!Number.isFinite(asOf) || asOf <= Date.now())) {
        return { date, close: Number(price), source: 'current' };
      }
      return historicalQuote(symbol, date, snapshotQuote(at(date), symbol));
    },
    fx(currency, date) {
      if (!first || date < first.date) return null;
      if (date === today && currentRates[currency] > 0) return { rate: currentRates[currency] };
      const frame = at(date);
      return frame?.rates.has(currency) ? { rate: frame.rates.get(currency) } : null;
    }
  };
}

const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
export const assetDate = time => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
const previousDate = date => new Date(Date.parse(date + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
const captureTime = now => Date.parse(assetDate(now) + 'T04:30:00+08:00');
export const nextAssetCapture = now => captureTime(now) + (now >= captureTime(now) ? 86400000 : 0);

export function createPostgresAssetHistory(db, { portfolio }) {
  async function capture(userId, accounts, entries, rates, now = Date.now(), { snapshot = true, daily = false } = {}) {
    const linked = accounts.filter(a => a.included && a.balanceSource === 'portfolio');
    if (!linked.length || linked.some(a => !Number.isFinite(a.ledgerBalance))) return false;
    const date = daily ? snapshotDay(now) : assetDate(now);
    return db.transaction(async client => {
      if (daily) {
        if (now < captureTime(now)) return false;
        const saved = (await client.query('SELECT captured_at FROM navigation.bookkeeping_asset_snapshots WHERE user_id=$1 AND date=$2', [userId, date])).rows[0];
        if (saved) return false;
      }
      const latest = (await client.query('SELECT MAX(date) AS date FROM navigation.bookkeeping_asset_snapshots WHERE user_id=$1', [userId])).rows[0];
      if (latest.date && date < latest.date) return false;
      let baseline = (await client.query('SELECT * FROM navigation.bookkeeping_asset_baselines WHERE user_id=$1', [userId])).rows[0];
      if (!baseline) {
        const ledger = accounts.map(a => a.balanceSource === 'portfolio' ? { ...a, balance: a.ledgerBalance, balanceSource: 'ledger' } : a);
        const history = assetTrends(ledger, entries, date, rates, { end: previousDate(date) });
        if (!entries.length && Number.isFinite(history.current)) history.points = [{ date: previousDate(date), currency: 'CNY', balance: history.current }];
        if (!history.points.length || history.missingCurrencies.length) return false;
        history.accountHistories = Object.fromEntries(ledger.filter(a => a.group === SOCIAL_ACCOUNT_GROUP).map(a => {
          const curve = assetTrends(ledger.map(item => ({ ...item, included: item.id === a.id && item.included })),
            entries.filter(e => e.accountId === a.id || e.toAccountId === a.id), date, rates, { end: previousDate(date) });
          return [a.id, curve.points.length ? curve.points : Number.isFinite(curve.current) ? [{ date: previousDate(date), currency: 'CNY', balance: curve.current }] : []];
        }));
        await client.query('INSERT INTO navigation.bookkeeping_asset_baselines(user_id,cutover_date,history) VALUES($1,$2,$3)',
          [userId, date, JSON.stringify(history)]);
        baseline = { cutover_date: date };
      }
      if (date < baseline.cutover_date) return false;
      if (!snapshot) return true;
      const included = accounts.filter(a => a.included);
      if (included.some(a => !Number.isFinite(a.balance) || !(rates[a.currency] > 0))) return false;
      const balance = round(included.reduce((n, a) => n + a.balance * rates[a.currency], 0));
      const bindings = daily ? new Map((await portfolio.investmentRows(userId)).map(a => [a.id, a])) : new Map();
      const details = included.map(a => ({ id: a.id, currency: a.currency, balance: a.balance, rate: rates[a.currency],
        source: a.balanceSource || 'ledger', quotes: a.investment?.positions?.map(p => ({ symbol: p.symbol, asOf: p.quoteAsOf, price: p.price })) || [],
        ...(a.investment && bindings.has(a.investment.id) ? { investmentId: a.investment.id, cashBaseline: {
          baseline_at: bindings.get(a.investment.id).baseline_at, baseline_trade_ids: bindings.get(a.investment.id).baseline_trade_ids
        } } : {}) }));
      await client.query(`INSERT INTO navigation.bookkeeping_asset_snapshots(user_id,date,captured_at,balance,details)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,date) DO UPDATE SET captured_at=excluded.captured_at,
        balance=excluded.balance,details=excluded.details
        WHERE excluded.captured_at >= navigation.bookkeeping_asset_snapshots.captured_at`,
      [userId, date, new Date(now).toISOString(), balance, JSON.stringify(details)]);
      return true;
    });
  }
  async function read(userId, filter = {}, today = assetDate(Date.now()), currentBalance = null, scope = {}) {
    const baseline = (await db.query('SELECT * FROM navigation.bookkeeping_asset_baselines WHERE user_id=$1', [userId])).rows[0];
    if (!baseline) return null;
    const history = JSON.parse(baseline.history);
    const snapshots = (await db.query(`SELECT date,balance,captured_at,details FROM navigation.bookkeeping_asset_snapshots
      WHERE user_id=$1 AND date<=$2 ORDER BY date`, [userId, today])).rows.map(row => ({ ...row, balance: Number(row.balance) }));
    const excluded = new Set(scope.excludedAccountIds || []);
    const atCurve = (curve, date) => {
      let low = 0, high = curve.length;
      while (low < high) { const mid = (low + high) >> 1; if (curve[mid].date <= date) low = mid + 1; else high = mid; }
      return curve[Math.max(0, low - 1)]?.balance ?? 0;
    };
    let legacy = history.points.map(p => ({ ...p, source: 'ledger' })), estimated = false;
    if (excluded.size) {
      const first = snapshots[0], details = first ? JSON.parse(first.details) : [];
      const knownEntries = first
        ? new Set((await db.query('SELECT id FROM navigation.bookkeeping_entries WHERE user_id=$1 AND created_at<=$2', [userId, first.captured_at])).rows.map(e => e.id))
        : null;
      const missingCurrencies = [], missingValuations = [];
      const curves = [...excluded].map(id => {
        if (history.accountHistories && Object.hasOwn(history.accountHistories, id)) return history.accountHistories[id];
        estimated = true;
        const observed = details.find(a => a.id === id), account = scope.accounts?.find(a => a.id === id);
        if (!account || (first && !observed)) return [];
        const anchorDate = first?.date || today;
        const anchorRates = { ...scope.rates, ...Object.fromEntries(details.map(a => [a.currency, a.rate])), CNY: 1 };
        const anchorAccounts = scope.accounts.map(a => ({ ...a, included: a.id === id,
          balance: a.id === id ? (observed?.balance ?? a.ledgerBalance ?? a.balance) : a.balance, balanceSource: 'ledger' }));
        const bills = (scope.entries || []).filter(e => (e.accountId === id || e.toAccountId === id) && e.date.slice(0, 10) <= anchorDate);
        const snapshotBills = knownEntries ? bills.filter(e => knownEntries.has(e.id)) : bills;
        let curve = assetTrends(anchorAccounts, snapshotBills, anchorDate, anchorRates);
        if (observed && account.group === SOCIAL_ACCOUNT_GROUP && account.currency === 'CNY' &&
          snapshotBills.length < bills.length && bills.every(e => e.currency === 'CNY')) {
          const rebuilt = assetTrends(anchorAccounts, bills, anchorDate, anchorRates);
          if (rebuilt.points.length > 1 && rebuilt.points[0].balance === 0 && rebuilt.points.every(p => p.balance >= 0)) curve = rebuilt;
        }
        missingCurrencies.push(...curve.missingCurrencies); missingValuations.push(...(curve.missingValuations || []));
        return curve.points;
      });
      if (missingCurrencies.length || missingValuations.length) {
        return { points: [], missingCurrencies: [...new Set(missingCurrencies)], missingValuations, historyMode: 'hybrid', period: null,
          note: '所选排除账户的历史汇率或余额不完整，暂无法计算筛选后的历史资产。' };
      }
      const dates = [...new Set([...legacy.map(p => p.date),
        ...curves.flat().map(p => p.date).filter(date => date >= legacy[0].date && date <= legacy.at(-1).date)])].sort();
      legacy = dates.map(date => ({ date, currency: 'CNY', source: 'ledger',
        balance: round(atCurve(history.points, date) - curves.reduce((sum, curve) => sum + atCurve(curve, date), 0)),
        ...(estimated ? { scopeEstimated: true } : {}) }));
    }
    const replay = await createPostgresSnapshotReplay(db, userId, scope.securityHistory);
    const observed = snapshots.map(p => {
      const original = JSON.parse(p.details);
      const details = replay(p, original).filter(a => !excluded.has(a.id));
      const revisionPending = details.some(a => a.revisionPending), revised = details.some(a => a.revised);
      const included = revisionPending ? original.filter(a => !excluded.has(a.id)) : details;
      const balance = excluded.size || revised && !revisionPending ? round(included.reduce((sum, a) => sum + a.balance * a.rate, 0)) : p.balance;
      return { date: p.date, currency: 'CNY', balance, source: 'valuation', capturedAt: p.captured_at,
        ...(revisionPending ? { revisionPending } : revised ? { revised } : {}) };
    });
    const points = [...legacy, ...observed];
    if (!points.length) return null;
    const live = Number.isFinite(currentBalance);
    if (live) {
      const index = points.findIndex(p => p.date === today);
      if (index >= 0) points.splice(index);
      points.push({ date: today, currency: 'CNY', balance: round(currentBalance), source: 'current' });
    }
    const start = filter.start || (filter.month ? filter.month + '-01' : history.period?.start || points[0].date);
    const requestedEnd = filter.end || (filter.month ? new Date(Date.UTC(Number(filter.month.slice(0, 4)), Number(filter.month.slice(5, 7)), 0)).toISOString().slice(0, 10) : today);
    const end = requestedEnd < today ? requestedEnd : today;
    const at = date => points.filter(p => p.date <= date).at(-1) || points[0];
    const boundary = date => { const p = at(date); return { ...p, date, asOf: p.date, source: p.date === date ? p.source : 'carried' }; };
    const openingAsOf = previousDate(start), opening = at(openingAsOf), closing = at(end);
    const scoped = start <= end ? [{ ...boundary(openingAsOf), periodBoundary: 'opening' }, boundary(start), ...points.filter(p => p.date > start && p.date < end), ...(end > start ? [boundary(end)] : [])] : [];
    return { points: scoped, missingCurrencies: [], estimatedTransfers: history.estimatedTransfers, unlinkedEntries: history.unlinkedEntries,
      historyMode: 'hybrid', valuationCutover: baseline.cutover_date, latestValuation: snapshots.at(-1)?.captured_at || null,
      ...(estimated ? { scopeEstimatedBefore: baseline.cutover_date } : {}),
      current: points.at(-1).balance, asOf: points.at(-1).date,
      period: start <= end ? { start, end, openingAsOf, opening: opening.balance, closing: closing.balance,
        change: Number.isFinite(opening.balance) && Number.isFinite(closing.balance) ? round(closing.balance - opening.balance) : null,
        openingSource: opening.source, closingSource: closing.source, closingAsOf: closing.date } : null,
      note: `${baseline.cutover_date} 前保留账单与余额调整反推的历史账面资产；从该日起按采集时的账户范围、现金及证券最新可用行情记录 CNY 估值，每天北京时间 04:30 采集一次并归入前一日。补录交易后可补算历史估值，缺少可靠资料时显示原快照并标注待补齐。曲线包含范围首日前一日日末的期初基准，首尾差值与范围内资产变化一致。范围覆盖今天时使用当前账户余额、最新可用证券行情及当前汇率显示“今日暂估”，刷新不会改写历史快照。其他未采集日期沿用上一观测，不代表当日实际收盘净值；切换日可能包含账面与行情估值的口径差额，资产变化不等同投资收益。历史反推数据已冻结，不随最新股价重算。`
        + (excluded.size ? ' 已按选择排除社保公积金等账户；快照段使用各账户当时的余额与汇率。' : '')
        + (estimated ? ` ${baseline.cutover_date} 前原冻结数据未保存账户拆分，排除部分按最早可用账户快照及账单反推，属于估算；原始总曲线保持不变。` : '') };
  }
  async function returns(userId, filter, today, accounts, entries, rates, excludedAccountIds = [], allowPortfolioHistory = true) {
    const excluded = new Set(excludedAccountIds);
    const observations = (await db.query(`SELECT date,captured_at,details FROM navigation.bookkeeping_asset_snapshots
      WHERE user_id=$1 AND date<=$2 ORDER BY date`, [userId, today])).rows.map(p => ({
      date: p.date, capturedAt: p.captured_at, source: 'valuation', accounts: JSON.parse(p.details).filter(a => !excluded.has(a.id))
    }));
    if (!allowPortfolioHistory && observations.some(p => p.accounts.some(a => a.source === 'portfolio'))) return null;
    const included = accounts.filter(a => a.included && !excluded.has(a.id));
    if (included.length && included.every(a => Number.isFinite(a.balance) && rates[a.currency] > 0)) {
      const index = observations.findIndex(p => p.date === today);
      if (index >= 0) observations.splice(index);
      observations.push({ date: today, capturedAt: new Date().toISOString(), source: 'current',
        accounts: included.map(a => ({ id: a.id, currency: a.currency, balance: a.balance, rate: rates[a.currency], source: a.balanceSource || 'ledger' })) });
    }
    const events = (await db.query(`SELECT at,data FROM navigation.investment_account_audit
      WHERE user_id=$1 AND action IN ('cash-baseline','unlink')`, [userId])).rows.filter(e => {
      const data = JSON.parse(e.data), id = data.before?.bookkeeping_id || data.input?.bookkeepingId || data.bookkeepingId;
      return !id || included.some(a => a.id === id);
    });
    return investmentReturns(observations, entries, filter, today, events);
  }
  return { capture, read, returns };
}

export function startPostgresAssetHistory(db, { portfolio, store, fx, history, clock = Date.now, refresh, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let running = false;
  const collect = async () => {
    const startedAt = clock();
    const cutoff = captureTime(startedAt);
    if (running || startedAt < cutoff) return;
    running = true;
    try {
      const users = (await db.query('SELECT DISTINCT user_id FROM navigation.investment_accounts WHERE bookkeeping_id IS NOT NULL')).rows;
      for (const { user_id: userId } of users) {
        if (clock() >= cutoff + 60000) break;
        try {
          const saved = (await db.query('SELECT captured_at FROM navigation.bookkeeping_asset_snapshots WHERE user_id=$1 AND date=$2',
            [userId, snapshotDay(startedAt)])).rows[0];
          if (saved) continue;
          const original = await store.entries(userId);
          const accounts = await store.accounts(userId);
          const destinations = original.filter(e => e.toAccountId).map(e => ({ ...e, currency: accounts.find(a => a.id === e.toAccountId)?.currency || e.currency }));
          await fx.ensure([...original, ...destinations]);
          if (refresh) await refresh(store, userId);
          const entries = (await store.entries(userId)).map(fx.enrich);
          for (const e of entries) {
            if (!e.toAccountId) continue;
            const currency = accounts.find(a => a.id === e.toAccountId)?.currency;
            e.toHistoricalRate = currency ? fx.quote(currency, e.date.slice(0, 10))?.rate : null;
            if (e.toAmount != null && !e.toHistoricalRate) e.toFxMissing = currency;
          }
          const capturedAt = clock();
          if (capturedAt >= cutoff + 60000) continue;
          const settings = await store.settings(userId);
          await history.capture(userId, await store.accounts(userId), entries, effectiveBookkeepingFx(settings).rates, capturedAt, { daily: true });
        } catch (error) { console.error('[asset-history]', error.message); }
      }
    } catch (error) { console.error('[asset-history]', error.message); }
    finally { running = false; }
  };
  let timer, stopped = false;
  const arm = () => {
    if (stopped) return;
    timer = schedule(async () => { await collect(); arm(); }, Math.max(1, nextAssetCapture(clock()) - clock()));
    timer.unref?.();
  };
  void collect();
  arm();
  return { collect, stop: () => { stopped = true; cancel(timer); } };
}

export async function createPostgresTradeHistoryReturns(db, userId, filter, today, accounts, excludedIds = [], { portfolio, history, fx, currentRates = {} } = {}) {
  if (!portfolio) return null;
  const data = await portfolio.read(userId);
  const excluded = new Set(excludedIds), included = new Set(accounts.filter(a => a.included && !excluded.has(a.id)).map(a => a.id));
  const rows = await portfolio.investmentRows(userId);
  const allowed = new Set(rows.filter(a => included.has(a.bookkeeping_id)).map(a => a.id));
  const original = Array.isArray(data.trades) ? data.trades : [];
  const trades = original.filter(t => t.account_id ? allowed.has(t.account_id) : allowed.size > 0);
  if (trades.some(t => !tradeDay(t))) {
    return { points: [], summary: null, issues: ['存在无法识别日期的证券交易，请先核对'], missingSymbols: [], pending: 0,
      unavailable: [], unassigned: trades.filter(t => !t.account_id).length, tradeCount: trades.length,
      note: '无法将全部成交归入正确日期，历史收益暂不计算。' };
  }
  const endRequested = filter.end || (filter.month ? new Date(Date.UTC(Number(filter.month.slice(0, 4)), Number(filter.month.slice(5, 7)), 0)).toISOString().slice(0, 10) : today);
  const end = endRequested < today ? endRequested : today, start = filter.start || (filter.month ? filter.month + '-01' : '');
  const prices = await history.read(userId);
  const valuation = await createPostgresTradeValuation(db, userId, included, today, data.quotes || {}, currentRates, prices);
  const valid = trades.filter(t => valuation.day(t) <= end);
  const entries = tradesWithReinvestmentIncome(valid);
  await fx.ensure(valid.map(t => ({ currency: inferCurrency(t.symbol, t.currency), date: tradeDay(t) })));
  const first = valuation.first;
  const requests = new Map();
  const withBackfill = (lookup) => (symbol, date) => {
    const quote = lookup(symbol, date);
    const option = optionSymbol(symbol);
    if (option) {
      const expiry = '20' + option[2].slice(0, 2) + '-' + option[2].slice(2, 4) + '-' + option[2].slice(4);
      if (Date.parse(date) > Date.parse(expiry) + 86400000 || quote?.date === date) return quote;
    } else if (quote && Date.parse(date) - Date.parse(quote.date) <= 7 * 86400000) return quote;
    const previous = requests.get(symbol);
    if (previous) previous.end = date > previous.end ? date : previous.end;
    else requests.set(symbol, { symbol, start: new Date(Date.parse(date) - 7 * 86400000).toISOString().slice(0, 10), end: date });
    return quote;
  };
  let anchorUnrealized = null;
  if (first && first.date <= end) {
    const before = entries.filter(t => tradeStamp(t) <= Date.parse(first.capturedAt));
    const baselineQuote = withBackfill(valuation.baselineQuote);
    const anchor = reconstructTradeReturns(before, { end: first.date, today: first.date,
      quote: (symbol, date) => date === first.date ? baselineQuote(symbol, date) : null,
      fx: fx.quote, valuationFx: valuation.baselineFx, splits: prices.splits, valuationDay: valuation.day });
    anchorUnrealized = before.length ? anchor.summary?.unrealized ?? null : 0;
  }
  const result = reconstructTradeReturns(entries, { start, end, today,
    quote: withBackfill(valuation.quote), fx: fx.quote, valuationFx: valuation.fx, splits: prices.splits,
    valuationDay: valuation.day, hybrid: { cutover: first?.date || null, anchorUnrealized } });
  const pending = requests.size ? await history.ensure?.(userId, [...requests.values()]) || 0 : 0;
  const unassigned = valid.filter(t => !t.account_id).length;
  return { ...result, mode: 'hybrid', valuationCutover: first?.date || null, pending, unavailable: prices.unavailable || [],
    unassigned, tradeCount: valid.length,
    note: (valid.length ? result.note : '当前范围没有可用证券成交记录。') + (unassigned ? ' 包含 ' + unassigned + ' 笔历史未归属记录，独立匹配，不与已归属账户混用成本。' : '') };
}
