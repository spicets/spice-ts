#!/usr/bin/env tsx
/** pnpm build && pnpm exec tsx benchmarks/transmission-line-controls/compare.ts */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alignAndMeasure, parseNgspiceRaw, runSpiceTs } from '../comparison-harness.js';
import { MATCH_THRESHOLD, peakFloor } from '../corpus/corpus-f/lib.js';

const deck = readFileSync(new URL('./step.cir', import.meta.url), 'utf8');
const signals = ['v(input)', 'v(output)'];
const variants = {
  omitted: '',
  explicitDefaults: 'REL=1 ABS=1',
  relative: 'REL=0.5',
  absolute: 'REL=0.5 ABS=1g',
  suppressed: 'REL=1 ABS=1t',
};

async function main(): Promise<void> {
  console.log(execFileSync('ngspice', ['--version'], { encoding: 'utf8' }).split('\n').find(line => line.includes('ngspice-')));
  for (const [name, parameters] of Object.entries(variants)) {
    const netlist = deck.replace('TD=5n', `TD=5n ${parameters}`);
    const directory = mkdtempSync(join(tmpdir(), 'tline-controls-'));
    try {
      writeFileSync(join(directory, 'deck.cir'), netlist);
      writeFileSync(join(directory, '.spiceinit'), 'set filetype=ascii\n');
      const start = performance.now();
      execFileSync('spice-heavy', ['ngspice', '-b', '-r', join(directory, 'oracle.raw'), join(directory, 'deck.cir')], {
        env: { ...process.env, HOME: directory }, stdio: 'pipe', timeout: 180_000,
      });
      const oracleWallMsIncludingQueue = performance.now() - start;
      const reference = parseNgspiceRaw(readFileSync(join(directory, 'oracle.raw'), 'utf8'))
        .find(plot => plot.plotName.toLowerCase().includes('transient'))!;
      const actual = await runSpiceTs({ name, netlist, signals, analysis: 'tran' });
      if (actual.status !== 'success') {
        console.log(JSON.stringify({ name, status: actual.status, error: actual.error }));
        process.exitCode = 1;
        continue;
      }
      const metrics = alignAndMeasure(actual.series, reference, signals);
      for (const signal of signals) {
        const metric = metrics.signals[signal];
        if (metric.status !== 'compared') throw new Error(`${name}: missing ${signal}`);
        const peak = Math.max(...reference.signals[signal].map(value => Math.hypot(value.re, value.im)));
        const normalized = metric.absoluteError.max / Math.max(peak, peakFloor('tran', signal));
        console.log(JSON.stringify({ name, signal, spiceTsPoints: actual.series.grid.length,
          ngspicePoints: reference.grid.length, maxAbs: metric.absoluteError.max,
          rmsAbs: metric.absoluteError.rms, normalized, spiceTsMs: actual.runtimeMs, oracleWallMsIncludingQueue }));
        if (normalized > MATCH_THRESHOLD) process.exitCode = 1;
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
