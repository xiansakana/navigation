export function apiIntervalSeconds(value = 2) {
  if (!['string', 'number'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 1 || Number(value) > 60) throw new Error('API 请求间隔须为 1–60 秒');
  return Number(value);
}
