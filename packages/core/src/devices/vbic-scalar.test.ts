import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { resolveVBICParams } from './vbic.js';
import { resolveVBICTemperature } from './vbic-temperature.js';
import { evaluateScalar, ScalarWorkspace } from './vbic-scalar.js';

interface Quantity { value: number; derivative: Float64Array }
interface Result { residual: Quantity[]; charge: Quantity[]; noise: Record<string, Quantity> }
interface Oracle {
  DualWorkspace: new (size: number) => object;
  evaluate(v: number[], p: ReturnType<typeof resolveVBICParams>, t: ReturnType<typeof resolveVBICTemperature>, scale: number, gmin: number, w: object): Result;
}
// Compile the unmodified production Dual evaluator, not a copied scalar formula.
const source = readFileSync(new URL('./vbic.ts', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('class Dual {'), source.indexOf('/** Number of device nodes:'));
const compiled = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const oracle = new Function(compiled + '\nreturn { evaluate, DualWorkspace };')() as Oracle;
const deck = readFileSync(new URL('../../../../benchmarks/corpus/corpus-f/fixtures/examples/vbic/DFF_Y_ECL.sp', import.meta.url), 'utf8');
const card = deck.slice(deck.indexOf('.MODEL')).split('\n').filter((line, i) => i === 0 || line.startsWith('+')).join(' ');
const dff = Object.fromEntries([...card.matchAll(/(\w+)\s*=\s*([\d.Ee+-]+)/g)].map(m => [m[1], Number(m[2])]));

describe('scalar VBIC full Jacobian oracle', () => {
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('retains the bounded HRCF domain for %s', HRCF => {
    expect(() => resolveVBICParams({ HRCF }, 1)).toThrow("Invalid bounded VBIC DC model parameter: 'HRCF'");
  });
  it.each([{ VO: 2, HRCF: 0 }, { VO: 0, HRCF: 2 }, { VO: 0, HRCF: 0 }])(
    'uses ngspice zero inverses in quasi-saturation ($VO, $HRCF)', supplied => {
      const p = resolveVBICParams({ ...supplied, RCI: 2, GAMM: 0.01 }, 1);
      const t = resolveVBICTemperature(p, 27);
      const v = [0.7, 0.7, 0.02, -0.03, 0, 0, 0.4, 0, 0];
      // ngspice-47 a80f6e3e vbicload.c:2210-2222,3722-3733.
      const vt = t.vt;
      const kbci = Math.sqrt(1 + t.GAMM * Math.exp(v[2] / vt));
      const kbcx = Math.sqrt(1 + t.GAMM * Math.exp(v[3] / vt));
      const iohm = (v[6] + vt * (kbci - kbcx - Math.log((kbci + 1) / (kbcx + 1)))) / t.RCI;
      const ivo = supplied.VO > 0 ? 1 / supplied.VO : 0;
      const ihrcf = supplied.HRCF > 0 ? 1 / supplied.HRCF : 0;
      const derf = ivo * t.RCI * iohm / (1 + 0.5 * ivo * ihrcf * Math.sqrt(v[6] ** 2 + 0.01));
      const expected = iohm / Math.sqrt(1 + derf ** 2);
      const scalar = evaluateScalar(v, p, t, 1, 0, new ScalarWorkspace());
      const dual = oracle.evaluate(v, p, t, 1, 0, new oracle.DualWorkspace(9));
      expect(scalar.noise.irci.value).toBeCloseTo(expected, 14);
      expect(dual.noise.irci.value).toBeCloseTo(expected, 14);
      for (let col = 0; col < 9; col++) {
        const plus = [...v], minus = [...v];
        plus[col] += 1e-6;
        minus[col] -= 1e-6;
        const upper = evaluateScalar(plus, p, t, 1, 0, new ScalarWorkspace()).noise.irci.value;
        const lower = evaluateScalar(minus, p, t, 1, 0, new ScalarWorkspace()).noise.irci.value;
        expect(scalar.noise.irci.derivative[col]).toBeCloseTo((upper - lower) / 2e-6, 8);
        expect(dual.noise.irci.derivative[col]).toBeCloseTo(scalar.noise.irci.derivative[col], 14);
      }
    },
  );

  it('matches Dual for every residual, charge and noise value and branch partial', () => {
    let seed = 131013;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const rich = {
      CJE: 1e-12, CJC: 2e-12, CJEP: 3e-12, CJCP: 4e-12, TF: 2e-12, TR: 3e-12,
      ITF: 0.01, XTF: 2, VTF: 1.2, ISP: 1e-16, IBEIP: 1e-18, IBENP: 2e-19,
      IBCIP: 3e-18, IBCNP: 4e-19, WBE: 0.4, WSP: 0.3, VER: 20, VEF: 50,
      IKF: 1e-6, IKR: 2e-6, IKP: 3e-6, GAMM: 0.01, VO: 2, AVC1: 0.1, AVC2: 5, QCO: 1e-13,
    };
    let points = 0, comparisons = 0, worstAbsoluteError = 0, worstRelativeError = 0;
    for (const polarity of [1, -1]) for (const temperature of [-40, 27, 125]) {
      for (const supplied of [{}, rich, { ...rich, HRCF: 0 }, { ...rich, VO: 0, HRCF: 0 }, { ...rich, WSP: 0, FC: 0.99, ME: 0.95, MC: 0.95, MS: 0.95 }, dff]) {
        const p = resolveVBICParams(supplied, polarity);
        const t = resolveVBICTemperature(p, temperature);
        const w = new ScalarWorkspace(), ow = new oracle.DualWorkspace(9);
        const edges = [-20, -3, -0.7, -1e-15, -0, 0, 1e-15, 0.65, 0.85, 1.4, 2.5,
          ...[t.PE, t.PC, t.PS].flatMap(potential => [-1e-15, 0, 1e-15].map(e => potential * p.FC + e))];
        for (let point = 0; point < 400; point++) {
          // Already polarity-normalized, as in the device's junction limiter.
          const v = Array.from({ length: 9 }, () => point < edges.length ? edges[point] : -3 + random() * 4.4);
          const scale = point % 2 ? 1 : 2;
          const gmin = point % 3 ? 1e-12 : 0;
          const actual = evaluateScalar(v, p, t, scale, gmin, w);
          const expected = oracle.evaluate(v, p, t, scale, gmin, ow);
          const aq = [...actual.residual, ...actual.charge, ...Object.values(actual.noise)];
          const eq = [...expected.residual, ...expected.charge, ...Object.values(expected.noise)];
          expect(aq.length).toBe(eq.length);
          for (let row = 0; row < aq.length; row++) {
            const av = [aq[row].value, ...aq[row].derivative];
            const ev = [eq[row].value, ...eq[row].derivative];
            for (let col = 0; col < av.length; col++) {
              const abs = Math.abs(av[col] - ev[col]);
              const rel = abs / Math.max(Math.abs(ev[col]), 1e-42);
              if (!Number.isFinite(av[col]) || !Number.isFinite(ev[col]) || abs > Math.max(1e-42, Math.abs(ev[col]) * 1e-12)) {
                throw new Error(JSON.stringify({ polarity, temperature, point, row, col, actual: av[col], expected: ev[col], abs, rel, v, supplied }));
              }
              worstAbsoluteError = Math.max(worstAbsoluteError, abs);
              worstRelativeError = Math.max(worstRelativeError, rel);
              comparisons++;
            }
          }
          points++;
        }
      }
    }
    console.log(JSON.stringify({ points, comparisons, worstAbsoluteError, worstRelativeError, tolerance: 1e-12, absoluteFloor: 1e-42 }));
  });

  it('reuses every output buffer across repeated calls', () => {
    const w = new ScalarWorkspace(), p = resolveVBICParams({}, 1), t = resolveVBICTemperature(p, 27);
    const v = Array<number>(9).fill(0);
    const a = evaluateScalar(v, p, t, 1, 0, w);
    const derivative = a.residual[0].derivative;
    v[0] = 0.7;
    expect(evaluateScalar(v, p, t, 1, 0, w)).toBe(a);
    expect(a.residual[0].derivative).toBe(derivative);
  });
});
