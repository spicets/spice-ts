import { InvalidCircuitError, UnsupportedModelParameterError, UnsupportedTemperatureError } from '../errors.js';
import type { ChargeIntegration, ChargeTruncation, DeviceModel, StampContext } from './device.js';
import { TransientChargeState } from './charge-state.js';

/**
 * Independently implemented from the EPFL EKV 2.6 equations (1999 report),
 * https://ngspice.sourceforge.io/external-documents/models/ekv_v262.pdf.
 * Xyce 7.10 is a behavioral reference for defaults and revision-III smoothing.
 * No GPL implementation is included. Intrinsic temperature scaling is supported;
 * explicit junction temperature laws remain outside this slice.
 */
interface Differential {
  value: number;
  gradient: readonly [number, number, number];
}
export interface EKVEvaluation {
  /** Physical current from drain to source, excluding the junctions. */
  current: number;
  /** Derivatives with respect to physical D, G, S, B voltages. */
  derivatives: readonly [number, number, number, number];
}

export interface EKVCharges {
  /** Physical terminal charges in D, G, S, B order (coulombs). */
  charges: readonly number[];
  /** Signed dQ(row)/dV(column), not the off-diagonal Cxy sign convention. */
  jacobian: readonly (readonly number[])[];
}

// Three independent bulk-referenced voltages. The fourth derivative follows
// from invariance under a common-mode translation of all terminal voltages.
const constant = (value: number): Differential => ({ value, gradient: [0, 0, 0] });
function variable(value: number, index: number): Differential {
  return { value, gradient: [index === 0 ? 1 : 0, index === 1 ? 1 : 0, index === 2 ? 1 : 0] };
}
function unary(a: Differential, value: number, slope: number): Differential {
  return { value, gradient: [a.gradient[0] * slope, a.gradient[1] * slope, a.gradient[2] * slope] };
}
function add(a: Differential, b: Differential): Differential {
  return { value: a.value + b.value,
    gradient: [a.gradient[0] + b.gradient[0], a.gradient[1] + b.gradient[1], a.gradient[2] + b.gradient[2]] };
}
function scale(a: Differential, factor: number): Differential { return unary(a, a.value * factor, factor); }
function sub(a: Differential, b: Differential): Differential { return add(a, scale(b, -1)); }
function mul(a: Differential, b: Differential): Differential {
  return { value: a.value * b.value, gradient: [
    a.gradient[0] * b.value + a.value * b.gradient[0],
    a.gradient[1] * b.value + a.value * b.gradient[1],
    a.gradient[2] * b.value + a.value * b.gradient[2],
  ] };
}
function div(a: Differential, b: Differential): Differential {
  return mul(a, unary(b, 1 / b.value, -1 / (b.value * b.value)));
}
function root(a: Differential): Differential {
  const value = Math.sqrt(a.value);
  return unary(a, value, 0.5 / value);
}
const square = (a: Differential): Differential => mul(a, a);
const offset = (a: Differential, value: number): Differential => add(a, constant(value));
const log = (a: Differential): Differential => unary(a, Math.log(a.value), 1 / a.value);
const abs = (a: Differential): Differential => scale(a, a.value < 0 ? -1 : 1);
/** Smooth positive part, with a strictly positive radicand. */
const positive = (a: Differential, smoothingSquared: number): Differential =>
  scale(add(a, root(offset(square(a), smoothingSquared))), 0.5);

/**
 * Equations 41-42: v = 2*y + log(y), F(v) = y*(1+y).
 * Newton on log(y) is positive by construction and safe in weak inversion.
 * Unlike Xyce's approximate explicit inversion, this solves the defining
 * equation. Its exact implicit derivative is dF/dv = y.
 */
function normalizedCurrent(v: Differential): Differential {
  let t = v.value > 1 ? Math.log(v.value / 2) : v.value;
  for (let iteration = 0; iteration < 16; iteration++) {
    const y = Math.exp(t);
    const step = (2 * y + t - v.value) / (2 * y + 1);
    t -= step;
    if (Math.abs(step) < 1e-14) break;
  }
  const y = Math.exp(t);
  // A floor is needed only for log(if) and sqrt(if) in deep-off operation.
  // Below exp(-140), it contributes less than 1e-60 to normalized current.
  const value = y * (1 + y);
  return value < 1e-60 ? constant(1e-60) : unary(v, value, y);
}

