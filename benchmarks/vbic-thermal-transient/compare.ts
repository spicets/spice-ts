// Run: spice-heavy pnpm exec tsx benchmarks/vbic-thermal-transient/compare.ts
// Provenance and the deliberately retained public-deck loss: SOURCES.md.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { arch, cpus, platform, release } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { ClassicCircuit } from '../corpus/classic/report.js';
import type { CorpusFCircuit } from '../corpus/corpus-f/ingest.js';
import { MATCH_RULE, runBoundedSimulatePacked, runNgspicePacked } from '../corpus/corpus-f/outcomes.js';
import { compareInBatches, lazyExecution } from '../corpus/corpus-f/packed.js';
import { normalizedSignalErrors, pairedReferenceSeries } from '../corpus/corpus-f/lib.js';

async function main(): Promise<void> {
  const version = spawnSync('ngspice', ['--version'], { encoding: 'utf8' }).stdout;
  if (!version.includes('ngspice-47')) throw new Error('requires ngspice-47');
  const manifest = JSON.parse(readFileSync('benchmarks/corpus/corpus-f/manifest.json', 'utf8')) as { circuits: CorpusFCircuit[] };
  const original = manifest.circuits.find(c => c.sourcePath === 'examples/vbic/vbic99_tran.sp');
  if (!original) throw new Error('missing public fixture');
  const path = 'benchmarks/vbic-thermal-transient/power-step.cir';
  const bytes = readFileSync(path);
  const authored: CorpusFCircuit = { ...original, id: 'vbic-thermal-power-step', localPath: path,
    sourcePath: path, sourceUrl: 'https://github.com/spicets/spice-ts/issues/1522',
    sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, analyses: ['tran'], sameNameAs: [] };
  console.log(JSON.stringify({ command: 'spice-heavy pnpm exec tsx benchmarks/vbic-thermal-transient/compare.ts',
    node: process.version, ngspice: '47', machine: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model },
    matchRule: MATCH_RULE, policy: 'Identical bytes. No per-circuit tolerance tuning. Cold wall times, not speed claims.' }));
  for (const circuit of [authored, original]) {
    const input = readFileSync(circuit.localPath);
    if (createHash('sha256').update(input).digest('hex') !== circuit.sha256) throw new Error('fixture hash mismatch');
    const startNg = performance.now();
    const ng = await runNgspicePacked(input, circuit);
    const ngMs = performance.now() - startNg;
    const startTs = performance.now();
    const ts = await runBoundedSimulatePacked(input, { ...circuit, category: 'vbic-thermal-transient',
      ngspice: { expectedStatus: 'pass' }, spiceTs: { expectedStatus: 'pass' } } as unknown as ClassicCircuit);
    const tsMs = performance.now() - startTs;
    const comparisons = ng.status === 'success' && ts.status === 'success' ? compareInBatches(ts, ng.execution) : [];
    const { errors, missing } = normalizedSignalErrors(comparisons, pairedReferenceSeries(lazyExecution(ts), lazyExecution(ng.execution)));
    console.log(JSON.stringify({ id: circuit.id, sha256: circuit.sha256,
      ngspice: { status: ng.status, error: ng.firstErrorLine, points: ng.execution.analyses.map(a => [a.type, a.grid.length]) },
      spiceTs: { status: ts.status, error: ts.error, points: ts.analyses.map(a => [a.type, a.grid.length]) },
      errors, missing, ngMs, tsMs, comparisons }));
    if (ng.status !== 'success') throw new Error(`ngspice did not run ${circuit.id}`);
    if (circuit === authored && (ts.status !== 'success' || errors.length === 0 || missing > 0
      || errors.some(e => !Number.isFinite(e.normalized) || e.normalized > 0.01))) {
      throw new Error('project-authored thermal power-step regression');
    }
    // The unchanged public deck still needs resistor-temperature physics.
    // Its failure is printed, not treated as a zero-error comparison or success.
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
