/** Run: spice-heavy pnpm exec tsx benchmarks/xspice/sidiode-compare.ts */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { simulate } from '../../packages/core/src/simulate.js';

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spice-sidiode-'));
  try {
    const text = readFileSync(new URL('./sidiode.cir', import.meta.url), 'utf8');
    writeFileSync(join(dir, 'deck.cir'), text);
    console.log(JSON.stringify({ oracle: execFileSync('ngspice', ['-v'], { encoding: 'utf8' }).match(/ngspice-\d+/)?.[0],
      sha256: createHash('sha256').update(text).digest('hex'), platform: process.platform, arch: process.arch, node: process.version }));
    const start = performance.now();
    execFileSync('ngspice', ['-b', 'deck.cir'], { cwd: dir, stdio: 'pipe' });
    const ngspiceMs = performance.now() - start;
    const coreStart = performance.now();
    const result = await simulate(text);
    console.log(JSON.stringify({ ngspiceMs, spiceTsMs: performance.now() - coreStart }));
    for (const analysis of ['dc', 'tran'] as const) {
      const rows = readFileSync(join(dir, `${analysis}.txt`), 'utf8').trim().split('\n').slice(1)
        .map(line => line.trim().split(/\s+/).map(Number));
      const actual = analysis === 'dc' ? result.dcSweep! : result.transient!;
      const x = analysis === 'dc' ? result.dcSweep!.sweepValues : result.transient!.time;
      for (const [column, source] of ['vplain', 'vsoft', 'vlimit'].entries()) {
        const values = actual.current(source);
        let j = 0;
        const errors = rows.map(row => {
          const t = row[0];
          while (j + 1 < x.length && x[j + 1] < t) j++;
          if (t < x[0] - 1e-12 || t > x[x.length - 1] + 1e-12) throw new Error('Time range mismatch');
          const next = Math.min(j + 1, x.length - 1);
          const fraction = next === j ? 0 : (t - x[j]) / (x[next] - x[j]);
          return Math.abs(values[j] + fraction * (values[next] - values[j]) - row[column + 1]);
        });
        const peak = rows.reduce((max, row) => Math.max(max, Math.abs(row[column + 1])), 0);
        const maxAbsoluteError = errors.reduce((a, b) => Math.max(a, b), 0);
        const maxNormalizedError = maxAbsoluteError / peak;
        const rmsNormalizedError = Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length) / peak;
        console.log(JSON.stringify({ analysis, source, referenceSamples: rows.length, actualSamples: x.length,
          maxAbsoluteError, maxNormalizedError, rmsNormalizedError }));
        if (!Number.isFinite(maxNormalizedError) || maxNormalizedError > 1e-6) process.exitCode = 1;
      }
    }
    const acText = readFileSync(new URL('./sidiode-ac.cir', import.meta.url), 'utf8');
    writeFileSync(join(dir, 'ac.cir'), acText);
    execFileSync('ngspice', ['-b', 'ac.cir'], { cwd: dir, stdio: 'pipe' });
    const ac = (await simulate(acText)).ac!;
    const rows = readFileSync(join(dir, 'ac.txt'), 'utf8').trim().split('\n')
      .map(line => line.trim().split(/\s+/).map(Number));
    for (let source = 0; source < 6; source++) {
      const values = ac.current(`v${source}`);
      if (values.length !== rows.length) throw new Error('AC sample count mismatch');
      const errors = rows.map((row, i) => {
        const phase = values[i].phase * Math.PI / 180;
        return Math.hypot(values[i].magnitude * Math.cos(phase) - row[1 + 2 * source],
          values[i].magnitude * Math.sin(phase) - row[2 + 2 * source]);
      });
      const peak = Math.max(...rows.map(row => Math.hypot(row[1 + 2 * source], row[2 + 2 * source])));
      const maxNormalizedError = Math.max(...errors) / peak;
      console.log(JSON.stringify({ analysis: 'ac', source: `v${source}`, samples: rows.length, maxNormalizedError,
        sha256: createHash('sha256').update(acText).digest('hex') }));
      if (!Number.isFinite(maxNormalizedError) || maxNormalizedError > 1e-6) process.exitCode = 1;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
