import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { ClassicCircuit } from '../corpus/classic/report.js';
import { runBoundedSimulatePacked, runNgspicePacked, MATCH_RULE } from '../corpus/corpus-f/outcomes.js';
import { reduceRow, type Circuit } from '../corpus/corpus-j/parity.js';

const root = 'benchmarks/embedded-gpio-1889';
const ids = ['gpio-led', 'gpio-open-drain', 'gpio-npn-switch', 'gpio-mosfet-load', 'gpio-flyback', 'gpio-debounce'];
async function main() {
  const ngspice = spawnSync('ngspice', ['--version'], { encoding: 'utf8' }).stdout.split('\n').find(line => line.includes('ngspice-47'));
  if (!ngspice) throw new Error('ngspice-47 required');
  const fixtures = [];
  for (const id of ids) {
    const localPath = `${root}/${id}.cir`;
    const bytes = await readFile(localPath);
    const circuit = { id, source: 'project', sourcePath: localPath, sourceUrl: 'https://github.com/spicets/spice-ts', localPath,
      sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, licence: 'MIT', revision: 'project-authored',
      analyses: ['tran'], unmappedAnalyses: [], sameNameAs: [], includeClosure: [] } as unknown as Circuit;
    const startNg = performance.now();
    const ng = await runNgspicePacked(bytes, circuit);
    const ngspiceWallMs = performance.now() - startNg;
    const startTs = performance.now();
    const ts = await runBoundedSimulatePacked(bytes, { ...circuit, category: 'embedded-gpio', ngspice: { expectedStatus: 'pass' }, spiceTs: { expectedStatus: 'pass' } } as unknown as ClassicCircuit);
    const row = { ...reduceRow(circuit, ng, ts), runtime: { ngspiceWallMs, spiceTsWallMs: performance.now() - startTs } };
    fixtures.push(row);
    console.log(JSON.stringify({ id, outcome: row.outcome, error: row.worstNormalizedError, ng: row.ngspice.status, ts: row.spiceTs.status }));
  }
  await writeFile(`${root}/report.json`, JSON.stringify({ schemaVersion: 'embedded-gpio-1889/v1', ngspice: ngspice.trim(), node: process.version,
    machine: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model },
    coreTree: spawnSync('git', ['rev-parse', 'HEAD:packages/core'], { encoding: 'utf8' }).stdout.trim(),
    command: `spice-heavy pnpm exec tsx ${root}/run.ts`, matchRule: MATCH_RULE,
    runtimeNote: 'Cold process wall time including adapter and startup; not solver-only or browser performance.', fixtures }, null, 2) + '\n');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
