import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, cpus, platform, arch } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulate } from '../../packages/core/src/index.js';

function interpolate(t: ArrayLike<number>, y: ArrayLike<number>, at: number): number {
  let i = 1;
  while (i < t.length - 1 && t[i] < at) i++;
  const f = (at - t[i - 1]) / (t[i] - t[i - 1]);
  return y[i - 1] + f * (y[i] - y[i - 1]);
}

async function main(): Promise<void> {
const fixture = fileURLToPath(new URL('./loop.cir', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'core-hysteresis-'));
try {
  const version = execFileSync('ngspice', ['--version'], { encoding: 'utf8' });
  assert.match(version, /ngspice-47\b/, 'parity oracle must be ngspice-47');
  // Source exactly the same committed bytes passed to simulate. Only observation
  // commands live in this wrapper, not solver options or a modified netlist.
  writeFileSync(join(work, 'observe.cir'), `Core hysteresis observer\n.control\nsource ${fixture}\nrun\nset wr_singlescale\nset numdgt=17\nwrdata reference.txt i(vdrive)\nquit\n.endc\n.end\n`);
  const ngStart = performance.now();
  execFileSync('ngspice', ['-n', '-b', 'observe.cir'], { cwd: work, stdio: 'pipe', timeout: 30000 });
  const ngMs = performance.now() - ngStart;
  const rows = readFileSync(join(work, 'reference.txt'), 'utf8').trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  assert.ok(rows.length > 100);
  assert.ok(rows.every(row => row.length === 2 && row.every(Number.isFinite)));
  const tsStart = performance.now();
  const tran = (await simulate(readFileSync(fixture, 'utf8'))).transient!;
  const tsMs = performance.now() - tsStart;
  assert.ok(tran.time.length > 100);
  const times = rows.map(row => row[0]);
  const flux = rows.map(row => row[1]);
  const actual = tran.current('vdrive');
  const peak = Math.max(...flux.map(Math.abs));
  assert.ok(peak > 0);
  const metrics = (errors: number[]) => ({
    points: errors.length,
    maxAbsolute: Math.max(...errors),
    rmsAbsolute: Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length),
    maxNormalized: Math.max(...errors) / peak,
    rmsNormalized: Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length) / peak,
  });
  const atNgspice = metrics(rows.map(([t, y]) => Math.abs(y - interpolate(tran.time, actual, t))));
  const atSpiceTs = metrics(Array.from(tran.time, (t, i) => Math.abs(actual[i] - interpolate(times, flux, t))));
  console.log(JSON.stringify({ oracle: 'ngspice-47', machine: `${platform()} ${arch()} ${cpus()[0].model}`, vector: 'i(vdrive) = -core flux/output', peak, atNgspice, atSpiceTs, runtimeMs: { ngspice: ngMs, spiceTs: tsMs } }, null, 2));
  assert.ok(atNgspice.maxNormalized <= 0.01, 'ngspice grid exceeds 1% of peak');
  assert.ok(atSpiceTs.maxNormalized <= 0.01, 'spice-ts grid exceeds 1% of peak');
} finally {
  rmSync(work, { recursive: true, force: true });
}
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
