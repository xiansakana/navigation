import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, createStore } from '../src/storage.js';
import { getDatabase, resolveDbPath } from '../../shared/db/index.js';
import { normalizeDividendTaxTrade } from '../../shared/dividend-tax.js';

const config = loadConfig();
const store = createStore(config);
const db = getDatabase({ dbPath: resolveDbPath(config.dbPath) });
const find = () => store.read().trades.filter((t) => normalizeDividendTaxTrade(t) !== t);
const changes = find();
if (!process.argv.includes('--apply') || !changes.length) {
  console.log(JSON.stringify({ mode: 'preview', count: changes.length, records: changes.map((t) => ({ id: t.id, date: t.trade_date, currency: t.currency || 'USD', before: t.total_amount, after: -Number(t.total_amount) })) }));
} else {
  const backupDir = path.resolve('data/backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, `before-dividend-tax-${Date.now()}.db`);
  await db.backup(backup);
  let fixed;
  db.transaction(() => {
    const data = store.read();
    const targets = data.trades.filter((t) => normalizeDividendTaxTrade(t) !== t);
    const saved = store.write(data);
    fixed = { count: targets.length, amountByCurrency: {}, cashUsdDelta: Math.round((saved.cashUsd - data.cashUsd) * 100) / 100, cashCnyDelta: Math.round((saved.cashCny - data.cashCny) * 100) / 100 };
    for (const trade of targets) {
      const currency = trade.currency || 'USD';
      fixed.amountByCurrency[currency] = Math.round(((fixed.amountByCurrency[currency] || 0) + Number(trade.total_amount)) * 100) / 100;
    }
  })();
  console.log(JSON.stringify({ mode: 'applied', backup, ...fixed, remainingPositive: find().length }));
}
