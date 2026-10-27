import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';

type Point = Record<string, number>;
const directory = new URL('../../../../benchmarks/fixtures/issue-1845/', import.meta.url);
const { references } = JSON.parse(readFileSync(new URL('reference.json', directory), 'utf8')) as {
  references: { id: string; op: Point[]; dc?: Point[] }[];
};
const deck = (id: string) => readFileSync(new URL(`${id}.cir`, directory), 'utf8');

const worst = new Map<string, { relative: number; absolute: number; relativeAboveFloor: number }>();
afterAll(() => {
  if (process.env.VDMOS_PARITY_REPORT) console.log('ngspice-47 worst errors', Object.fromEntries(worst));
});

function compare(actual: number, expected: number, label: string): void {
  const quantity = label.split(' ').at(-1)!;
  const error = Math.abs(actual - expected);
  const previous = worst.get(quantity) ?? { relative: 0, absolute: 0, relativeAboveFloor: 0 };
  worst.set(quantity, {
    relative: Math.max(previous.relative, expected === 0 ? 0 : error / Math.abs(expected)),
    absolute: Math.max(previous.absolute, error),
    // Currents below 1 uA use the absolute-error branch of the contract.
    relativeAboveFloor: Math.max(previous.relativeAboveFloor,
      Math.abs(expected) > 1e-6 ? error / Math.abs(expected) : 0),
  });
  expect(Number.isFinite(actual), label).toBe(true);
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(Math.max(1e-12, 1e-6 * Math.abs(expected)));
}

function node(signal: string): string {
  return signal.slice(2, -1).replace('#', '.');
}

describe('VDMOS circuit temperature ngspice-47 parity (#1845)', () => {
  for (const reference of references) {
    it(`${reference.id} identical-deck OP and gate sweep`, async () => {
      const result = await simulate(deck(reference.id));
      for (const [signal, expected] of Object.entries(reference.op[0])) {
        compare(signal.startsWith('v(') ? result.dc!.voltage(node(signal)) : result.dc!.current(node(signal)),
          expected, `OP ${signal}`);
      }
      if (!reference.dc) return;
      expect(result.dcSweep!.sweepValues.length).toBe(reference.dc.length);
      reference.dc.forEach((point, index) => {
        for (const [signal, expected] of Object.entries(point)) {
          const actual = signal === 'v(v-sweep)' ? result.dcSweep!.sweepValues[index]
            : signal.startsWith('v(') ? result.dcSweep!.voltage(node(signal))[index]
              : result.dcSweep!.current(node(signal))[index];
          compare(actual, expected, `DC ${index} ${signal}`);
        }
      });
    });
  }
  it('routes .temp through the same law', async () => {
    const result = await simulate(deck('repro').replace('.options TEMP=75', '.temp 75'));
    compare(result.dc!.current('Vd'), references[0].op[0]['i(vd)'], '.temp I(Vd)');
  });
  it.each([
    ['TEMP=-20', 75], ['DTEMP=-95', 75], ['TEMP=75 DTEMP=-95', 75],
  ] as const)('preserves instance %s precedence', async (instance, ambient) => {
    const result = await simulate(deck('n-channel-temp-20')
      .replace('TEMP=-20', `TEMP=${ambient}`)
      .replace('M1 d g 0 vd', `M1 d g 0 vd ${instance}`));
    const reference = references.find(r => r.id === 'n-channel-temp-20')!;
    compare(result.dc!.current('Vd'), reference.op[0]['i(vd)'], 'instance i(vd)');
    reference.dc!.forEach((point, index) => {
      compare(result.dcSweep!.current('Vd')[index], point['i(vd)'], `instance ${index} i(vd)`);
    });
  });
  it('applies the law during .dc TEMP sweeps', async () => {
    const result = await simulate(deck('n-channel-temp75').replace('.dc Vg 0 6 0.1', '.dc TEMP -20 75 95'));
    [-20, 75].forEach((temperature, index) => {
      const reference = references.find(r => r.id === `n-channel-temp${temperature}`)!;
      compare(result.dcSweep!.current('Vd')[index], reference.op[0]['i(vd)'], `TEMP ${temperature} i(vd)`);
    });
  });
  it('retains the unsupported circuit TNOM guard', async () => {
    await expect(simulate(deck('repro').replace('TEMP=75', 'TEMP=75 TNOM=40')))
      .rejects.toThrow('.options TNOM=40 is unsupported');
  });
  it('retains the self-heating circuit temperature guard', async () => {
    await expect(simulate(deck('repro').replace('0 vd\n', '0 tj tc vd thermal\n')
      .replace('KP=1)', 'KP=1 RTHJC=1 RTHCA=2)'))).rejects.toMatchObject({
      code: 'UNSUPPORTED_TEMPERATURE', deviceName: 'M1', temperature: 75,
    });
  });
});
