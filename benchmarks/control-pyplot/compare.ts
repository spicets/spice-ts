#!/usr/bin/env tsx
/** #1631: score only the unchanged pyplot deck, using the existing control export wrapper.
 * Run headlessly: MPLBACKEND=Agg spice-heavy pnpm exec tsx benchmarks/control-pyplot/compare.ts [--update]
 * ngspice-47 commands.c:216 dispatches pyplot to com_pyplot; com_pyplot.c:91 calls plotit.
 * plotting/pyplot.c:123-130 uses pyplot_subplots only for display layout, not simulation.
 * These are output-only no-ops in spice-ts, not a claim that ngspice ignores pyplot in batch.
 * Source: https://github.com/imr/ngspice/tree/a80f6e3e95d51534905b1f23410a951802666656/src/frontend
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { runControlReference } from '../corpus/corpus-f/control-vectors.js';
import { mergeReadme, outcomeDigest, renderMarkdown, runFixture, stableReport, summarize, type CorpusFReport } from '../corpus/corpus-f/outcomes.js';
import type { CorpusFManifest } from '../corpus/corpus-f/ingest.js';

async function main(): Promise<void> {
  const root = 'benchmarks/corpus/corpus-f';
  const manifest: CorpusFManifest = JSON.parse(await readFile(`${root}/manifest.json`, 'utf8'));
  const fixture = manifest.circuits.find(row => row.sourcePath === 'examples/plot/inv-chain-pyplot.cir');
  assert(fixture);
  // Alias quit/exit only in the wrapper to export retained plots after sourcing the byte-identical deck.
  const measured = await runFixture(fixture, runControlReference);
  measured.ngspice.note = '#1631 targeted re-score via unchanged-fixture control export wrapper (quit/exit deferred); reproduce with MPLBACKEND=Agg spice-heavy pnpm exec tsx benchmarks/control-pyplot/compare.ts';
  console.log(JSON.stringify(measured, null, 2));
  assert.equal(measured.ngspice.status, 'success');
  assert.equal(measured.spiceTs.status, 'success');
  assert(measured.comparedSignals > 0);
  assert(measured.worstNormalizedError !== null);
  assert(['matched', 'mismatch'].includes(measured.outcome));
  if (process.argv.includes('--update')) {
    const report: CorpusFReport = JSON.parse(await readFile(`${root}/outcomes.json`, 'utf8'));
    report.fixtures = report.fixtures.map(row => row.id === fixture.id ? measured : row);
    Object.assign(report, summarize(report.fixtures));
    report.outcomeSha256 = outcomeDigest(report);
    await writeFile(`${root}/outcomes.json`, stableReport(report));
    await writeFile(`${root}/README.md`, mergeReadme(await readFile(`${root}/README.md`, 'utf8'), renderMarkdown(report)));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
