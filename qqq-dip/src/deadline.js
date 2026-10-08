export async function withDeadline(operation, timeoutMs, label, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label}超时 (${timeoutMs / 1000}s)`);
      error.name = 'TimeoutError';
      reject(error);
      onTimeout?.();
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
