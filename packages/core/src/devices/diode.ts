import type { DiodeInstanceParams } from '../parser/diode-parser.js';
import { InvalidCircuitError, UnsupportedModelParameterError } from '../errors.js';
import {
  DEVICE_GMIN, type ChargeIntegration, type ChargeTruncation, type DeviceModel, type StampContext,
} from './device.js';
import { chargeTruncationTimestep } from './charge-state.js';
import { gear3Coefficients } from './gear3.js';
import { temperatureJunction } from './junction-temperature.js';
import { pnjlim } from './devsup.js';

export interface DiodeParams {
  IS: number;
  N: number;
  BV: number;
  IBV: number;
  /**
   * First-order breakdown-voltage temperature coefficient. By default it is
   * ngspice-47 TCV (V/K): BV(T) = BV - TBV1 * (T - TNOM). With LEVEL=2 it is the
   * PSpice/Xyce relative coefficient: BV(T) = BV * (1 + TBV1*dT + TBV2*dT^2).
   */
  TBV1: number;
  /** PSpice/Xyce second-order coefficient; ignored with a warning outside LEVEL=2. */
  TBV2: number;
  /**
   * Breakdown emission coefficient (alias NZ). Defaults to N like ngspice-47;
   * the LEVEL=2 PSpice slice keeps NBV = 1.
   */
  NBV: number;
  /** Diode model level; only LEVEL=2 changes the breakdown law here. */
  LEVEL?: number;
  TNOM: number;
  /** Series resistance (per AREA*M) at the device temperature. */
  RS: number;
  /** Sidewall resistance per PJ*M; expanded into its own junction by Circuit. */
  RSW?: number;
  /**
   * ngspice-47 diotemp.c RS temperature coefficients (TRS is an alias of TRS1):
   * RS(T) = RS * (1 + TRS1*dT + TRS2*dT^2), dT = T - TNOM.
   */
  TRS1?: number;
  TRS2?: number;
  JSW?: number;
  /**
   * Sidewall emission coefficient. When supplied (with JSW) and different from
   * N, the sidewall carries its own current JSW*PJ*(exp(vd/(NS*vt)) - 1)
   * (ngspice-47 dioload.c); otherwise it shares the bottom characteristic.
   * diotemp.c scales the sidewall saturation current with NS (default 1).
   */
  NS?: number;
  CJ0?: number;
  CJO?: number;
  CJP?: number;
  CJSW?: number;
  VJ?: number;
  PHP?: number;
  VJSW?: number;
  M?: number;
  MJSW?: number;
  FC?: number;
  FCS?: number;
  TT?: number;
  /** Junction capacitance temperature law: 0 = band-gap, 1 = linear about 27 C. */
  TLEVC?: number;
  /** Linear bottom/sidewall capacitance coefficients (1/K), used with TLEVC=1. */
  CTA?: number;
  CTP?: number;
  /** Bottom/sidewall potential coefficients (V/K), used with TLEVC=1. */
  TPB?: number;
  TPHP?: number;
  /** Bottom grading and transit-time polynomial coefficients about TNOM. */
  TM1?: number;
  TM2?: number;
  TTT1?: number;
  TTT2?: number;
  KF?: number;
  AF?: number;
  /** Forward knee current (high injection) of the bottom junction; ngspice alias IK. */
  IKF?: number;
  /** Reverse knee current of the bottom junction (ngspice IKR), scaled by AREA*M. */
  IKR?: number;
  /** Forward knee current of the sidewall junction (ngspice IKP), scaled by PJ*M. */
  IKP?: number;
  /** Activation energy (eV) of the IS temperature law; ngspice default 1.11. */
  EG?: number;
  /** Saturation-current temperature exponent; ngspice default 3. */
  XTI?: number;
  RTH0?: number;
  CTH0?: number;
}

/** Values at TNOM that diotemp.c maps to the device temperature. */
interface DiodeNominalParams {
  /** Area saturation current IS*AREA*M and sidewall JSW*PJ*M. */
  areaSaturationCurrent: number;
  sidewallSaturationCurrent: number;
  CJ0: number;
  CJSW: number;
  VJ: number;
  VJSW: number;
  M: number;
  TT: number;
  /** Series resistance RS/(AREA*M) before the TRS1/TRS2 law. */
  RS: number;
}

/**
 * ngspice-47 dio.c model-parameter aliases. Every name in a group sets the same
 * ngspice field; the first name is the spice-ts canonical one.
 */
const DIODE_ALIAS_GROUPS: ReadonlyArray<{
  names: readonly string[];
  description: string;
}> = [
  { names: ['IS', 'JS'], description: 'saturation current' },
  { names: ['JSW', 'ISW'], description: 'sidewall saturation current' },
  { names: ['TNOM', 'TREF'], description: 'parameter measurement temperature' },
  { names: ['TRS1', 'TRS'], description: 'first-order RS temperature coefficient' },
  { names: ['CJO', 'CJ0', 'CJ'], description: 'zero-bias junction capacitance' },
  { names: ['VJ', 'PB'], description: 'junction potential' },
  { names: ['M', 'MJ'], description: 'grading coefficient' },
  { names: ['CJSW', 'CJP'], description: 'sidewall junction capacitance' },
  { names: ['VJSW', 'PHP'], description: 'sidewall junction potential' },
  { names: ['IKF', 'IK'], description: 'forward knee current' },
  { names: ['NBV', 'NZ'], description: 'breakdown emission coefficient' },
  { names: ['BV', 'VB', 'VRB', 'VAR'], description: 'reverse breakdown voltage' },
  { names: ['IBV', 'IB'], description: 'reverse breakdown current' },
  { names: ['TBV1', 'TCV'], description: 'breakdown-voltage temperature coefficient' },
];

const DIODE_CANONICAL_NAMES: ReadonlyMap<string, string> = new Map(
  DIODE_ALIAS_GROUPS.flatMap(({ names }) => names.map(field => [field, names[0]] as const)),
);

export type DiodeModelAlias =
  | 'JS' | 'ISW' | 'TREF' | 'TRS' | 'CJ' | 'PB' | 'MJ' | 'IK' | 'NZ'
  | 'VB' | 'VRB' | 'VAR' | 'IB' | 'TCV';

/** Diode model fields as written in a netlist, canonical names or ngspice aliases. */
export type DiodeModelInput = Partial<DiodeParams> & Partial<Record<DiodeModelAlias, number>>;

// ngspice-47 const.h: CONSTboltz, CHARGE, CONSTCtoK.
const BOLTZMANN = 1.38064852e-23;
const ELEMENTARY_CHARGE = 1.6021766208e-19;
const KELVIN_OFFSET = 273.15;
const K_OVER_Q = BOLTZMANN / ELEMENTARY_CHARGE;

/** ngspice CKTepsmin: smaller IKF/IKR/IKP values disable the knee (diosetup.c). */
const MIN_KNEE_CURRENT = 1e-28;
/**
 * dio.c model fields spice-ts does not implement. They change the ngspice
 * result, so they are rejected rather than ignored (#643).
 */
const UNSUPPORTED_MODEL_PARAMETERS: ReadonlyMap<string, string> = new Map([
  ['RSW', 'sidewall resistance requires Circuit compilation to expand the internal sidewall node'],
]);
/** ngspice dioload.c applies the knee only above this junction current. */
const KNEE_CURRENT_THRESHOLD = 1e-18;
const UNSUPPORTED_BREAKDOWN_TEMPERATURE_PARAMETERS = new Set([
  'IBVL', 'NBVL', 'TLEV',
]);
/**
 * Fields the LEVEL=2 PSpice breakdown law cannot honour: it keeps NBV = 1 and
 * has no ngspice TCV. (TBV2 outside LEVEL=2 is warned about and ignored, like
 * ngspice-47; see {@link Diode.modelWarnings}.)
 */
const LAW_SPECIFIC_UNSUPPORTED: Readonly<Record<'ngspice' | 'pspice', ReadonlyMap<string, string>>> = {
  ngspice: new Map(),
  pspice: new Map([
    ['NBV', 'the LEVEL=2 PSpice breakdown law uses NBV=1'],
    ['TCV', 'TCV is the ngspice-47 linear coefficient; LEVEL=2 uses TBV1/TBV2'],
  ]),
};

/** Thermal voltage kT/q at a temperature in Celsius, as ngspice computes it. */
function thermalVoltageAt(temperatureCelsius: number): number {
  return K_OVER_Q * (temperatureCelsius + KELVIN_OFFSET);
}

/**
 * Map ngspice diode model aliases onto canonical spice-ts names. ngspice keeps
 * the last value written to a shared field, which depends on netlist order that
 * the model card no longer carries, so conflicting values are rejected.
 */
