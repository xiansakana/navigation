import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createOffsetPager,
    lastOffset,
    offsetForPage,
    pageCount,
    pageForOffset,
    pagePosition,
    pageSummary,
    pageWindow
} from '../public/ui/pager.js';

test('page and offset convert both ways and never go negative', () => {
    assert.equal(offsetForPage(1, 30), 0);
    assert.equal(offsetForPage(4, 30), 90);
    assert.equal(offsetForPage(0, 30), 0);
    assert.equal(offsetForPage(-3, 30), 0);
    assert.equal(pageForOffset(0, 30), 1);
    assert.equal(pageForOffset(90, 30), 4);
    assert.equal(pageForOffset(-10, 30), 1);
    for (const page of [1, 2, 7, 42]) assert.equal(pageForOffset(offsetForPage(page, 30), 30), page);
});

test('page count keeps an empty collection on a single page', () => {
    assert.equal(pageCount(0, 30), 1);
    assert.equal(pageCount(1, 30), 1);
    assert.equal(pageCount(30, 30), 1);
    assert.equal(pageCount(31, 30), 2);
    assert.equal(pageCount(-5, 30), 1);
    assert.equal(lastOffset(0, 30), 0);
    assert.equal(lastOffset(1, 30), 0);
    assert.equal(lastOffset(61, 30), 60);
});

test('pagePosition clamps a stranded offset after the list shrinks', () => {
    // 61 items, page 3 (offset 60) still valid.
    assert.deepEqual(pagePosition({ offset: 60, total: 61 }), {
        page: 3, count: 3, total: 61, prevDisabled: false, nextDisabled: true
    });
    // The same offset after deleting down to 31 items must fall back to page 2.
    assert.deepEqual(pagePosition({ offset: 60, total: 31 }), {
        page: 2, count: 2, total: 31, prevDisabled: false, nextDisabled: true
    });
    // An empty list reports page 1 of 1 with both controls disabled.
    assert.deepEqual(pagePosition({ offset: 90, total: 0 }), {
        page: 1, count: 1, total: 0, prevDisabled: true, nextDisabled: true
    });
});

test('pageWindow keeps the first, last and a two page radius without duplicates', () => {
    assert.deepEqual(pageWindow(1, 1), [1]);
    assert.deepEqual(pageWindow(1, 3), [1, 2, 3]);
    assert.deepEqual(pageWindow(6, 12), [1, 4, 5, 6, 7, 8, 12]);
    assert.deepEqual(pageWindow(11, 12), [1, 9, 10, 11, 12]);
    assert.deepEqual(pageWindow(99, 12), [1, 10, 11, 12]);
    assert.deepEqual(pageWindow(0, 12), [1, 2, 3, 12]);
});

test('pageSummary uses one wording everywhere', () => {
    assert.equal(pageSummary(132, 30, 3), '第 3 / 5 页 · 共 132 条');
    assert.equal(pageSummary(0, 30, 1, '篇'), '第 1 / 1 页 · 共 0 篇');
    assert.equal(pageSummary(10, 30, 99, '篇'), '第 1 / 1 页 · 共 10 篇');
});

test('offset pager resets on filter change and clamps past the last page', async () => {
    const calls = [];
    const request = async params => {
        calls.push(params);
        const total = params.search === 'empty' ? 0 : params.search === 'short' ? 5 : 100;
        return { total, documents: [] };
    };
    const pager = createOffsetPager(request, 30);

    const first = await pager.load({ search: '', topic: '' });
    assert.equal(first.offset, 0);
    assert.equal(first.filterChanged, true);

    const second = await pager.load({ search: '', topic: '' }, 60);
    assert.equal(second.offset, 60);
    assert.equal(second.filterChanged, false);

    // A filter change ignores the requested offset and starts over.
    const filtered = await pager.load({ search: 'x', topic: '' }, 60);
    assert.equal(filtered.offset, 0);
    assert.equal(filtered.filterChanged, true);

    // Same filters, far offset: the first attempt asks for it, then clamps back
    // to the last real page instead of rendering an empty view.
    await pager.load({ search: 'short', topic: '' });
    const before = calls.length;
    const clamped = await pager.load({ search: 'short', topic: '' }, 120);
    assert.equal(calls[before].offset, 120);
    assert.equal(calls[before].limit, 30);
    assert.equal(calls.at(-1).offset, 0);
    assert.equal(clamped.offset, 0);

    const empty = await pager.load({ search: 'empty', topic: '' });
    assert.equal(empty.offset, 0);
});

test('offset pager ignores a stale response and restores committed state on error', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let calls = 0;
    const pager = createOffsetPager(async () => {
        calls++;
        if (calls === 1) { await gate; return { total: 200 }; }
        return { total: 200 };
    }, 30);

    const slow = pager.load({ search: '' }, 0);
    const fast = pager.load({ search: '' }, 30);
    release();
    assert.equal(await slow, null);
    assert.equal((await fast).offset, 30);

    const failing = createOffsetPager(async () => { throw new Error('offline'); }, 30);
    await assert.rejects(failing.load({ search: '' }), /offline/);
    await assert.rejects(failing.refresh(), /offline/);
});
