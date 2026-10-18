import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../../packages/core/src/parser/index.js';
import { resolveOptions } from '../../packages/core/src/types.js';
import { createDriverFromCompiled } from '../../packages/core/src/analysis/transient-driver.js';

// Run with spice-heavy pnpm exec tsx benchmarks/gear-order-policy/compare.ts.
// MAXORD=3 remains publicly rejected. Parse the identical MAXORD=2 control
// and select the internal cap-3 hook; no component or tolerance is changed.
const fixture = readFileSync(new URL('./rc.cir', import.meta.url), 'utf8');
const directory = mkdtempSync(join(tmpdir(), 'gear-order-policy-'));
const rows: object[] = [];
try {
  for (const cap of [2, 3] as const) {
    for (const h of [20e-9, 10e-9, 5e-9, 2.5e-9]) {
      const deck = fixture.replace('.tran 10n 2u 0 10n', `.tran ${h} 2u 0 ${h}`);
      const data = join(directory, 'wave.txt');
      writeFileSync(join(directory, 'rc.cir'), deck.replace('maxord=2', `maxord=${cap}`).replace('.end', `.control
set wr_singlescale
set wr_vecnames
set numdgt=17
run
wrdata ${data} v(in) v(out) i(v1)
quit
.endc
.end`));
      execFileSync('ngspice', ['-b', join(directory, 'rc.cir')], { stdio: 'pipe' });
      const native = readFileSync(data, 'utf8').trim().split('\n').slice(1)
        .map(line => line.trim().split(/\s+/).map(Number));
      const compiled = parse(deck).compile();
      const sim = createDriverFromCompiled(compiled, resolveOptions({ integrationMethod: 'gear2' }, 2e-6), {
        stopTime: 2e-6, timestep: h, maxTimestep: h, useInitialConditions: true,
        initialSolution: new Float64Array(compiled.nodeCount + compiled.branchCount),
        experimentalGearOrder: cap === 3 ? 3 : undefined,
      });
      try {
        const steps = sim.advanceUntil(2e-6).filter(step => step.time > 0);
        let cursor = 0;
        const errors: number[][] = [[], [], []];
        let analyticNative = 0;
        let analyticTS = 0;
        for (const sample of native) {
          while (cursor + 1 < steps.length && steps[cursor + 1].time < sample[0]) cursor++;
          const a = steps[cursor];
          const b = steps[Math.min(cursor + 1, steps.length - 1)];
          const fraction = b.time === a.time ? 0 : (sample[0] - a.time) / (b.time - a.time);
          const values = (step: typeof a) => [step.voltages.get('in')!, step.voltages.get('out')!, step.currents.get('V1')!];
          const av = values(a), bv = values(b);
          av.forEach((value, i) => errors[i].push(value + fraction * (bv[i] - value) - sample[i + 1]));
          analyticNative = Math.max(analyticNative, Math.abs(sample[2] - (1 - Math.exp(-sample[0] / 1e-6))));
        }
        for (const step of steps) analyticTS = Math.max(analyticTS,
          Math.abs(step.voltages.get('out')! - (1 - Math.exp(-step.time / 1e-6))));
        rows.push({ cap, h, points: [native.length, steps.length],
          maxAbs: errors.map(values => Math.max(...values.map(Math.abs))),
          rms: errors.map(values => Math.sqrt(values.reduce((sum, x) => sum + x * x, 0) / values.length)),
          analyticMax: [analyticNative, analyticTS],
          finalError: [Math.abs(native.at(-1)![2] - (1 - Math.exp(-2))), Math.abs(steps.at(-1)!.voltages.get('out')! - (1 - Math.exp(-2)))],
        });
      } finally { sim.dispose(); }
    }
  }
  console.log(JSON.stringify({ version: execFileSync('ngspice', ['--version'], { encoding: 'utf8' }).trim(), signals: ['v(in)', 'v(out)', 'i(v1)'], rows }, null, 2));
} finally { rmSync(directory, { recursive: true, force: true }); }
