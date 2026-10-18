import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function integrationConfig() {
  const file = process.env.NAVIGATION_INTEGRATIONS_CONFIG || fileURLToPath(new URL('../data/integrations.json', import.meta.url));
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('共享集成配置无法读取'); }
}

export function codexConfig() {
  // QQ_CODEX_CONFIG remains an explicit legacy override for existing installations/tests.
  const file = process.env.NAVIGATION_CODEX_CONFIG || process.env.QQ_CODEX_CONFIG || fileURLToPath(new URL('../data/codex.json', import.meta.url));
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw.codex || raw;
  } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Codex 执行配置无法读取'); }
}
