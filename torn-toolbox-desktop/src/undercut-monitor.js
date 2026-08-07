import { EventEmitter } from 'node:events';
import { API_DELAY_MS, formatMoney, sleep } from './utils.js';
import {
    fetchMarketLowestPrice,
    fetchMyPlayerId,
    fetchUserBazaar,
    fetchUserItemMarket,
    fetchWeav3rBazaarLowest
} from './torn-api.js';
import { notifyUndercutAlert } from './notify.js';
import { normalizeUndercutWatchers } from './watchers.js';

export class UndercutMonitor extends EventEmitter {
    constructor(getConfig) {
        super();
        this.getConfig = getConfig;
        this.timer = null;
        this.running = false;
        this.checks = 0;
        this.alerts = 0;
        this.applications = [];
        this.nextScanAt = null;
        this.statusMessage = '';
        this.watcherStates = new Map();
    }

    ensureWatcherState(id) {
        if (!this.watcherStates.has(id)) {
            this.watcherStates.set(id, {
                playerCache: {},
                activeKeys: new Set(),
                alertMap: new Map(),
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
        var interval = Math.max(30, Number(this.getConfig().undercut?.intervalSeconds) || 60);
        this.running = true;
        this.emit('state', this.getState());
        this.runOnce().catch(function(err) {
            this.emit('error', err.message);
        }.bind(this));
        this.timer = setInterval(function() {
            this.runOnce().catch(function(err) {
                this.emit('error', err.message);
            }.bind(this));
        }.bind(this), interval * 1000);
        this.scheduleNext(interval);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.running = false;
        this.nextScanAt = null;
        this.statusMessage = '';
        this.emit('state', this.getState());
    }

    scheduleNext(intervalSeconds) {
        this.nextScanAt = Date.now() + intervalSeconds * 1000;
        this.emit('state', this.getState());
    }

    buildAlertText(alert) {
        var tag = alert.source === 'Bazaar' ? '[Bazaar]' : '[Item Market]';
        var prefix = alert.watcherLabel ? '[' + alert.watcherLabel + '] ' : '';
        if (alert.source === 'Bazaar' && alert.undercutBy) {
            return prefix + tag + ' ' + alert.name + '：你的 ' + formatMoney(alert.myPrice) + ' 被 '
                + alert.undercutBy.playerName + '（ID ' + alert.undercutBy.playerId + '）'
                + ' 压至 ' + formatMoney(alert.compareLow);
        }
        var lowLabel = alert.source === 'Bazaar' ? '巴扎最低' : '市场最低';
        return prefix + tag + ' ' + alert.name + '：你的 ' + formatMoney(alert.myPrice) + ' 已被压至 '
            + lowLabel + ' ' + formatMoney(alert.compareLow);
    }

    async scanWatcher(config, watcher) {
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
        var myPlayerId = watchBazaar ? await fetchMyPlayerId(apiKey, state.playerCache) : null;
        var listings = [];

        if (watchItemMarket) {
            var imRows = await fetchUserItemMarket(apiKey);
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
            var bazaar = await fetchUserBazaar(apiKey);
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
            state.activeKeys.clear();
            state.alertMap.clear();
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
        var newAlerts = [];

        for (var i = 0; i < listings.length; i++) {
            var entry = listings[i];
            if (!entry.itemId) continue;

            var channelLabel = entry.kind === 'bazaar' ? 'Bazaar' : 'Item Market';
            this.statusMessage = watcher.label + '：正在扫描 ' + channelLabel + ' · '
                + entry.name + '（' + (i + 1) + '/' + listings.length + '）';
            this.emit('state', this.getState());

            var compareLow = null;
            var undercutBy = null;
            if (entry.kind === 'bazaar') {
                var bazaarLow = await fetchWeav3rBazaarLowest(entry.itemId, myPlayerId, bazaarPriceCache);
                if (bazaarLow) {
                    compareLow = bazaarLow.price;
                    undercutBy = { playerId: bazaarLow.playerId, playerName: bazaarLow.playerName };
                }
            } else {
                compareLow = await fetchMarketLowestPrice(apiKey, entry.itemId, imPriceCache);
            }

            if (compareLow !== null && compareLow < entry.myPrice) {
                currentUndercuts.add(entry.key);
                var alert = {
                    key: entry.key,
                    itemId: entry.itemId,
                    name: entry.name,
                    source: entry.source,
                    myPrice: entry.myPrice,
                    compareLow: compareLow,
                    undercutBy: undercutBy,
                    detectedAt: Math.floor(Date.now() / 1000),
                    watcherId: watcher.id,
                    watcherLabel: watcher.label
                };
                if (!state.activeKeys.has(entry.key)) newAlerts.push(alert);
                state.alertMap.set(entry.key, alert);
            }

            if (i < listings.length - 1) await sleep(API_DELAY_MS);
        }

        state.activeKeys.forEach(function(key) {
            if (!currentUndercuts.has(key)) state.alertMap.delete(key);
        });
        state.activeKeys = currentUndercuts;

        if (newAlerts.length) {
            state.alerts += newAlerts.length;
            this.alerts += newAlerts.length;
            for (var j = 0; j < newAlerts.length; j++) {
                var text = this.buildAlertText(newAlerts[j]);
                await notifyUndercutAlert(config.notify, watcher.notify, newAlerts[j], text);
            }
        }

        return { newAlerts: newAlerts, undercutCount: currentUndercuts.size };
    }

    async runOnce() {
        var config = this.getConfig();
        var watchers = this.getWatchers();
        if (!watchers.length) {
            throw new Error('请至少添加一个监听账号并填写 API Key');
        }

        this.checks++;
        this.statusMessage = '正在扫描 ' + watchers.length + ' 个账号...';
        this.emit('state', this.getState());

        var totalUndercuts = 0;
        var totalNew = 0;

        for (var i = 0; i < watchers.length; i++) {
            var watcher = watchers[i];
            try {
                this.statusMessage = '正在扫描 ' + watcher.label + '（' + (i + 1) + '/' + watchers.length + '）...';
                this.emit('state', this.getState());
                var result = await this.scanWatcher(config, watcher);
                totalUndercuts += result.undercutCount;
                totalNew += result.newAlerts.length;
                this.ensureWatcherState(watcher.id).lastError = '';
            } catch (err) {
                this.ensureWatcherState(watcher.id).lastError = err.message;
                this.emit('error', watcher.label + ': ' + err.message);
            }
        }

        this.statusMessage = totalNew
            ? '发现 ' + totalNew + ' 个新压价提醒'
            : (totalUndercuts
                ? '共 ' + totalUndercuts + ' 个货物被压价'
                : '所有账号货物均为对应渠道最低价');
        this.emit('alerts', this.getAllAlerts());
        this.emit('state', this.getState());

        if (this.running) {
            var interval = Math.max(30, Number(config.undercut?.intervalSeconds) || 60);
            this.scheduleNext(interval);
        }
    }
}
