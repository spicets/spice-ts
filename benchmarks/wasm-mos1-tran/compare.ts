// Original MIT fixture. Default options for both engines and ngspice, identical deck bytes.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpiceEngine } from '../../packages/wasm/dist/index.js';
import { parseNgspiceRaw } from '../comparison-harness.js';

async function main(): Promise<void> {
  const source = readFileSync(new URL('./inverter.cir', import.meta.url), 'utf8');
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  const version = spawnSync('ngspice', ['--version'], { encoding: 'utf8' });
  if (!`${version.stdout}${version.stderr}`.includes('ngspice-47')) throw new Error('Requires ngspice-47');
  const directory = mkdtempSync(join(tmpdir(), 'mos1-tran-'));
  try {
    writeFileSync(join(directory, 'input.cir'), source);
    writeFileSync(join(directory, '.spiceinit'), 'set filetype=ascii\n');
    const start = performance.now();
    const run = spawnSync('ngspice', ['-b', '-r', 'tran.raw', 'input.cir'], {
      cwd: directory, env: { ...process.env, HOME: directory }, encoding: 'utf8', timeout: 30_000,
    });
    const ngspiceRuntimeMs = performance.now() - start;
    if (run.status !== 0) throw new Error(run.stderr);
    const plot = parseNgspiceRaw(readFileSync(join(directory, 'tran.raw'), 'utf8')).find(p => /transient/i.test(p.plotName));
    if (!plot) throw new Error('Missing transient');
    const oracle = { oracle: 'ngspice-47', sourceSha256, timeS: plot.grid,
      signals: Object.fromEntries(Object.entries(plot.signals).map(([key, values]) => [key, values.map(v => v.re)])) };
    if (process.argv.includes('--update-oracle')) writeFileSync(new URL('./ngspice.json', import.meta.url), `${JSON.stringify(oracle, null, 2)}\n`);
    const results = [];
    for (const backend of ['spice-ts-js', 'spice-ts-wasm'] as const) {
      const engine = await createSpiceEngine({ backend });
      try {
        const start = performance.now();
        const result = await engine.simulate({ apiVersion: '1', input: { format: 'spice', source } }, { requestId: backend });
        const runtimeMs = performance.now() - start;
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        const a = result.data.analyses[0];
        if (a?.type !== 'tran') throw new Error('Expected transient');
        const signals = [];
        for (const field of ['voltagesV', 'currentsA'] as const) {
          for (const [name, values] of Object.entries(a[field])) {
            const key = field === 'voltagesV' ? `v(${name.toLowerCase()})` : `i(${name.toLowerCase()})`;
            const reference = oracle.signals[key] ?? oracle.signals[`${name.toLowerCase()}#branch`];
            if (!reference) throw new Error(`Missing oracle signal ${key}`);
            let j = 0;
            let maxAbsoluteError = 0, squared = 0, maxRelativeError = 0, squaredRelative = 0;
            for (let i = 0; i < values.length; i++) {
              const time = a.timeS[i]!;
              while (j + 1 < oracle.timeS.length - 1 && oracle.timeS[j + 1]! < time) j++;
              const weight = (time - oracle.timeS[j]!) / (oracle.timeS[j + 1]! - oracle.timeS[j]!);
              const expected = reference[j]! + weight * (reference[j + 1]! - reference[j]!);
              const error = Math.abs(values[i]! - expected);
              const relative = error / Math.max(1e-12, Math.abs(expected));
              maxAbsoluteError = Math.max(maxAbsoluteError, error);
              maxRelativeError = Math.max(maxRelativeError, relative);
              squared += error * error;
              squaredRelative += relative * relative;
            }
            signals.push({ name: key, samples: values.length, maxAbsoluteError, rmsAbsoluteError: Math.sqrt(squared / values.length),
              maxRelativeError, rmsRelativeError: Math.sqrt(squaredRelative / values.length) });
          }
        }
        results.push({ backend, points: a.timeS.length, runtimeMs, signals });
      } finally { await engine.close(); }
    }
    console.log(JSON.stringify({ sourceSha256, oracle: 'ngspice-47', machine: `${arch()} ${cpus()[0]?.model}`,
      comparison: 'default options, ngspice linearly interpolated at engine times; relative denominator floor 1e-12 in signal units',
      ngspicePoints: oracle.timeS.length, ngspiceRuntimeMs, results }, null, 2));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
