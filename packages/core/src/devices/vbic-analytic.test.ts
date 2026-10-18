import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { resolveVBICParams } from './vbic.js';
import { resolveVBICTemperature } from './vbic-temperature.js';

// Keep the pre-analytic depletion evaluator as a test-only Dual oracle. Compile
// it in the complete evaluator so every residual/charge/noise derivative is
// compared, not just the local slope. No oracle code enters the runtime bundle.
const dualDepletion = `function depletionCharge(voltage: Dual, potential: number, grading: number, fc: number): Dual {
  const workspace = voltage.workspace;
  const delta = voltage.value - potential * fc;
  if (delta > 0) {
    const pw = Math.pow(1 - fc, -1 - grading);
    const constant = potential * (1 - pw * (1 - fc) * (1 - fc)) / (1 - grading);
    return add(c(constant, workspace), scale(
      mul(
        sub(voltage, c(potential * fc, workspace)),
        add(c(1 - fc, workspace), scale(sub(voltage, c(potential * fc, workspace)), 0.5 * grading / potential)),
      ), pw,
    ));
  }
  return scale(
    sub(c(1, workspace), pow(sub(c(1, workspace), scale(voltage, 1 / potential)), 1 - grading)),
    potential / (1 - grading),
  );
}
`;
// Exact pre-round-11 helper, including the N-wide Dual chain rule.
const dualDiode = `function diode(voltage: Dual, current: number, ideality: number, vt: number): Dual {
  const inverse = 1 / (ideality * vt);
  const argument = voltage.value * inverse;
  const limited = Math.min(80, Math.max(-80, argument));
  const exponential = Math.exp(limited);
  const slope = argument === limited ? exponential : 0;
  const result = voltage.workspace.take(0);
  const derivative = result.derivative;
  for (let i = 0; i < derivative.length; i++) {
    derivative[i] = ((voltage.derivative[i] * inverse) * slope - 0) * current;
  }
  result.value = (exponential - 1) * current;
  return result;
}
`;
interface Quantity { value: number; derivative: Float64Array }
interface Result { residual: Quantity[]; charge: Quantity[]; noise: Record<string, Quantity> }
interface Workspace { reset(): void }
interface Evaluator {
  DualWorkspace: new (size: number) => Workspace;
  evaluate: (v: number[], p: ReturnType<typeof resolveVBICParams>, t: ReturnType<typeof resolveVBICTemperature>, scale: number, gmin: number, w: Workspace) => Result;
}
const source = readFileSync(new URL('./vbic.ts', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('class Dual {'), source.indexOf('/** Number of device nodes:'));
function compile(oracle?: 'depletion' | 'diode'): Evaluator {
  const text = oracle === 'depletion'
    ? body.replace(/function depletionCharge\([\s\S]*?(?=\/\*\* Per local node;)/, dualDepletion + '\n')
    : oracle === 'diode' ? body.replace(/function diode\([\s\S]*?(?=\/\/ ngspice-47 vbicload.c:2238)/, dualDiode + '\n') : body;
  if (oracle && text === body) throw new Error(`Dual oracle substitution did not match ${oracle}`);
  const js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function(js + '\nreturn { evaluate, DualWorkspace };')() as Evaluator;
}
const analytic = compile();

describe.each(['depletion', 'diode'] as const)('VBIC analytic %s in the complete Dual evaluator', slice => {
  const oracle = compile(slice);
  it('matches every value and derivative, including junction boundaries and inactive branches', () => {
    let seed = 1310;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    let worst = 0;
    let worstAbsolute = 0;
    let comparisons = 0;
    for (const polarity of [1, -1]) for (const temperature of [-40, 27, 125]) for (const rich of [false, true]) for (const grading of [0, 0.33, 0.95]) {
      const p = resolveVBICParams({ ...(rich ? {
        TD: 2e-12, RTH: 100, CJE: 1e-12, CJC: 2e-12, CJEP: 3e-12, CJCP: 4e-12,
        TF: 2e-12, TR: 3e-12, ITF: 0.01, XTF: 2, VTF: 1.2,
        ISP: 1e-16, IBEIP: 1e-18, IBENP: 2e-19, IBCIP: 3e-18, IBCNP: 4e-19,
        WBE: 0.4, WSP: 0.3, VER: 20, VEF: 50, IKF: 0.01, IKR: 0.02, IKP: 0.03,
        GAMM: 0.01, VO: 2, AVC1: 0.1, AVC2: 5, QCO: 1e-13,
      } : {}), ME: grading, MC: grading, MS: grading, FC: grading === 0 ? 0 : grading === 0.95 ? 0.99 : 0.9 }, polarity);
      const t = resolveVBICTemperature(p, temperature);
      const size = p.TD > 0 ? 11 : 9;
      const wa = new analytic.DualWorkspace(size), wo = new oracle.DualWorkspace(size);
      const edges = [-3, -0.7, -1e-15, -0, 0, 1e-15, 0.65, 0.85, 2.5,
        ...[t.PE, t.PC, t.PS].flatMap(potential => [-1e-15, 0, 1e-15].map(e => potential * p.FC + e)),
        // Exact clamp endpoints and both neighboring sides for each ideality.
        ...[p.NF, p.NR, p.NEI, p.NEN, p.NCI, p.NCN, p.NCIP, p.NCNP, p.NFP].flatMap(n =>
          [-80, 80].flatMap(limit => [-1e-12, 0, 1e-12].map(e => (limit + e) * n * t.vt)))];
      for (let point = 0; point < 300; point++) {
        const v = Array.from({ length: size }, () => point < edges.length ? edges[point] : -1.5 + random() * 2.5);
        // Both are evaluated in normalized junction-voltage coordinates, exactly
        // as VBIC does after the NPN/PNP transformation and junction limiting.
        const a = analytic.evaluate(v, p, t, 2, 1e-12, wa);
        const o = oracle.evaluate(v, p, t, 2, 1e-12, wo);
        const aq = [...a.residual, ...a.charge, ...Object.values(a.noise)];
        const oq = [...o.residual, ...o.charge, ...Object.values(o.noise)];
        for (let i = 0; i < aq.length; i++) {
          const av = [aq[i].value, ...aq[i].derivative], ov = [oq[i].value, ...oq[i].derivative];
          for (let j = 0; j < av.length; j++) {
            if (!Number.isFinite(av[j])) throw new Error(`Nonfinite value at ${point}/${i}/${j}`);
            const absolute = Math.abs(av[j] - ov[j]);
            const error = absolute / Math.max(1e-30, Math.abs(ov[j]));
            worstAbsolute = Math.max(worstAbsolute, absolute);
            worst = Math.max(worst, error);
            if (error > 1e-12) throw new Error(`Oracle error ${error} at ${point}/${i}/${j}`);
            comparisons++;
          }
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(1e-12);
    console.log(JSON.stringify({ slice, vbicOracleComparisons: comparisons, worstRelativeError: worst, worstAbsoluteError: worstAbsolute, absoluteFloor: 1e-42 }));
  });
});
