import { EventEmitter } from 'node:events';
import { API_DELAY_MS, formatMoney, sleep } from './utils.js';
import {
    fetchMarketLowestListing,
    fetchMyPlayerId,
    fetchUserBazaar,
    fetchUserItemMarket,
    fetchWeav3rBazaarLowest
} from './torn-api.js';
import { publishBusinessEvent } from '../../shared/business-events.js';
import { normalizeUndercutWatchers } from './watchers.js';

export class UndercutMonitor extends EventEmitter {
    constructor(getConfig, dependencies = {}) {
        super();
        this.getConfig = getConfig;
        this.store = dependencies.store;
        this.now = dependencies.now || (() => Math.floor(Date.now() / 1000));
        this.scanTimeoutMs = dependencies.scanTimeoutMs || 600000;
        this.requestTimeoutMs = dependencies.requestTimeoutMs || 45000;
        this.lastScanError = '';
        this.timer = null;
        this.running = false;
        this.checking = false;
        this.checks = 0;
        this.alerts = 0;
        this.applications = [];
        this.nextScanAt = null;
        this.statusMessage = '';
        this.watcherStates = new Map();
    }

    ensureWatcherState(id) {
        if (!this.watcherStates.has(id)) {
            const watcher = this.getWatchers().find(w => w.id === id);
            const saved = watcher && this.store?.load(watcher);
            this.watcherStates.set(id, {
                playerCache: {},
                pendingMarket: new Map(saved?.pendingMarket || []),
                activeKeys: new Set(saved?.activeKeys || []),
                alertMap: new Map(saved?.alerts || []),
                checks: 0,
                alerts: 0,
                lastError: ''
            });
        }
        return this.watcherStates.get(id);
    }

    getWatchers() {
        return normalizeUndercutWatchers(this.getConfig());
    }

    getAllAlerts() {
        var list = [];
        this.watcherStates.forEach(function(state, watcherId) {
            state.alertMap.forEach(function(alert) {
                list.push({ ...alert, watcherId: watcherId });
            });
        });
        list.sort(function(a, b) { return (b.detectedAt || 0) - (a.detectedAt || 0); });
        return list.slice(0, 100);
    }

    getState() {
        var watchers = this.getWatchers().map(function(w) {
            var st = this.watcherStates.get(w.id) || {};
            return {
                id: w.id,
                label: w.label,
                checks: st.checks || 0,
                alerts: st.alerts || 0,
                lastError: st.lastError || ''
            };
        }.bind(this));
        return {
            running: this.running,
            checking: this.checking,
            scanStartedAt: this.scanStartedAt || null,
            lastScanFinishedAt: this.lastScanFinishedAt || null,
            lastScanError: this.lastScanError,
            checks: this.checks,
            alerts: this.alerts,
            nextScanAt: this.nextScanAt,
            statusMessage: this.statusMessage,
            alertsList: this.getAllAlerts(),
            watchers: watchers
        };
    }

    start() {
        if (this.running) return;
        if (!this.getWatchers().length) {
            throw new Error('请至少添加一个监听账号并填写 API Key');
        }
        this.running = true;
        if (!this.checking) this.runScheduledScan();
    }

    runScheduledScan() {
        this.runOnce().catch(error => this.emit('error', error.message));
    }

    stop() {
        this.running = false;
        this.scanController?.abort(new Error('扫描已停止'));
        clearTimeout(this.timer);
        this.timer = null;
        this.nextScanAt = null;
        this.statusMessage = '';
        this.emit('state', this.getState());
    }

    scheduleNext() {
        clearTimeout(this.timer);
        const interval = Math.max(30, Number(this.getConfig().undercut?.intervalSeconds) || 60);
        const delay = Math.max(interval * 1000, (this.retryNotBefore || 0) - Date.now());
        this.nextScanAt = Date.now() + delay;
        this.timer = setTimeout(() => this.runScheduledScan(), delay);
        this.timer.unref?.();
        this.emit('state', this.getState());
    }

