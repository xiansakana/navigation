import { ensureRbacRevision } from './schema.js';
const initialized = new WeakSet();
function ready(db) { if (!initialized.has(db)) { ensureRbacRevision(db); initialized.add(db); } }
const revisionKey = Symbol.for('navigation.rbacRevision');

export function rbacRevision(db) {
  ready(db);
  return db.prepare('SELECT revision FROM rbac_snapshot WHERE id = 1').get()?.revision || 0;
}

export function copyRbac(data) {
  const copy = structuredClone(data);
  if (data[revisionKey] !== undefined) Object.defineProperty(copy, revisionKey, { value: data[revisionKey], writable: true, configurable: true });
  return copy;
}

export function loadRbacBlob(db) {
  ready(db);
  const row = db.prepare('SELECT payload, revision FROM rbac_snapshot WHERE id = 1').get();
  if (!row) return null;
  const data = JSON.parse(row.payload);
  Object.defineProperty(data, revisionKey, { value: row.revision, writable: true, configurable: true });
  return data;
}

export function saveRbacBlob(db, data) {
  ready(db);
  db.transaction(() => {
    const expected = data[revisionKey] ?? rbacRevision(db);
    const payload = JSON.stringify(data);
    const result = expected === 0
      ? db.prepare('INSERT OR IGNORE INTO rbac_snapshot (id, payload, revision) VALUES (1, ?, 1)').run(payload)
      : db.prepare('UPDATE rbac_snapshot SET payload = ?, revision = revision + 1 WHERE id = 1 AND revision = ?').run(payload, expected);
    if (!result.changes) throw Object.assign(new Error('权限配置已被其他操作更新，请刷新后重试'), { status: 409, code: 'RBAC_CONFLICT' });
    Object.defineProperty(data, revisionKey, { value: expected + 1, writable: true, configurable: true });
  }).immediate();
}

export function hasRbacData(db) {
  return !!db.prepare('SELECT 1 AS ok FROM rbac_snapshot WHERE id = 1').get();
}
