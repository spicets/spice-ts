import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InvalidCircuitError } from '../errors.js';
import { simulate } from '../simulate.js';
import type { StampContext } from './device.js';
import { VBIC, resolveVBICParams } from './vbic.js';

const deck = readFileSync('../../benchmarks/vbic-wbe/wbe.cir', 'utf8');

describe('VBIC WBE partition (#1291)', () => {
  it('accepts the closed unit interval and defaults to one', () => {
    expect(resolveVBICParams({}, 1).WBE).toBe(1);
    for (const WBE of [0, 0.3, 1]) expect(resolveVBICParams({ WBE }, 1).WBE).toBe(WBE);
  });

  it('rejects nonfinite and out-of-domain WBE with the typed invalid-parameter error', () => {
    for (const WBE of [-0.01, 1.01, NaN, Infinity, -Infinity]) {
      expect(() => resolveVBICParams({ WBE }, 1)).toThrow(InvalidCircuitError);
      expect(() => resolveVBICParams({ WBE }, 1)).toThrow("Invalid bounded VBIC DC model parameter: 'WBE'");
    }
  });

  for (const WBE of [0, 0.3, 1]) {
    for (const polarity of [1, -1]) {
      it(`matches independent current/derivative and depletion charge at WBE=${WBE}, polarity=${polarity}`, () => {
        // Local nodes CX CI BX BI EI BP SI. Unequal Vbei/Vbex is essential.
        const v = [0, 0, 0.3, 0.2, 0, 0, 0].map(x => x * polarity);
        const g = Array.from({ length: 7 }, () => new Float64Array(7));
        const c = Array.from({ length: 7 }, () => new Float64Array(7));
        const b = new Float64Array(7);
        const ctx: StampContext = {
          stampG: (r, col, x) => { g[r][col] += x; }, stampB: (r, x) => { b[r] += x; },
          stampC: (r, col, x) => { c[r][col] += x; },
          getVoltage: n => v[n], getCurrent: () => 0, time: 0, dt: 0, numNodes: 7,
          sourceScale: 1, useDcSourceValue: false, gmin: 0,
        };
        const device = new VBIC('Q', [0, 1, 2, 3, 4, 5, 6], {
          // Suppress transport and resistive currents to isolate the two BE
          // diodes without subtracting nearly equal resistor stamps.
          WBE, IS: 1e-30, RBI: 1e30, IBCI: 0, IBEI: 1e-18, IBEN: 2e-17, NEI: 1.1, NEN: 1.8, CJE: 1e-12,
        }, polarity);
        for (let i = 0; i < 8; i++) {
          g.forEach(row => row.fill(0)); b.fill(0);
          device.stamp(ctx);
        }
        const vt = 1.380662e-23 * 300.15 / 1.602189e-19;
        const errors: number[] = [];
        for (const [node, voltage, weight] of [[3, 0.2, WBE], [2, 0.3, 1 - WBE]]) {
          const current = weight * (1e-18 * Math.expm1(voltage / (1.1 * vt)) + 2e-17 * Math.expm1(voltage / (1.8 * vt)));
          const slope = weight * (1e-18 * Math.exp(voltage / (1.1 * vt)) / (1.1 * vt) + 2e-17 * Math.exp(voltage / (1.8 * vt)) / (1.8 * vt));
          const actual = (g[node].reduce((sum, x, col) => sum + x * v[col], 0) - b[node]) * polarity;
          errors.push(Math.abs(actual - current));
          expect(Math.abs(actual - current)).toBeLessThan(1e-25);
          expect(Math.abs(-g[node][4] - slope)).toBeLessThan(1e-20);
        }
        // Charge history starts at zero, then integrates the same independent
        // unsmoothed depletion integral. AC and Euler must use its derivative.
        device.resetTransient(); v.fill(0); device.acceptTransientStep(ctx);
        v[3] = 0.2 * polarity; v[2] = 0.3 * polarity;
        device.stampDynamic(ctx);
        g.forEach(row => row.fill(0)); b.fill(0);
        device.stampTransientCharge(ctx, { method: 'euler', dt: 1 });
        for (const [node, voltage, weight] of [[3, 0.2, WBE], [2, 0.3, 1 - WBE]]) {
          const cap = weight * 1e-12 * (1 - voltage / 0.75) ** -0.33;
          const q = weight * 1e-12 * 0.75 * (1 - (1 - voltage / 0.75) ** 0.67) / 0.67;
          expect(c[node][node] / 1e-12).toBeCloseTo(cap / 1e-12, 13);
          expect(g[node][node]).toBe(c[node][node]);
          const actual = (g[node].reduce((sum, x, col) => sum + x * v[col], 0) - b[node]) * polarity;
          expect(actual / 1e-12).toBeCloseTo(q / 1e-12, 13);
        }
        console.info(`WBE=${WBE} polarity=${polarity} hand current max absolute error ${Math.max(...errors)}`);
      });
    }
  }

  it('keeps forward diffusion charge intrinsic when WBE=0', () => {
    const caps: number[] = [];
    const device = new VBIC('Q', [0, 1, 2, 3, 4, 5, 6], { WBE: 0, TF: 1e-9 }, 1);
    device.stampDynamic({
      stampG: () => {}, stampB: () => {}, stampC: (r, col, x) => { if (r === 3 && col === 3) caps.push(x); },
      getVoltage: n => n === 3 ? 0.3 : 0, getCurrent: () => 0, time: 0, dt: 0, numNodes: 7,
      sourceScale: 1, useDcSourceValue: false,
    });
    expect(caps[0]).toBeGreaterThan(0);
  });

  it('matches byte-identical ngspice-47 OP/DC/AC within 0.1% peak-normalized error', async () => {
    const result = await simulate(deck);
    // SPICE_ASCIIRAWFILE=1 spice-heavy ngspice -b -r wbe.raw benchmarks/vbic-wbe/wbe.cir
    const dc = [[1.998813029459933, -1.188009973701609e-8], [1.991803971173736, -8.204208916076650e-8], [1.943694157996195, -5.657204232395463e-7]];
    const op = [1.991803969779176, -8.204209337267510e-8];
    const ac = [
      [[-0.3165512356548705, 0.001300467524026804], [-3.188301414699946e-6, -1.240635291182079e-5]],
      [[-0.3160437921290027, 0.01298467687539424], [-4.964049684877403e-6, -1.239986811472459e-4]],
      [[-0.2721202401553288, 0.1125362858647379], [-1.604952389945638e-4, -1.183824165976699e-3]],
    ];
    const errors: number[] = [];
    for (const [col, name] of ['c', 'vb'].entries()) {
      const sweep = col ? result.dcSweep!.current(name) : result.dcSweep!.voltage(name);
      const complex = col ? result.ac!.current(name) : result.ac!.voltage(name);
      const peak = Math.max(...dc.map(row => Math.abs(row[col])));
      const acPeak = Math.max(...ac.map(row => Math.hypot(...row[col])));
      expect(sweep).toHaveLength(3); expect(complex).toHaveLength(3);
      errors.push(Math.abs((col ? result.dc!.current(name) : result.dc!.voltage(name)) - op[col]) / peak);
      dc.forEach((row, i) => errors.push(Math.abs(sweep[i] - row[col]) / peak));
      ac.forEach((row, i) => {
        const phase = complex[i].phase * Math.PI / 180;
        errors.push(Math.hypot(complex[i].magnitude * Math.cos(phase) - row[col][0], complex[i].magnitude * Math.sin(phase) - row[col][1]) / acPeak);
      });
    }
    console.info(`VBIC WBE ngspice-47 max normalized error ${Math.max(...errors)}`);
    expect(Math.max(...errors)).toBeLessThan(0.001);
  });
});
