import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Source tests pin the facade to the worker in dist/, mirroring the define that
// scripts/build.ts injects into dist/index.js (#412). Without a build there is no
// pin and the facade fails closed on the bundled manifest.
function bundledWorkerPin(): Record<string, string | number> | undefined {
  const manifestPath = fileURLToPath(new URL('./dist/manifest.json', import.meta.url));
  if (!existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return {
    engineBuildId: manifest.engineBuildId,
    sha256: manifest.worker.sha256,
    numericEngineBuildId: manifest.numericWasm.engineBuildId,
    numericSha256: manifest.numericWasm.sha256,
    numericByteLength: manifest.numericWasm.byteLength,
  };
}

const pin = bundledWorkerPin();

export default defineConfig({
  define: pin ? { __SPICE_TS_BUNDLED_WORKER__: JSON.stringify(pin) } : {},
  resolve: {
    alias: {
      '@spice-ts/core/protocol': fileURLToPath(new URL('../core/src/protocol/wire/index.ts', import.meta.url)),
      '@spice-ts/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
});
