(async function () {
  const status = document.getElementById('public-status');
  const setStatus = text => {
    if (window.CodexShell?.setPublicStatus) window.CodexShell.setPublicStatus(text);
    else if (status) status.textContent = text;
  };
  try {
    const response = await fetch('/api/codex-cli/public-status', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '公开入口暂不可用');
    setStatus('浏览入口正常。' + data.description);
  } catch (error) { setStatus(error.message); }
})();
