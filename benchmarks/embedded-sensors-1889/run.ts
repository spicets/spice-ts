import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { ClassicCircuit } from '../corpus/classic/report.js';
import { runBoundedSimulatePacked, runNgspicePacked, MATCH_RULE } from '../corpus/corpus-f/outcomes.js';
import { normalizedSignalErrors, pairedReferenceSeries } from '../corpus/corpus-f/lib.js';
import { lazyExecution } from '../corpus/corpus-f/packed.js';
import { reduceRow, type Circuit } from '../corpus/corpus-j/parity.js';

const root = 'benchmarks/embedded-sensors-1889';
const ids = ['anti-alias', 'two-stage', 'loaded-divider', 'thermistor', 'differential', 'rlc-input', 'shunt-sense'];
function cleanCoreTree() {
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'packages/core'], { encoding: 'utf8' });
  if (status.status !== 0 || status.error) throw new Error('Unable to check core source status');
  if (status.stdout.trim()) throw new Error('Dirty core inputs: commit or clean packages/core before benchmarking');
  const tree = spawnSync('git', ['rev-parse', 'HEAD:packages/core'], { encoding: 'utf8' });
  if (tree.status !== 0 || tree.error) throw new Error('Unable to identify core tree');
  return tree.stdout.trim();
}
async function main() {
  const coreTree = cleanCoreTree();
  // Build from the checked source rather than trusting a potentially stale ignored dist.
  await rm('packages/core/dist', { recursive: true, force: true });
  const build = spawnSync('pnpm', ['-C', 'packages/core', 'build'], { encoding: 'utf8' });
  if (build.status !== 0 || build.error) throw new Error(`Core build failed: ${build.stderr || build.stdout || build.error}`);
  if (cleanCoreTree() !== coreTree) throw new Error('Core tree changed during build');
  const coreBundleSha256 = createHash('sha256').update(await readFile('packages/core/dist/index.js')).digest('hex');
  const ngspice = spawnSync('ngspice', ['--version'], { encoding: 'utf8' }).stdout.split('\n').find(line => line.includes('ngspice-47'));
  if (!ngspice) throw new Error('ngspice-47 required');
  const fixtures = [];
  for (const id of ids) {
    const localPath = `${root}/${id}.cir`;
    const bytes = await readFile(localPath);
    const circuit = { id, source: 'project', sourcePath: localPath, sourceUrl: 'https://github.com/spicets/spice-ts', localPath,
      sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, licence: 'MIT', revision: 'project-authored',
      analyses: ['tran'], unmappedAnalyses: [], sameNameAs: [], includeClosure: [] } as unknown as Circuit;
    const ngTimes: number[] = [], tsTimes: number[] = [];
    let row: ReturnType<typeof reduceRow> | undefined;
    let normalizedErrors: ReturnType<typeof normalizedSignalErrors>['errors'] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const startNg = performance.now();
      const ng = await runNgspicePacked(bytes, circuit);
      ngTimes.push(performance.now() - startNg);
      const startTs = performance.now();
      const ts = await runBoundedSimulatePacked(bytes, { ...circuit, category: 'embedded-sensors', ngspice: { expectedStatus: 'pass' }, spiceTs: { expectedStatus: 'pass' } } as unknown as ClassicCircuit);
      tsTimes.push(performance.now() - startTs);
      const current = reduceRow(circuit, ng, ts);
      if (row && (row.outcome !== current.outcome || row.ngspice.status !== current.ngspice.status || row.spiceTs.status !== current.spiceTs.status)) throw new Error(`Inconsistent outcomes across runs: ${id}`);
      row = current;
      normalizedErrors = ng.status === 'success' && ts.status === 'success'
        ? normalizedSignalErrors(current.comparisons, pairedReferenceSeries(lazyExecution(ts), lazyExecution(ng.execution))).errors : [];
    }
    if (!row) throw new Error(`No result for ${id}`);
    const median = (samplesMs: number[]) => ({ samplesMs, medianMs: [...samplesMs].sort((a, b) => a - b)[1] });
    const result = { ...row, normalizedErrors, runtime: { ngspice: median(ngTimes), spiceTs: median(tsTimes) } };
    fixtures.push(result);
    console.log(JSON.stringify({ id, outcome: row.outcome, error: row.worstNormalizedError, ng: row.ngspice.status, ts: row.spiceTs.status }));
  }
  if (cleanCoreTree() !== coreTree) throw new Error('Core tree changed during benchmark');
  if (createHash('sha256').update(await readFile('packages/core/dist/index.js')).digest('hex') !== coreBundleSha256) throw new Error('Core bundle changed during benchmark');
  await writeFile(`${root}/report.json`, JSON.stringify({ schemaVersion: 'embedded-sensors-1889/v1', ngspice: ngspice.trim(), node: process.version,
    machine: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model },
    coreTree, coreBundleSha256, coreBuildCommand: 'pnpm -C packages/core build (after removing packages/core/dist)',
    command: `spice-heavy pnpm exec tsx ${root}/run.ts`, matchRule: MATCH_RULE,
    spiceTsVersion: JSON.parse(await readFile('packages/core/package.json', 'utf8')).version,
    runtimeNote: 'Median of three cold process wall times including adapter and startup; not solver-only or browser performance.', fixtures }, null, 2) + '\n');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
