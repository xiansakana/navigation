import { createHash } from 'node:crypto';

const fingerprint = value => createHash('sha256').update(String(value)).digest('hex');
const loadSnapshot = (row, watcher) => row?.key_hash === fingerprint(watcher.apiKey) ? JSON.parse(row.snapshot) : null;
const snapshotOf = state => JSON.stringify({
  activeKeys: [...state.activeKeys], alerts: [...state.alertMap], pendingMarket: [...(state.pendingMarket || [])],
  ...(state.recentBazaarAlerts ? { recentBazaarAlerts: [...state.recentBazaarAlerts] } : {}),
});

export function createPostgresUndercutStore(db) {
  return {
    async restore(watcher) {
      const { rows: [row] } = await db.query('SELECT key_hash,snapshot FROM navigation.torn_undercut_runtime WHERE watcher_id=$1', [watcher.id]);
      return loadSnapshot(row, watcher);
    },
    async save(watcher, state) {
      await db.query(`INSERT INTO navigation.torn_undercut_runtime(watcher_id,key_hash,snapshot) VALUES($1,$2,$3)
        ON CONFLICT(watcher_id) DO UPDATE SET key_hash=excluded.key_hash,snapshot=excluded.snapshot`,
        [watcher.id, fingerprint(watcher.apiKey), snapshotOf(state)]);
    },
  };
}

export function createUndercutStore(db) {
  db.exec('CREATE TABLE IF NOT EXISTS torn_undercut_runtime (watcher_id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, snapshot TEXT NOT NULL)');
  return {
    load(watcher) {
      const row = db.prepare('SELECT * FROM torn_undercut_runtime WHERE watcher_id=?').get(watcher.id);
      return loadSnapshot(row, watcher);
    },
    save(watcher, state) {
      db.prepare('INSERT INTO torn_undercut_runtime(watcher_id,key_hash,snapshot) VALUES(?,?,?) ON CONFLICT(watcher_id) DO UPDATE SET key_hash=excluded.key_hash,snapshot=excluded.snapshot')
        .run(watcher.id, fingerprint(watcher.apiKey), snapshotOf(state));
    }
  };
}
