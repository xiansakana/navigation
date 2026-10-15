import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { initSchema } from '../../shared/db/schema.js';
import { createPortfolioStore, createLegacyPortfolioStore, migrateLegacyPortfolio } from '../../shared/db/portfolio-store.js';
import { runWithPortfolioUser, currentPortfolioUserId, requirePortfolioUserId } from '../../shared/portfolio-user.js';

const require = createRequire(import.meta.url);
const Database = require('../../portal/node_modules/better-sqlite3');
const fixture = () => {
  const db = new Database(':memory:'); initSchema(db); return db;
};

test('isolates all portfolio fields and identical trade IDs across users', () => {
  const db = fixture();
  try {
    const a = createPortfolioStore(db, 'user-a'), b = createPortfolioStore(db, 'user-b');
    a.write({ cashUsd: 123, cashCny: 456, trades: [{ id: 'same', symbol: 'AAPL' }], quotes: { AAPL: { price: 100 } }, holdingsMeta: { AAPL: { targetPrice: 200 } } });
    assert.deepEqual(b.read().trades, []);
    assert.deepEqual(b.read().quotes, {});
    assert.deepEqual(b.read().holdingsMeta, {});
    assert.equal(b.read().cashUsd, 0);
    b.write({ userId: 'user-a', cashUsd: 9, trades: [{ id: 'same', symbol: 'GOOG' }] });
    assert.equal(a.read().trades[0].symbol, 'AAPL');
    assert.equal(a.read().cashUsd, 123);
    assert.equal(b.read().trades[0].symbol, 'GOOG');
    b.write({});
    assert.equal(a.read().trades.length, 1);
    assert.throws(() => createPortfolioStore(db));
    assert.throws(() => requirePortfolioUserId('user-a OR 1=1'));
  } finally { db.close(); }
});

test('migration preserves the complete legacy state and has one explicit owner', () => {
  const db = fixture();
  try {
    const legacy = createLegacyPortfolioStore(db);
    legacy.write({ cashUsd: 123.45, cashCny: 67.89, usdCnyRate: 7, trades: [{ id: 't', symbol: 'QQQ' }], quotes: { QQQ: { price: 1.234 } }, holdingsMeta: { QQQ: { score: 4 } } });
    const before = legacy.read();
    assert.equal(createPortfolioStore(db, 'other').read().trades.length, 0);
    assert.equal(migrateLegacyPortfolio(db, 'owner').migrated, true);
    assert.deepEqual(createPortfolioStore(db, 'owner').read(), before);
    assert.deepEqual(legacy.read(), before);
    assert.equal(migrateLegacyPortfolio(db, 'owner').migrated, false);
    assert.throws(() => migrateLegacyPortfolio(db, 'other'));
    assert.throws(() => legacy.write(before));
  } finally { db.close(); }
});

test('migration refuses to replace an existing destination', () => {
  const db = fixture();
  try {
    createPortfolioStore(db, 'owner').write({ cashUsd: 10 });
    assert.throws(() => migrateLegacyPortfolio(db, 'owner'));
    assert.equal(createPortfolioStore(db, 'owner').read().cashUsd, 10);
  } finally { db.close(); }
});

test('concurrent asynchronous requests retain their authenticated user across awaits', async () => {
  const seen = await Promise.all(['a', 'b', 'c'].map((userId) => runWithPortfolioUser(userId, async () => {
    await new Promise((resolve) => setTimeout(resolve, userId === 'a' ? 20 : 1));
    return currentPortfolioUserId();
  })));
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.equal(currentPortfolioUserId(), undefined);
});
