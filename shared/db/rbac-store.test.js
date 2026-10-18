import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { initSchema } from './schema.js';
import { loadRbacBlob, saveRbacBlob, rbacRevision } from './rbac-store.js';
const require = createRequire(new URL('../../portal/package.json', import.meta.url));
const Database = require('better-sqlite3');

test('RBAC rejects stale writes and detects legacy payload updates', () => {
  const db = new Database(':memory:');
  try {
    initSchema(db);
    saveRbacBlob(db, { roles: [] });
    const a = loadRbacBlob(db), b = loadRbacBlob(db);
    a.roles.push({ id: 'a' });
    saveRbacBlob(db, a);
    b.roles.push({ id: 'b' });
    assert.throws(() => saveRbacBlob(db, b), { code: 'RBAC_CONFLICT' });
    const version = rbacRevision(db);
    db.prepare('UPDATE rbac_snapshot SET payload = ? WHERE id = 1').run(JSON.stringify({ roles: [{ id: 'external' }] }));
    assert.equal(rbacRevision(db), version + 1);
    assert.equal(loadRbacBlob(db).roles[0].id, 'external');
  } finally { db.close(); }
});
