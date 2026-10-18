import { InvalidCircuitError } from '../errors.js';
import type { ChargeIntegration, ChargeTruncation, DeviceModel, StampContext } from './device.js';
import { TransientChargeState } from './charge-state.js';
import { DEVICE_GMIN } from './device.js';
import {
  VBIC_PE, VBIC_ME, VBIC_PC, VBIC_MC, VBIC_PS, VBIC_MS,
  resolveVBICTemperature, type VBICTemperatureState,
} from './vbic-temperature.js';
import { pnjlim } from './devsup.js';

/** ngspice default circuit temperature and VBIC TNOM in degrees Celsius. */
const NOMINAL_TEMPERATURE_C = 27;

const ACTIVE_PARAMETERS = [
  'IS', 'IBEI', 'IBEN', 'IBCI', 'IBCN', 'ISP', 'IBCIP', 'IBCNP', 'IBEIP', 'IBENP',
  'NF', 'NR', 'NEI', 'NEN', 'NCI', 'NCN', 'NFP', 'NCIP', 'NCNP',
  'RCX', 'RCI', 'RBX', 'RBI', 'RE', 'RS', 'RBP', 'FC',
  'VEF', 'VER', 'IKF', 'IKR', 'IKP', 'VO', 'GAMM', 'HRCF', 'AVC1', 'AVC2',
  'PE', 'ME', 'PC', 'MC', 'PS', 'MS', 'WBE', 'WSP',
] as const;
/**
 * Charge-storage and excess-phase parameters: inert at DC, active in the
 * small-signal (.ac/.pz) linearization and transient integration. RTH stays
 * electrically inert: a four-terminal instance has no thermal terminal, so ngspice ties the thermal
 * node to ground and self-heating cannot change any node voltage.
 */
const DC_INERT_PARAMETERS = [
  'CJE', 'CJC', 'CJEP', 'CJCP', 'QCO', 'TF', 'TR', 'TD', 'ITF', 'XTF', 'VTF', 'RTH',
  'KFN', 'AFN', 'BFN',
] as const;
/** Temperature mapping inputs (ngspice vbictemp.c); TNOM defaults to 27 C. */
const TEMPERATURE_PARAMETERS = ['TNOM'] as const;
const SUPPORTED_PARAMETERS = new Set<string>([
  'LEVEL', ...ACTIVE_PARAMETERS, ...DC_INERT_PARAMETERS, ...TEMPERATURE_PARAMETERS,
]);

type ActiveParameter = typeof ACTIVE_PARAMETERS[number];
type InertParameter = typeof DC_INERT_PARAMETERS[number];
type TemperatureParameter = typeof TEMPERATURE_PARAMETERS[number];

export interface VBICParams
  extends Record<ActiveParameter | InertParameter | TemperatureParameter, number> {
  LEVEL: 4;
  polarity: 1 | -1;
}

const DEFAULTS: VBICParams = {
  LEVEL: 4,
  polarity: 1,
  IS: 1e-16,
  IBEI: 1e-18,
  IBEN: 0,
  IBCI: 1e-16,
  IBCN: 0,
  ISP: 0,
  IBCIP: 0,
  IBCNP: 0,
  IBEIP: 0,
  IBENP: 0,
  NF: 1,
  NR: 1,
  NEI: 1,
  NEN: 2,
  NCI: 1,
  NCN: 2,
  NFP: 1,
  NCIP: 1,
  NCNP: 2,
  RCX: 0,
  RCI: 0.1,
  RBX: 0,
  RBI: 0.1,
  RE: 0,
  RS: 0,
  RBP: 0.1,
  FC: 0.9,
  WBE: 1,
  WSP: 1,
  VEF: 0,
  VER: 0,
  IKF: 0,
  IKR: 0,
  IKP: 0,
  VO: 0,
  GAMM: 0,
  HRCF: 1,
  AVC1: 0,
  AVC2: 0,
  PE: VBIC_PE,
  ME: VBIC_ME,
  PC: VBIC_PC,
  MC: VBIC_MC,
  PS: VBIC_PS,
  MS: VBIC_MS,
  CJE: 0,
  CJC: 0,
  CJEP: 0,
  CJCP: 0,
  QCO: 0,
  TF: 0,
  TR: 0,
  TD: 0,
  ITF: 0,
  XTF: 0,
  VTF: 0,
  RTH: 0,
  KFN: 0,
  AFN: 1,
  BFN: 1,
  TNOM: NOMINAL_TEMPERATURE_C,
};

