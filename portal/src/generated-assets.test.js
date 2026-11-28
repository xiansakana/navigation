import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../public/generated/', import.meta.url);

// Regression guard: a previous cleanup step deleted esbuild shared chunks that
// single-entry builds never regenerate, which silently broke every view that
// imported them. Generated output is only present after `npm run build:views`.
test('generated entries never import a chunk that is missing', () => {
    if (!existsSync(root)) return;
    const files = readdirSync(root).filter(name => name.endsWith('.js'));
    const missing = [];
    for (const file of files) {
        const source = readFileSync(new URL(file, root), 'utf8');
        for (const match of source.matchAll(/["'`](\.\/(chunk-[A-Za-z0-9_-]+\.js))["'`]/g)) {
            if (!existsSync(new URL(match[1], root))) missing.push(`${file} -> ${match[1]}`);
        }
    }
    assert.deepEqual(missing, []);
});
