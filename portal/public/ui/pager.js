/**
 * Shared pagination primitives.
 *
 * Knowledge notes and mingli knowledge cases each grew their own copy of the
 * same math: page <-> offset conversion, page count, clamping after a delete,
 * the "1 … 4 5 6 … 20" window and the prev/next disabled rules. The copies
 * drifted, so this module owns the numbers and the callers only own copy and
 * markup.
 */

export const DEFAULT_PAGE_SIZE = 30;

export function pageCount(total, pageSize = DEFAULT_PAGE_SIZE) {
  const size = Math.max(1, Math.trunc(Number(pageSize) || DEFAULT_PAGE_SIZE));
  return Math.max(1, Math.ceil(Math.max(0, Number(total) || 0) / size));
}

export function offsetForPage(page, pageSize = DEFAULT_PAGE_SIZE) {
  const size = Math.max(1, Math.trunc(Number(pageSize) || DEFAULT_PAGE_SIZE));
  return Math.max(0, (Math.max(1, Math.trunc(Number(page) || 1)) - 1) * size);
}

export function pageForOffset(offset, pageSize = DEFAULT_PAGE_SIZE) {
  const size = Math.max(1, Math.trunc(Number(pageSize) || DEFAULT_PAGE_SIZE));
  return Math.floor(Math.max(0, Number(offset) || 0) / size) + 1;
}

/** Offset of the last page; 0 when the collection is empty. */
export function lastOffset(total, pageSize = DEFAULT_PAGE_SIZE) {
  const count = Number(total) || 0;
  return count > 0 ? offsetForPage(pageCount(count, pageSize), pageSize) : 0;
}

/**
 * Current page plus everything a pager needs to render its controls.
 * Clamps the page so a delete that shortens the list cannot strand the view.
 */
export function pagePosition({ offset = 0, total = 0, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const count = pageCount(total, pageSize);
  const page = Math.min(pageForOffset(offset, pageSize), count);
  return {
    page,
    count,
    total: Math.max(0, Number(total) || 0),
    prevDisabled: page <= 1,
    nextDisabled: page >= count
  };
}

/**
 * Page numbers worth rendering: first, last and a window around the current
 * page, ascending and de-duplicated. Callers insert the ellipsis themselves so
 * each surface can keep its own markup.
 */
export function pageWindow(current, count, span = 2) {
  const total = Math.max(1, Math.trunc(Number(count) || 1));
  const active = Math.min(Math.max(1, Math.trunc(Number(current) || 1)), total);
  const numbers = new Set([1, total]);
  for (let page = active - span; page <= active + span; page++) {
    if (page >= 1 && page <= total) numbers.add(page);
  }
  return [...numbers].sort((a, b) => a - b);
}

/** "第 2 / 5 页 · 共 132 条" — one format for every module. */
export function pageSummary(total, pageSize, page, unit = '条') {
  const count = pageCount(total, pageSize);
  const active = Math.min(Math.max(1, Math.trunc(Number(page) || 1)), count);
  return `第 ${active} / ${count} 页 · 共 ${Math.max(0, Number(total) || 0)} ${unit}`;
}

/**
 * Offset pager with filter awareness and stale-response protection.
 *
 * `request` receives `{ ...filters, offset, limit }` and must resolve to
 * `{ total, ... }`. When a filter changes the offset resets; when the list
 * shrinks under the current offset the pager clamps to the last page instead
 * of rendering an empty view.
 */
export function createOffsetPager(request, pageSize = DEFAULT_PAGE_SIZE) {
  let offset = 0;
  let filters = {};
  let key = '';
  let sequence = 0;
  let loading = false;
  let committed = { offset: 0, filters: {}, key: '' };

  async function load(nextFilters, nextOffset) {
    const nextKey = JSON.stringify(nextFilters);
    offset = nextKey !== key ? 0 : Math.max(0, nextOffset ?? offset);
    filters = { ...nextFilters };
    key = nextKey;
    const ticket = ++sequence;
    const filterChanged = key !== committed.key;
    loading = true;
    try {
      let target = offset;
      while (true) {
        const result = await request({ ...nextFilters, offset: target, limit: pageSize });
        if (ticket !== sequence) return null;
        const last = lastOffset(result.total, pageSize);
        if (target > last && result.total > 0) { target = last; offset = last; continue; }
        offset = result.total ? target : 0;
        committed = { offset, filters: { ...nextFilters }, key };
        return { ...result, offset, pageSize, filterChanged, filterKey: key };
      }
    } catch (error) {
      if (ticket !== sequence) return null;
      ({ offset, filters, key } = { ...committed });
      throw error;
    } finally {
      if (ticket === sequence) loading = false;
    }
  }

  return { load, refresh: () => (loading ? Promise.resolve(null) : load(filters, offset)) };
}
