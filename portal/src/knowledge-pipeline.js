// Shared limits are stored per account and applied independently to each worker.
export function pipelineSettings(raw = {}, previous = {}) {
  const result = {};
  for (const [key, fallback, max] of [['mediaConcurrency', 1, 2], ['summaryConcurrency', 2, 4]]) {
    const value = raw[key] === undefined ? previous[key] ?? fallback : raw[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('转写并发需为1至2，总结并发需为1至4');
    result[key] = value;
  }
  return result;
}

