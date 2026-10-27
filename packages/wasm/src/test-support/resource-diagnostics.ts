import { createHook } from 'node:async_hooks';
import { writeSync } from 'node:fs';
import { afterAll, afterEach, beforeEach } from 'vitest';

// Opt in with SPICE_WASM_TEST_RESOURCES=1. No async hook or output otherwise.
if (process.env.SPICE_WASM_TEST_RESOURCES === '1') {
  const workers = new Set<number>();
  const hook = createHook({
    init(id, type) { if (type === 'WORKER') workers.add(id); },
    destroy(id) { workers.delete(id); },
  }).enable();
  const report = (phase: string, test: string) => {
    writeSync(2, '[wasm-test-resources] ' + JSON.stringify({
      phase, test, pid: process.pid, rssBytes: process.memoryUsage.rss(),
      // Live WORKER async resources created by this fork, not machine-wide workers.
      workerCount: workers.size,
    }) + '\n');
  };
  beforeEach(context => { report('before', context.task.name); });
  afterEach(context => { report('after', context.task.name); });
  afterAll(() => { hook.disable(); });
}
