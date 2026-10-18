/** Unchanged corpus-f pwlts fixture, ngspice-47 and the uniform 1%-of-peak metric.
 * Run after pnpm build: spice-heavy pnpm exec tsx benchmarks/pwlts-1267/compare.ts
 * Source/licence: benchmarks/SOURCES.md and corpus/corpus-f/SOURCES.md (BSD-3-Clause).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runFixture } from '../corpus/corpus-f/outcomes.js';
import { runControlReference } from '../corpus/corpus-f/control-vectors.js';
import { runCorpusFSpiceTs } from '../corpus/corpus-f/plot-adapter.js';
import { compareExecutions } from '../aggregate-report.js';
import { normalizedSignalErrors } from '../corpus/corpus-f/lib.js';
import type { ClassicCircuit } from '../corpus/classic/report.js';
import type { CorpusFManifest } from '../corpus/corpus-f/ingest.js';

async function main() {
  const manifest: CorpusFManifest = JSON.parse(await readFile('benchmarks/corpus/corpus-f/manifest.json', 'utf8'));
  const circuit = manifest.circuits.find(c => c.sourcePath === 'examples/xspice/various/pwlts1.cir');
  if (!circuit) throw new Error('pwlts1 fixture is missing from the corpus-f manifest');
  const result = await runFixture(circuit, runControlReference);
  const input = await readFile(circuit.localPath);
  const reference = await runControlReference(input, circuit);
  const actual = await runCorpusFSpiceTs(input, { ...circuit, category: 'xspice', analyses: ['tran'],
    ngspice: { expectedStatus: 'pass' }, spiceTs: { expectedStatus: 'pass' } } as ClassicCircuit);
  const errors = normalizedSignalErrors(compareExecutions(actual, reference.execution),
    analysis => reference.execution.analyses.find(a => a.type === analysis)?.series);
  console.log(JSON.stringify({ result, ...errors }, null, 2));
  assert.equal(result.ngspice.status, 'success');
  assert.equal(result.spiceTs.status, 'success');
  assert.equal(result.outcome, 'matched');
  assert.equal(errors.missing, 0);
  for (const signal of ['v(3)', 'v(33)', 'v(4)', 'v(44)']) {
    assert.ok(errors.errors.some(error => error.signal === signal));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
