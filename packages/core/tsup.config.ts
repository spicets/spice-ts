import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    protocol: 'src/protocol/wire/index.ts',
    'step-worker': 'src/analysis/step-worker.ts',
    'step-worker-browser': 'src/analysis/step-worker-browser.ts',
  },
  format: ['esm', 'cjs'],
  // Shorten local bindings as well as whitespace to reduce cold loader/compiler
  // work. Keep public function/class names for diagnostics and source maps for
  // debugging; do not minify syntax or alter numeric expressions.
  esbuildOptions(options) {
    options.minifyWhitespace = true;
    options.minifyIdentifiers = true;
    options.keepNames = true;
  },
  external: ['eecircuit-engine'],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  clean: true,
  sourcemap: true,
});
