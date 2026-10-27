import { describe, expect, it } from 'vitest';
import { BJT } from './bjt.js';
import { InvalidCircuitError } from '../errors.js';
import { simulate } from '../simulate.js';
import { readFileSync } from 'node:fs';

const model = { IS: 1e-14, BF: 150, BR: 4, XTB: 1.5, ISE: 1e-13, ISC: 2e-13,
  CJE: 10e-12, CJC: 5e-12, VJE: 0.75, VJC: 0.7 };
const deck = (instance: string, temperature: number, base = 'RB=30') => `BJT instance temperature #1852
VC vc 0 5
VB vb 0 0.8
RL vc c 100
RB vb b 1k
Q1 c b 0 QM ${instance}
.model QM NPN IS=1e-14 BF=150 XTB=1.5 ISE=1e-13 NE=1.5 ISC=2e-13 NC=2
+ ${base} RC=10 RE=2 TRB1=0.003 TRM1=-0.001 TRC1=0.002 TRE1=0.001
.options temp=${temperature} reltol=1e-10 abstol=1e-15 vntol=1e-12
.op
.end`;

describe('BJT instance temperature #1852', () => {
  const directory = new URL('../../../../benchmarks/fixtures/1852/', import.meta.url);
  const oracle = JSON.parse(readFileSync(new URL('oracle.json', directory), 'utf8')) as {
    name: string; values: Record<string, number[]>;
  }[];
  it.each(oracle)('matches ngspice-47 on $name at strict relative 1e-6', async ({ name, values }) => {
    const result = await simulate(readFileSync(new URL(name, directory), 'utf8'));
    for (const [signal, expected] of Object.entries(values)) {
      const node = signal.slice(2, -1);
      const current = signal.startsWith('i(');
      const actual = result.dcSweep
        ? Array.from(current ? result.dcSweep.current(node) : result.dcSweep.voltage(node))
        : [current ? result.dc!.current(node) : result.dc!.voltage(node)];
      expect(actual).toHaveLength(name.includes('-dc') ? 61 : 1);
      expected.forEach((reference, index) => {
        expect(Math.abs((actual[index] - reference) / reference)).toBeLessThanOrEqual(1e-6);
      });
    }
  });

  it('validates DTEMP against the actual circuit temperature at initialization', async () => {
    const input = deck('DTEMP=-301', 80).replace('.options temp=80', '.temp 80\n.options');
    await expect(simulate(input)).resolves.toBeDefined();
  });

  it('maps every thermal field and restores offsets without accumulating', () => {
    const absolute = new BJT('Q1', [0, 1, -1], model, { TEMP: 50, DTEMP: -500 });
    const offset = new BJT('Q2', [0, 1, -1], model, { DTEMP: 23 });
    const reference = new BJT('QR', [0, 1, -1], model);
    reference.setTemperature(50);
    expect(absolute.params).toEqual(reference.params);
    expect(offset.params).toEqual(reference.params);
    for (const temperature of [80, 0, 27, 27]) {
      absolute.setTemperature(temperature);
      offset.setTemperature(temperature);
      reference.setTemperature(temperature + 23);
      expect(absolute.getTemperature()).toBe(50);
      expect(offset.params).toEqual(reference.params);
      const copy = offset.withSensitivityParameter('BF', 150);
      expect(copy.params).toEqual(offset.params);
    }
  });

  it.each(['RB=30', 'RB=100 RBM=20 IRB=0.2m'])(
    'propagates instance temperature to series resistors with %s', async base => {
      for (const temperature of [27, 0, 80]) {
        for (const instance of ['TEMP=50 DTEMP=-500', `DTEMP=${50 - temperature}`]) {
          const actual = (await simulate(deck(instance, temperature, base))).dc!;
          const reference = (await simulate(deck('', 50, base))).dc!;
          for (const node of ['c', 'b']) expect(actual.voltage(node)).toBeCloseTo(reference.voltage(node), 10);
          for (const source of ['VC', 'VB']) expect(actual.current(source)).toBeCloseTo(reference.current(source), 12);
        }
      }
    });

  it.each(['RB=30', 'RB=100 RBM=20 IRB=0.2m'])(
    'uses circuit TNOM for series resistors with %s and instance temperature', async base => {
      for (const instance of ['TEMP=50', 'DTEMP=-30']) {
        const input = deck(instance, 80, base).replace('.options temp=80', '.options tnom=80 temp=80');
        const implicit = (await simulate(input)).dc!;
        const explicit = (await simulate(input.replace('.model QM NPN', '.model QM NPN TNOM=80'))).dc!;
        for (const node of ['c', 'b']) expect(implicit.voltage(node)).toBeCloseTo(explicit.voltage(node), 12);
        for (const source of ['VC', 'VB']) expect(implicit.current(source)).toBeCloseTo(explicit.current(source), 14);
      }
    });

  it.each(['TEMP=-273.15', 'DTEMP=-300.15', 'DTEMP=-400', 'TEMP=1e999'])(
    'rejects invalid effective temperature %s', async instance => {
      await expect(simulate(deck(instance, 27))).rejects.toThrow(/temperature|TEMP|absolute zero/);
    });

  it('rejects invalid temperatures passed through the device API', () => {
    const device = new BJT('Q1', [0, 1, -1], model, { DTEMP: -20 });
    for (const temperature of [-253.15, NaN, Infinity]) {
      expect(() => device.setTemperature(temperature)).toThrow(InvalidCircuitError);
    }
  });

  it('keeps VBIC instance temperature explicitly unsupported', async () => {
    await expect(simulate('VBIC temperature guard\nVC c 0 5\nVB b 0 0.6\nQ1 c b 0 QM TEMP=50\n.model QM NPN LEVEL=4\n.op\n.end'))
      .rejects.toThrow(/VBIC.*instance/);
  });
});
