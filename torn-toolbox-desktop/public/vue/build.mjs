import { createRequire } from 'node:module';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(here, '../..');
const portalRoot = path.resolve(serviceRoot, '../portal');
const portalRequire = createRequire(path.join(portalRoot, 'package.json'));
const { build } = portalRequire('esbuild');
const { parse, compileScript } = portalRequire('vue/compiler-sfc');
const vueEntry = path.join(portalRoot, 'node_modules/vue/dist/vue.esm-bundler.js');

const singleFileComponents = {
  name: 'vue-single-file-components',
  setup(build) {
    build.onLoad({ filter: /\.vue$/ }, async ({ path: filename }) => {
      const { descriptor, errors } = parse(await readFile(filename, 'utf8'), { filename });
      if (errors.length) throw errors[0];
      if (!descriptor.scriptSetup || descriptor.styles.length || descriptor.customBlocks.length) {
        throw new Error(filename + ' requires <script setup> and external styles');
      }
      const id = path.relative(serviceRoot, filename).replaceAll('\\', '/');
      const { content } = compileScript(descriptor, { id, inlineTemplate: true });
      return { contents: content, loader: descriptor.scriptSetup.lang === 'ts' ? 'ts' : 'js' };
    });
  },
};

await build({
  entryPoints: [path.join(here, 'main.js')],
  outfile: path.join(serviceRoot, 'public/generated/main.js'),
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  legalComments: 'eof',
  plugins: [singleFileComponents],
  alias: { vue: vueEntry },
  define: {
    'process.env.NODE_ENV': '"production"',
    __VUE_OPTIONS_API__: 'false',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false'
  }
});
