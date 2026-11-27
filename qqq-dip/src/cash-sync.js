// Cash polling is independent of quote fetching/monitor state. Each SSE request
// retains its authenticated AsyncLocalStorage context and owns its cleanup.
export function watchCash({ read, send, initialCash, schedule = setInterval, cancel = clearInterval, intervalMs = 2000 }) {
  let previous;
  if (initialCash !== undefined) previous = JSON.stringify(initialCash);
  else {
    try {
      const first = read();
      previous = first && typeof first.then === 'function' ? null : JSON.stringify(first);
    } catch { previous = null; }
  }
  const timer = schedule(async () => {
    try {
      const cash = await read();
      const signature = JSON.stringify(cash);
      if (signature === previous) return;
      await send(cash);
      previous = signature;
    } catch { /* A temporary DB/socket failure must not crash the service. */ }
  }, intervalMs);
  timer?.unref?.();
  return () => cancel(timer);
}
