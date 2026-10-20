import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { simulate } from '../simulate.js';
import { InvalidCircuitError } from '../errors.js';
import { VBIC } from './vbic.js';
import type { StampContext } from './device.js';

// Project-authored MIT regression. An independent thermal power source isolates
// CTH integration from the existing nonlinear electrical/temperature mapping.
const powerStep = (method: string, polarity: string, area: number) => `VBIC thermal power step
Q1 0 0 0 0 dt mod ${area}
Iheat 0 dt PWL(0 0 1u 0 1.000001u 1m)
.model mod ${polarity} level=9 rth=300 cth=1u
.options method=${method} reltol=1e-6 abstol=1e-14
.tran 1u 1.5m 0 1u
.end`;

describe('VBIC transient self heating', () => {
  it.each(['trap', 'gear'].flatMap(method => ['npn', 'pnp'].flatMap(polarity =>
    [1, 2].map(area => ({ method, polarity, area })))))(
    'integrates a thermal power step ($method $polarity area=$area)', async ({ method, polarity, area }) => {
      const result = (await simulate(powerStep(method, polarity, area))).transient!;
      const temperature = result.voltage('dt');
      let worst = 0;
      result.time.forEach((time, i) => {
        if (time < 2e-6) return;
        const expected = 0.3 / area * (1 - Math.exp(-(time - 1e-6) / 300e-6));
        worst = Math.max(worst, Math.abs(temperature[i] / expected - 1));
      });
      expect(worst).toBeLessThan(1e-3);
      expect(result.time.at(-1)).toBe(1.5e-3);
    },
  );

  it('stamps scaled CTH without a polarity sign and resets its accepted current', () => {
    const device = new VBIC('Q', Array.from({ length: 8 }, (_, i) => i), { RTH: 300, CTH: 1e-6 }, -1, 2);
    let temperature = 0;
    let conductance = 0;
    let rhs = 0;
    const ctx: StampContext = {
      stampG: (r, c, value) => { if (r === 7 && c === 7) conductance += value; },
      stampB: (r, value) => { if (r === 7) rhs += value; }, stampC: () => {},
      getVoltage: n => n === 7 ? temperature : 0, getCurrent: () => 0,
      time: 0, dt: 1e-6, numNodes: 8, sourceScale: 1, useDcSourceValue: false,
    };
    device.acceptTransientStep(ctx);
    temperature = 0.1;
    device.stampTransientCharge(ctx, { method: 'euler', dt: 1e-6 });
    expect(conductance).toBe(2);
    expect(rhs).toBeCloseTo(0, 14);
    device.acceptTransientStep(ctx);
    rhs = 0;
    device.stampAcceptedChargeCurrent(ctx);
    expect(rhs).toBeCloseTo(-0.2, 14);
    device.resetTransient();
    rhs = 0;
    device.stampAcceptedChargeCurrent(ctx);
    expect(rhs).toBe(0);

    // Curved thermal history must enter LTE even with no electrical charges.
    temperature = 0;
    device.acceptTransientStep(ctx);
    temperature = 0.1;
    device.stampTransientCharge(ctx, { method: 'euler', dt: 1e-6 });
    device.acceptTransientStep(ctx);
    temperature = 0.4;
    device.stampTransientCharge(ctx, { method: 'euler', dt: 1e-6 });
    const truncation = { deltas: [1e-6, 1e-6, 1e-6] as const,
      reltol: 1e-6, abstol: 1e-14, chgtol: 1e-18, trtol: 1 };
    const bound = device.truncateTransientStep(ctx, truncation);
    expect(bound).toBeGreaterThan(0);
    expect(bound).toBeLessThan(1e-6);
    expect(device.truncateTransientStep(ctx, truncation)).toBe(bound);
    rhs = 0;
    device.stampAcceptedChargeCurrent(ctx);
    expect(rhs).toBeCloseTo(-0.2, 14); // Trial LTE evaluation did not commit.
  });

  it('heats under an electrical power step with temperature-dependent electrical charge', async () => {
    const source = readFileSync(new URL('../../../../benchmarks/vbic-thermal-transient/power-step.cir', import.meta.url), 'utf8');
    const result = (await simulate(source)).transient!;
    expect(result.time.at(-1)).toBe(3e-6);
    const temperature = result.voltage('dt');
    expect(temperature.at(-1)!).toBeGreaterThan(temperature[0]);
    // Identical-byte ngspice-47 oracle; the benchmark prints all signal errors.
    expect(Math.abs(temperature.at(-1)! / 0.03419172976017186 - 1)).toBeLessThan(1e-3);
  });

  it('reports the next explicit bounded-domain limitation of the unchanged public deck', async () => {
    const source = readFileSync(new URL('../../../../benchmarks/corpus/corpus-f/fixtures/examples/vbic/vbic99_tran.sp', import.meta.url), 'utf8');
    // Resistor exponents and activation energies are supported; HRCF=0 remains separate.
    await expect(simulate(source)).rejects.toThrow(InvalidCircuitError);
    await expect(simulate(source)).rejects.toThrow("Invalid bounded VBIC DC model parameter: 'HRCF'");
  }, 30_000);

  it('keeps four-terminal CTH inert, including the adaptive time grid', async () => {
    const source = `VBIC four terminal
Vc c 0 1
Vb b 0 PWL(0 0.6 1n 0.6 1.1n 0.65)
Q1 c b 0 0 mod
.model mod npn level=4 rth=300 cje=1p CTH=0
.tran 10p 3n
.end`;
    const cold = (await simulate(source)).transient!;
    const inert = (await simulate(source.replace('CTH=0', 'CTH=1u'))).transient!;
    expect(inert.time).toEqual(cold.time);
    for (const node of ['c', 'b']) expect(inert.voltage(node)).toEqual(cold.voltage(node));
    for (const name of ['Vc', 'Vb']) expect(inert.current(name)).toEqual(cold.current(name));
  });
});
