export function createTornRunStore(db) {
  if (db.query) return {
    async list() {
      const { rows } = await db.query('SELECT module,user_id,desired,error,updated_at FROM navigation.torn_monitor_runs');
      return rows.map(row => ({ ...row, desired: Number(row.desired) }));
    },
    set(module, uid, desired, error = '') {
      return db.query(`INSERT INTO navigation.torn_monitor_runs(module,user_id,desired,error,updated_at) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(module,user_id) DO UPDATE SET desired=excluded.desired,error=excluded.error,
        updated_at=greatest(excluded.updated_at,torn_monitor_runs.updated_at+1)`,
      [module, uid, desired ? 1 : 0, error, Date.now()]);
    },
    clearIfUnchanged(row, error) {
      return db.query(`UPDATE navigation.torn_monitor_runs SET desired=0,error=$1,updated_at=greatest($2,updated_at+1)
        WHERE module=$3 AND user_id=$4 AND desired=1 AND updated_at=$5`,
      [error, Date.now(), row.module, row.user_id, row.updated_at]);
    },
  };
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
