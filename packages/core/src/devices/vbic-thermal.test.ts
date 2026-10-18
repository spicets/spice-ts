import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { InvalidCircuitError } from '../errors.js';
import { readFileSync } from 'node:fs';

const deck = (terminal = 'dt', rth = 300, extra = '', analysis = '.op') => `VBIC thermal
Vc c 0 1
Vb b 0 0.6
Q1 c b 0 0 ${terminal} mod
.model mod npn level=4 rth=${rth} ${extra}
${analysis}
.end`;

describe('VBIC DC self heating', () => {
  it('runs the unchanged public vbic99 DC deck', async () => {
    const source = readFileSync(new URL('../../../../benchmarks/corpus/corpus-f/fixtures/examples/vbic/vbic99_dc.sp', import.meta.url), 'utf8');
    const result = await simulate(source);
    expect(result.dcSweep!.voltage('dt')).toHaveLength(51);
    expect(Array.from(result.dcSweep!.voltage('dt')).every(Number.isFinite)).toBe(true);
  });
  it('balances intrinsic dissipation and RTH and changes the electrical currents', async () => {
    const hot = (await simulate(deck())).dc!;
    const cold = (await simulate(deck('', 300))).dc!;
    const power = -hot.current('Vc') - 0.6 * hot.current('Vb');
    expect(hot.voltage('dt')).toBeGreaterThan(0);
    expect(hot.voltage('dt')).toBeCloseTo(power * 300, 6);
    expect(Math.abs(hot.current('Vc'))).toBeGreaterThan(Math.abs(cold.current('Vc')));
  });

  it('keeps RTH=0 and four-terminal electrical results identical', async () => {
    const four = (await simulate(deck('', 0))).dc!;
    const five = (await simulate(deck('dt', 0))).dc!;
    expect(five.current('Vc')).toBe(four.current('Vc'));
    expect(five.current('Vb')).toBe(four.current('Vb'));
    expect(five.voltage('dt')).toBe(0);
    const inert = (await simulate(deck('', 300))).dc!;
    expect(inert.current('Vc')).toBe(four.current('Vc'));
  });

  it('rejects active transient thermal storage with a typed error', async () => {
    await expect(simulate(deck('dt', 300, 'cth=1u', '.tran 1n 2n')))
      .rejects.toThrow(InvalidCircuitError);
  });
});
