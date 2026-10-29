(() => {
  async function refresh(attempt = 0) {
    try {
      const response = await fetch('/api/me/torn-toolbox-access', { credentials: 'same-origin', signal: AbortSignal.timeout(10000) });
      if ([401, 403].includes(response.status)) return;
      if (!response.ok) throw Error('Access lookup unavailable');
      const access = await response.json();
      if (!access.ok) throw Error('Access lookup failed');
      document.getElementById('shopping-card').hidden = access.shopping !== true;
      document.getElementById('chain-card').hidden = access.chain !== true;
    } catch {
      if (attempt < 2) setTimeout(() => refresh(attempt + 1), 1500 * (attempt + 1));
    }
  }
  refresh();
})();
