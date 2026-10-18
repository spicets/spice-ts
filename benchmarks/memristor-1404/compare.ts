#!/usr/bin/env tsx
/** Run with spice-heavy pnpm exec tsx benchmarks/memristor-1404/compare.ts after pnpm build. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runNativeSpiceTs, type ClassicCircuit, type EngineExecution } from '../corpus/classic/report.js';
import { readNgspiceRawFile } from '../corpus/corpus-f/raw-stream.js';
import { normalizedSignalErrors, pairedReferenceSeries, MATCH_THRESHOLD } from '../corpus/corpus-f/lib.js';
import { compareExecutions } from '../aggregate-report.js';

async function main(): Promise<void> {
  const path = 'benchmarks/corpus/corpus-f/fixtures/examples/memristor/memristor_x.sp';
  const input = await readFile(path);
  const circuit: ClassicCircuit = { id: 'memristor-1404', category: 'xspice', analyses: ['op', 'ac', 'tran'],
    sourcePath: 'examples/memristor/memristor_x.sp', sourceUrl: 'https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/examples/memristor/memristor_x.sp',
    localPath: path, sha256: createHash('sha256').update(input).digest('hex'), ngspice: { expectedStatus: 'pass' }, spiceTs: { expectedStatus: 'pass' } };
  const own = await runNativeSpiceTs(input, circuit, { parseFirst: false });
  if (own.status !== 'success') throw new Error(JSON.stringify(own));
  const directory = await mkdtemp(resolve(tmpdir(), 'memristor-1404-'));
  try {
    // Source the unchanged bytes. Export only native electrical vectors: `write all`
    // includes the deck's cross-plot res1/res2 vectors, padding scales to unequal lengths.
    await writeFile(resolve(directory, 'fixture.cir'), input);
    const plots = ['op1', 'ac1', 'tran1', 'tran2', 'tran3'];
    await writeFile(resolve(directory, 'wrapper.cir'), ['memristor export', '.control', 'set filetype=ascii',
      'source fixture.cir', ...plots.flatMap(plot => [`setplot ${plot}`, `write ${plot}.raw v(1) v(11) v(2) i(v1) i(vgnd)`]),
      '.endc', '.end', ''].join('\n'));
    const env = { ...process.env, HOME: directory };
    delete env.DISPLAY;
    const run = spawnSync('ngspice', ['-b', 'wrapper.cir'], { cwd: directory, env, encoding: 'utf8', timeout: 120000 });
    if (run.error || run.status !== 0) throw new Error(`${run.error ?? run.stderr}`);
    const reference: EngineExecution = { status: 'success', convergence: 'converged', analyses: [] };
    for (const plotId of plots) {
      const [plot] = await readNgspiceRawFile(resolve(directory, `${plotId}.raw`));
      const type = plotId.startsWith('tran') ? 'tran' : plotId.startsWith('ac') ? 'ac' : 'op';
      reference.analyses.push({ type, plotId, plotName: plot.plotName, series: { grid: plot.grid, signals: plot.signals } });
    }
    const comparisons = compareExecutions(own, reference);
    const normalized = normalizedSignalErrors(comparisons, pairedReferenceSeries(own, reference));
    console.log(JSON.stringify({ path, threshold: MATCH_THRESHOLD, ownPlots: own.analyses.length,
      referencePlots: reference.analyses.length, comparisons, ...normalized }, null, 2));
    if (normalized.missing > 0 || normalized.errors.length !== 25) process.exitCode = 1;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
