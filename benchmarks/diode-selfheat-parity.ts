/** Reproduce issue #1801 against ngspice-47. Run with spice-heavy pnpm exec tsx benchmarks/diode-selfheat-parity.ts. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulate } from '../packages/core/src/simulate.js';

async function main(): Promise<void> {
const deck = fileURLToPath(new URL('./circuits/diode-selfheat-tran-1801.cir', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'diode-selfheat-'));
try {
  const output = join(directory, 'oracle.txt');
  const start = performance.now();
  const oracle = spawnSync('ngspice', ['-n', '-b'], {
    input: `Oracle control wrapper\n.control\nsource ${deck}\nrun\nset numdgt=15\nset wr_singlescale\nset wr_vecnames\nwrdata ${output} v(anode) i(v1) v(tj)\nquit\n.endc\n.end\n`,
    encoding: 'utf8',
  });
  const ngspiceMs = performance.now() - start;
  if (oracle.status !== 0 || !spawnSync('ngspice', ['--version'], { encoding: 'utf8' }).stdout.includes('ngspice-47')) {
    throw new Error(`Expected ngspice-47: ${oracle.error ?? oracle.stderr}\n${oracle.stdout}`);
  }
  const rows = readFileSync(output, 'utf8').trim().split('\n').slice(1)
    .map(line => line.trim().split(/\s+/).map(Number));
  if (process.argv.includes('--write-reference')) {
    writeFileSync(new URL('../packages/core/src/devices/fixtures/diode-selfheat-1801.json', import.meta.url),
      JSON.stringify(rows.filter((_, index) => index % 16 === 0 || index === rows.length - 1)) + '\n');
  }
  const spiceStart = performance.now();
  const result = (await simulate(readFileSync(deck, 'utf8'))).transient!;
  const spiceMs = performance.now() - spiceStart;
  const series = [result.voltage('anode'), result.current('V1'), result.voltage('tj')];
  const names = ['v(anode)', 'i(V1)', 'v(tj)'];
  const metrics = series.map((values, column) => {
    let index = 1;
    let max = 0;
    let sum = 0;
    let peak = 0;
    for (const row of rows) {
      const time = row[0];
      while (index < result.time.length - 1 && result.time[index] < time) index++;
      const weight = (time - result.time[index - 1]) / (result.time[index] - result.time[index - 1]);
      const value = values[index - 1] + weight * (values[index] - values[index - 1]);
      const error = Math.abs(value - row[column + 1]);
      max = Math.max(max, error);
      sum += error * error;
      peak = Math.max(peak, Math.abs(row[column + 1]));
    }
    return { vector: names[column], peak, maxAbsolute: max, maxPercentOfPeak: 100 * max / peak,
      rmsPercentOfPeak: 100 * Math.sqrt(sum / rows.length) / peak };
  });
  console.log(JSON.stringify({ ngspiceMs, spiceMs, oraclePoints: rows.length,
    spicePoints: result.time.length, metrics }, null, 2));
  if (metrics.some(metric => !Number.isFinite(metric.maxPercentOfPeak) || metric.maxPercentOfPeak >= 1)) {
    process.exitCode = 1;
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
