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
  `);

  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (!row) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
  }
}