const DEFAULTS = {
  TNOM: 27, COX: 2e-3, XJ: 300e-9, VTO: 0.5, GAMMA: 0.7, PHI: 0.5,
  CGSO: 0, CGDO: 0, CGBO: 0,
  TCV: 1e-3, BEX: -1.5, UCEX: 0.8, IBBT: 9e-4,
  KP: 150e-6, THETA: 0, E0: 1e8, UCRIT: 2e6, LAMBDA: 0.8,
  DL: -0.01e-6, DW: -0.01e-6, WETA: 0.2, LETA: 0.3, Q0: 230e-6, LK: 0.4e-6,
  AVTO: 1e-6, AKP: 1e-6, AGAMMA: 1e-6, IBA: 5e8, IBB: 4e8, IBN: 1,
  L: 10e-6, W: 10e-6, M: 1, NS: 1, AS: 0, AD: 0, PS: 0, PD: 0, HDIF: 0.5e-6,
  XD_JS: 1e-9, XD_JSW: 1e-12, XD_JSWG: 1e-12, XD_N: 1,
} as const;
type Parameter = keyof typeof DEFAULTS;
type Parameters = Record<Parameter, number>;
/** Physical signed VTO, unsmoothed PHI and intrinsic parameters at device T. */
export type EKVTemperatureParameters = Readonly<Pick<Parameters, 'VTO' | 'KP' | 'UCRIT' | 'IBB' | 'PHI'> & { vt: number }>;
const DEFERRED = new Set([
  'KF', 'AF', 'NOISE',
  'XD_MJ', 'XD_MJSW', 'XD_MJSWG', 'XD_PB', 'XD_PBSW', 'XD_PBSWG',
  'XD_CJ', 'XD_CJSW', 'XD_CJSWG', 'XD_XJBV', 'XD_BV',
  'XD_NJTS', 'XD_NJTSSW', 'XD_NJTSSWG', 'XD_VTS', 'XD_VTSSW', 'XD_VTSSWG',
  'TP_XTI', 'TP_CJ', 'TP_CJSW', 'TP_CJSWG', 'TP_PB', 'TP_PBSW', 'TP_PBSWG',
  'TP_NJTS', 'TP_NJTSSW', 'TP_NJTSSWG',
]);

export class EKV26 implements DeviceModel {
  readonly branches: number[] = [];
  readonly isNonlinear = true;
  readonly storesCharge = true;
  readonly integratesTransientCharge = true;
  private readonly chargeState = new TransientChargeState(4);
  readonly modelWarnings: readonly string[];
  readonly params: Parameters;
  private readonly length: number;
  private readonly width: number;
  private vt: number;
  private phi: number;
  private readonly gamma: number;
  private threshold: number;
  private gainWidth: number;
  private readonly rsce: number;
  private temperature: number;
  private scaled: EKVTemperatureParameters;
  private junctionTemperatureParameter?: string;

