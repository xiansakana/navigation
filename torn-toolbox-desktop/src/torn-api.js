import { API_DELAY_MS, RATE_LIMIT_RETRIES, WEAV3R_MARKETPLACE_URL, sleep, toNumber } from './utils.js';

function isRateLimitError(data) {
    if (!data || !data.error) return false;
    return data.error.code === 5 || String(data.error.error || '').toLowerCase().includes('too many');
}

function apiErrorMessage(data) {
    if (!data || !data.error) return 'API 返回错误';
    return typeof data.error === 'object' ? (data.error.error || 'API 返回错误') : String(data.error);
}

export async function fetchJsonWithRetry(url, onWait) {
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
    var resp = await fetch(WEAV3R_MARKETPLACE_URL + itemId + '?limit=100', {
        headers: { Accept: 'application/json' }
    });
    if (!resp.ok) throw new Error('Weav3r 巴扎 API 请求失败 (' + resp.status + ')');
    var data = await resp.json();
    var listings = data.listings || [];
    var best = null;
    listings.forEach(function(row) {
        if (myPlayerId && toNumber(row.player_id) === myPlayerId) return;
        var price = toNumber(row.price);
        if (!price) return;
        if (!best || price < best.price) {
            best = {
                price: price,
                playerId: toNumber(row.player_id),
                playerName: row.player_name || '未知'
            };
        }
    });
    cache[itemId] = best;
    return best;
}

export async function fetchMarketLowestPrice(apiKey, itemId, cache) {
    if (cache[itemId] !== undefined) return cache[itemId];
    var data = await fetchJsonWithRetry(
        'https://api.torn.com/v2/market/' + itemId + '/itemmarket?key=' + encodeURIComponent(apiKey)
    );
    var listings = (data.itemmarket && data.itemmarket.listings) || [];
    var lowest = listings.length ? listings.reduce(function(min, row) {
        var price = toNumber(row.price);
        return min === null || price < min ? price : min;
    }, null) : null;
    cache[itemId] = lowest;
    return lowest;
}

export async function fetchCompanyApplications(apiKey) {
    var data = await fetchJsonWithRetry(
        'https://api.torn.com/company/?selections=applications&key=' + encodeURIComponent(apiKey)
    );
    return data.applications || {};
}
