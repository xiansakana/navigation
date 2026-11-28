import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../qq-bot/src/config.js';
import { getPostgresMonitoring } from '../qq-bot/src/postgres.js';
import { createPostgresCodexStore } from '../shared/codex/codex-postgres-store.js';
import { createCodexStore } from '../shared/codex/codex-store.js';
import { getDatabase, closeDatabase } from '../shared/db/index.js';
import { readCodexStatus } from '../shared/codex/codex-control.js';
import { readCodexUsage } from '../shared/codex/codex-usage.js';

const run = promisify(execFile);
const binary = '/usr/bin/codex';
const versions = '/var/lib/codex-cli-versions';
const stable = /^\d+\.\d+\.\d+$/;
const registry = 'https://registry.npmjs.org/';
const launcher = 'node_modules/@openai/codex/bin/codex.js';
let config;
let database;
let phase = 'configuration';

async function version(file) {
  const { stdout } = await run(file, ['--version'], { timeout: 10000 });
  const value = /^codex-cli (\d+\.\d+\.\d+)$/.exec(stdout.trim())?.[1];
  if (!value) throw new Error('Unexpected CLI version');
  return value;
}

function newer(candidate, current) {
  const old = current.split('.').map(Number);
  const difference = candidate.split('.').map((part, index) => Number(part) - old[index]);
  return (difference.find(value => value !== 0) ?? 0) > 0;
}

async function verify(file, expected) {
  if (await version(file) !== expected) throw new Error('Unexpected installed version');
  const candidate = { ...config, binary: file };
  const status = await readCodexStatus(candidate);
  if (!status.account.loggedIn || !status.models.length) throw new Error('CLI account or catalog unavailable');
  const usage = await readCodexUsage(candidate);
  if (!usage.rateLimits && !Object.keys(usage.rateLimitsByLimitId ?? {}).length) throw new Error('Quota unavailable');
  console.log(`Codex ${expected} verified: login, model list (${status.models.length}), quota`);
}

async function idle(store) {
  if (await store.hasActiveJobs()) return false;
  // Include stand-alone sessions and knowledge workers that use the same CLI.
  for (const pid of (await fs.readdir('/proc')).filter(name => /^\d+$/.test(name))) {
    try {
      if ((await fs.readFile(`/proc/${pid}/comm`, 'utf8')).trim() === 'codex') return false;
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
    }
  }
  return true;
}

async function install(candidate) {
  const directory = path.join(versions, candidate);
  const file = path.join(directory, launcher);
  try { await fs.access(file); return file; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(versions, { recursive: true, mode: 0o755 });
  const staging = await fs.mkdtemp(path.join(versions, '.staging-'));
  try {
    await run('/usr/bin/npm', ['install', '--prefix', staging, '--registry', registry, '--no-audit', '--no-fund', `@openai/codex@${candidate}`], { timeout: 360000 });
    if (await version(path.join(staging, launcher)) !== candidate) throw new Error('Invalid package');
    await fs.chmod(staging, 0o755);
    await fs.rename(staging, directory);
    return file;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function switchTo(target) {
  const staging = await fs.mkdtemp('/usr/bin/.codex-update-');
  const link = path.join(staging, 'codex');
  try {
    await fs.symlink(target, link);
    await fs.rename(link, binary);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function main() {
  config = loadConfig().codex;
  if (config.binary !== binary || !(await fs.lstat(binary)).isSymbolicLink()) throw new Error('Unsupported production CLI path');
  const current = await version(binary);
  if (process.argv.includes('--verify-current')) {
    phase = 'live verification';
    await verify(binary, current);
    database = await getPostgresMonitoring();
    const store = database ? createPostgresCodexStore(database) : createCodexStore(getDatabase());
    console.log(`Codex queue idle: ${!await store.hasActiveJobs()}`);
    return;
  }

  phase = 'stable release lookup';
  const { stdout } = await run('/usr/bin/npm', ['view', '@openai/codex@latest', 'version', '--json', '--registry', registry, '--fetch-timeout=15000', '--fetch-retries=1'], { timeout: 45000 });
  const candidate = JSON.parse(stdout);
  if (typeof candidate !== 'string' || !stable.test(candidate)) throw new Error('Invalid stable release');
  if (!newer(candidate, current)) {
    console.log(`Codex ${current} is current (stable ${candidate})`);
    return;
  }

  phase = 'check the task queue';
  database = await getPostgresMonitoring();
  const store = database ? createPostgresCodexStore(database) : createCodexStore(getDatabase());
  if (!await idle(store)) { console.log('Codex is busy; upgrade deferred to the next check'); return; }
  const previous = await fs.realpath(binary);
  phase = 'install isolated candidate';
  const target = await install(candidate);
  phase = 'verify isolated candidate';
  await verify(target, candidate);
  phase = 'recheck the task queue';
  if (!await idle(store)) { console.log('Codex is busy; upgrade deferred to the next check'); return; }
  if (await fs.realpath(binary) !== previous) throw new Error('CLI changed during verification');

  phase = 'switch CLI version';
  await switchTo(target);
  try {
    if (await version(binary) !== candidate) throw new Error('CLI switch failed');
  } catch (error) {
    await switchTo(previous);
    throw error;
  }
  console.log(`Codex upgraded from ${current} to ${candidate}. Previous executable: ${previous}`);
}

try { await main(); }
catch {
  console.error(`Codex upgrade failed during ${phase}. Check the service journal and current CLI version.`);
  process.exitCode = 1;
} finally {
  if (database) await database.close();
  closeDatabase();
}