export function canonicalDiodeModelParams(
  name: string,
  params: Readonly<DiodeModelInput>,
): Partial<DiodeParams> {
  const values = params as Readonly<Record<string, number | undefined>>;
  const canonical: Record<string, number> = {};
  for (const { names, description } of DIODE_ALIAS_GROUPS) {
    const supplied = names.filter(field => values[field] !== undefined);
    const conflict = supplied.find(field => values[field] !== values[supplied[0]]);
    if (conflict !== undefined) {
      throw new InvalidCircuitError(
        `Diode '${name}' sets both ${supplied[0]}=${values[supplied[0]]} and `
          + `${conflict}=${values[conflict]}; they are aliases of the same `
          + `${description}, so supply only one`,
      );
    }
    if (supplied.length > 0) canonical[names[0]] = values[supplied[0]]!;
  }
  for (const [field, value] of Object.entries(values)) {
    if (value !== undefined && !DIODE_CANONICAL_NAMES.has(field)) canonical[field] = value;
  }
  return canonical as Partial<DiodeParams>;
}

interface BreakdownParams {
  voltage: number;
  current: number;
  /** Breakdown thermal voltage NBV*kT/q (ngspice vtebrk). */
  thermalVoltage: number;
  /** Plain kT/q, used by the knee fit's linear term (ngspice vt). */
  junctionThermalVoltage: number;
}

/** Sidewall current csatsw (ngspice cdsw), present when JSW is given. */
interface SidewallJunction {
  /** NS*kT/q with its own characteristic, N*kT/q when it shares the bottom one. */
  thermalVoltage: number;
  saturationCurrent: number;
  /** NS is given (ngspice DIOswEmissionCoeffGiven): the sidewall has its own law. */
  ownCharacteristic: boolean;
}

/** Temperature-resolved junction law shared by the DC, AC and noise paths. */
interface Junction {
  thermalVoltage: number;
  /**
   * Total bottom + sidewall saturation current (diotemp.c totalSatCur): it
   * sets the critical voltage and the breakdown knee.
   */
  saturationCurrent: number;
  /** Area saturation current of the bottom junction (ngspice csat). */
  bottomSaturationCurrent: number;
  sidewall?: SidewallJunction;
  breakdown?: BreakdownParams;
  /** Area-scaled forward knee current IKF of the bottom junction; 0 disables it. */
  kneeCurrent: number;
  /** Area-scaled reverse knee current IKR of the bottom junction; 0 disables it. */
  reverseKneeCurrent: number;
  /** Perimeter-scaled forward knee current IKP of the sidewall; 0 disables it. */
  sidewallKneeCurrent: number;
}

export interface DiodeDistortionCoefficients {
  current2: number;
  current3: number;
  charge2: number;
  charge3: number;
}

interface ChargeTaylorCoefficients {
  capacitance: number;
  second: number;
  third: number;
}

export class Diode implements DeviceModel {
  readonly branches: number[] = [];
  readonly isNonlinear = true;
  readonly integratesTransientCharge: boolean;
  readonly params: DiodeParams;
  readonly suppliedParams: Readonly<Partial<DiodeParams>>;
  readonly modelWarnings: readonly string[];
  private temperature = 27;
  private readonly nominal: DiodeNominalParams;
  /**
   * The sidewall has its own NS characteristic (ngspice DIOsatSWCurGiven &&
   * DIOswEmissionCoeffGiven). It differs from the shared characteristic in
   * breakdown even when NS = N, so it follows the ngspice flag exactly.
   */
  private readonly separateSidewall: boolean;
  /** Temperature-resolved area and sidewall saturation currents (DIOtSatCur, DIOtSatSWCur). */
  private bottomSaturationCurrent = 0;
  private sidewallSaturationCurrent = 0;
  /** Limited junction voltage of the last stamp (ngspice CKTstate0 DIOvoltage). */
  private previousJunctionVoltage: number | undefined;
  /** Junction voltage of the last accepted transient timepoint (CKTstate1). */
  private acceptedJunctionVoltage: number | undefined;
  /** Junction voltage and step of the accepted timepoint before that (CKTstate2, CKTdeltaOld[1]). */
  private priorAcceptedJunctionVoltage: number | undefined;
  private acceptedStep: number | undefined;
  /** The next stamp is the first Newton iterate of a timepoint (ngspice MODEINITPRED). */
  private predictJunction = false;
  /** A transient Newton solve ran since the last accepted timepoint. */
  private inTransientNewton = false;
  /** Junction voltage of the last undamped transient Newton solve, if unused. */
  private newtonJunctionVoltage: number | undefined;
  /** Whether the last stamp limited the junction (ngspice noncon). */
  private limited = false;
  /**
   * The junction is limited whenever the stamped junction is the terminal
   * pair: no RS, or RS expanded into a separate resistor. The two-terminal RS
   * fallback solves its internal junction exactly and needs no limiting.
   */
  readonly limitsOwnJunctions: boolean;
  /** stampDynamic is a no-op without junction capacitance or transit time. */
  readonly storesCharge: boolean;
  /** Junction voltage the last `stamp` linearised at; the charge uses the same point. */
  private stampedJunctionVoltage = 0;
  /**
   * Accepted junction charge history (ngspice DIOcapCharge in CKTstate1/2) and
   * the charge current at the last accepted point (DIOcapCurrent).
   */
  private acceptedCharge: number | undefined;
  private previousAcceptedCharge: number | undefined;
  /** q(n-2), the extra point the order-2 truncation error needs (ngspice CKTstate3). */
  private olderAcceptedCharge: number | undefined;
  /** q(n-3), needed by order-3 CKTterr (ngspice CKTstate4). */
  private oldestAcceptedCharge: number | undefined;
  private acceptedChargeCurrent = 0;
  /** Integration rule of the most recent charge stamp, committed on acceptance. */
  private pendingIntegration: ChargeIntegration | undefined;

