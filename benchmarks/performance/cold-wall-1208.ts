#!/usr/bin/env tsx
/**
 * Fresh-process adapter wall comparison for #1208. No deck/tolerance changes.
 * Build each revision separately; pass its retained dist/index.js:
 * spice-heavy pnpm exec tsx benchmarks/performance/cold-wall-1208.ts \
 *   --baseline /path/to/before/dist/index.js --candidate /path/to/after/dist/index.js \
 *   --output /path/to/scratch/result.json
 * Both packages should have the same package.json (type: module) and directory layout.
 * Sources/licences: benchmarks/SOURCES.md; generated RC ladder is repository MIT.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serialize } from 'node:v8';
import { runNativeSpiceTs, type ClassicCircuit } from '../corpus/classic/report.js';
import { rcLadderTran } from './scaling-m2-fixture.mjs';

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), '../..');
const flag = (name: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const hash = (input: Buffer | string) => createHash('sha256').update(input).digest('hex');
const median = (values: number[]) => [...values].sort((a, b) => a - b)[4];

async function worker(): Promise<void> {
  const input = readFileSync(flag('--deck')!);
  const circuit = {
    analyses: /^\s*\.op\b/im.test(input.toString('utf8')) ? ['op', 'tran'] : ['tran'],
  } as ClassicCircuit;
  const execution = await runNativeSpiceTs(input, circuit, {
    coreModule: pathToFileURL(resolve(flag('--worker')!)).href,
  });
  if (execution.status !== 'success') throw new Error(`${execution.status}: ${execution.error}`);
  writeFileSync(flag('--result')!, serialize(execution));
}

function main(): void {
  const baseline = flag('--baseline');
  const candidate = flag('--candidate');
  const output = flag('--output');
  if (!baseline || !candidate || !output) throw new Error('--baseline, --candidate and --output required');
  const directory = mkdtempSync(join(tmpdir(), 'spice-cold-1208-'));
  const entries = { before: resolve(baseline), after: resolve(candidate) };
  const samples: { repeat: number; deck: string; side: 'before' | 'after'; ms: number; digest: string }[] = [];
  try {
    const rc = join(directory, 'rc.cir');
    writeFileSync(rc, rcLadderTran(1000).netlist);
    const decks = {
      jimi: resolve(root, 'benchmarks/corpus/ngspice/fixtures/examples/wave/jimi_fuzz.cir'),
      rc,
      mos6: resolve(root, 'benchmarks/corpus/ngspice/fixtures/tests/mos6/simpleinv.cir'),
    };
    for (let repeat = 0; repeat < 9; repeat++) {
      for (const [deck, path] of Object.entries(decks)) {
        const order = repeat % 2 ? ['after', 'before'] as const : ['before', 'after'] as const;
        for (const side of order) {
          const result = join(directory, 'result.v8');
          rmSync(result, { force: true });
          const started = performance.now();
          const child = spawnSync(process.execPath, [
            ...process.execArgv, script, '--worker', entries[side], '--deck', path, '--result', result,
          ], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
          const ms = performance.now() - started;
          if (child.status !== 0) throw new Error(child.error?.message ?? child.stderr.slice(-2000));
          samples.push({ repeat, deck, side, ms, digest: hash(readFileSync(result)) });
        }
      }
    }
    const summary = Object.keys(decks).map(deck => {
      const rows = samples.filter(sample => sample.deck === deck);
      const before = median(rows.filter(row => row.side === 'before').map(row => row.ms));
      const after = median(rows.filter(row => row.side === 'after').map(row => row.ms));
      const reductionPercent = 100 * (1 - after / before);
      const bitIdentical = new Set(rows.map(row => row.digest)).size === 1;
      return { deck, before, after, reductionPercent, bitIdentical,
        passed: bitIdentical && reductionPercent >= (deck === 'jimi' ? 15 : -3) };
    });
    mkdirSync(dirname(resolve(output)), { recursive: true });
    writeFileSync(output, JSON.stringify({ node: process.version, entries,
      boundary: 'fresh child launch through adapter import, parse, simulate, mapping and V8 serialization',
      samplesPerSide: 9, deckHashes: Object.fromEntries(Object.entries(decks).map(([name, path]) => [name, hash(readFileSync(path))])),
      samples, summary }, null, 2) + '\n');
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.every(row => row.passed)) process.exitCode = 1;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function entry(): Promise<void> {
  if (flag('--worker')) await worker();
  else main();
}

entry().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
