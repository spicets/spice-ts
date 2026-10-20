// Original project-authored rectifier fixture, MIT. No per-circuit tolerance tuning.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, arch, cpus } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1, SimulationResultV1 } from '@spice-ts/core/protocol';
import { simulateLinearOpWasmV1 } from '../src/numeric-wasm.js';
// Runtime-only benchmark dependency, outside the package's compilation root.
const harnessUrl = new URL('../../../benchmarks/comparison-harness.ts', import.meta.url).href;
const { parseNgspiceRaw }: { parseNgspiceRaw: (raw: string) => {
  plotName: string; grid: number[]; signals: Record<string, { re: number; im: number }[]>;
}[] } = await import(harnessUrl);

const source = '* Original MIT rectifier\nV1 in 0 SIN(0 2 1k)\nR1 in a 100\nD1 a out junction\nR2 out 0 1k\nC1 out 0 100n\n.model junction D(IS=1e-14 N=1 RS=2)\n.tran 1u 2m\n.end\n';
const version = spawnSync('ngspice', ['--version'], { encoding: 'utf8' });
if (!`${version.stdout}${version.stderr}`.includes('ngspice-47')) throw new Error('Requires ngspice-47');
const wasm = readFileSync(new URL('../native/dense-solver.wasm', import.meta.url));
const baseline = process.env.BASELINE_NUMERIC_MODULE
  ? (await import(pathToFileURL(process.env.BASELINE_NUMERIC_MODULE).href)).simulateLinearOpWasmV1
  : undefined;
const directory = mkdtempSync(join(tmpdir(), 'diode-tran-'));
try {
  writeFileSync(join(directory, 'input.cir'), source);
  writeFileSync(join(directory, '.spiceinit'), 'set filetype=ascii\n');
  const oracle = spawnSync('ngspice', ['-b', '-r', 'tran.raw', 'input.cir'], {
    cwd: directory, env: { ...process.env, HOME: directory }, encoding: 'utf8', timeout: 30_000,
  });
  if (oracle.status !== 0) throw new Error(oracle.stderr);
  const plot = parseNgspiceRaw(readFileSync(join(directory, 'tran.raw'), 'utf8')).find(p => /transient/i.test(p.plotName));
  if (!plot) throw new Error('Missing transient plot');
  const results = [];
  for (const tight of [false, true]) {
    const request: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice', source },
      ...(tight ? { options: { reltol: 1e-10, vntol: 1e-13, abstol: 1e-16 } } : {}) };
    const core = (await simulateProtocolV1(request)).analyses[0];
    if (core?.type !== 'tran') throw new Error('Expected transient');
    for (const [name, simulate] of [['before', baseline], ['after', simulateLinearOpWasmV1]] as const) {
      if (!simulate) continue;
      const result: SimulationResultV1 = await simulate(request, wasm, 12_000);
      const actual = result.analyses[0];
      if (actual?.type !== 'tran') throw new Error('Expected transient');
      let maxCoreDelta = 0;
      let maxTimeDelta = 0;
      let maxNgspiceDelta = 0;
      let squaredNgspice = 0;
      let samples = 0;
      for (const field of ['voltagesV', 'currentsA'] as const) {
        for (const [signal, values] of Object.entries(actual[field])) {
          const key = field === 'voltagesV' ? `v(${signal.toLowerCase()})` : `i(${signal.toLowerCase()})`;
          const reference = plot.signals[key] ?? plot.signals[`${signal.toLowerCase()}#branch`];
          if (!reference) throw new Error(`Missing ${key}`);
          let j = 0;
          values.forEach((value, i) => {
            const time = actual.timeS[i]!;
            while (j + 1 < plot.grid.length - 1 && plot.grid[j + 1]! < time) j++;
            const weight = (time - plot.grid[j]!) / (plot.grid[j + 1]! - plot.grid[j]!);
            const expected = reference[j]!.re + weight * (reference[j + 1]!.re - reference[j]!.re);
            const delta = Math.abs(value - expected);
            maxNgspiceDelta = Math.max(maxNgspiceDelta, delta);
            squaredNgspice += delta * delta;
            samples++;
            if (actual.timeS.length === core.timeS.length) {
              maxCoreDelta = Math.max(maxCoreDelta, Math.abs(value - core[field][signal]![i]!));
              maxTimeDelta = Math.max(maxTimeDelta, Math.abs(time - core.timeS[i]!));
            }
          });
        }
      }
      results.push({ name, tight, points: actual.timeS.length, corePoints: core.timeS.length,
        maxCoreDelta: actual.timeS.length === core.timeS.length ? maxCoreDelta : null,
        maxTimeDelta: actual.timeS.length === core.timeS.length ? maxTimeDelta : null,
        samples, maxNgspiceDelta, rmsNgspiceDelta: Math.sqrt(squaredNgspice / samples) });
    }
  }
  console.log(JSON.stringify({ oracle: 'ngspice-47', machine: `${arch()} ${cpus()[0]?.model}`,
    comparison: 'all node voltages and source branch currents; ngspice linearly interpolated to WASM times; core index-wise only on equal-length grids',
    ngspicePoints: plot.grid.length, results }, null, 2));
} finally { rmSync(directory, { recursive: true, force: true }); }
