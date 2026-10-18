/** Unchanged corpus-f vector_param.cir versus ngspice-47. Run with spice-heavy. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { simulate } from '../packages/core/src/simulate.js';

async function main() {
const fixture = resolve('benchmarks/corpus/corpus-f/fixtures/examples/numparam/vector_param.cir');
const scratch = mkdtempSync(join(tmpdir(), 'vector-param-'));
const raw = join(scratch, 'sine.tsv');
const driver = join(scratch, 'reference.cir');
writeFileSync(driver, `reference driver\n.control\nsource ${fixture}\nset wr_singlescale\nset wr_vecnames\nset numdgt=15\nwrdata ${raw} sine\neprint node3\nquit\n.endc\n.end\n`);
const ngStart = performance.now();
const log = execFileSync('ngspice', ['-b', driver], { encoding: 'utf8' });
const ngMs = performance.now() - ngStart;
const reference = readFileSync(raw, 'utf8').trim().split('\n').slice(1).map(line => line.trim().split(/\s+/).map(Number));
const events = [...log.matchAll(/^([\d.e+-]+)\s+([01U])([srzu])\s*$/gm)].map(m => ({ time: Number(m[1]), state: m[2], strength: m[3] }));
const start = performance.now();
const result = (await simulate(readFileSync(fixture, 'utf8'))).transient!;
const spiceMs = performance.now() - start;
const volts = result.voltage('sine');
let j = 0;
const errors = reference.map(([t, v]) => {
  while (j + 1 < result.time.length && result.time[j + 1] < t) j++;
  const next = Math.min(j + 1, result.time.length - 1);
  const alpha = next === j ? 0 : (t - result.time[j]) / (result.time[next] - result.time[j]);
  return volts[j] + alpha * (volts[next] - volts[j]) - v;
});
const scale = Math.max(...reference.map(row => Math.abs(row[1])));
const actual = result.digital('node3');
const equalStates = events.length === actual.length && events.every((e, i) => e.state === actual[i].state && e.strength === actual[i].strength);
const timeErrors = equalStates ? events.map((e, i) => actual[i].time - e.time) : [];
const rms = (values: number[]) => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
console.log(JSON.stringify({ fixture, ngspice: execFileSync('ngspice', ['--version'], { encoding: 'utf8' }).match(/ngspice-\d+/)?.[0],
  referenceRows: reference.length, spiceRows: result.time.length,
  sine: { maxAbsolute: Math.max(...errors.map(Math.abs)), rmsAbsolute: rms(errors), maxRelativePeak: Math.max(...errors.map(Math.abs)) / scale, rmsRelativePeak: rms(errors) / scale },
  node3: { referenceEvents: events.length, actualEvents: actual.length, equalStates, maxTimeError: Math.max(...timeErrors.map(Math.abs)), rmsTimeError: rms(timeErrors), reference: events, actual },
  runtimeMs: { ngspiceProcess: ngMs, spiceTsSimulation: spiceMs }, scratch }, null, 2));
if (!equalStates) process.exitCode = 1;
}
void main();
