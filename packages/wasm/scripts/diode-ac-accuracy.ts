import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { arch, platform, release } from 'node:os';
import { diodeAcSource } from '../src/test-support/diode-ac.js';

// Lint runs before build in CI; type against source, load the pinned built facade at runtime.
const facadeUrl = new URL('../dist/index.js', import.meta.url).href;
const { createSpiceEngine } = await import(facadeUrl) as typeof import('../src/index.js');

// Reuse the public identical-deck harness without adding it to this package's build graph.
const harnessUrl = new URL('../../../benchmarks/comparison-harness.ts', import.meta.url).href;
const { runNgspice, alignAndMeasure } = await import(harnessUrl);
const signals = ['v(in)', 'v(out)', 'i(v1)'];
for (const [name, source] of [
  ['bounded-diode-ac', diodeAcSource],
  ['bounded-diode-reverse-ac', diodeAcSource.replace('DC 2', 'DC -2')],
] as const) {
  const fixture = { name, analysis: 'ac', netlist: source, signals };
  const ngspice = await runNgspice(fixture);
  if (ngspice.status !== 'success') throw new Error(JSON.stringify(ngspice));
  const series: Record<string, { grid: number[]; signals: Record<string, { re: number; im: number }[]> }> = {};
  const phasors: Record<string, number[]> = {};
  for (const backend of ['spice-ts-js', 'spice-ts-wasm'] as const) {
    const engine = await createSpiceEngine({ backend });
    try {
      const result = await engine.simulate({ apiVersion: '1', input: { format: 'spice', source } }, { requestId: backend });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const ac = result.data.analyses[0];
      if (ac?.type !== 'ac') throw new Error('Expected AC');
      const output: typeof series[string] = { grid: ac.frequencyHz, signals: {} };
      phasors[backend] = [];
      for (const [field, prefix] of [['voltagePhasors', 'v'], ['currentPhasors', 'i']] as const) {
        for (const [name, values] of Object.entries(ac[field])) {
          output.signals[`${prefix}(${name.toLowerCase()})`] = values.map(value => {
            phasors[backend]!.push(value.magnitude, value.phaseDegrees);
            const phase = value.phaseDegrees * Math.PI / 180;
            return { re: value.magnitude * Math.cos(phase), im: value.magnitude * Math.sin(phase) };
          });
        }
      }
      series[backend] = output;
    } finally { await engine.close(); }
  }
  const comparisons = {
    wasmVsNgspice: alignAndMeasure(series['spice-ts-wasm'], ngspice.series, signals),
    jsVsNgspice: alignAndMeasure(series['spice-ts-js'], ngspice.series, signals),
    wasmVsJs: alignAndMeasure(series['spice-ts-wasm'], series['spice-ts-js'], signals),
  };
  console.log(JSON.stringify({
    fixture: fixture.name, source: 'Original project-authored fixture; repository MIT licence',
    sha256: createHash('sha256').update(source).digest('hex'),
    ngspiceVersion: execFileSync('ngspice', ['--version'], { encoding: 'utf8' }).trim(),
    machine: `${platform()} ${release()} ${arch()}`, points: ngspice.series.grid.length,
    metric: 'max/RMS complex relative error at matched frequencies, zero references excluded',
    comparisons,
    maxMagnitudePhaseRelativeError: Math.max(...phasors['spice-ts-js']!.map((value, i) =>
      Math.abs(phasors['spice-ts-wasm']![i]! - value) / Math.max(Math.abs(value), 1e-30))),
  }, null, 2));
}
