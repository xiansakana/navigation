import { getDatabase } from '../../shared/db/index.js';
import { backtestYoloDataset } from './yolo-backtest.js';

function safeUserId(userId) {
  const value = String(userId || 'local').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : 'local';
}

export function createYoloStore(config, databaseOverride = null) {
  const db = databaseOverride || getDatabase({ dbPath: config.dbPath });
  const getSettings = db.prepare('SELECT * FROM yolo_settings WHERE user_id = ?');
  const putSettings = db.prepare(`
    INSERT INTO yolo_settings (user_id, enabled, interval_seconds, last_attempt_at, last_capture_at, last_error, updated_at)
    VALUES (@userId, @enabled, @intervalSeconds, @lastAttemptAt, @lastCaptureAt, @lastError, @updatedAt)
    ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled, interval_seconds=excluded.interval_seconds,
      last_attempt_at=excluded.last_attempt_at, last_capture_at=excluded.last_capture_at,
      last_error=excluded.last_error, updated_at=excluded.updated_at
  `);
  const insertCapture = db.prepare(`
    INSERT INTO yolo_captures (user_id, captured_at, market_date, expiration, underlying_price, source, contract_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const findCapture = db.prepare('SELECT id FROM yolo_captures WHERE user_id = ? AND captured_at = ?');
  const insertQuote = db.prepare(`
    INSERT INTO yolo_option_quotes (capture_id, user_id, option_symbol, right_type, strike, expiration,
      bid, ask, bid_size, ask_size, last_price, delta, gamma, theta, vega, iv, volume, open_interest)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function ensure(userId) {
    const id = safeUserId(userId);
    let row = getSettings.get(id);
    if (!row) {
      const now = new Date().toISOString();
      putSettings.run({ userId: id, enabled: 1, intervalSeconds: 60, lastAttemptAt: null, lastCaptureAt: null, lastError: null, updatedAt: now });
      row = getSettings.get(id);
    }
    return row;
  }

  function settings(userId) {
    const row = ensure(userId);
    return {
      enabled: !!row.enabled, intervalSeconds: row.interval_seconds,
      lastAttemptAt: row.last_attempt_at, lastCaptureAt: row.last_capture_at,
      lastError: row.last_error, updatedAt: row.updated_at
    };
  }

  function updateSettings(userId, patch) {
    const id = safeUserId(userId);
    const current = ensure(id);
    const next = {
      userId: id,
      enabled: 'enabled' in patch ? (patch.enabled ? 1 : 0) : current.enabled,
      intervalSeconds: 'intervalSeconds' in patch ? Math.min(900, Math.max(30, Number(patch.intervalSeconds) || 60)) : current.interval_seconds,
      lastAttemptAt: current.last_attempt_at,
      lastCaptureAt: current.last_capture_at,
      lastError: current.last_error,
      updatedAt: new Date().toISOString()
    };
    putSettings.run(next);
    return settings(id);
  }

  function markAttempt(userId, error = null, capturedAt = null) {
    const id = safeUserId(userId);
    const current = ensure(id);
    putSettings.run({
      userId: id, enabled: current.enabled, intervalSeconds: current.interval_seconds,
      lastAttemptAt: new Date().toISOString(), lastCaptureAt: capturedAt || current.last_capture_at,
      lastError: error ? String(error).slice(0, 500) : null, updatedAt: new Date().toISOString()
    });
  }

  const saveCapture = db.transaction((userId, snapshot) => {
    const id = safeUserId(userId);
    const existing = findCapture.get(id, snapshot.capturedAt);
    if (existing) {
      markAttempt(id, null, snapshot.capturedAt);
      return Number(existing.id);
    }
    const info = insertCapture.run(id, snapshot.capturedAt, snapshot.marketDate, snapshot.expiration,
      snapshot.underlyingPrice || null, snapshot.source || '', snapshot.contracts.length);
    for (const quote of snapshot.contracts) {
      insertQuote.run(info.lastInsertRowid, id, quote.optionSymbol, quote.right, quote.strike, quote.expiration,
        quote.bid, quote.ask, quote.bidSize, quote.askSize, quote.last, quote.delta, quote.gamma,
        quote.theta, quote.vega, quote.iv, quote.volume, quote.openInterest);
    }
    markAttempt(id, null, snapshot.capturedAt);
    return Number(info.lastInsertRowid);
  });

  function enabledUsers() {
    return db.prepare('SELECT * FROM yolo_settings WHERE enabled = 1').all().map((row) => ({
      userId: row.user_id, intervalSeconds: row.interval_seconds, lastAttemptAt: row.last_attempt_at
    }));
  }

  function status(userId) {
    const id = safeUserId(userId);
    const cfg = settings(id);
    const stats = db.prepare(`
      SELECT COUNT(*) captures, COUNT(DISTINCT market_date) days, COALESCE(SUM(contract_count), 0) quote_rows,
        MIN(captured_at) first_capture_at, MAX(captured_at) latest_capture_at
      FROM yolo_captures WHERE user_id = ?
    `).get(id);
    const recent = db.prepare(`
      SELECT id, captured_at, market_date, expiration, underlying_price, source, contract_count
      FROM yolo_captures WHERE user_id = ? ORDER BY captured_at DESC LIMIT 12
    `).all(id);
    return { settings: cfg, stats: { captures: stats.captures, days: stats.days, quoteRows: stats.quote_rows,
      firstCaptureAt: stats.first_capture_at, latestCaptureAt: stats.latest_capture_at }, recent };
  }

  function dataset(userId) {
    const id = safeUserId(userId);
    const captures = db.prepare(`SELECT * FROM yolo_captures WHERE user_id = ? ORDER BY captured_at`).all(id);
    const quoteRows = db.prepare(`
      SELECT q.* FROM yolo_option_quotes q JOIN yolo_captures c ON c.id = q.capture_id
      WHERE q.user_id = ? ORDER BY c.captured_at, q.option_symbol
    `).all(id);
    const grouped = new Map();
    captures.forEach((row) => grouped.set(row.id, {
      id: row.id, capturedAt: row.captured_at, marketDate: row.market_date, expiration: row.expiration,
      underlyingPrice: row.underlying_price, quotes: []
    }));
    quoteRows.forEach((row) => grouped.get(row.capture_id)?.quotes.push({
      optionSymbol: row.option_symbol, right: row.right_type, strike: row.strike, expiration: row.expiration,
      bid: row.bid, ask: row.ask, delta: row.delta
    }));
    return [...grouped.values()];
  }

  function backtest(userId, options) { return backtestYoloDataset(dataset(userId), options); }

  return { ensure, settings, updateSettings, markAttempt, saveCapture, enabledUsers, status, dataset, backtest };
}
