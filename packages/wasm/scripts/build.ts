import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { build } from 'tsup';

const directory = new URL('../dist/', import.meta.url);
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });

await build({
  entry: { worker: 'src/worker.ts' },
  format: ['esm'],
  platform: 'neutral',
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: false,
  dts: false,
  noExternal: ['@spice-ts/core', '@spice-ts/core/protocol'],
  external: ['node:worker_threads', 'worker_threads', 'url', 'eecircuit-engine'],
});

const worker = await readFile(new URL('worker.js', directory));
const sha256 = createHash('sha256').update(worker).digest('hex');
const engineBuildId = `spice-ts-js-${sha256.slice(0, 16)}`;
const numericSource = new URL('../native/dense-solver.wasm', import.meta.url);
const numericTarget = new URL('dense-solver.wasm', directory);
await copyFile(numericSource, numericTarget);
const numeric = await readFile(numericTarget);
const numericSha256 = createHash('sha256').update(numeric).digest('hex');
const numericEngineBuildId = `spice-ts-wasm-${numericSha256.slice(0, 16)}`;
const manifest = {
  schemaVersion: 1,
  engineBuildId,
  worker: { url: './worker.js', sha256 },
  numericWasm: {
    url: './dense-solver.wasm',
    sha256: numericSha256,
    byteLength: numeric.byteLength,
    engineBuildId: numericEngineBuildId,
  },
};
await writeFile(new URL('manifest.json', directory), `${JSON.stringify(manifest, null, 2)}\n`);
const bundledWorker = { engineBuildId, sha256, numericEngineBuildId, numericSha256, numericByteLength: numeric.byteLength };

await build({
  define: { __SPICE_TS_BUNDLED_WORKER__: JSON.stringify(bundledWorker) },
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'neutral',
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: false,
  dts: { compilerOptions: { composite: false } },
  noExternal: ['@spice-ts/core/protocol'],
  external: ['node:fs/promises', 'node:worker_threads'],
});
