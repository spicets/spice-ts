import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { parse } from '../parser/index.js';
import { InvalidCircuitError } from '../errors.js';
import type { StampContext } from './device.js';
import { VBIC, resolveVBICParams } from './vbic.js';
import { resolveVBICTemperature } from './vbic-temperature.js';

const junctions = { PE: 0.9, ME: 0.4, PC: 0.6, MC: 0.45, PS: 0.7, MS: 0.25 };
// Identical input to ngspice-47: SPICE_ASCIIRAWFILE=1 ngspice -b -r junction.raw junction.cir.
const deck = `VBIC junction parameters
VCC cc 0 2
RC cc c 1k
VB b 0 DC 0.65 AC 1
VS ss 0 -0.2
RS ss s 100
Q1 c b 0 s QV
.model QV NPN(LEVEL=4 IS=1e-16 IBEI=1e-18 IBCI=1e-16 ISP=1e-17 RBP=10 VEF=50 VER=10 CJE=1p CJC=2p CJEP=3p CJCP=4p PE=0.9 ME=0.4 PC=0.6 MC=0.45 PS=0.7 MS=0.25)
.temp 75
.op
.dc VB 0.6 0.7 0.05
.ac dec 1 1meg 100meg
.save v(c) v(s) i(vb)
.end
`;