  constructor(
    readonly name: string, readonly nodes: number[],
    model: Readonly<Record<string, number>>, instance: Readonly<Record<string, number>> = {},
    readonly polarity = 1, readonly modelName = name,
  ) {
    const warnings = [`${name}: EKV26 quasi-static intrinsic and overlap charges supported in transient and AC; junction charges, NQS and noise are not implemented. Default diffusion leakage stays at TNOM; explicit junction parameters require unsupported temperature laws off TNOM.`];
    // Section 5.2.1: physical PMOS VTO/TCV have the opposite sign.
    const values: Parameters = { ...DEFAULTS, TCV: polarity * DEFAULTS.TCV };
    for (const [key, value] of Object.entries({ ...model, ...instance })) {
      if (!Number.isFinite(value)) throw new InvalidCircuitError(`EKV26 '${name}': ${key} must be finite`);
      // Preserve nominal compatibility, but never silently freeze explicit
      // junction coefficients/geometry when a deck asks for nonnominal T.
      if (value !== 0 && (key.startsWith('TP_') || key.startsWith('XD_')
        || ['AD', 'AS', 'PD', 'PS', 'HDIF'].includes(key))) {
        this.junctionTemperatureParameter ??= key;
      }
      if (key === 'LEVEL') {
        if (value !== 260) this.unsupported(key, 'only LEVEL=260 is registered by Xyce 7.10');
      } else if (Object.hasOwn(DEFAULTS, key)) {
        values[key as Parameter] = value;
      } else if (DEFERRED.has(key)) {
        warnings.push(`${name}: EKV26 parameter ${key}=${value} ignored in nominal-temperature static DC slice.`);
      } else if (['RSH', 'XD_GMIN'].includes(key) && value === 0) {
        // Explicit zero is exactly the supported no-series-resistance/no-extra-gmin case.
      } else {
        this.unsupported(key, 'not supported by the nominal-temperature EKV26 static slice');
      }
    }
    this.params = values;
    if (!(values.TNOM > -273.15)) throw new InvalidCircuitError(`EKV26 '${name}': invalid TNOM`);
    for (const key of ['COX', 'XJ', 'PHI', 'UCRIT', 'IBB', 'XD_N', 'L', 'W', 'M', 'NS'] as const) {
      if (!(values[key] > 0)) throw new InvalidCircuitError(`EKV26 '${name}': ${key} must be positive`);
    }
    for (const key of ['GAMMA', 'KP', 'THETA', 'E0', 'LAMBDA', 'Q0', 'LK', 'LETA', 'WETA',
      'IBA', 'IBN', 'HDIF', 'AD', 'AS', 'PD', 'PS', 'XD_JS', 'XD_JSW', 'XD_JSWG', 'CGSO', 'CGDO', 'CGBO'] as const) {
      if (values[key] < 0) throw new InvalidCircuitError(`EKV26 '${name}': ${key} must be nonnegative`);
    }
    if (values.NS !== 1) this.unsupported('NS', 'multiple series devices are outside this Xyce-validated slice');
    if (polarity !== 1 && polarity !== -1) throw new InvalidCircuitError(`EKV26 '${name}': invalid polarity`);
    this.length = values.L + values.DL;
    this.width = values.W + values.DW;
    if (!(this.length > 0 && this.width > 0)) throw new InvalidCircuitError(`EKV26 '${name}': L+DL and W+DW must be positive`);
    if (values.Q0 > 0 && !(values.LK > 0)) throw new InvalidCircuitError(`EKV26 '${name}': LK must be positive with Q0`);
    this.vt = 8.617333262145e-5 * (values.TNOM + 273.15);
    this.temperature = values.TNOM;
    this.scaled = { VTO: values.VTO, KP: values.KP, UCRIT: values.UCRIT, IBB: values.IBB, PHI: values.PHI, vt: this.vt };
    // Xyce revision-III smoothing of PHI at 0.2 V is active even at TNOM.
    this.phi = 0.2 + 0.5 * (values.PHI - 0.2 + Math.hypot(values.PHI - 0.2, this.vt));
    // Xyce uses deviations from a 1um sentinel for deterministic matching
    // parameters. EPFL section 5.5 describes the area law, not this sentinel.
    const inverseAreaRoot = 1 / Math.sqrt(this.length * this.width);
    this.threshold = polarity * (values.VTO + (values.AVTO - 1e-6) * inverseAreaRoot);
    this.gamma = values.GAMMA + (values.AGAMMA - 1e-6) * inverseAreaRoot;
    this.gainWidth = values.KP * this.width * (1 + (values.AKP - 1e-6) * inverseAreaRoot) * values.M;
    if (this.gamma < 0 || this.gainWidth < 0) throw new InvalidCircuitError(`EKV26 '${name}': matching parameters yield negative GAMMA/KP`);
    const xi = values.Q0 === 0 ? 0 : 0.28 * (this.length / values.LK - 0.1);
    this.rsce = values.Q0 === 0 ? 0 : 2 * values.Q0 / values.COX / (1 + 0.5 * (xi + Math.hypot(xi, Math.sqrt(1.936e-3)))) ** 2;
    if (values.THETA !== 0 && values.E0 !== 0) {
      warnings.push(`${name}: EKV26 THETA=${values.THETA} ignored while E0=${values.E0} selects charge-based mobility; set E0=0 for THETA mobility, as in Xyce 7.10.`);
    }
    warnings.push(`${name}: EKV26 impact ionization (IBA=${values.IBA}, IBB=${values.IBB}, IBN=${values.IBN}) ignored in static slice; drain-to-bulk substrate current is not implemented.`);
    this.modelWarnings = warnings;
  }

