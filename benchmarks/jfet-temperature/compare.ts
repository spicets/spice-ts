// Original MIT decks. Run with spice-heavy pnpm exec tsx benchmarks/jfet-temperature/compare.ts.
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
  const directory = mkdtempSync(join(tmpdir(), 'jfet-temperature-'));
  const reports = [];
  let failed = false;
  try {
    writeFileSync(join(directory, '.spiceinit'), 'set filetype=ascii\n');
    for (const p of [1, -1]) for (const mode of ['instance-l1', 'instance-l2', 'circuit', 'circuit-tnom', 'instance-l2-off', 'tran'] as const) {
      const tran = mode === 'tran';
      const input = `JFET temperature parity
V1 1 0 ${p * 5}
R1 1 2 1k
VG g 0 ${p * -0.5}
J1 2 g 0 JM ${mode.startsWith('instance-l2') ? `temp=-20 area=2 m=3 ic=2,-1 ${mode.endsWith('-off') ? 'off' : ''}` : mode === 'instance-l1' || tran ? 'temp=50' : ''}
.model JM ${p === 1 ? 'NJF' : 'PJF'} LEVEL=${mode.startsWith('instance-l2') ? 2 : 1} IS=2e-10 CGS=1n CGD=0.5n ${mode === 'circuit' ? 'TNOM=40 TCV=0.002 BEX=-1.5 XTI=3 EG=1.05' : ''}
${mode === 'circuit-tnom' ? '.temp 85\n.options TNOM=40' : mode === 'circuit' ? '.temp 85' : '.temp 27'}
${tran ? '.tran 0.1u 10u uic' : '.op'}
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
      const times = tran ? Array.from(own.transient!.time) : [0];
      const signals = [];
      for (const signal of ['v(2)', 'i(v1)']) {
        const ng = plot.signals[signal].map(v => v.re);
        const a = tran ? Array.from(signal.startsWith('i') ? own.transient!.current('V1') : own.transient!.voltage('2'))
          : [signal.startsWith('i') ? own.dc!.current('V1') : own.dc!.voltage('2')];
        let j = 0;
        const errors = [];
        for (let i = 0; i < times.length; i++) {
          const t = times[i];
          if (tran && (t < plot.grid[0] || t > plot.grid[plot.grid.length - 1])) continue;
          while (j + 1 < ng.length - 1 && plot.grid[j + 1] < t) j++;
          const ref = tran ? ng[j] + (ng[j + 1] - ng[j]) * (t - plot.grid[j]) / (plot.grid[j + 1] - plot.grid[j]) : ng[0];
          errors.push(Math.abs(a[i] - ref) / Math.max(1e-12, Math.abs(ref)));
        }
        const maxRel = Math.max(...errors);
        const passed = errors.length > 0 && Number.isFinite(maxRel) && maxRel <= (tran ? 0.01 : 1e-6);
        if (!passed && mode !== 'instance-l2-off') failed = true;
        signals.push({ signal, passed, maxRel, rmsRel: Math.sqrt(errors.reduce((s, v) => s + v * v, 0) / errors.length),
          firstNg: ng[0], firstOwn: a[0], pointsCompared: errors.length });
      }
      reports.push({ mode, polarity: p, gate: mode === 'instance-l2-off' ? 'known-loss (#1698 OFF OP)' : 'required', sha256: createHash('sha256').update(input).digest('hex'), ngMs, ownMs, signals });
    }
    console.log(JSON.stringify({ machine: { arch: arch(), cpu: cpus()[0]?.model }, oracle: 'ngspice-47',
      alignment: 'ngspice linearly interpolated at spice-ts times; relative denominator floor 1e-12', reports, failed }, null, 2));
  } finally { rmSync(directory, { recursive: true, force: true }); }
  if (failed) process.exitCode = 1;
}
void main();