describe('VBIC junction potentials and grading (#1281)', () => {
  for (const name of ['PE', 'PC', 'PS']) {
    it(`rejects invalid ${name}`, () => {
      for (const value of [0, -1, NaN, Infinity]) {
        expect(() => resolveVBICParams({ [name]: value }, 1)).toThrow(InvalidCircuitError);
      }
    });
  }
  for (const name of ['ME', 'MC', 'MS'] as const) {
    it(`bounds ${name} below the depletion integral singularity`, () => {
      for (const value of [-1, 1, NaN, Infinity]) {
        expect(() => resolveVBICParams({ [name]: value }, 1)).toThrow(InvalidCircuitError);
      }
      expect(resolveVBICParams({ [name]: 0 }, 1)[name]).toBe(0);
    });
  }

  it.each([{}, { IBEIP: 0 }, { IBENP: 0 }, { IBEIP: 0, IBENP: 0 }, { WBE: 1 }, { WSP: 1 }, { WBE: 1, WSP: 1 }] as Record<string, number>[])('keeps default DC/AC/transient stamps bit-identical with %j', wbe => {
    // Captured before the fix at 55b6fcf3, not re-generated from new defaults.
    // Both polarities and 0/27/75 C include all four depletion capacitances.
    const all: unknown[] = [];
    for (const polarity of [1, -1]) {
      for (const temperature of [0, 27, 75]) {
        const device = new VBIC('Q', [0, 1, 2, 3, 4, 5, 6], {
          ...wbe, CJE: 1e-12, CJC: 2e-12, CJEP: 3e-12, CJCP: 4e-12, VEF: 50, VER: 10,
        }, polarity);
        device.setTemperature(temperature);
        const stamps: unknown[] = [];
        const ctx: StampContext = {
          stampG: (...v: number[]) => { stamps.push(['g', ...v]); },
          stampB: (...v: number[]) => { stamps.push(['b', ...v]); },
          stampC: (...v: number[]) => { stamps.push(['c', ...v]); },
          getVoltage: n => [0.2, 0.3, 0.1, 0.15, 0, 0.05, 0.2][n] * polarity,
          getCurrent: () => 0, time: 0, dt: 0, numNodes: 7,
          sourceScale: 1, useDcSourceValue: false,
        };
        device.stamp(ctx);
        device.stampDynamic(ctx);
        device.acceptTransientStep(ctx);
        device.stampTransientCharge(ctx, { method: 'euler', dt: 1e-9 });
        all.push(stamps);
      }
    }
    expect(createHash('sha256').update(`${JSON.stringify(all)}\n`).digest('hex'))
      .toBe('a434320192909e68675d0fe79fb6f9d5cfc0c309d878203b1fee07fada119012');
  });

  // ngspice-47 src/spicelib/devices/vbic/vbictemp.c:278-331.
  // Potential lower limit and capacitance scaling use each nominal P/M pair;
  // CJEP shares PC/MC, whereas CJCP uses PS/MS.
  for (const temperature of [0, 27, 75]) {
    it(`maps all four zero-bias capacitances at ${temperature} C`, () => {
      const params = resolveVBICParams({ ...junctions, CJE: 1e-12, CJC: 2e-12, CJEP: 3e-12, CJCP: 4e-12 }, 1);
      const actual = resolveVBICTemperature(params, temperature);
      const ratio = (temperature + 273.15) / 300.15;
      const vt = 1.380662e-23 * (temperature + 273.15) / 1.602189e-19;
      for (const [cap, potential, grading] of [
        ['CJE', 'PE', 'ME'], ['CJC', 'PC', 'MC'], ['CJEP', 'PC', 'MC'], ['CJCP', 'PS', 'MS'],
      ] as const) {
        const psi0 = 2 * vt / ratio * Math.log(2 * Math.sinh(params[potential] * ratio / (2 * vt)));
        const psi = ratio * psi0 - 3 * vt * Math.log(ratio) - 1.12 * (ratio - 1);
        const mapped = psi + 2 * vt * Math.log((1 + Math.sqrt(1 + 4 * Math.exp(-psi / vt))) / 2);
        expect(actual[potential]).toBeCloseTo(mapped, 14);
        expect(actual[cap] / params[cap]).toBeCloseTo((params[potential] / mapped) ** params[grading], 14);
      }
    });
  }

  // vbicload.c:2241-2280 (ngspice-47), unsmoothed FC=0.9 depletion
  // integral and its derivative, including the forward-bias continuation.
  for (const [cap, potential, grading, from, to] of [
    ['CJE', 'PE', 'ME', 3, 4], ['CJC', 'PC', 'MC', 3, 1],
    ['CJEP', 'PC', 'MC', 2, 5], ['CJCP', 'PS', 'MS', 6, 5],
  ] as const) {
    for (const normalizedVoltage of [-0.3, 0.95]) {
      it(`applies ${potential}/${grading} to ${cap} charge and capacitance at V/P=${normalizedVoltage}`, () => {
        const device = new VBIC('Q', [0, 1, 2, 3, 4, 5, 6], { ...junctions, [cap]: 1e-12 }, 1);
        const voltage = new Float64Array(7);
        const b = new Float64Array(7);
        const c = Array.from({ length: 7 }, () => new Float64Array(7));
        const ctx: StampContext = {
          stampG: () => {}, stampB: (r, v) => { b[r] += v; },
          stampC: (r, col, v) => { c[r][col] += v; },
          getVoltage: n => voltage[n], getCurrent: () => 0,
          time: 0, dt: 0, numNodes: 7, sourceScale: 1, useDcSourceValue: false,
        };
        device.acceptTransientStep(ctx); // Q(0)=0 before measuring the integral.
        const p = junctions[potential];
        const m = junctions[grading];
        const v = p * normalizedVoltage;
        voltage[from] = v;
        device.stampDynamic(ctx);
        device.stampTransientCharge(ctx, { method: 'euler', dt: 1 });
        const delta = v - 0.9 * p;
        const q = delta > 0
          ? p * (1 - 0.1 ** (1 - m)) / (1 - m) + delta * (0.1 + 0.5 * m * delta / p) * 0.1 ** (-1 - m)
          : p * (1 - (1 - v / p) ** (1 - m)) / (1 - m);
        const capacitance = delta > 0
          ? (0.1 + m * delta / p) * 0.1 ** (-1 - m)
          : (1 - v / p) ** -m;
        expect(c[from][from] / 1e-12).toBeCloseTo(capacitance, 12);
        expect((c[from][from] * v - b[from]) / 1e-12).toBeCloseTo(q, 12);
        expect(c[from][to]).toBe(-c[from][from]);
      });
    }
  }

  it('matches ngspice-47 non-default OP/DC/AC at 75 C within 0.1% peak-normalized error', async () => {
    const result = await simulate(deck);
    const dc = [
      [1.971903959187987, -0.1999999997828096, -2.961916519042972e-7],
      [1.852711191699312, -0.1999999997947288, -1.568071897132083e-6],
      [1.232865387726782, -0.1999999998567134, -8.301377200899158e-6],
    ];
    const ac = [
      [[-4.867542712859521, 0.2023938375161094], [-0.0003824620099445829, -0.008751197375454047], [-0.0000562580306038285, -0.0001266124632633907]],
      [[-4.195434539607401, 1.764034607590766], [-0.03330602275723128, -0.07473886897274461], [-0.0004001464748633055, -0.001133559666813877]],
      [[0.02831061356723341, 1.326791880605732], [-0.229976037705297, 0.05339744090950908], [-0.002663719875075188, -0.003005280517046886]],
    ];
    const errors: number[] = [];
    for (const [column, node] of ['c', 's', 'vb'].entries()) {
      const current = node === 'vb';
      const sweep = current ? result.dcSweep!.current(node) : result.dcSweep!.voltage(node);
      const complex = current ? result.ac!.current(node) : result.ac!.voltage(node);
      const dcPeak = Math.max(current ? 1e-10 : 1e-4, ...dc.map(row => Math.abs(row[column])));
      const acPeak = Math.max(current ? 1e-10 : 1e-4, ...ac.map(row => Math.hypot(...row[column])));
      expect(sweep).toHaveLength(3);
      expect(complex).toHaveLength(3);
      dc.forEach((row, i) => errors.push(Math.abs(sweep[i] - row[column]) / dcPeak));
      ac.forEach((row, i) => {
        const phase = complex[i].phase * Math.PI / 180;
        errors.push(Math.hypot(complex[i].magnitude * Math.cos(phase) - row[column][0],
          complex[i].magnitude * Math.sin(phase) - row[column][1]) / acPeak);
      });
      const op = [1.852712168545907, -0.1999999997947288, -1.568071899019568e-6][column];
      errors.push(Math.abs((current ? result.dc!.current(node) : result.dc!.voltage(node)) - op) / dcPeak);
    }
    const max = Math.max(...errors);
    console.info(`VBIC junction ngspice-47 max normalized error: ${max}`);
    expect(max).toBeLessThan(0.001);
  });

  it('compiles the unchanged DFF deck without rewriting model parameters', () => {
    const original = readFileSync('../../benchmarks/corpus/corpus-f/fixtures/examples/vbic/DFF_Y_ECL.sp', 'utf8');
    expect(createHash('sha256').update(original).digest('hex')).toBe('d811ecfa0f370d281fb35729ca3177e738fe034621d9b2909765d9d70f527cc6');
    // Full 10 ns parity is measured separately; do not run it twice in unit tests.
    expect(() => parse(original).compile()).not.toThrow();
  });
});
