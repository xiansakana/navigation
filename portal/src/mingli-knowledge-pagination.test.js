import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { createKnowledgeCases } from '../public/mingli/knowledge-cases.js';

test('knowledge numbered pagination replaces rows, preserves applied queries, resets filters and recovers from shrinking results', async () => {
  const dom = new JSDOM(fs.readFileSync(new URL('../public/mingli/index.html', import.meta.url), 'utf8'));
  const previous = globalThis.document; globalThis.document = dom.window.document;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const $ = id => document.getElementById(id);
  const records = Array.from({ length: 65 }, (_, i) => ({ id: String(i), title: '案例' + i, chart: { pillars: [] }, birth: { gender: i % 2 }, tags: [], documentTitle: '来源', topic: '', timeLabel: '' }));
  let available = records, fail = false, panel, pending;
  const requests = [];
  const run = fn => {
    panel.busy(true);
    pending = (async () => { try { await fn(); } catch (e) { if (!fail) throw e; } finally { panel.busy(false); } })();
  };
  const click = async id => { $(id).click(); await pending; };
  const submit = async id => { $(id).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); await pending; };
  try {
    panel = createKnowledgeCases({ run, tab() {}, api: async route => {
      const params = new URL(route, 'http://localhost').searchParams; requests.push(Object.fromEntries(params));
      if (fail) throw new Error('network');
      const filters = JSON.parse(params.get('filters')), query = params.get('search');
      const matched = available.filter(r => (!query || r.title.includes(query)) && (filters.gender === undefined || r.birth.gender === Number(filters.gender)));
      return { cases: matched.slice(Number(params.get('offset')), Number(params.get('offset')) + Number(params.get('limit'))), total: matched.length, uniqueCharts: matched.length, documents: [] };
    } });
    panel.permissions(['*']);
    await click('knowledge-tab');
    assert.equal($('kc-list').children.length, 30); assert.equal($('kc-prev').disabled, true);
    assert.match($('kc-page-info').textContent, /第 1 \/ 3 页/);
    $('kc-search').value = '未应用的草稿';
    await click('kc-next');
    assert.equal(requests.at(-1).search, ''); assert.equal(requests.at(-1).offset, '30');
    assert.equal($('kc-list').children.length, 30); assert.equal($('kc-list').firstElementChild.dataset.knowledgeCase, '30');
    await click('kc-next');
    assert.equal($('kc-list').children.length, 5); assert.equal($('kc-next').disabled, true);
    assert.equal($('kc-pages').querySelector('[aria-current="page"]').dataset.page, '3');
    $('kc-page-input').value = '1'; await submit('kc-jump-form');
    assert.equal(requests.at(-1).offset, '0');
    $('kc-pages').querySelector('[data-page="2"]').click(); await pending;
    assert.equal(requests.at(-1).offset, '30');
    fail = true; await click('kc-next');
    assert.match($('kc-page-info').textContent, /第 2 \/ 3 页/); assert.equal($('kc-list').children.length, 30);
    fail = false; available = records.slice(0, 12); await click('kc-next');
    assert.equal(requests.at(-2).offset, '60'); assert.equal(requests.at(-1).offset, '0');
    assert.equal($('kc-list').children.length, 12); assert.match($('kc-page-info').textContent, /第 1 \/ 1 页/);
    available = records; $('kc-search').value = ''; await submit('kc-search-form'); await click('kc-next');
    $('kc-filter-gender').value = '0'; await submit('kc-advanced-form');
    assert.equal(requests.at(-1).offset, '0'); assert.equal($('kc-list').children.length, 30);
    await click('kc-next'); assert.equal($('kc-list').children.length, 3);
    assert.equal(JSON.parse(requests.at(-1).filters).gender, '0');
    $('kc-search').value = '不存在'; await submit('kc-search-form');
    assert.equal($('kc-pagination').hidden, true); assert.match($('kc-list').textContent, /没有匹配/);
    await click('kc-clear-case-filters'); assert.match($('kc-page-info').textContent, /第 1 \/ 3 页/);
  } finally { globalThis.document = previous; dom.window.close(); }
});
