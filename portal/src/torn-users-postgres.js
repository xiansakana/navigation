import { chainNotifySettings, DEFAULT_CHAIN_NOTIFY } from './torn-chain-notifications.js';
import { usersConfig } from './torn-users-monitor.js';

const fields = ['config', 'notify', 'history', 'seen', 'observations'];
const parse = row => Object.fromEntries(fields.map(field => [field, JSON.parse(row[field])]));

export function createPostgresUsersStore(db) {
  const defaults = [JSON.stringify(usersConfig({})), JSON.stringify(DEFAULT_CHAIN_NOTIFY)];
  const empty = { config: defaults[0], notify: defaults[1], history: '[]', seen: '[]', observations: '[]' };
  async function get(uid) {
    const { rows } = await db.query('SELECT * FROM navigation.torn_user_monitors WHERE user_id=$1', [uid]);
    return parse(rows[0] || empty);
  }
  function mutate(uid, run) {
    return db.transaction(async client => {
      await client.query(`INSERT INTO navigation.torn_user_monitors (user_id,config,notify)
        VALUES ($1,$2,$3) ON CONFLICT (user_id) DO NOTHING`, [uid, ...defaults]);
      const { rows: [row] } = await client.query('SELECT * FROM navigation.torn_user_monitors WHERE user_id=$1 FOR UPDATE', [uid]);
      return run(client, parse(row));
    });
  }
  const update = (client, uid, field, value) => client.query(
    'UPDATE navigation.torn_user_monitors SET ' + field + '=$1 WHERE user_id=$2', [JSON.stringify(value), uid]);
  return {
    get,
    save: (uid, input) => mutate(uid, (client, data) => update(client, uid, 'config', usersConfig(input, data.config))),
    async getNotify(uid) { return (await get(uid)).notify; },
    saveNotify: (uid, input) => mutate(uid, client => update(client, uid, 'notify', chainNotifySettings(input))),
    clear: uid => mutate(uid, client => update(client, uid, 'history', [])),
    observe: (uid, rows) => mutate(uid, client => update(client, uid, 'observations', rows)),
    record(uid, row) {
      return mutate(uid, async (client, data) => {
        const signature = row.id + ':' + row.hospitalUntil;
        if (data.seen.includes(signature)) return false;
        data.seen.push(signature);
        data.history.push({ ...row, notification: 'pending' });
        await client.query('UPDATE navigation.torn_user_monitors SET history=$1,seen=$2 WHERE user_id=$3',
          [JSON.stringify(data.history.slice(-200)), JSON.stringify(data.seen.slice(-10000)), uid]);
        return true;
      });
    },
    delivered(uid, row, notification) {
      return mutate(uid, async (client, data) => {
        const found = data.history.find(item => item.id === row.id && item.hospitalUntil === row.hospitalUntil);
        if (!found) return;
        found.notification = notification;
        await update(client, uid, 'history', data.history);
      });
    },
  };
}
