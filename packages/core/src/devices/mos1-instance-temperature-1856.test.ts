import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { parse } from '../parser/index.js';
import { solveDCSweep } from '../analysis/dc-sweep.js';
import { resolveOptions } from '../types.js';
import { MOSFET } from './mosfet.js';

type Point = Record<string, number>;
const directory = new URL('../../../../benchmarks/fixtures/issue-1856/', import.meta.url);
const { references } = JSON.parse(readFileSync(new URL('reference.json', directory), 'utf8')) as {
  references: { id: string; sha256: string; op: Point[]; dc: Point[] }[];
};
const deck = (id: string) => readFileSync(new URL(`${id}.cir`, directory), 'utf8');

function device(instance: { TEMP?: number; DTEMP?: number } = {}, circuitTemperature = 40): MOSFET {
  return new MOSFET('M1', [1, 2, 0, 0], { KP: 1e-4, VTO: 0.7, ...instance }, circuitTemperature);
}

describe('MOS1 instance temperature ngspice-47 parity (#1856)', () => {
  for (const reference of references) {
    it(`${reference.id} identical-deck OP and 61-point gate DC sweep`, async () => {
      const netlist = deck(reference.id);
      expect(createHash('sha256').update(netlist).digest('hex')).toBe(reference.sha256);
      const result = await simulate(netlist);
      let worst = 0;
      function compare(actual: number, expected: number, label: string): void {
        const error = Math.abs(actual - expected);
        worst = Math.max(worst, expected === 0 ? (error === 0 ? 0 : Infinity) : error / Math.abs(expected));
        expect(Number.isFinite(actual), label).toBe(true);
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
      expect(worst).toBeLessThanOrEqual(1e-6);
    });
  }

  it.each(['temp', 'dtemp', 'both'])('%s survives repeated circuit TEMP sweeps', variant => {
    const compiled = parse(deck(`n-${variant}`)).compile();
    const mos = compiled.devices.find(device => device instanceof MOSFET) as MOSFET;
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
  });

  it.each([NaN, Infinity, -Infinity, -273.15, -300])('rejects invalid instance TEMP=%s during construction', TEMP => {
    expect(() => new MOSFET('M1', [1, 2, 0, 0], { TEMP }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_CIRCUIT' }));
  });

  it.each([NaN, Infinity, -Infinity, -320])('rejects invalid effective DTEMP=%s', DTEMP => {
    expect(() => device({ DTEMP })).toThrowError(expect.objectContaining({ code: 'INVALID_CIRCUIT' }));
  });

  it.each([NaN, Infinity, -Infinity, -293.15, -320])('invalid circuit TEMP=%s preserves last valid state', value => {
    const mos = device({ DTEMP: 20 });
    expect(() => mos.setTemperature(value)).toThrowError(expect.objectContaining({ code: 'INVALID_CIRCUIT' }));
    expect(mos.getTemperature()).toBe(60);
    expect(mos.getCircuitTemperature()).toBe(40);
    mos.setTemperature(50);
    expect(mos.getTemperature()).toBe(70);
  });

  it.each(['TEMP=75', 'DTEMP=35', 'TEMP=75 DTEMP=35'])('%s matches ambient temperature for AC and transient charges', async instance => {
    const netlist = deck('n-temp')
      .replace('TEMP=75\n.model', `${instance}\n.model`)
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

  it('zero Celsius is an explicit TEMP, not a fallback', () => {
    expect(device({ TEMP: 0, DTEMP: 20 }).getTemperature()).toBe(0);
  });

  it('validates DTEMP using the initial circuit temperature, not the default 27 C', () => {
    const compiled = parse(deck('n-dtemp').replace('DTEMP=20', 'DTEMP=-310').replace('TEMP=40', 'TEMP=75')).compile();
    const mos = compiled.devices.find(device => device instanceof MOSFET) as MOSFET;
    expect(mos.getTemperature()).toBe(-235);
    expect(mos.getCircuitTemperature()).toBe(75);
  });
});
