import { API_DELAY_MS, RATE_LIMIT_RETRIES, WEAV3R_MARKETPLACE_URL, sleep, toNumber } from './utils.js';

// Installed only by the unified worker. Standalone desktop servers keep their existing client.
let workerRequest, workerBazaar, workerSignal;
export function installWorkerApi(request, bazaar, signal) { workerRequest = request; workerBazaar = bazaar; workerSignal = signal; }

function isRateLimitError(data) {
    if (!data || !data.error) return false;
    return data.error.code === 5 || String(data.error.error || '').toLowerCase().includes('too many');
}

function apiErrorMessage(data) {
    if (!data || !data.error) return 'API 返回错误';
    return typeof data.error === 'object' ? (data.error.error || 'API 返回错误') : String(data.error);
}

export async function fetchJsonWithRetry(url, onWait) {
    if (workerRequest) {
        const parsed = new URL(url), key = parsed.searchParams.get('key');
        parsed.searchParams.delete('key');
        for (let attempt = 0; ; attempt++) {
            try { return await workerRequest(parsed.href, key, workerSignal, { scope: 'legacy-toolbox', spacingMs: 2000 }); }
            catch (error) {
                if (workerSignal?.aborted) throw error;
                const limited = error.apiCode === 5 || error.rateLimited;
                if (attempt >= 3 || (!limited && !error.transient)) throw error;
                const ms = limited ? Math.max(65000 * 2 ** attempt, error.retryAfterMs || 0) : 10000 * 2 ** attempt;
                onWait?.(ms, attempt + 1);
                const { setTimeout } = await import('node:timers/promises');
                await setTimeout(ms, undefined, { signal: workerSignal });
            }
        }
    }
    var attempt = 0;
    while (true) {
        var resp = await fetch(url);
        var data = await resp.json();
        if (isRateLimitError(data)) {
            attempt++;
            if (attempt > RATE_LIMIT_RETRIES) throw new Error(apiErrorMessage(data));
            var waitMs = 5000 * attempt;
            if (onWait) onWait(waitMs, attempt);
            await sleep(waitMs);
            continue;
        }
        if (data.error) throw new Error(apiErrorMessage(data));
        return data;
    }
}

export async function fetchItems(apiKey) {
    var data = await fetchJsonWithRetry(
        'https://api.torn.com/v2/torn/items?key=' + encodeURIComponent(apiKey)
    );
    return data.items || {};
}

export async function fetchUserBazaar(apiKey) {
    var data = await fetchJsonWithRetry(
        'https://api.torn.com/v2/user/bazaar?key=' + encodeURIComponent(apiKey)
    );
    return data.bazaar || [];
}

export async function fetchUserItemMarket(apiKey) {
    var all = [], offset = 0, limit = 100;
    while (true) {
        var url = 'https://api.torn.com/v2/user/itemmarket?key=' + encodeURIComponent(apiKey)
            + '&limit=' + limit + '&offset=' + offset;
        var data = await fetchJsonWithRetry(url);
        var rows = data.itemmarket || [];
        all = all.concat(rows);
        if (rows.length < limit) break;
        offset += limit;
        await sleep(API_DELAY_MS);
    }
    return all;
}

export async function fetchMyPlayerId(apiKey, cache) {
    if (cache.playerId) return cache.playerId;
    var data = await fetchJsonWithRetry(
        'https://api.torn.com/v2/user/basic?key=' + encodeURIComponent(apiKey)
    );
    var id = toNumber(data.player_id || (data.profile && data.profile.id));
    if (!id) throw new Error('无法获取玩家 ID');
    cache.playerId = id;
    return id;
}

