// Run: spice-heavy pnpm exec tsx benchmarks/vbic-resistance/reference.ts
// Self-authored single-transistor probe, reusing the unmodified corpus model.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readNgspiceRawFile } from '../corpus/corpus-f/raw-stream.js';

async function main(): Promise<void> {
  const directory = resolve('benchmarks/vbic-resistance');
  const original = readFileSync('benchmarks/corpus/corpus-f/fixtures/examples/vbic/DFF_Y_ECL.sp', 'utf8');
  if (createHash('sha256').update(original).digest('hex') !== 'd811ecfa0f370d281fb35729ca3177e738fe034621d9b2909765d9d70f527cc6') {
    throw new Error('DFF fixture bytes changed');
  }
  const model = original.slice(original.indexOf('.MODEL'), original.indexOf('.SAVE'));
  const deck = 'VBIC explicit zero resistance regression (project-authored MIT)\n'
    + 'VC c 0 -0.1326307805633016\nVB b 0 -0.25\nVE e 0 -0.5311834726396674\nVS s 0 -2\n'
    + 'Q1 c b e s NPN_VBIC_VLG\n' + model + '.op\n.end\n';
  const version = execFileSync('ngspice', ['--version'], { encoding: 'utf8' });
  if (!version.includes('ngspice-47')) throw new Error('Reference requires ngspice-47');
  const scratch = mkdtempSync(join(tmpdir(), 'vbic-resistance-'));
  try {
    const path = join(scratch, 'probe.cir');
    const raw = join(scratch, 'probe.raw');
    writeFileSync(path, deck);
    execFileSync('ngspice', ['-n', '-b', '-r', raw, path], {
      env: { ...process.env, SPICE_ASCIIRAWFILE: '1', DISPLAY: '' }, stdio: 'pipe', timeout: 30000,
    });
    const op = (await readNgspiceRawFile(raw)).find(p => p.plotName.toLowerCase().includes('operating point'));
    if (!op) throw new Error('Missing operating point');
    writeFileSync(join(directory, 'ngspice-47.json'), JSON.stringify({
      version: 'ngspice-47', deck, sha256: createHash('sha256').update(deck).digest('hex'), signals: op.signals,
    }) + '\n');
    console.info('ngspice-47 reference: single-transistor OP, unchanged DFF model');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
