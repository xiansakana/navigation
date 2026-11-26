import { createRequire } from 'node:module';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

const [outdir, ...entryPoints] = process.argv.slice(2);
if (!outdir || !entryPoints.length) throw new Error('Usage: build-vue.mjs <output-dir> <entry> [...]');
const require = createRequire(path.resolve('package.json'));
const { build } = require('esbuild');
const { parse, compileScript } = require('vue/compiler-sfc');

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
