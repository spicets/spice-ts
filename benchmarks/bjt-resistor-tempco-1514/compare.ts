// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulate } from '../../packages/core/src/simulate.js';
import { parseNgspiceRaw } from '../comparison-harness.js';

// --update regenerates the checked-in oracle consumed by the core regression test.
// Normal mode compares both engines on identical bytes, without changing fixtures.
async function main(): Promise<void> {
const update = process.argv.includes('--update');
assert.match(execFileSync('ngspice', ['--version'], { encoding: 'utf8' }), /ngspice-47\b/);
const dir = mkdtempSync(join(tmpdir(), 'bjt-tempco-1514-'));
const oracle: { name: string; deck: string; values: Record<string, number[]> }[] = [];
try {
  for (const [name, type, base, extra, analysis] of [
    ['npn-op', 'NPN', 'RB=500 RBM=50 IRB=0.2m', '', '.op'],
    ['pnp-sweep', 'PNP', 'RB=500 RBM=50 IRB=0.2m', '2 M=3', '.dc temp -15 105 20'],
    ['equal-rbm-sweep', 'NPN', 'RB=500 RBM=500', '', '.dc temp -15 105 20'],
    ['default-rbm-op', 'NPN', 'RB=500', '', '.op'],
    ['fixed-rb-sweep', 'NPN', 'RB=500 RBM=500', '', '.dc temp 105 -15 -20'],
  ]) {
    const sign = type === 'PNP' ? '-' : '';
    const deck = `BJT resistor temperature coefficients #1514, original MIT fixture
VC vc 0 ${sign}5
VB vb 0 ${sign}0.8
RLOAD vc c 100
RBIAS vb b 1k
Q1 c b 0 QM ${extra}
.model QM ${type} TNOM=25 IS=1e-14 BF=150 VAF=60 IKF=0.01 RE=10 RC=30
+ TRE1=0.001 TRE2=1e-6 TRC1=-0.002 TRC2=2e-6
+ TRB1=0.003 TRB2=3e-6 ${name === 'fixed-rb-sweep' ? 'TRM1=0.003 TRM2=3e-6' : 'TRM1=-0.001 TRM2=4e-6'} ${base}
.options temp=85 reltol=1e-8 abstol=1e-14 vntol=1e-10
${analysis}
.end
`;
    const input = join(dir, 'deck.cir');
    const raw = join(dir, 'out.raw');
    writeFileSync(input, deck);
    execFileSync('ngspice', ['-n', '-b', '-r', raw, input], {
      encoding: 'utf8', env: { ...process.env, SPICE_ASCIIRAWFILE: '1' }, timeout: 30_000,
    });
    assert.equal(readFileSync(input, 'utf8'), deck);
    const plot = parseNgspiceRaw(readFileSync(raw, 'utf8'))[0];
    assert.ok(plot);
    const values = Object.fromEntries(['v(c)', 'v(b)', 'i(vc)', 'i(vb)'].map(signal => {
      assert.ok(plot.signals[signal], `Missing ${signal}`);
      return [signal, plot.signals[signal].map(value => value.re)];
    }));
    oracle.push({ name, deck, values });
    if (update) continue;
    const result = await simulate(deck);
    let maxRelativeError = 0;
    for (const [signal, expected] of Object.entries(values)) {
      const current = signal.startsWith('i(');
      const node = signal.slice(2, -1);
      const actual = result.dcSweep
        ? Array.from(current ? result.dcSweep.current(node) : result.dcSweep.voltage(node))
        : [current ? result.dc!.current(node) : result.dc!.voltage(node)];
      assert.equal(actual.length, expected.length);
      expected.forEach((reference, index) => {
        const error = Math.abs(actual[index] - reference) / Math.abs(reference);
        assert.ok(Number.isFinite(error));
        maxRelativeError = Math.max(maxRelativeError, error);
        assert.ok(error <= 2e-5, `${name} ${signal}[${index}]: relative error ${error}`);
      });
    }
    console.log(JSON.stringify({ name, points: plot.grid.length, maxRelativeError }));
  }
  if (update) writeFileSync(new URL('../../packages/core/src/devices/fixtures/bjt-resistor-tempco-1514.json', import.meta.url), JSON.stringify(oracle, null, 2) + '\n');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