  constructor(
    readonly name: string,
    readonly nodes: number[],
    modelParams: DiodeModelInput,
    private readonly hasExternalSeriesResistance = false,
    readonly instanceParams: DiodeInstanceParams = {},
    private readonly currentControlNode?: number,
  ) {
    const pspiceBreakdownLaw = modelParams.LEVEL === 2;
    const lawSpecific = LAW_SPECIFIC_UNSUPPORTED[pspiceBreakdownLaw ? 'pspice' : 'ngspice'];
    for (const field of Object.keys(modelParams)) {
      const canonicalField = DIODE_CANONICAL_NAMES.get(field) ?? field;
      // TCV is checked as written: it shares TBV1's field but not its LEVEL=2 law.
      const lawField = lawSpecific.has(field) ? field : canonicalField;
      const reason = lawSpecific.get(lawField);
      if (UNSUPPORTED_BREAKDOWN_TEMPERATURE_PARAMETERS.has(canonicalField) || reason) {
        const written = lawField === field ? '' : ` (written as '${field}')`;
        throw new Error(
          `Unsupported bounded diode breakdown-temperature model parameter: '${lawField}'${written}`
            + (reason ? `; ${reason}` : ''),
        );
      }
    }
    const params = canonicalDiodeModelParams(name, modelParams);
    if (params.TLEVC !== undefined && params.TLEVC !== 0 && params.TLEVC !== 1) {
      throw new UnsupportedModelParameterError(name, 'TLEVC', 'only TLEVC=0 and TLEVC=1 are implemented');
    }
    for (const [field, reason] of UNSUPPORTED_MODEL_PARAMETERS) {
      if ((params as Record<string, number | undefined>)[field] !== undefined
        && (params as Record<string, number | undefined>)[field] !== 0) {
        throw new UnsupportedModelParameterError(name, field, reason);
      }
    }
    const warnings: string[] = [];
    if (!pspiceBreakdownLaw && params.TBV2 !== undefined) {
      // ngspice-47 dio.c has no tbv2 (only tbv1, an alias of tcv, at dio.c:121),
      // so inpgmod.c:186-189 reports "unrecognized parameter (tbv2) - ignored"
      // and simulates without it. Only the LEVEL=2 PSpice law applies TBV2.
      warnings.push(
        `Diode ${name}: unrecognized parameter (tbv2) - ignored; ngspice-47 has no TBV2, `
          + 'only LEVEL=2 applies the PSpice TBV1/TBV2 law',
      );
    }
    this.modelWarnings = warnings;
    this.suppliedParams = params;
    if (instanceParams.THERMAL && nodes.length === 3 && params.RTH0 !== undefined && (params.RS ?? 0) > 0
      && ((params.CJO ?? 0) !== 0 || (params.CJSW ?? 0) !== 0 || (params.TT ?? 0) !== 0)) {
      throw new InvalidCircuitError('Self-heating diode reduced-RS junction charge requires an internal junction node');
    }
    const effectiveArea = (instanceParams.AREA ?? 1) * (instanceParams.M ?? 1);
    const effectivePerimeter = (instanceParams.PJ ?? 0) * (instanceParams.M ?? 1);
    this.params = {
      IS: (params.IS ?? 1e-14) * effectiveArea
        + (params.JSW ?? 0) * effectivePerimeter,
      N: params.N ?? 1,
      BV: params.BV ?? Infinity,
      IBV: params.IBV ?? 1e-3,
      TBV1: params.TBV1 ?? 0,
      TBV2: pspiceBreakdownLaw ? params.TBV2 ?? 0 : 0,
      // ngspice-47 diosetup.c:131-133: NBV defaults to the emission coefficient N.
      NBV: pspiceBreakdownLaw ? 1 : params.NBV ?? params.N ?? 1,
      LEVEL: params.LEVEL,
      TNOM: params.TNOM ?? 27,
      RS: (params.RS ?? 0) / effectiveArea,
      TRS1: params.TRS1 ?? 0,
      TRS2: params.TRS2 ?? 0,
      JSW: params.JSW ?? 0,
      NS: params.NS ?? 1,
      CJ0: (params.CJO ?? 0) * effectiveArea,
      CJSW: (params.CJSW ?? 0) * effectivePerimeter,
      // ngspice diosetup.c defaults: VJ = VJSW = 1 V, FC = FCS = 0.5.
      VJ: params.VJ ?? 1,
      VJSW: params.VJSW ?? 1,
      M: params.M ?? 0.5,
      MJSW: params.MJSW ?? 0.33,
      FC: params.FC ?? 0.5,
      FCS: params.FCS ?? 0.5,
      TT: params.TT ?? 0,
      TLEVC: params.TLEVC ?? 0,
      CTA: params.CTA ?? 0,
      CTP: params.CTP ?? 0,
      TPB: params.TPB ?? 0,
      TPHP: params.TPHP ?? 0,
      TM1: params.TM1 ?? 0,
      TM2: params.TM2 ?? 0,
      TTT1: params.TTT1 ?? 0,
      TTT2: params.TTT2 ?? 0,
      KF: params.KF ?? 0,
      AF: params.AF ?? 1,
      // ngspice-47 diosetup.c:110-129, 362-364: knees below CKTepsmin are
      // disabled; IKF and IKR scale with AREA*M, IKP with PJ*M.
      IKF: (params.IKF ?? 0) >= MIN_KNEE_CURRENT ? params.IKF! * effectiveArea : 0,
      IKR: (params.IKR ?? 0) >= MIN_KNEE_CURRENT ? params.IKR! * effectiveArea : 0,
      IKP: (params.IKP ?? 0) >= MIN_KNEE_CURRENT ? params.IKP! * effectivePerimeter : 0,
      EG: params.EG ?? 1.11,
      XTI: params.XTI ?? 3,
    };
    this.nominal = {
      areaSaturationCurrent: (params.IS ?? 1e-14) * effectiveArea,
      sidewallSaturationCurrent: (params.JSW ?? 0) * effectivePerimeter,
      CJ0: this.params.CJ0!,
      CJSW: this.params.CJSW!,
      VJ: this.params.VJ!,
      VJSW: this.params.VJSW!,
      M: this.params.M!,
      TT: this.params.TT!,
      RS: this.params.RS,
    };
    this.separateSidewall = params.NS !== undefined && params.JSW !== undefined;
    this.setTemperature(27);
    this.limitsOwnJunctions = this.params.RS === 0;
    this.storesCharge = Boolean(this.params.CJ0 || this.params.CJSW || this.params.TT);
    // A two-terminal RS fallback cannot carry the internal junction charge, so
    // it keeps the reduced C(v) stamp. Compiled circuits expand RS whenever the
    // junction stores charge, leaving RS = 0 here.
    this.integratesTransientCharge = this.limitsOwnJunctions && this.storesCharge;
  }

  beginTransientNewton(): void {
    // ngspice MODEINITPRED copies CKTstate1 into CKTstate0, so a new or
    // retried timepoint limits against the accepted junction voltage.
    if (this.acceptedJunctionVoltage !== undefined) {
      this.previousJunctionVoltage = this.acceptedJunctionVoltage;
    }
    this.newtonJunctionVoltage = undefined;
    this.predictJunction = true;
    this.inTransientNewton = true;
  }

  /**
   * First-iterate junction voltage of a timepoint, as ngspice dioload.c
   * MODEINITPRED: DEVpred extrapolates the two accepted junction voltages,
   * vd = (1+x)*vd(n) - x*vd(n-1) with x = h(n+1)/h(n). The first timepoint
   * after the operating point (MODEINITTRAN) starts from vd(n). On a
   * non-monotonic junction charge (the sidewall F1 step, #450) the start
   * selects which charge-conserving solution Newton converges to.
   */
  private predictedJunctionVoltage(dt: number): number | undefined {
    const accepted = this.acceptedJunctionVoltage;
    if (accepted === undefined) return undefined;
    const prior = this.priorAcceptedJunctionVoltage;
    const step = this.acceptedStep;
    if (prior === undefined || step === undefined || !(step > 0) || !(dt > 0)) return accepted;
    const ratio = dt / step;
    return (1 + ratio) * accepted - ratio * prior;
  }

  observeTransientNewton(solution: Float64Array): void {
    this.newtonJunctionVoltage = this.terminalVoltage(solution);
  }

  private terminalVoltage(solution: Float64Array): number {
    const [nA, nK] = this.nodes;
    return (nA >= 0 ? solution[nA] : 0) - (nK >= 0 ? solution[nK] : 0);
  }

  limitedLastStamp(): boolean {
    return this.limited;
  }

  acceptTransientStep(ctx: StampContext): void {
    if (this.selfHeating) {
      this.temperature = this.ambientTemperature + ctx.getVoltage(this.nodes[2]);
      this.applyTemperature();
    }
    const [nA, nK] = this.nodes;
    const voltage = (nA >= 0 ? ctx.getVoltage(nA) : 0) - (nK >= 0 ? ctx.getVoltage(nK) : 0);
    if (this.inTransientNewton) {
      this.priorAcceptedJunctionVoltage = this.acceptedJunctionVoltage;
      this.acceptedStep = ctx.dt;
    } else {
      // Operating point: the transient history restarts here.
      this.priorAcceptedJunctionVoltage = undefined;
      this.acceptedStep = undefined;
    }
    this.acceptedJunctionVoltage = voltage;
    this.inTransientNewton = false;
    this.predictJunction = false;
    this.newtonJunctionVoltage = undefined;
    if (this.integratesTransientCharge) this.acceptCharge(this.acceptedJunctionVoltage, ctx.gmin ?? DEVICE_GMIN);
  }

  resetTransient(): void {
    this.acceptedJunctionVoltage = undefined;
    this.priorAcceptedJunctionVoltage = undefined;
    this.acceptedStep = undefined;
    this.predictJunction = false;
    this.inTransientNewton = false;
    this.newtonJunctionVoltage = undefined;
    this.limited = false;
    this.acceptedCharge = undefined;
    this.previousAcceptedCharge = undefined;
    this.olderAcceptedCharge = undefined;
    this.oldestAcceptedCharge = undefined;
    this.acceptedChargeCurrent = 0;
    this.pendingIntegration = undefined;
  }

  setTemperature(value: number): void {
    // ngspice-47 dio.c:14-15, dioparam.c:51-57, diotemp.c:291-296:
    // TEMP replaces CKTtemp and DTEMP, including for self-heating instances.
    this.ambientTemperature = this.instanceParams.TEMP ?? value + (this.instanceParams.DTEMP ?? 0);
    this.temperature = this.ambientTemperature;
    this.applyTemperature();
  }

