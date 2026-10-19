#!/usr/bin/env tsx
/** Compare all three constructed outputs of unchanged 3d_loop.sp, not just
 * its first DC plot. Run after build with spice-heavy pnpm exec tsx
 * benchmarks/corpus/corpus-f/three-dimensional-output.ts.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { simulate } from '../../../packages/core/dist/index.js';
import type { EngineExecution } from '../classic/report.js';
import { MATCH_THRESHOLD, normalizedSignalErrors, pairedReferenceSeries } from './lib.js';
import { asPacked, compareInBatches } from './packed.js';
import { readNgspiceRawFile } from './raw-stream.js';

async function main(): Promise<void> {
  const fixture = 'benchmarks/corpus/corpus-f/fixtures/examples/various/3d_loop.sp';
  const input = await readFile(fixture);
  const sha256 = createHash('sha256').update(input).digest('hex');
  assert.equal(sha256, '91280ff5b7dd5a6b7babbba0cb5a330483062caff1e7911d0f49fa6295481521');
  const directory = await mkdtemp(resolve(tmpdir(), 'three-dimensional-output-'));
  try {
    await writeFile(resolve(directory, 'fixture.cir'), input);
    // Identical deck bytes. ASCII is an engine-wide output-format choice.
    await writeFile(resolve(directory, '.spiceinit'), 'set filetype=ascii\n');
    const env = { ...process.env, HOME: directory };
    delete env.DISPLAY;
    const oracle = spawnSync('ngspice', ['-b', 'fixture.cir'], { cwd: directory, env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(oracle.error, undefined);
    assert.equal(oracle.status, 0, oracle.stderr);
    assert.equal((oracle.stdout.match(/No\. of Data Rows/g) ?? []).length, 15);
    const result = await simulate(input.toString('utf8'));
    assert.equal(result.control?.runs.length, 15);
    assert.equal(result.control?.files?.length, 3);
    const outputs = [];
    for (const [suffix, signals, points] of [['v', 16, 6], ['t', 19, 5], ['para', 31, 3]] as const) {
      const path = `3d_loop_i_vs_${suffix}.out`;
      const candidate = result.control!.files!.find(file => file.path === path);
      assert.ok(candidate, path);
      await writeFile(resolve(directory, 'candidate.raw'), candidate.contents);
      const execution = async (file: string): Promise<EngineExecution> => ({
        status: 'success', convergence: 'converged',
        analyses: (await readNgspiceRawFile(resolve(directory, file))).map(plot => {
          assert.equal(plot.points, points, path);
          const entries = Object.entries(plot.signals).map(([name, values]) => [name.replace(/^[iv]\((.*)\)$/, '$1'), values] as const);
          const selected = Object.fromEntries(entries);
          assert.equal(Object.keys(selected).length, signals, path);
          return { type: 'dc', plotId: path, plotName: plot.plotName, series: { grid: plot.grid, signals: selected } };
        }),
      });
      const actual = await execution('candidate.raw');
      const reference = await execution(path);
      const comparisons = compareInBatches(asPacked(actual), asPacked(reference));
      const { errors, missing } = normalizedSignalErrors(comparisons, pairedReferenceSeries(actual, reference));
      const worst = errors.length ? Math.max(...errors.map(error => error.normalized)) : null;
      outputs.push({ path, comparedSignals: errors.length, points, missing, worstNormalizedError: worst });
      assert.equal(errors.length, signals);
      assert.equal(missing, 0);
      assert.ok(worst !== null && worst <= MATCH_THRESHOLD, JSON.stringify(outputs));
    }
    console.log(JSON.stringify({ fixture, sha256, runs: 15, outputs,
      comparedSignals: outputs.reduce((sum, output) => sum + output.comparedSignals, 0),
      worstNormalizedError: Math.max(...outputs.map(output => output.worstNormalizedError!)), threshold: MATCH_THRESHOLD }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
