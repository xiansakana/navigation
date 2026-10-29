import { setTimeout as delay } from 'node:timers/promises';
let bazaarQueue = Promise.resolve(), lastBazaarAt = 0;
import { ChainMonitor, chainConfig } from './torn-chain-monitor.js';
import { chainNotifySettings, DEFAULT_CHAIN_NOTIFY } from './torn-chain-notifications.js';
export function shoppingConfig(input, previous = {}) {
  const keys = chainConfig({ ...input, minHits: 0, maxHits: null, intervalSeconds: 60, bonusHits: [], leaderFilter: 'all' }, { ...previous, bonusHits: [], leaderFilter: 'all' });
  const intervalSeconds = Number(input.intervalSeconds ?? previous.intervalSeconds ?? 30);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 10 || intervalSeconds > 3600) throw new Error('扫描间隔须为10–3600秒');
  const items = input.items ?? previous.items ?? [];
  if (!Array.isArray(items) || items.length > 100) throw new Error('最多监控100种物品');
  const ids = new Set();
  const normalized = items.map(row => {
    const id = Number(row.id); if (!Number.isSafeInteger(id) || id <= 0 || ids.has(id)) throw new Error('物品ID须为不重复正整数'); ids.add(id);
    const limit = v => { if (v === '' || v === null || v === undefined) return null; const n = Number(v); if (!Number.isSafeInteger(n) || n <= 0) throw new Error('最高购买价须为正整数'); return n; };
    const market = limit(row.market), bazaar = limit(row.bazaar);
    if (market === null && bazaar === null) throw new Error('至少设置市场或巴扎价格');
    return { id, name: String(row.name || 'Item #' + id).slice(0, 100), market, bazaar };
  });
  return { apiKey: keys.apiKey, apiKeys: keys.apiKeys, apiIntervalSeconds: keys.apiIntervalSeconds, intervalSeconds, items: normalized };
}
export function createShoppingStore(db) {
  db.exec("CREATE TABLE IF NOT EXISTS torn_shopping(user_id TEXT PRIMARY KEY, config TEXT NOT NULL, notify TEXT NOT NULL DEFAULT '{}', history TEXT NOT NULL DEFAULT '[]', seen TEXT NOT NULL DEFAULT '[]')");
  const get = uid => { db.prepare('INSERT OR IGNORE INTO torn_shopping(user_id,config,notify) VALUES(?,?,?)').run(uid, JSON.stringify(shoppingConfig({})), JSON.stringify(DEFAULT_CHAIN_NOTIFY)); const row = db.prepare('SELECT * FROM torn_shopping WHERE user_id=?').get(uid); return { config: JSON.parse(row.config), history: JSON.parse(row.history), seen: JSON.parse(row.seen), notify: JSON.parse(row.notify) }; };
  return { get, save(uid, input) { const config = shoppingConfig(input, get(uid).config); db.prepare('UPDATE torn_shopping SET config=? WHERE user_id=?').run(JSON.stringify(config), uid); }, getNotify: uid => get(uid).notify, saveNotify(uid, input) { get(uid); db.prepare('UPDATE torn_shopping SET notify=? WHERE user_id=?').run(JSON.stringify(chainNotifySettings(input)), uid); }, clear(uid) { get(uid); db.prepare("UPDATE torn_shopping SET history='[]' WHERE user_id=?").run(uid); },
    record: db.transaction((uid, row) => { const saved = get(uid); const signature = [row.itemId, row.source, row.seller || '', row.price].join(':'); if (saved.seen.includes(signature)) return false; saved.seen.push(signature); saved.history.push(row); db.prepare('UPDATE torn_shopping SET history=?,seen=? WHERE user_id=?').run(JSON.stringify(saved.history.slice(-200)), JSON.stringify(saved.seen.slice(-10000)), uid); return true; }) };
}
export function bazaarListings(id, signal) {
  const job = bazaarQueue.catch(()=>{}).then(async()=>{
  await delay(Math.max(0,lastBazaarAt + 2000 - Date.now()),undefined,{signal}); signal.throwIfAborted(); lastBazaarAt=Date.now();
  const r = await fetch('https://weav3r.dev/api/marketplace/' + id + '?limit=100', { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), redirect: 'error', headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('Weav3r HTTP ' + r.status);
  const d = await r.json(); if (!Array.isArray(d.listings)) throw new Error('巴扎数据无效'); return d.listings;
  }); bazaarQueue=job.catch(()=>{}); return job;
}
export function lowListings(rows, source, limit, item) {
  if (!Array.isArray(rows)) throw new Error('挂单数据无效');
  return rows.filter(row => Number.isSafeInteger(Number(row.price)) && Number(row.price) > 0 && Number(row.price) <= limit && Number(row.amount ?? row.quantity) > 0).map(row => {
    const seller = Number(row.player_id);
    if (source === 'bazaar' && (!Number.isSafeInteger(seller) || seller <= 0)) return null;
    return { kind: 'shopping', itemId: item.id, name: item.name, source, price: Number(row.price), quantity: Number(row.amount ?? row.quantity), seller: source === 'bazaar' ? seller : null, link: source === 'bazaar' ? 'https://www.torn.com/bazaar.php?userId=' + seller : 'https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=' + item.id };
  }).filter(Boolean).sort((a,b) => a.price - b.price).slice(0, 5);
}
export class ShoppingMonitor extends ChainMonitor {
  constructor(options) {
    const request = (path,key,signal,policy) => options.request(path,key,signal,{ ...policy, scope: 'shopping:' + options.uid });
    request.release = () => options.request.release?.('shopping:' + options.uid);
    super({ ...options, request }); this.bazaar = options.bazaar || bazaarListings; this.state.rows = []; }
  start() {
    if (this.running || this.busy) throw new Error('监控正在运行或停止中');
    if (!this.authorize()) throw new Error('无权启动'); this.config = this.store.get(this.uid).config;
    if (!this.config.apiKeys.length || !this.config.items.length) throw new Error('请先保存Key和监控物品');
    this.resetKeys(); this.running = true; this.controller = new AbortController(); this.promise = this.scan();
  }
  async scan() {
    if (!this.running || this.busy) return; this.busy = true; const signal = this.controller.signal;
    const check = () => { signal.throwIfAborted(); if (!this.running || !this.authorize()) throw Object.assign(new Error('监控已停止或权限已变更'), { fatal: true }); };
    this.state.rows = []; this.state.error = '';
    try {
      await this.prepareKeys(signal);
      for (const item of this.config.items) for (const source of ['market', 'bazaar']) {
        if (item[source] === null) continue; check();
        try {
          let rows;
          if (source === 'market') { const d = await this.api('market/' + item.id + '/itemmarket?limit=100&sort=ASC', signal); rows = d.itemmarket?.listings; }
          else rows = await this.bazaar(item.id, signal);
          check(); const lows = lowListings(rows, source, item[source], item);
          this.state.rows.push({ itemId: item.id, name: item.name, source, matches: lows.length, checkedAt: this.now() });
          for (const row of lows) { check(); row.detectedAt = this.now(); if (this.store.record(this.uid, row)) { try { await this.notify(row); } catch { this.state.notificationError = '记录已保存，通知失败，请检查QQ配置（不自动重发）'; } } }
        } catch (error) { if (error.fatal || signal.aborted) throw error; this.state.rows.push({ itemId: item.id, source, error: this.safeError(error) }); }
      }
      this.state.rounds++; this.state.lastScanAt = this.now();
    } catch (error) { if (!signal.aborted) { this.state.error = this.safeError(error); if (error.fatal) this.stop(); } }
    finally { this.busy = false; if (this.running && !signal.aborted && this.authorize()) { this.state.nextScanAt = this.now() + this.config.intervalSeconds; this.timer = this.schedule(() => { this.promise = this.scan(); }, this.config.intervalSeconds * 1000); this.timer?.unref?.(); } else this.stop(); }
  }
}
