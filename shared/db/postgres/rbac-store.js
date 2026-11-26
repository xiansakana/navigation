import { revisionKey, staleRbacError } from '../rbac-store.js';

export function createPostgresRbacStore(db) {
  return {
    async revision() {
      const { rows } = await db.query('SELECT revision FROM navigation.rbac_snapshot WHERE id = 1');
      return BigInt(rows[0]?.revision || 0);
    },
    async load() {
      const { rows: [row] } = await db.query('SELECT payload, revision FROM navigation.rbac_snapshot WHERE id = 1');
      if (!row) return null;
      const data = JSON.parse(row.payload);
      Object.defineProperty(data, revisionKey, { value: BigInt(row.revision), writable: true, configurable: true });
      return data;
    },
    async save(data) {
      const expected = BigInt(data[revisionKey] ?? 0);
      const payload = JSON.stringify(data);
      const { rows } = expected === 0n
        ? await db.query(`INSERT INTO navigation.rbac_snapshot (id, payload, revision)
            VALUES (1, $1, 1) ON CONFLICT (id) DO NOTHING RETURNING revision`, [payload])
        : await db.query(`UPDATE navigation.rbac_snapshot SET payload = $1, revision = revision + 1
            WHERE id = 1 AND revision = $2 RETURNING revision`, [payload, expected.toString()]);
      if (!rows.length) throw staleRbacError();
      Object.defineProperty(data, revisionKey, { value: BigInt(rows[0].revision), writable: true, configurable: true });
    },
  };
}
