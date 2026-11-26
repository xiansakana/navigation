export function createSampling({ sample, onSample, onError, onBusy, document, interval = 10000, timeout = 12000 }) {
  let paused = false;
  let disposed = false;
  let timer;
  let pending;

  function schedule() {
    if (!paused && !disposed && !document.hidden) timer = setTimeout(refresh, interval);
  }

  async function refresh() {
    clearTimeout(timer);
    if (disposed || pending) return;
    const request = new AbortController();
    pending = request;
    const expiry = setTimeout(() => request.abort(new Error('资源采样超时')), timeout);
    onBusy(true);
    try {
      const snapshot = await sample(request.signal);
      if (!disposed) onSample(snapshot);
    } catch (error) {
      if (!disposed) onError(error);
    } finally {
      clearTimeout(expiry);
      pending = null;
      if (!disposed) {
        onBusy(false);
        schedule();
      }
    }
  }

  function onVisibility() {
    if (document.hidden) clearTimeout(timer);
    else if (!paused) refresh();
  }

  function dispose() {
    disposed = true;
    clearTimeout(timer);
    pending?.abort();
    document.removeEventListener('visibilitychange', onVisibility);
  }

  document.addEventListener('visibilitychange', onVisibility);
  return {
    refresh,
    dispose,
    setPaused(value) {
      paused = value;
      clearTimeout(timer);
      if (!paused && !document.hidden) refresh();
    }
  };
}
