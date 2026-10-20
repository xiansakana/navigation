export function createNotePager(request, pageSize = 30) {
  let offset = 0, filters = {}, key = '', sequence = 0, loading = false;
  let committed = { offset: 0, filters: {}, key: '' };
  async function load(nextFilters, nextOffset) {
    const nextKey = JSON.stringify(nextFilters);
    offset = nextKey !== key ? 0 : Math.max(0, nextOffset ?? offset);
    filters = { ...nextFilters }; key = nextKey;
    const ticket = ++sequence, filterChanged = key !== committed.key;
    loading = true;
    try {
      let target = offset;
      while (true) {
        const result = await request({ ...nextFilters, offset: target, limit: pageSize });
        if (ticket !== sequence) return null;
        const last = Math.max(0, Math.floor((result.total - 1) / pageSize) * pageSize);
        if (target > last && result.total > 0) { target = last; offset = last; continue; }
        offset = result.total ? target : 0;
        committed = { offset, filters: { ...nextFilters }, key };
        return { ...result, offset, pageSize, filterChanged, filterKey: key };
      }
    } catch (e) {
      if (ticket !== sequence) return null;
      ({ offset, filters, key } = { ...committed });
      throw e;
    } finally { if (ticket === sequence) loading = false; }
  }
  return { load, refresh: () => loading ? Promise.resolve(null) : load(filters, offset) };
}