/** Resolve the bounded, isothermal VBIC 1.2 subset used by NPN/PNP LEVEL=4. */
export function resolveVBICParams(
  supplied: Record<string, number>,
  polarity: number,
): VBICParams {
  for (const name of Object.keys(supplied)) {
    if (!SUPPORTED_PARAMETERS.has(name)) {
      throw new InvalidCircuitError(`Unsupported bounded VBIC DC model parameter: '${name}'`);
    }
  }
  if ((supplied.LEVEL ?? 4) !== 4) {
    throw new InvalidCircuitError(`Unsupported bounded VBIC model level: ${supplied.LEVEL}`);
  }
  if (polarity !== 1 && polarity !== -1) {
    throw new InvalidCircuitError('Invalid bounded VBIC polarity: expected NPN (+1) or PNP (-1)');
  }
  const resolved = { ...DEFAULTS, ...supplied, LEVEL: 4, polarity } as VBICParams;
  for (const name of [...ACTIVE_PARAMETERS, ...DC_INERT_PARAMETERS, ...TEMPERATURE_PARAMETERS]) {
    if (!Number.isFinite(resolved[name])) {
      throw new InvalidCircuitError(`Invalid bounded VBIC DC model parameter: '${name}'`);
    }
  }
  for (const name of [
    'IS', 'IBEI', 'IBEN', 'IBCI', 'IBCN', 'ISP', 'IBCIP', 'IBCNP', 'IBEIP', 'IBENP',
    'RCX', 'RBX', 'RE', 'RS', 'RBP', 'VEF', 'VER', 'IKF', 'IKR', 'IKP',
    'VO', 'GAMM', 'AVC1', 'AVC2', ...DC_INERT_PARAMETERS,
  ] as const) {
    // ngspice vbicload.c disables IVTF for every finite VTF <= 0.
    if (name !== 'VTF' && resolved[name] < 0) throw new InvalidCircuitError(`Invalid bounded VBIC DC model parameter: '${name}'`);
  }
  // ngspice-47 a80f6e3e vbicmpar.c:20,42-120: R_MIN applies only
  // to explicitly supplied resistances. Do not clamp vbicsetup.c defaults.
  // Keep negative inputs outside this implementation's bounded domain.
  for (const name of ['RCX', 'RCI', 'RBX', 'RBI', 'RE', 'RS', 'RBP'] as const) {
    if (resolved[name] < 0) throw new InvalidCircuitError(`Invalid bounded VBIC DC model parameter: '${name}'`);
    if (supplied[name] !== undefined) resolved[name] = Math.max(0.01, resolved[name]);
  }
  for (const name of ['HRCF', 'NF', 'NR', 'NEI', 'NEN', 'NCI', 'NCN', 'NFP', 'NCIP', 'NCNP'] as const) {
    if (resolved[name] <= 0) throw new InvalidCircuitError(`Invalid bounded VBIC DC model parameter: '${name}'`);
  }
  if (resolved.TNOM <= -273.15) throw new InvalidCircuitError("Invalid bounded VBIC DC model parameter: 'TNOM'");
  // Bounded physical domain. ngspice vbicsetup.c defaults FC to 0.9 but
  // vbicmpar.c does not validate it; FC=1 makes the charge formula singular.
  if (resolved.FC < 0 || resolved.FC >= 1) throw new InvalidCircuitError("Invalid bounded VBIC DC model parameter: 'FC'");
  if (resolved.WBE < 0 || resolved.WBE > 1) throw new InvalidCircuitError("Invalid bounded VBIC DC model parameter: 'WBE'");
  if (resolved.WSP < 0 || resolved.WSP > 1) throw new InvalidCircuitError("Invalid bounded VBIC DC model parameter: 'WSP'");
  for (const name of ['PE', 'PC', 'PS'] as const) {
    if (resolved[name] <= 0) throw new InvalidCircuitError(`Invalid bounded VBIC DC model parameter: '${name}'`);
  }
  // The bounded depletion integral divides by 1 - M; M = 1 is unsupported.
  for (const name of ['ME', 'MC', 'MS'] as const) {
    if (resolved[name] < 0 || resolved[name] >= 1) {
      throw new InvalidCircuitError(`Invalid bounded VBIC DC model parameter: '${name}'`);
    }
  }
  return resolved;
}

class Dual {
  constructor(public value: number, readonly derivative: Float64Array, readonly workspace: DualWorkspace) {}

  static constant(value: number, workspace: DualWorkspace): Dual {
    const result = workspace.take(value);
    result.derivative.fill(0);
    return result;
  }

  static variable(value: number, workspace: DualWorkspace, index: number): Dual {
    const result = Dual.constant(value, workspace);
    result.derivative[index] = 1;
    return result;
  }
}

/** Monotonic evaluation scratch: no slot is reused until the next evaluation.
 * Every helper overwrites all derivatives. Inputs therefore never alias its
 * result, including repeated operands such as mul(q1, q1). Capacity grows only
 * to the largest expression path visited by this fixed-size device.
 */
class DualWorkspace {
  private readonly slots: Dual[] = [];
  private next = 0;
  private slab = new Float64Array(0);
  private offset = 0;

  constructor(private readonly size: number) {}

  reset(): void {
    this.next = 0;
  }

  take(value: number): Dual {
    const index = this.next++;
    let result = this.slots[index];
    if (result === undefined) {
      // Existing views remain valid when the workspace grows another slab.
      if (this.offset + this.size > this.slab.length) {
        this.slab = new Float64Array(this.size * 256);
        this.offset = 0;
      }
      const derivative = this.slab.subarray(this.offset, this.offset + this.size);
      this.offset += this.size;
      result = new Dual(value, derivative, this);
      this.slots.push(result);
    } else {
      result.value = value;
    }
    return result;
  }
}

