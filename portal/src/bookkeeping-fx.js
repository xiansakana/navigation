import fs from 'node:fs';
import { createForeignExchangeService, FX_CURRENCIES } from '../../shared/foreign-exchange.js';

let service;
function getService() {
  if (!service) {
    let finnhubApiKey = '';
    try { finnhubApiKey = JSON.parse(fs.readFileSync(new URL('../../stock-manage/config.json', import.meta.url), 'utf8')).finnhubApiKey || ''; } catch { /* Public sources do not require a key. */ }
    service = createForeignExchangeService({ finnhubApiKey, requestOptions: { timeoutMs: 8000, retries: 0 } });
  }
  return service;
}
export function effectiveBookkeepingFx(settings, now = Date.now()) {
  const rates = { CNY: 1 }, quotes = { CNY: { rate: 1, source: 'fixed', stale: false } };
  for (const c of FX_CURRENCIES.filter(c => c !== 'CNY')) {
    const auto = settings.autoRates?.[c], manual = Number(settings.rates?.[c]);
    const validAuto = auto && Number.isFinite(auto.rate) && auto.rate > 0 && Number.isFinite(Date.parse(auto.fetchedAt));
    const stale = validAuto && (auto.stale === true || now - Date.parse(auto.fetchedAt) >= 3600000);
    if (validAuto && !stale) quotes[c] = { ...auto, stale: false, mode: 'automatic' };
    else if (Number.isFinite(manual) && manual > 0) quotes[c] = { rate: manual, source: 'manual', stale: false, mode: 'fallback' };
    else if (validAuto) quotes[c] = { ...auto, stale: true, mode: 'cached' };
    if (quotes[c]) rates[c] = quotes[c].rate;
  }
  return { rates, quotes };
}
export async function refreshBookkeepingFx(store, userId, fxService = getService()) {
  const result = await fxService.getRates();
  const quotes = { ...result.quotes };
  for (const [c, previous] of Object.entries(store.settings(userId).autoRates || {})) {
    if (!quotes[c]) quotes[c] = { ...previous, stale: true };
  }
  store.saveAutoRates(userId, quotes);
  return { ...effectiveBookkeepingFx(store.settings(userId)), errors: result.errors };
}
