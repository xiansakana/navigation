export async function loadQqBotState(db, key) {
  if (!db) return null;
  const { rows: [row] } = await db.query('SELECT data FROM navigation.qq_bot_state WHERE key=$1', [key]);
  if (!row) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}

export async function saveQqBotState(db, key, value) {
  if (!db) return;
  await db.query(`INSERT INTO navigation.qq_bot_state(key,data,updated_at) VALUES($1,$2,$3)
    ON CONFLICT(key) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`,
  [key, JSON.stringify(value), new Date().toISOString()]);
}
