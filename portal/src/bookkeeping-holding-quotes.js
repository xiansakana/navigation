import fs from 'node:fs';
import { createQuoteService } from '../../stock-manage/src/quotes.js';

let service;
function getHoldingQuote(symbol) {
  if (!service) {
    let config = {};
    try {
      config = JSON.parse(fs.readFileSync(new URL('../../stock-manage/config.json', import.meta.url), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    service = createQuoteService({
      finnhubApiKey: config.finnhubApiKey || process.env.FINNHUB_API_KEY,
      polygonApiKey: config.polygonApiKey || process.env.POLYGON_API_KEY,
    });
  }
  return service.getQuote(symbol);
}

const quoteTime = quote => Date.parse(quote?.asOf || quote?.updatedAt || quote?.timestamp || quote?.date || '');

export async function refreshHoldingQuotes(db, userId, accounts, timeoutMs, getQuote = getHoldingQuote) {
  const symbols = [...new Set(accounts.filter(a => a.included).flatMap(a => a.investment?.positions?.map(p => p.symbol) || []))];
  if (!symbols.length || timeoutMs <= 0) return;
  const updated = new Map();
  let cursor = 0, expired = false, timer;
  async function fetchQuotes() {
    while (!expired && cursor < symbols.length) {
      const symbol = symbols[cursor++];
      try {
        const quote = await getQuote(symbol);
        if (!expired && Number.isFinite(quote?.price) && quote.price >= 0) updated.set(symbol, quote);
      } catch {
        // A provider failure leaves this position's last saved quote available.
      }
    }
  }
  try {
    const deadline = new Promise(resolve => { timer = setTimeout(() => { expired = true; resolve(); }, timeoutMs); });
    await Promise.race([Promise.all(Array.from({ length: Math.min(4, symbols.length) }, fetchQuotes)), deadline]);
  } finally {
    clearTimeout(timer);
  }
  if (!updated.size) return;
  db.transaction(() => {
    const row = db.prepare('SELECT data FROM portfolio_users WHERE user_id=?').get(userId);
    const portfolio = JSON.parse(row?.data || '{}');
    portfolio.quotes ||= {};
    for (const [symbol, quote] of updated) {
      const savedTime = quoteTime(portfolio.quotes[symbol]);
      const fetchedTime = quoteTime(quote);
      if (Number.isFinite(savedTime) && (!Number.isFinite(fetchedTime) || savedTime > fetchedTime)) continue;
      portfolio.quotes[symbol] = quote;
    }
    db.prepare(`INSERT INTO portfolio_users(user_id,data,updated_at) VALUES(?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`)
      .run(userId, JSON.stringify(portfolio), new Date().toISOString());
  }).immediate();
}
