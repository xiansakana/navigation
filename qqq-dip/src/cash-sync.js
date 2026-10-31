// Cash polling is independent of quote fetching/monitor state. Each SSE request
// retains its authenticated AsyncLocalStorage context and owns its cleanup.
export function watchCash({ read, send, initialCash, schedule = setInterval, cancel = clearInterval, intervalMs = 2000 }) {
  let previous = JSON.stringify(initialCash === undefined ? read() : initialCash);
  const timer = schedule(() => {
    try {
      const cash = read();
      const signature = JSON.stringify(cash);
      if (signature === previous) return;
      send(cash);
      previous = signature;
    } catch { /* A temporary DB/socket failure must not crash the service. */ }
  }, intervalMs);
  timer?.unref?.();
  return () => cancel(timer);
}
