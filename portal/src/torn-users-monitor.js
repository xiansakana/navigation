import { ChainMonitor, chainConfig } from './torn-chain-monitor.js';
import { chainNotifySettings, DEFAULT_CHAIN_NOTIFY } from './torn-chain-notifications.js';

export function usersConfig(input, previous = {}) {
  const keys = chainConfig({ ...input, minHits: 0, maxHits: null, intervalSeconds: 60, bonusHits: [], leaderFilter: 'all' }, { ...previous, bonusHits: [], leaderFilter: 'all' });
  const number = (field, fallback, min, max) => {
    const raw = input[field] ?? previous[field] ?? fallback, value = Number(raw);
    if (raw === '' || !Number.isFinite(value) || value < min || value > max) throw new Error(field === 'leadMinutes' ? '提前提醒须为 0.1–1440 分钟' : '扫描间隔须为 5–3600 秒');
    return value;
  };
  const leadMinutes = number('leadMinutes', 1, 0.1, 1440), intervalSeconds = number('intervalSeconds', 15, 5, 3600);
  const supplied = input.targets ?? previous.targets ?? [];
  const list = typeof supplied === 'string' ? supplied.split(/[\s,，;；]+/).filter(Boolean) : supplied;
  if (!Array.isArray(list) || list.length > 100) throw new Error('最多监控 100 名用户');
  const ids = new Set();
  const targets = list.map(value => {
    let raw = typeof value === 'object' && value ? value.id : value;
    if (typeof raw === 'string' && /^https:\/\//.test(raw)) {
      const url = new URL(raw);
      if (url.hostname !== 'www.torn.com' || url.pathname !== '/profiles.php') throw new Error('请使用 Torn profile 链接或数字 ID');
      raw = url.searchParams.get('XID');
    }
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0 || ids.has(id)) throw new Error('用户 ID 须为不重复的正整数');
    ids.add(id); return { id };
  });
  return { apiKey: keys.apiKey, apiKeys: keys.apiKeys, apiIntervalSeconds: keys.apiIntervalSeconds, leadMinutes, intervalSeconds, targets };
}

export function createUsersStore(db) {
  db.exec("CREATE TABLE IF NOT EXISTS torn_user_monitors(user_id TEXT PRIMARY KEY, config TEXT NOT NULL, notify TEXT NOT NULL, history TEXT NOT NULL DEFAULT '[]', seen TEXT NOT NULL DEFAULT '[]', observations TEXT NOT NULL DEFAULT '[]')");
  const get = uid => {
    db.prepare('INSERT OR IGNORE INTO torn_user_monitors(user_id,config,notify) VALUES(?,?,?)').run(uid, JSON.stringify(usersConfig({})), JSON.stringify(DEFAULT_CHAIN_NOTIFY));
    const row = db.prepare('SELECT * FROM torn_user_monitors WHERE user_id=?').get(uid);
    return Object.fromEntries(['config', 'notify', 'history', 'seen', 'observations'].map(key => [key, JSON.parse(row[key])]));
  };
  return {
    get,
    save(uid, input) { const config = usersConfig(input, get(uid).config); db.prepare('UPDATE torn_user_monitors SET config=? WHERE user_id=?').run(JSON.stringify(config), uid); },
    getNotify: uid => get(uid).notify,
    saveNotify(uid, input) { get(uid); db.prepare('UPDATE torn_user_monitors SET notify=? WHERE user_id=?').run(JSON.stringify(chainNotifySettings(input)), uid); },
    clear(uid) { get(uid); db.prepare("UPDATE torn_user_monitors SET history='[]' WHERE user_id=?").run(uid); },
    observe(uid, rows) { get(uid); db.prepare('UPDATE torn_user_monitors SET observations=? WHERE user_id=?').run(JSON.stringify(rows), uid); },
    record: db.transaction((uid, row) => {
      const data = get(uid), signature = row.id + ':' + row.hospitalUntil;
      if (data.seen.includes(signature)) return false;
      data.seen.push(signature); data.history.push({ ...row, notification: 'pending' });
      db.prepare('UPDATE torn_user_monitors SET history=?,seen=? WHERE user_id=?').run(JSON.stringify(data.history.slice(-200)), JSON.stringify(data.seen.slice(-10000)), uid);
      return true;
    }),
    delivered(uid, row, notification) {
      const data = get(uid), found = data.history.find(item => item.id === row.id && item.hospitalUntil === row.hospitalUntil);
      if (found) { found.notification = notification; db.prepare('UPDATE torn_user_monitors SET history=? WHERE user_id=?').run(JSON.stringify(data.history), uid); }
    }
  };
}

