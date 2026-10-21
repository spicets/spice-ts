import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { simulate } from '../../packages/core/src/index.js';
import { alignAndMeasure, parseNgspiceRaw, type SampleSeries } from '../comparison-harness.js';

// --refresh regenerates committed reference data using an observer, never edits the deck.
async function main() {
  const version = execFileSync('ngspice', ['--version'], { encoding: 'utf8' }).match(/ngspice-\d+/)?.[0];
  if (version !== 'ngspice-47') throw new Error(`expected ngspice-47, got ${version}`);
  for (const analysis of ['dc', 'tran']) {
    const file = resolve(`benchmarks/xspice-multi-input-pwl/${analysis}.cir`);
    const referenceFile = file.replace('.cir', '.raw');
    const work = mkdtempSync(join(tmpdir(), 'multi-pwl-'));
    try {
      const raw = join(work, 'reference.raw');
      const observer = join(work, 'observer.cir');
      writeFileSync(observer, `Observer\n.control\nset filetype=ascii\nsource ${file}\nrun\nwrite ${raw} v(low) v(high)\nquit\n.endc\n.end\n`);
      const start = performance.now();
      execFileSync('ngspice', ['-n', '-b', observer], { stdio: 'pipe', timeout: 30000, env: { ...process.env, DISPLAY: '' } });
      const ngspiceMs = performance.now() - start;
      const reference = parseNgspiceRaw(readFileSync(raw, 'utf8'))[0];
      if (process.argv.includes('--refresh')) writeFileSync(referenceFile, readFileSync(raw));
      const stored = parseNgspiceRaw(readFileSync(referenceFile, 'utf8'))[0];
      if (JSON.stringify(reference.grid) !== JSON.stringify(stored.grid) || JSON.stringify(reference.signals) !== JSON.stringify(stored.signals)) throw new Error('reference drift');
      const tsStart = performance.now();
      const result = await simulate(readFileSync(file, 'utf8'));
      const spiceTsMs = performance.now() - tsStart;
      const run = analysis === 'dc' ? result.dcSweep! : result.transient!;
      const grid = analysis === 'dc' ? Array.from(result.dcSweep!.sweepValues) : Array.from(result.transient!.time);
      const series: SampleSeries = { grid, signals: Object.fromEntries(['low', 'high'].map(name => [`v(${name})`, Array.from(run.voltage(name), re => ({ re, im: 0 }))])) };
      const metrics = alignAndMeasure(series, reference, ['v(low)', 'v(high)']);
      console.log(JSON.stringify({ analysis, version, node: process.version, cpu: cpus()[0]?.model,
        sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), identicalDeckBytes: true,
        runtimeMilliseconds: { ngspice: ngspiceMs, spiceTs: spiceTsMs }, metrics }, null, 2));
      for (const signal of Object.values(metrics.signals)) {
        // Apply the requested DC relative tolerance to BOTH analyses; no
        // circuit-specific relaxation. Also bound absolute error at zero.
        if (signal.status !== 'compared' || signal.absoluteError.max > 1e-6
          || signal.relativeError.max === null || signal.relativeError.max > 1e-6) process.exitCode = 1;
      }
    } finally { rmSync(work, { recursive: true, force: true }); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