  private unsupported(parameter: string, reason: string): never {
    throw new UnsupportedModelParameterError(this.name, parameter, reason, { modelName: this.modelName, model: 'EKV26' });
  }

  setTemperature(temperature: number): void {
    if (!Number.isFinite(temperature) || temperature <= -273.15) {
      throw new InvalidCircuitError(`EKV26 '${this.name}': invalid temperature`);
    }
    const p = this.params;
    if (temperature !== p.TNOM && this.junctionTemperatureParameter) {
      throw new UnsupportedTemperatureError(this.name, temperature, this.junctionTemperatureParameter);
    }
    const kelvin = temperature + 273.15;
    const nominalKelvin = p.TNOM + 273.15;
    const delta = temperature - p.TNOM;
    const ratio = kelvin / nominalKelvin;
    // EPFL eq. 7; retain the existing thermal constant for bit-identical TNOM.
    const vt = 8.617333262145e-5 * kelvin;
    const eg = (t: number): number => 1.16 - 0.000702 * t * t / (t + 1108); // Eq. 8.
    const scaled: EKVTemperatureParameters = temperature === p.TNOM
      ? { VTO: p.VTO, KP: p.KP, UCRIT: p.UCRIT, IBB: p.IBB, PHI: p.PHI, vt }
      : {
        VTO: p.VTO - p.TCV * delta, // Eq. 17, physical signed VTO/TCV.
        KP: p.KP * ratio ** p.BEX, // Eq. 18.
        UCRIT: p.UCRIT * ratio ** p.UCEX, // Eq. 19.
        PHI: p.PHI * ratio - 3 * vt * Math.log(ratio) - eg(nominalKelvin) * ratio + eg(kelvin), // Eq. 20.
        IBB: p.IBB * (1 + p.IBBT * delta), // Eq. 21; substrate current remains unsupported.
        vt,
      };
    if (Object.values(scaled).some(value => !Number.isFinite(value))
      || scaled.KP < 0 || scaled.UCRIT <= 0 || scaled.IBB <= 0) {
      throw new InvalidCircuitError(`EKV26 '${this.name}': invalid temperature-scaled intrinsic parameters`);
    }
    const inverseAreaRoot = 1 / Math.sqrt(this.length * this.width);
    this.threshold = this.polarity * (scaled.VTO + (p.AVTO - 1e-6) * inverseAreaRoot);
    this.gainWidth = scaled.KP * this.width * (1 + (p.AKP - 1e-6) * inverseAreaRoot) * p.M;
    this.phi = 0.2 + 0.5 * (scaled.PHI - 0.2 + Math.hypot(scaled.PHI - 0.2, vt));
    this.vt = vt;
    this.scaled = scaled;
    this.temperature = temperature;
  }

  getTemperature(): number {
    return this.temperature;
  }

  get temperatureParameters(): EKVTemperatureParameters {
    return { ...this.scaled };
  }

  evaluate(voltages: readonly [number, number, number, number]): EKVEvaluation {
    return this.evaluateModel(voltages);
  }

  evaluateCharges(voltages: readonly [number, number, number, number]): EKVCharges {
    const charges: Differential[] = [];
    this.evaluateModel(voltages, charges);
    return {
      charges: charges.map(q => this.polarity * q.value),
      jacobian: charges.map(q => [...q.gradient, -q.gradient[0] - q.gradient[1] - q.gradient[2]]),
    };
  }

