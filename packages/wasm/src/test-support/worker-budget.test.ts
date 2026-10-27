import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile } from 'vite';

it('bounds file forks independently of host CPU count', async () => {
  const loaded = await loadConfigFromFile(
    { command: 'serve', mode: 'test' },
    fileURLToPath(new URL('../../vitest.config.ts', import.meta.url)),
  );
  // Each file can spawn its own WASM worker in addition to the Vitest fork.
  const config = loaded?.config as { test?: { maxWorkers?: number } } | undefined;
  expect(config?.test?.maxWorkers).toBe(2);
});
