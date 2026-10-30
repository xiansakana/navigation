import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDatabase, closeDatabase } from '../../shared/db/index.js';
import { loadRbacBlob } from '../../shared/db/rbac-store.js';

import { ensureGuestAccess, syncRbacPermissions, canTestNotificationSlack, canWriteService, canManageBusinessNotification } from './rbac.js';

test('sync persistently retires target and score permissions without removing custom permissions', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'navigation-rbac-retired-'));
    const previousPath = process.env.NAVIGATION_DB_PATH;
    process.env.NAVIGATION_DB_PATH = path.join(directory, 'test.db');
    try {
        const retired = ['service:stock-manage:col-target:view', 'service:stock-manage:col-signal:view', 'service:stock-manage:col-target:edit', 'service:stock-manage:col-signal:edit'];
        const custom = 'custom:report:view';
        const data = { permissions: retired.map(id => ({ id, name: id })).concat([{ id: custom, name: 'Custom' }]), roles: [{ id: 'custom', permissions: [...retired, custom, 'service:stock-manage:col-name:view'] }, { id: 'role_admin', permissions: ['*', ...retired] }], users: [], menus: [] };
        const config = { services: [{ id: 'stock-manage', name: '股票管理' }], auth: { guestUsername: 'guest' } };
        syncRbacPermissions(data, config);
        const saved = loadRbacBlob(getDatabase());
        assert.ok(saved.permissions.some(p => p.id === custom));
        assert.deepEqual(saved.roles.find(r => r.id === 'custom').permissions, [custom, 'service:stock-manage:col-name:view']);
        for (const id of retired) {
            assert.ok(!saved.permissions.some(p => p.id === id));
            assert.ok(saved.roles.every(r => !r.permissions.includes(id)));
        }
        const before = JSON.stringify(data);
        syncRbacPermissions(data, config);
        assert.equal(JSON.stringify(data), before);
    } finally {
        closeDatabase();
        if (previousPath === undefined) delete process.env.NAVIGATION_DB_PATH;
        else process.env.NAVIGATION_DB_PATH = previousPath;
        if (path.dirname(directory) !== path.resolve(os.tmpdir())) throw new Error('Unexpected test directory');
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('sync preserves permissions saved for every existing role', function() {
    var data = {
        permissions: [],
        roles: [
            {
                id: 'role_guest',
                name: '游客',
                permissions: [
                    'service:piclist:view',
                    'service:notifications:edit',
                    'service:stock-manage:cash:view',
                    'service:stock-manage:cash:edit'
                ]
            },
            {
                id: 'role_custom',
                name: '自定义角色',
                permissions: ['service:napcat:view']
            }
        ],
        users: [
            {
                id: 'usr_guest',
                username: 'guest',
                roleIds: ['role_guest'],
                enabled: true
            }
        ],
        menus: [],
        userPrefs: {}
    };
    var config = {
        auth: { guestUsername: 'guest' },
        services: [
            { id: 'piclist', name: 'PicList 图床' },
            { id: 'notifications', name: '通知管理' },
            { id: 'napcat', name: 'NapCat' }
        ]
    };

    ensureGuestAccess(data, config);

    assert.deepEqual(
        data.roles.find(function(role) { return role.id === 'role_guest'; }).permissions,
        ['service:piclist:view', 'service:notifications:edit', 'codex-cli:view', 'knowledge:view', 'knowledge:notes:view', 'mingli:view', 'mingli:chart:calculate', 'torn-users:view', 'torn-chain:view', 'torn-factions:view']
    );
    assert.deepEqual(
        data.roles.find(function(role) { return role.id === 'role_custom'; }).permissions,
        ['service:napcat:view']
    );
});

test('Slack test permission grants only that notification action', function() {
    var slackOnly = ['service:notifications:view', 'service:notifications:slack-test:edit'];
    assert.equal(canTestNotificationSlack(slackOnly), true);
    assert.equal(canWriteService(slackOnly, 'notifications'), false);
    assert.equal(canTestNotificationSlack(['service:notifications:view']), false);
    assert.equal(canTestNotificationSlack(['service:notifications:edit']), true);
});

test('business notification save and test permissions remain separate', function() {
    assert.equal(canManageBusinessNotification(['service:notifications:business-save:edit'], 'save'), true);
    assert.equal(canManageBusinessNotification(['service:notifications:business-save:edit'], 'test'), false);
    assert.equal(canManageBusinessNotification(['service:notifications:business-test:edit'], 'test'), true);
    assert.equal(canManageBusinessNotification(['service:notifications:edit'], 'save'), true);
});