export class UsersMonitor extends ChainMonitor {
  constructor(options) {
    const request = (path, key, signal, policy) => options.request(path, key, signal, { ...policy, scope: 'users:' + options.uid });
    request.release = () => options.request.release?.('users:' + options.uid);
    super({ ...options, request });
    this.state.kind = 'users'; this.state.rows = this.store.get(this.uid).observations;
  }
  status() { return { ...super.status(), rows: this.state.rows.map(row => ({ ...row })), serverNow: this.now() }; }
  start() {
    if (this.running || this.busy) throw new Error('监控正在运行或停止中');
    if (!this.authorize()) throw new Error('无权启动用户监控');
    this.config = this.store.get(this.uid).config;
    if (!this.config.apiKeys.length || !this.config.targets.length) throw new Error('请先保存 API Keys 和监控用户');
    this.resetKeys(); this.running = true; this.controller = new AbortController(); this.state.notificationError = ''; this.promise = this.scan();
  }
  async scan() {
    if (!this.running || this.busy) return;
    this.busy = true; const signal = this.controller.signal;
    const check = () => { signal.throwIfAborted(); if (!this.running || !this.authorize()) throw Object.assign(new Error('监控已停止或权限已变更'), { fatal: true }); };
    this.state.rows = []; this.state.error = '';
    try {
      await this.prepareKeys(signal);
      for (const target of this.config.targets) {
        check();
        try {
          const { profile } = await this.api('user/' + target.id + '/profile', signal); check();
          if (profile?.id !== target.id || typeof profile.name !== 'string' || typeof profile.status?.state !== 'string') throw new Error('用户状态数据无效');
          const hospital = profile.status.state === 'Hospital', until = profile.status.until;
          if (hospital && (!Number.isSafeInteger(until) || until <= 0)) throw new Error('出院时间未知');
          const now = this.now(), row = { id: target.id, name: profile.name.slice(0, 120), status: profile.status.state, hospitalUntil: hospital ? until : null, checkedAt: now, reminderAt: hospital ? until - Math.round(this.config.leadMinutes * 60) : null };
          this.state.rows.push(row);
          if (hospital && until > now && now >= row.reminderAt) {
            const alert = { ...row, kind: 'user-hospital', leadMinutes: this.config.leadMinutes, remainingSeconds: until - now, detectedAt: now, link: 'https://www.torn.com/profiles.php?XID=' + target.id };
            if (this.store.record(this.uid, alert)) {
              try { const result = await this.notify(alert); this.store.delivered(this.uid, alert, result?.skipped ? 'disabled' : 'sent'); }
              catch { this.store.delivered(this.uid, alert, 'failed'); this.state.notificationError = '提醒记录已保存，通知失败；请检查通知管理（不自动重发）'; }
            }
          }
        } catch (error) {
          if (error.fatal || signal.aborted) throw error;
          this.state.rows.push({ id: target.id, status: 'unknown', error: this.safeError(error), checkedAt: this.now() });
        }
        this.store.observe(this.uid, this.state.rows);
      }
      this.state.rounds++; this.state.lastScanAt = this.now();
    } catch (error) {
      if (!signal.aborted) {
        this.state.error = this.safeError(error);
        // Invalid keys/permission changes cannot recover without configuration.
        // Rate limits and network failures retry next round using the shared cooldown.
        if (!this.keys?.length || !this.authorize()) this.stop();
      }
    } finally {
      this.busy = false;
      if (this.running && !signal.aborted && this.authorize()) {
        const now = this.now(), deadlines = this.state.rows.map(row => row.reminderAt).filter(at => Number.isFinite(at) && at > now);
        const seconds = Math.max(1, Math.min(this.config.intervalSeconds, ...deadlines.map(at => at - now)));
        this.state.nextScanAt = now + seconds;
        this.timer = this.schedule(() => { this.promise = this.scan(); }, seconds * 1000); this.timer?.unref?.();
      } else this.stop();
    }
  }
}
