import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InvalidCircuitError } from '../errors.js';
import { simulate } from '../simulate.js';
import type { StampContext } from './device.js';
import { VBIC, resolveVBICParams } from './vbic.js';

const deck = readFileSync('../../benchmarks/vbic-wsp/wsp.cir', 'utf8');

describe('VBIC WSP substrate-parasitic weighting (#1294)', () => {
  it('defaults to one and accepts the closed unit interval', () => {
    expect(resolveVBICParams({}, 1).WSP).toBe(1);
    for (const WSP of [0, 0.3, 1]) expect(resolveVBICParams({ WSP }, 1).WSP).toBe(WSP);
  });

  it('rejects nonfinite and out-of-domain WSP with a typed error', () => {
    for (const WSP of [-0.01, 1.01, NaN, Infinity, -Infinity]) {
      expect(() => resolveVBICParams({ WSP }, 1)).toThrow(InvalidCircuitError);
      expect(() => resolveVBICParams({ WSP }, 1)).toThrow("Invalid bounded VBIC DC model parameter: 'WSP'");
    }
  });

  for (const WSP of [0, 0.3, 1]) {
    for (const polarity of [1, -1]) {
      it(`matches independent transport, Jacobian, AC and transient charge at WSP=${WSP}, polarity=${polarity}`, () => {
        // Local nodes CX CI BX BI EI BP SI. Vbep != Vbci detects wrong mixing.
        const v = [0, 0, 0.3, 0.2, 0, 0, 0.1].map(x => x * polarity);
        const g = Array.from({ length: 7 }, () => new Float64Array(7));
        const caps = Array.from({ length: 7 }, () => new Float64Array(7));
        const b = new Float64Array(7);
        const ctx: StampContext = {
          stampG: (r, col, x) => { g[r][col] += x; }, stampB: (r, x) => { b[r] += x; },
          stampC: (r, col, x) => { caps[r][col] += x; },
          getVoltage: n => v[n], getCurrent: () => 0, time: 0, dt: 0, numNodes: 7,
          sourceScale: 1, useDcSourceValue: false, gmin: 0,
        };
        const device = new VBIC('Q', [0, 1, 2, 3, 4, 5, 6], {
          WSP, ISP: 1e-12, NFP: 1.2, IKP: 1e-8, TR: 1e-9,
          IS: 1e-30, IBCI: 0, IBEI: 0, RBI: 1e30,
        }, polarity);
        for (let i = 0; i < 8; i++) {
          g.forEach(row => row.fill(0)); b.fill(0); device.stamp(ctx);
        }
        const nvt = 1.2 * 1.380662e-23 * 300.15 / 1.602189e-19;
        const ifp = 1e-12 * (WSP * Math.expm1(0.3 / nvt) + (1 - WSP) * Math.expm1(0.2 / nvt));
        const irp = 1e-12 * Math.expm1(0.1 / nvt);
        const root = Math.sqrt(1 + 4 * ifp / 1e-8);
        const qbp = (1 + root) / 2;
        const current = (ifp - irp) / qbp;
        const actual = -(g[6].reduce((sum, x, col) => sum + x * v[col], 0) - b[6]) * polarity;
        const error = Math.abs(actual - current);
        expect(error).toBeLessThan(1e-20);
        for (const [col, voltage, weight] of [[2, 0.3, WSP], [3, 0.2, 1 - WSP]]) {
          const derivative = 1e-12 * weight * Math.exp(voltage / nvt) / nvt;
          const slope = derivative * (1 / qbp - (ifp - irp) / (qbp * qbp * root * 1e-8));
          expect(Math.abs(g[6][col] + slope)).toBeLessThan(1e-18);
          device.stampDynamic(ctx);
          expect(Math.abs(caps[2][col] - 1e-9 * derivative)).toBeLessThan(1e-28);
          caps.forEach(row => row.fill(0));
        }
        device.resetTransient(); v.fill(0); device.acceptTransientStep(ctx);
        v[2] = 0.3 * polarity; v[3] = 0.2 * polarity; v[6] = 0.1 * polarity;
        g.forEach(row => row.fill(0)); b.fill(0);
        device.stampTransientCharge(ctx, { method: 'euler', dt: 1 });
        const charge = (g[2].reduce((sum, x, col) => sum + x * v[col], 0) - b[2]) * polarity;
        expect(Math.abs(charge - 1e-9 * ifp)).toBeLessThan(1e-28);
        console.info(`WSP=${WSP} polarity=${polarity} hand current absolute error ${error}`);
      });
    }
  }

  it('matches byte-identical ngspice-47 OP/DC/AC within 0.1% peak-normalized error', async () => {
    const result = await simulate(deck);
    // SPICE_ASCIIRAWFILE=1 spice-heavy ngspice -b -r wsp.raw benchmarks/vbic-wsp/wsp.cir
    const op = [-7.782977733431957e-6, -2.984404390930784e-7, 4.712674194680875e-8];
    const dc = [
      [-1.135776079529767e-6, -4.648342857821453e-8, 9.807912959205333e-9],
      [-7.782852499782941e-6, -2.984360850828705e-7, 4.712641399735449e-8],
      [-5.090745160474004e-5, -1.843508992621090e-6, 1.995138167976553e-7],
    ];
    const ac = [
      [[-2.979461215308450e-4, 6.332361565161968e-8], [-1.106376781265239e-5, -5.038339519381325e-8], [1.442910571627571e-6, -4.464519826878896e-11]],
      [[-2.979458695169414e-4, 6.332360511348886e-7], [-1.106396617732430e-5, -5.038338690240592e-7], [1.442910388864668e-6, -4.464519061852638e-10]],
      [[-2.979206685678442e-4, 6.332255131888469e-6], [-1.108380229554451e-5, -5.038255777621549e-6], [1.442892112894778e-6, -4.464442560568510e-9]],
    ];
    const errors: number[] = [];
    const absolute: number[] = [];
    for (const [col, name] of ['vc', 'vb', 'vs'].entries()) {
      const sweep = result.dcSweep!.current(name);
      const complex = result.ac!.current(name);
      const peak = Math.max(...dc.map(row => Math.abs(row[col])));
      const acPeak = Math.max(...ac.map(row => Math.hypot(...row[col])));
      expect(sweep).toHaveLength(3); expect(complex).toHaveLength(3);
      const opError = Math.abs(result.dc!.current(name) - op[col]);
      absolute.push(opError); errors.push(opError / peak);
      dc.forEach((row, i) => {
        const error = Math.abs(sweep[i] - row[col]);
        absolute.push(error); errors.push(error / peak);
      });
      ac.forEach((row, i) => {
        const phase = complex[i].phase * Math.PI / 180;
        const error = Math.hypot(complex[i].magnitude * Math.cos(phase) - row[col][0], complex[i].magnitude * Math.sin(phase) - row[col][1]);
        absolute.push(error); errors.push(error / acPeak);
      });
    }
    console.info(`VBIC WSP ngspice-47 max normalized error ${Math.max(...errors)}, max absolute current error ${Math.max(...absolute)} A`);
    expect(Math.max(...errors)).toBeLessThan(0.001);
  });
});
