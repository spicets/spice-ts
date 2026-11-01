import type { ModelParams } from '../types.js';
import { UnsupportedModelParameterError } from '../errors.js';
import { DEVICE_GMIN } from './device.js';

export interface HFET1InstanceParams {
  L: number;
  W: number;
  TEMP?: number;
  DTEMP?: number;
  thermalVoltage?: number;
}

export interface HFET1Model {
  LEVEL: 5;
  RD: number;
  RS: number;
  /** Intrinsic drain/source resistances inside the channel equations (hfetload.c RDI/RSI). */
  RDI: number;
  RSI: number;
  M: number;
  LAMBDA: number;
  VS: number;
  MU: number;
  VTO: number;
  ETA: number;
  SIGMA0: number;
  VSIGMA: number;
  VSIGMAT: number;
  JS1S: number;
  JS1D: number;
  NMAX: number;
}

export interface HFET1Evaluation {
  drainCurrent: number;
  gm: number;
  gds: number;
  gateSourceCurrent: number;
  gateSourceConductance: number;
  gateDrainCurrent: number;
  gateDrainConductance: number;
  capGS: number;
  capGD: number;
}

const MODEL_PARAMETERS = new Set([
  'LEVEL', 'RD', 'RS', 'RDI', 'RSI', 'M', 'LAMBDA', 'VS', 'MU', 'VT0', 'VTO', 'ETA',
  'SIGMA0', 'VSIGMA', 'VSIGMAT', 'JS1S', 'JS1D', 'NMAX',
]);
const BOLTZMANN = 1.380649e-23;
const CHARGE = 1.602176634e-19;
const EPSILON = 12.244 * 8.85418e-12;
const TEMPERATURE = 300.15;
const THERMAL_VOLTAGE = BOLTZMANN * TEMPERATURE / CHARGE;

export function resolveHFET1Model(model: ModelParams): HFET1Model {
  if (model.type !== 'NHFET') throw new Error(`Unsupported Z-card model type: '${model.type}'`);
  const level = model.params.LEVEL ?? 1;
  if (level !== 5) throw new Error(`Unsupported NHFET model level: ${level}`);
  for (const name of Object.keys(model.params)) {
    if (!MODEL_PARAMETERS.has(name)) {
      throw new UnsupportedModelParameterError('', name,
        `Unsupported NHFET level-5 model parameter: '${name}'; hfettemp.c:71-73,89-91 temperature laws are not ported`,
        { modelName: model.name, model: 'HFET1' });
    }
  }
  if (model.params.VT0 !== undefined && model.params.VTO !== undefined) {
    throw new Error("NHFET level-5 model may specify only one of 'VT0' and 'VTO'");
  }
  const resolved: HFET1Model = {
    LEVEL: 5,
    RD: model.params.RD ?? 0,
    RS: model.params.RS ?? 0,
    RDI: model.params.RDI ?? 0,
    RSI: model.params.RSI ?? 0,
    M: model.params.M ?? 3,
    LAMBDA: model.params.LAMBDA ?? 0.15,
    VS: model.params.VS ?? 1.5e5,
    MU: model.params.MU ?? 0.4,
    VTO: model.params.VT0 ?? model.params.VTO ?? 0.15,
    ETA: model.params.ETA ?? 1.28,
    SIGMA0: model.params.SIGMA0 ?? 0.057,
    VSIGMA: model.params.VSIGMA ?? 0.1,
    VSIGMAT: model.params.VSIGMAT ?? 0.3,
    JS1S: model.params.JS1S ?? 1,
    JS1D: model.params.JS1D ?? 1,
    NMAX: model.params.NMAX ?? 2e16,
  };
  if (resolved.RD < 0 || resolved.RS < 0 || resolved.RDI < 0 || resolved.RSI < 0 || resolved.M <= 0
    || resolved.VS <= 0 || resolved.MU <= 0 || resolved.ETA <= 0
    || resolved.VSIGMA <= 0 || resolved.JS1S < 0 || resolved.JS1D < 0
    || resolved.NMAX <= 0) {
    throw new Error('Invalid NHFET level-5 model parameter value');
  }
  return resolved;
}

export function resolveHFET1Instance(params: Record<string, number> = {}): HFET1InstanceParams {
  for (const name of Object.keys(params)) {
    if (name !== 'L' && name !== 'W' && name !== 'TEMP' && name !== 'DTEMP') {
      throw new Error(`Unsupported NHFET level-5 instance parameter: '${name}'`);
    }
  }
  const instance = { L: params.L ?? 1e-6, W: params.W ?? 20e-6,
    TEMP: params.TEMP, DTEMP: params.DTEMP };
  if (instance.L <= 0 || instance.W <= 0) {
    throw new Error('NHFET level-5 instance L and W must be positive');
  }
  return instance;
}

