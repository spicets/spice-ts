import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InvalidCircuitError } from '../errors.js';
import { simulate } from '../simulate.js';
import type { StampContext } from './device.js';
import { VBIC, resolveVBICParams } from './vbic.js';

describe('VBIC parasitic BE currents (#1297)', () => {
  for (const name of ['IBEIP', 'IBENP'] as const) {
    it(`defaults ${name} to zero and validates its bounded domain`, () => {
      expect(resolveVBICParams({}, 1)[name]).toBe(0);
      expect(resolveVBICParams({ [name]: 1e-14 }, 1)[name]).toBe(1e-14);
      for (const value of [-1, NaN, Infinity, -Infinity]) {
        expect(() => resolveVBICParams({ [name]: value }, 1)).toThrow(InvalidCircuitError);
        expect(() => resolveVBICParams({ [name]: value }, 1)).toThrow(`Invalid bounded VBIC DC model parameter: '${name}'`);
      }
    });
  }

  for (const temperature of [0, 27, 75]) for (const polarity of [1, -1]) {
    for (const currents of [{ IBEIP: 1e-12, IBENP: 0 }, { IBEIP: 0, IBENP: 2e-10 }, { IBEIP: 1e-12, IBENP: 2e-10 }]) {
      it(`matches hand current and derivatives at ${temperature} C, polarity ${polarity}, ${JSON.stringify(currents)}`, () => {
        // CX CI BX BI EI BP SI; Vbep=0.3 differs from both Vbei and Vbex.
        const v = [0.1, 0.1, 0.4, 0.2, 0, 0.1, 0].map(x => x * polarity);
        const g = Array.from({ length: 7 }, () => new Float64Array(7));
        const b = new Float64Array(7);
        const caps: number[][] = [];
        const ctx: StampContext = {
          stampG: (r, c, x) => { g[r][c] += x; }, stampB: (r, x) => { b[r] += x; },
          stampC: (...x) => { caps.push(x); }, getVoltage: n => v[n], getCurrent: () => 0,
          time: 0, dt: 0, numNodes: 7, sourceScale: 1, useDcSourceValue: false, gmin: 0,
        };
        // Disable unrelated junctions/transport; RBP current is zero at this bias.
        const device = new VBIC('Q', [0, 1, 2, 3, 4, 5, 6], {
          ...currents, IS: 1e-30, IBEI: 0, IBCI: 0, RBI: 1e30,
          NCI: 1.2, NCN: 1.8, NEI: 1.1, NEN: 2.2,
        }, polarity, 3);
        device.setTemperature(temperature);
        for (let i = 0; i < 8; i++) {
          g.forEach(row => row.fill(0)); b.fill(0); device.stamp(ctx);
        }
        const vt = 1.380662e-23 * (temperature + 273.15) / 1.602189e-19;
        const ratio = (temperature + 273.15) / 300.15;
        const factor = ratio ** 3 * Math.exp(-1.12 * (1 - ratio) / vt);
        const ideal = currents.IBEIP * factor ** (1 / 1.2);
        const nonideal = currents.IBENP * factor ** (1 / 1.8);
        const current = 3 * (ideal * Math.expm1(0.3 / (1.2 * vt)) + nonideal * Math.expm1(0.3 / (1.8 * vt)));
        const slope = 3 * (ideal * Math.exp(0.3 / (1.2 * vt)) / (1.2 * vt) + nonideal * Math.exp(0.3 / (1.8 * vt)) / (1.8 * vt));
        const actual = (g[2].reduce((sum, x, c) => sum + x * v[c], 0) - b[2]) * polarity;
        expect(Math.abs(actual / current - 1)).toBeLessThan(1e-10);
        expect(Math.abs(g[2][2] / slope - 1)).toBeLessThan(1e-10);
        expect(Math.abs(g[2][5] / slope + 1)).toBeLessThan(1e-10);
        expect(Math.abs(g[5][2] / slope + 1)).toBeLessThan(1e-10);
        const noise = device.noiseOperatingPoint(Float64Array.from(v), 0);
        expect(Math.abs(noise[5].shotCurrent / current - 1)).toBeLessThan(1e-10);
        device.stampDynamic(ctx);
        expect(caps).toEqual([]); // Ibep adds conductance, no stored charge.
        device.acceptTransientStep(ctx);
        device.stampTransientCharge(ctx, { method: 'euler', dt: 1e-9 });
        expect(Math.abs(g[2][2] / slope - 1)).toBeLessThan(1e-10);
      });
    }
  }
  it('matches byte-identical ngspice-47 OP/DC/AC within 0.1% peak-normalized error', async () => {
    const deck = readFileSync('../../benchmarks/vbic-ibeip/ibeip.cir', 'utf8');
    const result = await simulate(deck);
    // SPICE_ASCIIRAWFILE=1 spice-heavy ngspice -b -r ibeip.raw benchmarks/vbic-ibeip/ibeip.cir
    const op = [1.332403885504739e-5, -1.494279112454848e-4];
    const dc = [
      [6.439430862155516e-5, -9.125449626902177e-5],
      [1.332390030940021e-5, -1.494277833738174e-4],
      [-4.572619561709686e-4, -2.175962547829308e-4],
    ];
    const ac = [-3.120987508018475e-3, -1.274670085486124e-3];
    const absolute: number[] = [];
    const normalized: number[] = [];
    for (const [col, name] of ['vc', 'vb'].entries()) {
      const sweep = result.dcSweep!.current(name);
      const complex = result.ac!.current(name);
      expect(sweep).toHaveLength(3); expect(complex).toHaveLength(3);
      const peak = Math.max(...dc.map(row => Math.abs(row[col])));
      const errors = [Math.abs(result.dc!.current(name) - op[col]), ...dc.map((row, i) => Math.abs(sweep[i] - row[col]))];
      absolute.push(...errors); normalized.push(...errors.map(x => x / peak));
      for (const point of complex) {
        const phase = point.phase * Math.PI / 180;
        const error = Math.hypot(point.magnitude * Math.cos(phase) - ac[col], point.magnitude * Math.sin(phase));
        absolute.push(error); normalized.push(error / Math.abs(ac[col]));
      }
    }
    console.info(`IBEIP/IBENP ngspice-47 max absolute error ${Math.max(...absolute)} A, max peak-normalized error ${Math.max(...normalized)}`);
    expect(Math.max(...normalized)).toBeLessThan(0.001);
  });
});
