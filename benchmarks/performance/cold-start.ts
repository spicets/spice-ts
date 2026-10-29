#!/usr/bin/env tsx
/** Fresh process OP wall times for identical generated RC ladders. */
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { cpus, platform, release, arch, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export function generateDeck(nodes: number): string {
  if (!Number.isInteger(nodes) || nodes < 2) throw new Error('nodes must be an integer >= 2');
  const lines = [`* Generated RC ladder OP: ${nodes} nodes`, 'V1 n0 0 DC 1'];
  for (let i = 1; i < nodes; i++) lines.push(`R${i} n${i-1} n${i} 1k`, `C${i} n${i} 0 1p`);
  return [...lines, '.op', '.end', ''].join('\n');
}

// The child measures compilation within simulate using the actual Circuit method;
// solveMs is the remainder of simulate, including validation and result mapping.
const worker = `
const {readFileSync} = await import('node:fs');
const {createHash} = await import('node:crypto');
const start = performance.now();
const core = await import(process.argv[1]);
const imported = performance.now();
const bytes = readFileSync(process.argv[2]);
const beforeParse = performance.now();
const circuit = core.parse(bytes.toString('utf8'));
const parsed = performance.now();
const compile = circuit.compile.bind(circuit); let setupMs = 0, calls = 0;
circuit.compile = (...args) => { const t = performance.now(); const result = compile(...args); setupMs += performance.now()-t; calls++; return result; };
const result = await core.simulate(circuit);
const done = performance.now();
if (!result.dc || calls !== 1) throw Error('expected one compiled OP solve');
console.log(JSON.stringify({deckSha256:createHash('sha256').update(bytes).digest('hex'), importMs:imported-start, parseMs:parsed-beforeParse, setupMs, solveMs:done-parsed-setupMs}));`;

function run(command: string, args: string[]): { stdout: string; totalMs: number } {
  const start = performance.now();
  const child = spawnSync(command, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  const totalMs = performance.now() - start;
  if (child.error || child.status !== 0) throw new Error(`${command}: ${child.error ?? child.stderr}`);
  return { stdout: child.stdout, totalMs };
}
export function runPair(deck: string) {
  const dir = mkdtempSync(join(tmpdir(), 'spice-cold-'));
  const path = join(dir, 'deck.cir');
  try {
    writeFileSync(path, deck);
    const node = run(process.execPath, ['--input-type=module', '-e', worker, pathToFileURL(join(root, 'packages/core/dist/index.js')).href, path]);
    const spice = { ...JSON.parse(node.stdout), totalMs: node.totalMs } as {deckSha256: string; importMs: number; parseMs: number; setupMs: number; solveMs: number; totalMs: number};
    const before = sha(readFileSync(path));
    const native = run('ngspice', ['-b', path]);
    const after = sha(readFileSync(path));
    if (before !== after || spice.deckSha256 !== before || before !== sha(deck)) throw new Error('deck bytes changed');
    if (!/Node\s+Voltage/i.test(native.stdout)) throw new Error('ngspice did not produce an operating point');
    return { spice, ngspice: { deckSha256: before, totalMs: native.totalMs } };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const stat = (xs: number[]) => { const sorted = [...xs].sort ( (a,b) => a-b); return { median: sorted[Math.floor(sorted.length/2)], min: sorted[0] }; };
function main() {
  const runs = 5;
  const rows = [10, 100, 1000].map(nodes => {
    const deck = generateDeck(nodes);
    const samples = Array.from({ length: runs }, () => runPair(deck));
    return { nodes, netlistSha256: sha(deck), samples, spice: Object.fromEntries((['importMs','parseMs','setupMs','solveMs','totalMs'] as const).map(key => [key, stat(samples.map(s => s.spice[key]))])), ngspice: stat(samples.map(s => s.ngspice.totalMs)) };
  });
  const version = JSON.parse(readFileSync(join(root, 'packages/core/package.json'), 'utf8')).version;
  const result = { description: 'Cold fresh-process RC ladder operating-point wall time; solve includes validation and result mapping, ngspice includes output.', runs, node: process.version, host: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0].model, memoryBytes: totalmem() }, spiceTs: { version, sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() }, ngspice: execFileSync('ngspice', ['--version'], { encoding: 'utf8' }).trim(), comparison030: 'Not reproduced: no matching 0.3.0 run with this harness.', rows };
  const output = join(root, 'benchmarks/results/cold-start'); mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  const format = (n: number) => n.toFixed(3);
  const table = ['| Nodes | Import median/min ms | Parse median/min ms | Setup median/min ms | Solve median/min ms | spice-ts wall median/min ms | ngspice wall median/min ms |', '|---:|---:|---:|---:|---:|---:|---:|', ...rows.map(row => `| ${row.nodes} | ${(['importMs','parseMs','setupMs','solveMs','totalMs'] as const).map(key => `${format(row.spice[key].median)}/${format(row.spice[key].min)}`).join(' | ')} | ${format(row.ngspice.median)}/${format(row.ngspice.min)} |`)].join('\n');
  writeFileSync(join(output, 'result.md'), `# Cold process operating-point timings\n\nFive runs, milliseconds. Both engines receive the identical generated deck. Wall includes process startup and output; phase timings exclude startup. Solve includes validation and result mapping; ngspice timings include output. These are timing measurements, not correctness comparisons.\n\nCore ${version}, source ${result.spiceTs.sha}; Node ${result.node}; ${result.host.cpu}, ${result.host.platform} ${result.host.release}, ${result.host.arch}.\n\n${table}\n\n${result.comparison030}\n`);
  console.log(table);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
