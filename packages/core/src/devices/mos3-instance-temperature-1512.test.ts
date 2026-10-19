import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { solveDCOperatingPoint } from '../analysis/dc.js';
import { solveDCSweep } from '../analysis/dc-sweep.js';
import { parse } from '../parser/index.js';
import { simulate } from '../simulate.js';
import { resolveOptions } from '../types.js';
import { MOS3 } from './mos3.js';

interface Reference {
  id: string;
  deck: string;
  sha256: string;
  op: number[];
  dc: number[][];
}
const { references } = JSON.parse(readFileSync(new URL(
  '../../../../benchmarks/mos3-instance-temperature/reference.json', import.meta.url,
), 'utf8')) as { references: Reference[] };

// Same OP tolerance as mos3-temperature-1057.test.ts, without relaxation.
function expectParity(actual: number[], expected: number[]): void {
  actual.forEach((value, index) => {
    expect(Math.abs(value - expected[index]), `signal ${index}`)
      .toBeLessThan(1e-12 + 1e-7 * Math.abs(expected[index]));
  });
}

describe('MOS3 instance temperature ngspice-47 parity (#1512)', () => {
  for (const reference of references) {
    it(`${reference.id} identical-byte OP and DC TEMP sweep`, async () => {
      expect(createHash('sha256').update(reference.deck).digest('hex')).toBe(reference.sha256);
      const result = await simulate(reference.deck);
      expectParity([result.dc!.voltage('d'), result.dc!.voltage('s'), result.dc!.current('VD')], reference.op);
      const sweep = result.dcSweep!;
      expect([...sweep.sweepValues]).toEqual(reference.dc.map(row => row[0]));
      reference.dc.forEach((row, index) => {
        expectParity([sweep.voltage('d')[index], sweep.voltage('s')[index], sweep.current('VD')[index]], row.slice(1));
      });
    });
  }

  it('preserves DTEMP across .step TEMP using the ngspice DC TEMP oracle', async () => {
    const reference = references.find(reference => reference.id === 'nmos-dtemp=25')!;
    const result = await simulate(reference.deck.replace('.dc TEMP -25 100 25',
      '.step TEMP list -25 0 25 50 75 100'), { stepWorkers: false });
    expect(result.steps!.map(step => step.paramValue)).toEqual(reference.dc.map(row => row[0]));
    result.steps!.forEach((step, index) => {
      expectParity([step.dc!.voltage('d'), step.dc!.voltage('s'), step.dc!.current('VD')], reference.dc[index].slice(1));
    });
  });

  it('restores circuit temperature after repeated DC sweeps without accumulating DTEMP', () => {
    const reference = references.find(reference => reference.id === 'nmos-dtemp=25')!;
    const compiled = parse(reference.deck).compile();
    const options = resolveOptions(compiled.simulationOptions);
    const mos = compiled.devices.find(device => device instanceof MOS3) as MOS3;
    for (let repeat = 0; repeat < 2; repeat++) {
      solveDCSweep(compiled, { type: 'dc', source: 'TEMP', start: -25, stop: 100, step: 25 }, options);
      expect(mos.getTemperature()).toBe(50);
      const { result } = solveDCOperatingPoint(compiled, options);
      expectParity([result.voltage('d'), result.voltage('s'), result.current('VD')], reference.op);
    }
  });

  it('validates unported model fields against effective instance temperature', async () => {
    const reference = references.find(reference => reference.id === 'nmos-temp=75')!;
    await expect(simulate(reference.deck.replace('LEVEL=3', 'LEVEL=3 TCV=0.1'))).rejects.toMatchObject({
      code: 'UNSUPPORTED_TEMPERATURE', parameter: 'TCV', temperature: 75,
    });
  });
});
