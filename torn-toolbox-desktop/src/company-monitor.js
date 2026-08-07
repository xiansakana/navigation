import { EventEmitter } from 'node:events';
import { fetchCompanyApplications } from './torn-api.js';
import { notifyCompanyApplications } from './notify.js';
import { normalizeCompanyWatchers } from './watchers.js';

export class CompanyMonitor extends EventEmitter {
    constructor(getConfig) {
        super();
        this.getConfig = getConfig;
        this.timer = null;
        this.running = false;
        this.checks = 0;
        this.apps = 0;
        this.applications = [];
        this.nextScanAt = null;
        this.statusMessage = '';
        this.watcherStates = new Map();
    }

    ensureWatcherState(id) {
        if (!this.watcherStates.has(id)) {
            this.watcherStates.set(id, {
                seen: new Set(),
                checks: 0,
                apps: 0,
                lastError: ''
            });
        }
        return this.watcherStates.get(id);
    }

    getWatchers() {
        return normalizeCompanyWatchers(this.getConfig());
    }

    getState() {
        var watchers = this.getWatchers().map(function(w) {
            var st = this.watcherStates.get(w.id) || {};
            return {
                id: w.id,
                label: w.label,
                checks: st.checks || 0,
                apps: st.apps || 0,
                lastError: st.lastError || ''
            };
        }.bind(this));
        return {
            running: this.running,
            checks: this.checks,
            apps: this.apps,
            nextScanAt: this.nextScanAt,
            statusMessage: this.statusMessage,
            applications: this.applications,
            watchers: watchers
        };
    }

    start() {
        if (this.running) return;
        if (!this.getWatchers().length) {
            throw new Error('请至少添加一个监听账号并填写 API Key');
        }
        var interval = Math.max(10, Number(this.getConfig().company?.intervalSeconds) || 30);
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

    async runOnce() {
        var config = this.getConfig();
        var watchers = this.getWatchers();
        if (!watchers.length) {
            throw new Error('请至少添加一个监听账号并填写 API Key');
        }

        this.checks++;
        this.statusMessage = '正在检查公司申请...';
        this.emit('state', this.getState());

        var allNewApps = [];
        for (var i = 0; i < watchers.length; i++) {
            var watcher = watchers[i];
            var state = this.ensureWatcherState(watcher.id);
            state.checks++;
            try {
                var applications = await fetchCompanyApplications(watcher.apiKey);
                var newApps = [];
                var seedExisting = state.seen.size === 0;
                Object.keys(applications).forEach(function(id) {
                    if (seedExisting) {
                        state.seen.add(id);
                        return;
                    }
                    if (!state.seen.has(id)) {
                        state.seen.add(id);
                        state.apps++;
                        this.apps++;
                        var app = applications[id];
                        newApps.push({
                            id: id,
                            name: app.name || '未知',
                            userId: app.userID || app.user_id,
                            level: app.level,
                            status: app.status,
                            expires: app.expires,
                            message: app.message || '无消息',
                            stats: app.stats || {},
                            detectedAt: Math.floor(Date.now() / 1000),
                            watcherId: watcher.id,
                            watcherLabel: watcher.label
                        });
                    }
                }.bind(this));

                if (newApps.length) {
                    allNewApps = allNewApps.concat(newApps);
                    await notifyCompanyApplications(config.notify, watcher.notify, watcher.label, newApps);
                }
                state.lastError = '';
            } catch (err) {
                state.lastError = err.message;
                this.emit('error', watcher.label + ': ' + err.message);
            }
        }

        if (allNewApps.length) {
            this.applications = allNewApps.concat(this.applications).slice(0, 50);
        }

        this.statusMessage = allNewApps.length
            ? '发现 ' + allNewApps.length + ' 个新申请'
            : '暂无新申请';
        this.emit('applications', this.applications);
        this.emit('state', this.getState());

        if (this.running) {
            var interval = Math.max(10, Number(config.company?.intervalSeconds) || 30);
            this.scheduleNext(interval);
        }
    }
}
