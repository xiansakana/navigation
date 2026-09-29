import { EventEmitter } from 'node:events';
import { fetchCompanyApplications } from './torn-api.js';
import { publishBusinessEvent } from '../../shared/business-events.js';
import { formatApplicationSummary } from './utils.js';
import { normalizeCompanyWatchers } from './watchers.js';
import { DEFAULT_STATE_FILE, fingerprint, loadCompanyMonitorSnapshot, saveCompanyMonitorSnapshot } from './company-monitor-store.js';

export class CompanyMonitor extends EventEmitter {
    constructor(getConfig, dependencies = {}) {
        super();
        this.getConfig = getConfig;
        this.fetchApplications = dependencies.fetchApplications || fetchCompanyApplications;
        this.publishEvent = dependencies.publishEvent || publishBusinessEvent;
        this.stateFile = dependencies.stateFile === undefined ? DEFAULT_STATE_FILE : dependencies.stateFile;
        this.persistedWatchers = this.stateFile ? loadCompanyMonitorSnapshot(this.stateFile) : {};
        this.timer = null;
        this.running = false;
        this.checking = false;
        this.checks = 0;
        this.apps = 0;
        this.applications = [];
        this.nextScanAt = null;
        this.statusMessage = '';
        this.watcherStates = new Map();
    }

    ensureWatcherState(watcher) {
        if (!this.watcherStates.has(watcher.id)) {
            var saved = this.persistedWatchers[fingerprint(watcher.id)];
            var apiKeyFingerprint = fingerprint(watcher.apiKey);
            var isCompatible = saved && saved.apiKeyFingerprint === apiKeyFingerprint;
            this.watcherStates.set(watcher.id, {
                initialized: !!(isCompatible && saved.initialized),
                seen: new Set(isCompatible ? saved.seenApplicationFingerprints || [] : []),
                apiKeyFingerprint: apiKeyFingerprint,
                dirty: false,
                checks: 0,
                apps: 0,
                lastError: ''
            });
        }
        return this.watcherStates.get(watcher.id);
    }

    persistState(watchers) {
        if (!this.stateFile) return;
        var snapshot = {};
        watchers.forEach(function(watcher) {
            var state = this.watcherStates.get(watcher.id);
            if (!state || !state.initialized) return;
            snapshot[fingerprint(watcher.id)] = {
                apiKeyFingerprint: state.apiKeyFingerprint,
                initialized: true,
                seenApplicationFingerprints: Array.from(state.seen)
            };
        }.bind(this));
        saveCompanyMonitorSnapshot(snapshot, this.stateFile);
        this.persistedWatchers = snapshot;
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
        if (this.checking) return;

        var config = this.getConfig();
        var watchers = this.getWatchers();
        if (!watchers.length) {
            throw new Error('请至少添加一个监听账号并填写 API Key');
        }

        this.checking = true;
        try {
            this.checks++;
            this.statusMessage = '正在检查公司申请...';
            this.emit('state', this.getState());

            var allNewApps = [];
            for (var i = 0; i < watchers.length; i++) {
                var watcher = watchers[i];
                var state = this.ensureWatcherState(watcher);
                state.checks++;
                try {
                    var applications = await this.fetchApplications(watcher.apiKey);
                    var newApps = [];
                    var applicationIds = Object.keys(applications || {});
                    if (!state.initialized) {
                        applicationIds.forEach(function(id) {
                            state.seen.add(fingerprint(id));
                        });
                        state.initialized = true;
                        state.dirty = true;
                    } else {
                        applicationIds.forEach(function(id) {
                            if (state.seen.has(fingerprint(id))) return;
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
                        });
                    }

                    if (newApps.length) {
                        await this.publishEvent(config.notify, {
                            source: 'company', watcherId: watcher.id, eventKey: 'application',
                            message: '[' + watcher.label + '] 发现 ' + newApps.length + ' 个新申请：'
                                + newApps.map(formatApplicationSummary).join('；')
                        });
                        newApps.forEach(function(app) {
                            state.seen.add(fingerprint(app.id));
                            state.apps++;
                            this.apps++;
                        }.bind(this));
                        state.dirty = true;
                        allNewApps = allNewApps.concat(newApps);
                    }
                    if (state.dirty) {
                        this.persistState(watchers);
                        state.dirty = false;
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
        } finally {
            this.checking = false;
        }
    }
}
