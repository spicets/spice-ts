import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { arch, platform, release } from 'node:os';
import { createSpiceEngine } from '../dist/index.js';
import { diodeAcSource } from '../src/test-support/diode-ac.js';

// Reuse the public identical-deck harness without adding it to this package's build graph.
const harnessUrl = new URL('../../../benchmarks/comparison-harness.ts', import.meta.url).href;
const { runNgspice, alignAndMeasure } = await import(harnessUrl);
const signals = ['v(in)', 'v(out)', 'i(v1)'];
const fixture = { name: 'bounded-diode-ac', analysis: 'ac', netlist: diodeAcSource, signals };
const ngspice = await runNgspice(fixture);
if (ngspice.status !== 'success') throw new Error(JSON.stringify(ngspice));
const series: Record<string, { grid: number[]; signals: Record<string, { re: number; im: number }[]> }> = {};
for (const backend of ['spice-ts-js', 'spice-ts-wasm'] as const) {
  const engine = await createSpiceEngine({ backend });
  try {
    const result = await engine.simulate({ apiVersion: '1', input: { format: 'spice', source: diodeAcSource } }, { requestId: backend });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const ac = result.data.analyses[0];
    if (ac?.type !== 'ac') throw new Error('Expected AC');
    const output: typeof series[string] = { grid: ac.frequencyHz, signals: {} };
    for (const [field, prefix] of [['voltagePhasors', 'v'], ['currentPhasors', 'i']] as const) {
      for (const [name, values] of Object.entries(ac[field])) {
        output.signals[`${prefix}(${name.toLowerCase()})`] = values.map(value => {
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
  sha256: createHash('sha256').update(diodeAcSource).digest('hex'),
  ngspiceVersion: execFileSync('ngspice', ['--version'], { encoding: 'utf8' }).trim(),
  machine: `${platform()} ${release()} ${arch()}`, points: ngspice.series.grid.length,
  metric: 'max/RMS complex relative error at matched frequencies, zero references excluded',
  comparisons,
}, null, 2));
