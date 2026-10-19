import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { UnsupportedTemperatureError } from '../errors.js';
import { BJT } from './bjt.js';

const oracle = JSON.parse(readFileSync(
  new URL('./fixtures/bjt-resistor-tempco-1514.json', import.meta.url), 'utf8',
)) as { name: string; deck: string; values: Record<string, number[]> }[];

// Regenerate with spice-heavy pnpm exec tsx benchmarks/bjt-resistor-tempco-1514/compare.ts --update.
// Same 2e-5 Newton-residual tolerance as temperature-ngspice-parity.test.ts.
describe('BJT resistor temperature laws (#1514)', () => {
  it('recomputes from instance-scaled nominal resistances and restores TNOM', () => {
    const bjt = new BJT('Q1', [0, 1, 2, -1, 3], {
      RB: 500, RBM: 50, RC: 30, RE: 10, TNOM: 25,
      TRB1: 0.003, TRB2: 3e-6, TRM1: -0.001, TRM2: 4e-6,
      TRC1: -0.002, TRC2: 2e-6, TRE1: 0.001, TRE2: 1e-6,
    }, { AREA: 2, M: 3 });
    for (const temperature of [85, -15, 85, 25, 105, 25]) {
      bjt.setTemperature(temperature);
      const dt = temperature - 25;
      for (const [resistance, nominal, t1, t2] of [
        [bjt.params.RB, 500, 0.003, 3e-6],
        [bjt.params.RBM, 50, -0.001, 4e-6],
        [bjt.params.RC, 30, -0.002, 2e-6],
        [bjt.params.RE, 10, 0.001, 1e-6],
      ]) expect(resistance).toBe(nominal / 6 * (1 + t1 * dt + t2 * dt * dt));
    }
  });

  it.each(oracle)('$name matches ngspice-47 on identical bytes', async fixture => {
    const result = await simulate(fixture.deck);
    let maxRelativeError = 0;
    for (const [signal, expected] of Object.entries(fixture.values)) {
      const current = signal.startsWith('i(');
      const name = signal.slice(2, -1);
      const actual = result.dcSweep
        ? Array.from(current ? result.dcSweep.current(name) : result.dcSweep.voltage(name))
        : [current ? result.dc!.current(name) : result.dc!.voltage(name)];
      expect(actual).toHaveLength(expected.length);
      expected.forEach((reference, index) => {
        const error = Math.abs(actual[index] - reference) / Math.abs(reference);
        expect(Number.isFinite(error)).toBe(true);
        expect(error).toBeLessThanOrEqual(2e-5);
        maxRelativeError = Math.max(maxRelativeError, error);
      });
    }
    console.info(fixture.name, { maxRelativeError });
  });

  it.each(['TRB', 'TRC', 'TRE', 'TLEV', 'TLEVC', 'TBF1', 'TBF2', 'TVAF1', 'TIRB1'])(
    'still rejects unsupported %s away from TNOM', async parameter => {
      const deck = oracle[0].deck.replace('BF=150', `BF=150 ${parameter}=1`);
      await expect(simulate(deck)).rejects.toBeInstanceOf(UnsupportedTemperatureError);
      await expect(simulate(deck)).rejects.toMatchObject({ parameter });
    },
  );
});