  /**
   * ngspice-47 diotemp.c (TLEV = 0) at the device temperature: the
   * saturation currents follow exp((T/TNOM - 1)*EG/(N*vt) + XTI/N*ln(T/TNOM))
   * (the sidewall current with its emission coefficient NS, default 1), and the
   * junction potentials and zero-bias capacitances follow the REFTEMP-mapped
   * band-gap law. BV is mapped in {@link breakdownParams}; RS follows the
   * TRS1/TRS2 polynomial. TLEVC=1 instead uses a linear law about REFTEMP,
   * not TNOM, even when the device is at its nominal temperature.
   */
  private applyTemperature(): void {
    const nominal = this.nominal;
    const params = this.params;
    const kelvin = this.temperature + KELVIN_OFFSET;
    const nominalKelvin = params.TNOM + KELVIN_OFFSET;
    // ngspice-47 diotemp.c:253-258 (DIOresistGiven && RS != 0): conductance
    // AREA*M/RS divided by 1 + TRS1*dT + TRS2*dT^2, so RS(T) scales by it.
    const dt = kelvin - nominalKelvin;
    params.RS = nominal.RS * (1 + params.TRS1! * dt + params.TRS2! * dt * dt);
    // ngspice-47 diotemp.c:52-55,248-251. Always use immutable nominal values.
    params.M = nominal.M * (1 + params.TM1! * dt + params.TM2! * dt * dt);
    params.TT = nominal.TT * (1 + params.TTT1! * dt + params.TTT2! * dt * dt);
    if (params.TLEVC === 1) {
      // diotemp.c:92-96,108-112: these four coefficients use Temp-REFTEMP.
      const referenceDelta = this.temperature - 27;
      params.VJ = nominal.VJ - params.TPB! * referenceDelta;
      params.CJ0 = nominal.CJ0 * (1 + params.CTA! * referenceDelta);
      params.VJSW = nominal.VJSW - params.TPHP! * referenceDelta;
      params.CJSW = nominal.CJSW * (1 + params.CTP! * referenceDelta);
    } else if (kelvin === nominalKelvin) {
      params.CJ0 = nominal.CJ0;
      params.CJSW = nominal.CJSW;
      params.VJ = nominal.VJ;
      params.VJSW = nominal.VJSW;
    } else {
      // diotemp.c:82-91,98-107: only the bottom grading is temperature adjusted.
      const bottom = temperatureJunction(nominal.VJ, nominal.CJ0, params.M, kelvin, nominalKelvin);
      const sidewall = temperatureJunction(nominal.VJSW, nominal.CJSW, params.MJSW!, kelvin, nominalKelvin);
      params.VJ = bottom.potential;
      params.CJ0 = bottom.capacitance;
      params.VJSW = sidewall.potential;
      params.CJSW = sidewall.capacitance;
    }
    if (kelvin === nominalKelvin) {
      this.bottomSaturationCurrent = nominal.areaSaturationCurrent;
      this.sidewallSaturationCurrent = nominal.sidewallSaturationCurrent;
      params.IS = nominal.areaSaturationCurrent + nominal.sidewallSaturationCurrent;
      return;
    }
    const vt = K_OVER_Q * kelvin;
    const activationEnergy = params.EG!;
    const exponent = params.XTI!;
    const ratio = kelvin / nominalKelvin;
    const saturationScale = (emission: number) => Math.exp(
      (ratio - 1) * activationEnergy / (emission * vt) + exponent / emission * Math.log(ratio),
    );
    this.bottomSaturationCurrent = nominal.areaSaturationCurrent * saturationScale(params.N);
    this.sidewallSaturationCurrent = nominal.sidewallSaturationCurrent * saturationScale(params.NS!);
    params.IS = this.bottomSaturationCurrent + this.sidewallSaturationCurrent;
  }

  getTemperature(): number {
    return this.temperature;
  }

  /**
   * Kept for the `.disto` driver. The thermal voltage is kT/q in every mode now,
   * so distortion no longer needs a different junction law.
   */
  setDistortionMode(_enabled: boolean): void {}

  private junction(): Junction {
    const vt = thermalVoltageAt(this.temperature);
    const ownCharacteristic = this.separateSidewall;
    return {
      thermalVoltage: this.params.N * vt,
      saturationCurrent: this.params.IS,
      bottomSaturationCurrent: this.bottomSaturationCurrent,
      sidewall: this.suppliedParams.JSW !== undefined
        ? {
          thermalVoltage: (ownCharacteristic ? this.params.NS! : this.params.N) * vt,
          saturationCurrent: this.sidewallSaturationCurrent,
          ownCharacteristic,
        }
        : undefined,
      breakdown: this.breakdownParams(),
      kneeCurrent: this.params.IKF!,
      reverseKneeCurrent: this.params.IKR!,
      sidewallKneeCurrent: this.params.IKP!,
    };
  }

  /** Reject diode fields outside the bounded `.disto` slice (no solution needed). */
  assertDistortionSupported(): void {
    const supported = new Set(['IS', 'TT', 'CJ0', 'CJO', 'RS']);
    const unsupported = Object.keys(this.suppliedParams).filter(name => !supported.has(name));
    if (unsupported.length > 0) {
      throw new InvalidCircuitError(
        `.disto diode '${this.name}' does not support model parameter ${unsupported[0]}`,
      );
    }
    if (Object.keys(this.instanceParams).length > 0) {
      throw new InvalidCircuitError(
        `.disto diode '${this.name}' supports only default instance geometry`,
      );
    }
    if (this.suppliedParams.RS !== undefined
        || this.hasExternalSeriesResistance || this.params.RS !== 0) {
      throw new InvalidCircuitError(`.disto diode '${this.name}' does not support series resistance`);
    }
    if (this.temperature !== 27) {
      throw new InvalidCircuitError(`.disto diode '${this.name}' does not support temperature overrides`);
    }
  }

  distortionCoefficients(solution: Float64Array): DiodeDistortionCoefficients {
    this.assertDistortionSupported();
    const [nA, nK] = this.nodes;
    const voltage = (nA >= 0 ? solution[nA] : 0) - (nK >= 0 ? solution[nK] : 0);
    const { IS, N, TT, CJ0: distortionCapacitance } = this.params;
    const thermalVoltage = N * thermalVoltageAt(this.temperature);
    const conductance = (IS / thermalVoltage) * safeExponential(voltage / thermalVoltage);
    const current2 = conductance / (2 * thermalVoltage);
    const current3 = conductance / (6 * thermalVoltage * thermalVoltage);
    const { VJ, M, FC } = this.params;
    const depletion = depletionChargeTaylor(voltage, distortionCapacitance!, VJ!, M!, FC!);
    return {
      current2,
      current3,
      charge2: TT! * current2 + depletion.second,
      charge3: TT! * current3 + depletion.third,
    };
  }

  stampDistortionDynamic(ctx: StampContext): void {
    const { IS, N, TT, CJ0: distortionCapacitance } = this.params;
    if (!distortionCapacitance && !TT) return;
    const [nA, nK] = this.nodes;
    const voltage = (nA >= 0 ? ctx.getVoltage(nA) : 0) - (nK >= 0 ? ctx.getVoltage(nK) : 0);
    const thermalVoltage = N * thermalVoltageAt(this.temperature);
    const conductance = (IS / thermalVoltage) * safeExponential(voltage / thermalVoltage);
    const { VJ, M, FC } = this.params;
    const capacitance = depletionChargeTaylor(voltage, distortionCapacitance!, VJ!, M!, FC!)
      .capacitance + TT! * conductance;
    if (nA >= 0) ctx.stampC(nA, nA, capacitance);
    if (nK >= 0) ctx.stampC(nK, nK, capacitance);
    if (nA >= 0 && nK >= 0) {
      ctx.stampC(nA, nK, -capacitance);
      ctx.stampC(nK, nA, -capacitance);
    }
  }

  private breakdownParams(): BreakdownParams | undefined {
    const { BV, IBV, TBV1, TBV2, NBV, TNOM, LEVEL } = this.params;
    if (!Number.isFinite(BV) || BV <= 0 || !Number.isFinite(IBV) || IBV <= 0) {
      return undefined;
    }
    const thermalVoltage = thermalVoltageAt(this.temperature);
    const delta = this.temperature - TNOM;
    return {
      voltage: LEVEL === 2
        // PSpice/Xyce level-2 law (#319).
        ? BV * (1 + TBV1 * delta + TBV2 * delta * delta)
        // ngspice-47 diotemp.c:211-212 (TLEV=0): BV(T) = BV - TCV*(T - TNOM).
        : BV - TBV1 * delta,
      // ngspice-47 diotemp.c:216-217 (LEVEL=1): cbv = M*IBV. The instance
      // multiplier scales IBV like it scales IS; AREA does not scale IBV.
      current: IBV * (this.instanceParams.M ?? 1),
      // ngspice-47 dioload.c:109/322: vtebrk = NBV*vt.
      thermalVoltage: NBV * thermalVoltage,
      junctionThermalVoltage: thermalVoltage,
    };
  }

  /** DC junction current for device readouts and small-signal shot/flicker noise. */
  noiseOperatingPoint(solution: Float64Array, gmin = DEVICE_GMIN): {
    current: number;
    flickerCoefficient: number;
    flickerExponent: number;
    parallelMultiplier: number;
  } {
    if (this.selfHeating) {
      this.temperature = this.ambientTemperature + solution[this.nodes[2]];
      this.applyTemperature();
    }
    const [nA, nK] = this.nodes;
    const terminalVoltage = (nA >= 0 ? solution[nA] : 0) - (nK >= 0 ? solution[nK] : 0);
    const { RS, KF, AF } = this.params;
    const currentVoltage = this.currentControlNode === undefined ? terminalVoltage
      : (this.currentControlNode >= 0 ? solution[this.currentControlNode] : 0) - (nK >= 0 ? solution[nK] : 0);
    const { current, junctionVoltage } = diodeCurrent(currentVoltage, this.junction(), RS);
    return {
      // dionoise.c takes the shot noise from DIOcurrent, cdb + cdsw + GMIN*vd.
      current: current + gmin * (this.currentControlNode === undefined ? junctionVoltage : terminalVoltage),
      flickerCoefficient: KF!,
      flickerExponent: AF!,
      parallelMultiplier: this.instanceParams.M ?? 1,
    };
  }

