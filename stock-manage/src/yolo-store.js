import { getDatabase } from '../../shared/db/index.js';
import { backtestYoloDataset, summarizeYoloTrades } from './yolo-backtest.js';
import { yoloMarketDate } from './yolo-time.js';

function safeUserId(userId) {
  const value = String(userId || 'local').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : 'local';
}

export function createYoloStore(config, databaseOverride = null) {
  const db = databaseOverride || getDatabase({ dbPath: config.dbPath });
  // Preserve the previous date on repaired legacy rows. No quotes are fabricated or deleted.
  const dateRepairKey = 'yolo_market_date_et_v1';
  if (!db.prepare('SELECT value FROM meta WHERE key = ?').get(dateRepairKey)) {
    db.transaction(() => {
      const update = db.prepare('UPDATE yolo_captures SET original_market_date = COALESCE(original_market_date, market_date), market_date = ? WHERE id = ?');
      for (const row of db.prepare("SELECT id, captured_at, market_date FROM yolo_captures WHERE capture_kind = 'intraday'").all()) {
        if (!Number.isFinite(Date.parse(row.captured_at))) continue;
        const date = yoloMarketDate(row.captured_at);
        if (date !== row.market_date) update.run(date, row.id);
      }
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(dateRepairKey, new Date().toISOString());
    })();
  }
  const getSettings = db.prepare('SELECT * FROM yolo_settings WHERE user_id = ?');
  const putSettings = db.prepare(`
    INSERT INTO yolo_settings (user_id, enabled, interval_seconds, last_attempt_at, last_capture_at, last_error, updated_at)
    VALUES (@userId, @enabled, @intervalSeconds, @lastAttemptAt, @lastCaptureAt, @lastError, @updatedAt)
    ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled, interval_seconds=excluded.interval_seconds,
      last_attempt_at=excluded.last_attempt_at, last_capture_at=excluded.last_capture_at,
      last_error=excluded.last_error, updated_at=excluded.updated_at
  `);
  const insertCapture = db.prepare(`
    INSERT INTO yolo_captures (user_id, captured_at, market_date, expiration, underlying_price, source, capture_kind, contract_count,
      requested_at, received_at, timestamp_origin, provider_timestamp_raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const findCapture = db.prepare('SELECT id FROM yolo_captures WHERE user_id = ? AND captured_at = ? AND expiration = ?');
  const getCapture = db.prepare(`
    SELECT id, captured_at, market_date, expiration, underlying_price, source, capture_kind, contract_count
    FROM yolo_captures WHERE id = ? AND user_id = ?
  `);
  const getLatestExpirationCaptures = db.prepare(`
    SELECT c.id, c.captured_at, c.market_date, c.expiration, c.underlying_price, c.source, c.capture_kind, c.contract_count
    FROM yolo_captures c
    JOIN (
      SELECT expiration, MAX(captured_at) AS latest_at FROM yolo_captures
      WHERE user_id = ? GROUP BY expiration
    ) latest ON c.expiration = latest.expiration AND c.captured_at = latest.latest_at
    WHERE c.user_id = ?
    ORDER BY c.expiration
  `);
  const getCaptureQuotes = db.prepare(`
    SELECT option_symbol, right_type, strike, expiration, bid, ask, bid_size, ask_size, last_price,
      last_trade_at, open_price, high_price, low_price, prev_close, delta, gamma, theta, vega, iv,
      volume, open_interest
    FROM yolo_option_quotes WHERE capture_id = ? AND user_id = ? ORDER BY strike, right_type
  `);
  const getOptionHistoryRows = db.prepare(`
    SELECT c.captured_at, c.market_date, c.expiration, q.option_symbol, q.bid, q.ask, q.last_price,
      q.volume, q.open_interest
    FROM yolo_option_quotes q
    JOIN yolo_captures c ON c.id = q.capture_id
    WHERE q.user_id = ? AND q.option_symbol = ?
    ORDER BY c.captured_at
  `);
  const insertQuote = db.prepare(`
    INSERT INTO yolo_option_quotes (capture_id, user_id, option_symbol, right_type, strike, expiration,
      bid, ask, bid_size, ask_size, last_price, last_trade_at, open_price, high_price, low_price, prev_close,
      delta, gamma, theta, vega, iv, volume, open_interest)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    db.transaction(() => {
      putSettings.run(next);
      const attemptId = beginAttempt(id, 'settings');
      finishAttempt(id, attemptId, { status: next.enabled ? 'enabled' : 'paused', durationMs: 0,
        error: `自动采集${next.enabled ? '开启' : '暂停'}；间隔 ${next.intervalSeconds} 秒` });
    })();
    return settings(id);
  }

  function markAttempt(userId, error = null, capturedAt = null) {
    const id = safeUserId(userId);
    const current = ensure(id);
    putSettings.run({
      userId: id, enabled: current.enabled, intervalSeconds: current.interval_seconds,
      lastAttemptAt: new Date().toISOString(), lastCaptureAt: capturedAt && (!current.last_capture_at || capturedAt > current.last_capture_at) ? capturedAt : current.last_capture_at,
      lastError: error ? String(error).slice(0, 500) : null, updatedAt: new Date().toISOString()
    });
  }

  const saveCaptureDetailed = db.transaction((userId, snapshot) => {
    const id = safeUserId(userId);
    const groups = Array.isArray(snapshot.chains) && snapshot.chains.length
      ? snapshot.chains
      : [snapshot];
    let lastId = null;
    let newCaptures = 0;
    let duplicateCaptures = 0;
    let contractCount = 0;
    const marketDate = snapshot.captureKind === 'daily-summary' ? snapshot.marketDate : yoloMarketDate(snapshot.capturedAt);
    for (const chain of groups) {
      const expiration = chain.expiration || chain.contracts?.[0]?.expiration || snapshot.expiration || '';
      const existing = findCapture.get(id, snapshot.capturedAt, expiration);
      if (existing) { lastId = Number(existing.id); duplicateCaptures += 1; continue; }
      const contracts = Array.isArray(chain.contracts) ? chain.contracts : [];
      const info = insertCapture.run(id, snapshot.capturedAt, marketDate, expiration,
        chain.underlyingPrice ?? snapshot.underlyingPrice ?? null, snapshot.source || '', snapshot.captureKind || 'intraday', contracts.length,
        snapshot.requestedAt || null, snapshot.receivedAt || null, snapshot.timestampOrigin || null, snapshot.providerTimestampRaw || null);
      lastId = Number(info.lastInsertRowid);
      newCaptures += 1;
      contractCount += contracts.length;
      for (const quote of contracts) {
        insertQuote.run(info.lastInsertRowid, id, quote.optionSymbol, quote.right, quote.strike, quote.expiration,
          quote.bid, quote.ask, quote.bidSize ?? null, quote.askSize ?? null, quote.last ?? null,
          quote.lastTradeAt ?? null, quote.open ?? null, quote.high ?? null, quote.low ?? null, quote.prevClose ?? null,
          quote.delta ?? null, quote.gamma ?? null, quote.theta ?? null, quote.vega ?? null, quote.iv ?? null,
          quote.volume ?? null, quote.openInterest ?? null);
      }
    }
    markAttempt(id, null, snapshot.capturedAt);
    return { lastId, newCaptures, duplicateCaptures, contractCount };
  });

  function saveCapture(userId, snapshot) { return saveCaptureDetailed(userId, snapshot).lastId; }

  function beginAttempt(userId, triggerKind, requestedAt = new Date().toISOString()) {
    return Number(db.prepare('INSERT INTO yolo_collection_attempts (user_id, requested_at, trigger_kind) VALUES (?, ?, ?)')
      .run(safeUserId(userId), requestedAt, triggerKind).lastInsertRowid);
  }

  function finishAttempt(userId, attemptId, detail) {
    const finishedAt = detail.finishedAt || new Date().toISOString();
    db.prepare(`UPDATE yolo_collection_attempts SET finished_at = @finishedAt, status = @status,
      provider_at = @providerAt, source = @source, duration_ms = @durationMs, lag_ms = @lagMs,
      new_captures = @newCaptures, duplicate_captures = @duplicateCaptures, contract_count = @contractCount, error = @error
      WHERE id = @id AND user_id = @userId AND status = 'running'`).run({
      id: attemptId, userId: safeUserId(userId), finishedAt, status: detail.status,
      providerAt: detail.providerAt || null, source: detail.source || null,
      durationMs: detail.durationMs ?? null, lagMs: detail.lagMs ?? null,
      newCaptures: detail.newCaptures || 0, duplicateCaptures: detail.duplicateCaptures || 0,
      contractCount: detail.contractCount || 0, error: detail.error ? String(detail.error).slice(0, 500) : null
    });
  }

  const commitCaptureAttempt = db.transaction((userId, attemptId, snapshot, detail) => {
    const saved = saveCaptureDetailed(userId, snapshot);
    finishAttempt(userId, attemptId, { ...detail, ...saved, status: saved.newCaptures ? 'success' : 'duplicate' });
    return saved;
  });

  function recoverAttempts() {
    return db.prepare(`UPDATE yolo_collection_attempts SET status = 'interrupted', finished_at = ?,
      error = '服务重启前采集未完成；无法判断当时的具体失败原因'
      WHERE status = 'running'`).run(new Date().toISOString()).changes;
  }

  function collectionHealth(userId) {
    const id = safeUserId(userId);
    const attempts = db.prepare('SELECT * FROM yolo_collection_attempts WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(id);
    const latest = attempts[0] || null;
    return { attempts, latest, auditSince: db.prepare('SELECT MIN(requested_at) first FROM yolo_collection_attempts WHERE user_id = ?').get(id).first,
      repairedDates: db.prepare('SELECT COUNT(*) n FROM yolo_captures WHERE user_id = ? AND original_market_date IS NOT NULL').get(id).n };
  }

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
        COALESCE(SUM(CASE WHEN capture_kind = 'intraday' THEN 1 ELSE 0 END), 0) intraday_captures,
        COALESCE(SUM(CASE WHEN capture_kind = 'daily-summary' THEN 1 ELSE 0 END), 0) summary_captures,
        MIN(captured_at) first_capture_at, MAX(captured_at) latest_capture_at
      FROM yolo_captures WHERE user_id = ?
    `).get(id);
    const recent = db.prepare(`
      SELECT id, captured_at, market_date, expiration, underlying_price, source, capture_kind, contract_count
      FROM yolo_captures WHERE user_id = ? ORDER BY captured_at DESC LIMIT 12
    `).all(id);
    return { settings: cfg, stats: { captures: stats.captures, days: stats.days, quoteRows: stats.quote_rows,
      intradayCaptures: stats.intraday_captures, summaryCaptures: stats.summary_captures,
      firstCaptureAt: stats.first_capture_at, latestCaptureAt: stats.latest_capture_at }, recent, collectionHealth: collectionHealth(id) };
  }

  function dataset(userId) {
    const id = safeUserId(userId);
    const captures = db.prepare(`
      SELECT * FROM yolo_captures WHERE user_id = ? AND capture_kind = 'intraday' ORDER BY captured_at
    `).all(id);
    const quoteRows = db.prepare(`
      SELECT q.* FROM yolo_option_quotes q JOIN yolo_captures c ON c.id = q.capture_id
      WHERE q.user_id = ? AND c.capture_kind = 'intraday' ORDER BY c.captured_at, q.option_symbol
    `).all(id);
    const grouped = new Map();
    captures.forEach((row) => grouped.set(row.id, {
      id: row.id, capturedAt: row.captured_at, marketDate: row.market_date, expiration: row.expiration,
      underlyingPrice: row.underlying_price, source: row.source, captureKind: row.capture_kind, quotes: []
    }));
    quoteRows.forEach((row) => grouped.get(row.capture_id)?.quotes.push({
      optionSymbol: row.option_symbol, right: row.right_type, strike: row.strike, expiration: row.expiration,
      bid: row.bid, ask: row.ask, delta: row.delta
    }));
    return [...grouped.values()];
  }

  function captureDetails(userId, captureId) {
    const id = safeUserId(userId);
    const numericId = Number(captureId);
    if (!Number.isSafeInteger(numericId) || numericId < 1) return null;
    const capture = getCapture.get(numericId, id);
    if (!capture) return null;
    return { capture, quotes: getCaptureQuotes.all(numericId, id) };
  }

  function optionChain(userId) {
    const id = safeUserId(userId);
    const groups = getLatestExpirationCaptures.all(id, id).map((capture) => ({
      capture,
      quotes: getCaptureQuotes.all(capture.id, id)
    }));
    return { groups };
  }

  function optionHistory(userId, optionSymbol, intervalMinutes = 1) {
    const id = safeUserId(userId);
    const symbol = String(optionSymbol || '').trim().toUpperCase();
    const interval = Math.min(1440, Math.max(1, Number(intervalMinutes) || 1));
    if (!symbol) return { optionSymbol: '', intervalMinutes: interval, candles: [] };
    const rows = getOptionHistoryRows.all(id, symbol);
    const buckets = new Map();
    for (const row of rows) {
      const capturedAt = Date.parse(row.captured_at);
      if (!Number.isFinite(capturedAt)) continue;
      const last = Number(row.last_price);
      const bid = Number(row.bid);
      const ask = Number(row.ask);
      const midpoint = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
      const price = last > 0 ? last : midpoint;
      if (!(price > 0)) continue;
      const bucket = Math.floor(capturedAt / (interval * 60000)) * interval * 60000;
      const candle = buckets.get(bucket);
      if (!candle) {
        buckets.set(bucket, { timestamp: bucket, open: price, high: price, low: price, close: price,
          samples: 1, volume: Number(row.volume) || 0 });
      } else {
        candle.high = Math.max(candle.high, price);
        candle.low = Math.min(candle.low, price);
        candle.close = price;
        candle.samples += 1;
        candle.volume = Math.max(candle.volume, Number(row.volume) || 0);
      }
    }
    const candles = [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp);
    return { optionSymbol: symbol, intervalMinutes: interval, candles, samples: rows.length,
      firstCapturedAt: rows[0]?.captured_at || null, lastCapturedAt: rows.at(-1)?.captured_at || null };
  }

  function backtest(userId, options) { return backtestYoloDataset(dataset(userId), options); }

  async function backtestAsync(userId, options, onProgress = () => {}) {
    const id = safeUserId(userId);
    const yieldToRequests = () => new Promise((resolve) => setImmediate(resolve));
    onProgress({ stage: '读取日期和到期日', completedDays: 0, totalDays: 0, quoteRows: 0, diagnostics: [] });
    await yieldToRequests();
    // Freeze capture IDs for this run. New collector writes belong to a later run.
    const rows = db.prepare(`SELECT id, captured_at, market_date, expiration, underlying_price
      FROM yolo_captures WHERE user_id = ? AND capture_kind = 'intraday' ORDER BY market_date, captured_at`).all(id);
    const days = new Map();
    for (const row of rows) {
      if (!days.has(row.market_date)) days.set(row.market_date, []);
      days.get(row.market_date).push(row);
    }
    // Use the capture_id primary-key prefix, not a multi-million-row quote scan.
    const selectQuotes = db.prepare(`SELECT option_symbol, right_type, strike, expiration, bid, ask, delta
      FROM yolo_option_quotes WHERE capture_id = ? AND user_id = ? AND expiration = ?`);
    const diagnostics = [];
    const trades = [];
    let quoteRows = 0;
    let completedDays = 0;
    const resultConfig = backtestYoloDataset([], options).config;
    for (const [marketDate, dayRows] of days) {
      const expiration = dayRows.map((row) => row.expiration).filter((value) => value > marketDate).sort()[0];
      const selected = dayRows.filter((row) => row.expiration === expiration);
      const captures = [];
      for (let offset = 0; offset < selected.length; offset += 20) {
        onProgress({ stage: '读取下一到期日报价', marketDate, expiration, completedDays, totalDays: days.size,
          loadedCaptures: offset, totalCaptures: selected.length, quoteRows, diagnostics: [...diagnostics] });
        await yieldToRequests();
        for (const row of selected.slice(offset, offset + 20)) {
          const quotes = selectQuotes.all(row.id, id, expiration).map((q) => ({
            optionSymbol: q.option_symbol, right: q.right_type, strike: q.strike, expiration: q.expiration,
            bid: q.bid, ask: q.ask, delta: q.delta
          }));
          quoteRows += quotes.length;
          captures.push({ id: row.id, capturedAt: row.captured_at, marketDate, expiration,
            underlyingPrice: row.underlying_price, quotes });
        }
      }
      onProgress({ stage: '计算入场与退出', marketDate, expiration, completedDays, totalDays: days.size,
        loadedCaptures: selected.length, totalCaptures: selected.length, quoteRows, diagnostics: [...diagnostics] });
      await yieldToRequests();
      const result = backtestYoloDataset(captures, options);
      trades.push(...result.trades);
      diagnostics.push(...(result.diagnostics.length ? result.diagnostics : [{ marketDate, expiration: null,
        status: 'skipped', reason: '没有下一到期日的日内报价（排除0DTE）', captures: 0 }]));
      completedDays += 1;
      onProgress({ stage: '日期处理完成', marketDate, expiration, completedDays, totalDays: days.size,
        quoteRows, diagnostics: [...diagnostics] });
      await yieldToRequests();
    }
    onProgress({ stage: '汇总结果', completedDays, totalDays: days.size, quoteRows, diagnostics: [...diagnostics] });
    return { config: resultConfig, ...summarizeYoloTrades(trades, resultConfig.initialCapital), trades, diagnostics,
      dataQuality: { days: days.size, quoteRows, incompleteDays: diagnostics.filter((d) => d.status === 'incomplete').length,
        expirationRule: '每个交易日选择本站已采集的最近未来到期日；不是按自然日+1，缺失更近到期日时不能证明严格1DTE。',
        priceBasis: 'Cboe延时采样买卖报价，不是逐笔成交或实时NBBO；回撤为已平仓权益回撤。' } };
  }

  return { ensure, settings, updateSettings, markAttempt, saveCapture, saveCaptureDetailed, beginAttempt, finishAttempt,
    commitCaptureAttempt, recoverAttempts, collectionHealth, enabledUsers, status, captureDetails, optionChain, optionHistory, dataset, backtest, backtestAsync };
}
