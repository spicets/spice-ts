import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';

type Point = Record<string, number>;
const directory = new URL('../../../../benchmarks/fixtures/issue-1821/', import.meta.url);
const { references } = JSON.parse(readFileSync(new URL('reference.json', directory), 'utf8')) as {
  references: { id: string; temperature: number; op: Point[]; dc: Point[] }[];
};
const deck = (id: string) => readFileSync(new URL(`${id}.cir`, directory), 'utf8');

function compare(actual: number, expected: number, label: string): void {
  // Strict relative error: no absolute floor, even for junction leakage. Zeros must be exact.
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(1e-6 * Math.abs(expected));
}

describe('BSIM1/BSIM2 circuit temperature ngspice-47 parity (#1821)', () => {
  for (const reference of references) {
    it(`${reference.id} identical-deck OP and DC`, async () => {
      const result = await simulate(deck(reference.id));
      for (const [signal, expected] of Object.entries(reference.op[0])) {
        const name = signal.slice(2, -1);
        compare(signal.startsWith('v(') ? result.dc!.voltage(name) : result.dc!.current(name), expected, `OP ${signal}`);
      }
      expect(result.dcSweep!.sweepValues.length).toBe(reference.dc.length);
      reference.dc.forEach((point, index) => {
        for (const [signal, expected] of Object.entries(point)) {
          const name = signal.slice(2, -1);
          const actual = name === 'v-sweep' ? result.dcSweep!.sweepValues[index]
            : signal.startsWith('v(') ? result.dcSweep!.voltage(name)[index] : result.dcSweep!.current(name)[index];
          compare(actual, expected, `DC ${index} ${signal}`);
        }
      });
    });
  }

  it.each([4, 5])('routes .temp and a .dc TEMP sweep for LEVEL=%s', async level => {
    const text = deck(`b${level - 3}-n-model27-temp27`);
    const nominal = (await simulate(text)).dc!;
    const hot = (await simulate(text.replace('TEMP=27 RELTOL', 'TEMP=75 RELTOL'))).dc!;
    // b1temp.c/b2temp.c NG_IGNORE(ckt): model TEMP is independent of circuit TEMP.
    expect([...hot.voltages]).toEqual([...nominal.voltages]);
    expect([...hot.currents]).toEqual([...nominal.currents]);
    const dotTemp = (await simulate(text.replace('TEMP=27 RELTOL', 'RELTOL').replace('.op', '.temp -20\n.op'))).dc!;
    expect([...dotTemp.voltages]).toEqual([...nominal.voltages]);
    expect([...dotTemp.currents]).toEqual([...nominal.currents]);
    const swept = (await simulate(text.replace(/\.dc VG[^\n]+/, '.dc TEMP -20 75 47.5'))).dcSweep!;
    // Sweep continuation can change final solver roundoff; use the oracle error contract.
    for (const current of swept.current('VD')) compare(current, nominal.current('VD'), '.dc TEMP I(VD)');
  });
});