  /** ngspice-47 dioask.c DIO_CAP (`cd`): depletion + diffusion dQ/dV,
   * at the inner junction voltage, not the terminal voltage behind RS.
   */
  outputCapacitance(solution: Float64Array, gmin = DEVICE_GMIN): number {
    if (this.selfHeating) {
      this.temperature = this.ambientTemperature + solution[this.nodes[2]];
      this.applyTemperature();
    }
    const [nA, nK] = this.nodes;
    const voltage = (nA >= 0 ? solution[nA] : 0) - (nK >= 0 ? solution[nK] : 0);
    const { junctionVoltage } = diodeCurrent(voltage, this.junction(), this.params.RS);
    return this.junctionCharge(junctionVoltage, gmin).capacitance;
  }

  private ambientTemperature = 27;

  private get selfHeating(): boolean {
    return (this.nodes[2] ?? -1) >= 0 && this.instanceParams.THERMAL === 1
      && this.suppliedParams.RTH0 !== undefined;
  }

  /** Thermal fluctuation sources and their electro-thermal correlations are not modeled. */
  get supportsNoise(): boolean {
    return !this.selfHeating;
  }

  stampSmallSignal(ctx: StampContext): void {
    // stampThermal evaluates dI/dT and the power derivatives at the converged
    // hot operating point.
    this.stamp(ctx);
    if (this.selfHeating) {
      // ngspice-47 dioacld uses state[DIOcqth]*omega, but dioload does not
      // initialize DIOcqth to CTH0 in MODEINITSMSIG. Thus intrinsic CTH0 is
      // absent in AC (unlike transient). Cancel only the compiled intrinsic
      // capacitor; explicit external thermal capacitors remain active.
      ctx.stampC(this.nodes[2], this.nodes[2], -(this.suppliedParams.CTH0 ?? 1e-5));
    }
  }

  stamp(ctx: StampContext): void {
    if (this.selfHeating) {
      this.stampThermal(ctx);
      return;
    }
    const [nA, nK] = this.nodes;
    const vA = nA >= 0 ? ctx.getVoltage(nA) : 0;
    const vK = nK >= 0 ? ctx.getVoltage(nK) : 0;
    const junction = this.junction();
    let vd = vA - vK;

    this.limited = false;
    if (this.limitsOwnJunctions) {
      if (this.newtonJunctionVoltage !== undefined) vd = this.newtonJunctionVoltage;
      const predicted = this.predictJunction ? this.predictedJunctionVoltage(ctx.dt) : undefined;
      if (predicted !== undefined) vd = predicted;
      this.predictJunction = false;
      this.newtonJunctionVoltage = undefined;
      // ngspice dioload.c limits the junction relative to the previous Newton
      // iterate (CKTstate0 DIOvoltage) and stores the limited value back, in
      // DC and transient alike. Limiting only shapes iterates: once a step is
      // within 2*Vte it is the identity, so the converged point is on the
      // exact diode law (#430). A limited iterate is not converged (noncon).
      const limited = limitJunctionStep(vd, this.previousJunctionVoltage ?? 0, junction);
      this.limited = limited !== vd;
      vd = limited;
      this.previousJunctionVoltage = vd;
    }
    this.stampedJunctionVoltage = vd;

    // ngspice-47 dioload.c:385-388 evaluates the default-NS sidewall current
    // at the bottom voltage even with RSW. Its companion conductance is still
    // stamped at the sidewall node (also in AC), not as a transconductance.
    const currentVoltage = this.currentControlNode === undefined ? vd
      : (this.currentControlNode >= 0 ? ctx.getVoltage(this.currentControlNode) : 0) - vK;
    const { current: id, conductance, linearizationVoltage: currentLinearizationVoltage } = diodeCurrent(
      currentVoltage,
      junction,
      this.params.RS,
    );
    const linearizationVoltage = this.currentControlNode === undefined
      ? currentLinearizationVoltage : vd;
    const gmin = ctx.gmin ?? DEVICE_GMIN;
    // ngspice dioload.c: cd = cdb + cdsw + CKTgmin*vd, gd = gdb + gdsw + CKTgmin.
    const gd = conductance + gmin;

    // Newton-Raphson companion: I = gd * Vd + Ieq
    const ieq = id + gmin * linearizationVoltage - gd * linearizationVoltage;

    if (nA >= 0) ctx.stampG(nA, nA, gd);
    if (nK >= 0) ctx.stampG(nK, nK, gd);
    if (nA >= 0 && nK >= 0) {
      ctx.stampG(nA, nK, -gd);
      ctx.stampG(nK, nA, -gd);
    }

    if (nA >= 0) ctx.stampB(nA, -ieq);
    if (nK >= 0) ctx.stampB(nK, ieq);
  }

  /** Reduced RS/junction system with temperature-dependent current and power. */
  private stampThermal(ctx: StampContext): void {
    const [a, k, t] = this.nodes;
    const voltage = (a >= 0 ? ctx.getVoltage(a) : 0) - (k >= 0 ? ctx.getVoltage(k) : 0);
    const rise = ctx.getVoltage(t);
    const temperature = this.ambientTemperature + rise;
    const evaluate = (temp: number) => {
      this.temperature = temp;
      this.applyTemperature();
      return diodeCurrent(voltage, this.junction(), this.params.RS);
    };
    // Central difference includes both the junction law and RS(TRS1,TRS2).
    const delta = 1e-3;
    const plus = evaluate(temperature + delta).current;
    const minus = evaluate(temperature - delta).current;
    const point = evaluate(temperature);
    this.stampedJunctionVoltage = voltage;
    const current = point.current;
    const conductance = point.conductance;
    const dIdT = (plus - minus) / (2 * delta);
    const ieq = current - conductance * voltage - dIdT * rise;
    for (const [row, sign] of [[a, 1], [k, -1]]) {
      if (row < 0) continue;
      if (a >= 0) ctx.stampG(row, a, sign * conductance);
      if (k >= 0) ctx.stampG(row, k, -sign * conductance);
      ctx.stampG(row, t, sign * dIdT);
      ctx.stampB(row, -sign * ieq);
    }
    // ngspice-47 dioload.c:749-759: junction heat plus RS Joule heat = V*I.
    const dPdV = current + voltage * conductance;
    const dPdT = voltage * dIdT;
    if (a >= 0) ctx.stampG(t, a, -dPdV);
    if (k >= 0) ctx.stampG(t, k, dPdV);
    ctx.stampG(t, t, 1 / this.suppliedParams.RTH0! - dPdT);
    ctx.stampB(t, voltage * current - dPdV * voltage - dPdT * rise);
  }

  stampDynamic(ctx: StampContext): void {
    const { CJ0, CJSW, VJ, VJSW, M, MJSW, FC, FCS, TT, RS } = this.params;
    if (!CJ0 && !CJSW && !TT) return;

    const [nA, nK] = this.nodes;
    const vA = nA >= 0 ? ctx.getVoltage(nA) : 0;
    const vK = nK >= 0 ? ctx.getVoltage(nK) : 0;
    const terminalVoltage = vA - vK;
    const junction = this.junction();

    // RS separates the external terminal from the charge-storing junction. The
    // two-terminal reduction therefore needs dVj/dVt as well as dQ/dVj.
    const operatingPoint = RS > 0
      ? diodeCurrent(terminalVoltage, junction, RS)
      : undefined;
    const junctionVoltage = operatingPoint?.junctionVoltage ?? terminalVoltage;
    const junctionVoltageGain = operatingPoint
      ? 1 / (1 + RS * operatingPoint.junctionConductance)
      : 1;

    let cj = depletionChargeTaylor(junctionVoltage, CJ0!, VJ!, M!, FC!).capacitance;
    cj += depletionChargeTaylor(junctionVoltage, CJSW!, VJSW!, MJSW!, FCS!).capacitance;

    if (TT) {
      // ngspice: diffcap = TT*gd, with gd including GMIN.
      const junctionConductance = operatingPoint?.junctionConductance
        ?? junctionCurrent(terminalVoltage, junction).conductance;
      cj += TT * (junctionConductance + (ctx.gmin ?? DEVICE_GMIN));
    }

    // A two-terminal fallback can only represent the low-frequency reduction.
    // Compiled circuits expand RS into a physical resistor and internal junction
    // node, preserving the complete frequency-dependent pole.
    cj *= junctionVoltageGain * junctionVoltageGain;

    if (nA >= 0) ctx.stampC(nA, nA, cj);
    if (nK >= 0) ctx.stampC(nK, nK, cj);
    if (nA >= 0 && nK >= 0) {
      ctx.stampC(nA, nK, -cj);
      ctx.stampC(nK, nA, -cj);
    }
  }

