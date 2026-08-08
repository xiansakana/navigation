export function loadRbacBlob(db) {
  const row = db.prepare('SELECT payload FROM rbac_snapshot WHERE id = 1').get();
  if (!row) return null;
  return JSON.parse(row.payload);
}

export function saveRbacBlob(db, data) {
  db.prepare('INSERT OR REPLACE INTO rbac_snapshot (id, payload) VALUES (1, ?)').run(JSON.stringify(data));
}

export function hasRbacData(db) {
  return !!db.prepare('SELECT 1 AS ok FROM rbac_snapshot WHERE id = 1').get();
}
