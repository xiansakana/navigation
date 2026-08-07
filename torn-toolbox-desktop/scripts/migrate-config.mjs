#!/usr/bin/env node
/** 将旧版 config.json 拆分为 config.undercut.json 与 config.company.json */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const legacyPath = path.join(root, 'config.json');
const undercutPath = path.join(root, 'config.undercut.json');
const companyPath = path.join(root, 'config.company.json');

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function buildUndercutFromLegacy(legacy) {
    var undercut = legacy.undercut || {};
    var watchers = undercut.watchers;
    if (!Array.isArray(watchers) || !watchers.length) {
        if (legacy.tornApiKey) {
            watchers = [{
                id: 'default',
                label: '默认',
                enabled: true,
                apiKey: legacy.tornApiKey,
                watchBazaar: undercut.watchBazaar !== false,
                watchItemMarket: undercut.watchItemMarket !== false,
                selectedItems: undercut.selectedItems || [],
                notify: legacy.notify || {}
            }];
        } else {
            watchers = [];
        }
    }
    return {
        server: { ...legacy.server, port: 8790, openBrowser: false },
        undercut: {
            intervalSeconds: undercut.intervalSeconds || 60,
            autoStart: undercut.autoStart !== false,
            watchers: watchers
        },
        notify: legacy.notify || {}
    };
}

function buildCompanyFromLegacy(legacy) {
    return {
        server: { ...legacy.server, port: 8791, openBrowser: false },
        company: legacy.company || { intervalSeconds: 30, autoStart: false, watchers: [] },
        notify: legacy.notify || {}
    };
}

if (!fs.existsSync(legacyPath)) {
    console.log('无 config.json，跳过迁移');
    process.exit(0);
}

var legacy = readJson(legacyPath);
var migrated = false;

if (!fs.existsSync(undercutPath)) {
    writeJson(undercutPath, buildUndercutFromLegacy(legacy));
    console.log('已创建 config.undercut.json');
    migrated = true;
}

if (!fs.existsSync(companyPath)) {
    writeJson(companyPath, buildCompanyFromLegacy(legacy));
    console.log('已创建 config.company.json');
    migrated = true;
}

if (!migrated) {
    console.log('config.undercut.json 与 config.company.json 已存在，未改动');
}