  private evaluateModel(voltages: readonly [number, number, number, number], charges?: Differential[]): EKVEvaluation {
    const p = this.params;
    const [d, g, s, b] = voltages;
    let drain = variable(this.polarity * (d - b), 0);
    const gate = variable(this.polarity * (g - b), 1);
    let source = variable(this.polarity * (s - b), 2);
    const reverse = drain.value < source.value;
    if (reverse) [drain, source] = [source, drain];
    const vt = this.vt;
    const epsSi = 11.7 * 8.8541878128e-12;
    const depletionLength = Math.sqrt(epsSi / p.COX * p.XJ);
    const criticalVoltage = this.scaled.UCRIT * this.length;

    // Equations 33-38 with revision-III smooth gate voltage and charge sharing.
    const unsmoothedGate = offset(gate, -this.threshold - this.rsce + this.phi + this.gamma * Math.sqrt(this.phi));
    const effectiveGate = positive(unsmoothedGate, 32 * vt * vt);
    const pinch = (gamma: Differential): Differential => sub(offset(effectiveGate, -this.phi),
      mul(gamma, sub(root(add(effectiveGate, scale(square(gamma), 0.25))), scale(gamma, 0.5))));
    const longPinch = pinch(constant(this.gamma));
    const bulkRoots = add(root(positive(offset(source, this.phi), 16 * vt * vt)),
      root(positive(offset(drain, this.phi), 16 * vt * vt)));
    const effectiveGamma = positive(add(offset(scale(bulkRoots, -epsSi / p.COX * p.LETA / this.length), this.gamma),
      scale(root(offset(longPinch, this.phi + 0.1 * vt)), 3 * epsSi / p.COX * p.WETA * p.M / this.width)), 0.1 * vt);
    const vp = pinch(effectiveGamma);
    const forward = normalizedCurrent(scale(sub(vp, source), 1 / vt));
    if (charges) {
      // EPFL EKV 2.6 section 6.1, equations 69-78. Section 5.17.2 uses
      // the long-channel reverse current for charges, not transport ir.
      const f = root(offset(forward, 0.25));
      const r = root(offset(normalizedCurrent(scale(sub(vp, drain), 1 / vt)), 0.25));
      const bodyRoot = root(offset(vp, this.phi + 1e-6));
      const nq = offset(div(constant(this.gamma), scale(bodyRoot, 2)), 1);
      const partition = (a: Differential, z: Differential): Differential => {
        const polynomial = add(add(scale(mul(square(a), a), 3), scale(mul(square(a), z), 6)),
          add(scale(mul(a, square(z)), 4), scale(mul(square(z), z), 2)));
        return scale(mul(nq, offset(scale(div(polynomial, square(add(a, z))), 4 / 15), -0.5)), -vt);
      };
      let qd = partition(r, f);
      let qs = partition(f, r);
      const qi = add(qd, qs);
      // Eq.75 uses the unsmoothed V_G' to select accumulation. Charges
      // here are already multiplied by Vt (eq.78), so qB=-V_G'/Vt
      // becomes -V_G'. Keep the smoothed gate in the static current path.
      const qb = unsmoothedGate.value <= 0 ? scale(unsmoothedGate, -1)
        : sub(scale(bodyRoot, -this.gamma), mul(div(offset(nq, -1), nq), qi));
      if (reverse) [qd, qs] = [qs, qd];
      const area = p.COX * this.width * this.length * p.M;
      const physical = [scale(qd, area), scale(add(qi, qb), -area), scale(qs, area), scale(qb, area)];
      // Linear overlap capacitances per width (G-S/G-D), per length (G-B).
      const original = [variable(this.polarity * (d - b), 0), gate, variable(this.polarity * (s - b), 2), constant(0)];
      for (const [terminal, capacitance] of [[0, p.CGDO * this.width * p.M], [2, p.CGSO * this.width * p.M], [3, p.CGBO * this.length * p.M]]) {
        const overlap = scale(sub(gate, original[terminal]), capacitance);
        physical[1] = add(physical[1], overlap);
        physical[terminal] = sub(physical[terminal], overlap);
      }
      charges.push(...physical);
    }
    const sqrtForward = root(forward);

    // Equations 45-56. Vds and the saturation voltage are half voltages here.
    const saturation = scale(offset(root(offset(scale(sqrtForward, vt / criticalVoltage), 0.25)), -0.5), criticalVoltage);
    const halfDrain = scale(sub(drain, source), 0.5);
    const smoothing = scale(offset(scale(sub(sqrtForward, scale(saturation, 1 / vt)), p.LAMBDA), 1 / 64), 16 * vt * vt);
    const intermediate = sub(root(add(square(saturation), smoothing)), root(add(square(sub(halfDrain, saturation)), smoothing)));
    const reverseSaturation = offset(scale(offset(root(offset(scale(sub(sqrtForward, scale(log(forward), 0.75)), vt / criticalVoltage), 0.25)), -0.5), criticalVoltage),
      vt * (Math.log(criticalVoltage / (2 * vt)) - 0.6));
    const reverseArgument = add(sub(sub(vp, halfDrain), source), sub(
      root(add(square(sub(halfDrain, reverseSaturation)), smoothing)), root(add(square(reverseSaturation), smoothing))));
    const backward = normalizedCurrent(scale(reverseArgument, 1 / vt));
    const lengthLoss = scale(log(offset(scale(sub(halfDrain, intermediate), 1 / (depletionLength * this.scaled.UCRIT)), 1)), p.LAMBDA * depletionLength);
    const equivalentLength = positive(add(offset(scale(add(halfDrain, intermediate), 1 / this.scaled.UCRIT), this.length), scale(lengthLoss, -1)), (0.1 * this.length) ** 2);
    let beta = div(constant(this.gainWidth), equivalentLength);

    // Equations 59-64, 69-78. E0=0 selects the THETA mobility option.
    if (p.E0 === 0) {
      beta = div(beta, offset(scale(positive(vp, 2 * vt * vt), p.THETA), 1));
    } else {
      const reverseChargeCurrent = normalizedCurrent(scale(sub(vp, drain), 1 / vt));
      const f = root(offset(forward, 0.25));
      const r = root(offset(reverseChargeCurrent, 0.25));
      const chargeSlope = div(constant(this.gamma), scale(root(offset(vp, this.phi + 1e-6)), 2));
      const inversionCharge = scale(mul(offset(chargeSlope, 1), offset(scale(div(add(add(square(f), mul(f, r)), square(r)), add(f, r)), 4 / 3), -1)), -vt);
      const depletionCharge = sub(scale(root(offset(vp, this.phi + 1e-6)), -this.gamma),
        mul(div(chargeSlope, offset(chargeSlope, 1)), inversionCharge));
      const fieldFactor = p.COX / (epsSi * p.E0);
      beta = div(scale(beta, 1 + fieldFactor * this.gamma * Math.sqrt(this.phi)),
        offset(scale(abs(add(depletionCharge, scale(inversionCharge, this.polarity > 0 ? 0.5 : 1 / 3))), fieldFactor), 1));
    }
    const slope = offset(div(constant(this.gamma), scale(root(offset(vp, this.phi + 4 * vt)), 2)), 1);
    const current = scale(mul(mul(beta, slope), sub(forward, backward)), 2 * vt * vt * (reverse ? -1 : 1));
    const [dd, dg, ds] = current.gradient;
    return { current: this.polarity * current.value, derivatives: [dd, dg, ds, -dd - dg - ds] };
  }

