import { DEFAULT_EVENTS } from './playbook.js';

function formatPct(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

// The monitor owns market context only. The notification hub owns rules and delivery.
export function appendMarketSnapshot(text, stats, symbol = 'QQQ') {
  const price = Number.isFinite(stats?.price) ? stats.price.toFixed(3) : '—';
  const h = Number.isFinite(stats?.H) ? stats.H.toFixed(3) : '—';
  return `${text}\n行情：${symbol} 现价 ${price}｜当日涨跌幅 ${formatPct(stats?.changePercent)}｜相对 H 回撤 ${formatPct(stats?.drawdownLive)}（H ${h}）`;
}

// Legacy snapshot remains read-only for one-time import by notification management.
export function maskNotifyForClient(notify) {
  const n = notify || {};
  return {
    desktop: n.desktop,
    qq: {
      enabled: n.qq?.enabled,
      url: n.qq?.url,
      hasToken: !!n.qq?.token,
      token: n.qq?.token ? `***${n.qq.token.slice(-4)}` : ''
    },
    slack: { enabled: n.slack?.enabled === true },
    targets: n.targets || [],
    events: { ...DEFAULT_EVENTS, ...(n.events || {}) }
  };
}
