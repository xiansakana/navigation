function etParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour12: false,
    hour: '2-digit', minute: '2-digit'
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function isUsOptionMarketOpen(date = new Date()) {
  const parts = etParts(date);
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return minute >= 9 * 60 + 30 && minute < 16 * 60;
}

export function createYoloCollector({ store, quotes, logger = console }) {
  let timer = null;
  let running = false;

  async function captureUsers(users) {
    if (!users.length) return null;
    let snapshot;
    try {
      snapshot = await quotes.getQqq1dteChain();
    } catch (error) {
      users.forEach((user) => store.markAttempt(user.userId, error.message || String(error)));
      throw error;
    }
    users.forEach((user) => store.saveCapture(user.userId, snapshot));
    return snapshot;
  }

  async function tick(force = false, onlyUserId = null) {
    if (running) return null;
    if (!force && !isUsOptionMarketOpen()) return null;
    const now = Date.now();
    const users = (onlyUserId ? [{ userId: onlyUserId, intervalSeconds: 0, lastAttemptAt: null }] : store.enabledUsers())
      .filter((user) => force || !user.lastAttemptAt || now - Date.parse(user.lastAttemptAt) >= user.intervalSeconds * 1000);
    if (!users.length) return null;
    running = true;
    try { return await captureUsers(users); }
    finally { running = false; }
  }

  async function backfillPreviousSession(userId) {
    if (running) throw new Error('采集器正在写入，请稍后重试');
    running = true;
    try {
      const snapshot = await quotes.getQqqPreviousSessionSummary();
      store.saveCapture(userId, snapshot);
      return snapshot;
    } catch (error) {
      store.markAttempt(userId, error.message || String(error));
      throw error;
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => tick().catch((error) => logger.warn(`梭哈采集失败: ${error.message}`)), 15000);
    timer.unref?.();
    tick().catch((error) => logger.warn(`梭哈首次采集失败: ${error.message}`));
  }

  function stop() { if (timer) clearInterval(timer); timer = null; }
  return {
    start,
    stop,
    tick,
    captureNow: (userId) => tick(true, userId),
    backfillPreviousSession,
    isRunning: () => running
  };
}