  /**
   * Transient junction charge companion, as ngspice dioload.c integrates
   * DIOcapCharge with NIintegrate: the current is the integrated dQ/dt of the
   * charge q(v), not C(v)*dv/dt, so the stored charge is conserved across a
   * nonlinear swing (#403).
   */
  stampTransientCharge(ctx: StampContext, integration: ChargeIntegration): void {
    const voltage = this.stampedJunctionVoltage;
    const thermalNode = this.selfHeating ? this.nodes[2] : -1;
    const rise = thermalNode >= 0 ? ctx.getVoltage(thermalNode) : 0;
    let temperatureCurrent = 0;
    if (thermalNode >= 0) {
      // Differentiate Q(V,T), including depletion and TT(T)*I(V,T), at fixed V.
      // Only accepted charges enter the integration history, never trial temperatures.
      const evaluate = (temperature: number) => {
        this.temperature = temperature;
        this.applyTemperature();
        const point = this.junctionCharge(voltage, ctx.gmin ?? DEVICE_GMIN);
        return this.integrateCharge(point.charge, point.capacitance, integration).current;
      };
      const temperature = this.ambientTemperature + rise;
      temperatureCurrent = (evaluate(temperature + 1e-3) - evaluate(temperature - 1e-3)) / 2e-3;
      this.temperature = temperature;
      this.applyTemperature();
    }
    const { charge, capacitance } = this.junctionCharge(voltage, ctx.gmin ?? DEVICE_GMIN);
    const { current, conductance } = this.integrateCharge(charge, capacitance, integration);
    this.pendingIntegration = integration;

    const [nA, nK] = this.nodes;
    const ieq = current - conductance * voltage - temperatureCurrent * rise;
    if (nA >= 0) ctx.stampG(nA, nA, conductance);
    if (nK >= 0) ctx.stampG(nK, nK, conductance);
    if (nA >= 0 && nK >= 0) {
      ctx.stampG(nA, nK, -conductance);
      ctx.stampG(nK, nA, -conductance);
    }
    if (nA >= 0) ctx.stampB(nA, -ieq);
    if (nK >= 0) ctx.stampB(nK, ieq);
    if (thermalNode >= 0) {
      if (nA >= 0) ctx.stampG(nA, thermalNode, temperatureCurrent);
      if (nK >= 0) ctx.stampG(nK, thermalNode, -temperatureCurrent);
      // dioload.c evaluates Ith = vd*cd after adding integrated charge current.
      const dPdV = current + voltage * conductance;
      const dPdT = voltage * temperatureCurrent;
      if (nA >= 0) ctx.stampG(thermalNode, nA, -dPdV);
      if (nK >= 0) ctx.stampG(thermalNode, nK, dPdV);
      ctx.stampG(thermalNode, thermalNode, -dPdT);
      ctx.stampB(thermalNode, voltage * current - dPdV * voltage - dPdT * rise);
    }
  }

  stampAcceptedChargeCurrent(ctx: StampContext): void {
    // The accepted electrical current must also contribute junction power.
    const [nA, nK] = this.nodes;
    if (nA >= 0) ctx.stampB(nA, -this.acceptedChargeCurrent);
    if (nK >= 0) ctx.stampB(nK, this.acceptedChargeCurrent);
    if (this.selfHeating) {
      const voltage = (nA >= 0 ? ctx.getVoltage(nA) : 0) - (nK >= 0 ? ctx.getVoltage(nK) : 0);
      ctx.stampB(this.nodes[2], voltage * this.acceptedChargeCurrent);
    }
  }

  /** Commit the junction charge and its integrated current at an accepted timepoint. */
  private acceptCharge(junctionVoltage: number, gmin: number): void {
    const { charge, capacitance } = this.junctionCharge(junctionVoltage, gmin);
    const integration = this.pendingIntegration;
    this.pendingIntegration = undefined;
    if (integration === undefined || this.acceptedCharge === undefined) {
      // Initial operating point: the charge is at rest (ngspice copies
      // CKTstate0 into CKTstate1 with a zero capacitor current at MODEINITTRAN).
      this.acceptedCharge = charge;
      this.previousAcceptedCharge = undefined;
      this.olderAcceptedCharge = undefined;
      this.oldestAcceptedCharge = undefined;
      this.acceptedChargeCurrent = 0;
      return;
    }
    this.acceptedChargeCurrent = this.integrateCharge(charge, capacitance, integration).current;
    this.oldestAcceptedCharge = this.olderAcceptedCharge;
    this.olderAcceptedCharge = this.previousAcceptedCharge;
    this.previousAcceptedCharge = this.acceptedCharge;
    this.acceptedCharge = charge;
  }

  /** The junction charge is truncated exactly as ngspice DIOtrunc does (#621). */
  get truncationCoversCharges(): boolean {
    return this.integratesTransientCharge;
  }

  /**
   * ngspice DIOtrunc: CKTterr on the junction charge DIOcapCharge (bottom,
   * sidewall and diffusion), evaluated at the converged trial solution in
   * `ctx` against the accepted history. RSW and soft reverse recovery, the
   * other DIOtrunc charges, are not supported.
   */
  truncateTransientStep(ctx: StampContext, truncation: ChargeTruncation): number {
    if (this.selfHeating) {
      this.temperature = this.ambientTemperature + ctx.getVoltage(this.nodes[2]);
      this.applyTemperature();
    }
    const integration = this.pendingIntegration;
    const accepted = this.acceptedCharge;
    const previous = this.previousAcceptedCharge;
    if (!this.integratesTransientCharge || integration === undefined || accepted === undefined) return Infinity;
    const secondOrder = truncation.order !== undefined
      ? truncation.order === 2
      : integration.method === 'trapezoidal'
        || (integration.method === 'gear2' && integration.prevDt !== undefined && previous !== undefined);
    // Order 1 needs q(n+1), q(n), q(n-1); order 2 one point more.
    if (previous === undefined || (secondOrder && this.olderAcceptedCharge === undefined)) return Infinity;
    const [nA, nK] = this.nodes;
    const voltage = (nA >= 0 ? ctx.getVoltage(nA) : 0) - (nK >= 0 ? ctx.getVoltage(nK) : 0);
    const { charge, capacitance } = this.junctionCharge(voltage, ctx.gmin ?? DEVICE_GMIN);
    const { current } = this.integrateCharge(charge, capacitance, integration);
    if (truncation.order === undefined && this.usesGear3(integration)) {
      if (this.oldestAcceptedCharge === undefined || truncation.olderDelta === undefined) return Infinity;
      const { deltas, reltol, abstol, chgtol, trtol } = truncation;
      const intervals = [...deltas, truncation.olderDelta];
      const diff = [charge, accepted, previous, this.olderAcceptedCharge!, this.oldestAcceptedCharge];
      // CKTterr's fourth divided difference, matching the shared charge kernel.
      for (let level = 1; level <= 4; level++) {
        for (let i = 0; i < 5 - level; i++) {
          let span = 0;
          for (let j = i; j < i + level; j++) span += intervals[j];
          diff[i] = (diff[i] - diff[i + 1]) / span;
        }
      }
      const currentTolerance = abstol + reltol * Math.max(Math.abs(current), Math.abs(this.acceptedChargeCurrent));
      const chargeTolerance = reltol * Math.max(Math.abs(charge), Math.abs(accepted), chgtol) / deltas[0];
      return Math.cbrt(trtol * Math.max(currentTolerance, chargeTolerance)
        / Math.max(abstol, 0.1363636364 * Math.abs(diff[0])));
    }
    return chargeTruncationTimestep(
      secondOrder ? integration.method : 'euler', secondOrder ? 2 : 1,
      charge, accepted, previous, this.olderAcceptedCharge ?? 0,
      current, this.acceptedChargeCurrent, truncation,
    );
  }

  /** Depletion (bottom + sidewall) plus diffusion charge and dQ/dV (ngspice dioload.c). */
  private junctionCharge(voltage: number, gmin: number): { charge: number; capacitance: number } {
    const { CJ0, CJSW, VJ, VJSW, M, MJSW, FC, FCS, TT } = this.params;
    const bottom = depletionCharge(voltage, CJ0!, VJ!, M!, FC!);
    // ngspice-47 dioload.c:559 offsets the sidewall charge above FCS*VJSW with
    // the bottom junction's F1 (DIOtF1 = VJ*(1-(1-FC)^(1-M))/(1-M)), not a
    // sidewall F1, so the charge steps at FCS*VJSW by CJSW*(F1 - F1sw)
    // whenever the two differ. The capacitance is unaffected (#450).
    const sidewall = depletionCharge(
      voltage, CJSW!, VJSW!, MJSW!, FCS!, abruptJunctionCharge(FC! * VJ!, 1, VJ!, M!),
    );
    let charge = bottom.charge + sidewall.charge;
    let capacitance = bottom.capacitance + sidewall.capacitance;
    if (TT) {
      // ngspice: diffcharge = TT*cd, diffcap = TT*gd, with cd and gd including GMIN.
      const { current, conductance } = junctionCurrent(voltage, this.junction());
      charge += TT * (current + gmin * voltage);
      capacitance += TT * (conductance + gmin);
    }
    return { charge, capacitance };
  }

