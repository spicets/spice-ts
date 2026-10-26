import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { parse } from '../parser/index.js';
import { MOS6 } from './mos6.js';

type Point = Record<string, number>;
const directory = new URL('../../../../benchmarks/fixtures/issue-1806/', import.meta.url);
const { references } = JSON.parse(readFileSync(new URL('reference.json', directory), 'utf8')) as {
  references: { id: string; op: Point[]; dc: Point[] }[];
};
const deck = (id: string) => readFileSync(new URL(`${id}.cir`, directory), 'utf8');

function compare(actual: number, expected: number, label: string): void {
  // Strict relative error, including tiny body-source currents. Zeros must be exact.
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(1e-6 * Math.abs(expected));
}

describe('MOS6 circuit temperature ngspice-47 parity (#1806)', () => {
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
  it('routes .temp through the same model', async () => {
    const result = await simulate(deck('n-tnom27-temp50').replace('TEMP=50 ', '').replace('.op', '.temp 50\n.op'));
    compare(result.dc!.current('VD'), references.find(r => r.id === 'n-tnom27-temp50')!.op[0]['i(vd)'], '.temp I(VD)');
  });
  it('applies and restores the model during a .dc TEMP sweep', async () => {
    const result = await simulate(deck('n-tnom27-temp27').replace(/\.dc VG[^\n]+/, '.dc TEMP 27 100 73'));
    for (const [index, temperature] of [27, 100].entries()) {
      const reference = references.find(r => r.id === `n-tnom27-temp${temperature}`)!;
      compare(result.dcSweep!.current('VD')[index], reference.op[0]['i(vd)'], `TEMP=${temperature}`);
    }
  });
  it.each(['TCV', 'UTE', 'TRD', 'XTI'])('rejects unported model %s off nominal', async parameter => {
    await expect(simulate(deck('n-tnom27-temp50').replace('LEVEL=6', `LEVEL=6 ${parameter}=0.1`)))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_TEMPERATURE', deviceName: 'M1', temperature: 50, parameter });
  });
  it.each(['TEMP', 'DTEMP'])('rejects unported instance %s rather than ignoring it', async parameter => {
    await expect(simulate(deck('n-tnom27-temp50').replace('W=10u', `W=10u ${parameter}=80`)))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_TEMPERATURE', deviceName: 'M1', parameter });
  });
  it('guards direct temperature hooks without mutating the last valid state', () => {
    const circuit = parse(deck('n-tnom27-temp27').replace('LEVEL=6', 'LEVEL=6 UTE=0.1')).compile();
    const device = circuit.devices.find(device => device instanceof MOS6) as MOS6;
    expect(() => device.setTemperature(100)).toThrowError(expect.objectContaining({
      code: 'UNSUPPORTED_TEMPERATURE', parameter: 'UTE', temperature: 100,
    }));
    expect(device.getTemperature()).toBe(27);
  });
});
