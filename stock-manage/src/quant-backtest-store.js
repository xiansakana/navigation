import crypto from 'node:crypto';
import { getDatabase } from '../../shared/db/index.js';

function safeUserId(userId) {
  const value = String(userId || 'local').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : 'local';
}

function summary(result) {
  return {
    id: result.id,
    createdAt: result.createdAt,
    period: result.period,
    symbols: (result.results || []).map((item) => item.symbol),
    initialCapital: result.initialCapital,
    finalEquity: result.finalEquity,
    totalReturn: result.totalReturn,
    buyHoldReturn: result.buyHoldReturn,
    completedTrades: result.completedTrades,
    from: result.from,
    to: result.to
  };
}

export function createQuantBacktestStore(config, databaseOverride = null) {
  const database = databaseOverride || getDatabase({ dbPath: config.dbPath });
  const insert = database.prepare(`
    INSERT INTO quant_backtest_results (id, user_id, payload, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const listRows = database.prepare(`
    SELECT payload FROM quant_backtest_results
    WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
  `);
  const getRow = database.prepare('SELECT payload FROM quant_backtest_results WHERE id = ? AND user_id = ?');
  const deleteRow = database.prepare('DELETE FROM quant_backtest_results WHERE id = ? AND user_id = ?');

  function save(userId, rawResult) {
    const createdAt = new Date().toISOString();
    const result = { ...rawResult, id: crypto.randomUUID(), createdAt };
    insert.run(result.id, safeUserId(userId), JSON.stringify(result), createdAt);
    return result;
  }

  function list(userId, limit = 20) {
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
    return listRows.all(safeUserId(userId), safeLimit).flatMap((row) => {
      try { return [summary(JSON.parse(row.payload))]; } catch { return []; }
    });
  }

  function get(userId, id) {
    const row = getRow.get(String(id || ''), safeUserId(userId));
    if (!row) return null;
    try { return JSON.parse(row.payload); } catch { return null; }
  }

  function remove(userId, id) {
    return deleteRow.run(String(id || ''), safeUserId(userId)).changes > 0;
  }

  return { save, list, get, remove };
}
