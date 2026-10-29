export function createTornRunStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS torn_monitor_runs (
    module TEXT NOT NULL, user_id TEXT NOT NULL, desired INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL, PRIMARY KEY(module,user_id)
  )`);
  return {
    list: () => db.prepare('SELECT module,user_id,desired,error FROM torn_monitor_runs').all(),
    set(module, uid, desired, error = '') {
      db.prepare(`INSERT INTO torn_monitor_runs(module,user_id,desired,error,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(module,user_id) DO UPDATE SET desired=excluded.desired,error=excluded.error,updated_at=excluded.updated_at`)
        .run(module, uid, desired ? 1 : 0, error, Date.now());
    }
  };
}
