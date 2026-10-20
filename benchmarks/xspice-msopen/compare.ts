#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { simulate } from '../../packages/core/src/index.js';
import { readNgspiceRawFile } from '../corpus/corpus-f/raw-stream.js';

async function main(): Promise<void> {
  const fixture = readFileSync(resolve('benchmarks/xspice-msopen/terminated.cir'), 'utf8');
  const work = mkdtempSync(join(tmpdir(), 'msopen-'));
  const version = execFileSync('ngspice', ['--version'], { encoding: 'utf8' }).match(/ngspice-\d+/)?.[0];
  if (version !== 'ngspice-47') throw new Error(`Expected ngspice-47, got ${version}`);
  const cases = [];
  const metrics = [];
  try {
    for (const [name, netlist] of [
      ['kirschning', fixture],
      ['hammerstad', fixture.replace('msopen(w=', 'msopen(msopen_model=1 w=')],
      ['alexopoulos', fixture.replace('msopen(w=', 'msopen(msopen_model=2 w=')],
      ['zero-thickness', fixture.replaceAll('t=35u', 't=0')],
    ]) {
      const input = join(work, 'input.cir'), observer = join(work, 'observer.cir');
      const opPath = join(work, 'op.raw'), acPath = join(work, 'ac.raw');
      writeFileSync(input, netlist);
      writeFileSync(observer, `Observer\n.control\nsource ${input}\nop\nac dec 20 1e8 2e10\nset filetype=ascii\nsetplot op1\nwrite ${opPath} v(in) v(out) i(v1)\nsetplot ac1\nwrite ${acPath} v(in)\nquit\n.endc\n.end\n`);
      const ngStart = performance.now();
      execFileSync('ngspice', ['-n', '-b', observer], { stdio: 'pipe', timeout: 30000, env: { ...process.env, DISPLAY: '' } });
      const ngspiceMs = performance.now() - ngStart;
      const [op] = await readNgspiceRawFile(opPath), [ac] = await readNgspiceRawFile(acPath);
      const opValues = { input: op.signals['v(in)'][0].re, output: op.signals['v(out)'][0].re, current: op.signals['i(v1)'][0].re };
      const points = ac.grid.map((frequency, i) => ({ frequency, ...ac.signals['v(in)'][i] }));
      const tsStart = performance.now();
      const result = await simulate(netlist);
      const spiceTsMs = performance.now() - tsStart;
      if (result.dc!.voltage('in') !== opValues.input || result.dc!.voltage('out') !== opValues.output || result.dc!.current('v1') !== opValues.current) throw new Error(`${name}: OP mismatch`);
      const actual = result.ac!.voltage('in');
      if (actual.length !== points.length) throw new Error('point count mismatch');
      let maxMagnitudeRelativeError = 0, maxPhaseRelativeError = 0, maxComplexRelativeError = 0;
      for (const [i, ref] of points.entries()) {
        if (Math.abs(result.ac!.frequencies[i] / ref.frequency - 1) > 1e-12) throw new Error('grid mismatch');
        const magnitude = Math.hypot(ref.re, ref.im), phase = Math.atan2(ref.im, ref.re) * 180 / Math.PI;
        const phaseError = Math.abs(((actual[i].phase - phase + 540) % 360) - 180);
        maxMagnitudeRelativeError = Math.max(maxMagnitudeRelativeError, Math.abs(actual[i].magnitude / magnitude - 1));
        maxPhaseRelativeError = Math.max(maxPhaseRelativeError, phaseError / Math.abs(phase));
        const radians = actual[i].phase * Math.PI / 180;
        maxComplexRelativeError = Math.max(maxComplexRelativeError, Math.hypot(actual[i].magnitude * Math.cos(radians) - ref.re, actual[i].magnitude * Math.sin(radians) - ref.im) / magnitude);
      }
      const errors = [maxMagnitudeRelativeError, maxPhaseRelativeError, maxComplexRelativeError];
      const match = errors.every(e => Number.isFinite(e) && e < 1e-4);
      metrics.push({ name, sha256: createHash('sha256').update(netlist).digest('hex'), identicalDeckBytes: true,
        points: points.length, opExact: true, maxMagnitudeRelativeError, maxPhaseRelativeError, maxComplexRelativeError,
        outcome: match ? 'match' : 'spice-ts-loss', runtimeMilliseconds: { ngspice: ngspiceMs, spiceTs: spiceTsMs } });
      if (!match) process.exitCode = 1;
      cases.push({ name, netlist, op: opValues, ac: points });
    }
    if (process.argv.includes('--update-reference')) writeFileSync(resolve('benchmarks/xspice-msopen/ngspice-47.json'), JSON.stringify({ version, cases }, null, 2) + '\n');
    console.log(JSON.stringify({ version, machine: { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
      node: process.version, caveat: 'Single runs with different process boundaries, not a speed claim.', metrics }, null, 2));
  } finally { rmSync(work, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
