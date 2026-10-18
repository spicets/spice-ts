#!/usr/bin/env tsx
// Observe the original control plots without altering any fixture bytes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, cpus, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { simulate } from '../../packages/core/src/index.js';
import { assertMatchedFrequencies, metrics, required } from '../noise-raw.js';
import { readNgspiceRawFile } from '../corpus/corpus-f/raw-stream.js';

async function main(): Promise<void> {
  const fixture = resolve('benchmarks/corpus/corpus-f/fixtures/examples/xspice/noise/noise_gain.cir');
  const bytes = readFileSync(fixture);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== 'd41121a130eda2169c7b9e7fa3ec74d129beba369c61ff0c24edae0f7896ea5c') throw new Error('fixture bytes changed');
  const workspace = mkdtempSync(join(tmpdir(), 'gain-noise-'));
  try {
    const commands = [`source ${fixture}`, 'set filetype=ascii'];
    for (let i = 1; i <= 4; i++) {
      commands.push(`setplot noise${i}`, `write ${join(workspace, `${i}.raw`)} ${i % 2 ? 'onoise_spectrum inoise_spectrum' : 'onoise_total inoise_total'}`);
    }
    commands.push('quit');
    const observer = join(workspace, 'observer.cir');
    writeFileSync(observer, ['Noise observer', '.control', ...commands, '.endc', '.end', ''].join('\n'));
    const start = performance.now();
    execFileSync('ngspice', ['-n', '-b', observer], { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DISPLAY: '' } });
    const ngspiceMilliseconds = performance.now() - start;
    const spiceStart = performance.now();
    const result = await simulate(bytes.toString('utf8'));
    const spiceTsMilliseconds = performance.now() - spiceStart;
    const runs = result.control?.runs.filter(run => run.result.noise !== undefined) ?? [];
    if (runs.length !== 2) throw new Error(`expected two noise runs, got ${runs.length}`);
    const comparisons = await Promise.all(runs.map(async (run, i) => {
      const [spectral] = await readNgspiceRawFile(join(workspace, `${i * 2 + 1}.raw`));
      const [integrated] = await readNgspiceRawFile(join(workspace, `${i * 2 + 2}.raw`));
      const values = (plot: typeof spectral, name: string): number[] => {
        const signal = plot.signals[name] ?? plot.signals[`v(${name})`];
        if (!signal) throw new Error(`missing reference ${name}`);
        return signal.map(v => v.re);
      };
      const reference = { frequencies: spectral.grid, output: values(spectral, 'onoise_spectrum'), input: values(spectral, 'inoise_spectrum'),
        integratedOutput: values(integrated, 'onoise_total')[0], integratedInput: values(integrated, 'inoise_total')[0] };
      const noise = run.result.noise!;
      // ngspice NStpsSm=16 writes only every sixteenth spectral point.
      // Match exported frequencies exactly; totals still span the full sweep.
      const indices = reference.frequencies.map(f => noise.frequencies.findIndex(actual => Math.abs(actual - f) <= f * 1e-12));
      if (indices.some(index => index < 0)) throw new Error('reference frequency absent from spice-ts sweep');
      assertMatchedFrequencies(indices.map(index => noise.frequencies[index]), reference.frequencies);
      const pairs: Array<[string, number[], number[]]> = [
        ['onoise_spectrum', indices.map(index => noise.outputNoiseDensity[index]), reference.output],
        ['inoise_spectrum', indices.map(index => noise.inputNoiseDensity[index]), reference.input],
        ['onoise_total', [required(noise.integratedOutputNoise, 'output total')], [reference.integratedOutput]],
        ['inoise_total', [required(noise.integratedInputNoise, 'input total')], [reference.integratedInput]],
      ];
      return { output: noise.outputNode, points: noise.frequencies.length, comparedPoints: indices.length, signals: Object.fromEntries(pairs.map(([name, actual, expected]) => [name, {
        ...metrics(actual, expected),
        maximumNormalizedError: Math.max(...actual.map((v, j) => Math.abs(v - expected[j]))) / Math.max(...expected.map(Math.abs)),
      }])) };
    }));
    const maximumNormalizedError = Math.max(...comparisons.flatMap(comparison =>
      Object.values(comparison.signals).map(signal => signal.maximumNormalizedError)));
    console.log(JSON.stringify({ fixture, sha256, identicalNetlistForBothEngines: true,
      observer: 'source original deck; write existing noise1..noise4 plots (no fixture edits)',
      versions: { ngspice: execFileSync('ngspice', ['--version'], { encoding: 'utf8' }).match(/ngspice-\d+/)?.[0], node: process.version },
      machine: { platform: platform(), arch: process.arch, cpu: cpus()[0]?.model },
      outcome: maximumNormalizedError <= 0.01 ? 'match' : 'spice-ts-loss', maximumNormalizedError,
      comparisons, runtimeMilliseconds: { ngspice: ngspiceMilliseconds, spiceTs: spiceTsMilliseconds },
      caveat: 'Different process boundaries; not a speed claim. No corpus thresholds changed.',
    }, null, 2));
    if (!Number.isFinite(maximumNormalizedError) || maximumNormalizedError > 0.01) process.exitCode = 1;
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
