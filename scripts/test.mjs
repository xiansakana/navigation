import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const areas = ['portal', 'stock-manage', 'qqq-dip', 'qq-bot', 'torn-toolbox-desktop', 'shared'];
const selected = process.argv.slice(2);
if (selected.some(area => !areas.includes(area))) throw new Error('Unknown test area');
function discover(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'data' ? [] : discover(file);
    return entry.name.endsWith('.test.js') ? [file] : [];
  });
}
const files = (selected.length ? selected : areas).flatMap(area => discover(path.join(root, area === 'shared' ? area : area + '/src'))).sort();
if (!files.length) throw new Error('No tests found');
console.log(`Running ${files.length} test files with ${process.version}`);
// Tests referencing distribution scripts always resolve from the repository root.
const child = spawn(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', env: process.env });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