  private usesGear3(integration: ChargeIntegration): boolean {
    return integration.method === 'gear2' && integration.order === 3
      && integration.prevDt !== undefined && integration.prevPrevDt !== undefined
      && this.previousAcceptedCharge !== undefined && this.olderAcceptedCharge !== undefined;
  }

  /** ngspice NIintegrate for one charge: returns the capacitor current and its dI/dV. */
  private integrateCharge(
    charge: number,
    capacitance: number,
    integration: ChargeIntegration,
  ): { current: number; conductance: number } {
    const { method, dt, prevDt, prevPrevDt } = integration;
    const previous = this.acceptedCharge ?? charge;
    if (this.usesGear3(integration)) {
      const [a1, a2, a3, a4] = gear3Coefficients(dt, prevDt!, prevPrevDt!);
      return {
        current: a1 * charge + a2 * previous + a3 * this.previousAcceptedCharge! + a4 * this.olderAcceptedCharge!,
        conductance: a1 * capacitance,
      };
    }
    if (method === 'trapezoidal') {
      const factor = 2 / dt;
      return {
        current: factor * (charge - previous) - this.acceptedChargeCurrent,
        conductance: factor * capacitance,
      };
    }
    if (method === 'gear2' && prevDt !== undefined && this.previousAcceptedCharge !== undefined) {
      const alpha = prevDt / dt;
      const a1 = (2 + alpha) / ((1 + alpha) * dt);
      const a2 = (1 + alpha) / (alpha * dt);
      const a3 = 1 / (alpha * (1 + alpha) * dt);
      return {
        current: a1 * charge - a2 * previous + a3 * this.previousAcceptedCharge,
        conductance: a1 * capacitance,
      };
    }
    return { current: (charge - previous) / dt, conductance: capacitance / dt };
  }
}

/**
 * Depletion charge and capacitance of one junction component, as ngspice
 * dioload.c: Q = VJ*CJ0*(1 - (1-V/VJ)^(1-M))/(1-M) below FC*VJ, and the
 * integral of the linear capacitance extension above it. Above FC*VJ the
 * extension starts from CJ0*F1; `f1` overrides F1 (default: this junction's
 * own, which keeps Q C^1) for the ngspice sidewall quirk.
 */
function depletionCharge(
  voltage: number,
  zeroBiasCapacitance: number,
  junctionPotential: number,
  gradingCoefficient: number,
  forwardCoefficient: number,
  f1?: number,
): { charge: number; capacitance: number } {
  if (!zeroBiasCapacitance) return { charge: 0, capacitance: 0 };
  const { capacitance } = depletionChargeTaylor(
    voltage, zeroBiasCapacitance, junctionPotential, gradingCoefficient, forwardCoefficient,
  );
  const threshold = forwardCoefficient * junctionPotential;
  if (voltage < threshold) {
    return {
      charge: abruptJunctionCharge(voltage, zeroBiasCapacitance, junctionPotential, gradingCoefficient),
      capacitance,
    };
  }
  const continuation = Math.pow(1 - forwardCoefficient, 1 + gradingCoefficient);
  const linear = 1 - forwardCoefficient * (1 + gradingCoefficient);
  const extension = zeroBiasCapacitance / continuation * (
    linear * (voltage - threshold)
    + gradingCoefficient / (2 * junctionPotential) * (voltage * voltage - threshold * threshold)
  );
  const offset = f1 === undefined
    ? abruptJunctionCharge(threshold, zeroBiasCapacitance, junctionPotential, gradingCoefficient)
    : zeroBiasCapacitance * f1;
  return {
    charge: offset + extension,
    capacitance,
  };
}

/** Charge stored between 0 and V on the abrupt-junction law CJ0/(1-V/VJ)^M. */
function abruptJunctionCharge(
  voltage: number,
  zeroBiasCapacitance: number,
  junctionPotential: number,
  gradingCoefficient: number,
): number {
  const depletion = 1 - voltage / junctionPotential;
  const exponent = 1 - gradingCoefficient;
  return Math.abs(exponent) < 1e-12
    ? -junctionPotential * zeroBiasCapacitance * Math.log(depletion)
    : junctionPotential * zeroBiasCapacitance * (1 - Math.pow(depletion, exponent)) / exponent;
}

/**
 * Resolve the zero-bias junction capacitance. ngspice accepts CJO, CJ0 and CJ
 * for the same model field; conflicting values are rejected rather than
 * silently picking one.
 */
export function diodeZeroBiasCapacitance(
  name: string,
  params: Readonly<DiodeModelInput>,
): number | undefined {
  return canonicalDiodeModelParams(name, params).CJO;
}

/**
 * Depletion capacitance dQ/dV and its Taylor terms, as in ngspice dioload.c:
 * the abrupt-junction law below FC*VJ, and above it the linear extension
 * C = CJ0/F2 * (F3 + M*V/VJ) with F2 = (1-FC)^(1+M), F3 = 1 - FC*(1+M),
 * which keeps the capacitance continuous at V = FC*VJ.
 */
function depletionChargeTaylor(
  junctionVoltage: number,
  zeroBiasCapacitance: number,
  junctionPotential: number,
  gradingCoefficient: number,
  forwardCoefficient: number,
): ChargeTaylorCoefficients {
  if (!zeroBiasCapacitance) return { capacitance: 0, second: 0, third: 0 };
  if (junctionVoltage < forwardCoefficient * junctionPotential) {
    const depletion = 1 - junctionVoltage / junctionPotential;
    const capacitance = zeroBiasCapacitance / Math.pow(depletion, gradingCoefficient);
    const second = capacitance * gradingCoefficient
      / (2 * junctionPotential * depletion);
    return {
      capacitance,
      second,
      third: second * (gradingCoefficient + 1)
        / (3 * junctionPotential * depletion),
    };
  }
  const continuation = Math.pow(1 - forwardCoefficient, 1 + gradingCoefficient);
  return {
    capacitance: zeroBiasCapacitance / continuation * (
      1 - forwardCoefficient * (1 + gradingCoefficient)
      + gradingCoefficient * junctionVoltage / junctionPotential
    ),
    second: zeroBiasCapacitance * gradingCoefficient
      / (2 * junctionPotential * continuation),
    third: 0,
  };
}

function diodeCurrent(
  terminalVoltage: number,
  junction: Junction,
  seriesResistance: number,
): {
  current: number;
  conductance: number;
  junctionConductance: number;
  junctionVoltage: number;
  linearizationVoltage: number;
} {
  const { thermalVoltage, saturationCurrent } = junction;
  if (seriesResistance === 0) {
    const { current, conductance } = junctionCurrent(terminalVoltage, junction);
    return {
      current,
      conductance,
      junctionConductance: conductance,
      junctionVoltage: terminalVoltage,
      linearizationVoltage: terminalVoltage,
    };
  }

  let junctionVoltage = terminalVoltage;
  if (terminalVoltage > 0) {
    junctionVoltage = Math.min(
      terminalVoltage,
      thermalVoltage * Math.log1p(terminalVoltage / (seriesResistance * saturationCurrent)),
    );
  }

  for (let iteration = 0; iteration < 12; iteration++) {
    const { current, conductance } = junctionCurrent(junctionVoltage, junction);
    const correction = (junctionVoltage + seriesResistance * current - terminalVoltage)
      / (1 + seriesResistance * conductance);
    junctionVoltage -= correction;
    if (Math.abs(correction) <= 1e-12) break;
  }

  const { current, conductance } = junctionCurrent(junctionVoltage, junction);
  return {
    current,
    conductance: conductance / (1 + seriesResistance * conductance),
    junctionConductance: conductance,
    junctionVoltage,
    linearizationVoltage: terminalVoltage,
  };
}

/**
 * Junction current as ngspice-47 dioload.c computes it without RSW: the
 * bottom current cdb and, when JSW is given, the sidewall current cdsw, each
 * with its own knee (IKF/IKR on cdb, IKP on cdsw). The caller adds GMIN*vd.
 */
function junctionCurrent(
  voltage: number,
  junction: Junction,
): { current: number; conductance: number } {
  const bottom = bottomCurrent(voltage, junction);
  if (!junction.sidewall) return bottom;
  const sidewall = applyForwardKnee(
    sidewallCurrent(voltage, junction.sidewall, junction),
    junction.sidewallKneeCurrent,
  );
  return {
    current: bottom.current + sidewall.current,
    conductance: bottom.conductance + sidewall.conductance,
  };
}

