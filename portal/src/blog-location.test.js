import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

test('automatic location starts only on permission-gated activation, waits and ignores removed results', async () => {
  const dom = new JSDOM('<div id="location"></div>', { runScripts: 'outside-only' });
  const calls = [];
  dom.window.fetch = async () => ({ ok: true, json: async () => ({ ok: true, label: '上海市 · 浦东新区 · 世纪大道' }) });
  Object.defineProperty(dom.window.navigator, 'geolocation', { value: { getCurrentPosition: (ok, fail) => calls.push({ ok, fail }) } });
  dom.window.eval(fs.readFileSync(new URL('../public/blog-widgets.js', import.meta.url), 'utf8'));
  const root = dom.window.document.querySelector('#location');
  try {
    const location = dom.window.createBlogLocation(root);
    assert.equal(calls.length, 0);
    location.start(); location.start();
    assert.equal(calls.length, 1);
    const result = location.value();
    assert.equal(await location.value({ wait: false }), null);
    calls[0].ok({ coords: { latitude: 31.2, longitude: 121.5 } });
    assert.equal((await result).latitude, 31.2);
    assert.match(root.textContent, /世纪大道/);
    assert.doesNotMatch(root.textContent, /31\.2/);
    location.clear();
    root.querySelectorAll('button')[1].click();
    calls[1].ok({ coords: { latitude: 50, longitude: 1 } });
    assert.equal(await location.value(), null);
    root.querySelectorAll('button')[0].click();
    calls[2].fail({ code: 1 });
    assert.equal(await location.value(), null);
    assert.match(root.textContent, /未获定位授权/);
    assert.equal(root.querySelectorAll('input').length, 0);
  } finally { dom.window.close(); }
});

test('editing an existing location preserves it without replacing it with current coordinates', async () => {
  const dom = new JSDOM('<div id="location"></div>', { runScripts: 'outside-only' });
  let called = false;
  Object.defineProperty(dom.window.navigator, 'geolocation', { value: { getCurrentPosition: () => { called = true; } } });
  dom.window.eval(fs.readFileSync(new URL('../public/blog-widgets.js', import.meta.url), 'utf8'));
  try {
    const widget = dom.window.createBlogLocation(dom.window.document.querySelector('#location'), { label: '旧位置', latitude: 1, longitude: 2 });
    widget.start();
    assert.equal(called, false);
    assert.equal((await widget.value()).label, '旧位置');
  } finally { dom.window.close(); }
});

test('an unanswered location permission prompt times out without blocking publishing', async () => {
  const dom = new JSDOM('<div id="location"></div>', { runScripts: 'outside-only' });
  let timeout, success;
  dom.window.setTimeout = callback => { timeout = callback; return 1; };
  dom.window.clearTimeout = () => {};
  Object.defineProperty(dom.window.navigator, 'geolocation', { value: { getCurrentPosition: callback => { success = callback; } } });
  dom.window.eval(fs.readFileSync(new URL('../public/blog-widgets.js', import.meta.url), 'utf8'));
  try {
    const widget = dom.window.createBlogLocation(dom.window.document.querySelector('#location'));
    widget.start(); timeout();
    assert.equal(await widget.value(), null);
    success({ coords: { latitude: 1, longitude: 2 } });
    assert.equal(await widget.value(), null);
    assert.match(dom.window.document.body.textContent, /超时/);
  } finally { dom.window.close(); }
});

test('legacy coordinates resolve as addresses and removed locations ignore late address responses', async () => {
  const dom = new JSDOM('<div id="location"></div>', { runScripts: 'outside-only' });
  let answer, requests = 0;
  dom.window.fetch = () => { requests++; return new Promise(resolve => { answer = label => resolve({ ok: true, json: async () => ({ ok: true, label }) }); }); };
  dom.window.eval(fs.readFileSync(new URL('../public/blog-widgets.js', import.meta.url), 'utf8'));
  try {
    const root = dom.window.document.querySelector('#location');
    const widget = dom.window.createBlogLocation(root, { label: '', latitude: 31.2, longitude: 121.5 });
    const pending = widget.start();
    assert.equal(requests, 1);
    assert.match(root.textContent, /正在解析位置地址/);
    root.querySelectorAll('button')[1].click();
    answer('上海市 · 浦东新区 · 世纪大道'); await pending;
    assert.equal(await widget.value(), null);
    assert.doesNotMatch(root.textContent, /世纪大道/);
    const second = dom.window.createBlogLocation(dom.window.document.createElement('div'), { label: '', latitude: 31.2, longitude: 121.5 });
    await second.start();
    assert.equal((await second.value()).label, '上海市 · 浦东新区 · 世纪大道');
    assert.equal(requests, 1);
  } finally { dom.window.close(); }
});

test('address failures preserve coordinates for maps without showing them or preventing a submit', async () => {
  const dom = new JSDOM('<div id="location"></div>', { runScripts: 'outside-only' });
  dom.window.fetch = async () => { throw new Error('network unavailable'); };
  dom.window.eval(fs.readFileSync(new URL('../public/blog-widgets.js', import.meta.url), 'utf8'));
  try {
    const root = dom.window.document.querySelector('#location');
    const widget = dom.window.createBlogLocation(root, { label: '', latitude: 31.2, longitude: 121.5 });
    await widget.start();
    assert.equal((await widget.value()).latitude, 31.2);
    assert.match(root.textContent, /地址暂不可用/);
    assert.doesNotMatch(root.textContent, /31\.2/);
  } finally { dom.window.close(); }
});
