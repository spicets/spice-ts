import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { simulate } from '../simulate.js';
import { Diode } from './diode.js';
import { InvalidCircuitError } from '../errors.js';

// ngspice-47 dio.c:14-15, dioparam.c:51-57, diotemp.c:291-296.
// TEMP overrides circuit temperature and DTEMP; otherwise DTEMP adds to it.
const deck = (instance: string, temperature = 27) => `Diode instance temperature reference
V1 in 0 0.5
D1 in 0 DM ${instance}
.model DM D (IS=1e-14 N=1 RS=0.2 TNOM=27)
.options temp=${temperature} reltol=1e-10 abstol=1e-14 vntol=1e-12
.op
.end
`;

const relativeError = (actual: number, expected: number) => Math.abs((actual - expected) / expected);

describe('diode instance temperature (#1397)', () => {
  it.each([
    ['temp=125', 27],
    ['dtemp=98', 27],
    ['TeMp=125 DtEmP=-40', 80],
    ['dtemp=45', 80],
  ])('matches circuit TEMP=125 and ngspice-47 for %s at %d C', async (instance, temperature) => {
    const result = await simulate(deck(instance, temperature));
    const reference = await simulate(deck('', 125));
    const current = -result.dc!.current('V1');
    expect(relativeError(current, -reference.dc!.current('V1'))).toBeLessThan(1e-9);
    // Identical deck, ngspice -b; control `set numdgt=15; op; print @d1[id]`.
    expect(relativeError(current, 1.904558476448052e-3)).toBeLessThan(1e-8);
  });

  it('applies instance temperature at construction and recomputes offsets without accumulating', () => {
    const absolute = new Diode('D1', [0, -1], { RS: 10, TRS1: 0.01 }, false, { TEMP: 125, DTEMP: 98 });
    const offset = new Diode('D2', [0, -1], { RS: 10, TRS1: 0.01 }, false, { DTEMP: 98 });
    expect(absolute.params.RS).toBeCloseTo(19.8, 12);
    expect(offset.params.RS).toBeCloseTo(19.8, 12);
    for (const temperature of [0, 80, 0, 27]) {
      absolute.setTemperature(temperature);
      offset.setTemperature(temperature);
      expect(absolute.params.RS).toBeCloseTo(19.8, 12);
      expect(offset.params.RS).toBeCloseTo(10 * (1 + 0.01 * (temperature + 98 - 27)), 12);
    }
  });

  it.each(['temp=125 dtemp=-40', 'dtemp=98'])('preserves %s on expanded temperature-dependent RS', async instance => {
    // CJO forces a separate RS device, which must share the junction temperature.
    const expanded = (fields: string, temperature: number) => deck(fields, temperature)
      .replace('TNOM=27)', 'TNOM=27 CJO=10p TRS1=0.01 TRS2=0.0001)');
    const result = await simulate(expanded(instance, 27));
    const reference = await simulate(expanded('', 125));
    expect(relativeError(result.dc!.current('V1'), reference.dc!.current('V1'))).toBeLessThan(1e-9);
  });

  it.each(['temp=125 dtemp=-10', 'dtemp=98'])('supports %s with a thermal node like ngspice', async instance => {
    const thermal = (fields: string, temperature: number) => deck(fields, temperature)
      .replace('D1 in 0 DM', 'D1 in 0 tj DM')
      .replace('TNOM=27)', 'TNOM=27 RTH0=100)')
      .replace('.op', 'Rt tj 0 100\n.op')
      .replace(`DM ${fields}`, `DM thermal ${fields}`);
    const result = await simulate(thermal(instance, 27));
    const reference = await simulate(thermal('', 125));
    expect(relativeError(result.dc!.current('V1'), reference.dc!.current('V1'))).toBeLessThan(1e-9);
    expect(relativeError(result.dc!.voltage('tj'), reference.dc!.voltage('tj'))).toBeLessThan(1e-9);
    // ngspice-47 on the identical thermal-node deck, print @d1[id].
    expect(relativeError(-result.dc!.current('V1'), 1.909258479075053e-3)).toBeLessThan(1e-8);
  });

  it('keeps unsupported thermal junction charge a typed error with TEMP', async () => {
    const input = deck('thermal temp=125').replace('D1 in 0 DM', 'D1 in 0 tj DM')
      .replace('TNOM=27)', 'TNOM=27 RTH0=100 CJO=1p)');
    await expect(simulate(input)).rejects.toBeInstanceOf(InvalidCircuitError);
  });

  it('runs the unchanged corpus-f diode-soa-simple DC sweep', async () => {
    const input = readFileSync(new URL('../../../../benchmarks/corpus/corpus-f/fixtures/examples/soa/diode-soa-simple.cir', import.meta.url), 'utf8');
    const result = await simulate(input);
    const sweep = result.dcSweep!;
    expect(sweep.current('v1')).toHaveLength(100);
    expect(sweep.current('v1').every(Number.isFinite)).toBe(true);
  });
});