/**
 * Bottom current cdb of the N characteristic: the exponential law at and above
 * -3*N*vt with the IKF knee, below it the reverse law and, beyond the
 * breakdown knee, the breakdown law, both with the IKR knee.
 */
function bottomCurrent(
  voltage: number,
  junction: Junction,
): { current: number; conductance: number } {
  const { thermalVoltage, bottomSaturationCurrent, kneeCurrent, reverseKneeCurrent } = junction;
  const current = pnJunctionCurrent(voltage, thermalVoltage, bottomSaturationCurrent, junction, voltage);
  return voltage >= -3 * thermalVoltage
    ? applyForwardKnee(current, kneeCurrent)
    : applyReverseKnee(current, reverseKneeCurrent);
}

/**
 * Sidewall current cdsw. With NS given it has its own NS characteristic and
 * breaks down at vd. Without NS it shares the N characteristic, and dioload.c
 * evaluates its breakdown law at vdsw, which stays 0 without RSW, so the
 * sidewall carries only csatsw*exp(-BVknee/(NBV*vt)) in breakdown.
 */
function sidewallCurrent(
  voltage: number,
  { thermalVoltage, saturationCurrent, ownCharacteristic }: SidewallJunction,
  junction: Junction,
): { current: number; conductance: number } {
  return pnJunctionCurrent(
    voltage, thermalVoltage, saturationCurrent, junction, ownCharacteristic ? voltage : 0,
  );
}

/**
 * ngspice-47 dioload.c pn law for one junction component: csat*(exp(vd/vte)-1)
 * at and above -3*vte, the reverse law -csat*(1 + (3*vte/(vd*e))^3) below it
 * while vd >= -BVknee (or without BV), and the breakdown law
 * -csat*exp(-(BVknee + vbreak)/(NBV*vt)) beyond the knee.
 */
function pnJunctionCurrent(
  voltage: number,
  thermalVoltage: number,
  saturationCurrent: number,
  { saturationCurrent: totalSaturationCurrent, breakdown }: Junction,
  breakdownVoltage: number,
): { current: number; conductance: number } {
  if (voltage >= -3 * thermalVoltage) {
    const exponential = safeExponential(voltage / thermalVoltage);
    return {
      current: saturationCurrent * (exponential - 1),
      conductance: saturationCurrent * exponential / thermalVoltage,
    };
  }
  // dioload.c: the reverse law applies when `!BVgiven || vd >= -tBrkdwnV`.
  const knee = breakdown ? breakdownKneeVoltage(breakdown, totalSaturationCurrent) : 0;
  if (!breakdown || voltage >= -knee) {
    const root = 3 * thermalVoltage / (voltage * Math.E);
    const cube = root * root * root;
    return {
      current: -saturationCurrent * (1 + cube),
      conductance: saturationCurrent * 3 * cube / voltage,
    };
  }
  const exponential = safeExponential(-(knee + breakdownVoltage) / breakdown.thermalVoltage);
  return {
    current: -saturationCurrent * exponential,
    conductance: saturationCurrent * exponential / breakdown.thermalVoltage,
  };
}

/** High-injection roll-off above a forward knee current, IKF or IKP (ngspice dioload.c). */
function applyForwardKnee(
  { current, conductance }: { current: number; conductance: number },
  kneeCurrent: number,
): { current: number; conductance: number } {
  if (kneeCurrent <= 0 || current <= KNEE_CURRENT_THRESHOLD) return { current, conductance };
  const root = Math.sqrt(current / kneeCurrent);
  return {
    current: current / (1 + root),
    conductance: ((1 + root) * conductance - current * conductance / (2 * root * kneeCurrent))
      / (1 + 2 * root + current / kneeCurrent),
  };
}

/** Reverse roll-off below the reverse knee current IKR (ngspice dioload.c "limit reverse"). */
function applyReverseKnee(
  { current, conductance }: { current: number; conductance: number },
  kneeCurrent: number,
): { current: number; conductance: number } {
  if (kneeCurrent <= 0 || current >= -KNEE_CURRENT_THRESHOLD) return { current, conductance };
  const root = Math.sqrt(-current / kneeCurrent);
  return {
    current: current / (1 + root),
    conductance: ((1 + root) * conductance + current * conductance / (2 * root * kneeCurrent))
      / (1 + 2 * root - current / kneeCurrent),
  };
}

function breakdownKneeVoltage(
  breakdown: BreakdownParams,
  saturationCurrent: number,
): number {
  const { voltage, current, thermalVoltage, junctionThermalVoltage } = breakdown;
  // ngspice-47 diotemp.c:221-228: a breakdown current below Isat*BV/vt cannot
  // be matched by the knee iteration (its log argument goes negative), so
  // ngspice raises cbv and puts the knee at the breakdown voltage itself.
  if (current < saturationCurrent * voltage / junctionThermalVoltage) return voltage;
  // ngspice-47 diotemp.c:231-235: the log term scales with NBV*vt, while the
  // linear reverse-leakage term -xbv/vt uses plain vt.
  const slot = findCachedKnee(voltage, current, thermalVoltage, junctionThermalVoltage, saturationCurrent);
  if (slot >= 0) return kneeCacheValues[slot];
  let knee = voltage - thermalVoltage * Math.log1p(current / saturationCurrent);
  for (let iteration = 0; iteration < 25; iteration++) {
    knee = voltage - thermalVoltage
      * Math.log(current / saturationCurrent + 1 - knee / junctionThermalVoltage);
  }
  return cacheKnee(voltage, current, thermalVoltage, junctionThermalVoltage, saturationCurrent, knee);
}

/*
 * Recently solved breakdown knees, keyed on every input of the fit above.
 * ngspice-47 solves the knee once per temperature in diotemp.c (tBrkdwnV);
 * spice-ts used to re-run the 26-log fixed point on every junction evaluation,
 * which was the top self-time frame on diode-heavy transient decks (#549). The
 * fit is a pure function of these five numbers, so a hit returns the identical
 * double.
 */
const KNEE_CACHE_SIZE = 16;
const kneeCacheKeys = new Float64Array(KNEE_CACHE_SIZE * 5).fill(Number.NaN);
const kneeCacheValues = new Float64Array(KNEE_CACHE_SIZE);
let kneeCacheNext = 0;

function findCachedKnee(
  voltage: number,
  current: number,
  thermalVoltage: number,
  junctionThermalVoltage: number,
  saturationCurrent: number,
): number {
  for (let entry = 0, key = 0; entry < KNEE_CACHE_SIZE; entry++, key += 5) {
    if (kneeCacheKeys[key] === voltage && kneeCacheKeys[key + 1] === current
        && kneeCacheKeys[key + 2] === thermalVoltage
        && kneeCacheKeys[key + 3] === junctionThermalVoltage
        && kneeCacheKeys[key + 4] === saturationCurrent) {
      return entry;
    }
  }
  return -1;
}

function cacheKnee(
  voltage: number,
  current: number,
  thermalVoltage: number,
  junctionThermalVoltage: number,
  saturationCurrent: number,
  knee: number,
): number {
  const key = kneeCacheNext * 5;
  kneeCacheKeys[key] = voltage;
  kneeCacheKeys[key + 1] = current;
  kneeCacheKeys[key + 2] = thermalVoltage;
  kneeCacheKeys[key + 3] = junctionThermalVoltage;
  kneeCacheKeys[key + 4] = saturationCurrent;
  kneeCacheValues[kneeCacheNext] = knee;
  kneeCacheNext = (kneeCacheNext + 1) % KNEE_CACHE_SIZE;
  return knee;
}

/** @internal Test hook: the knee as the memo returns it, and a cache reset. */
export const breakdownKneeMemoForTest = {
  knee: breakdownKneeVoltage,
  clear(): void {
    kneeCacheKeys.fill(Number.NaN);
    kneeCacheNext = 0;
  },
};

/**
 * ngspice-47 dioload.c junction limiting: DEVpnjlim on the forward junction,
 * or on the voltage beyond the breakdown knee when the junction is in breakdown.
 * Both use the forward critical voltage tVcrit, as ngspice does.
 */
function limitJunctionStep(
  voltage: number,
  previousVoltage: number,
  { thermalVoltage, saturationCurrent, breakdown }: Junction,
): number {
  const criticalVoltage = thermalVoltage
    * Math.log(thermalVoltage / (Math.SQRT2 * saturationCurrent));
  if (breakdown) {
    const knee = breakdownKneeVoltage(breakdown, saturationCurrent);
    if (voltage < Math.min(0, -knee + 10 * breakdown.thermalVoltage)) {
      return -knee - pnjlim(
        -(voltage + knee),
        -(previousVoltage + knee),
        breakdown.thermalVoltage,
        criticalVoltage,
      );
    }
  }
  return pnjlim(voltage, previousVoltage, thermalVoltage, criticalVoltage);
}

function safeExponential(exponent: number): number {
  return Math.exp(Math.min(exponent, 700));
}
