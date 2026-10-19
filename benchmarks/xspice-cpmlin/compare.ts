#!/usr/bin/env tsx
// Observe the unchanged corpus-f SP deck; no fixture or tolerance overrides.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { simulate } from '../../packages/core/src/index.js';
import { readNgspiceRawFile } from '../corpus/corpus-f/raw-stream.js';

async function main(): Promise<void> {
  const fixture = resolve('benchmarks/corpus/corpus-f/fixtures/examples/xspice/transmission_lines/cpmline_ac.cir');
  const bytes = readFileSync(fixture);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const work = mkdtempSync(join(tmpdir(), 'cpmlin-'));
  try {
    const raw = join(work, 'sp.raw');
    const observer = join(work, 'observer.cir');
    writeFileSync(observer, `Observer\n.control\nsource ${fixture}\nset filetype=ascii\nsetplot sp1\nwrite ${raw} all\nquit\n.endc\n.end\n`);
    const start = performance.now();
    execFileSync('ngspice', ['-n', '-b', observer], { stdio: 'pipe', env: { ...process.env, DISPLAY: '', SPICE_ASCIIRAWFILE: '1' }, timeout: 30000 });
    const ngspiceMs = performance.now() - start;
    const [reference] = await readNgspiceRawFile(raw);
    const tsStart = performance.now();
    const result = await simulate(bytes.toString());
    const spiceTsMs = performance.now() - tsStart;
    const sp = result.control!.runs.find(run => run.result.sParameters)?.result.sParameters;
    if (!sp || sp.frequencies.length !== 100 || reference.grid.length !== 100) throw new Error('expected 100 SP points');
    const vectors = [];
    for (const [rawName, ref] of Object.entries(reference.signals)) {
      const name = rawName.replace(/^[vi]\((.+)\)$/, '$1');
      if (!sp.vectors.has(name.toUpperCase())) continue;
      const actual = sp.vector(name);
      if (actual.length !== ref.length) throw new Error(`length mismatch: ${name}`);
      const errors = actual.map((p, i) => {
        if (Math.abs(sp.frequencies[i] - reference.grid[i]) > reference.grid[i] * 1e-12) throw new Error('frequency mismatch');
        return Math.hypot(p.real - ref[i].re, p.imaginary - ref[i].im);
      });
      const peak = Math.max(...ref.map(p => Math.hypot(p.re, p.im)));
      const maximumNormalizedError = Math.max(...errors) / peak;
      vectors.push({ name, maximumNormalizedError });
    }
    // All S/Y/Z entries, not just the four plotted S parameters.
    if (vectors.length !== 48) throw new Error(`expected 48 common vectors, got ${vectors.length}; reference=${Object.keys(reference.signals)}; actual=${[...sp.vectors.keys()]}`);
    const worst = vectors.reduce((a, b) => a.maximumNormalizedError > b.maximumNormalizedError ? a : b);
    const match = vectors.every(v => Number.isFinite(v.maximumNormalizedError) && v.maximumNormalizedError < .01);
    console.log(JSON.stringify({ fixture, sha256, identicalDeckBytes: true, points: sp.frequencies.length,
      comparedVectors: vectors.length, worst, outcome: match ? 'match' : 'spice-ts-loss', vectors,
      exclusions: Object.keys(reference.signals).filter(name => !sp.vectors.has(name.replace(/^[vi]\((.+)\)$/, '$1').toUpperCase())),
      versions: { ngspice: execFileSync('ngspice', ['--version'], { encoding: 'utf8' }).match(/ngspice-\d+/)?.[0], node: process.version },
      machine: { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
      runtimeMilliseconds: { ngspice: ngspiceMs, spiceTs: spiceTsMs }, caveat: 'Different process boundaries; not a speed claim.' }, null, 2));
    if (!match) process.exitCode = 1;
  } finally { rmSync(work, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
