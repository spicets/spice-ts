// Run from repo root: spice-heavy pnpm exec tsx benchmarks/vbic-vtf/reference.ts
// Writes the ngspice-47 fixture consumed by vbic-vtf.test.ts; no netlist rewriting.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readNgspiceRawFile } from '../corpus/corpus-f/raw-stream.js';

async function main(): Promise<void> {
  const directory = resolve('benchmarks/vbic-vtf');
  const deck = join(directory, 'vtf.cir');
  const version = execFileSync('ngspice', ['--version'], { encoding: 'utf8' });
  if (!version.includes('ngspice-47')) throw new Error('Reference requires ngspice-47');
  const scratch = mkdtempSync(join(tmpdir(), 'vbic-vtf-'));
  try {
    const raw = join(scratch, 'vtf.raw');
    execFileSync('ngspice', ['-n', '-b', '-r', raw, deck], {
      env: { ...process.env, SPICE_ASCIIRAWFILE: '1', DISPLAY: '' }, stdio: 'pipe', timeout: 30000,
    });
    const plots = await readNgspiceRawFile(raw);
    const ac = plots.find(plot => plot.plotName.toLowerCase().includes('ac analysis'));
    const tran = plots.find(plot => plot.plotName.toLowerCase().includes('transient'));
    if (!ac || !tran) throw new Error(`Missing AC/TRAN plots: ${JSON.stringify(plots.map(p => p.plotName))}`);
    const reference = {
      version: 'ngspice-47', sha256: createHash('sha256').update(readFileSync(deck)).digest('hex'),
      ac: { grid: ac.grid, signals: ac.signals },
      transient: { grid: tran.grid, signals: tran.signals },
    };
    writeFileSync(join(directory, 'ngspice-47.json'), JSON.stringify(reference) + '\n');
    console.info(`ngspice-47 reference: AC ${ac.grid.length} points, TRAN ${tran.grid.length} points`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
