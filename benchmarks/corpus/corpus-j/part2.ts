import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { fileURLToPath } from 'node:url';
import { runControlReference, hasControlBlock } from '../corpus-f/control-vectors.js';
import { runNgspicePacked, runBoundedSimulatePacked, outcomeDigest, MATCH_RULE, type ReferenceRun } from '../corpus-f/outcomes.js';
import { asPacked, type PackedExecution } from '../corpus-f/packed.js';
import type { ClassicCircuit } from '../classic/report.js';
import { ROOT, CHILD_BOUND_MS, WALL_BUDGET_MS, consumedWall, reduceRow, summarize, type Circuit, type Manifest } from './parity.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function ledger(path: string) {
  try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
async function bounded(circuit: Circuit, engine: 'ngspice' | 'spiceTs') {
  const total = consumedWall([...await ledger(`${ROOT}/wall.jsonl`), ...await ledger(`${ROOT}/part2-wall.jsonl`)]);
  if (total + CHILD_BOUND_MS > WALL_BUDGET_MS) throw new Error('cumulative budget exhausted');
  const directory = await mkdtemp(resolve(tmpdir(), 'corpus-j-part2-'));
  const resultPath = resolve(directory, 'execution.bin');
  const started = performance.now();
  await appendFile(`${ROOT}/part2-wall.jsonl`, JSON.stringify({ event: 'start', id: circuit.id, engine, reservationMs: CHILD_BOUND_MS }) + '\n');
  let timedOut = false;
  let diagnostic = '';
  const code = await new Promise<number | null>((done, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--engine', engine, circuit.id, resultPath],
      { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4000); });
    const timer = setTimeout(() => { timedOut = true; if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } } }, CHILD_BOUND_MS - 1000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); done(code); });
  });
  const wallMs = performance.now() - started;
  await appendFile(`${ROOT}/part2-wall.jsonl`, JSON.stringify({ event: 'end', id: circuit.id, engine, wallMs, timedOut, exitCode: code }) + '\n');
  try {
    if (!timedOut && code === 0) return { run: deserialize(await readFile(resultPath)) as ReferenceRun<PackedExecution>, wallMs };
    const error = timedOut ? 'owned group exceeded 19 s execution deadline (20 s boundary)' : `engine exited ${code}: ${diagnostic}`;
    return { run: { status: 'failed' as const, firstErrorLine: error, execution: { status: 'failed' as const, convergence: 'failed' as const, analyses: [], error } }, wallMs };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
async function main() {
const manifestBytes = await readFile(`${ROOT}/manifest.json`);
const manifest = JSON.parse(manifestBytes.toString()) as Manifest;
// The immutable manifest predates batch sensitivity support (#1633). Promote
// declarations symmetrically for both engines, as corpus-f/outcomes.ts does.
const circuits = manifest.circuits.slice(11).map(circuit => ({
  ...circuit,
  analyses: [...new Set([...circuit.analyses, ...circuit.unmappedAnalyses.filter(type => type === 'sens')])],
  unmappedAnalyses: circuit.unmappedAnalyses.filter(type => type !== 'sens'),
}));
if (process.argv[2] === '--engine') {
  const circuit = circuits.find(c => c.id === process.argv[4]);
  if (!circuit) throw new Error('unknown part2 fixture');
  const input = await readFile(circuit.localPath);
  if (hash(input) !== circuit.sha256) throw new Error('fixture hash mismatch');
  const run = process.argv[3] === 'ngspice' ? await (async () => {
    // Output-only source/write wrapper; fixture bytes, analyses and tolerances remain unchanged.
    const result = hasControlBlock(input.toString()) ? await runControlReference(input, circuit) : await runNgspicePacked(input, circuit);
    const execution = asPacked(result.execution);
    if (result.status === 'success' && execution.analyses.length === 0) return { ...result, execution, status: 'failed', firstErrorLine: result.note ?? 'no raw vectors' };
    return { ...result, execution };
  })() : await (async () => {
    const execution = await runBoundedSimulatePacked(input, { ...circuit, category: 'corpus-j', ngspice: { expectedStatus: 'pass' }, spiceTs: { expectedStatus: 'pass' } } as unknown as ClassicCircuit);
    return { status: execution.status, execution };
  })();
  await writeFile(process.argv[5], serialize(run));
} else {
  const version = spawnSync('ngspice', ['--version'], { encoding: 'utf8' }).stdout;
  if (!/ngspice-47\b/.test(version)) throw new Error('requires ngspice-47');
  const fixtures = [];
  for (const circuit of circuits) {
    const ng = await bounded(circuit, 'ngspice');
    const spice = await bounded(circuit, 'spiceTs');
    const row = { ...reduceRow(circuit, ng.run, spice.run.execution), runtime: { spiceTsChildWallMs: spice.wallMs, ngspiceChildWallMs: ng.wallMs } };
    fixtures.push(row);
    await writeFile(`${ROOT}/part2-checkpoint.json`, JSON.stringify(fixtures, null, 2) + '\n');
    console.log(`${circuit.id}: ng=${row.ngspice.status} ts=${row.spiceTs.status} ${row.outcome} ${row.spiceTs.firstErrorLine ?? ''}`);
  }
  const base = { schemaVersion: 'spice-ts-corpus-j-part2/v1', sources: manifest.sources.slice(2), manifestSha256: hash(manifestBytes),
    coreTree: spawnSync('git', ['rev-parse', 'HEAD:packages/core'], { encoding: 'utf8' }).stdout.trim(),
    tools: { ngspice: 'ngspice-47', spiceTs: JSON.parse(await readFile('packages/core/package.json', 'utf8')).version, node: process.version },
    environment: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model },
    commands: { generate: `spice-heavy pnpm exec tsx ${ROOT}/part2.ts`, verify: `pnpm exec tsx --test ${ROOT}/corpus-j.test.ts ${ROOT}/part2.test.ts`, ngspice: 'unchanged runControlReference for control decks, runNgspicePacked otherwise', spiceTs: 'unchanged runBoundedSimulatePacked on identical original bytes' },
    policy: { input: 'byte-identical', fixtureAdaptation: 'none', perCircuitToleranceTuning: false, matchThreshold: 0.01, matchRule: MATCH_RULE,
      childGroupBoundMs: CHILD_BOUND_MS, executionDeadlineMs: CHILD_BOUND_MS - 1000, cumulativeChildWallBudgetMs: WALL_BUDGET_MS,
      runtimeBoundary: 'serial cold owned engine group; includes Node/tsx, adapter, parse/solve, output export and serialization; no speed claim',
      controlExport: 'unchanged corpus-f source/write wrapper exports all retained plots by ID for each declared type, defers quit/exit; no netlist edits',
      fineReference: 'none; no adapted deck' },
    actualCumulativeChildWallMs: consumedWall([...await ledger(`${ROOT}/wall.jsonl`), ...await ledger(`${ROOT}/part2-wall.jsonl`)]),
    ...summarize(fixtures), fixtures };
  await writeFile(`${ROOT}/part2-outcomes.json`, JSON.stringify({ ...base, outcomeSha256: outcomeDigest(base as never) }, null, 2) + '\n');
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
