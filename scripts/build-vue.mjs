import { createRequire } from 'node:module';
import path from 'node:path';
import { readFile, readdir, unlink } from 'node:fs/promises';

const [outdir, ...entryPoints] = process.argv.slice(2);
if (!outdir || !entryPoints.length) throw new Error('Usage: build-vue.mjs <output-dir> <entry> [...]');
const require = createRequire(path.resolve('package.json'));
const { build } = require('esbuild');
const { parse, compileScript } = require('vue/compiler-sfc');

// Prune generated leftovers without ever deleting a chunk that a sibling entry
// still imports. This must run *after* the build: earlier builds are separate
// processes, and a single-entry build has splitting disabled, so anything we
// delete up front would never be regenerated.
async function pruneGenerated(outdir) {
  let names;
  try { names = await readdir(outdir); } catch { return; }
  const jsFiles = names.filter(name => name.endsWith('.js'));
  const referenced = new Set();
  for (const name of jsFiles) {
    const source = await readFile(path.join(outdir, name), 'utf8').catch(() => '');
    for (const match of source.matchAll(/\.\/(chunk-[A-Za-z0-9_-]+\.js)/g)) referenced.add(match[1]);
  }
  const stale = jsFiles.filter(name =>
    (/^chunk-/.test(name) && !referenced.has(name)) || name === 'bookkeeping-entries-view.js');
  if (!stale.length) return;
  await Promise.all(stale.map(name => unlink(path.join(outdir, name))));
  console.log('[build-vue] removed ' + stale.length + ' stale generated file(s)');
}

const singleFileComponents = {
  name: 'vue-single-file-components',
  setup(build) {
    build.onLoad({ filter: /\.vue$/ }, async ({ path: filename }) => {
      const { descriptor, errors } = parse(await readFile(filename, 'utf8'), { filename });
      if (errors.length) throw errors[0];
      if (!descriptor.scriptSetup || descriptor.styles.length || descriptor.customBlocks.length) {
        throw new Error(filename + ' requires <script setup> and external styles');
      }
      const id = path.relative(process.cwd(), filename).replaceAll('\\', '/');
      const { content } = compileScript(descriptor, { id, inlineTemplate: true });
      return { contents: content, loader: descriptor.scriptSetup.lang === 'ts' ? 'ts' : 'js' };
    });
  },
};

await build({
  entryPoints,
  outdir,
  splitting: entryPoints.length > 1,
  bundle: true,
  format: 'esm',
  target: 'es2020',
  minify: true,
  legalComments: 'eof',
  plugins: [singleFileComponents],
  define: {
    'process.env.NODE_ENV': '"production"',
    __VUE_OPTIONS_API__: 'false',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false'
  }
});

await pruneGenerated(outdir);