interface IntrinsicResult {
  drainCurrent: number;
  capGS: number;
  capGD: number;
}

function intrinsic(vGS: number, vDS: number, model: HFET1Model, instance: HFET1InstanceParams): IntrinsicResult {
  if (vDS < 0) {
    // ngspice-47 hfetload.c negates vds for inverse operation and then calls
    // hfeta(..., vds>0 ? vgs : vgd, vds, ...). The condition is evaluated
    // after the negation, so the channel is still evaluated at the external
    // VGS (not VGD) with |VDS|. Reproduce that exactly: only the current sign
    // and the Cgs/Cgd assignment are mirrored.
    const reverse = intrinsic(vGS, -vDS, model, instance);
    return { drainCurrent: -reverse.drainCurrent, capGS: reverse.capGD, capGD: reverse.capGS };
  }

  const { L, W } = instance;
  const vt = instance.thermalVoltage ?? THERMAL_VOLTAGE;
  const di = 0.04e-6;
  const deltad = 4.5e-9;
  const delta = 3;
  const gamma = 3;
  const rsi = model.RSI;
  const rdi = model.RDI;
  const cf = 0.5 * EPSILON * W;
  const n0 = EPSILON * model.ETA * vt / (2 * CHARGE * (di + deltad));
  const gchi0 = CHARGE * W * model.MU / L;
  const imax = CHARGE * model.NMAX * model.VS * W;
  const vl = model.VS / model.MU * L;

  const vgt0 = vGS - model.VTO;
  const sigmaShape = Math.exp(Math.max(-80, Math.min(80, (vgt0 - model.VSIGMAT) / model.VSIGMA)));
  const sigma = model.SIGMA0 / (1 + sigmaShape);
  const vgt = vgt0 + sigma * vDS;
  const u = 0.5 * vgt / vt - 1;
  const t = Math.sqrt(delta * delta + u * u);
  const vgte = vt * (2 + u + t);
  const exponential = Math.exp(Math.max(-80, Math.min(80, vgt / (model.ETA * vt))));
  const nsm = 2 * n0 * Math.log1p(0.5 * exponential);
  if (nsm < 1e-38) return { drainCurrent: 0, capGS: cf, capGD: cf };

  const compression = (nsm / model.NMAX) ** gamma;
  const ns = nsm / (1 + compression) ** (1 / gamma);
  const gchi = gchi0 * ns;
  const gch = gchi / (1 + gchi * (rsi + rdi));
  const gchim = gchi0 * nsm;
  const h = Math.sqrt(1 + 2 * gchim * rsi + vgte * vgte / (vl * vl));
  const p = 1 + gchim * rsi + h;
  const isatm = gchim * vgte / p;
  const currentCompression = (isatm / imax) ** gamma;
  const isat = isatm / (1 + currentCompression) ** (1 / gamma);
  const vsate = isat / gch;
  const normalizedDrain = (vDS / vsate) ** model.M;
  const knee = (1 + normalizedDrain) ** (1 / model.M);
  const drainCurrent = gch * vDS * (1 + model.LAMBDA * vDS) / knee;

  const dnsmDvgt = n0 / (model.ETA * vt) / (1 / exponential + 0.5);
  const dnsDnsm = ns / nsm * (1 - compression / (1 + compression));

  const eta1 = 2;
  const d1 = 0.03e-6;
  const vt1 = model.VTO + CHARGE * model.NMAX * di / EPSILON;
  const cgi = 1 / (d1 / EPSILON + eta1 * vt * Math.exp(-(vGS - vt1) / (eta1 * vt)));
  const cgc = W * L * (CHARGE * dnsDnsm * dnsmDvgt * (1 - vDS * model.SIGMA0 / model.VSIGMA
    * sigmaShape / ((1 + sigmaShape) ** 2)) + cgi);
  const mcDrain = 3;
  const vdse = vDS * (1 + (vDS / vsate) ** mcDrain) ** (-1 / mcDrain);
  let partition = (vsate - vdse) / (2 * vsate - vdse);
  partition *= partition;
  const twoThirds = 2 / 3;
  const weighting = 1;
  const capGS = cf + 2 * twoThirds * cgc * (1 - partition) / (1 + weighting);
  partition = vsate / (2 * vsate - vdse);
  partition *= partition;
  const capGD = cf + 2 * weighting * twoThirds * cgc * (1 - partition) / (1 + weighting);
  return { drainCurrent, capGS, capGD };
}

