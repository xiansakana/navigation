import { readJson, sameOriginWrite } from '../../shared/http.js';
import { getDatabase } from '../../shared/db/index.js';
import { hasPermission } from './rbac.js';
import { resolveSessionUser } from './auth.js';
import { integrationConfig } from '../../shared/runtime-config.js';
import { loadServiceConfig } from '../../torn-toolbox-desktop/src/config.js';
import { normalizeCompanyWatchers } from '../../torn-toolbox-desktop/src/watchers.js';
import { portalTornRequest } from './torn-chain-monitor.js';
import { createChainNotifier } from './torn-chain-notifications.js';
import { COMPANY_ALERT_KINDS, companyRules, createCompanyAlertsStore, CompanyAlertsMonitor } from './torn-company-alerts-monitor.js';
const names = { salary: '扣工资', training: '员工训练', stock: '库存' };
export function canCompanyAlerts(s, action = 'view') { return !!s?.userId && (!s.isGuest || action.endsWith('view')) && hasPermission(s.dataAccess?.permissions || s.permissions || [], 'torn-company-alerts:' + action); }
export function createCompanyAlertsService({ store, request = portalTornRequest, roster, authorize, notify }) {
  const monitors = new Map();
  const monitor = uid => { if (!monitors.has(uid)) monitors.set(uid, new CompanyAlertsMonitor({ uid, store, request, authorize: () => authorize(uid, 'control:edit'), authorizeKind: kind => authorize(uid, kind + ':view'), notify: row => authorize(uid, row.kind + ':view') && authorize(uid, row.kind + ':notify:edit') ? notify(store.getNotify(uid, row.kind), row) : { skipped: true } })); return monitors.get(uid); };
  return { monitors, async handle(req, res, url, s, json) {
    res.setHeader('Cache-Control', 'no-store'); const uid = s.userId;
    if (!canCompanyAlerts(s)) return json(res, 403, { ok: false, error: '无权访问公司提醒' });
    if (!sameOriginWrite(req)) return json(res, 403, { ok: false, error: '不允许跨站操作' });
    const parts = url.pathname.slice('/api/torn-company-alerts/'.length).split('/'), kind = COMPANY_ALERT_KINDS.includes(parts[0]) ? parts.shift() : null, action = parts.join('/');
    const deny = () => json(res, 403, { ok: false, error: '无权执行此操作' });
    try {
      if (kind && !canCompanyAlerts(s, kind + ':view')) return deny();
      if (action.startsWith('notifications')) {
        if (!kind || !canCompanyAlerts(s, kind + ':notify:view')) return deny();
        if (req.method === 'GET' && action === 'notifications') return json(res, 200, { ok: true, settings: store.getNotify(uid, kind), permissions: { save: canCompanyAlerts(s, kind + ':notify:edit'), test: canCompanyAlerts(s, kind + ':notify:test:edit') } });
        if (req.method === 'PUT' && action === 'notifications') { if (!canCompanyAlerts(s, kind + ':notify:edit')) return deny(); store.saveNotify(uid, kind, await readJson(req, 16384)); return json(res, 200, { ok: true, settings: store.getNotify(uid, kind) }); }
        if (req.method === 'POST' && action === 'notifications/test') { if (!canCompanyAlerts(s, kind + ':notify:test:edit')) return deny(); const row = { kind, message: '测试通知 · 配置正常', companyName: names[kind], link: 'https://www.torn.com/companies.php' }; const result = await notify(store.getNotify(uid, kind), row); if (!result?.sent) throw new Error('未启用可用通知渠道'); return json(res, 200, { ok: true, result }); }
        return deny();
      }
      if (action === 'state' && req.method === 'GET') {
        const saved = store.get(uid), visible = COMPANY_ALERT_KINDS.filter(k => canCompanyAlerts(s, k + ':view'));
        const current = monitor(uid).status();
        return json(res, 200, { ok: true, config: { intervalSeconds: saved.config.intervalSeconds, rules: Object.fromEntries(visible.map(k => [k, saved.config.rules[k]])), watcherIds: saved.config.watchers.map(w => w.id) }, roster: roster().map(w => ({ id: w.id, label: w.label })), state: { ...current, rows: current.rows.filter(r => visible.includes(r.kind)) }, history: saved.history.filter(r => visible.includes(r.kind)).reverse(), permissions: { accounts: hasPermission(s.dataAccess?.permissions || s.permissions || [], 'service:torn-company:edit'), control: canCompanyAlerts(s, 'control:edit'), configure: canCompanyAlerts(s, 'config:edit'), kinds: Object.fromEntries(visible.map(k => [k, { view: true, edit: canCompanyAlerts(s, k + ':edit') }])) } });
      }
      if (action === 'config' && req.method === 'POST') {
        if (!canCompanyAlerts(s, 'config:edit')) return deny(); const body = await readJson(req, 16384), old = store.get(uid).config;
        for (const k of Object.keys(body.rules || {})) if (!COMPANY_ALERT_KINDS.includes(k) || !canCompanyAlerts(s, k + ':edit')) return deny();
        const rules = companyRules(body.rules, old.rules), intervalSeconds = Number(body.intervalSeconds ?? old.intervalSeconds);
        if (!Number.isInteger(intervalSeconds) || intervalSeconds < 30 || intervalSeconds > 3600) throw new Error('扫描间隔须为 30–3600 秒');
        let watchers = old.watchers;
        if (body.watcherIds !== undefined) {
          if (!hasPermission(s.dataAccess?.permissions || s.permissions || [], 'service:torn-company:edit')) return deny();
          if (!Array.isArray(body.watcherIds) || body.watcherIds.length > 20) throw new Error('最多选择 20 个公司账号');
          const source = roster(); watchers = [...new Set(body.watcherIds)].map(id => { const w = source.find(w => w.id === id); if (!w) throw new Error('公司账号不存在或未启用'); return { id: w.id, label: w.label, apiKey: w.apiKey }; });
        }
        const m = monitor(uid); m.stop(); await m.promise; store.save(uid, { rules, watchers, intervalSeconds }); return json(res, 200, { ok: true });
      }
      if (['start', 'stop'].includes(action) && req.method === 'POST') { if (!canCompanyAlerts(s, 'control:edit')) return deny(); monitor(uid)[action](); return json(res, 200, { ok: true }); }
      return json(res, 404, { ok: false, error: 'Not Found' });
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  } };
}
let service;
export const companyAlertJobs = () => service?.monitors || new Map();
export async function handleCompanyAlertsApi(req, res, url, session, json, config) {
  const authorize = (uid, action) => { const s = resolveSessionUser({ userId: uid }, config); return !!s && canCompanyAlerts({ userId: uid, permissions: s.permissions, isGuest: s.user.username === (config.auth?.guestUsername || 'guest') }) && s.rbac?.accessPolicy?.modules?.['torn-company-alerts']?.enabled !== false && canCompanyAlerts({ userId: uid, permissions: s.permissions, isGuest: s.user.username === (config.auth?.guestUsername || 'guest') }, action); };
  service ||= createCompanyAlertsService({ store: createCompanyAlertsStore(getDatabase()), authorize, roster: () => normalizeCompanyWatchers(loadServiceConfig('company')), notify: (settings, row) => createChainNotifier({ endpoint: config.services?.find(s => s.id === 'notifications')?.internalUrl || 'http://127.0.0.1:8787', token: integrationConfig().notifyToken })(settings, { ...row, kind: 'company-alert', message: `[Torn 公司 · ${names[row.kind]}] ${row.watcherLabel || ''} · ${row.companyName}\n${row.message}\n${row.link}` }) });
  return service.handle(req, res, url, session, json);
}
