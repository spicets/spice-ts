// Run from repo root: spice-heavy pnpm exec tsx benchmarks/vbic-rbp/reference.ts
// The output is consumed by vbic-rbp.test.ts. Both engines use unmodified bytes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readNgspiceRawFile } from '../corpus/corpus-f/raw-stream.js';

async function main(): Promise<void> {
  const directory = resolve('benchmarks/vbic-rbp');
  const deck = join(directory, 'rbp.cir');
  const version = execFileSync('ngspice', ['--version'], { encoding: 'utf8' });
  if (!version.includes('ngspice-47')) throw new Error('Reference requires ngspice-47');
  const scratch = mkdtempSync(join(tmpdir(), 'vbic-rbp-'));
  try {
    const raw = join(scratch, 'rbp.raw');
    execFileSync('ngspice', ['-n', '-b', '-r', raw, deck], {
      env: { ...process.env, SPICE_ASCIIRAWFILE: '1', DISPLAY: '' }, stdio: 'pipe', timeout: 30000,
    });
    const plots = await readNgspiceRawFile(raw);
    const dc = plots.find(plot => plot.plotName.toLowerCase().includes('dc transfer'));
    const tran = plots.find(plot => plot.plotName.toLowerCase().includes('transient'));
    if (!dc || !tran) throw new Error(`Missing DC/TRAN plots: ${JSON.stringify(plots.map(p => p.plotName))}`);
    writeFileSync(join(directory, 'ngspice-47.json'), JSON.stringify({
      version: 'ngspice-47', sha256: createHash('sha256').update(readFileSync(deck)).digest('hex'),
      dc: { grid: dc.grid, signals: dc.signals },
      transient: { grid: tran.grid, signals: tran.signals },
    }) + '\n');
    console.info(`ngspice-47 reference: DC ${dc.grid.length} points, TRAN ${tran.grid.length} points`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
