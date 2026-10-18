#!/usr/bin/env tsx
/** Unchanged corpus-f analog delay, ngspice-47. Run via spice-heavy after pnpm build. */
import { readFile, writeFile } from 'node:fs/promises';
import { runControlReference } from '../corpus/corpus-f/control-vectors.js';
import { normalizedSignalErrors, pairedReferenceSeries } from '../corpus/corpus-f/lib.js';
import { runBoundedSimulatePacked, runFixture, outcomeDigest, summarize, renderMarkdown, mergeReadme, stableReport, type CorpusFReport } from '../corpus/corpus-f/outcomes.js';
import { compareInBatches, lazyExecution, packExecution } from '../corpus/corpus-f/packed.js';
import type { ClassicAnalysisType } from '../corpus/classic/report.js';
import type { CorpusFManifest } from '../corpus/corpus-f/ingest.js';

async function main(): Promise<void> {
const root = 'benchmarks/corpus/corpus-f';
const manifest: CorpusFManifest = JSON.parse(await readFile(`${root}/manifest.json`, 'utf8'));
const fixture = manifest.circuits.find(c => c.sourcePath === 'examples/xspice/delay/analog-delay1.cir')!;
const input = await readFile(fixture.localPath);
const native = await runBoundedSimulatePacked(input, { ...fixture, category: 'corpus-f', analyses: fixture.analyses as ClassicAnalysisType[],
  ngspice: { expectedStatus: 'pass' }, spiceTs: { expectedStatus: 'pass' } });
const reference = await runControlReference(input, fixture);
const view = lazyExecution(native);
const comparisons = compareInBatches(native, packExecution(reference.execution));
const { errors, missing } = normalizedSignalErrors(comparisons, pairedReferenceSeries(view, reference.execution));
const outputs = errors.filter(e => /^v\(out[1-5]\)$/.test(e.signal));
if (native.status !== 'success' || reference.status !== 'success' || outputs.length !== 5 || missing) {
  throw new Error(JSON.stringify({ native: native.status, reference: reference.status, outputs, missing }));
}
const controlOutcome = await runFixture(fixture, runControlReference);
const headline = await runFixture(fixture);
console.log(JSON.stringify({ fixture: fixture.sourcePath, sha256: fixture.sha256, outputs, controlOutcome, headline }, null, 2));
if (process.argv.includes('--update')) {
  const report: CorpusFReport = JSON.parse(await readFile(`${root}/outcomes.json`, 'utf8'));
  report.fixtures = report.fixtures.map(row => row.id === fixture.id ? headline : row);
  Object.assign(report, summarize(report.fixtures));
  report.outcomeSha256 = outcomeDigest(report);
  await writeFile(`${root}/outcomes.json`, stableReport(report));
  let markdown = mergeReadme(await readFile(`${root}/README.md`, 'utf8'), renderMarkdown(report));
  const bucket = controlOutcome.outcome === 'matched' ? 'match' : 'loss';
  const line = `| [${fixture.sourcePath}](fixtures/${fixture.sourcePath}) | ${bucket} | ${controlOutcome.outcome} | ${controlOutcome.worstNormalizedError} | ${controlOutcome.worstSignal} | https://github.com/mfiumara/spice-ts/issues/1335 | #1335 unchanged-deck max normalized errors: ${outputs.map(e => `${e.signal}=${e.normalized.toPrecision(6)}`).join(', ')}. Reproduce: spice-heavy pnpm exec tsx benchmarks/xspice-delay/compare.ts |`;
  const rows = markdown.split('\n');
  const indices = rows.flatMap((row, i) => row.startsWith(`| [${fixture.sourcePath}]`) ? [i] : []);
  if (indices.length < 2) throw new Error(`Expected headline and control rows, found ${indices.length}`);
  rows[indices.at(-1)!] = line;
  await writeFile(`${root}/README.md`, rows.join('\n'));
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
