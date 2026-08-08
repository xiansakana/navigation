import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

export function resolveRepoRoot() {
  return REPO_ROOT;
}

export function resolveDbPath(override) {
  if (process.env.NAVIGATION_DB_PATH) {
    const envPath = process.env.NAVIGATION_DB_PATH;
    return path.isAbsolute(envPath) ? envPath : path.join(REPO_ROOT, envPath);
  }
  if (override) {
    return path.isAbsolute(override) ? override : path.join(REPO_ROOT, override);
  }
  return path.join(REPO_ROOT, 'data', 'navigation.db');
}

export function defaultRbacJsonPath() {
  return path.join(REPO_ROOT, 'portal', 'data', 'rbac.json');
}

export function defaultPortfolioJsonPath() {
  return path.join(REPO_ROOT, 'stock-manage', 'data', 'portfolio.json');
}
