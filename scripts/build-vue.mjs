import { createRequire } from 'node:module';
import path from 'node:path';

const [outdir, ...entryPoints] = process.argv.slice(2);
if (!outdir || !entryPoints.length) throw new Error('Usage: build-vue.mjs <output-dir> <entry> [...]');
const require = createRequire(path.resolve('package.json'));
const { build } = require('esbuild');

await build({
  entryPoints,
  outdir,
  splitting: entryPoints.length > 1,
  bundle: true,
  format: 'esm',
  target: 'es2020',
  minify: true,
  legalComments: 'eof',
  define: {
    'process.env.NODE_ENV': '"production"',
    __VUE_OPTIONS_API__: 'false',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false'
  }
});
