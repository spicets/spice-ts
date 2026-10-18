import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, platform, arch, cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { simulate } from '../../packages/core/src/simulate.js';

// Run with spice-heavy pnpm exec tsx benchmarks/diode-self-heating/compare.ts.
// Source/licence: benchmarks/SOURCES.md, corpus-f ngspice-47 examples (BSD).
void main();
async function main(): Promise<void> {
const path = resolve('benchmarks/corpus/corpus-f/fixtures/examples/soa/diode-soa-sh.cir');
const bytes = readFileSync(path);
const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'diode-self-heating-'));
const raw = join(directory, 'reference.raw');
const wrapper = join(directory, 'run.cir');
writeFileSync(wrapper, `Reference output wrapper\n.control\nsource ${path}\nset filetype=ascii\nwrite ${raw} v(tj) i(v1) @d1[id]\nquit\n.endc\n.end\n`);
const ngStart = performance.now();
// Source the exact original file. Only output instrumentation is sent separately.
const ng = spawnSync('ngspice', ['-n', '-b', wrapper], {
  encoding: 'utf8', timeout: 60000,
});
writeFileSync(join(directory, 'ngspice.log'), ng.stdout + ng.stderr);
if (ng.error || ng.status !== 0) throw ng.error ?? new Error(`ngspice exit ${ng.status}`);
const ngMs = performance.now() - ngStart;
const text = readFileSync(raw, 'utf8');
const values = text.split('Values:')[1].trim().split('\n').filter(line => line.trim())
  .map(line => Number(line.trim().split(/\s+/).at(-1)));
const variables = Number(/No. Variables:\s*(\d+)/.exec(text)![1]);
const points = Number(/No. Points:\s*(\d+)/.exec(text)![1]);
if (values.length !== points * variables) throw new Error('Incomplete ngspice raw data');
const start = performance.now();
const simulation = await simulate(bytes.toString());
const result = simulation.dcSweep!;
const tsMs = performance.now() - start;
const metrics = (actual: ArrayLike<number>, index: number) => {
  if (actual.length !== points) throw new Error(`Expected ${points} points, got ${actual.length}`);
  const reference = Array.from({ length: points }, (_, i) => values[i * variables + index]);
  const peak = Math.max(...reference.map(Math.abs));
  const maxAbsoluteError = Math.max(...reference.map((v, i) => Math.abs(v - actual[i])));
  const rmsAbsoluteError = Math.sqrt(reference.reduce((sum, v, i) => sum + (v - actual[i]) ** 2, 0) / points);
  return { peak, maxAbsoluteError, rmsAbsoluteError, errorOfPeak: maxAbsoluteError / peak,
    rmsErrorOfPeak: rmsAbsoluteError / peak, pass: maxAbsoluteError <= 0.01 * peak };
};
const temperatureRise = metrics(result.voltage('tj'), 1);
const sourceCurrent = metrics(result.current('v1'), 2);
const diodeCurrent = metrics(result.deviceVectors.get('@d1[id]')!, 3);
console.log(JSON.stringify({
  referenceVersion: spawnSync('ngspice', ['--version'], { encoding: 'utf8' }).stdout.trim(),
  machine: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  identicalInputSha256: createHash('sha256').update(bytes).digest('hex'),
  originalOutcome: 'success',
  publicApi: { points: result.sweepValues.length, referencePoints: points,
    temperatureRise, sourceCurrent, diodeCurrent },
  runtimeMs: { ngspiceWithPostprocessingAndOutput: ngMs, spiceTsWithPostprocessing: tsMs },
  referenceLog: join(directory, 'ngspice.log'),
}, null, 2));
if (![temperatureRise, sourceCurrent, diodeCurrent].every(metric => metric.pass)) process.exitCode = 1;
}