function map(a: Dual, value: number, slope: number): Dual {
  const result = a.workspace.take(value);
  const derivative = result.derivative;
  for (let i = 0; i < derivative.length; i++) derivative[i] = a.derivative[i] * slope;
  return result;
}

function add(a: Dual, b: Dual): Dual {
  const result = a.workspace.take(0);
  const derivative = result.derivative;
  for (let i = 0; i < derivative.length; i++) derivative[i] = a.derivative[i] + b.derivative[i];
  result.value = a.value + b.value;
  return result;
}

function sub(a: Dual, b: Dual): Dual {
  const result = a.workspace.take(0);
  const derivative = result.derivative;
  for (let i = 0; i < derivative.length; i++) derivative[i] = a.derivative[i] - b.derivative[i];
  result.value = a.value - b.value;
  return result;
}

// Only use on locally owned accumulators, never on an input/expression Dual.
// Retain each add/sub operation (including signed zeros), without new arrays.
function addInto(target: Dual, source: Dual): void {
  for (let i = 0; i < target.derivative.length; i++) target.derivative[i] += source.derivative[i];
  target.value += source.value;
}

function subInto(target: Dual, source: Dual): void {
  for (let i = 0; i < target.derivative.length; i++) target.derivative[i] -= source.derivative[i];
  target.value -= source.value;
}

function mul(a: Dual, b: Dual): Dual {
  const result = a.workspace.take(0);
  const derivative = result.derivative;
  for (let i = 0; i < derivative.length; i++) {
    derivative[i] = a.derivative[i] * b.value + a.value * b.derivative[i];
  }
  result.value = a.value * b.value;
  return result;
}

function scale(a: Dual, factor: number): Dual {
  return map(a, a.value * factor, factor);
}

function div(a: Dual, b: Dual): Dual {
  const denominator = b.value * b.value;
  const result = a.workspace.take(0);
  const derivative = result.derivative;
  for (let i = 0; i < derivative.length; i++) {
    derivative[i] = (a.derivative[i] * b.value - a.value * b.derivative[i]) / denominator;
  }
  result.value = a.value / b.value;
  return result;
}

function sqrt(a: Dual): Dual {
  const value = Math.sqrt(Math.max(a.value, Number.EPSILON));
  return map(a, value, 0.5 / value);
}

function log(a: Dual): Dual {
  const value = Math.max(a.value, Number.EPSILON);
  return map(a, Math.log(value), 1 / value);
}

function exp(a: Dual): Dual {
  const argument = Math.min(80, Math.max(-80, a.value));
  const value = Math.exp(argument);
  return map(a, value, a.value === argument ? value : 0);
}

function pow(a: Dual, exponent: number): Dual {
  const base = Math.max(a.value, Number.EPSILON);
  return map(a, Math.pow(base, exponent), exponent * Math.pow(base, exponent - 1));
}

function c(value: number, workspace: DualWorkspace): Dual {
  return Dual.constant(value, workspace);
}

function reciprocalOrZero(value: number): number {
  return value > 0 ? 1 / value : 0;
}

