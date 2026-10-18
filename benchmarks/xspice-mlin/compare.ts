#!/usr/bin/env tsx
// Source the unchanged deck; observe its existing z vector, without editing it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { simulate } from '../../packages/core/src/index.js';
import { readNgspiceRawFile } from '../corpus/corpus-f/raw-stream.js';

async function main(): Promise<void> {
  const fixture = resolve('benchmarks/corpus/corpus-f/fixtures/examples/xspice/transmission_lines/mlin.cir');
  const bytes = readFileSync(fixture);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== 'ec539c7b6dc4c3da7a9b368ceb44c7760fceb0f68d4444a6d2d3e3ef3dee1089') throw new Error('fixture changed');
  const work = mkdtempSync(join(tmpdir(), 'mlin-'));
  try {
    const raw = join(work, 'ac.raw');
    const observer = join(work, 'observer.cir');
    writeFileSync(observer, `Observer\n.control\nsource ${fixture}\nset filetype=ascii\nsetplot ac1\nwrite ${raw} z\nquit\n.endc\n.end\n`);
    const start = performance.now();
    execFileSync('ngspice', ['-n', '-b', observer], { stdio: 'pipe', env: { ...process.env, DISPLAY: '' }, timeout: 30000 });
    const ngspiceMs = performance.now() - start;
    const [reference] = await readNgspiceRawFile(raw);
    const ref = reference.signals.z ?? reference.signals['v(z)'];
    if (!ref) throw new Error(`missing z: ${Object.keys(reference.signals)}`);
    const tsStart = performance.now();
    const result = await simulate(bytes.toString());
    const spiceTsMs = performance.now() - tsStart;
    const ac = result.control!.runs.find(run => run.result.ac)?.result.ac;
    if (!ac || ac.frequencies.length !== 200 || reference.grid.length !== 200) throw new Error('expected 200 AC points');
    const v = ac.voltage('in'), current = ac.current('v1');
    const actual = v.map((p, i) => {
      if (Math.abs(ac.frequencies[i] - reference.grid[i]) > reference.grid[i] * 1e-12) throw new Error('frequency mismatch');
      const phase = (p.phase - current[i].phase - 180) * Math.PI / 180;
      const mag = p.magnitude / current[i].magnitude;
      return { re: mag * Math.cos(phase), im: mag * Math.sin(phase) };
    });
    const errors = actual.map((p, i) => Math.hypot(p.re - ref[i].re, p.im - ref[i].im));
    const maximumNormalizedError = Math.max(...errors) / Math.max(...ref.map(p => Math.hypot(p.re, p.im)));
    console.log(JSON.stringify({ fixture, sha256, identicalDeckBytes: true, points: actual.length, maximumNormalizedError,
      outcome: maximumNormalizedError < .01 ? 'match' : 'spice-ts-loss',
      versions: { ngspice: execFileSync('ngspice', ['--version'], { encoding: 'utf8' }).match(/ngspice-\d+/)?.[0], node: process.version },
      machine: { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
      runtimeMilliseconds: { ngspice: ngspiceMs, spiceTs: spiceTsMs }, caveat: 'Different process boundaries; not a speed claim.' }, null, 2));
    if (!Number.isFinite(maximumNormalizedError) || maximumNormalizedError >= .01) process.exitCode = 1;
  } finally { rmSync(work, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
