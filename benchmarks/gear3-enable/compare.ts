// Run with: spice-heavy pnpm exec tsx benchmarks/gear3-enable/compare.ts
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { simulate } from '../../packages/core/src/simulate.js';
import { parseNgspiceRaw } from '../comparison-harness.js';

const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'gear3-enable-'));
writeFileSync(join(work, '.spiceinit'), 'set filetype=ascii\n');
const oscillator = resolve('benchmarks/corpus/corpus-f/fixtures/examples/p-to-n-examples/switch-oscillators.cir');
const cases = [{ name: 'switch-oscillators', path: oscillator, signals: ['v(osc_out)', 'i(vmeasure)'] }];
for (const h of [20, 10, 5, 2.5]) {
  const path = join(work, `rc-${h}.cir`);
  writeFileSync(path, `RC refinement\nV1 in 0 DC 1\nR1 in out 1k\nC1 out 0 1n\n.options method=gear maxord=3\n.tran ${h}n 2u 0 ${h}n uic\n.end\n`);
  cases.push({ name: `rc-${h}ns`, path, signals: ['v(in)', 'v(out)', 'i(v1)'] });
}
console.log(JSON.stringify({ work, platform: process.platform, arch: process.arch, cpu: cpus()[0].model, node: process.version,
  ngspice: execFileSync('ngspice', ['--version'], { encoding: 'utf8' }).split('\n').find(s => s.includes('ngspice-')) }));
async function main() {
for (const item of cases) {
  const source = readFileSync(item.path, 'utf8');
  const raw = join(work, `${item.name}.raw`);
  const start = performance.now();
  const native = spawnSync('ngspice', ['-b', '-r', raw, item.path], {
    encoding: 'utf8', env: { ...process.env, HOME: work }, timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  });
  const nativeMs = performance.now() - start;
  writeFileSync(join(work, `${item.name}.log`), native.stdout + native.stderr);
  const plot = parseNgspiceRaw(readFileSync(raw, 'utf8')).find(p => /transient/i.test(p.plotName));
  if (!plot) throw new Error(`No transient reference for ${item.name}; ngspice status ${native.status}`);
  const tsStart = performance.now();
  try {
    const result = (await simulate(source)).transient!;
    const tsMs = performance.now() - tsStart;
    const metrics = item.signals.map(signal => {
      const values = signal.startsWith('v(') ? result.voltage(signal.slice(2, -1)) : result.current(signal.slice(2, -1));
      const reference = plot.signals[signal];
      if (!values || !reference) throw new Error(`Missing ${signal}`);
      let k = 0, maxAbs = 0, squares = 0, count = 0;
      for (let i = 0; i < plot.grid.length; i++) {
        const t = plot.grid[i];
        if (t < result.time[0] || t > result.time[result.time.length - 1]) continue;
        while (k + 1 < result.time.length && result.time[k + 1] < t) k++;
        const next = Math.min(k + 1, result.time.length - 1);
        const fraction = next === k ? 0 : (t - result.time[k]) / (result.time[next] - result.time[k]);
        const error = values[k] + fraction * (values[next] - values[k]) - reference[i].re;
        if (!Number.isFinite(error)) throw new Error(`Non-finite ${signal}`);
        maxAbs = Math.max(maxAbs, Math.abs(error)); squares += error * error; count++;
      }
      return { signal, count, maxAbs, rms: Math.sqrt(squares / count) };
    });
    console.log(JSON.stringify({ name: item.name, sha256: createHash('sha256').update(source).digest('hex'), nativeStatus: native.status,
      nativeMs, tsMs, nativeRows: plot.grid.length, tsRows: result.time.length, metrics,
      ...(item.name.startsWith('rc') ? { nativeFinalError: Math.abs(plot.signals['v(out)'].at(-1)!.re - (1 - Math.exp(-2))),
        tsFinalError: Math.abs(result.voltage('out').at(-1)! - (1 - Math.exp(-2))) } : {}) }));
  } catch (error) {
    console.log(JSON.stringify({ name: item.name, nativeStatus: native.status, nativeMs, nativeRows: plot.grid.length,
      tsMs: performance.now() - tsStart, failure: String(error) }));
    process.exitCode = 1;
  }
}
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
