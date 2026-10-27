import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { parse } from '../parser/index.js';
import { MOS6 } from './mos6.js';
import { solveDCSweep } from '../analysis/dc-sweep.js';
import { resolveOptions } from '../types.js';

type Point = Record<string, number>;
const directory = new URL('../../../../benchmarks/fixtures/issue-1847/', import.meta.url);
const { references } = JSON.parse(readFileSync(new URL('reference.json', directory), 'utf8')) as {
  references: { id: string; sha256: string; op: Point[]; dc: Point[] }[];
};
const deck = (id: string) => readFileSync(new URL(`${id}.cir`, directory), 'utf8');

describe('MOS6 instance temperature ngspice-47 parity (#1847)', () => {
  for (const reference of references) {
    it(`${reference.id} identical-deck OP and DC`, async () => {
      const netlist = deck(reference.id);
      expect(createHash('sha256').update(netlist).digest('hex')).toBe(reference.sha256);
      const result = await simulate(netlist);
      const worst: Record<string, number> = {};
      function compare(actual: number, expected: number, label: string, signal: string): void {
        const error = Math.abs(actual - expected);
        expect(error, label).toBeLessThanOrEqual(1e-6 * Math.abs(expected));
        worst[signal] = Math.max(worst[signal] ?? 0, expected === 0 ? 0 : error / Math.abs(expected));
      }
      for (const [signal, expected] of Object.entries(reference.op[0])) {
        const name = signal.slice(2, -1);
        compare(signal.startsWith('v(') ? result.dc!.voltage(name) : result.dc!.current(name),
          expected, `OP ${signal}`, signal);
      }
      expect(result.dcSweep!.sweepValues.length).toBe(61);
      expect(result.dcSweep!.sweepValues.length).toBe(reference.dc.length);
      reference.dc.forEach((point, index) => {
        for (const [signal, expected] of Object.entries(point)) {
          const name = signal.slice(2, -1);
          const actual = name === 'v-sweep' ? result.dcSweep!.sweepValues[index]
            : signal.startsWith('v(') ? result.dcSweep!.voltage(name)[index] : result.dcSweep!.current(name)[index];
          compare(actual, expected, `DC ${index} ${signal}`, signal);
        }
      });
      console.info(`${reference.id} worst relative errors ${JSON.stringify(worst)}`);
    });
  }

  it.each(['', 'TEMP=27', 'TEMP=40'])('guards unported laws at initial effective temperature (%s)', async circuitTemperature => {
    for (const [instance, effective] of [['TEMP=75', 75], ['DTEMP=30', circuitTemperature === 'TEMP=40' ? 70 : 57]] as const) {
      const netlist = deck('n-temp').replace('TEMP=75', instance).replace('TEMP=40', circuitTemperature)
        .replace('LEVEL=6', 'LEVEL=6 UTE=0.1');
      await expect(simulate(netlist)).rejects.toMatchObject({
        code: 'UNSUPPORTED_TEMPERATURE', parameter: 'UTE', temperature: effective,
      });
    }
  });

  it('validates against actual circuit temperature, not the constructor default', async () => {
    const netlist = deck('n-dtemp').replace('DTEMP=30', 'DTEMP=-13').replace('LEVEL=6', 'LEVEL=6 UTE=0.1');
    await expect(simulate(netlist)).resolves.toBeDefined();
  });

  it.each(['temp', 'dtemp', 'both'])('%s follows circuit changes without accumulating DTEMP', async variant => {
    const netlist = deck(`n-${variant}`);
    const circuit = parse(netlist);
    const compiled = circuit.compile();
    const device = compiled.devices.find(device => device instanceof MOS6) as MOS6;
    const effective = variant === 'dtemp' ? 70 : 75;
    expect(device.getTemperature()).toBe(effective);
    device.setTemperature(50);
    expect(device.getTemperature()).toBe(variant === 'dtemp' ? 80 : 75);
    device.setTemperature(40);
    expect(device.getTemperature()).toBe(effective);
    const result = await simulate(netlist.replace('.dc Vg 0 3 0.05', '.dc TEMP 40 50 10'));
    for (const [index, temperature] of [40, 50].entries()) {
      const direct = await simulate(netlist.replace('TEMP=40', `TEMP=${temperature}`));
      expect(result.dcSweep!.current('Vd')[index]).toBeCloseTo(direct.dc!.current('Vd'), 14);
    }
    // Restore CKTtemp, not the effective instance temperature (no double DTEMP).
    solveDCSweep(compiled, { type: 'dc', source: 'TEMP', start: 40, stop: 50, step: 10 }, resolveOptions());
    expect(device.getTemperature()).toBe(effective);
    expect(device.getCircuitTemperature()).toBe(40);
  });
});
