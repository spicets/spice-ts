// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulate } from '../../../packages/core/src/simulate.js';
import { parseNgspiceRaw } from '../../comparison-harness.js';

async function main(): Promise<void> {
  assert.match(execFileSync('ngspice', ['--version'], { encoding: 'utf8' }), /ngspice-47\b/);
  const update = process.argv.includes('--update');
  const directory = new URL('./', import.meta.url);
  const scratch = mkdtempSync(join(tmpdir(), 'bjt-instance-1852-'));
  const oracle: { name: string; values: Record<string, number[]> }[] = [];
  try {
    for (const name of readdirSync(directory).filter(name => name.endsWith('.cir')).sort()) {
      const deck = readFileSync(new URL(name, directory), 'utf8');
      const input = join(scratch, 'deck.cir');
      const raw = join(scratch, 'out.raw');
      writeFileSync(input, deck);
      execFileSync('ngspice', ['-n', '-b', '-r', raw, input], {
        encoding: 'utf8', env: { ...process.env, SPICE_ASCIIRAWFILE: '1' }, timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.equal(readFileSync(input, 'utf8'), deck);
      const plots = parseNgspiceRaw(readFileSync(raw, 'utf8'));
      const plot = plots.find(plot => plot.grid.length === (name.includes('-dc') ? 61 : 1));
      assert.ok(plot);
      const values = Object.fromEntries(Object.entries(plot.signals)
        .filter(([signal]) => /^(v|i)\(/.test(signal))
        .map(([signal, points]) => [signal, points.map(point => point.re)]));
      oracle.push({ name, values });
      if (update) continue;
      const result = await simulate(deck);
      let worstRelativeError = 0;
      for (const [signal, expected] of Object.entries(values)) {
        const node = signal.slice(2, -1);
        const current = signal.startsWith('i(');
        const actual = result.dcSweep
          ? Array.from(current ? result.dcSweep.current(node) : result.dcSweep.voltage(node))
          : [current ? result.dc!.current(node) : result.dc!.voltage(node)];
        assert.equal(actual.length, expected.length);
        expected.forEach((reference, index) => {
          const error = reference === 0 ? Math.abs(actual[index]) : Math.abs((actual[index] - reference) / reference);
          assert.ok(Number.isFinite(error));
          worstRelativeError = Math.max(worstRelativeError, error);
          assert.ok(error <= 1e-6, `${name} ${signal}[${index}] relative error ${error}`);
        });
      }
      console.log(JSON.stringify({ name, points: plot.grid.length, signals: Object.keys(values).length, worstRelativeError }));
    }
    assert.equal(oracle.length, 12);
    if (update) writeFileSync(new URL('oracle.json', directory), JSON.stringify(oracle, null, 2) + '\n');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
