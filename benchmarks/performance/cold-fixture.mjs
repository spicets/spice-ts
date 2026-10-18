#!/usr/bin/env node
/** Rotated fresh-process release-adapter measurements of one unchanged manifest deck.
 * spice-heavy node benchmarks/performance/cold-fixture.mjs OUT.json ngspice FIXTURE \
 *   baseline=/installed/core/dist/index.js before=/saved/dist/index.js after=/built/dist/index.js
 * Preserve whole dist directories (including chunks) and the original package.json
 * module type. Missing type=module changes tsx's loading path and invalidates comparisons.
 * Timings exclude Node/tsx startup,
 * include core import, parse precheck, simulate and adapter mapping, as in then-vs-now.ts.
 * Output is scratch evidence. Baseline waveforms may differ; before/after must not.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deserialize, serialize } from 'node:v8';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [output, corpus, id, ...entries] = process.argv.slice(2);
const modules = entries.map(entry => {
  const split = entry.indexOf('=');
  if (split < 1) throw new Error('expected label=/path/to/core/dist/index.js');
  return { label: entry.slice(0, split), entry: resolve(entry.slice(split + 1)) };
});
if (!output || !corpus || !id || modules.length < 2
  || new Set(modules.map(m => m.label)).size !== modules.length) {
  throw new Error('OUT.json CORPUS FIXTURE and >=2 unique label=entry arguments required');
}
const circuit = JSON.parse(readFileSync(join(root, 'benchmarks/corpus', corpus, 'manifest.json'), 'utf8'))
  .circuits.find(circuit => circuit.id === id);
if (!circuit) throw new Error('fixture not found');
const input = readFileSync(join(root, circuit.localPath));
const hash = value => createHash('sha256').update(value).digest('hex');
if (hash(input) !== circuit.sha256) throw new Error('fixture SHA256 mismatch');
const directory = mkdtempSync(join(tmpdir(), 'cold-fixture-'));
const samples = [];
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  for (let round = 0; round < 9; round++) {
    const offset = round % modules.length;
    const order = [...modules.slice(offset), ...modules.slice(0, offset)];
    for (const module of order) {
      const jobPath = join(directory, 'job.v8');
      const resultPath = join(directory, 'result.v8');
      writeFileSync(jobPath, serialize({ input, circuit, engine: 'candidate', coreModule: pathToFileURL(module.entry).href }));
      rmSync(resultPath, { force: true });
      const start = performance.now();
      const child = spawnSync(process.execPath, ['--import', 'tsx',
        'benchmarks/release/then-vs-now.ts', '--worker', jobPath, '--result', resultPath],
      { cwd: root, encoding: 'utf8', timeout: 120000 });
      const wallMs = performance.now() - start;
      if (child.error || child.status !== 0) throw new Error(`${module.label}: ${child.error ?? child.stderr}`);
      const receipt = deserialize(readFileSync(resultPath));
      if (receipt.execution.status !== 'success' || !Number.isFinite(receipt.runtimeMs)) {
        throw new Error(JSON.stringify(receipt.execution));
      }
      samples.push({ round, engine: module.label, runtimeMs: receipt.runtimeMs, wallMs,
        resultHash: hash(JSON.stringify(receipt.execution)) });
    }
  }
  const summary = modules.map(module => {
    const rows = samples.filter(sample => sample.engine === module.label);
    const resultHashes = [...new Set(rows.map(sample => sample.resultHash))];
    if (rows.length !== 9 || resultHashes.length !== 1) throw new Error('non-deterministic results');
    return { engine: module.label, samples: rows.length, medianMs: median(rows.map(row => row.runtimeMs)),
      medianProcessWallMs: median(rows.map(row => row.wallMs)), resultHashes };
  });
  const before = summary.find(row => row.engine === 'before');
  const after = summary.find(row => row.engine === 'after');
  if (before && after && before.resultHashes[0] !== after.resultHashes[0]) throw new Error('before/after waveform changed');
  writeFileSync(output, JSON.stringify({ node: process.version, cpu: cpus()[0].model,
    fixture: `${corpus}/${id}`, netlistSha256: hash(input),
    modules: modules.map(module => ({ ...module, entrySha256: hash(readFileSync(module.entry)) })),
    summary, samples }, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
