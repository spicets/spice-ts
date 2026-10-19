#!/usr/bin/env tsx
/** Compare dc_loop's own constructed/transposed write output, not its destroyed DC plots.
 * Run (after build): spice-heavy pnpm exec tsx benchmarks/corpus/corpus-f/dc-loop-output.ts
 * Fixture bytes, signal names, grids and corpus-f scoring rules are unchanged.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { simulate } from '../../../packages/core/dist/index.js';
import { type EngineExecution } from '../classic/report.js';
import { MATCH_THRESHOLD, normalizedSignalErrors, pairedReferenceSeries } from './lib.js';
import { asPacked, compareInBatches } from './packed.js';
import { readNgspiceRawFile } from './raw-stream.js';

async function main(): Promise<void> {
const fixture = 'benchmarks/corpus/corpus-f/fixtures/examples/various/dc_loop.sp';
const input = await readFile(fixture);
const sha256 = createHash('sha256').update(input).digest('hex');
if (sha256 !== '786213d027f3314a61d272b6fedc862e56d3f3303495b172594c29d52dada4d6') throw new Error('Fixture checksum mismatch');
const directory = await mkdtemp(resolve(tmpdir(), 'dc-loop-output-'));
try {
  await writeFile(resolve(directory, 'fixture.cir'), input);
  await writeFile(resolve(directory, '.spiceinit'), 'set filetype=ascii\n');
  const env = { ...process.env, HOME: directory };
  delete env.DISPLAY;
  const oracle = spawnSync('ngspice', ['-b', 'fixture.cir'], { cwd: directory, env, encoding: 'utf8', timeout: 60_000 });
  if (oracle.error || oracle.status !== 0) throw new Error(`${oracle.error ?? oracle.stderr}`);
  const result = await simulate(input.toString('utf8'));
  const output = result.control?.files?.find(file => file.path === 'dc_loop.out');
  if (!output) throw new Error('spice-ts did not construct dc_loop.out');
  await writeFile(resolve(directory, 'candidate.raw'), output.contents);
  const execution = async (file: string): Promise<EngineExecution> => ({
    status: 'success', convergence: 'converged',
    // The deck's custom plot is a DC crossplot: temperature is its scale, six bias currents its vectors.
    analyses: (await readNgspiceRawFile(resolve(directory, file))).map(plot => {
      // ngspice's settype current adds i(...) in raw headers; spice-ts retains
      // expression names. Canonicalize only this spelling, without changing samples.
      const signals = Object.fromEntries(Object.entries(plot.signals)
        .filter(([name]) => name !== 'tvect')
        .map(([name, values]) => [name.replace(/^i\((.*)\)$/, '$1'), values]));
      if (Object.keys(signals).length !== 6 || !plot.signals.tvect || plot.points !== 5) {
        throw new Error(`${file}: expected six current vectors and a five-point temperature scale`);
      }
      return { type: 'dc', plotId: 'constructed-output', plotName: plot.plotName,
        series: { grid: plot.signals.tvect.map(value => value.re), signals } };
    }),
  });
  const candidate = await execution('candidate.raw');
  const reference = await execution('dc_loop.out');
  const comparisons = compareInBatches(asPacked(candidate), asPacked(reference));
  const { errors, missing } = normalizedSignalErrors(comparisons, pairedReferenceSeries(candidate, reference));
  const worst = errors.length ? Math.max(...errors.map(error => error.normalized)) : null;
  const matched = worst !== null && worst <= MATCH_THRESHOLD && missing === 0;
  console.log(JSON.stringify({ fixture, sha256, output: 'dc_loop.out', spiceTs: 'success', ngspice: 'success',
    comparedSignals: errors.length, missingSignals: missing, worstNormalizedError: worst,
    threshold: MATCH_THRESHOLD, outcome: matched ? 'matched' : 'mismatch', errors }));
  if (!matched) process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
