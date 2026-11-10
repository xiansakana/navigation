import { ChainMonitor } from './torn-chain-monitor.js';
import { chainNotifySettings, DEFAULT_CHAIN_NOTIFY } from './torn-chain-notifications.js';
export const COMPANY_ALERT_KINDS = ['salary', 'training', 'stock'];
export const COMPANY_RULES = { salary: { enabled: false, days: 3 }, training: { enabled: false, hours: 2 }, stock: { enabled: false, low: 5, high: 95 } };
export function companyRules(input = {}, previous = COMPANY_RULES) {
  const result = structuredClone(previous);
  for (const kind of COMPANY_ALERT_KINDS) if (input[kind]) {
    const rule = { ...result[kind], ...input[kind] };
    if (typeof rule.enabled !== 'boolean') throw new Error('请选择是否监控');
    const fields = kind === 'salary' ? ['days'] : kind === 'training' ? ['hours'] : ['low', 'high'];
    for (const field of fields) {
      const n = Number(rule[field]), max = kind === 'salary' ? 3650 : kind === 'training' ? 24 : 100;
      if (rule[field] === '' || rule[field] === null || !Number.isFinite(n) || n < 0 || n > max) throw new Error('提醒阈值无效');
      rule[field] = n;
    }
    if (kind === 'stock' && rule.low >= rule.high) throw new Error('库存下限必须小于上限');
    result[kind] = Object.fromEntries(['enabled', ...fields].map(k => [k, rule[k]]));
  }
  return result;
}
function knownWage(employee) {
  return Number.isSafeInteger(employee.wage) && employee.wage >= 0 ? employee.wage : null;
}

function trackSalaryReturns(saved, slot, fresh, data, now) {
  const pendingKey = slot + ':pending-wages';
  const pending = saved.runtime[pendingKey] || {};
  const employees = new Map(data.employees.map(employee => [employee.id, employee]));
  const returned = [];
  for (const [id, baseline] of Object.entries(pending)) {
    const employee = employees.get(Number(id));
    if (!employee || baseline.companyId !== data.profile.id ||
        (baseline.joinedAt != null && employee.joined_at != null && baseline.joinedAt !== employee.joined_at)) {
      delete pending[id];
      continue;
    }
    const activeAt = employee.last_action?.timestamp;
    if (!Number.isSafeInteger(activeAt) || activeAt <= baseline.lastActionAt ||
        activeAt < baseline.detectedAt || activeAt > now) continue;

    delete pending[id];
    const wage = knownWage(employee);
    if (wage === null || wage === baseline.wage) continue;
    returned.push({
      companyId: baseline.companyId, companyName: data.profile.name || baseline.companyName,
      employeeId: employee.id, name: employee.name, link: baseline.link,
      kind: baseline.kind, watcherId: baseline.watcherId, watcherLabel: baseline.watcherLabel,
      key: baseline.key + ':returned',
      detectedAt: now,
      lastActionAt: activeAt,
      previousWage: baseline.wage,
      wage,
      message: `员工 ${employee.name} [${id}] 已恢复活动，工资从 $${baseline.wage.toLocaleString('en-US')} 变为 $${wage.toLocaleString('en-US')}，请核对是否需要恢复原工资。\nhttps://www.torn.com/profiles.php?XID=${id}`
    });
  }
  for (const row of fresh) {
    if (row.wage !== null) pending[row.employeeId] = row;
  }
  saved.runtime[pendingKey] = pending;
  return returned;
}

