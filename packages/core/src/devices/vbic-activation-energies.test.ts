import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { resolveVBICParams } from './vbic.js';
import { resolveVBICTemperature } from './vbic-temperature.js';

const reference = JSON.parse(readFileSync(new URL('../../../../benchmarks/vbic-activation-energies/ngspice-47.json', import.meta.url), 'utf8')) as {
  version: string; rows: { deck: string; values: number[] }[];
};
const names = ['EA', 'EAIE', 'EAIC', 'EAIS', 'EANE', 'EANC', 'EANS', 'EAP'] as const;
describe('VBIC activation energies (#1529)', () => {
  it.each(reference.rows.map((row, i) => ({ ...row, i })))('matches ngspice-47 OP case $i', async ({ deck, values }) => {
    expect(reference.version).toBe('ngspice-47');
    const result = (await simulate(deck)).dc!;
    const actual = ['c', 'b', 'e', 's'].map(node => result.voltage(node)).concat(['vc', 'vb', 've', 'vs'].map(source => result.current(source)));
    actual.forEach((value, i) => expect(Math.abs(value / values[i] - 1)).toBeLessThanOrEqual(1e-6));
  });
  it.each(names)('rejects nonfinite %s', name => {
    for (const value of [NaN, Infinity, -Infinity]) expect(() => resolveVBICParams({ [name]: value }, 1)).toThrow();
  });
  it('keeps explicit default energies bit-identical at every temperature', () => {
    const defaults = resolveVBICParams({}, 1);
    const explicit = resolveVBICParams(Object.fromEntries(names.map(name => [name, 1.12])), 1);
    for (const temperature of [-20, 27, 85]) expect(resolveVBICTemperature(explicit, temperature)).toEqual(resolveVBICTemperature(defaults, temperature));
  });
  it('uses each junction energy and emission coefficient, including parasitic cross-mapping', () => {
    const params = resolveVBICParams({
      EA: 1.01, EAIE: 1.02, EAIC: 1.03, EAIS: 1.04,
      EANE: 1.05, EANC: 1.06, EANS: 1.07, EAP: 1.08,
      NF: 1.1, NEI: 1.2, NEN: 1.3, NCI: 1.4, NCN: 1.5,
      NFP: 1.6, NCIP: 1.7, NCNP: 1.8,
      IS: 1e-16, IBEI: 2e-16, IBEN: 3e-16, IBCI: 4e-16, IBCN: 5e-16,
      IBEIP: 6e-16, IBENP: 7e-16, ISP: 8e-16, IBCIP: 9e-16, IBCNP: 1e-15,
      GAMM: 0.01, CJE: 1e-12, CJC: 2e-12, CJEP: 3e-12, CJCP: 4e-12,
    }, 1);
    const mapped = resolveVBICTemperature(params, 85);
    const ratio = (273.15 + 85) / (273.15 + 27);
    const vt = 1.380662e-23 * (273.15 + 85) / 1.602189e-19;
    const pairs = [
      ['IS', 'EA', 'NF'], ['IBEI', 'EAIE', 'NEI'], ['IBEN', 'EANE', 'NEN'],
      ['IBCI', 'EAIC', 'NCI'], ['IBCN', 'EANC', 'NCN'],
      ['IBEIP', 'EAIC', 'NCI'], ['IBENP', 'EANC', 'NCN'], ['ISP', 'EAP', 'NFP'],
      ['IBCIP', 'EAIS', 'NCIP'], ['IBCNP', 'EANS', 'NCNP'],
    ] as const;
    for (const [current, activation, emission] of pairs) {
      const expected = params[current] * (ratio ** 3 * Math.exp(params[activation] * (ratio - 1) / vt)) ** (1 / params[emission]);
      expect(mapped[current] / expected).toBeCloseTo(1, 14);
    }
    expect(mapped.GAMM / (params.GAMM * ratio ** 3 * Math.exp(params.EA * (ratio - 1) / vt))).toBeCloseTo(1, 14);
    for (const [potential, activation] of [['PE', 'EAIE'], ['PC', 'EAIC'], ['PS', 'EAIS']] as const) {
      const nominalVt = vt / ratio;
      const psi0 = 2 * nominalVt * Math.log(2 * Math.sinh(params[potential] / (2 * nominalVt)));
      const psi = ratio * psi0 - 3 * vt * Math.log(ratio) - params[activation] * (ratio - 1);
      const expected = psi + 2 * vt * Math.log((1 + Math.sqrt(1 + 4 * Math.exp(-psi / vt))) / 2);
      expect(mapped[potential]).toBeCloseTo(expected, 14);
    }
    for (const [cap, potential, grading] of [['CJE', 'PE', 'ME'], ['CJC', 'PC', 'MC'], ['CJEP', 'PC', 'MC'], ['CJCP', 'PS', 'MS']] as const) {
      expect(mapped[cap] / (params[cap] * (params[potential] / mapped[potential]) ** params[grading])).toBeCloseTo(1, 14);
    }
  });
});