  stamp(ctx: StampContext): void {
    const [d, g, s, b] = this.nodes;
    const voltages = [d, g, s, b].map(n => n >= 0 ? ctx.getVoltage(n) : 0) as [number, number, number, number];
    const result = this.evaluate(voltages);
    let companion = result.current;
    for (let terminal = 0; terminal < 4; terminal++) {
      const conductance = result.derivatives[terminal];
      companion -= conductance * voltages[terminal];
      if (this.nodes[terminal] >= 0) {
        if (d >= 0) ctx.stampG(d, this.nodes[terminal], conductance);
        if (s >= 0) ctx.stampG(s, this.nodes[terminal], -conductance);
      }
    }
    if (d >= 0) ctx.stampB(d, -companion);
    if (s >= 0) ctx.stampB(s, companion);
    // Small nominal-temperature diffusion leakage. Breakdown/tunneling are
    // explicitly deferred above, never replaced with a MOS1 diode model.
    // This compatibility leakage is not a junction temperature model. Keep its
    // complete nominal law unchanged; explicit junction cards reject off TNOM.
    const junctionVt = 8.617333262145e-5 * (this.params.TNOM + 273.15);
    for (const [terminal, area, perimeter] of [[d, this.params.AD, this.params.PD], [s, this.params.AS, this.params.PS]]) {
      const a = area || 2 * this.params.HDIF * this.width;
      const perimeterValue = perimeter || 4 * this.params.HDIF + this.width;
      const saturation = this.params.M * (a * this.params.XD_JS + perimeterValue * this.params.XD_JSW + this.width * this.params.XD_JSWG);
      const voltage = this.polarity * ((terminal >= 0 ? ctx.getVoltage(terminal) : 0) - voltages[3]);
      const argument = Math.max(-40, Math.min(709, -voltage / (junctionVt * this.params.XD_N)));
      const exponential = Math.exp(argument);
      const current = this.polarity * saturation * (1 - exponential);
      const conductance = argument > -40 && argument < 709 ? saturation * exponential / (junctionVt * this.params.XD_N) : 0;
      const rhs = current - conductance * this.polarity * voltage;
      for (const [row, sign] of [[terminal, 1], [b, -1]]) {
        if (row < 0) continue;
        if (terminal >= 0) ctx.stampG(row, terminal, sign * conductance);
        if (b >= 0) ctx.stampG(row, b, -sign * conductance);
        ctx.stampB(row, -sign * rhs);
      }
    }
  }

