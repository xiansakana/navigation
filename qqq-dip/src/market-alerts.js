import { buildBuyPreview } from './playbook.js';
import { cnMarketStatus } from './cn-market-hours.js';
import { isRth } from './market-hours.js';

export function alertMarketOpen(market, now = new Date()) {
  return market === 'CN' ? cnMarketStatus(now).open : isRth(now);
}

function symbolMarket(symbol) {
  return /^\d{6}$/.test(String(symbol || '')) ? 'CN' : 'US';
}

// Signal confirmation is independent of when each instrument can be traded.
// Route from actual plan legs, rather than from the QQQ signal's symbol.
export function marketAlertRoutes(ev, round, alert, now = new Date()) {
  const tierId = alert.event === 'T4_intraday' ? 'T4' : alert.event;
  const tier = ev.tiers?.find((row) => row.id === tierId);
  if (tier) {
    if (ev.reset || ev.fakeRight || ev.sameDaySkip?.includes(tierId)
      || tier.status !== 'confirmed') return [];
    const plan = round.executionPlans?.[tierId];
    if (plan?.cancelled || plan?.inFlight) return [];
    const preview = plan || buildBuyPreview({ ...ev, primary: { ...ev.primary, tier: tierId } }, ev.suggestedContracts);
    const legs = (preview.legs || []).filter((leg) => !leg.complete && !leg.pendingOption && !leg.skipped
      && (leg.kind !== 'call' || !tier.vxnGate?.blocked)
      && Number(leg.currency === 'CNY' ? leg.cny : leg.usd) > Number(leg.spent || 0));
    return (alert.optionReady ? ['US'] : ['CN', 'US']).flatMap((market) => {
      const matched = legs.filter((leg) => (leg.currency === 'CNY' ? 'CN' : 'US') === market);
      return matched.length ? [{ market, symbols: [...new Set(matched.map((leg) => leg.symbol))] }] : [];
    });
  }
  const lot = ev.lots?.find((row) => alert.key.startsWith(`${row.id}:`));
  if (alert.event === 'reset') {
    const markets = new Set((ev.lots || []).map((row) => symbolMarket(row.symbol)));
    if (!markets.size) markets.add('US');
    return [...markets].map((market) => ({ market, symbols: [] }));
  }
  return [{ market: symbolMarket(lot?.symbol || alert.symbol), symbols: [lot?.symbol || alert.symbol || 'QQQ'] }];
}

// Preserve recent legacy deliveries made in the correct trading session. An
// off-hours delivery must not consume either market's execution reminder.
export function migrateMarketDeliveries(round, alerts, actions, now = new Date()) {
  if (round.marketDeliveryVersion) return;
  round.marketDeliveries = { ...round.marketDeliveries };
  for (const alert of alerts) {
    const firedAt = round.firedAlerts?.[alert.key];
    if (!firedAt) continue;
    const rows = actions.filter((a) => a.type === 'notify' && a.tier === alert.event
      && (!a.payload?.key || a.payload.key === alert.key)
      && Date.parse(a.ts) >= Date.parse(firedAt) - 10000);
    for (const market of ['CN', 'US']) {
      const sent = rows.find((a) => a.payload?.reason === 'event-disabled'
        || (a.payload?.sent?.length && alertMarketOpen(market, new Date(a.ts))));
      if (sent || now.getTime() - Date.parse(firedAt) > 7 * 86400000) {
        round.marketDeliveries[`${alert.key}:${market}`] = sent?.ts || firedAt;
      }
    }
  }
  round.marketDeliveryVersion = 1;
}
