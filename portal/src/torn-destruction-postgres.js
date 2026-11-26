import { chainConfig } from './torn-chain-monitor.js';
import { chainNotifySettings, DEFAULT_CHAIN_NOTIFY } from './torn-chain-notifications.js';
import { applyDestructionObservation, destructionConfig } from './torn-destruction-monitor.js';

export function createPostgresDestructionStore(db) {
  async function get(uid, client = db, lock = false) {
    const sql = 'SELECT config_json,history_json FROM navigation.torn_destruction_monitors WHERE user_id=$1' + (lock ? ' FOR UPDATE' : '');
    let { rows: [row] } = await client.query(sql, [uid]);
    if (!row) {
      const { rows: [legacy] } = await client.query('SELECT config_json FROM navigation.torn_chain_monitors WHERE user_id=$1', [uid]);
      const old = chainConfig({}, legacy ? JSON.parse(legacy.config_json) : undefined);
      const defaults = destructionConfig({ apiKeys: old.apiKeys, apiIntervalSeconds: old.apiIntervalSeconds });
      await client.query('INSERT INTO navigation.torn_destruction_monitors(user_id,config_json) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING',
        [uid, JSON.stringify(defaults)]);
      ({ rows: [row] } = await client.query(sql, [uid]));
    }
    return { config: destructionConfig({}, JSON.parse(row.config_json)), history: JSON.parse(row.history_json) };
  }

  function observeBatch(uid, rows) {
    return db.transaction(async client => {
      const saved = await get(uid, client, true);
      const ids = rows.map(row => row.id);
      const existing = await client.query('SELECT faction_id,row_json FROM navigation.torn_destruction_observations WHERE user_id=$1 AND faction_id=ANY($2::bigint[])', [uid, ids]);
      const previous = new Map(existing.rows.map(row => [Number(row.faction_id), JSON.parse(row.row_json)]));
      const updates = new Map();
      let history = saved.history;
      const events = rows.map(row => {
        const result = applyDestructionObservation(row, previous.get(row.id), () => history);
        if (!result) return null;
        if (result.history) history = result.history;
        previous.set(row.id, result.observation);
        updates.set(row.id, { faction_id: row.id, row_json: JSON.stringify(result.observation) });
        return result.event;
      });
      if (history !== saved.history) await client.query('UPDATE navigation.torn_destruction_monitors SET history_json=$2 WHERE user_id=$1', [uid, JSON.stringify(history)]);
      if (updates.size) await client.query(`INSERT INTO navigation.torn_destruction_observations(user_id,faction_id,row_json)
        SELECT $1, faction_id, row_json FROM jsonb_to_recordset($2::jsonb) AS changes(faction_id bigint,row_json text)
        ON CONFLICT(user_id,faction_id) DO UPDATE SET row_json=excluded.row_json`, [uid, JSON.stringify([...updates.values()])]);
      return events;
    });
  }

  return {
    get,
    observeBatch,
    async observe(uid, row) { return (await observeBatch(uid, [row]))[0]; },
    save(uid, input) {
      return db.transaction(async client => {
        const config = destructionConfig(input, (await get(uid, client, true)).config);
        await client.query('UPDATE navigation.torn_destruction_monitors SET config_json=$2 WHERE user_id=$1', [uid, JSON.stringify(config)]);
        return config;
      });
    },
    async observations(uid) {
      const { rows } = await db.query('SELECT row_json FROM navigation.torn_destruction_observations WHERE user_id=$1 ORDER BY faction_id', [uid]);
      return rows.map(row => JSON.parse(row.row_json));
    },
    async clear(uid) {
      await db.query("UPDATE navigation.torn_destruction_monitors SET history_json='[]' WHERE user_id=$1", [uid]);
    },
    async getNotify(uid) {
      const { rows: [row] } = await db.query('SELECT settings_json FROM navigation.torn_chain_notifications WHERE user_id=$1', [uid]);
      return row ? JSON.parse(row.settings_json) : structuredClone(DEFAULT_CHAIN_NOTIFY);
    },
    async saveNotify(uid, input) {
      const settings = chainNotifySettings(input);
      await db.query(`INSERT INTO navigation.torn_chain_notifications(user_id,settings_json) VALUES($1,$2)
        ON CONFLICT(user_id) DO UPDATE SET settings_json=excluded.settings_json`, [uid, JSON.stringify(settings)]);
      return settings;
    },
  };
}
