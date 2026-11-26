import crypto from 'node:crypto';
import { getDatabase } from '../../shared/db/index.js';
import { safeQuantUserId as safeUserId } from './quant-store.js';

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

function parsed(payload) {
  try { return JSON.parse(payload); } catch { return null; }
}

function newResult(rawResult) {
  return { ...rawResult, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
}

export function createPostgresQuantBacktestStore(db) {
  return {
    async save(userId, rawResult) {
      const result = newResult(rawResult);
      await db.query('INSERT INTO navigation.quant_backtest_results(id,user_id,payload,created_at) VALUES($1,$2,$3,$4)',
        [result.id, safeUserId(userId), JSON.stringify(result), result.createdAt]);
      return result;
    },
    async list(userId, limit = 20) {
      const bound = Math.max(1, Math.min(50, Math.trunc(Number(limit)) || 20));
      const { rows } = await db.query(`SELECT payload FROM navigation.quant_backtest_results
        WHERE user_id=$1 ORDER BY created_at DESC,_sqlite_rowid ASC LIMIT $2`, [safeUserId(userId), bound]);
      return rows.map(row => parsed(row.payload)).filter(Boolean).map(summary);
    },
    async get(userId, id) {
      const { rows: [row] } = await db.query('SELECT payload FROM navigation.quant_backtest_results WHERE id=$1 AND user_id=$2', [String(id || ''), safeUserId(userId)]);
      return row ? parsed(row.payload) : null;
    },
    async remove(userId, id) {
      const result = await db.query('DELETE FROM navigation.quant_backtest_results WHERE id=$1 AND user_id=$2', [String(id || ''), safeUserId(userId)]);
      return result.rowCount > 0;
    },
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
    const result = newResult(rawResult);
    insert.run(result.id, safeUserId(userId), JSON.stringify(result), result.createdAt);
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