export async function fetchWeav3rBazaarLowest(itemId, myPlayerId, cache) {
    if (cache[itemId] !== undefined) return cache[itemId];
    var resp = workerBazaar ? null : await fetch(WEAV3R_MARKETPLACE_URL + itemId + '?limit=100', {
        headers: { Accept: 'application/json' }
    });
    if (resp && !resp.ok) throw new Error('Weav3r 巴扎 API 请求失败 (' + resp.status + ')');
    var data = workerBazaar ? { listings: await workerBazaar(itemId, workerSignal) } : await resp.json();
    var listings = data.listings || [];
    var best = null;
    listings.forEach(function(row) {
        if (myPlayerId && toNumber(row.player_id) === myPlayerId) return;
        var price = toNumber(row.price);
        if (!price) return;
        if (!best || price < best.price) {
            best = {
                price: price,
                quantity: row.quantity ?? null,
                playerId: toNumber(row.player_id),
                playerName: row.player_name || '未知'
            };
        }
    });
    cache[itemId] = best;
    return best;
}

// Stackable market rows are anonymous price/quantity aggregates, not seller rows.
// Reconcile against every own listing of this item, including lower-priced lots.
export function marketLowestCompetitor(rows, ownRows = [], metadata = {}) {
    const ownUids = new Set(), ownAmounts = new Map();
    for (const row of ownRows) {
        const uid = row.item?.uid;
        if (uid != null && String(uid) !== '0') ownUids.add(String(uid));
        else {
            const price = toNumber(row.price), amount = toNumber(row.amount);
            if (price > 0 && amount > 0) ownAmounts.set(price, (ownAmounts.get(price) || 0) + amount);
        }
    }
    const totals = new Map();
    for (const row of rows) if (row.item_details?.uid == null && Number.isSafeInteger(toNumber(row.amount)) && toNumber(row.amount) > 0) totals.set(toNumber(row.price), (totals.get(toNumber(row.price)) || 0) + toNumber(row.amount));
    const coveredOwnListings = ownRows.filter(own => {
        const uid = own.item?.uid, price = toNumber(own.price);
        return uid != null && String(uid) !== '0'
            ? rows.some(row => row.item_details?.uid != null && String(row.item_details.uid) === String(uid) && toNumber(row.price) === price)
            : ownAmounts.has(price) && (totals.get(price) || 0) >= ownAmounts.get(price);
    }).map(row => String(row.id));
    let best = null;
    for (const row of rows) {
        const price = toNumber(row.price), uid = row.item_details?.uid;
        if (!Number.isSafeInteger(price) || price <= 0 || uid != null && ownUids.has(String(uid))) continue;
        let quantity = row.amount == null ? null : toNumber(row.amount);
        if (quantity !== null && (!Number.isSafeInteger(quantity) || quantity <= 0)) continue;
        if (uid == null && ownAmounts.has(price)) {
            // Consume the budget once across all public rows at the same price.
            // Unknown public quantities cannot prove that competitors remain.
            if (quantity === null) continue;
            const own = Math.min(quantity, ownAmounts.get(price));
            ownAmounts.set(price, ownAmounts.get(price) - own); quantity -= own;
            if (quantity <= 0) continue;
        }
        if (!best || price < best.price) best = { price, quantity };
        else if (price === best.price) best.quantity = best.quantity === null || quantity === null ? null : best.quantity + quantity;
    }
    return best && { ...best, coveredOwnListings, cacheTimestamp: Number.isSafeInteger(metadata.cache_timestamp) ? metadata.cache_timestamp : null, cacheDelay: Number(metadata.cache_delay) || 0 };
}
export async function fetchMarketLowestListing(apiKey, itemId, cache, ownRows = []) {
    if (cache[itemId] !== undefined) return cache[itemId];
    var data = await fetchJsonWithRetry(
        'https://api.torn.com/v2/market/' + itemId + '/itemmarket?key=' + encodeURIComponent(apiKey) + '&limit=100&sort=ASC'
    );
    if (!Array.isArray(data.itemmarket?.listings)) throw new Error('市场挂单数据无效');
    const lowest = marketLowestCompetitor(data.itemmarket.listings, ownRows, data.itemmarket);
    cache[itemId] = lowest;
    return lowest;
}

export async function fetchCompanyApplications(apiKey) {
    var data = await fetchJsonWithRetry(
        'https://api.torn.com/company/?selections=applications&key=' + encodeURIComponent(apiKey)
    );
    return data.applications || {};
}
