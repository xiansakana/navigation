import os from 'node:os';
import { readFile, readdir, statfs, access } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hasPermission } from './rbac.js';

const runFile = promisify(execFile);
const number = (value) => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const percent = (used, total) => total > 0 ? Math.min(100, Math.max(0, used / total * 100)) : null;
const read = async (file) => { try { return await readFile(file, 'utf8'); } catch { return null; } };

export function canViewResources(session) {
  return !!session && !session.isGuest && hasPermission(session.permissions || [], 'service:resources:edit');
}

export function parseMemory(text = '') {
  const fields = Object.fromEntries([...text.matchAll(/^(\w+):\s+(\d+)\s+kB/gm)].map((m) => [m[1], Number(m[2]) * 1024]));
  const total = fields.MemTotal ?? os.totalmem();
  const available = fields.MemAvailable ?? fields.MemFree ?? os.freemem();
  const swapTotal = fields.SwapTotal ?? null;
  const swapUsed = swapTotal === null ? null : swapTotal - (fields.SwapFree ?? 0);
  return { total, available, used: total - available, percent: percent(total - available, total), cached: fields.Cached ?? null,
    swapTotal, swapUsed, swapPercent: percent(swapUsed, swapTotal) };
}

export function parseNetwork(text = '') {
  return text.split('\n').flatMap((line) => {
    const match = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (!match) return [];
    const values = match[2].trim().split(/\s+/).map(Number);
    if (values.length < 16 || !values.every(Number.isFinite)) return [];
    return [{ name: match[1].trim(), rxBytes: values[0], rxPackets: values[1], rxErrors: values[2], rxDropped: values[3],
      txBytes: values[8], txPackets: values[9], txErrors: values[10], txDropped: values[11] }];
  });
}

export function parseDiskIo(text = '') {
  return text.trim().split('\n').flatMap((line) => {
    const v = line.trim().split(/\s+/);
    if (!/^(?:sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/.test(v[2]) || v.length < 14) return [];
    return [{ name: v[2], readBytes: Number(v[5]) * 512, writeBytes: Number(v[9]) * 512, ioMs: Number(v[12]) }];
  });
}

export function counterRate(current, previous, elapsedMs) {
  return previous == null || current == null || elapsedMs <= 0 || current < previous ? null : (current - previous) / (elapsedMs / 1000);
}

export function cpuTotals(cpus) {
  return cpus.reduce((out, cpu) => ({ idle: out.idle + cpu.times.idle,
    total: out.total + Object.values(cpu.times).reduce((sum, v) => sum + v, 0) }), { idle: 0, total: 0 });
}

export function publicPm2(items) {
  // Never send PM2's environment, arguments, paths or log configuration to a browser.
  return items.slice(0, 128).map((p) => ({ id: number(p.pm_id), name: String(p.name || '未命名'), pid: number(p.pid),
    status: String(p.pm2_env?.status || 'unknown'), cpuPercent: number(p.monit?.cpu), memoryBytes: number(p.monit?.memory),
    startedAt: number(p.pm2_env?.pm_uptime), restarts: number(p.pm2_env?.restart_time), mode: String(p.pm2_env?.exec_mode || 'unknown') }));
}

export function parsePm2Output(text) {
  // Some PM2 versions print upgrade notices before their JSON output.
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('[')) continue;
    try { const value = JSON.parse(line); if (Array.isArray(value)) return value; } catch { /* Notice line. */ }
  }
  throw new Error('PM2 未返回有效数据');
}

export function publicContainers(ps, stats) {
  const byId = new Map(stats.map((s) => [s.ID, s]));
  return ps.slice(0, 128).map((p) => {
    const s = byId.get(p.ID);
    return { id: String(p.ID || ''), name: String(p.Names || ''), image: String(p.Image || ''), state: String(p.State || 'unknown'),
      status: String(p.Status || ''), cpuPercent: s ? number(String(s.CPUPerc).replace('%', '')) : null,
      memory: s?.MemUsage || null, memoryPercent: s ? number(String(s.MemPerc).replace('%', '')) : null,
      networkIo: s?.NetIO || null, blockIo: s?.BlockIO || null, pids: s ? number(s.PIDs) : null };
  });
}

async function command(file, args) {
  const { stdout } = await runFile(file, args, { timeout: 8000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  return stdout;
}
const jsonLines = (text) => text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

async function processDetails(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || os.platform() !== 'linux') return {};
  const status = await read(`/proc/${pid}/status`);
  let fds = null;
  try { fds = (await readdir(`/proc/${pid}/fd`)).length; } catch { /* Process exited or inaccessible. */ }
  const field = (name) => number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(status || '')?.[1]);
  return { rssBytes: field('VmRSS') === null ? null : field('VmRSS') * 1024, threads: field('Threads'), fds };
}

async function disks() {
  const mounts = await read('/proc/mounts');
  const candidates = mounts ? mounts.trim().split('\n').map((line) => line.split(' '))
    .filter((v) => /^(ext[234]|xfs|btrfs|zfs|nfs4?)$/.test(v[2]) || (v[2] === 'overlay' && v[1] === '/')) : [['local', process.cwd(), 'unknown']];
  const seen = new Set();
  const selected = candidates.filter((v) => {
    if (seen.has(v[0])) return false;
    seen.add(v[0]); return true;
  }).slice(0, 16);
  const results = await Promise.all(selected.map(async ([device, encodedMount, fsType]) => {
    const mount = encodedMount.replace(/\\([0-7]{3})/g, (_, v) => String.fromCharCode(parseInt(v, 8)));
    try {
      const s = await statfs(mount);
      const total = s.blocks * s.bsize, free = s.bfree * s.bsize, available = s.bavail * s.bsize;
      return { device, mount, fsType, total, used: total - free, available, percent: percent(total - free, total),
        inodes: s.files, freeInodes: s.ffree, inodePercent: percent(s.files - s.ffree, s.files) };
    } catch { return null; }
  }));
  return results.filter(Boolean);
}

