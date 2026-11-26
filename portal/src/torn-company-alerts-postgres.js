import { commitCompanySignals, defaultCompanyConfig, readCompanyNotify, updateCompanyNotify } from './torn-company-alerts-monitor.js';

export function createPostgresCompanyAlertsStore(db) {
  async function get(uid, client = db, lock = false) {
    const sql = 'SELECT config,runtime,history,notify FROM navigation.torn_company_alerts WHERE user_id=$1' + (lock ? ' FOR UPDATE' : '');
    let { rows: [row] } = await client.query(sql, [uid]);
    if (!row) {
      await client.query('INSERT INTO navigation.torn_company_alerts(user_id,config) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING',
        [uid, JSON.stringify(defaultCompanyConfig())]);
      ({ rows: [row] } = await client.query(sql, [uid]));
    }
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, JSON.parse(value)]));
  }

  return {
    get,
    async save(uid, config) {
      await db.query(`INSERT INTO navigation.torn_company_alerts(user_id,config) VALUES($1,$2)
        ON CONFLICT(user_id) DO UPDATE SET config=excluded.config`, [uid, JSON.stringify(config)]);
    },
    async getNotify(uid, kind, watcherId) {
      return readCompanyNotify((await get(uid)).notify, kind, watcherId);
    },
    saveNotify(uid, kind, value, watcherId) {
      return db.transaction(async client => {
        const { notify } = await get(uid, client, true);
        updateCompanyNotify(notify, kind, value, watcherId);
        await client.query('UPDATE navigation.torn_company_alerts SET notify=$2 WHERE user_id=$1', [uid, JSON.stringify(notify)]);
      });
    },
    commit(uid, slot, signals, kind, watcher, now, data) {
      return db.transaction(async client => {
        const saved = await get(uid, client, true);
        const fresh = commitCompanySignals(saved, slot, signals, kind, watcher, now, data);
        await client.query('UPDATE navigation.torn_company_alerts SET runtime=$2,history=$3 WHERE user_id=$1',
          [uid, JSON.stringify(saved.runtime), JSON.stringify(saved.history)]);
        return fresh;
      });
    },
  };
}
