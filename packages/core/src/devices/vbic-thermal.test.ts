import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { InvalidCircuitError } from '../errors.js';
import { readFileSync } from 'node:fs';
import { VBIC } from './vbic.js';
import type { StampContext } from './device.js';

const deck = (terminal = 'dt', rth = 300, extra = '', analysis = '.op') => `VBIC thermal
Vc c 0 1
Vb b 0 0.6
Q1 c b 0 0 ${terminal} mod
.model mod npn level=4 rth=${rth} ${extra}
${analysis}
.end`;

describe('VBIC DC self heating', () => {
  it('stamps all four series-power voltage derivatives against a numerical oracle', () => {
    const supplied = { RTH: 300, RCX: 1000, RBX: 10000, RE: 100, RS: 500 };
    const nodes = Array.from({ length: 8 }, (_, i) => i);
    const external = [8, 9, 10, 11];
    const internal = [0, 2, 4, 6];
    const resistance = [1000, 10000, 100, 500];
    const v = [1.5, 1.4, 0.74, 0.73, 0.02, 0.6, -0.1, 0.2, 2, 0.75, 0, -0.2];
    const power = (values: number[]) => external.reduce((sum, node, i) =>
      sum + 2 * (values[node] - values[internal[i]]) ** 2 / resistance[i], 0);
    const stamp = (terminals?: number[]) => {
      const g = new Float64Array(v.length);
      let rhs = 0;
      const ctx: StampContext = {
        stampG: (row, column, value) => { if (row === 7) g[column] += value; },
        stampB: (row, value) => { if (row === 7) rhs += value; },
        stampC: () => {}, getVoltage: node => v[node], getCurrent: () => 0,
        time: 0, dt: 0, numNodes: v.length, sourceScale: 1, useDcSourceValue: true,
      };
      new VBIC('Q', nodes, supplied, 1, 2, 1, terminals).stamp(ctx);
      return { g, rhs };
    };
    const intrinsic = stamp();
    const full = stamp(external);
    expect(full.rhs - intrinsic.rhs).toBeCloseTo(-power(v), 12);
    for (let column = 0; column < v.length; column++) {
      const plus = [...v];
      const minus = [...v];
      plus[column] += 1e-5;
      minus[column] -= 1e-5;
      const derivative = (power(plus) - power(minus)) / 2e-5;
      expect(full.g[column] - intrinsic.g[column]).toBeCloseTo(-derivative, 10);
    }
  });

  it.each(['rcx=1000', 'rbx=10000', 're=100', 'rs=1000', 'rcx=1000 rbx=10000 re=100 rs=1000']
    .flatMap(resistance => ['npn', 'pnp'].flatMap(polarity => [1, 2].map(area => ({ resistance, polarity, area })))))(
    'includes expanded resistor heat ($resistance $polarity area=$area)', async ({ resistance, polarity, area }) => {
      const sign = polarity === 'npn' ? 1 : -1;
      const result = (await simulate(`VBIC series heat ${resistance} ${polarity} ${area}
Vc c 0 ${sign * 2}
Vb b 0 ${sign * 0.75}
Vs s 0 ${sign * -0.2}
Q1 c b 0 s dt mod ${area}
.model mod ${polarity} level=4 rth=300 ${resistance}
.op
.end`)).dc!;
      const power = -sign * (2 * result.current('Vc') + 0.75 * result.current('Vb') - 0.2 * result.current('Vs'));
      expect(result.voltage('dt')).toBeCloseTo(power * 300 / area, 6);
    },
  );

  it('matches the ngspice-47 RCX heating oracle', async () => {
    const result = (await simulate(deck('dt', 300, 'rcx=1000')
      .replace('Vc c 0 1', 'Vc c 0 2').replace('Vb b 0 0.6', 'Vb b 0 0.75'))).dc!;
    expect(result.voltage('dt')).toBeCloseTo(0.2392679, 5);
  });

  it('runs the unchanged public vbic99 DC deck', async () => {
    const source = readFileSync(new URL('../../../../benchmarks/corpus/corpus-f/fixtures/examples/vbic/vbic99_dc.sp', import.meta.url), 'utf8');
    const result = await simulate(source);
    expect(result.dcSweep!.voltage('dt')).toHaveLength(51);
    expect(Array.from(result.dcSweep!.voltage('dt')).every(Number.isFinite)).toBe(true);
  });
  it('balances intrinsic dissipation and RTH and changes the electrical currents', async () => {
    const hot = (await simulate(deck())).dc!;
    const cold = (await simulate(deck('', 300))).dc!;
    const power = -hot.current('Vc') - 0.6 * hot.current('Vb');
    expect(hot.voltage('dt')).toBeGreaterThan(0);
    expect(hot.voltage('dt')).toBeCloseTo(power * 300, 6);
    expect(Math.abs(hot.current('Vc'))).toBeGreaterThan(Math.abs(cold.current('Vc')));
  });

  it.each(['', 'rcx=1000 rbx=10000 re=100 rs=1000'])(
    'keeps RTH=0 and four-terminal electrical results identical (%s)', async extra => {
      const four = (await simulate(deck('', 0, extra))).dc!;
      const five = (await simulate(deck('dt', 0, extra))).dc!;
      expect(five.current('Vc')).toBe(four.current('Vc'));
      expect(five.current('Vb')).toBe(four.current('Vb'));
      expect(five.voltage('dt')).toBe(0);
      const inert = (await simulate(deck('', 300, extra))).dc!;
      expect(inert.current('Vc')).toBe(four.current('Vc'));
  });

  it.each(['.ac lin 1 1k 1k', '.noise v(c) Vb dec 2 1k 10k'])(
    'still rejects active self-heating small-signal analysis (%s) with a typed error', async analysis => {
      await expect(simulate(deck('dt', 300, 'cth=1u', analysis)))
        .rejects.toThrow(InvalidCircuitError);
    },
  );
});
