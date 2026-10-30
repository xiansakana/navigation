import { createHash } from 'node:crypto';

const fingerprint = value => createHash('sha256').update(String(value)).digest('hex');
export function createUndercutStore(db) {
  db.exec('CREATE TABLE IF NOT EXISTS torn_undercut_runtime (watcher_id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, snapshot TEXT NOT NULL)');
  return {
    load(watcher) {
      const row = db.prepare('SELECT * FROM torn_undercut_runtime WHERE watcher_id=?').get(watcher.id);
      return row?.key_hash === fingerprint(watcher.apiKey) ? JSON.parse(row.snapshot) : null;
    },
    save(watcher, state) {
      const snapshot = JSON.stringify({ activeKeys: [...state.activeKeys], alerts: [...state.alertMap], pendingMarket: [...(state.pendingMarket || new Map())] });
      db.prepare('INSERT INTO torn_undercut_runtime(watcher_id,key_hash,snapshot) VALUES(?,?,?) ON CONFLICT(watcher_id) DO UPDATE SET key_hash=excluded.key_hash,snapshot=excluded.snapshot')
        .run(watcher.id, fingerprint(watcher.apiKey), snapshot);
    }
  };
}
