import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { parse } from '../parser/index.js';
import { solveDCSweep } from '../analysis/dc-sweep.js';
import { resolveOptions } from '../types.js';
import { MOS2, resolveMOS2Model } from './mos2.js';

type Point = Record<string, number>;
const directory = new URL('../../../../benchmarks/fixtures/issue-1853/', import.meta.url);
const { references } = JSON.parse(readFileSync(new URL('reference.json', directory), 'utf8')) as {
  references: { id: string; sha256: string; op: Point[]; dc: Point[] }[];
};
const deck = (id: string) => readFileSync(new URL(`${id}.cir`, directory), 'utf8');

function device(instance: { TEMP?: number; DTEMP?: number } = {}, circuitTemperature = 40): MOS2 {
  return new MOS2('M1', [1, 2, 0, 0], resolveMOS2Model('MOD', { KP: 1e-4, VTO: 0.7 }, 1),
    instance, circuitTemperature);
}

describe('MOS2 instance temperature ngspice-47 parity (#1853)', () => {
  for (const reference of references) {
    it(`${reference.id} identical-deck OP and 61-point gate DC sweep`, async () => {
      const netlist = deck(reference.id);
      expect(createHash('sha256').update(netlist).digest('hex')).toBe(reference.sha256);
      const result = await simulate(netlist);
      let worst = 0;
      function compare(actual: number, expected: number, label: string): void {
        const error = Math.abs(actual - expected);
        expect(error, label).toBeLessThanOrEqual(1e-6 * Math.abs(expected));
        worst = Math.max(worst, expected === 0 ? 0 : error / Math.abs(expected));
      }
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
      console.info(`${reference.id} worst relative error ${worst}`);
    });
  }

  it.each(['temp', 'dtemp', 'both'])('%s preserves effective temperature across repeated DC TEMP sweeps', variant => {
    const compiled = parse(deck(`n-${variant}`)).compile();
    const mos = compiled.devices.find(device => device instanceof MOS2) as MOS2;
    const effective = variant === 'dtemp' ? 60 : 75;
    expect(mos.getTemperature()).toBe(effective);
    for (let repeat = 0; repeat < 2; repeat++) {
      solveDCSweep(compiled, { type: 'dc', source: 'TEMP', start: 40, stop: 50, step: 10 },
        resolveOptions(compiled.simulationOptions));
      expect(mos.getTemperature()).toBe(effective);
      expect(mos.getCircuitTemperature()).toBe(40);
    }
    mos.setTemperature(50);
    expect(mos.getTemperature()).toBe(variant === 'dtemp' ? 70 : 75);
    mos.setTemperature(40);
    expect(mos.getTemperature()).toBe(effective);
  });

  it.each([NaN, Infinity, -Infinity, -273.15, -300])('rejects invalid instance TEMP=%s at construction', TEMP => {
    expect(() => device({ TEMP })).toThrowError(expect.objectContaining({ code: 'INVALID_CIRCUIT' }));
  });

  it.each([NaN, Infinity, -Infinity, -320])('rejects invalid effective DTEMP=%s at construction', DTEMP => {
    expect(() => device({ DTEMP })).toThrowError(expect.objectContaining({ code: 'INVALID_CIRCUIT' }));
  });

  it.each([NaN, Infinity, -Infinity, -293.15, -320])('invalid circuit TEMP=%s preserves last valid state', value => {
    const mos = device({ DTEMP: 20 });
    const before = mos.evaluateChannel(2, 3, -0.4);
    expect(() => mos.setTemperature(value)).toThrowError(expect.objectContaining({ code: 'INVALID_CIRCUIT' }));
    expect(mos.getTemperature()).toBe(60);
    expect(mos.getCircuitTemperature()).toBe(40);
    expect(mos.evaluateChannel(2, 3, -0.4)).toEqual(before);
    mos.setTemperature(50);
    expect(mos.getTemperature()).toBe(70);
  });

  it.each(['TEMP=75', 'DTEMP=35', 'TEMP=75 DTEMP=35'])('%s matches circuit temperature in AC and transient charges', async instance => {
    const netlist = deck('n-temp')
      .replace('TEMP=75\n.model', `${instance}\n.model`)
      .replace('AD=2p AS=3p', 'AD=2p AS=3p PD=6u PS=8u')
      .replace('Vg g 0 2', 'Vg g 0 SIN(2 0.1 1Meg) AC 1')
      .replace(' RELTOL=1e-12 ABSTOL=1e-20 VNTOL=1e-16', '')
      .replace('.dc Vg 0 3 0.05', '.ac dec 2 1k 1Meg\n.tran 1n 10n');
    const ambient = netlist.replace(instance, '').replace('TEMP=40', 'TEMP=75');
    const actual = await simulate(netlist);
    const expected = await simulate(ambient);
    expect(actual.ac!.voltage('d')).toEqual(expected.ac!.voltage('d'));
    expect(actual.transient!.time).toEqual(expected.transient!.time);
    expect(actual.transient!.voltage('d')).toEqual(expected.transient!.voltage('d'));
    expect(actual.transient!.current('Vd')).toEqual(expected.transient!.current('Vd'));
  });

  it('explicit TEMP ignores even nonfinite DTEMP', () => {
    expect(device({ TEMP: 75, DTEMP: NaN }).getTemperature()).toBe(75);
  });
});
