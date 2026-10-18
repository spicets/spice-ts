import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareExecutions } from '../../aggregate-report.js';
import { compareInBatches, packExecution } from './packed.js';
import type { EngineExecution } from '../classic/report.js';

function execution(count: number, offset = 0): EngineExecution {
  return { status: 'success', convergence: 'converged', analyses: [{ type: 'tran', plotName: 'Transient Analysis', series: {
    grid: Array.from({ length: count }, (_, i) => i / 10),
    signals: { 'v(out)': Array.from({ length: count }, (_, i) => ({ re: Math.sin(i / 10) + offset, im: 0 })) },
  } }] };
}

if (process.argv.includes('--metric-worker')) {
  const pair = execution(4_000_001);
  const packed = packExecution(pair);
  const start = performance.now();
  const result = compareInBatches(packed, packed);
  const wallMs = performance.now() - start;
  assert.equal(result[0].metrics.grid.alignedPoints, 4_000_001);
  assert.equal(result[0].metrics.signals['v(out)'].status, 'compared');
  console.log(JSON.stringify({ wallMs }));
} else {
  test('packed multi-million-point metric finishes within 12 s (30 s process safety bound)', () => {
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--metric-worker'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1_000_000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    const { wallMs } = JSON.parse(child.stdout.trim());
    assert(wallMs < 12_000, `metric took ${wallMs} ms`);
  });
  test('packed batches exactly equal the legacy metric on small, descending and nested inputs', () => {
    const golden = createHash('sha256');
    for (const count of [1, 9, 25_003]) {
      const left = execution(count, 0.0125);
      const right = execution(count + 2);
      for (const type of ['tran', 'dc', 'ac'] as const) {
        left.analyses[0].type = right.analyses[0].type = type;
        for (const mode of ['ascending', 'descending', 'nested']) {
          if (mode === 'descending') {
            for (const run of [left, right]) {
              run.analyses[0].series.grid.reverse();
              run.analyses[0].series.signals['v(out)'].reverse();
            }
          }
          if (mode === 'nested') {
            for (const run of [left, right]) run.analyses[0].series.secondaryGrid = run.analyses[0].series.grid.map((_, i) => i < 4 ? 0 : 1);
          }
          const legacy = compareExecutions(left, right);
          golden.update(JSON.stringify(legacy));
          assert.deepEqual(compareInBatches(packExecution(left), packExecution(right), 1), legacy);
        }
      }
    }
    // Captured before optimizing reference preparation (#1318).
    assert.equal(golden.digest('hex'), '3a060b07f89b2ff11308f028876715e6370cbbb961427b1cfa8ed56a17674c9e');
  });
}
