import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_CHAIN_NOTIFY, chainNotifySettings } from './torn-chain-notifications.js';

export const DEFAULT_CHAIN_CONFIG = { minHits: 100, maxHits: null, intervalSeconds: 60, apiKey: '' };

// Torn's documented cooldown duration is six seconds per hit. The public API
// explicitly defines cooldown as its end timestamp; `end` does not document
// when cooldown began, so keep this value explicitly identified as an estimate.
export function estimateCooldownStart(until, hits, detectedAt) {
  if (![until, hits, detectedAt].every(Number.isSafeInteger) || hits <= 0) return null;
  const start = until - hits * 6;
  return start > 0 && start <= detectedAt && start < until ? start : null;
}
export function chainConfig(input, previous = DEFAULT_CHAIN_CONFIG) {
  const result = { ...previous };
  for (const field of ['minHits', 'maxHits', 'intervalSeconds']) {
    if (!(field in input)) continue;
    const value = input[field];
    if (field === 'maxHits' && (value === '' || value === null)) { result[field] = null; continue; }
    if (value === '' || value === null || !Number.isSafeInteger(Number(value)) || Number(value) < (field === 'intervalSeconds' ? 30 : 0)) throw new Error('长度须为非负整数，间隔至少 30 秒');
    result[field] = Number(value);
  }
  if (result.maxHits !== null && result.maxHits < result.minHits) throw new Error('最大长度不能小于最小长度');
  if ('apiKey' in input) {
    const key = String(input.apiKey || '').trim();
    if (key && !/^[a-zA-Z0-9]{16}$/.test(key)) throw new Error('API Key 应为 16 位字母或数字');
    result.apiKey = key;
  }
  return result;
}

// One queue for this Portal process: <= 40 requests/minute, leaving headroom
// for other tools. Torn's per-user quota also includes external services.
export function createChainApiClient({ fetchImpl = fetch, spacingMs = 1500 } = {}) {
  let queue = Promise.resolve(), nextAt = 0;
  return (path, key, signal) => {
    const job = queue.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      const url = new URL(path, 'https://api.torn.com/v2/');
      if (url.origin !== 'https://api.torn.com' || !/^\/v2\/faction\/(warfarechains|\d+\/chain)$/.test(url.pathname)) throw new Error('API 分页地址无效');
      url.searchParams.set('key', key); url.searchParams.set('comment', 'NavChain');
      await delay(Math.max(0, nextAt - Date.now()), undefined, { signal });
      signal?.throwIfAborted(); nextAt = Date.now() + spacingMs;
      let response;
      try { response = await fetchImpl(url.href, { signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(15000)]), headers: { Accept: 'application/json' }, redirect: 'error' }); }
      catch { if (signal?.aborted) signal.throwIfAborted(); throw new Error('Torn API 网络异常或超时'); }
      if (response.status === 429) throw Object.assign(new Error('Torn API 已限流，监控已停止，请稍后手动启动'), { fatal: true });
      if (!response.ok) throw new Error('Torn API HTTP ' + response.status);
      const data = await response.json().catch(() => { throw new Error('Torn API 返回无效数据'); });
      if (data.error) {
        const code = Number(data.error.code);
        throw Object.assign(new Error('Torn API 错误 ' + code + ([1, 2, 10, 13, 16, 18].includes(code) ? '，请检查 Key 和权限' : '')), { fatal: [1, 2, 5, 8, 9, 10, 13, 16, 18].includes(code) });
      }
      return data;
    });
    queue = job.catch(() => {}); return job;
  };
}