export function companySignals(kind, rule, data, now) {
  const p = data.profile;
  if (!Number.isSafeInteger(p?.id) || p.id <= 0) throw new Error('API 未返回有效公司资料');
  const base = { companyId: p.id, companyName: p.name || String(p.id), link: 'https://www.torn.com/companies.php?step=profile&ID=' + p.id };
  if (kind === 'salary') {
    if (!Array.isArray(data.employees)) throw new Error('API 未返回员工资料');
    return data.employees.flatMap(e => {
      const ts = e.last_action?.timestamp;
      if (!Number.isSafeInteger(e.id) || !Number.isSafeInteger(ts) || ts <= 0 || ts > now) return [];
      return now - ts > rule.days * 86400 ? [{ ...base, key: 'salary:' + p.id + ':' + e.id + ':' + ts, employeeId: e.id, name: e.name, wage: knownWage(e), joinedAt: e.joined_at, lastActionAt: ts, offlineDays: (now - ts) / 86400, message: `员工 ${e.name} [${e.id}] 已离线 ${((now-ts)/86400).toFixed(1)} 天（阈值 ${rule.days} 天），请检查工资。\nhttps://www.torn.com/profiles.php?XID=${e.id}` }] : [];
    });
  }
  if (kind === 'training') {
    if (!Number.isInteger(p.trains) || p.trains < 0 || !Number.isInteger(p.rating) || p.rating < 0 || p.rating > 10) throw new Error('API 未返回训练次数或星级，请使用董事的 Limited Key');
    const date = new Date(now * 1000); date.setUTCHours(18, 0, 0, 0); if (date.getTime() / 1000 <= now) date.setUTCDate(date.getUTCDate() + 1);
    const settlement = date.getTime() / 1000, overflow = p.trains + p.rating - 20;
    return overflow > 0 && settlement - now <= rule.hours * 3600 ? [{ ...base, key: 'training:' + p.id + ':' + settlement, trains: p.trains, rating: p.rating, overflow, settlement, message: `${p.rating}★ · Trains: ${p.trains} / 20，预计结算新增 ${p.rating} 次，溢出 ${overflow} 次，请及时训练员工。\n预计结算：${date.toISOString()}（18:00 TCT）` }] : [];
  }
  if (!Array.isArray(data.stock)) throw new Error('API 未返回库存资料');
  if (!data.stock.length) return [];
  const capacity = p.upgrades?.storage_capacity;
  if (!Number.isSafeInteger(capacity) || capacity <= 0 || data.stock.some(s => !Number.isSafeInteger(s.in_stock) || s.in_stock < 0)) throw new Error('API 未返回有效仓库容量或现货库存');
  const total = data.stock.reduce((sum, s) => sum + s.in_stock, 0), percent = total / capacity * 100;
  const side = percent > rule.high ? 'high' : percent < rule.low ? 'low' : null;
  return side ? [{ ...base, key: 'stock:' + p.id + ':' + side, percent, total, capacity, side, message: `库存 ${total} / ${capacity}（${percent.toFixed(1)}%），${side === 'high' ? '超过上限 ' + rule.high : '低于下限 ' + rule.low}%，请检查单价、广告或补货。` }] : [];
}
export function createCompanyAlertsStore(db) {
  db.exec("CREATE TABLE IF NOT EXISTS torn_company_alerts(user_id TEXT PRIMARY KEY, config TEXT NOT NULL, runtime TEXT NOT NULL DEFAULT '{}', history TEXT NOT NULL DEFAULT '[]', notify TEXT NOT NULL DEFAULT '{}')");
  const get = uid => {
    if (!db.prepare('SELECT 1 FROM torn_company_alerts WHERE user_id=?').get(uid)) db.prepare('INSERT OR IGNORE INTO torn_company_alerts(user_id,config) VALUES(?,?)').run(uid, JSON.stringify({ rules: COMPANY_RULES, watchers: [], intervalSeconds: 60 }));
    const row = db.prepare('SELECT * FROM torn_company_alerts WHERE user_id=?').get(uid);
    return Object.fromEntries(['config', 'runtime', 'history', 'notify'].map(k => [k, JSON.parse(row[k])]));
  };
  return { get,
    save(uid, config) { get(uid); db.prepare('UPDATE torn_company_alerts SET config=? WHERE user_id=?').run(JSON.stringify(config), uid); },
    getNotify(uid, kind, watcherId) {
      const saved = get(uid).notify[kind] || structuredClone(DEFAULT_CHAIN_NOTIFY);
      const selected = watcherId && Object.hasOwn(saved.watchers || {}, watcherId) ? saved.watchers[watcherId] : saved;
      return { qq: selected.qq, slack: selected.slack, targets: selected.targets };
    },
    saveNotify(uid, kind, value, watcherId) {
      const n = get(uid).notify, settings = chainNotifySettings(value), old = n[kind] || structuredClone(DEFAULT_CHAIN_NOTIFY);
      n[kind] = watcherId ? { ...old, watchers: { ...old.watchers, [watcherId]: settings } } : { ...settings, watchers: old.watchers || {} };
      db.prepare('UPDATE torn_company_alerts SET notify=? WHERE user_id=?').run(JSON.stringify(n), uid);
    },
    commit: db.transaction((uid, slot, signals, kind, watcher, now, data) => {
      const saved = get(uid), old = new Set(saved.runtime[slot] || []);
      const fresh = signals.filter(r => !old.has(r.key)).map(r => ({ ...r, kind, watcherId: watcher.id, watcherLabel: watcher.label, detectedAt: now }));
      // Training and salary keys persist across temporary recovery, restarts and setting changes.
      saved.runtime[slot] = kind === 'stock' ? signals.map(r => r.key) : [...new Set([...old, ...signals.map(r => r.key)])].slice(-10000);
      if (kind === 'salary' && data) fresh.unshift(...trackSalaryReturns(saved, slot, fresh, data, now));
      saved.history.push(...fresh); db.prepare('UPDATE torn_company_alerts SET runtime=?,history=? WHERE user_id=?').run(JSON.stringify(saved.runtime), JSON.stringify(saved.history.slice(-200)), uid);
      return fresh;
    }).immediate
  };
}
export class CompanyAlertsMonitor extends ChainMonitor {
  constructor(options) {
    const request = (path, key, signal, policy) => options.request(path, key, signal, { ...policy, scope: 'company-alerts:' + options.uid });
    request.release = () => options.request.release?.('company-alerts:' + options.uid);
    super({ ...options, request }); this.authorizeKind = options.authorizeKind || (() => true); this.state.rows = [];
  }
  start() {
    if (this.running || this.busy) throw new Error('监控正在运行或停止中');
    if (!this.authorize()) throw new Error('无权启动');
    this.config = this.store.get(this.uid).config;
    this.config.apiKeys = this.config.watchers.map(w => w.apiKey);
    if (!this.config.watchers.length) throw new Error('请先选择公司账号并保存');
    this.running = true; this.controller = new AbortController(); this.promise = this.scan();
  }
  async scan() {
    if (!this.running || this.busy) return;
    this.busy = true; const signal = this.controller.signal;
    const check = () => { signal.throwIfAborted(); if (!this.running || !this.authorize()) throw new Error('监控已停止或权限已变更'); };
    this.state.rows = []; this.state.error = '';
    try {
      for (const watcher of this.config.watchers) {
        let profile;
        for (const kind of COMPANY_ALERT_KINDS) {
          const rule = this.config.rules[kind]; if (!rule.enabled || !this.authorizeKind(kind)) continue;
          try {
            check();
            const request = path => this.requestWithRetry(path, watcher.apiKey, signal);
            profile ||= (await request('company/profile')).profile;
            const data = { profile };
            if (kind === 'salary') data.employees = (await request('company/employees')).employees;
            if (kind === 'stock') data.stock = (await request('company/stock')).stock;
            check(); const signals = companySignals(kind, rule, data, this.now());
            const fresh = this.store.commit(this.uid, watcher.id + ':' + kind, signals, kind, watcher, this.now(), data);
            for (const row of fresh) { check(); try { await this.notify(row); } catch { this.state.notificationError = '提醒已记录，投递失败；请检查通知管理（不自动重发）'; } }
            this.state.rows.push({ kind, watcherId: watcher.id, label: watcher.label, companyName: profile.name, matches: signals.length, checkedAt: this.now(), ...(kind === 'training' ? { trains: profile.trains, rating: profile.rating } : {}) });
          } catch (e) { if (signal.aborted) throw e; this.state.rows.push({ kind, watcherId: watcher.id, error: this.safeError(e) }); }
        }
      }
      this.state.rounds++; this.state.lastScanAt = this.now();
    } catch (e) { if (!signal.aborted) this.state.error = this.safeError(e); }
    finally {
      this.busy = false;
      if (this.running && !signal.aborted && this.authorize()) { this.state.nextScanAt = this.now() + this.config.intervalSeconds; this.timer = this.schedule(() => { this.promise = this.scan(); }, this.config.intervalSeconds * 1000); this.timer?.unref?.(); } else this.stop();
    }
  }
  stop() { super.stop(); this.request.release?.('company-alerts:' + this.uid); }
}
