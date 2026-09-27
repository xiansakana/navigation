import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureGuestAccess, canTestNotificationSlack, canWriteService } from './rbac.js';

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
        ['service:piclist:view', 'service:notifications:edit']
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
