// Run from repo root: spice-heavy pnpm exec tsx benchmarks/vbic-rbp/dff.ts
// Full, unmodified corpus DFF. Prints measurements, including parity losses.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { simulate } from '../../packages/core/src/simulate.js';
import { readNgspiceRawFile } from '../corpus/corpus-f/raw-stream.js';

async function main(): Promise<void> {
  const path = resolve('benchmarks/corpus/corpus-f/fixtures/examples/vbic/DFF_Y_ECL.sp');
  const deck = readFileSync(path, 'utf8');
  const sha256 = createHash('sha256').update(deck).digest('hex');
  if (sha256 !== 'd811ecfa0f370d281fb35729ca3177e738fe034621d9b2909765d9d70f527cc6') {
    throw new Error('DFF fixture bytes changed');
  }
  if (!execFileSync('ngspice', ['--version'], { encoding: 'utf8' }).includes('ngspice-47')) {
    throw new Error('Reference requires ngspice-47');
  }
  const scratch = mkdtempSync(join(tmpdir(), 'dff-'));
  try {
    const raw = join(scratch, 'd.raw');
    let start = performance.now();
    // The deck runs TRAN inside .control, so -r alone does not retain that plot.
    // Source the unchanged deck in batch mode and explicitly export its vectors.
    const output = execFileSync('ngspice', ['-n', '-b'], {
      cwd: scratch,
      input: `DFF measurement driver\n.control\nsource ${path}\nset filetype=ascii\nwrite d.raw v(q) v(d) v(clk)\nquit\n.endc\n.end\n`,
      env: { ...process.env, SPICE_ASCIIRAWFILE: '1', DISPLAY: '' }, stdio: 'pipe', timeout: 120000,
    });
    if (!existsSync(raw)) throw new Error(`ngspice produced no raw file: ${output.toString()}`);
    const ngspiceSeconds = (performance.now() - start) / 1000;
    const reference = (await readNgspiceRawFile(raw)).find(p => p.plotName.toLowerCase().includes('transient'));
    if (!reference) throw new Error('Missing ngspice transient');
    console.info(JSON.stringify({ sha256, ngspiceSeconds, ngspiceRows: reference.grid.length }));
    start = performance.now();
    let result;
    try {
      result = await simulate(deck);
    } catch (error) {
      console.info(JSON.stringify({ outcome: 'failed', spiceSeconds: (performance.now() - start) / 1000,
        name: (error as Error).name, message: (error as Error).message }));
      process.exitCode = 1;
      return;
    }
    const spiceSeconds = (performance.now() - start) / 1000;
    const tran = result.transient;
    if (!tran || tran.time[0] > reference.grid[0] || tran.time.at(-1)! < reference.grid.at(-1)!) {
      throw new Error('spice-ts does not cover the full ngspice transient');
    }
    const errors: Record<string, { maxAbsolute: number; peakNormalized: number }> = {};
    for (const node of ['q', 'd', 'clk']) {
      const values = tran.voltage(node);
      const expected = reference.signals[`v(${node})`];
      let upper = 0; let maxAbsolute = 0; let peak = 0;
      reference.grid.forEach((time, i) => {
        while (tran.time[upper] < time) upper++;
        const lower = Math.max(0, upper - 1);
        const weight = upper === lower ? 0 : (time - tran.time[lower]) / (tran.time[upper] - tran.time[lower]);
        maxAbsolute = Math.max(maxAbsolute, Math.abs(values[lower] + weight * (values[upper] - values[lower]) - expected[i].re));
        peak = Math.max(peak, Math.abs(expected[i].re));
      });
      errors[node] = { maxAbsolute, peakNormalized: maxAbsolute / peak };
    }
    console.info(JSON.stringify({ outcome: 'simulated', spiceSeconds, spiceRows: tran.time.length, errors }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