    buildAlertText(alert) {
        var tag = alert.source === 'Bazaar' ? '[Bazaar]' : '[Item Market]';
        var prefix = alert.watcherLabel ? '[' + alert.watcherLabel + '] ' : '';
        var quantity = alert.undercutQuantity == null ? '未知' : Number(alert.undercutQuantity).toLocaleString('en-US') + ' 件';
        prefix += '压价挂单数量：' + quantity + ' · ';
        if (alert.source === 'Bazaar' && alert.undercutBy) {
            return prefix + tag + ' ' + alert.name + '：你的 ' + formatMoney(alert.myPrice) + ' 被 '
                + alert.undercutBy.playerName + '（ID ' + alert.undercutBy.playerId + '）'
                + ' 压至 ' + formatMoney(alert.compareLow);
        }
        var lowLabel = alert.source === 'Bazaar' ? '巴扎最低' : '市场最低';
        return prefix + tag + ' ' + alert.name + '：你的 ' + formatMoney(alert.myPrice) + ' 已被压至 '
            + lowLabel + ' ' + formatMoney(alert.compareLow);
    }

    async scanWatcher(config, watcher, signal) {
        const step = async (label, action) => {
            signal?.throwIfAborted();
            this.statusMessage = watcher.label + '：' + label;
            this.emit('state', this.getState());
            const controller = new AbortController();
            const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
            let timeout;
            const onQueueWait = (wait = 0) => {
                requestSignal.throwIfAborted();
                clearTimeout(timeout);
                timeout = setTimeout(() => controller.abort(new Error(label + '超时')), wait + this.requestTimeoutMs);
                this.statusMessage = watcher.label + '：' + label
                    + (wait >= 1000 ? '（共享限速排队，预计等待 ' + Math.ceil(wait / 1000) + ' 秒）' : '');
                this.emit('state', this.getState());
            };
            onQueueWait();
            let abort;
            const cancelled = new Promise((_, reject) => {
                abort = () => reject(requestSignal.reason);
                if (requestSignal.aborted) abort();
                else requestSignal.addEventListener('abort', abort, { once: true });
            });
            try {
                const result = await Promise.race([Promise.resolve().then(() => {
                    requestSignal.throwIfAborted();
                    return action({ signal: requestSignal, deferRateLimit: true, onQueueWait });
                }), cancelled]);
                requestSignal.throwIfAborted();
                return result;
            } finally {
                clearTimeout(timeout);
                requestSignal.removeEventListener('abort', abort);
            }
        };
        var state = this.ensureWatcherState(watcher.id);
        var apiKey = watcher.apiKey;
        var watchBazaar = watcher.watchBazaar !== false;
        var watchItemMarket = watcher.watchItemMarket !== false;
        var selectedIds = new Set();
        (watcher.selectedItems || []).forEach(function(item) {
            selectedIds.add(Number(item.id));
        });

        if (!watchBazaar && !watchItemMarket) {
            throw new Error(watcher.label + ': 请至少选择一种监听范围');
        }

        state.checks++;
        var myPlayerId = watchBazaar ? await step('读取玩家身份', options => fetchMyPlayerId(apiKey, state.playerCache, options)) : null;
        var listings = [], ownMarket = [];

        if (watchItemMarket) {
            var imRows = await step('读取个人市场挂单', options => fetchUserItemMarket(apiKey, options)); ownMarket = imRows;
            imRows.forEach(function(row) {
                var item = row.item || {};
                var itemId = item.id || item.ID;
                listings.push({
                    key: 'im-' + row.id,
                    itemId: itemId,
                    name: item.name || item.title || ('Item #' + (itemId || row.id)),
                    myPrice: Number(row.price) || 0,
                    source: 'Item Market',
                    kind: 'im'
                });
            });
        }

        if (watchBazaar) {
            var bazaar = await step('读取巴扎挂单', options => fetchUserBazaar(apiKey, options));
            bazaar.forEach(function(row) {
                var itemId = row.ID || row.id;
                listings.push({
                    key: 'bazaar-' + itemId + '-' + (Number(row.price) || 0),
                    itemId: itemId,
                    name: row.name || ('Item #' + itemId),
                    myPrice: Number(row.price) || 0,
                    source: 'Bazaar',
                    kind: 'bazaar'
                });
            });
        }

        if (selectedIds.size) {
            listings = listings.filter(function(entry) { return selectedIds.has(Number(entry.itemId)); });
        }

        var bazaarCount = listings.filter(function(e) { return e.kind === 'bazaar'; }).length;
        var imCount = listings.filter(function(e) { return e.kind === 'im'; }).length;

        if (!listings.length) {
            state.pendingMarket.clear();
            state.activeKeys.clear();
            state.alertMap.clear();
            this.store?.save(watcher, state);
            var scope = [];
            if (watchBazaar) scope.push('Bazaar');
            if (watchItemMarket) scope.push('Item Market');
            var scopeText = scope.join(' / ');
            this.statusMessage = watcher.label + '：'
                + (selectedIds.size
                    ? '指定物品在 ' + scopeText + ' 无在售'
                    : scopeText + ' 无在售货物');
            this.emit('state', this.getState());
            return { newAlerts: [], undercutCount: 0 };
        }

        this.statusMessage = watcher.label + '：Bazaar ' + bazaarCount + ' 件 · Item Market '
            + imCount + ' 件，正在比价...';
        this.emit('state', this.getState());

        var imPriceCache = {};
        var bazaarPriceCache = {};
        var currentUndercuts = new Set();
        var newAlerts = [], pendingKeys = new Set();

        for (var i = 0; i < listings.length; i++) {
            var entry = listings[i];
            if (!entry.itemId) continue;

            var channelLabel = entry.kind === 'bazaar' ? 'Bazaar' : 'Item Market';
            this.statusMessage = watcher.label + '：正在扫描 ' + channelLabel + ' · '
                + entry.name + '（' + (i + 1) + '/' + listings.length + '）';
            this.emit('state', this.getState());

            var compareLow = null;
            var undercutQuantity = null;
            var undercutBy = null;
            if (entry.kind === 'bazaar') {
                var bazaarLow = await step('巴扎比价 · ' + entry.name, options => fetchWeav3rBazaarLowest(entry.itemId, myPlayerId, bazaarPriceCache, options));
                if (bazaarLow) {
                    compareLow = bazaarLow.price;
                    undercutQuantity = bazaarLow.quantity;
                    undercutBy = { playerId: bazaarLow.playerId, playerName: bazaarLow.playerName };
                }
            } else {
                var marketLow = await step('市场比价 · ' + entry.name, options => fetchMarketLowestListing(apiKey, entry.itemId, imPriceCache, ownMarket.filter(row => Number(row.item?.id || row.item?.ID) === Number(entry.itemId)), options));
                if (marketLow) {
                    compareLow = marketLow.price;
                    undercutQuantity = marketLow.quantity;
                }
            }

            if (compareLow !== null && compareLow < entry.myPrice) {
                if (entry.kind === 'im' && !state.activeKeys.has(entry.key)) {
                    const signature = JSON.stringify([entry.myPrice, compareLow, ownMarket.filter(row => Number(row.item?.id || row.item?.ID) === Number(entry.itemId)).map(row => [row.id, row.price, row.amount, row.item?.uid ?? null]).sort((a,b) => Number(a[0])-Number(b[0]))]);
                    const now = this.now(), candidate = state.pendingMarket.get(entry.key);
                    pendingKeys.add(entry.key);
                    if (!candidate || candidate.signature !== signature || candidate.marketCacheAt === null && marketLow?.cacheTimestamp != null) {
                        state.pendingMarket.set(entry.key, { signature, firstSeenAt: now, marketCacheAt: marketLow?.cacheTimestamp ?? null });
                        continue;
                    }
                    // Do not "confirm" the same globally cached market snapshot.
                    if (!marketLow.coveredOwnListings.includes(entry.key.slice(3))) continue;
                    if (now - candidate.firstSeenAt < 60 || marketLow?.cacheTimestamp == null || candidate.marketCacheAt == null || marketLow.cacheTimestamp <= candidate.marketCacheAt) continue;
                    state.pendingMarket.delete(entry.key); pendingKeys.delete(entry.key);
                }

                currentUndercuts.add(entry.key);
                var alert = {
                    key: entry.key,
                    itemId: entry.itemId,
                    name: entry.name,
                    source: entry.source,
                    myPrice: entry.myPrice,
                    undercutQuantity: undercutQuantity,
                    compareLow: compareLow,
                    undercutBy: undercutBy,
                    detectedAt: this.now(),
                    watcherId: watcher.id,
                    watcherLabel: watcher.label
                };
                if (!state.activeKeys.has(entry.key)) newAlerts.push(alert);
                state.alertMap.set(entry.key, alert);
            }

                if (i < listings.length - 1) await step('等待下一物品', () => sleep(API_DELAY_MS));
        }

        for (const pending of state.pendingMarket.keys()) if (!pendingKeys.has(pending)) state.pendingMarket.delete(pending);
        state.activeKeys.forEach(function(key) {
            if (!currentUndercuts.has(key)) state.alertMap.delete(key);
        });
        state.activeKeys = currentUndercuts;
        this.store?.save(watcher, state);

        if (newAlerts.length) {
            state.alerts += newAlerts.length;
            this.alerts += newAlerts.length;
            for (var j = 0; j < newAlerts.length; j++) {
                var text = this.buildAlertText(newAlerts[j]);
                await step('投递压价提醒', () => publishBusinessEvent(config.notify, {
                    source: 'undercut', watcherId: watcher.id, eventKey: 'undercut', message: text
                }));
            }
        }

        return { newAlerts: newAlerts, undercutCount: currentUndercuts.size, pendingCount: state.pendingMarket.size };
    }

