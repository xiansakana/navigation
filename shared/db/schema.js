export function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rbac_snapshot (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quotes (
      symbol TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS holdings_meta (
      symbol TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quant_user_state (
      user_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quant_backtest_results (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_quant_backtests_user_created
      ON quant_backtest_results (user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS yolo_settings (
      user_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      interval_seconds INTEGER NOT NULL DEFAULT 60,
      last_attempt_at TEXT,
      last_capture_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS yolo_captures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      market_date TEXT NOT NULL,
      expiration TEXT NOT NULL,
      underlying_price REAL,
      source TEXT,
      contract_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS yolo_option_quotes (
      capture_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      option_symbol TEXT NOT NULL,
      right_type TEXT NOT NULL,
      strike REAL NOT NULL,
      expiration TEXT NOT NULL,
      bid REAL NOT NULL,
      ask REAL NOT NULL,
      bid_size REAL,
      ask_size REAL,
      last_price REAL,
      delta REAL,
      gamma REAL,
      theta REAL,
      vega REAL,
      iv REAL,
      volume REAL,
      open_interest REAL,
      PRIMARY KEY (capture_id, option_symbol),
      FOREIGN KEY (capture_id) REFERENCES yolo_captures(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_yolo_captures_user_time
      ON yolo_captures (user_id, captured_at);
    CREATE INDEX IF NOT EXISTS idx_yolo_quotes_user_symbol
      ON yolo_option_quotes (user_id, option_symbol, capture_id);
  `);

  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (!row) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '4')").run();
  } else if (Number(row.value) < 4) {
    db.prepare("UPDATE meta SET value = '4' WHERE key = 'schema_version'").run();
  }
}
