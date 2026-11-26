import { shoppingConfig } from './torn-shopping-monitor.js';
import { chainNotifySettings, DEFAULT_CHAIN_NOTIFY } from './torn-chain-notifications.js';

const decode = row => ({ config: JSON.parse(row.config), notify: JSON.parse(row.notify),
  history: JSON.parse(row.history), seen: JSON.parse(row.seen) });

export function createPostgresShoppingStore(db) {
  const defaults = { config: JSON.stringify(shoppingConfig({})), notify: JSON.stringify(DEFAULT_CHAIN_NOTIFY), history: '[]', seen: '[]' };
  async function get(uid) {
    const { rows } = await db.query('SELECT config,notify,history,seen FROM navigation.torn_shopping WHERE user_id=$1', [uid]);
    return decode(rows[0] || defaults);
  }
  function mutate(uid, run) {
    return db.transaction(async client => {
      await client.query(`INSERT INTO navigation.torn_shopping(user_id,config,notify)
        VALUES ($1,$2,$3) ON CONFLICT (user_id) DO NOTHING`, [uid, defaults.config, defaults.notify]);
      const { rows: [row] } = await client.query('SELECT config,notify,history,seen FROM navigation.torn_shopping WHERE user_id=$1 FOR UPDATE', [uid]);
      return run(client, decode(row));
    });
  }
  return {
    get,
    save(uid, input) {
      return mutate(uid, (client, row) => client.query('UPDATE navigation.torn_shopping SET config=$1 WHERE user_id=$2',
        [JSON.stringify(shoppingConfig(input, row.config)), uid]));
    },
    async getNotify(uid) { return (await get(uid)).notify; },
    saveNotify(uid, input) {
      return mutate(uid, client => client.query('UPDATE navigation.torn_shopping SET notify=$1 WHERE user_id=$2',
        [JSON.stringify(chainNotifySettings(input)), uid]));
    },
    clear(uid) { return mutate(uid, client => client.query("UPDATE navigation.torn_shopping SET history='[]' WHERE user_id=$1", [uid])); },
    record(uid, row) {
      return mutate(uid, async (client, saved) => {
        const signature = [row.itemId, row.source, row.seller || '', row.price].join(':');
        if (saved.seen.includes(signature)) return false;
        saved.seen.push(signature);
        saved.history.push(row);
        await client.query('UPDATE navigation.torn_shopping SET history=$1,seen=$2 WHERE user_id=$3',
          [JSON.stringify(saved.history.slice(-200)), JSON.stringify(saved.seen.slice(-10000)), uid]);
        return true;
      });
    },
  };
}
