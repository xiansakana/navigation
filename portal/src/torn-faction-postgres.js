import { FACTION_DEFAULTS, factionConfig } from './torn-faction-analysis.js';

export function createPostgresFactionStore(db) {
  const lists = new Map();
  async function read(client, uid, lock = false) {
    const sql = 'SELECT config_json,run_json FROM navigation.torn_faction_scans WHERE user_id=$1' + (lock ? ' FOR UPDATE' : '');
    let { rows: [saved] } = await client.query(sql, [uid]);
    if (!saved) {
      await client.query('INSERT INTO navigation.torn_faction_scans(user_id,config_json) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING',
        [uid, JSON.stringify(FACTION_DEFAULTS)]);
      ({ rows: [saved] } = await client.query(sql, [uid]));
    }
    const input = JSON.parse(saved.config_json);
    return { config: factionConfig({}, input), run: JSON.parse(saved.run_json), legacy: 'dailyDropPct' in input || 'peakDropPct' in input };
  }

  async function clearRows(client, uid) {
    await client.query('DELETE FROM navigation.torn_faction_rows WHERE user_id=$1', [uid]);
  }

  return {
    async getConfig(uid) { return (await read(db, uid)).config; },
    get(uid) {
      return db.transaction(async client => {
        const { config, run, legacy } = await read(client, uid, true);
        if (legacy) {
          const state = { stage: '已切换为金额条件，请确认金额阈值后启动；历史缓存保留' };
          await client.query('UPDATE navigation.torn_faction_scans SET config_json=$2,run_json=$3 WHERE user_id=$1',
            [uid, JSON.stringify(config), JSON.stringify(state)]);
          await clearRows(client, uid);
          lists.delete(uid);
          return { config, run: { ...state, rows: [] } };
        }
        const { rows } = await client.query('SELECT row_json FROM navigation.torn_faction_rows WHERE user_id=$1 ORDER BY respect,faction_id', [uid]);
        return { config, run: { ...run, rows: rows.map(row => JSON.parse(row.row_json)) } };
      });
    },
    async save(uid, input) {
      let reset;
      const config = await db.transaction(async client => {
        const { config: previous, legacy } = await read(client, uid, true);
        const updated = factionConfig(input, previous);
        const intervalOnly = !legacy && updated.apiIntervalSeconds !== previous.apiIntervalSeconds &&
          Object.keys(updated).every(key => key === 'apiIntervalSeconds' || JSON.stringify(updated[key]) === JSON.stringify(previous[key]));
        reset = !intervalOnly;
        if (intervalOnly) await client.query('UPDATE navigation.torn_faction_scans SET config_json=$2 WHERE user_id=$1', [uid, JSON.stringify(updated)]);
        else {
          await client.query("UPDATE navigation.torn_faction_scans SET config_json=$2,run_json='{}' WHERE user_id=$1", [uid, JSON.stringify(updated)]);
          await clearRows(client, uid);
        }
        return updated;
      });
      if (reset) lists.delete(uid);
      return config;
    },
    async saveRun(uid, run) {
      const { rows, ...state } = run;
      await db.transaction(async client => {
        await read(client, uid, true);
        const replace = !rows || lists.get(uid) !== rows;
        if (replace) await clearRows(client, uid);
        const updates = replace ? (rows || []) : rows.filter(row => row.id === run.currentFaction);
        if (updates.length) {
          const records = updates.map(row => ({ faction_id: row.id, respect: row.respect, row_json: JSON.stringify(row) }));
          await client.query(`INSERT INTO navigation.torn_faction_rows(user_id,faction_id,respect,row_json)
            SELECT $1,faction_id,respect,row_json FROM jsonb_to_recordset($2::jsonb) AS items(faction_id bigint,respect bigint,row_json text)
            ON CONFLICT(user_id,faction_id) DO UPDATE SET respect=excluded.respect,row_json=excluded.row_json`, [uid, JSON.stringify(records)]);
        }
        await client.query('UPDATE navigation.torn_faction_scans SET run_json=$2 WHERE user_id=$1', [uid, JSON.stringify(state)]);
      });
      if (rows) lists.set(uid, rows);
      else lists.delete(uid);
    },
    async point(uid, id, day) {
      const { rows: [row] } = await db.query('SELECT point_json FROM navigation.torn_faction_networth WHERE user_id=$1 AND leader_id=$2 AND day=$3', [uid, id, day]);
      return row ? JSON.parse(row.point_json) : null;
    },
    async points(uid, id, first, last) {
      const { rows } = await db.query('SELECT day,point_json FROM navigation.torn_faction_networth WHERE user_id=$1 AND leader_id=$2 AND day BETWEEN $3 AND $4', [uid, id, first, last]);
      return new Map(rows.map(row => [Number(row.day), JSON.parse(row.point_json)]));
    },
    savePoint(uid, id, point) { return this.savePoints(uid, id, [point]); },
    async savePoints(uid, id, points) {
      if (!points.length) return;
      const records = points.map(point => ({ day: point.day, point_json: JSON.stringify(point) }));
      await db.query(`INSERT INTO navigation.torn_faction_networth(user_id,leader_id,day,point_json)
        SELECT $1,$2,day,point_json FROM jsonb_to_recordset($3::jsonb) AS items(day bigint,point_json text)
        ON CONFLICT(user_id,leader_id,day) DO UPDATE SET point_json=excluded.point_json`, [uid, id, JSON.stringify(records)]);
    },
    async expireDay(uid, day) {
      await db.query('DELETE FROM navigation.torn_faction_networth WHERE user_id=$1 AND day=$2', [uid, day]);
    },
  };
}
