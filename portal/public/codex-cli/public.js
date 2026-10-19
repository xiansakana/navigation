(async function () {
  const status = document.getElementById('public-status');
  try {
    const response = await fetch('/api/codex-cli/public-status', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '公开入口暂不可用');
    status.textContent = '浏览入口正常。' + data.description;
  } catch (error) { status.textContent = error.message; }
})();
