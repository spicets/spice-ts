import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';

type Point = Record<string, number>;
const directory = new URL('../../../../benchmarks/fixtures/issue-1808/', import.meta.url);
const { references } = JSON.parse(readFileSync(new URL('reference.json', directory), 'utf8')) as {
  references: { id: string; op: Point[]; dc: Point[] }[];
};

function compare(actual: number, expected: number, label: string): void {
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(1e-9 * Math.abs(expected));
}

describe('resistor instance TEMP/DTEMP ngspice-47 parity (#1808)', () => {
  for (const reference of references) {
    it(`${reference.id} identical-deck OP and DC TEMP sweep`, async () => {
      const result = await simulate(readFileSync(new URL(`${reference.id}.cir`, directory), 'utf8'));
      for (const [signal, expected] of Object.entries(reference.op[0])) {
        const name = signal.slice(2, -1);
        compare(signal.startsWith('v(') ? result.dc!.voltage(name) : result.dc!.current(name), expected, `OP ${signal}`);
      }
      expect([...result.dcSweep!.sweepValues]).toEqual(reference.dc.map(point => point['temp-sweep']));
      reference.dc.forEach((point, index) => {
        for (const [signal, expected] of Object.entries(point)) {
          if (signal === 'temp-sweep') continue;
          const name = signal.slice(2, -1);
          compare(signal.startsWith('v(') ? result.dcSweep!.voltage(name)[index] : result.dcSweep!.current(name)[index],
            expected, `DC ${index} ${signal}`);
        }
      });
    });
  }
});
