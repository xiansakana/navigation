(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const pct = (value) => value == null ? '—' : `${Number(value).toFixed(1)}%`;
  const count = (value) => value == null ? '—' : Number(value).toLocaleString('zh-CN');
  function bytes(value) {
    if (value == null) return '—';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let n = Math.max(0, value), i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
  }
  const rate = (value) => value == null ? '等待采样' : `${bytes(value)}/s`;
  function duration(seconds) {
    if (seconds == null) return '—';
    const s = Math.max(0, seconds);
    return s >= 86400 ? `${Math.floor(s / 86400)} 天 ${Math.floor(s % 86400 / 3600)} 小时` : s >= 3600 ? `${Math.floor(s / 3600)} 小时 ${Math.floor(s % 3600 / 60)} 分` : `${Math.floor(s / 60)} 分`;
  }
  const meter = (value) => `<div class="resource-meter ${value >= 95 ? 'danger' : value >= 85 ? 'warn' : ''}"><i style="width:${Math.min(100, Math.max(0, Number(value) || 0))}%"></i></div>`;
  const badge = (status, good) => `<span class="resource-badge ${good ? 'good' : 'bad'}">${esc(status)}</span>`;
  const empty = (cols, message) => `<tr><td colspan="${cols}" class="resource-empty">${esc(message)}</td></tr>`;
  let snapshot = null, paused = false, busy = false, timer = null;

  function chart(id, points, fields, fixedMax) {
    const usable = points.filter((p) => fields.some((f) => p[f] != null));
    if (!usable.length) { $(id).innerHTML = '<p class="resource-empty">等待下一次采样</p>'; return; }
    const max = fixedMax || Math.max(1, ...usable.flatMap((p) => fields.map((f) => p[f] || 0))) * 1.15;
    const start = points[0].at, end = points.at(-1).at;
    const x = (p) => 45 + (end === start ? 0 : (p.at - start) / (end - start) * 545);
    const y = (v) => 155 - Math.min(max, Math.max(0, v)) / max * 140;
    let svg = '<svg viewBox="0 0 610 190" role="img" aria-label="最近采样趋势">';
    for (const fraction of [0, .5, 1]) {
      const value = max * fraction, height = y(value);
      svg += `<line class="grid" x1="45" x2="590" y1="${height}" y2="${height}"/><text x="0" y="${height + 4}">${esc(fixedMax ? Math.round(value) + '%' : bytes(value))}</text>`;
    }
    fields.forEach((field, i) => {
      // Separate missing samples into segments instead of drawing invented zeroes.
      let segment = [];
      const flush = () => {
        if (segment.length === 1) svg += `<circle cx="${x(segment[0])}" cy="${y(segment[0][field])}" r="3" fill="${i ? '#a78bfa' : 'var(--accent)'}"/>`;
        if (segment.length > 1) svg += `<polyline class="${i ? 'mem' : 'cpu'}" points="${segment.map((p) => `${x(p)},${y(p[field])}`).join(' ')}"/>`;
        segment = [];
      };
      points.forEach((p) => { if (p[field] == null) flush(); else segment.push(p); }); flush();
    });
    const time = (at) => new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
    svg += `<text x="45" y="180">${esc(time(start))}</text><text x="590" y="180" text-anchor="end">${esc(time(end))}</text></svg>`;
    $(id).innerHTML = svg;
  }

  function renderServices() {
    if (!snapshot) return;
    const term = $('service-search').value.trim().toLowerCase();
    const processes = snapshot.processes.filter((p) => `${p.name} ${p.status}`.toLowerCase().includes(term));
    $('processes').innerHTML = processes.map((p) => `<tr><td><strong>${esc(p.name)}</strong><small>${esc(p.mode)}</small></td><td>${badge(p.status, p.status === 'online')}</td><td>${pct(p.cpuPercent)}</td><td>${bytes(p.rssBytes ?? p.memoryBytes)}</td><td>${p.status === 'online' && p.startedAt ? duration((snapshot.collectedAt - p.startedAt) / 1000) : '—'}</td><td>${count(p.restarts)}</td><td>${count(p.pid)} / ${count(p.threads)}</td><td>${count(p.fds)}</td></tr>`).join('') || empty(8, term ? '没有匹配的应用进程' : '未采集到 PM2 应用进程');
    const containers = snapshot.containers.filter((p) => `${p.name} ${p.state} ${p.image}`.toLowerCase().includes(term));
    $('containers').innerHTML = containers.map((p) => `<tr><td><strong>${esc(p.name)}</strong><small title="${esc(p.image)}">${esc(p.image)}</small></td><td>${badge(p.state, p.state === 'running' && !p.status.includes('unhealthy'))}<small>${esc(p.status)}</small></td><td>${pct(p.cpuPercent)}</td><td>${esc(p.memory || '—')}</td><td>${pct(p.memoryPercent)}</td><td>${esc(p.networkIo || '—')}</td><td>${esc(p.blockIo || '—')}</td><td>${count(p.pids)}</td></tr>`).join('') || empty(8, term ? '没有匹配的容器' : '未采集到 Docker 容器');
  }

  function render(data) {
    snapshot = data;
    $('host-detail').textContent = `${data.host} · ${data.platform} · ${data.cpuCount} 核 · 运行 ${duration(data.uptimeSeconds)}`;
    const mostUsedDisk = data.disks.length ? data.disks.reduce((a, b) => a.percent > b.percent ? a : b) : null;
    const stats = [
      ['CPU 使用率', pct(data.cpuPercent), data.cpuPercent, `${data.cpuCount} 核 · ${data.model}`],
      ['内存使用率', pct(data.memory.percent), data.memory.percent, `${bytes(data.memory.used)} / ${bytes(data.memory.total)} · 可用 ${bytes(data.memory.available)}`],
      ['磁盘最高使用率', pct(mostUsedDisk?.percent), mostUsedDisk?.percent, mostUsedDisk ? `${mostUsedDisk.mount} · 可用 ${bytes(mostUsedDisk.available)}` : '文件系统信息不可用'],
      ['系统负载', data.load[0].toFixed(2), data.load[0] / Math.max(1, data.cpuCount) * 100, `1 / 5 / 15 分钟：${data.load.map((n) => n.toFixed(2)).join(' / ')}`],
      ['Swap 使用', bytes(data.memory.swapUsed), data.memory.swapPercent, data.memory.swapTotal === 0 ? '未配置 Swap' : `总量 ${bytes(data.memory.swapTotal)}`],
      ['应用在线', data.sources?.pm2 === false ? '不可用' : `${data.processes.filter((p) => p.status === 'online').length} / ${data.processes.length}`, null, 'PM2 管理的应用进程'],
      ['容器运行', data.sources?.docker === false ? '不可用' : `${data.containers.filter((p) => p.state === 'running').length} / ${data.containers.length}`, null, 'Docker 容器 · 含停止的容器'],
      ['系统文件句柄', count(data.openFiles?.allocated), null, `上限 ${count(data.openFiles?.limit)}`]
    ];
    $('overview').innerHTML = stats.map(([label, value, usage, detail]) => `<article class="resource-stat"><span class="resource-label">${esc(label)}</span><strong>${esc(value)}</strong>${usage == null ? '' : meter(usage)}<small>${esc(detail)}</small></article>`).join('');
    $('service-summary').textContent = `${data.processes.length} 个应用进程 · ${data.containers.length} 个容器`;
    renderServices();
    $('disks').innerHTML = data.disks.map((d) => `<tr><td><strong>${esc(d.mount)}</strong><small>${esc(d.device)}</small></td><td>${bytes(d.used)} / ${bytes(d.total)}</td><td>${bytes(d.available)}</td><td>${pct(d.percent)}${meter(d.percent)}</td><td>${pct(d.inodePercent)}${meter(d.inodePercent)}</td><td>${esc(d.fsType)}</td></tr>`).join('') || empty(6, '文件系统信息不可用');
    $('interfaces').innerHTML = data.network.map((n) => `<tr><td>${esc(n.name)}</td><td>${rate(n.rxBytesPerSecond)}</td><td>${rate(n.txBytesPerSecond)}</td><td>${count(n.rxErrors + n.txErrors)} / ${count(n.rxDropped + n.txDropped)}</td></tr>`).join('') || empty(4, '网络接口统计不可用');
    $('io').innerHTML = data.diskIo.map((d) => `<tr><td>${esc(d.name)}</td><td>${rate(d.readBytesPerSecond)}</td><td>${rate(d.writeBytesPerSecond)}</td></tr>`).join('') || empty(3, '磁盘 I/O 统计不可用');
    chart('usage-chart', data.history, ['cpuPercent', 'memoryPercent'], 100);
    chart('network-chart', data.history, ['rx', 'tx']);
    $('warnings').textContent = data.warnings.join('；'); $('warnings').classList.toggle('hidden', !data.warnings.length);
    $('updated-at').textContent = `采样时间 ${new Date(data.collectedAt).toLocaleString('zh-CN')}`;
  }

  async function refresh() {
    clearTimeout(timer);
    if (busy) return;
    busy = true; $('refresh').disabled = true;
    try {
      const response = await fetch('/api/resources/metrics', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || '资源监控加载失败');
      render(data.snapshot); $('error').classList.add('hidden');
      $('live-state').classList.toggle('paused', paused);
      $('live-state').textContent = paused ? '已暂停' : '实时采样';
    } catch (error) {
      $('error').textContent = `${error.message}${snapshot ? '，当前保留上次采样，数据尚未更新。' : '，请稍后刷新重试。'}`;
      $('error').classList.remove('hidden'); $('live-state').textContent = '数据未更新';
      $('live-state').classList.add('paused');
    } finally {
      busy = false; $('refresh').disabled = false; window.navigationSkeleton?.finish();
      if (!paused && !document.hidden) timer = setTimeout(refresh, 10000);
    }
  }
  $('refresh').addEventListener('click', refresh);
  $('service-search').addEventListener('input', renderServices);
  $('pause').addEventListener('click', () => {
    paused = !paused; $('pause').textContent = paused ? '恢复刷新' : '暂停刷新';
    $('pause').setAttribute('aria-pressed', String(paused)); $('live-state').classList.toggle('paused', paused);
    $('live-state').textContent = paused ? '已暂停' : '实时采样'; clearTimeout(timer); if (!paused) refresh();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else if (!paused) refresh(); });
  refresh();
})();
