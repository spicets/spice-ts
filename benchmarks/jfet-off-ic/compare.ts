// Original project-authored MIT decks; identical input bytes, default options.
// Run: spice-heavy pnpm exec tsx benchmarks/jfet-off-ic/compare.ts
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulate } from '../../packages/core/src/simulate.js';
import { parseNgspiceRaw } from '../comparison-harness.js';

async function main(): Promise<void> {
const version = spawnSync('ngspice', ['--version'], { encoding: 'utf8' });
if (!`${version.stdout}${version.stderr}`.includes('ngspice-47')) throw new Error('Requires ngspice-47');
const directory = mkdtempSync(join(tmpdir(), 'jfet-off-ic-'));
const reports: unknown[] = [];
let failed = false;
try {
  writeFileSync(join(directory, '.spiceinit'), 'set filetype=ascii\n');
  for (const level of [1, 2]) for (const p of [1, -1]) {
    for (const mode of ['op-grounded', 'op-resistive-gate', 'uic'] as const) {
      for (const off of mode !== 'uic' ? ['', 'off'] : ['off']) {
        const input = `JFET initialization parity
V1 v 0 ${p * 5}
R1 v d 1k
${mode === 'op-grounded' ? 'VG g 0 0' : 'RG g 0 10k'}
J1 d g 0 JM ${off} ic=${p * 2},${p * -1}
.model JM ${p === 1 ? 'NJF' : 'PJF'} LEVEL=${level} CGS=1n CGD=0.5n
${mode !== 'uic' ? '.op' : '.tran 0.1u 10u uic'}
.end\n`;
        writeFileSync(join(directory, 'input.cir'), input);
        const startNg = performance.now();
        const run = spawnSync('ngspice', ['-b', '-r', 'output.raw', 'input.cir'], {
          cwd: directory, env: { ...process.env, HOME: directory }, encoding: 'utf8', timeout: 30_000,
        });
        const ngMs = performance.now() - startNg;
        if (run.status !== 0) throw new Error(`${run.stdout}${run.stderr}`);
        const plot = parseNgspiceRaw(readFileSync(join(directory, 'output.raw'), 'utf8'))[0];
        const start = performance.now();
        const own = await simulate(input);
        const ownMs = performance.now() - start;
        const times = mode !== 'uic' ? [0] : Array.from(own.transient!.time);
        const signals = [];
        for (const signal of ['v(d)', 'v(g)', 'i(v1)']) {
          const ng = plot.signals[signal].map(v => v.re);
          const name = signal.slice(2, -1);
          const a = mode !== 'uic'
            ? [signal.startsWith('i') ? own.dc!.current('V1') : own.dc!.voltage(name)]
            : Array.from(signal.startsWith('i') ? own.transient!.current('V1') : own.transient!.voltage(name));
          let j = 0;
          const errors = [];
          for (let i = 0; i < times.length; i++) {
            const t = times[i];
            if (mode === 'uic' && (t < plot.grid[0] || t > plot.grid[plot.grid.length - 1])) continue;
            while (j + 1 < ng.length - 1 && plot.grid[j + 1] < t) j++;
            const ref = mode !== 'uic' ? ng[0] : ng[j] + (ng[j + 1] - ng[j]) * (t - plot.grid[j]) / (plot.grid[j + 1] - plot.grid[j]);
            errors.push(Math.abs(a[i] - ref) / Math.max(1e-12, Math.abs(ref)));
          }
          const maxRel = Math.max(...errors);
          if (maxRel > (mode !== 'uic' ? 1e-6 : 0.01)) failed = true;
          signals.push({ signal, maxRel, rmsRel: Math.sqrt(errors.reduce((s, v) => s + v * v, 0) / errors.length),
            firstNg: [plot.grid[0], ng[0]], firstOwn: [times[0], a[0]], pointsCompared: errors.length });
        }
        reports.push({ level, polarity: p, mode, off: !!off, sha256: createHash('sha256').update(input).digest('hex'),
          ngMs, ownMs, ngPoints: plot.grid.length, ownPoints: times.length, signals });
      }
    }
  }
  console.log(JSON.stringify({ machine: { arch: arch(), cpu: cpus()[0]?.model },
    oracle: 'ngspice-47', alignment: 'ngspice linearly interpolated at spice-ts times; relative denominator floor 1e-12', reports, failed }, null, 2));
} finally { rmSync(directory, { recursive: true, force: true }); }
if (failed) process.exitCode = 1;
}
void main();