function diode(voltage: Dual, current: number, ideality: number, vt: number): Dual {
  // Fuse scale -> exp -> subtract one -> scale without allocating the four
  // intermediate Duals/derivative arrays. Keep every floating-point operation
  // in its original order (including subtracting +0 and multiplying by zero).
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

// ngspice-47 vbicload.c:2238-2283 (BE), 2482-2543 (BC), revision
// a80f6e3e95d51534905b1f23410a951802666656. AJE/AJC/AJS <= 0.
function depletionCharge(voltage: Dual, potential: number, grading: number, fc: number): Dual {
  const workspace = voltage.workspace;
  const delta = voltage.value - potential * fc;
  if (delta > 0) {
    const pw = Math.pow(1 - fc, -1 - grading);
    const constant = potential * (1 - pw * (1 - fc) * (1 - fc)) / (1 - grading);
    return add(c(constant, workspace), scale(
      mul(
        sub(voltage, c(potential * fc, workspace)),
        add(c(1 - fc, workspace), scale(sub(voltage, c(potential * fc, workspace)), 0.5 * grading / potential)),
      ),
      pw,
    ));
  }
  return scale(
    sub(c(1, workspace), pow(sub(c(1, workspace), scale(voltage, 1 / potential)), 1 - grading)),
    potential / (1 - grading),
  );
}

/** Per local node; derivatives are with respect to the {@link BRANCHES} voltages. */
interface Evaluation {
  /** Static currents leaving each device node. */
  residual: Dual[];
  /** Stored charge attached to each device node (ngspice vbicload charges). */
  charge: Dual[];
  noise: { irci: Dual; irbi: Dual; irbp: Dual; itzf: Dual; ibe: Dual; ibep: Dual; iccp: Dual };
}

/** Local node order: seven VBIC nodes, then the excess-phase nodes when TD > 0. */
const CX = 0;
const CI = 1;
const BX = 2;
const BI = 3;
const EI = 4;
const BP = 5;
const SI = 6;
const XF1 = 7;
const XF2 = 8;

/**
 * Branch-voltage order of the model evaluation (ngspice vbicload.c): the six
 * pn junctions that DEVpnjlim limits, the three internal resistor branches,
 * then the excess-phase node voltages when TD > 0. ngspice treats these as
 * independent variables: each junction is limited on its own, so a limited
 * linearization point need not be a consistent set of node voltages.
 */
const BRANCHES: readonly (readonly [positive: number, negative: number])[] = [
  [BI, EI], // Vbei
  [BX, EI], // Vbex
  [BI, CI], // Vbci
  [BI, CX], // Vbcx
  [BX, BP], // Vbep
  [SI, BP], // Vbcp
  [CX, CI], // Vrci
  [BX, BI], // Vrbi
  [BP, CX], // Vrbp
];
const JUNCTION_COUNT = 6;
const NO_NODE = -1;
const EXCESS_PHASE_BRANCHES: readonly (readonly [number, number])[] = [[XF1, NO_NODE], [XF2, NO_NODE]];

/**
 * Evaluate the isothermal VBIC 1.2 currents and charges. `thermal` carries the
 * ngspice vbictemp.c values at the device temperature (kT/q, saturation
 * currents, GAMM, built-in potentials and zero-bias capacitances); every other
 * parameter is temperature independent with ngspice's default exponents.
 * Charges follow ngspice vbic_4T_et_cf_fj with AJE/AJC/AJS <= 0,
 * QTF = CBEO = CBCO = CCSO = 0. With TD > 0 the forward transport current
 * passes through ngspice's second-order excess-phase network (nodes xf1/xf2).
 */
function evaluate(
  voltages: readonly number[],
  params: VBICParams,
  thermal: VBICTemperatureState,
  instanceScale: number,
  gmin: number,
  workspace: DualWorkspace,
): Evaluation {
  workspace.reset();
  const size = voltages.length;
  const nodeCount = size === BRANCHES.length ? XF1 : XF2 + 1;
  const excessPhase = nodeCount > XF2;
  const { vt, PE, PC, PS } = thermal;
  const { ME, MC, MS } = params;
  const b = voltages.map((value, index) => Dual.variable(value, workspace, index));
  const [vbei, vbex, vbci, vbcx, vbep, vbcp, vrci, vrbi, vrbp] = b;
  const xf1 = b[BRANCHES.length];
  const xf2 = b[BRANCHES.length + 1];

  const ifi = diode(vbei, thermal.IS, params.NF, vt);
  const iri = diode(vbci, thermal.IS, params.NR, vt);
  const qdbe = depletionCharge(vbei, PE, ME, params.FC);
  const qdbc = depletionCharge(vbci, PC, MC, params.FC);
  const q1z = add(c(1, workspace), add(
    scale(qdbe, reciprocalOrZero(params.VER)),
    scale(qdbc, reciprocalOrZero(params.VEF)),
  ));
  const q1Offset = sub(q1z, c(1e-4, workspace));
  const q1 = add(scale(add(sqrt(add(mul(q1Offset, q1Offset), c(1e-8, workspace))), q1Offset), 0.5), c(1e-4, workspace));
  const q2 = add(scale(ifi, reciprocalOrZero(params.IKF)), scale(iri, reciprocalOrZero(params.IKR)));
  const qb = scale(add(q1, sqrt(add(mul(q1, q1), scale(q2, 4)))), 0.5);
  const itzf = div(ifi, qb);
  const itzr = div(iri, qb);
  const transport = sub(itzf, itzr);

  const ibe = scale(add(diode(vbei, thermal.IBEI, params.NEI, vt), diode(vbei, thermal.IBEN, params.NEN, vt)), params.WBE);
  const ibex = scale(add(diode(vbex, thermal.IBEI, params.NEI, vt), diode(vbex, thermal.IBEN, params.NEN, vt)), 1 - params.WBE);
  const ibcj = add(diode(vbci, thermal.IBCI, params.NCI, vt), diode(vbci, thermal.IBCN, params.NCN, vt));
  const ibcp = add(diode(vbcp, thermal.IBCIP, params.NCIP, vt), diode(vbcp, thermal.IBCNP, params.NCNP, vt));
  // ngspice vbicload.c:3566-3598 uses the collector emission coefficients.
  const ibep = add(diode(vbep, thermal.IBEIP, params.NCI, vt), diode(vbep, thermal.IBENP, params.NCN, vt));
  const avalancheVoltage = scale(add(
    sqrt(add(mul(sub(c(PC, workspace), vbci), sub(c(PC, workspace), vbci)), c(0.01, workspace))),
    sub(c(PC, workspace), vbci),
  ), 0.5);
  const avalanche = scale(mul(
    avalancheVoltage,
    exp(scale(pow(avalancheVoltage, MC - 1), -params.AVC2)),
  ), params.AVC1);
  const ibc = sub(ibcj, mul(sub(transport, ibcj), avalanche));

  // ngspice-47 vbicload.c:3221-3285 mixes exponentials of Vbep and
  // Vbci, not their voltages. The same Ifp drives qbp, Iccp and Qbep.
  // Keep the default arithmetic path bit-identical.
  const ifp = params.WSP === 1 ? diode(vbep, thermal.ISP, params.NFP, vt) : add(
    scale(diode(vbep, thermal.ISP, params.NFP, vt), params.WSP),
    scale(diode(vbci, thermal.ISP, params.NFP, vt), 1 - params.WSP),
  );
  const irp = diode(vbcp, thermal.ISP, params.NFP, vt);
  const qbp = scale(add(c(1, workspace), sqrt(add(c(1, workspace), scale(ifp, 4 * reciprocalOrZero(params.IKP))))), 0.5);
  const iccp = div(sub(ifp, irp), qbp);

  const kbci = sqrt(add(c(1, workspace), scale(exp(scale(vbci, 1 / vt)), thermal.GAMM)));
  const kbcx = sqrt(add(c(1, workspace), scale(exp(scale(vbcx, 1 / vt)), thermal.GAMM)));
  const ratio = div(add(kbci, c(1, workspace)), add(kbcx, c(1, workspace)));
  const iohm = scale(add(vrci, scale(sub(sub(kbci, kbcx), log(ratio)), vt)), 1 / params.RCI);
  const derf = div(
    scale(iohm, params.RCI * reciprocalOrZero(params.VO)),
    add(c(1, workspace), scale(sqrt(add(mul(vrci, vrci), c(0.01, workspace))), 0.5 * reciprocalOrZero(params.VO) / params.HRCF)),
  );
  const irci = div(iohm, sqrt(add(c(1, workspace), mul(derf, derf))));
  const irbi = scale(mul(vrbi, qb), 1 / params.RBI);
  // Explicit RBP=0 is clamped by vbicmpar.c before vbicload.c sees it.
  const irbp = scale(mul(vrbp, qbp), 1 / params.RBP);

  // ngspice: Iciei = Itxf - Itzr, with Itxf = V(xf2) when excess phase is on.
  const iciei = excessPhase ? sub(xf2, itzr) : transport;

  // Forward transit time with ITF/XTF/VTF bias dependence (QTF = 0).
  const forwardPositive = ifi.value > 0 ? 1 : 0;
  const relativeForward = scale(ifi, forwardPositive * reciprocalOrZero(params.ITF));
  const highCurrent = div(relativeForward, add(relativeForward, c(1, workspace)));
  const enhancement = scale(
    add(c(params.ITF > 0 ? 0 : 1, workspace), mul(highCurrent, highCurrent)),
    params.XTF * forwardPositive,
  );
  // ngspice-47 vbicload.c:2223-2227,3859-3863 (a80f6e3e):
  // value uses 1/1.44, but the generated Jacobian rounds it to 0.6944444.
  // Do not clamp this exponential like the junction diode helper. Keep the
  // disabled/default arithmetic path bit-identical, including signed zeros.
  const vtfExp = params.VTF > 0 ? Math.exp(vbci.value * (1 / params.VTF) / 1.44) : 1;
  const biasedEnhancement = params.VTF > 0
    ? mul(map(vbci, vtfExp, vtfExp * 0.6944444 / params.VTF), enhancement)
    : enhancement;
  const tff = scale(add(c(1, workspace), biasedEnhancement), params.TF);
  // ngspice-47 vbicload.c:3874-3896: partition depletion only; forward
  // diffusion remains intrinsic. The extrinsic integral uses Vbex, not Vbei.
  const qbe = add(scale(qdbe, thermal.CJE * params.WBE), div(mul(tff, ifi), qb));
  const qbex = scale(depletionCharge(vbex, PE, ME, params.FC), thermal.CJE * (1 - params.WBE));
  const qbc = add(add(scale(qdbc, thermal.CJC), scale(iri, params.TR)), scale(kbci, params.QCO));
  const qbcx = scale(kbcx, params.QCO);
  const qbep = add(scale(depletionCharge(vbep, PC, MC, params.FC), thermal.CJEP), scale(ifp, params.TR));
  const qbcp = thermal.CJCP > 0 ? scale(depletionCharge(vbcp, PS, MS, params.FC), thermal.CJCP) : c(0, workspace);

  const residual = Array.from({ length: nodeCount }, () => c(0, workspace));
  const charge = Array.from({ length: nodeCount }, () => c(0, workspace));
  // Each row owns its Dual/derivatives. None aliases branch expressions or
  // noise quantities, and these buffers never escape until evaluation ends.
  const branch = (from: number, to: number, current: Dual): void => {
    addInto(residual[from], current);
    subInto(residual[to], current);
  };
  const store = (from: number, to: number, stored: Dual): void => {
    addInto(charge[from], stored);
    subInto(charge[to], stored);
  };
  // ngspice vbic_4T_et_cf_fj scales every current and charge by
  // SCALE = area * m; the excess-phase network rows stay per-unit because
  // Iciei = SCALE * (V(xf2) - Itzr) is scaled once at the device branch.
  const s = (quantity: Dual): Dual => (instanceScale === 1 ? quantity : scale(quantity, instanceScale));
  // ngspice vbicload.c then adds an unscaled CKTgmin to Ibe, Ibex, Ibc, Ibep,
  // Ibcp and to Irci (via Vrci, Vbci and Vbcx).
  branch(CX, CI, add(s(irci), scale(add(add(vrci, vbci), vbcx), gmin)));
  branch(BX, BI, s(irbi));
  branch(BP, CX, s(irbp));
  branch(BI, EI, add(s(ibe), scale(vbei, gmin)));
  branch(BX, EI, add(s(ibex), scale(vbex, gmin)));
  branch(CI, EI, s(iciei));
  branch(BI, CI, add(s(ibc), scale(vbci, gmin)));
  // Preserve the original arithmetic path (including signed zeros) by default.
  branch(BX, BP, params.IBEIP === 0 && params.IBENP === 0
    ? scale(vbep, gmin) : add(s(ibep), scale(vbep, gmin)));
  branch(SI, BP, add(s(ibcp), scale(vbcp, gmin)));
  branch(BX, SI, s(iccp));
  store(BI, EI, s(qbe));
  // Preserve the default stamp's arithmetic order when the extrinsic charge
  // is identically zero, including signed zeros in conservative charge rows.
  if (params.WBE !== 1) store(BX, EI, s(qbex));
  store(BI, CI, s(qbc));
  store(BI, CX, s(qbcx));
  store(BX, BP, s(qbep));
  store(SI, BP, s(qbcp));
  if (excessPhase) {
    residual[XF1] = sub(xf2, itzf);
    residual[XF2] = sub(xf2, xf1);
    charge[XF1] = scale(xf1, params.TD);
    charge[XF2] = scale(xf2, params.TD / 3);
  }
  return { residual, charge, noise: { irci, irbi, irbp, itzf, ibe, ibep, iccp } };
}

/** Number of device nodes: seven VBIC nodes plus xf1/xf2 when excess phase is on. */
export function vbicNodeCount(params: Pick<VBICParams, 'TD'>): number {
  return params.TD > 0 ? 9 : 7;
}

/** A bounded four-terminal VBIC device with ngspice temperature mapping. */
export class VBIC implements DeviceModel {
  readonly branches: number[] = [];
  readonly isNonlinear = true;
  readonly integratesTransientCharge = true;
  // acceptTransientStep visits every conservative charge row, including both
  // TD excess-phase states. CBEO/CBCO/CTH are outside the bounded subset.
  readonly truncationCoversCharges = true;
  readonly limitsOwnJunctions = true;
  private readonly charges: TransientChargeState;
  private loadVoltages: number[] | undefined;
  /** Charges already evaluated at the limited static load's branch voltages. */
  private loadCharge: Dual[] | undefined;
  /** Retained until the next static load; other evaluations must not reset it. */
  private readonly loadWorkspace: DualWorkspace;
  /** Synchronous scratch for evaluations whose Duals do not escape the caller. */
  private readonly evaluationWorkspace: DualWorkspace;
  readonly params: VBICParams;
  /** Local (positive, negative) node pair of each evaluation branch voltage. */
  private readonly branchTerminals: readonly (readonly [number, number])[];
  private temperature = NOMINAL_TEMPERATURE_C;
  private thermal: VBICTemperatureState;
  /** ngspice vbictemp.c tVcrit, from the temperature-mapped IS: shared by all six junctions. */
  private criticalVoltage: number;
  /** Junction voltages linearized at the last load (ngspice CKTstate0). */
  private junctions: Float64Array | undefined;
  /** Whether the last stamp limited a junction (ngspice CKTnoncon). */
  private limited = false;

  constructor(
    readonly name: string,
    readonly nodes: number[],
    supplied: Record<string, number>,
    polarity: number,
    /** ngspice instance SCALE = AREA * M; the circuit divides the series resistors by it. */
    private readonly instanceScale = 1,
    private readonly parallelMultiplier = 1,
  ) {
    this.params = resolveVBICParams(supplied, polarity);
    this.charges = new TransientChargeState(nodes.length);
    const expected = vbicNodeCount(this.params);
    if (nodes.length !== expected) {
      throw new InvalidCircuitError(`Bounded VBIC device requires ${expected} internal nodes`);
    }
    this.branchTerminals = expected > XF1 ? [...BRANCHES, ...EXCESS_PHASE_BRANCHES] : BRANCHES;
    this.loadWorkspace = new DualWorkspace(this.branchTerminals.length);
    this.evaluationWorkspace = new DualWorkspace(this.branchTerminals.length);
    this.thermal = resolveVBICTemperature(this.params, this.temperature);
    this.criticalVoltage = this.vcrit();
  }

  /** vbictemp.c: tVcrit = Vt * ln(Vt / (sqrt(2) * tIS * area * m)). */
  private vcrit(): number {
    const { vt, IS } = this.thermal;
    return vt * Math.log(vt / (Math.SQRT2 * IS * this.instanceScale));
  }

  /** Evaluate at a circuit temperature in degrees Celsius (ngspice VBICtemp). */
  setTemperature(value: number): void {
    this.loadCharge = undefined;
    this.temperature = value;
    this.thermal = resolveVBICTemperature(this.params, value);
    this.criticalVoltage = this.vcrit();
  }

  getTemperature(): number {
    return this.temperature;
  }

  /** ngspice vbicnoise.c: internal resistor derivatives and junction currents.
   * External RCX/RBX/RE/RS noise is already carried by expanded resistors.
   */
  noiseOperatingPoint(solution: Float64Array, gmin = DEVICE_GMIN, emitterNode = this.nodes[EI]): Array<{
    positive: number;
    negative: number;
    conductance: number;
    shotCurrent: number;
    flickerCoefficient: number;
    excludeFromSpectrum?: boolean;
  }> {
    const voltage = (local: number): number => {
      const node = local === NO_NODE ? -1 : this.nodes[local];
      return node >= 0 ? solution[node] : 0;
    };
    const voltages = this.branchTerminals.map(([p, n]) =>
      this.params.polarity * (voltage(p) - voltage(n)));
    const { noise } = evaluate(voltages, this.params, this.thermal, this.instanceScale, 0, this.evaluationWorkspace);
    const source = (p: number, n: number, conductance = 0, shotCurrent = 0, flickerCoefficient = 0) => ({
      positive: this.nodes[p], negative: this.nodes[n], conductance, shotCurrent, flickerCoefficient,
    });
    // vbicload.c stores the post-gmin currents/derivatives in CKTstate0.
    const baseCurrent = Math.abs(noise.ibe.value * this.instanceScale + gmin * voltages[0]);
    const peripheralBaseCurrent = Math.abs(noise.ibep.value * this.instanceScale + gmin * voltages[4]);
    const flicker = (current: number): number => this.parallelMultiplier * this.params.KFN
      * Math.pow(Math.max(current / this.parallelMultiplier, 1e-38), this.params.AFN);
    return [
      source(CX, CI, noise.irci.derivative[6] * this.instanceScale + gmin),
      source(BX, BI, noise.irbi.derivative[7] * this.instanceScale),
      // vbicnoise.c intentionally projects RBP noise across EI/emitter,
      // not BP/CX. RE=0 makes that branch noiseless at the output.
      { ...source(EI, EI, noise.irbp.derivative[8] * this.instanceScale), negative: emitterNode },
      source(CI, EI, 0, Math.abs(noise.itzf.value * this.instanceScale)),
      source(BI, EI, 0, baseCurrent, flicker(baseCurrent)),
      source(BX, BP, 0, peripheralBaseCurrent, flicker(peripheralBaseCurrent)),
      // ngspice includes ICCP/RS in integrated totals only.
      { ...source(BX, SI, 0, Math.abs(noise.iccp.value * this.instanceScale)), excludeFromSpectrum: true },
    ];
  }

  /** Branch voltages of the evaluation, in {@link BRANCHES} order. */
  private branchVoltages(ctx: StampContext): number[] {
    const voltage = (local: number): number => {
      const node = local === NO_NODE ? -1 : this.nodes[local];
      return node >= 0 ? ctx.getVoltage(node) : 0;
    };
    // Evaluate both polarities in the forward-positive NPN coordinate system,
    // including the excess-phase states. Junction limiting uses these coordinates.
    return this.branchTerminals.map(([positive, negative]) =>
      this.params.polarity * (voltage(positive) - voltage(negative)));
  }

  /** Map branch-voltage derivatives onto the device's local node columns. */
  private nodeJacobian(quantity: Dual): Float64Array {
    const jacobian = new Float64Array(this.nodes.length);
    this.branchTerminals.forEach(([positive, negative], index) => {
      const derivative = quantity.derivative[index];
      jacobian[positive] += derivative;
      if (negative !== NO_NODE) jacobian[negative] -= derivative;
    });
    return jacobian;
  }

  /**
   * ngspice vbicload.c: the first load of an operating point (MODEINITJCT)
   * starts the junctions at tVcrit; every later load limits each junction
   * voltage on its own with DEVpnjlim against the voltage linearized at the
   * previous load (CKTstate0), and reports a limited iterate as unconverged.
   */
  private limitJunctions(voltages: number[]): void {
    const previous = this.junctions;
    if (previous === undefined) {
      const vcrit = this.criticalVoltage;
      voltages.fill(0);
      voltages[0] = vcrit; // Vbei
      voltages[1] = vcrit; // Vbex
      voltages[2] = -vcrit; // Vbci
      voltages[5] = -vcrit; // Vbcp = Vbc - Vbe
      this.junctions = Float64Array.from(voltages.slice(0, JUNCTION_COUNT));
      this.limited = true;
      return;
    }
    this.limited = false;
    for (let index = 0; index < JUNCTION_COUNT; index += 1) {
      const limited = pnjlim(voltages[index], previous[index], this.thermal.vt, this.criticalVoltage);
      if (limited !== voltages[index]) this.limited = true;
      voltages[index] = limited;
      previous[index] = limited;
    }
  }

  limitedLastStamp(): boolean {
    return this.limited;
  }

  stamp(ctx: StampContext): void {
    const voltages = this.branchVoltages(ctx);
    this.limitJunctions(voltages);
    this.loadVoltages = voltages;
    const { residual, charge } = evaluate(voltages, this.params, this.thermal, this.instanceScale, ctx.gmin ?? DEVICE_GMIN, this.loadWorkspace);
    this.loadCharge = charge;
    for (let row = 0; row < this.nodes.length; row += 1) {
      const matrixRow = this.nodes[row];
      if (matrixRow < 0) continue;
      // Linearize about the limited branch voltages: I(v) ~ I(vl) + dI/dv (v - vl).
      let rhs = -residual[row].value;
      for (let index = 0; index < voltages.length; index += 1) {
        rhs += residual[row].derivative[index] * voltages[index];
      }
      const jacobian = this.nodeJacobian(residual[row]);
      for (let column = 0; column < this.nodes.length; column += 1) {
        const matrixColumn = this.nodes[column];
        // Stamp zero derivatives too so the first assembly pass locks the full
        // nonlinear Jacobian pattern used by later Newton iterations.
        if (matrixColumn >= 0) ctx.stampG(matrixRow, matrixColumn, jacobian[column]);
      }
      // Iphysical(V) = polarity * Imodel(polarity * V): the Jacobian's
      // two polarity factors cancel, but the equivalent source changes sign.
      ctx.stampB(matrixRow, this.params.polarity * rhs);
    }
  }

  /**
   * Small-signal charge Jacobian dQ/dV at the operating point, the real-valued
   * counterpart of ngspice VBICacLoad/VBICpzLoad capacitive stamps. Only the
   * linearized AC and pole-zero analyses reach this; transient integrates Q.
   */
  stampDynamic(ctx: StampContext): void {
    const { charge } = evaluate(this.branchVoltages(ctx), this.params, this.thermal, this.instanceScale, ctx.gmin ?? DEVICE_GMIN, this.evaluationWorkspace);
    for (let row = 0; row < this.nodes.length; row += 1) {
      const matrixRow = this.nodes[row];
      if (matrixRow < 0) continue;
      const jacobian = this.nodeJacobian(charge[row]);
      for (let column = 0; column < this.nodes.length; column += 1) {
        const matrixColumn = this.nodes[column];
        const capacitance = jacobian[column];
        if (matrixColumn >= 0 && capacitance !== 0) ctx.stampC(matrixRow, matrixColumn, capacitance);
      }
    }
  }

  /** Integrate conservative terminal charges and both excess-phase state rows. */
  stampTransientCharge(ctx: StampContext, integration: ChargeIntegration): void {
    const voltages = this.loadVoltages ?? this.branchVoltages(ctx);
    // evaluate computes currents and charges together. Reuse the charge half
    // from stamp at these exact limited voltages; gmin affects residuals only.
    const charge = this.loadCharge
      ?? evaluate(voltages, this.params, this.thermal, this.instanceScale, ctx.gmin ?? DEVICE_GMIN, this.evaluationWorkspace).charge;
    this.charges.begin(integration);
    for (let row = 0; row < this.nodes.length; row++) {
      const node = this.nodes[row];
      if (node < 0) continue;
      const quantity = charge[row];
      let rhs = -this.charges.current(row, quantity.value);
      for (let index = 0; index < voltages.length; index++) {
        rhs += this.charges.factor * quantity.derivative[index] * voltages[index];
      }
      const jacobian = this.nodeJacobian(quantity);
      for (let column = 0; column < this.nodes.length; column++) {
        if (this.nodes[column] >= 0) ctx.stampG(node, this.nodes[column], this.charges.factor * jacobian[column]);
      }
      ctx.stampB(node, this.params.polarity * rhs);
    }
  }

  stampAcceptedChargeCurrent(ctx: StampContext): void {
    this.nodes.forEach((node, row) => {
      if (node >= 0) ctx.stampB(node, -this.params.polarity * this.charges.acceptedChargeCurrent(row));
    });
  }

  acceptTransientStep(ctx: StampContext): void {
    const { charge } = evaluate(this.branchVoltages(ctx), this.params, this.thermal, this.instanceScale, ctx.gmin ?? DEVICE_GMIN, this.evaluationWorkspace);
    charge.forEach((quantity, row) => this.charges.accept(row, quantity.value));
    this.charges.commit();
  }

  truncateTransientStep(ctx: StampContext, truncation: ChargeTruncation): number {
    return this.charges.truncationTimestep(truncation, () => this.acceptTransientStep(ctx));
  }

  resetTransient(): void {
    this.charges.reset();
    this.junctions = undefined;
    this.loadVoltages = undefined;
    this.loadCharge = undefined;
  }
}
