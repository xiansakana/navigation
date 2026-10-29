import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const settings=()=>({qq:{enabled:true},slack:{enabled:false},targets:[{type:'group',groupId:'123456',userId:'',atUserId:''}]});
test('notification management shopping card saves targets and tests saved configuration through Portal', async () => {
  const dom = new JSDOM('<div id="shopping-notifications" hidden></div><button id="business-refresh"></button>', { runScripts: 'outside-only', url: 'https://test/notifications/' });
  const w = dom.window, host = w.document.getElementById('shopping-notifications'), calls = [];
  const until = async check => { for (let i = 0; i < 50 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check()); };
  let writable = true;
  w.toast = () => {};
  w.fetch = async (url, options) => {
    calls.push({ url, ...options }); return { ok: true, json: async () => ({ ok: true, settings: options.body ? JSON.parse(options.body) : settings(), permissions: { save: writable, test: writable } }) };
  };
  try {
    w.eval(fs.readFileSync(new URL('../../qq-bot/public/qq-targets.js', import.meta.url), 'utf8'));
    w.eval(fs.readFileSync(new URL('../../qq-bot/public/shopping-notifications.js', import.meta.url), 'utf8'));
    await until(() => !host.hidden);
    host.querySelector('[data-action="add-target"]').click(); assert.equal(host.querySelectorAll('.biz-target').length, 2);
    host.querySelectorAll('[data-action="remove-target"]')[1].click();
    host.querySelector('[data-field="groupId"]').value = '987654';
    host.querySelector('[data-action="shopping-save"]').click(); await until(() => calls.some(row => row.method === 'PUT'));
    assert.equal(JSON.parse(calls.find(row => row.method === 'PUT').body).targets[0].groupId, '987654');
    await until(() => !host.querySelector('[data-action="shopping-save"]').disabled);
    host.querySelector('[data-action="shopping-test"]').click(); await until(() => calls.some(row => row.method === 'POST'));
    assert.equal(calls.find(row => row.method === 'POST').body, undefined);
    writable = false; w.document.getElementById('business-refresh').click(); await until(() => host.querySelector('input').disabled);
    assert.equal(host.querySelector('[data-action="shopping-test"]').disabled, true);
  } finally { w.close(); }
});
