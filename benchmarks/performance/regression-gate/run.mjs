import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, arch } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rcLadderTran } from '../scaling-m2-fixture.mjs';
import { cases, compare, order } from './gate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [basePath, candidatePath, outPath] = process.argv.slice(2);
if (!basePath || !candidatePath || !outPath) throw new Error('usage: node run.mjs BASE_ROOT CANDIDATE_ROOT OUTPUT_DIR');
const out = resolve(outPath); mkdirSync(out, { recursive: true });
for (const [label, root, expected] of [['base', basePath, process.env.BASE_SHA], ['candidate', candidatePath, process.env.HEAD_SHA]]) {
  if (expected) {
    const revision = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (revision.status !== 0 || revision.stdout.trim() !== expected) throw new Error(`${label} checkout SHA mismatch`);
  }
}
writeFileSync(join(out, 'revisions.json'), JSON.stringify({ base: process.env.BASE_SHA || null, candidate: process.env.HEAD_SHA || null }, null, 2) + '\n');
const sha = data => createHash('sha256').update(data).digest('hex');
const host = JSON.stringify({ platform: platform(), release: release(), arch: arch(), cpu: cpus()[0].model });
const roots = { base: resolve(basePath), candidate: resolve(candidatePath) };
const receipts = Object.fromEntries(Object.entries(roots).map(([key, root]) => [key, { engine: 'spice-ts', version: JSON.parse(readFileSync(join(root, 'packages/core/package.json'))).version, runtime: process.version, environment: host, cases: {} }]));
const decks = Object.fromEntries(cases.map((id, i) => [id, rcLadderTran([10, 100, 1000][i]).netlist]));
for (const id of cases) {
  writeFileSync(join(out, id + '.cir'), decks[id]);
  for (const receipt of Object.values(receipts)) receipt.cases[id] = { deck: sha(decks[id]), samples: [] };
}
function save() { for (const [key, receipt] of Object.entries(receipts)) writeFileSync(join(out, key + '.json'), JSON.stringify(receipt, null, 2) + '\n'); }
save();
try {
  for (let round = 0; round < 5; round++) {
    const rotatedCases = [...cases.slice(round % cases.length), ...cases.slice(0, round % cases.length)];
    for (const id of rotatedCases) for (const variant of order(round)) {
      const entry = join(roots[variant], 'packages/core/dist/index.js');
      const results = {};
      for (const mode of ['cold', 'warm']) {
        const start = performance.now();
        const child = spawnSync(process.execPath, [join(here, 'worker.mjs'), entry, join(out, id + '.cir'), mode], { encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024 });
        const wall = performance.now() - start;
        if (child.error || child.status !== 0) throw new Error(`${variant} ${id} ${mode}: ${child.error || child.stderr}`);
        results[mode] = { ...JSON.parse(child.stdout), wall };
      }
      if (results.cold.output !== results.warm.output || results.cold.points !== results.warm.points) throw new Error(`cold/warm output mismatch ${variant} ${id}`);
      receipts[variant].cases[id].samples.push({ cold: results.cold.wall, warm: results.warm.elapsed, output: results.cold.output, points: results.cold.points, round });
      save();
      console.log(`${round} ${variant} ${id}: cold ${results.cold.wall.toFixed(2)}ms warm ${results.warm.elapsed.toFixed(2)}ms`);
    }
  }
  const summary = compare(receipts.base, receipts.candidate);
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
} catch (error) {
  save(); writeFileSync(join(out, 'error.txt'), String(error.stack || error) + '\n');
  throw error;
}
