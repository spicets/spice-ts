import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';

type Point = Record<string, number>;
const directory = new URL('../../../../benchmarks/fixtures/issue-1812/', import.meta.url);
const { references } = JSON.parse(readFileSync(new URL('reference.json', directory), 'utf8')) as {
  references: { id: string; op: Point[]; dc: Point[] }[];
};
const deck = (id: string) => readFileSync(new URL(`${id}.cir`, directory), 'utf8');

function compare(actual: number, expected: number, label: string): void {
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(1e-6 * Math.abs(expected));
}

describe('MOS9 circuit temperature ngspice-47 parity (#1812)', () => {
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
  it.each([27, 50, 100])('routes .temp %s through the same model', async temperature => {
    const id = `n-tnom27-temp${temperature}`;
    const result = await simulate(deck(id).replace(`TEMP=${temperature} `, '').replace('.op', `.temp ${temperature}\n.op`));
    compare(result.dc!.current('VD'), references.find(r => r.id === id)!.op[0]['i(vd)'], '.temp I(VD)');
  });
  it('applies and restores circuit temperature during a .dc TEMP sweep', async () => {
    const result = await simulate(deck('n-tnom27-temp27').replace(/\.dc VG[^\n]+/, '.dc TEMP 27 100 73'));
    for (const [index, temperature] of [27, 100].entries()) {
      compare(result.dcSweep!.current('VD')[index], references.find(r => r.id === `n-tnom27-temp${temperature}`)!.op[0]['i(vd)'], `TEMP=${temperature}`);
    }
  });
  it.each(['TCV', 'UTE', 'TRD', 'XTI'])('preserves the unported model %s guard', async parameter => {
    await expect(simulate(deck('n-tnom27-temp50').replace('LEVEL=9', `LEVEL=9 ${parameter}=0.1`)))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_TEMPERATURE', deviceName: 'M1', temperature: 50, parameter });
  });
});
