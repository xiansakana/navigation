const DEFAULT_ENDPOINT = 'https://photon.komoot.io/reverse';

export function parseCoordinates(params) {
  const latitude = params.get('latitude');
  const longitude = params.get('longitude');
  if (!latitude?.trim() || !longitude?.trim()) throw new Error('定位坐标无效');
  const lat = Number(latitude), lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new Error('定位坐标无效');
  }
  return { latitude: lat, longitude: lon };
}

export function formatAddress(data) {
  const address = data?.features?.[0]?.properties;
  if (!address) return '';
  const fields = ['state', 'county', 'city', 'district', 'locality', 'street', 'housenumber', 'name'];
  if (address.countrycode !== 'CN') fields.unshift('country');
  const parts = [...new Set(fields.map(field => address[field]).filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
  return parts.join(' · ').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
}

// Share requests across viewers; keep traffic modest and bound both queue and cache.
export function createAddressResolver({ fetchImpl = fetch, endpoint = process.env.BLOG_GEOCODING_URL || DEFAULT_ENDPOINT,
  spacingMs = 1100, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), cacheLimit = 300 } = {}) {
  const cache = new Map(), pending = new Map();
  let tail = Promise.resolve(), lastStarted = 0;
  return function resolveAddress(coordinates) {
    const key = coordinates.latitude.toFixed(5) + ',' + coordinates.longitude.toFixed(5);
    const hit = cache.get(key);
    if (hit && hit.expires > now()) return Promise.resolve(hit.label);
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 8) return Promise.reject(new Error('地址服务繁忙，请稍后重试'));
    const task = tail.then(async () => {
      const delay = Math.max(0, lastStarted + spacingMs - now());
      if (delay) await sleep(delay);
      lastStarted = now();
      let label = '';
      try {
        const url = new URL(endpoint);
        url.searchParams.set('lat', coordinates.latitude.toFixed(5));
        url.searchParams.set('lon', coordinates.longitude.toFixed(5));
        url.searchParams.set('limit', '1');
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(5000),
          headers: { 'User-Agent': 'Navigation Blog/1.0 (+https://saoyu.fun/)' } });
        if (!response.ok) throw new Error('地址服务暂不可用');
        label = formatAddress(await response.json());
      } finally {
        cache.delete(key);
        cache.set(key, { label, expires: now() + (label ? 24 * 60 * 60 * 1000 : 60000) });
        if (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
      }
      return label;
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    tail = task.catch(() => {});
    return task;
  };
}

export const resolveAddress = createAddressResolver();
