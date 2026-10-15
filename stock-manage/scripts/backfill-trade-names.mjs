// Run from stock-manage: node scripts/backfill-trade-names.mjs [--apply]
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, createStore } from '../src/storage.js';
import { portfolioCliUserId } from '../../shared/portfolio-user.js';
import { createQuoteService } from '../src/quotes.js';
import { normalizeSymbol } from '../src/markets.js';
import { needsTradeName, backfillTradeName } from '../src/trade-name.js';
import { getDatabase, closeDatabase } from '../../shared/db/index.js';

const apply = process.argv.includes('--apply');
const config = loadConfig();
const db = getDatabase({ dbPath: config.dbPath });
const quotes = createQuoteService(config);
const store = createStore(config, { userId: portfolioCliUserId() });
const records = store.read().trades.map((trade) => ({ id: trade.id, data: JSON.stringify(trade) }));
const candidates = records.map((row) => JSON.parse(row.data)).filter(needsTradeName);
const symbols = [...new Set(candidates.map((trade) => normalizeSymbol(trade.symbol)))];
const names = new Map();
const unresolved = [];
let next = 0;
let completed = 0;
console.log(JSON.stringify({ phase: 'start', apply, trades: candidates.length, symbols: symbols.length }));

await Promise.all(Array.from({ length: Math.min(3, symbols.length) }, async () => {
  while (next < symbols.length) {
    const symbol = symbols[next++];
    let name = '';
    try { name = await quotes.getInstrumentName(symbol); } catch { /* Leave unresolved names unchanged. */ }
    if (name && normalizeSymbol(name) !== symbol) names.set(symbol, name);
    else unresolved.push(symbol);
    completed++;
    if (completed % 10 === 0 || completed === symbols.length) {
      console.log(JSON.stringify({ phase: 'lookup', completed, total: symbols.length, resolved: names.size, unresolved: unresolved.length }));
    }
  }
}));

const changes = [];
const reportDir = path.join(process.cwd(), 'data', 'name-backfills');
fs.mkdirSync(reportDir, { recursive: true, mode: 0o700 });
const reportPath = path.join(reportDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
let updated = 0;
db.transaction(() => {
  const data = store.read();
  // Re-read inside the write transaction so concurrent additions/edits are preserved.
  for (const row of data.trades.map((trade) => ({ id: trade.id, data: JSON.stringify(trade) }))) {
    const trade = JSON.parse(row.data);
    const named = backfillTradeName(trade, names);
    if (named === trade) continue;
    changes.push({ id: row.id, symbol: trade.symbol, previousName: trade.name ?? null, hadName: Object.hasOwn(trade, 'name'), name: named.name });
  }
  // Keep a protected rollback journal before changing any names.
  fs.writeFileSync(reportPath, JSON.stringify({ apply, changes, unresolved }, null, 2), { mode: 0o600, flag: 'wx' });
  if (apply) {
    data.trades = data.trades.map((trade) => {
      const named = backfillTradeName(trade, names);
      if (named !== trade) updated++;
      return named;
    });
    store.write(data);
  }
}).immediate();
const remaining = store.read().trades.filter(needsTradeName).length;
console.log(JSON.stringify({ phase: 'complete', apply, resolvedSymbols: names.size, unresolvedSymbols: unresolved.length, plannedTrades: changes.length, updatedTrades: updated, remainingTrades: remaining, reportPath }));
closeDatabase();
