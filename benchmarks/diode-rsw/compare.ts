import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { arch, cpus, platform, tmpdir } from 'node:os';
import { simulate } from '../../packages/core/src/simulate.js';

// spice-heavy pnpm exec tsx benchmarks/diode-rsw/compare.ts
// --write-reference refreshes the test oracle from an installed ngspice-47.
void main();
async function main(): Promise<void> {
const fixtureName = process.argv.includes('--default-ns') ? 'default-ns' : 'sidewall';
const fixture = resolve(`benchmarks/diode-rsw/${fixtureName}.cir`);
const bytes = readFileSync(fixture);
const directory = mkdtempSync(join(tmpdir(), 'rsw-'));
const analyses = ['op', 'dc', 'ac', 'tran'] as const;
const wrapper = join(directory, 'run.cir');
writeFileSync(wrapper, `RSW output instrumentation\n.control\nsource ${fixture}\nset filetype=ascii\nrun\n${analyses.map(a => `setplot ${a}1\nwrite ${join(directory, a + '.raw')} v(in) v(out) i(v1)`).join('\n')}\nquit\n.endc\n.end\n`);
const startNg = performance.now();
const ng = spawnSync('ngspice', ['-n', '-b', wrapper], { encoding: 'utf8', timeout: 60000 });
writeFileSync(join(directory, 'ngspice.log'), ng.stdout + ng.stderr);
if (ng.error || ng.status !== 0) throw ng.error ?? new Error(`ngspice exit ${ng.status}`);
const ngMs = performance.now() - startNg;
const reference = Object.fromEntries(analyses.map(analysis => {
  const text = readFileSync(join(directory, analysis + '.raw'), 'utf8');
  const width = Number(/No. Variables:\s*(\d+)/.exec(text)![1]);
  const count = Number(/No. Points:\s*(\d+)/.exec(text)![1]);
  const values = text.split('Values:')[1].trim().split('\n').filter(v => v.trim()).map(line => {
    const parts = line.trim().split(/\s+/).at(-1)!.split(',').map(Number);
    return [parts[0], parts[1] ?? 0];
  });
  if (values.length !== width * count) throw new Error(`Incomplete ${analysis} raw data`);
  const names = text.split('\nVariables:')[1].split('Values:')[0].trim().split('\n')
    .map(line => line.trim().split(/\s+/)[1]);
  return [analysis, { names, rows: Array.from({ length: count }, (_, i) => values.slice(i * width, (i + 1) * width)) }];
}));
const version = spawnSync('ngspice', ['--version'], { encoding: 'utf8' }).stdout;
if (!version.includes('ngspice-47')) throw new Error('Reference requires ngspice-47');
const oracle = { version: 'ngspice-47', sha256: createHash('sha256').update(bytes).digest('hex'), reference };
if (process.argv.includes('--write-reference')) {
  const referenceName = fixtureName === 'sidewall' ? 'reference' : `${fixtureName}-reference`;
  writeFileSync(resolve(`benchmarks/diode-rsw/${referenceName}.json`), JSON.stringify(oracle, null, 2) + '\n');
}
const startTs = performance.now();
const simulation = await simulate(bytes.toString());
const tsMs = performance.now() - startTs;
const metrics: Record<string, unknown> = {};
let pass = true;
for (const analysis of analyses) {
  const { names, rows } = reference[analysis];
  for (const signal of ['v(in)', 'v(out)', 'i(v1)']) {
    const column = names.indexOf(signal);
    if (column < 0) throw new Error(`Missing ${signal}`);
    const expected = rows.map(row => row[column]);
    const node = signal.slice(2, -1);
    const voltage = signal.startsWith('v');
    let actual: number[][];
    if (analysis === 'op') actual = [[voltage ? simulation.dc!.voltage(node) : simulation.dc!.current(node), 0]];
    else if (analysis === 'ac') actual = (voltage ? simulation.ac!.voltage(node) : simulation.ac!.current(node))
      .map(({ magnitude, phase }) => [magnitude * Math.cos(phase * Math.PI / 180), magnitude * Math.sin(phase * Math.PI / 180)]);
    else if (analysis === 'dc') actual = Array.from(voltage ? simulation.dcSweep!.voltage(node) : simulation.dcSweep!.current(node), v => [v, 0]);
    else {
      const time = simulation.transient!.time;
      const values = voltage ? simulation.transient!.voltage(node) : simulation.transient!.current(node);
      actual = rows.map(row => {
        const t = row[0][0];
        let i = 0;
        while (i < time.length - 2 && time[i + 1] < t) i++;
        const f = (t - time[i]) / (time[i + 1] - time[i]);
        return [values[i] + f * (values[i + 1] - values[i]), 0];
      });
    }
    if (actual.length !== expected.length) throw new Error(`${analysis}: mismatched point count`);
    const peak = Math.max(...expected.map(([re, im]) => Math.hypot(re, im)));
    const errors = expected.map(([re, im], i) => Math.hypot(re - actual[i][0], im - actual[i][1]));
    const max = Math.max(...errors);
    const rms = Math.sqrt(errors.reduce((s, v) => s + v * v, 0) / errors.length);
    const ok = max <= 0.01 * peak;
    pass &&= ok;
    metrics[`${analysis}:${signal}`] = { points: rows.length, maxAbsolute: max, rmsAbsolute: rms, maxOfPeak: max / peak, rmsOfPeak: rms / peak, pass: ok };
  }
}
console.log(JSON.stringify({ version: oracle.version, sha256: oracle.sha256,
  machine: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  runtimeMs: { ngspiceIncludingOutput: ngMs, spiceTs: tsMs }, metrics, pass }, null, 2));
if (!pass) process.exitCode = 1;
}
