import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { solveDCOperatingPoint } from '../analysis/dc.js';
import { parse } from '../parser/index.js';
import { simulate } from '../simulate.js';
import { resolveOptions } from '../types.js';
import { MOS3 } from './mos3.js';

interface TemperatureReference {
  id: string;
  deck: string;
  sha256: string;
  op: number[];
  tran: number[][];
}
const { references } = JSON.parse(readFileSync(new URL(
  '../../../../benchmarks/results/issue-1057/reference.json', import.meta.url,
), 'utf8')) as { references: TemperatureReference[] };

function interpolate(time: ArrayLike<number>, values: ArrayLike<number>, at: number): number {
  let index = 1;
  while (index < time.length - 1 && time[index] < at) index++;
  const fraction = (at - time[index - 1]) / (time[index] - time[index - 1]);
  return values[index - 1] + fraction * (values[index] - values[index - 1]);
}

function expectOP(actual: number[], expected: number[]): void {
  actual.forEach((value, index) => {
    expect(Math.abs(value - expected[index]), `OP signal ${index}`)
      .toBeLessThan(1e-12 + 1e-7 * Math.abs(expected[index]));
  });
}

describe('MOS3 non-nominal temperature ngspice-47 parity (#1057)', () => {
  it('covers both polarities, series resistance paths and hot/cold temperatures', () => {
    expect(references).toHaveLength(12);
    expect(new Set(references.map(reference => reference.id)).size).toBe(12);
  });
  for (const reference of references) {
    it(`${reference.id} device law independently of the circuit guard`, () => {
      const temperature = Number(/TEMP=(-?\d+)/.exec(reference.deck)![1]);
      const compiled = parse(reference.deck.replace(/TEMP=-?\d+/, 'TEMP=27')).compile();
      for (const device of compiled.devices) {
        if (device instanceof MOS3) device.setTemperature(temperature);
      }
      const { result: op } = solveDCOperatingPoint(compiled, resolveOptions(compiled.simulationOptions));
      expectOP([op.voltage('d'), op.voltage('s'), op.current('VD')], reference.op);
    });
    it(`${reference.id} identical-byte OP and short transient, TNOM=50`, async () => {
      expect(createHash('sha256').update(reference.deck).digest('hex')).toBe(reference.sha256);
      const result = await simulate(reference.deck);
      const op = result.dc!;
      expectOP([op.voltage('d'), op.voltage('s'), op.current('VD')], reference.op);
      const tran = result.transient!;
      const signals = [tran.voltage('d'), tran.voltage('s'), tran.current('VD')];
      for (const [time, ...values] of reference.tran) {
        signals.forEach((signal, index) => {
          // Uniform allowance for interpolation on different adaptive grids.
          expect(Math.abs(interpolate(tran.time, signal, time) - values[index]), `TRAN ${time} signal ${index}`)
            .toBeLessThan(1e-12 + 1e-4 * Math.abs(values[index]));
        });
      }
    });
  }
  it.each(['TCV', 'UTE', 'TRD', 'XTI'])('rejects unported model parameter %s with a structured temperature error', async parameter => {
    const deck = references[0].deck.replace('LEVEL=3', `LEVEL=3 ${parameter}=0.1`);
    await expect(simulate(deck)).rejects.toMatchObject({
      code: 'UNSUPPORTED_TEMPERATURE', deviceName: 'M1', temperature: 100, parameter,
    });
  });
  it('guards unported fields in direct .step/.dc temperature hooks and preserves the last valid state', () => {
    const circuit = parse(references[0].deck.replace('TNOM=50', 'TNOM=27 TCV=0.1')
      .replace('TEMP=100', 'TEMP=27')).compile();
    const device = circuit.devices.find(device => device instanceof MOS3) as MOS3;
    expect(() => device.setTemperature(-40)).toThrowError(expect.objectContaining({
      code: 'UNSUPPORTED_TEMPERATURE', parameter: 'TCV', temperature: -40,
    }));
    expect(device.getTemperature()).toBe(27);
  });
});
