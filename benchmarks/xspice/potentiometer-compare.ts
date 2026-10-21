/** Run: pnpm exec tsx benchmarks/xspice/potentiometer-compare.ts (oracle uses spice-heavy). */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { simulate } from '../../packages/core/src/simulate.js';

const signals = ['v(in)', 'v(wdefault)', 'v(wlinear)', 'v(wlog)', 'i(vdrive)'];
const analyses = ['op', 'dc', 'tran'] as const;
type Analysis = typeof analyses[number];
const tolerance = 1e-6;

function rows(text: string, analysis: Analysis): number[][] {
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift()!.trim().split(/\s+/);
  if (header.length !== 6 || header.slice(1).join(' ') !== signals.join(' ')) {
    throw new Error(`${analysis}: unexpected reference columns`);
  }
  const data = lines.map(line => line.trim().split(/\s+/).map(Number));
  if (!data.length || data.some(row => row.length !== 6 || row.some(v => !Number.isFinite(v)))) {
    throw new Error(`${analysis}: missing/nonfinite reference samples`);
  }
  if (analysis === 'op' && (data.length !== 1 || data[0][1] !== 5)) throw new Error('Missing 5V OP');
  if (analysis === 'dc' && (data.length !== 9 || data.some((r, i) => r[0] !== 1 + i * 0.5))) {
    throw new Error('Missing DC sweep samples');
  }
  if (analysis === 'tran' && (data.length < 81 || data[0][0] !== 0 || Math.abs(data.at(-1)![0] - 80e-6) > 1e-15)) {
    throw new Error('Incomplete transient reference');
  }
  if (analysis !== 'op' && data.some((r, i) => i > 0 && r[0] <= data[i - 1][0])) {
    throw new Error(`${analysis}: nonmonotonic scale`);
  }
  return data;
}

function measure(analysis: Analysis, reference: string, signal: string, expected: number[], actual: number[]): void {
  if (!actual.length || actual.length !== expected.length || actual.some(v => !Number.isFinite(v))) {
    throw new Error(`${analysis}/${signal}: missing/nonfinite actual samples`);
  }
  const errors = actual.map((v, i) => Math.abs(v - expected[i]));
  const peak = Math.max(...expected.map(Math.abs));
  if (!(peak > 0)) throw new Error(`${analysis}/${signal}: zero reference peak`);
  const maxAbsoluteError = Math.max(...errors);
  const maxNormalizedError = maxAbsoluteError / peak;
  const rmsNormalizedError = Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / errors.length) / peak;
  const maxRelativeError = Math.max(...errors.map((e, i) => e / Math.abs(expected[i])));
  console.log(JSON.stringify({ analysis, reference, signal, samples: actual.length,
    maxAbsoluteError, maxNormalizedError, rmsNormalizedError, maxRelativeError }));
  if (![maxNormalizedError, rmsNormalizedError, maxRelativeError].every(Number.isFinite)
    || maxNormalizedError > tolerance || rmsNormalizedError > tolerance
    || (analysis !== 'tran' && maxRelativeError > tolerance)) throw new Error('Parity tolerance exceeded');
}

async function main(): Promise<void> {
  const scratch = process.env['HERMES_SCRATCH_DIR'] ?? join(homedir(), '.cache/spice-ts/benchmarks');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'spice-potentiometer-'));
  try {
    const text = readFileSync(new URL('./potentiometer.cir', import.meta.url), 'utf8');
    writeFileSync(join(dir, 'deck.cir'), text);
    const version = execFileSync('ngspice', ['-v'], { encoding: 'utf8' }).match(/ngspice-\d+/)?.[0];
    if (!version) throw new Error('Unknown oracle version');
    console.log(JSON.stringify({ oracle: version, sha256: createHash('sha256').update(text).digest('hex'),
      platform: process.platform, release: release(), arch: process.arch, node: process.version,
      command: 'spice-heavy ngspice -b deck.cir', tolerance }));
    const start = performance.now();
    const log = execFileSync('spice-heavy', ['ngspice', '-b', 'deck.cir'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    if (/error:|aborted|failed/i.test(log)) throw new Error(`Oracle failure: ${log}`);
    const ngspiceMs = performance.now() - start;
    const coreStart = performance.now();
    const result = await simulate(text);
    console.log(JSON.stringify({ ngspiceMs, spiceTsMs: performance.now() - coreStart,
      timing: 'cold oracle includes process startup and semaphore queueing; TS simulation only' }));
    for (const analysis of analyses) {
      const live = rows(readFileSync(join(dir, `${analysis}.txt`), 'utf8'), analysis);
      const committed = rows(readFileSync(new URL(`./potentiometer-reference/${analysis}.txt`, import.meta.url), 'utf8'), analysis);
      if (live.length !== committed.length || live.some((r, i) => Math.abs(r[0] - committed[i][0]) > 1e-15)) {
        throw new Error(`${analysis}: live/committed reference grid mismatch`);
      }
      const actual = analysis === 'op' ? result.dc : analysis === 'dc' ? result.dcSweep : result.transient;
      if (!actual) throw new Error(`Missing ${analysis} analysis`);
      const x = analysis === 'op' ? [5] : analysis === 'dc' ? Array.from(result.dcSweep!.sweepValues) : result.transient!.time;
      if (!x.length || x.some((v, i) => !Number.isFinite(v) || (i > 0 && v <= x[i - 1]))) {
        throw new Error(`${analysis}: invalid actual scale`);
      }
      if (analysis === 'dc' && (x.length !== 9 || x.some((v, i) => v !== 1 + i * 0.5))) throw new Error('Missing actual DC samples');
      for (const [column, signal] of signals.entries()) {
        const node = signal.slice(2, -1);
        const series = signal.startsWith('i') ? actual.current(node) : actual.voltage(node);
        const values = typeof series === 'number' ? [series] : Array.from(series);
        if (values.length !== x.length || values.some(v => !Number.isFinite(v))) throw new Error(`Invalid ${signal}`);
        let j = 0;
        const aligned = live.map(row => {
          const t = row[0];
          if (t < x[0] - 1e-15 || t > x[x.length - 1] + 1e-15) throw new Error('Actual scale does not cover reference');
          while (j + 1 < x.length && x[j + 1] < t) j++;
          const next = Math.min(j + 1, x.length - 1);
          const fraction = next === j ? 0 : (t - x[j]) / (x[next] - x[j]);
          return values[j] + fraction * (values[next] - values[j]);
        });
        measure(analysis, 'committed-vs-live', signal, committed.map(r => r[column + 1]), live.map(r => r[column + 1]));
        measure(analysis, 'live-vs-spice-ts', signal, live.map(r => r[column + 1]), aligned);
        measure(analysis, 'committed-vs-spice-ts', signal, committed.map(r => r[column + 1]), aligned);
      }
      console.log(JSON.stringify({ analysis, referenceSamples: live.length, actualSamples: x.length }));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