function leakage(voltage: number, density: number, instance: HFET1InstanceParams, gmin: number): { current: number; conductance: number } {
  const is1 = density * instance.W * instance.L / 2;
  const is2 = 1.15e6 * instance.W * instance.L / 2;
  const m1 = 1.32;
  const m2 = 6.9;
  const vt1 = (instance.thermalVoltage ?? THERMAL_VOLTAGE) * m1;
  const vt2 = (instance.thermalVoltage ?? THERMAL_VOLTAGE) * m2;
  let current: number;
  let conductance: number;
  if (is1 === 0 || is2 === 0) {
    current = 0;
    conductance = 0;
  } else if (voltage <= -10 * vt1) {
    current = gmin * voltage - is1;
    conductance = gmin;
  } else {
    const resistance = 90;
    const effectiveVoltage = vt1 + vt2;
    const effectiveSaturation = is2 * (is1 / is2) ** (m1 / (m1 + m2));
    const firstArgument = (voltage + resistance * is1) / vt1
      + Math.log(resistance * is1 / vt1);
    const secondArgument = (voltage + resistance * effectiveSaturation) / effectiveVoltage
      + Math.log(resistance * effectiveSaturation / effectiveVoltage);
    const firstApproximation = vt1 * diode(firstArgument) / resistance - is1;
    const secondApproximation = effectiveVoltage * diode(secondArgument) / resistance
      - effectiveSaturation;
    const approximation = firstApproximation * secondApproximation !== 0
      ? 1 / (1 / firstApproximation + 1 / secondApproximation)
      : 0.5 * (firstApproximation + secondApproximation);
    const initialSlope = resistance + vt1 / (approximation + is1)
      + vt2 / (approximation + is2);
    const initialVoltage = resistance * approximation
      + vt1 * Math.log(approximation / is1 + 1)
      + vt2 * Math.log(approximation / is2 + 1);
    current = Math.max(-is1, approximation + (voltage - initialVoltage) / initialSlope) * 0.99999;
    conductance = 1 / (resistance + vt1 / (current + is1) + vt2 / (current + is2));
  }
  const argument = -voltage * 0.04 / (instance.thermalVoltage ?? THERMAL_VOLTAGE);
  const exponential = Math.exp(Math.min(argument, 80));
  const gateResistanceLeakage = 40 * instance.L * instance.W / 2;
  current += gateResistanceLeakage * voltage * exponential;
  conductance += gateResistanceLeakage * exponential * (1 - argument);
  return { current, conductance };
}

function diode(value: number): number {
  const exponential = Math.exp(Math.min(value, 80));
  let iterate: number;
  if (value <= -2.303) {
    iterate = exponential * (1 - exponential);
  } else {
    const b = 0.5 * (value + 2.303);
    iterate = value + 2.221 * Math.exp((-2.303 - value) / 6.804)
      - Math.log(b + Math.sqrt(b * b + 0.25 * 1.685 * 1.685));
  }
  const transformed = iterate + Math.log(iterate);
  const residual = value - transformed;
  const denominator = 1 + iterate;
  return iterate * (1 + residual / denominator
    + 0.5 * residual * residual / (denominator ** 3));
}

export function evaluateHFET1(
  vGS: number,
  vDS: number,
  model: HFET1Model,
  instance: HFET1InstanceParams,
  gmin = DEVICE_GMIN,
): HFET1Evaluation {
  const result = intrinsic(vGS, vDS, model, instance);
  const evaluationVGS = vGS;
  const evaluationVDS = Math.abs(vDS);
  const hGS = 1e-6 * Math.max(1, Math.abs(evaluationVGS));
  const hDS = 1e-6 * Math.max(1, evaluationVDS);
  // HFET1 retains the forward-mode gm/gds values after swapping drain and
  // source for inverse operation. Reproduce that model contract rather than
  // differentiating the externally signed current.
  const gm = (intrinsic(evaluationVGS + hGS, evaluationVDS, model, instance).drainCurrent
    - intrinsic(evaluationVGS - hGS, evaluationVDS, model, instance).drainCurrent) / (2 * hGS);
  const gds = (intrinsic(evaluationVGS, evaluationVDS + hDS, model, instance).drainCurrent
    - intrinsic(evaluationVGS, evaluationVDS - hDS, model, instance).drainCurrent) / (2 * hDS);
  const gateSource = leakage(vGS, model.JS1S, instance, gmin);
  const gateDrain = leakage(vGS - vDS, model.JS1D, instance, gmin);
  return {
    ...result,
    gm,
    gds,
    gateSourceCurrent: gateSource.current,
    gateSourceConductance: gateSource.conductance,
    gateDrainCurrent: gateDrain.current,
    gateDrainConductance: gateDrain.conductance,
  };
}
