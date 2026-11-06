import { latestCompletedSession } from './market-hours.js';
import { fetchQuoteResource } from '../../shared/quote-network.js';

const ARCHIVE_URL = 'https://api.github.com/repos/whit3rabbit/fear-greed-data/contents/datasets/cnn_fear_greed.csv';
const SOURCE = 'cnn-public-archive';
const RATINGS = new Set(['extreme fear', 'fear', 'neutral', 'greed', 'extreme greed']);

export function parseSentimentArchive(csv, expectedDate) {
  const [header, ...lines] = csv.trim().split(/\r?\n/);
  if (header !== 'Date,Fear Greed,Rating') throw new Error('情绪归档字段不匹配');
  const days = new Map();
  for (const line of lines) {
    const [date, raw, rating] = line.split(',');
    const score = Number(raw);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > expectedDate || !Number.isFinite(Date.parse(date))
      || !raw?.trim() || !Number.isFinite(score) || score < 0 || score > 100 || !RATINGS.has(rating)) continue;
    days.set(date, { asOf: date, score, rating });
  }
  const rows = [...days.values()].sort((a, b) => a.asOf.localeCompare(b.asOf));
  const latest = rows.at(-1);
  if (!latest) throw new Error('情绪归档没有有效的已完成交易日数据');
  const comparison = rows.at(-6);
  return { ...latest, source: SOURCE, comparisonDate: comparison?.asOf || null,
    change5: comparison ? Math.round((latest.score - comparison.score) * 100) / 100 : null };
}

export function sentimentStatus(value, now = new Date()) {
  if (!value) return null;
  return { ...value, stale: !!value.stale || value.asOf !== latestCompletedSession(now) };
}

export function createSentimentLoader() {
  let cached = null;
  let refreshAfter = 0;
  let expected = '';
  return async function load(previous = null) {
    const now = new Date();
    const session = latestCompletedSession(now);
    if (session === expected && now.getTime() < refreshAfter) return sentimentStatus(cached, now);
    expected = session;
    try {
      const csv = await fetchQuoteResource(ARCHIVE_URL, {
        headers: { Accept: 'application/vnd.github.raw+json' }, json: false, timeoutMs: 6000, retries: 0
      });
      const observation = parseSentimentArchive(csv, session);
      const fallback = cached || previous;
      cached = fallback?.asOf > observation.asOf
        ? { ...fallback, stale: true }
        : { ...observation, fetchedAt: new Date().toISOString() };
    } catch {
      const fallback = cached || previous;
      cached = fallback ? { ...fallback, stale: true } : null;
    }
    const result = sentimentStatus(cached, now);
    refreshAfter = Date.now() + (result && !result.stale ? 15 : 5) * 60000;
    return result;
  };
}
