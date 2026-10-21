import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { arch, platform, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createSpiceEngine } from '../dist/index.js';
import { bjtAcFixtures } from '../src/test-support/bjt-ac.js';

const harnessUrl = new URL('../../../benchmarks/comparison-harness.ts', import.meta.url).href;
const { runNgspice, alignAndMeasure } = await import(harnessUrl);
const ngspiceVersion = execFileSync('ngspice', ['--version'], { encoding: 'utf8' }).trim();
for (const { name, source } of bjtAcFixtures) {
  const signals = ['v(collector)', 'i(vcc)'];
  const ngspice = await runNgspice({ name, analysis: 'ac', netlist: source, signals });
  if (ngspice.status !== 'success') throw new Error(JSON.stringify(ngspice));
  const series: Record<string, { grid: number[]; signals: Record<string, { re: number; im: number }[]> }> = {};
  const outcomes: Record<string, unknown> = {};
  for (const backend of ['spice-ts-js', 'spice-ts-wasm'] as const) {
    const engine = await createSpiceEngine({ backend });
    try {
      const start = performance.now();
      const result = await engine.simulate({ apiVersion: '1', input: { format: 'spice', source } }, { requestId: backend });
      const elapsedMs = performance.now() - start;
      if (!result.ok) {
        outcomes[backend] = { status: 'rejected', code: result.error.code, elapsedMs };
        continue;
      }
      const ac = result.data.analyses[0];
      if (ac?.type !== 'ac') throw new Error('Expected AC');
      const output: typeof series[string] = { grid: ac.frequencyHz, signals: {} };
      for (const [field, prefix] of [['voltagePhasors', 'v'], ['currentPhasors', 'i']] as const) {
        for (const [signal, values] of Object.entries(ac[field])) {
          output.signals[`${prefix}(${signal.toLowerCase()})`] = values.map(value => {
            const phase = value.phaseDegrees * Math.PI / 180;
            return { re: value.magnitude * Math.cos(phase), im: value.magnitude * Math.sin(phase) };
          });
        }
      }
      series[backend] = output;
      outcomes[backend] = { status: 'success', points: ac.frequencyHz.length, elapsedMs,
        vsNgspice: alignAndMeasure(output, ngspice.series, signals) };
    } finally { await engine.close(); }
  }
  console.log(JSON.stringify({ fixture: name, sha256: createHash('sha256').update(source).digest('hex'),
    source: 'Original project-authored fixture; repository MIT licence', ngspiceVersion,
    machine: `${platform()} ${release()} ${arch()}`, outcomes,
    wasmVsJs: series['spice-ts-wasm'] ? alignAndMeasure(series['spice-ts-wasm'], series['spice-ts-js'], signals) : null }));
}