export function createChainStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS torn_chain_monitors (
    user_id TEXT PRIMARY KEY, config_json TEXT NOT NULL, history_json TEXT NOT NULL DEFAULT '[]', seen_json TEXT NOT NULL DEFAULT '[]'
  )`);
  db.exec('CREATE TABLE IF NOT EXISTS torn_chain_notifications (user_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL)');
  const ensure = uid => db.prepare('INSERT OR IGNORE INTO torn_chain_monitors(user_id,config_json) VALUES(?,?)').run(uid, JSON.stringify(DEFAULT_CHAIN_CONFIG));
  const get = uid => {
    ensure(uid); const row = db.prepare('SELECT * FROM torn_chain_monitors WHERE user_id=?').get(uid);
    const history = JSON.parse(row.history_json).map(record => ({ ...record, cooldownStartedAt: Object.hasOwn(record, 'cooldownStartedAt') ? record.cooldownStartedAt : estimateCooldownStart(record.cooldownUntil, record.hits, record.detectedAt) }));
    return { config: JSON.parse(row.config_json), history, seen: JSON.parse(row.seen_json) };
  };
  return {
    get,
    getNotify(uid) { const row = db.prepare('SELECT settings_json FROM torn_chain_notifications WHERE user_id=?').get(uid); return row ? JSON.parse(row.settings_json) : structuredClone(DEFAULT_CHAIN_NOTIFY); },
    saveNotify(uid, input) { const settings = chainNotifySettings(input); db.prepare('INSERT INTO torn_chain_notifications(user_id,settings_json) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET settings_json=excluded.settings_json').run(uid, JSON.stringify(settings)); return settings; },
    save(uid, input) { const config = chainConfig(input, get(uid).config); db.prepare('UPDATE torn_chain_monitors SET config_json=? WHERE user_id=?').run(JSON.stringify(config), uid); return config; },
    clear(uid) { ensure(uid); db.prepare("UPDATE torn_chain_monitors SET history_json='[]' WHERE user_id=?").run(uid); },
    record(uid, candidate, chain, fresh, now) {
      const { config, history, seen } = get(uid), id = Number(chain.id);
      if (chain.current < config.minHits || config.maxHits !== null && chain.current > config.maxHits || history.some(row => row.id === id)) return;
      const finalHits = Number.isSafeInteger(candidate.chain) && candidate.chain > 0 ? candidate.chain : chain.current;
      history.push({ id, factionId: Number(candidate.faction.id), name: String(candidate.faction.name || candidate.faction.id).slice(0, 160), hits: chain.current, cooldownStartedAt: estimateCooldownStart(chain.cooldown, finalHits, now), cooldownUntil: chain.cooldown, detectedAt: now, fresh: fresh && !seen.includes(id) });
      if (!seen.includes(id)) seen.push(id);
      db.prepare('UPDATE torn_chain_monitors SET history_json=?,seen_json=? WHERE user_id=?').run(JSON.stringify(history.slice(-200)), JSON.stringify(seen.slice(-5000)), uid);
      return history.at(-1);
    }
  };
}

export class ChainMonitor {
  constructor({ uid, store, request, notify = async () => {}, authorize = () => true, now = () => Math.floor(Date.now() / 1000), schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { uid, store, request, notify, authorize, now, schedule, cancel });
    this.running = false; this.busy = false; this.known = new Map(); this.cursor = 0;
    this.state = { running: false, rounds: 0, candidates: 0, confirmed: 0, failed: 0, partial: false, error: '', lastScanAt: null, nextScanAt: null };
  }
  status() { return { ...this.state, running: this.running, busy: this.busy }; }
  start() {
    if (this.running || this.busy) throw new Error('监控正在运行或上次请求尚未结束');
    if (!this.authorize()) throw new Error('无权启动 Chain 监控');
    this.config = this.store.get(this.uid).config;
    if (!this.config.apiKey) throw new Error('请先保存 Public API Key');
    this.known.clear(); this.cursor = 0; this.state.rounds = 0; this.state.error = ''; this.state.notificationError = '';
    this.running = true; this.controller = new AbortController();
    this.promise = this.scan();
  }
  stop() { this.running = false; this.cancel(this.timer); this.controller?.abort(); this.state.nextScanAt = null; }
  async scan() {
    if (!this.running || this.busy) return;
    this.busy = true; const signal = this.controller.signal;
    const valid = () => this.running && !signal.aborted && this.authorize();
    const check = () => { if (!valid()) throw Object.assign(new Error('监控已停止或权限已变更'), { fatal: true }); };
    const stats = { candidates: 0, confirmed: 0, failed: 0, partial: false, error: '' };
    try {
      check(); const candidates = new Map(), visited = new Set();
      let path = 'faction/warfarechains?cat=active&limit=100', pages = 0;
      while (path) {
        check(); if (visited.has(path)) { stats.partial = true; break; } visited.add(path);
        const data = await this.request(path, this.config.apiKey, signal); check();
        if (!Array.isArray(data.warfarechains)) throw new Error('API 未返回 Chain 列表');
        for (const row of data.warfarechains) if (Number.isSafeInteger(row?.id) && row.id > 0 && Number.isSafeInteger(row.faction?.id) && row.faction.id > 0) {
          candidates.set(row.id, row); const old = this.known.get(row.id); if (old) old.listedAt = this.now();
        }
        path = data._metadata?.links?.next || null; pages++;
        if (data.warfarechains.length === 100 && !data._metadata?.links) stats.partial = true;
        if (path && pages >= 10) { stats.partial = true; break; }
      }
      for (const [id, old] of this.known) if (old.status === 'active' && this.now() - old.listedAt <= 600 && !candidates.has(id)) candidates.set(id, old.candidate);
      stats.candidates = candidates.size;
      const eligible = [...candidates.values()].filter(row => { const old = this.known.get(row.id); return !(old?.status === 'cooldown' && old.until > this.now()); });
      const count = Math.min(40, eligible.length); stats.remainingCandidates = eligible.length - count;
      for (let i = 0; i < count; i++) {
        check(); const candidate = eligible[(this.cursor + i) % eligible.length];
        try {
          const { chain } = await this.request('faction/' + candidate.faction.id + '/chain', this.config.apiKey, signal); check();
          if (!chain || chain.id !== candidate.id || !['current', 'cooldown', 'timeout'].every(field => Number.isSafeInteger(chain[field]) && chain[field] >= 0)) { stats.failed++; continue; }
          const old = this.known.get(chain.id), status = chain.cooldown > this.now() ? 'cooldown' : chain.timeout > 0 ? 'active' : 'ended';
          if (status === 'cooldown') {
            const row = this.store.record(this.uid, candidate, chain, old?.status === 'active', this.now());
            if (row?.fresh) {
              try { check(); await this.notify(row); this.state.notificationError = ''; }
              catch { this.state.notificationError = '冷却记录已保存，但通知未能全部投递，请检查通知管理（不自动重试）'; }
            }
          }
          this.known.set(chain.id, { status, until: chain.cooldown, candidate, listedAt: this.now() }); stats.confirmed++;
        } catch (error) { if (error.fatal || !valid()) throw error; stats.failed++; }
      }
      this.cursor = eligible.length ? (this.cursor + count) % eligible.length : 0;
      for (const [id, old] of this.known) if (this.now() - old.listedAt > 86400) this.known.delete(id);
      this.state.rounds++; this.state.lastScanAt = this.now();
    } catch (error) {
      if (!signal.aborted) { stats.error = String(error.message).replaceAll(this.config.apiKey, '[Key]'); if (error.fatal) this.stop(); }
    } finally {
      Object.assign(this.state, stats); this.busy = false;
      if (valid()) {
        this.state.nextScanAt = this.now() + this.config.intervalSeconds;
        this.timer = this.schedule(() => { this.promise = this.scan(); }, this.config.intervalSeconds * 1000); this.timer?.unref?.();
      } else this.stop();
    }
  }
}
