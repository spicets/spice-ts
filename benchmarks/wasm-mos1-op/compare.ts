// Original project-authored MIT suite. No per-circuit options or tolerances.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, arch, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpiceEngine } from '../../packages/wasm/dist/index.js';
import { fixtures } from '../../packages/wasm/src/test-support/mos1-fixtures.js';
import { parseNgspiceRaw } from '../comparison-harness.js';

async function main(): Promise<void> {
const command = 'spice-heavy pnpm exec tsx benchmarks/wasm-mos1-op/compare.ts';
const version = spawnSync('ngspice', ['--version'], { encoding: 'utf8' });
const ngspiceVersion = `${version.stdout}${version.stderr}`.match(/ngspice-\d+/)?.[0];
if (ngspiceVersion !== 'ngspice-47') throw new Error(`Expected ngspice-47, got ${ngspiceVersion}`);
const engines = await Promise.all(['spice-ts-js', 'spice-ts-wasm'].map(backend =>
  createSpiceEngine({ backend: backend as 'spice-ts-js' | 'spice-ts-wasm' })));
const results = [];
try {
  for (const fixture of fixtures) {
    const vectors: Record<string, number>[] = [];
    const runtimeMs: number[] = [];
    for (const engine of engines) {
      const start = performance.now();
      const result = await engine.simulate({ apiVersion: '1', input: { format: 'spice', source: fixture.source } }, { requestId: fixture.name });
      runtimeMs.push(performance.now() - start);
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const op = result.data.analyses[0];
      if (op?.type !== 'op') throw new Error('Expected OP');
      vectors.push(Object.fromEntries([
        ...Object.entries(op.voltagesV).map(([name, value]) => [`v(${name.toLowerCase()})`, value]),
        ...Object.entries(op.currentsA).map(([name, value]) => [`i(${name.toLowerCase()})`, value]),
      ]));
    }
    const directory = mkdtempSync(join(tmpdir(), 'wasm-mos1-'));
    try {
      const netlist = join(directory, 'input.cir');
      const raw = join(directory, 'op.raw');
      writeFileSync(netlist, fixture.source);
      writeFileSync(join(directory, '.spiceinit'), 'set filetype=ascii\n');
      const start = performance.now();
      const oracle = spawnSync('ngspice', ['-b', '-r', raw, netlist], {
        encoding: 'utf8', env: { ...process.env, HOME: directory }, timeout: 30_000,
      });
      runtimeMs.push(performance.now() - start);
      if (oracle.status !== 0) throw new Error(`${fixture.name}: ${oracle.stderr}`);
      const plot = parseNgspiceRaw(readFileSync(raw, 'utf8')).find(p => /operating point/i.test(p.plotName));
      if (!plot) throw new Error('Missing OP plot');
      const samples = Object.entries(vectors[1]!).map(([name, wasm]) => {
        const js = vectors[0]![name]!;
        const signal = name.startsWith('i(') ? `${name.slice(2, -1)}#branch` : name;
        const ngspice = (plot.signals[name] ?? plot.signals[signal])?.[0]?.re;
        if (ngspice === undefined) throw new Error(`Missing ngspice vector ${signal}`);
        const coreError = Math.abs(wasm - js);
        const ngspiceError = Math.abs(wasm - ngspice);
        return { name, wasm, js, ngspice, coreError, ngspiceError,
          coreNormalizedError: coreError / (1e-12 + 1e-9 * Math.abs(js)),
          ngspiceNormalizedError: ngspiceError / (1e-9 + 1e-6 * Math.abs(ngspice)),
        };
      });
      results.push({ name: fixture.name, inputSha256: createHash('sha256').update(fixture.source).digest('hex'), runtimeMs, samples });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
} finally { await Promise.all(engines.map(engine => engine.close())); }
const samples = results.flatMap(result => result.samples);
const report = {
  command, ngspiceVersion, ngspiceCommand: 'ngspice -b -r <temp>/op.raw <temp>/input.cir',
  date: new Date().toISOString(), node: process.version, machine: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  tolerances: { core: { absolute: 1e-12, relative: 1e-9 }, ngspice: { absolute: 1e-9, relative: 1e-6 } },
  baseline: { revision: '7df79475', supportedFixtures: 0, totalFixtures: fixtures.length },
  runtimeOrder: ['spice-ts-js', 'spice-ts-wasm', 'ngspice'],
  limitations: 'Single cold one-shot worker run per fixture, includes startup. Correctness evidence only; no speed claim. MOS1 OP only; charge, other levels/parameters and analyses rejected.',
  fixtureCount: results.length, sampleCount: samples.length,
  maxCoreNormalizedError: Math.max(...samples.map(sample => sample.coreNormalizedError)),
  maxNgspiceNormalizedError: Math.max(...samples.map(sample => sample.ngspiceNormalizedError)),
  maxCoreAbsoluteError: Math.max(...samples.map(sample => sample.coreError)),
  maxNgspiceAbsoluteError: Math.max(...samples.map(sample => sample.ngspiceError)),
  results,
};
writeFileSync(new URL('./report.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ fixtures: report.fixtureCount, samples: report.sampleCount, maxCoreNormalizedError: report.maxCoreNormalizedError, maxNgspiceNormalizedError: report.maxNgspiceNormalizedError }));
if (report.maxCoreNormalizedError > 1 || report.maxNgspiceNormalizedError > 1) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
