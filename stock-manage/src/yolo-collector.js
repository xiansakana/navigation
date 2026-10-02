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

export function createYoloCollector({ store, quotes, logger = console, now = () => new Date() }) {
  let timer = null;
  let running = false;

  async function captureUsers(users, triggerKind) {
    if (!users.length) return null;
    const requestedAt = now().toISOString();
    const attempts = users.map((user) => ({ user, id: store.beginAttempt(user.userId, triggerKind, requestedAt) }));
    let snapshot;
    try {
      snapshot = triggerKind === 'summary' ? await quotes.getQqqPreviousSessionSummary() : await quotes.getQqqOptionChains();
      const receivedAt = now().toISOString();
      const providerMs = Date.parse(snapshot.capturedAt);
      const detail = { finishedAt: receivedAt, providerAt: snapshot.capturedAt, source: snapshot.source,
        durationMs: Date.parse(receivedAt) - Date.parse(requestedAt),
        lagMs: Number.isFinite(providerMs) ? Date.parse(receivedAt) - providerMs : null };
      let invalid = null;
      if (triggerKind !== 'summary') {
        if (!Number.isFinite(providerMs) || snapshot.timestampOrigin === 'received-fallback') invalid = 'invalid-time';
        else if (detail.lagMs < -60000) invalid = 'future-time';
        else if (detail.lagMs > 30 * 60 * 1000) invalid = 'stale';
        else if (!isUsOptionMarketOpen(new Date(providerMs))) invalid = 'off-session';
      }
      if (invalid) {
        const error = `未入分钟库：${invalid}（时间无效、过期或不在常规交易时段）`;
        attempts.forEach(({ user, id }) => {
          store.finishAttempt(user.userId, id, { ...detail, status: invalid, error });
          store.markAttempt(user.userId, error);
        });
        return { ...snapshot, collectionStatus: invalid, savedContracts: 0 };
      }
      let savedContracts = 0;
      attempts.forEach(({ user, id }) => {
        const saved = store.commitCaptureAttempt(user.userId, id, { ...snapshot, requestedAt, receivedAt }, detail);
        savedContracts += saved.contractCount;
      });
      return { ...snapshot, collectionStatus: savedContracts ? 'success' : 'duplicate', savedContracts };
    } catch (error) {
      const finishedAt = now().toISOString();
      attempts.forEach(({ user, id }) => {
        store.finishAttempt(user.userId, id, { status: 'error', finishedAt,
          durationMs: Date.parse(finishedAt) - Date.parse(requestedAt), error: error.message || String(error) });
        store.markAttempt(user.userId, error.message || String(error));
      });
      throw error;
    }
  }

  async function tick(force = false, onlyUserId = null) {
    if (running) { if (force) throw new Error('采集器正在运行，请稍后再试'); return null; }
    if (!force && !isUsOptionMarketOpen(now())) return null;
    const nowMs = now().getTime();
    const users = (onlyUserId ? [{ userId: onlyUserId, intervalSeconds: 0, lastAttemptAt: null }] : store.enabledUsers())
      .filter((user) => force || !user.lastAttemptAt || nowMs - Date.parse(user.lastAttemptAt) >= user.intervalSeconds * 1000);
    if (!users.length) return null;
    running = true;
    try { return await captureUsers(users, force ? 'manual' : 'scheduled'); }
    finally { running = false; }
  }

  async function backfillPreviousSession(userId) {
    if (running) throw new Error('采集器正在写入，请稍后重试');
    running = true;
    try { return await captureUsers([{ userId }], 'summary'); }
    finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    store.recoverAttempts();
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
