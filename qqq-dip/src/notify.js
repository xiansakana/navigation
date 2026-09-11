import { DEFAULT_EVENTS } from './playbook.js';

export function sanitizeQqText(text) {
  return String(text).replace(/\$/g, '\uFF04');
}

function formatPct(value) {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

export function appendMarketSnapshot(text, stats, symbol = 'QQQ') {
  const price = Number.isFinite(stats?.price) ? stats.price.toFixed(2) : '—';
  const h = Number.isFinite(stats?.H) ? stats.H.toFixed(2) : '—';
  return `${text}\n行情：${symbol} 现价 ${price}｜当日涨跌幅 ${formatPct(stats?.changePercent)}｜相对 H 回撤 ${formatPct(stats?.drawdownLive)}（H ${h}）`;
}

export function normalizeQqTargets(qqOrNotify) {
  const qq = qqOrNotify?.qq || qqOrNotify || {};
  const fromNotify = Array.isArray(qqOrNotify?.targets) ? qqOrNotify.targets : null;
  const list = fromNotify || (Array.isArray(qq.targets) ? qq.targets : []);
  if (list.length) {
    return list.map((target) => ({
      id: target.id || (`t-${Math.random().toString(36).slice(2, 8)}`),
      type: target.type || 'group',
      groupId: String(target.groupId || '').trim(),
      atUserId: String(target.atUserId || '').trim(),
      userId: String(target.userId || '').trim()
    }));
  }
  if (qq.groupId || qq.userId) {
    return [{
      id: 'legacy',
      type: qq.type || (qq.userId && !qq.groupId ? 'private' : 'group'),
      groupId: String(qq.groupId || '').trim(),
      atUserId: String(qq.atUserId || '').trim(),
      userId: String(qq.userId || '').trim()
    }];
  }
  return [];
}

function buildQqPayload(qqConfig, text) {
  const payload = { message: sanitizeQqText(text) };
  if (qqConfig.type) payload.type = qqConfig.type;
  if (qqConfig.groupId) payload.groupId = String(qqConfig.groupId);
  if (qqConfig.userId) payload.userId = String(qqConfig.userId);
  if (qqConfig.atUserId) payload.atUserId = String(qqConfig.atUserId);
  return payload;
}

export function buildQqConfigs(notify) {
  if (!notify?.qq?.enabled) return [];
  const url = (notify.qq.url || '').trim();
  if (!url) return [];
  return normalizeQqTargets(notify).map((target) => ({
    enabled: true,
    url,
    token: notify.qq.token,
    type: target.type || 'group',
    groupId: target.groupId || '',
    userId: target.userId || '',
    atUserId: target.atUserId || ''
  })).filter((cfg) => (cfg.type === 'private' ? !!cfg.userId : !!cfg.groupId));
}

export function describeQqTarget(qqConfig) {
  if (qqConfig.type === 'private') return `私聊 ${qqConfig.userId}`;
  if (qqConfig.atUserId) return `群 ${qqConfig.groupId} @${qqConfig.atUserId}`;
  return `群 ${qqConfig.groupId}`;
}

export async function sendQqNotification(qqConfig, text) {
  if (!qqConfig?.enabled) return;
  const url = (qqConfig.url || '').trim();
  if (!url) return;
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (qqConfig.token) headers.Authorization = `Bearer ${qqConfig.token}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildQqPayload(qqConfig, text))
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`QQ 推送失败 (${resp.status}): ${body}`);
  }
}

export function eventAllowed(notify, eventKey) {
  const events = { ...DEFAULT_EVENTS, ...(notify?.events || {}) };
  return events[eventKey] !== false;
}

export async function notifyDipEvent(notify, eventKey, text) {
  if (!eventAllowed(notify, eventKey)) return { skipped: true };
  const configs = buildQqConfigs(notify);
  if (!configs.length) return { skipped: true, reason: 'no-targets' };
  const sent = [];
  const errors = [];
  for (const cfg of configs) {
    try {
      await sendQqNotification(cfg, `[抄底] ${text}`);
      sent.push(describeQqTarget(cfg));
    } catch (err) {
      errors.push(`${describeQqTarget(cfg)}: ${err.message}`);
    }
  }
  return { sent, errors };
}

export async function testDipNotify(notify) {
  if (!notify?.qq?.enabled) {
    throw new Error('请先启用 QQ 通知');
  }
  const configs = buildQqConfigs(notify);
  if (!configs.length) {
    throw new Error('请至少添加一个有效的 QQ 通知方式（群号或私聊 QQ 号）');
  }
  const text = '测试通知 - 抄底监控配置正常';
  const sent = [];
  const errors = [];
  for (const cfg of configs) {
    try {
      await sendQqNotification(cfg, `[抄底] ${text}`);
      sent.push(describeQqTarget(cfg));
    } catch (err) {
      errors.push(`${describeQqTarget(cfg)}: ${err.message}`);
    }
  }
  if (!sent.length) throw new Error(errors.join('；'));
  return { targets: sent, errors: errors.length ? errors : undefined };
}

export function maskNotifyForClient(notify) {
  const n = notify || {};
  return {
    desktop: n.desktop,
    qq: {
      enabled: n.qq?.enabled,
      url: n.qq?.url,
      hasToken: !!(n.qq?.token),
      token: n.qq?.token ? `***${n.qq.token.slice(-4)}` : ''
    },
    targets: n.targets || [],
    events: { ...DEFAULT_EVENTS, ...(n.events || {}) }
  };
}