    async runOnce() {
        if (this.checking) return;
        clearTimeout(this.timer);
        this.timer = null;
        this.checking = true;
        this.retryNotBefore = 0;
        this.scanStartedAt = Date.now(); this.nextScanAt = null; this.lastScanError = '';
        const controller = this.scanController = new AbortController();
        const timeout = setTimeout(() => controller.abort(new Error('本轮扫描超时，已取消等待并安排重试')), this.scanTimeoutMs);
        try { await this.scanOnce(controller.signal); }
        catch (error) {
            if (controller.signal.aborted && !this.running) return;
            this.lastScanError = error.message; this.statusMessage = error.message; throw error;
        }
        finally {
            clearTimeout(timeout); this.checking = false; this.lastScanFinishedAt = Date.now();
            if (this.running) this.scheduleNext();
            else this.emit('state', this.getState());
        }
    }

    async scanOnce(signal) {
        var config = this.getConfig();
        var watchers = this.getWatchers();
        if (!watchers.length) {
            throw new Error('请至少添加一个监听账号并填写 API Key');
        }

        this.checks++;
        this.statusMessage = '正在扫描 ' + watchers.length + ' 个账号...';
        this.emit('state', this.getState());

        var totalUndercuts = 0;
        var totalNew = 0, totalPending = 0, errors = [];

        for (var i = 0; i < watchers.length; i++) {
            var watcher = watchers[i];
            try {
                this.statusMessage = '正在扫描 ' + watcher.label + '（' + (i + 1) + '/' + watchers.length + '）...';
                this.emit('state', this.getState());
                var result = await this.scanWatcher(config, watcher, signal);
                totalUndercuts += result.undercutCount;
                totalNew += result.newAlerts.length; totalPending += result.pendingCount || 0;
                this.ensureWatcherState(watcher.id).lastError = '';
            } catch (err) {
                this.ensureWatcherState(watcher.id).lastError = err.message;
                if (signal?.aborted) throw err;
                errors.push(watcher.label + '：' + err.message);
                this.emit('error', watcher.label + ': ' + err.message);
                if (err.rateLimited || err.apiCode === 5) {
                    this.retryNotBefore = Date.now() + Math.max(65000, Number(err.retryAfterMs) || 0);
                    break;
                }
            }
        }

        this.lastScanError = errors.join('；');
        this.statusMessage = errors.length ? '扫描未完整完成，将自动重试：' + this.lastScanError : totalNew
            ? '发现 ' + totalNew + ' 个新压价提醒'
            : (totalUndercuts
                ? '共 ' + totalUndercuts + ' 个货物被压价'
                : totalPending ? totalPending + ' 个市场候选等待跨缓存及自身挂单核验，暂不通知' : '未发现其他卖家的更低价');
        this.emit('alerts', this.getAllAlerts());
        this.emit('state', this.getState());

    }
}