async function readHost() {
  const [memory, net, io, filesystems, fileNr] = await Promise.all([
    read('/proc/meminfo'), read('/proc/net/dev'), read('/proc/diskstats'), disks(), read('/proc/sys/fs/file-nr')
  ]);
  const files = fileNr?.trim().split(/\s+/).map(Number);
  const network = parseNetwork(net || '');
  await Promise.all(network.map(async (item) => {
    try { await access(`/sys/class/net/${item.name}/device`); item.external = true; }
    catch { item.external = false; }
  }));
  return { memory: parseMemory(memory || ''), network, diskIo: parseDiskIo(io || ''), disks: filesystems,
    openFiles: files ? { allocated: files[0] - files[1], limit: files[2] } : null,
    cpu: cpuTotals(os.cpus()), cpuCount: os.cpus().length, model: os.cpus()[0]?.model || '', platform: os.platform(),
    uptimeSeconds: os.uptime(), load: os.loadavg(), host: os.hostname(), collectedAt: Date.now() };
}

async function readServices() {
  const providers = await Promise.allSettled([
    access(path.join(process.env.PM2_HOME || path.join(os.homedir(), '.pm2'), 'rpc.sock'))
      .then(() => command('pm2', ['jlist'])).then(parsePm2Output),
    command('docker', ['ps', '-a', '--format', '{"ID":{{json .ID}},"Names":{{json .Names}},"Image":{{json .Image}},"State":{{json .State}},"Status":{{json .Status}}}']).then(jsonLines),
    command('docker', ['stats', '--no-stream', '--format', '{{json .}}']).then(jsonLines)
  ]);
  const services = providers[0].status === 'fulfilled' ? publicPm2(providers[0].value) : [];
  await Promise.all(services.map(async (p) => Object.assign(p, await processDetails(p.pid))));
  // docker stats IDs are short; ps IDs must use the same key for lookup.
  const stats = providers[2].status === 'fulfilled' ? providers[2].value : [];
  const ps = providers[1].status === 'fulfilled' ? providers[1].value.map((p) => ({ ...p, ID: p.ID.slice(0, 12) })) : [];
  return { processes: services, containers: publicContainers(ps, stats),
    sources: { pm2: providers[0].status === 'fulfilled', docker: providers[1].status === 'fulfilled', dockerStats: providers[2].status === 'fulfilled' },
    warnings: providers.flatMap((result, i) => result.status === 'rejected'
    ? [['PM2 服务信息暂不可用', 'Docker 容器信息暂不可用', 'Docker 资源统计暂不可用'][i]] : []) };
}

export function createResourceMonitor({ hostReader = readHost, serviceReader = readServices, clock = Date.now, cacheMs = 10000 } = {}) {
  let previous = null, cached = null, pending = null, updatedAt = 0;
  const history = [];
  return {
    async snapshot() {
      if (cached && clock() - updatedAt < cacheMs) return cached;
      if (pending) return pending;
      pending = (async () => {
        const [host, service] = await Promise.all([hostReader(), serviceReader()]);
        const elapsed = previous ? host.collectedAt - previous.collectedAt : 0;
        const priorCpu = previous?.cpu;
        const delta = priorCpu ? host.cpu.total - priorCpu.total : 0;
        const cpuPercent = delta > 0 ? percent(delta - (host.cpu.idle - priorCpu.idle), delta) : null;
        const rates = (items, old, fields) => items.map((item) => {
          const prior = old?.find((v) => v.name === item.name);
          return { ...item, ...Object.fromEntries(fields.map((field) => [`${field}PerSecond`, counterRate(item[field], prior?.[field], elapsed)])) };
        });
        const network = rates(host.network, previous?.network, ['rxBytes', 'txBytes']);
        const diskIo = rates(host.diskIo, previous?.diskIo, ['readBytes', 'writeBytes']);
        const traffic = (field) => {
          const values = network.filter((v) => v.external).map((v) => v[field]);
          return values.length && values.every((v) => v !== null) ? values.reduce((sum, v) => sum + v, 0) : null;
        };
        history.push({ at: host.collectedAt, cpuPercent, memoryPercent: host.memory.percent, load1: host.load[0], rx: traffic('rxBytesPerSecond'), tx: traffic('txBytesPerSecond') });
        if (history.length > 120) history.shift();
        cached = { ...host, cpu: undefined, cpuPercent, network, diskIo, ...service, history: history.slice(), intervalSeconds: cacheMs / 1000 };
        if (host.platform !== 'linux') cached.warnings = [...cached.warnings, '当前非 Linux 系统，部分服务器指标不可用'];
        previous = host; updatedAt = clock();
        return cached;
      })();
      try { return await pending; } finally { pending = null; }
    }
  };
}

export async function handleResourceApi(req, res, session, monitor, sendJson) {
  res.setHeader('Cache-Control', 'no-store');
  if (!canViewResources(session)) return sendJson(res, 403, { ok: false, error: '无权查看资源管理' });
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { ok: false, error: '资源管理仅支持查看' });
  }
  try { return sendJson(res, 200, { ok: true, snapshot: await monitor.snapshot() }); }
  catch { return sendJson(res, 503, { ok: false, error: '监控采集暂不可用，请稍后重试' }); }
}