  limitNewtonStep(previous: Float64Array, candidate: Float64Array): number {
    let largest = 0;
    for (const node of this.nodes) if (node >= 0) largest = Math.max(largest, Math.abs(candidate[node] - previous[node]));
    return largest > 0.5 ? 0.5 / largest : 1;
  }

  private chargesAt(ctx: StampContext): EKVCharges {
    return this.evaluateCharges(this.nodes.map(n => n < 0 ? 0 : ctx.getVoltage(n)) as [number, number, number, number]);
  }

  /** Signed charge Jacobian. The AC assembler forms G + j*omega*C. */
  stampDynamic(ctx: StampContext): void {
    const { jacobian } = this.chargesAt(ctx);
    for (let row = 0; row < 4; row++) {
      const node = this.nodes[row];
      if (node < 0) continue;
      for (let col = 0; col < 4; col++) {
        const control = this.nodes[col];
        if (control >= 0) ctx.stampC(node, control, jacobian[row][col]);
      }
    }
  }

  stampAC(ctx: StampContext, _omega: number): void {
    this.stampDynamic(ctx);
  }

  stampTransientCharge(ctx: StampContext, integration: ChargeIntegration): void {
    const result = this.chargesAt(ctx);
    this.chargeState.begin(integration);
    for (let row = 0; row < 4; row++) {
      const node = this.nodes[row];
      if (node < 0) continue;
      let equivalent = this.chargeState.current(row, result.charges[row]);
      for (let col = 0; col < 4; col++) {
        const control = this.nodes[col];
        if (control < 0) continue;
        const g = this.chargeState.factor * result.jacobian[row][col];
        ctx.stampG(node, control, g);
        equivalent -= g * ctx.getVoltage(control);
      }
      ctx.stampB(node, -equivalent);
    }
  }

  stampAcceptedChargeCurrent(ctx: StampContext): void {
    this.nodes.forEach((node, row) => {
      if (node >= 0) ctx.stampB(node, -this.chargeState.acceptedChargeCurrent(row));
    });
  }

  acceptTransientStep(ctx: StampContext): void {
    this.chargesAt(ctx).charges.forEach((q, row) => this.chargeState.accept(row, q));
    this.chargeState.commit();
  }

  truncateTimestep(ctx: StampContext, truncation: ChargeTruncation): number {
    return this.chargeState.truncationTimestep(truncation, () => this.acceptTransientStep(ctx));
  }

  resetTransient(): void {
    this.chargeState.reset();
  }
}
