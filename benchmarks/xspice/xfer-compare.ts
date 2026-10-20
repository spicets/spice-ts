/** Original MIT microdecks; run: spice-heavy pnpm exec tsx benchmarks/xspice/xfer-compare.ts */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulate } from '../../packages/core/src/simulate.js';

async function main(): Promise<void> {
const dir = mkdtempSync(join(tmpdir(), 'spice-xfer-'));
const cases = [
  'table=[10 0 0 30 0 90]',
  'table=[10 99 99 2 3 20 99 99 4 5] span=5 offset=3 r_i=true',
  'table=[10 2 1.5707963267948966] db=false rad=true',
  'file="data.s1p"',
];
// MHz is deliberately retained: ngspice-47 computes but does not apply its unit multiplier.
const data = '# MHz S RI R 50\n0.00001 2 0\n0.00003 0 2\n';
try {
  console.log(execFileSync('ngspice', ['-v'], { encoding: 'utf8' }).match(/ngspice-\d+/)?.[0]);
  writeFileSync(join(dir, 'data.s1p'), data);
  for (const [i, params] of cases.entries()) {
    const text = ['xfer oracle', 'v1 in 0 dc 2 ac 1', 'a1 in out f', `.model f xfer(${params})`,
      'r1 out 0 1k', '.ac lin 31 1 31', '.control', 'set numdgt=15', 'run',
      `wrdata result-${i}.txt v(out)`, '.endc', '.end'].join('\n');
    writeFileSync(join(dir, `case-${i}.cir`), text);
    execFileSync('ngspice', ['-b', `case-${i}.cir`], { cwd: dir, stdio: 'pipe' });
    const reference = readFileSync(join(dir, `result-${i}.txt`), 'utf8').trim().split('\n')
      .map(line => line.trim().split(/\s+/).map(Number));
    const result = await simulate(text, { resolveInclude: async () => data });
    const actual = result.ac!.voltage('out');
    if (reference.length !== actual.length) throw new Error('Sample count mismatch');
    const errors = reference.map((row, index) => {
      const value = actual[index];
      const phase = value.phase * Math.PI / 180;
      return Math.hypot(value.magnitude * Math.cos(phase) - row[1], value.magnitude * Math.sin(phase) - row[2]);
    });
    const peak = Math.max(...reference.map(row => Math.hypot(row[1], row[2])));
    const normalizedError = Math.max(...errors) / peak;
    console.log(JSON.stringify({ params, samples: reference.length, maxAbsoluteComplexError: Math.max(...errors), normalizedError }));
    if (!Number.isFinite(normalizedError) || normalizedError > 1e-10) process.exitCode = 1;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
