import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getStatus } from './napcat.js';
import { getDatabase } from '../../shared/db/connection.js';

const execFileAsync = promisify(execFile);
export function createWatchdogStore(db) {
  db.exec('CREATE TABLE IF NOT EXISTS notification_service_health (id TEXT PRIMARY KEY, state_json TEXT NOT NULL)');
  return {
    read() { const row = db.prepare('SELECT state_json FROM notification_service_health WHERE id=?').get('qq-login'); return row ? JSON.parse(row.state_json) : {}; },
    write(state) { db.prepare('INSERT INTO notification_service_health(id,state_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json').run('qq-login', JSON.stringify(state)); }
  };
}

export function loginAlertChannels(config) {
  return ['slack', 'email'].map(id => {
    const c = config.channels?.[id] || {};
    const configured = id === 'slack' ? !!c.webhookUrl : !!(c.smtp?.host && c.to && (c.from || c.smtp?.user));
    return { id, enabled: c.enabled === true, configured, ready: c.enabled === true && configured };
  });
}

export function startLoginWatchdog(configOrGetter, hooks = {}) {
  const getConfig = typeof configOrGetter === 'function' ? configOrGetter : () => configOrGetter;
  const initial = getConfig().napcat?.watchdog || {};
  if (initial.enabled !== true) return null;
  const opts = {
    intervalMs: Number(initial.intervalMs) > 0 ? Number(initial.intervalMs) : 60000,
    failBeforeRestart: Number(initial.failBeforeRestart) > 0 ? Number(initial.failBeforeRestart) : 2,
    cooldownMs: Number(initial.cooldownMs) > 0 ? Number(initial.cooldownMs) : 600000,
    settleMs: Number(initial.settleMs) > 0 ? Number(initial.settleMs) : 45000
  };
  const store = hooks.store || createWatchdogStore(getDatabase());
  const now = hooks.now || Date.now;
  const state = { failCount: 0, lastRestartAt: null, incident: null, events: [], ...store.read() };
  let inFlight = false, stopped = false, timer, startup;
  const persist = () => store.write(state);
  function event(kind) {
    const incident = state.incident;
    if (state.events.some(e => e.incidentId === incident.id && e.kind === kind)) return;
    state.events.push({ incidentId: incident.id, kind, at: now(), sent: [], nextAttemptAt: 0 });
    state.events = state.events.slice(-20); persist();
  }
  async function deliverAlerts() {
    const channels = loginAlertChannels(getConfig()).filter(c => c.ready);
    for (const e of state.events) {
      if (e.nextAttemptAt > now()) continue;
      // Recovery notices replace stale offline alarms which never reached a channel.
      if (e.kind !== 'recovered' && state.events.some(other => other.incidentId === e.incidentId && other.kind === 'recovered')) continue;
      const labels = { offline: 'QQ 账号掉线告警', recovery_failed: 'QQ 自动恢复失败', recovered: 'QQ 账号已恢复在线' };
      const message = [labels[e.kind], '时间：' + new Date(e.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
        '事件：' + e.incidentId,
        e.kind === 'recovered' ? '已确认 QQ 账号在线，QQ 消息收发可继续。' : 'QQ 消息收发不可用，QQ 记账和 QQ 通知受影响。正在按冷却策略尝试自动登录；若仍失败，请检查 NapCat 并重新扫码。',
        '此告警通过独立渠道发送，不依赖 QQ。'].join('\n');
      await Promise.all(channels.filter(c => !e.sent.includes(c.id)).map(async c => {
        try {
          if (!hooks.send) throw new Error('missing sender');
          await hooks.send(c.id, message, { subject: labels[e.kind] });
          e.sent.push(c.id); persist();
        } catch { state.alertError = '部分独立告警渠道投递失败，将于 5 分钟后重试'; }
      }));
      e.nextAttemptAt = now() + 300000; persist();
    }
    const pending = state.events.some(e => !(e.kind !== 'recovered' && state.events.some(other => other.incidentId === e.incidentId && other.kind === 'recovered')) && channels.some(c => !e.sent.includes(c.id)));
    if (channels.length && !pending) state.alertError = '';
  }
  async function tick() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const config = getConfig();
      if (config.napcat?.watchdog?.enabled !== true) return;
      if (state.lastRestartAt !== null && now() - state.lastRestartAt < opts.settleMs) return;
      try {
        const data = await (hooks.getStatus || getStatus)(config.napcat.baseUrl, config.napcat.accessToken || '');
        const status = data?.data || data || {};
        state.reachable = true;
        // good describes the OneBot service, never the QQ login session.
        state.online = status.online === true;
        state.lastError = state.online ? '' : 'QQ 账号离线或登录已失效';
      } catch {
        state.reachable = false; state.online = false; state.lastError = '无法读取 NapCat QQ 登录状态';
      }
      state.lastCheckedAt = new Date(now()).toISOString();
      if (state.online) {
        state.failCount = 0;
        if (state.incident && !state.incident.recoveredAt) { state.incident.recoveredAt = now(); event('recovered'); }
      } else {
        state.failCount++;
        if (state.failCount >= opts.failBeforeRestart) {
          if (!state.incident || state.incident.recoveredAt) state.incident = { id: 'qq-' + now(), startedAt: now(), recoveredAt: null };
          event('offline');
          if (state.lastRestartAt !== null && state.lastRestartAt >= state.incident.startedAt) event('recovery_failed');
        }
      }
      persist();
      await deliverAlerts();
      if (stopped || state.online || state.failCount < opts.failBeforeRestart) return;
      if (state.lastRestartAt !== null && now() - state.lastRestartAt < opts.cooldownMs) return;
      state.lastRestartAt = now(); persist();
      try {
        const configured = config.napcat.watchdog.restartCommand;
        const command = Array.isArray(configured) && configured.length ? configured.map(String) : ['docker', 'restart', 'napcat'];
        if (hooks.restart) await hooks.restart(command);
        else await execFileAsync(command[0], command.slice(1), { timeout: 60000 });
        state.failCount = 0;
      } catch { state.lastError = 'NapCat 自动重启失败'; event('recovery_failed'); await deliverAlerts(); }
      persist();
    } finally { inFlight = false; }
  }
  if (hooks.schedule !== false) {
    const safeTick = () => { void tick().catch(() => { console.warn('[watchdog] 状态检查或持久化失败'); }); };
    timer = setInterval(safeTick, opts.intervalMs); timer.unref?.();
    startup = setTimeout(safeTick, 15000); startup.unref?.();
  }
  return {
    tick,
    status() { return { enabled: true, online: state.online ?? null, reachable: state.reachable ?? null, lastCheckedAt: state.lastCheckedAt || null, lastError: state.lastError || '', lastRestartAt: state.lastRestartAt, incident: state.incident, alertError: state.alertError || '', alertChannels: loginAlertChannels(getConfig()), events: state.events.map(({ kind, at, sent }) => ({ kind, at, sent })) }; },
    stop() { stopped = true; clearInterval(timer); clearTimeout(startup); }
  };
}
