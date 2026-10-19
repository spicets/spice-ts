#!/usr/bin/env tsx
/** Compare the final (8 Ohm) wingspread gain/irload arrays after the unchanged
 * fixture finishes. DC plots are destroyed by the deck. Export commands are
 * appended by the harness, never inserted into or substituted in fixture bytes.
 * Run after build: spice-heavy pnpm exec tsx benchmarks/corpus/corpus-f/wingspread-output.ts
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parse, simulate } from '../../../packages/core/dist/index.js';
import { type EngineExecution } from '../classic/report.js';
import { MATCH_THRESHOLD, normalizedSignalErrors, pairedReferenceSeries } from './lib.js';
import { asPacked, compareInBatches } from './packed.js';
import { readNgspiceRawFile } from './raw-stream.js';

async function main(): Promise<void> {
  const fixture = 'benchmarks/corpus/corpus-f/fixtures/examples/vdmos/100W_wingspread.sp';
  const input = await readFile(fixture);
  const sha256 = createHash('sha256').update(input).digest('hex');
  if (sha256 !== '95f344036b6c560d6a9f0ee75545071c8e123e3360780dd2662d877edd65be49') throw new Error('Fixture checksum mismatch');
  const directory = await mkdtemp(resolve(tmpdir(), 'wingspread-output-'));
  try {
    await writeFile(resolve(directory, 'fixture.cir'), input);
    await writeFile(resolve(directory, '.spiceinit'), 'set filetype=ascii\n');
    const exportCommand = 'write constructed.raw const.gain const.irload';
    await writeFile(resolve(directory, 'wrapper.cir'), `* unchanged fixture export\n.control\nsource fixture.cir\n${exportCommand}\n.endc\n.end\n`);
    const env = { ...process.env, HOME: directory };
    delete env.DISPLAY;
    const oracle = spawnSync('ngspice', ['-b', 'wrapper.cir'], { cwd: directory, env, encoding: 'utf8', timeout: 60_000 });
    if (oracle.error || oracle.status !== 0) throw new Error(`${oracle.error ?? oracle.stderr}`);
    const circuit = parse(input.toString('utf8'));
    circuit.controlScript!.statements.push({ kind: 'command', name: 'write', line: { lineNumber: 0, text: exportCommand } });
    const result = await simulate(circuit);
    const output = result.control?.files?.find(file => file.path === 'constructed.raw');
    if (!output) throw new Error('spice-ts did not export constructed arrays');
    await writeFile(resolve(directory, 'candidate.raw'), output.contents);
    const execution = async (file: string): Promise<EngineExecution> => ({
      status: 'success', convergence: 'converged',
      analyses: (await readNgspiceRawFile(resolve(directory, file))).map(plot => {
        const signals = Object.fromEntries(Object.entries(plot.signals)
          .map(([name, values]) => [name.replace(/^i\((.*)\)$/, '$1').replace(/^const\./, ''), values])
          .filter(([name]) => name === 'gain' || name === 'irload'));
        if (Object.keys(signals).length !== 2 || plot.points !== 2005) throw new Error(`${file}: expected gain/irload with 2005 samples; got ${plot.points}, ${Object.keys(plot.signals)}`);
        return { type: 'dc', plotId: 'constructed-output', series: {
          // These are flattened [5][401] arrays, not a retained DC sweep.
          grid: Array.from({ length: plot.points }, (_, index) => index), signals,
        } };
      }),
    });
    const candidate = await execution('candidate.raw');
    const reference = await execution('constructed.raw');
    const comparisons = compareInBatches(asPacked(candidate), asPacked(reference));
    const { errors, missing } = normalizedSignalErrors(comparisons, pairedReferenceSeries(candidate, reference));
    const worst = errors.length ? Math.max(...errors.map(error => error.normalized)) : null;
    const matched = worst !== null && worst <= MATCH_THRESHOLD && missing === 0;
    console.log(JSON.stringify({ fixture, sha256, output: 'final 8 Ohm arrays only; earlier loads overwritten by fixture',
      spiceTs: 'success', ngspice: 'success', comparedSignals: errors.length, points: 2005,
      missingSignals: missing, worstNormalizedError: worst, threshold: MATCH_THRESHOLD,
      outcome: matched ? 'matched' : 'mismatch', errors }));
    if (!matched) process.exitCode = 1;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
