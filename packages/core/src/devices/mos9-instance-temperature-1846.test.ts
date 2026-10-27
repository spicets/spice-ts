import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';

type Point = Record<string, number>;
const directory = new URL('../../../../benchmarks/fixtures/issue-1846/', import.meta.url);
const { references } = JSON.parse(readFileSync(new URL('reference.json', directory), 'utf8')) as {
  references: { id: string; op: Point[]; dc: Point[] }[];
};
const deck = (id: string) => readFileSync(new URL(`${id}.cir`, directory), 'utf8');

function compare(actual: number, expected: number, label: string): void {
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(1e-6 * Math.abs(expected));
}

describe('MOS9 instance temperature ngspice-47 parity (#1846)', () => {
  for (const reference of references) {
    it(`${reference.id} identical-deck OP and 61-point gate DC sweep`, async () => {
      const result = await simulate(deck(reference.id));
      for (const [signal, expected] of Object.entries(reference.op[0])) {
        const name = signal.slice(2, -1);
        compare(signal.startsWith('v(') ? result.dc!.voltage(name) : result.dc!.current(name), expected, `OP ${signal}`);
      }
      expect(result.dcSweep!.sweepValues.length).toBe(61);
      expect(reference.dc.length).toBe(61);
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

  it.each(['TCV', 'UTE', 'TRD', 'XTI'])('preserves the unported model %s guard at instance TEMP', async parameter => {
    await expect(simulate(deck('n-temp').replace('LEVEL=9', `LEVEL=9 ${parameter}=0.1`)))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_TEMPERATURE', deviceName: 'M1', temperature: 75, parameter });
  });
});
