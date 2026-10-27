import type { DeviceModel } from './devices/device.js';
import type {
  AnalysisDirective, DCSweepDimension, PoleZeroAnalysis, SensitivityAnalysis, SourceWaveform, ModelParams, SubcktDefinition, StepAnalysis,
  SimulationOptions, SimulationWarning, NodeInitialState, RFPort,
} from './types.js';
import type { CircuitIR } from './ir/types.js';
import { buildIR } from './ir/builder.js';
import { Resistor } from './devices/resistor.js';
import { expandUrc, parseUrcParams } from './devices/urc.js';
import { NodeShunt } from './devices/node-shunt.js';
import { resolveResistor } from './devices/resistor-model.js';
import { VoltageSource } from './devices/voltage-source.js';
import { CurrentSource } from './devices/current-source.js';
import { TransientNoiseContext } from './devices/transient-noise.js';
import { Capacitor } from './devices/capacitor.js';
import { Inductor } from './devices/inductor.js';
import { MutualInductor, validateCoupledInductors } from './devices/mutual-inductor.js';
import { Diode, canonicalDiodeModelParams, diodeZeroBiasCapacitance } from './devices/diode.js';
import { BJT, hasBiasDependentBaseResistance } from './devices/bjt.js';
import { VBIC, isVBICLevel, resolveVBICParams, vbicNodeCount } from './devices/vbic.js';
import { MOSFET } from './devices/mosfet.js';
import { EKV26 } from './devices/ekv.js';
import { MOS2, mos2SeriesResistances, resolveMOS2Model } from './devices/mos2.js';
import { MOS3, mos3SeriesResistances, resolveMOS3Model } from './devices/mos3.js';
import { MOS6, mos6SeriesResistances, resolveMOS6Model } from './devices/mos6.js';
import { createBSIM1, resolveBSIM1Model } from './devices/bsim1.js';
import { createBSIM2, resolveBSIM2Model } from './devices/bsim2.js';
import { ClassicBsimMosfet, classicBsimSeriesResistances, resolveClassicBsimInstance } from './devices/bsim12-load.js';
import { VDMOS } from './devices/vdmos.js';
import { isVdmosModelType, resolveVdmosModel } from './devices/vdmos-model.js';
import { JFET, resolveNJFETParams } from './devices/jfet.js';
import { createZDevice, expandZDevice, resolveZModel } from './devices/z-device.js';
import { BehavioralCurrentSource, BehavioralSource, BehavioralVoltageSource } from './devices/behavioral-source.js';
import {
  behavioralControlNodes,
  compileBehavioralExpression,
  formatBehavioralExpression,
  mapBehavioralNodes,
  parseBehavioralSourceCard,
  substituteBehavioralParameters,
  type BehavioralExpression,
  type BehavioralInstanceParams,
  type BehavioralSourceKind,
} from './parser/behavioral-expression.js';
import { BSIM3v3 } from './devices/bsim3v3.js';
import { BSIM4 } from './devices/bsim4/device.js';
import { bsim3SeriesResistances, isSupportedBsim3Version, SUPPORTED_BSIM3_VERSIONS } from './devices/bsim3v3-params.js';
import { VCCS } from './devices/vccs.js';
import { VCVS } from './devices/vcvs.js';
import { CCCS } from './devices/cccs.js';
import { CurrentSwitch, resolveSwitchModel, VoltageSwitch } from './devices/switch.js';
import { CCVS } from './devices/ccvs.js';
import { TransmissionLine, type TransmissionLineInitialConditions } from './devices/transmission-line.js';
import { resolveLtraModel } from './devices/ltra-model.js';
import { LossyTransmissionLine, LtraModelState } from './devices/lossy-transmission-line.js';
import {
  assertXspiceAnalyses,
  bindXspiceSources,
  buildXspiceEventNetwork,
  createXspiceDevice,
  implicitXspiceBridges,
  prepareXspiceInstance,
  type PreparedXspiceInstance,
} from './devices/xspice/compile.js';
import { parseXspiceInstance, parseXspiceModelCard, xspiceModelType, type XspiceInstanceCard, type XspiceModelCard } from './parser/xspice-parser.js';
import { resolveXspiceData, resolveXspiceFile, xspiceFilePath } from './devices/xspice/files.js';
import type { IncludeResolver } from './types.js';
import { assertControlledSourceCard, withoutNodePairParentheses } from './parser/controlled-source.js';
import type { ControlScript } from './parser/control/script.js';
import { DEFAULT_OPTIONS, GROUND_NODE } from './types.js';
import { evaluateExpression } from './parser/expression.js';
import { bindParameterRandom, parameterRandom } from './parser/statistical-functions.js';
import { parseNumber, tokenizeLine, tokenizeNetlist } from './parser/tokenizer.js';
import { formatNumber } from './netlist-number.js';
import { evaluateSubcircuitParams } from './subcircuit-params.js';
import { formatNumber as formatNumparamNumber, substituteExpressions } from './parser/preprocessor.js';
import { isPspiceSwitchModel, translatePspiceSwitchModel } from './parser/pspice-switch.js';
import { parseModelCard } from './parser/model-parser.js';
import { assertDeviceModelType, normalizeModelType } from './parser/model-type.js';
import {
  extractRFPort, extractSourceMultiplier, hasSourceMultiplier, parseSourceWaveform, parseInstanceParams,
  transientNoiseWaveform, transientRandomWaveform, VOLTAGE_SOURCE_MULTIPLIER_ERROR,
} from './parser/waveform-parser.js';
import { invalidPassiveInstanceLine, parsePassiveElement } from './parser/passive-parser.js';
import { locateSubcircuitCall, parseSubcircuitCallParams, splitNestedSubcircuits, validateSubcircuitCallCommas, subcircuitStringActuals } from './parser/subcircuit-syntax.js';
import { stringParameter, substituteStringAssignments, type ParameterScope } from './parser/string-param.js';
import { assertSupportedResistorModel, parseResistorElement } from './parser/resistor-parser.js';
import { parseZInstance } from './parser/z-device-parser.js';
import { parseSwitchInstance } from './parser/switch-parser.js';
import { DEVICE_GMIN } from './devices/device.js';
import { parseBJTInstance, type BJTInstanceParams } from './parser/bjt-parser.js';
import { jfetInstanceDescriptorParams, parseJFETInstance, type JFETInstanceParams } from './parser/jfet-parser.js';
import {
  formatCplModelCard,
  parseCplLines,
  parseTransmissionLineModelCard,
  parseTxlLine,
} from './parser/transmission-line-parser.js';
import { createSwecLine, swecLineBranchNames } from './devices/swec-line-factory.js';
import {
  parseDiodeInstanceParams,
  diodeModelIndex,
  type DiodeInstanceParams,
} from './parser/diode-parser.js';
import { assertSupportedPoleZero } from './validation/pole-zero.js';
import { assertSupportedSensitivity } from './validation/sensitivity.js';
import {
  resolveCapacitance,
  resolveCapacitorModel,
  resolveInductance,
  resolveInductorModel,
  type ResolvedCapacitorModel,
  type ResolvedInductorModel,
} from './devices/passive-model.js';
import {
  CycleError, InvalidCircuitError, ParseError, UnsupportedModelLevelError, UnsupportedModelVersionError,
  UnsupportedTemperatureError, UnsupportedMultiplicityError, UnsupportedModelParameterError,
} from './errors.js';
import type { ProtocolExecutionGuard } from './protocol/execution-guard.js';
import { CaseFoldedNameSet, CaseInsensitiveMap } from './case-fold.js';

/**
 * MOSFET model levels with a spice-ts implementation: MOS1, MOS2, MOS3, BSIM1 (4), BSIM2 (5), MOS6,
 * BSIM3v3 (8/49), MOS9, the static BSIM4 subset (14/54) and nominal-temperature static EKV2.6 (260).
 */
const SUPPORTED_MOSFET_LEVELS: readonly number[] = [1, 2, 3, 4, 5, 6, 8, 9, 14, 49, 54, 260];
/** ngspice's default circuit temperature (and TNOM) in degrees Celsius. */
const NOMINAL_TEMPERATURE_C = 27;
/** ngspice CONSTCtoK. */
const CELSIUS_TO_KELVIN = 273.15;

/**
 * The compiled representation of a circuit, ready for numerical simulation.
 *
 * Produced by {@link Circuit.compile}. Contains instantiated device models,
 * node/branch mappings, and analysis commands.
 */
export interface CompiledCircuit {
  /** Retained parser expressions, recompiled at the circuit temperature in Celsius. */
  recompileAtTemperature?: (celsius: number) => CompiledCircuit;
  /** Instantiated device models with resolved node indices */
  devices: DeviceModel[];
  /** Number of non-ground nodes */
  nodeCount: number;
  /** Number of MNA branches (voltage sources, inductors, controlled sources) */
  branchCount: number;
  /** Ordered list of node names (excludes ground) */
  nodeNames: string[];
  /** Map from node name to its matrix index (-1 for ground) */
  nodeIndexMap: Map<string, number>;
  /** Ordered list of branch names */
  branchNames: string[];
  /** Analysis commands to execute */
  analyses: AnalysisDirective[];
  /** Bounded native pole-zero commands, kept outside adapters without `.pz` result support. */
  poleZeroAnalyses: PoleZeroAnalysis[];
  /** Device model parameter cards */
  models: Map<string, ModelParams>;
  /** Subcircuit definitions */
  subcircuits: Map<string, SubcktDefinition>;
  /** Step directives for parametric sweeps */
  steps: StepAnalysis[];
  /** Solver options declared by `.options` cards in the netlist */
  simulationOptions: SimulationOptions;
  /**
   * Node voltages from `.ic`: the t=0 state with transient UIC; otherwise held
   * during the transient operating point and released at t=0 (ngspice).
   */
  initialConditions: NodeInitialState[];
  /** Node-voltage Newton guesses from `.nodeset`. */
  nodeSets: NodeInitialState[];
}

/** Definitions nested in one subcircuit instance body, and that body's local models. */
interface SubcircuitScope {
  /** Nested `.subckt` definitions, keyed by upper-case name. */
  definitions: ReadonlyMap<string, SubcktDefinition>;
  /** Upper-case local `.model` name -> instance-scoped model name (#854). */
  models: ReadonlyMap<string, string>;
  /** Parameter scope of the instance whose body holds these definitions (#857). */
  params: ParameterScope;
}

interface DeviceDescriptor {
  type: string;
  name: string;
  nodes: string[];
  /** Original C/B/E terminals retained through BJT series-resistance expansion. */
  bjtICTerminals?: string[];
  /** Original C/B/E/S terminals for VBIC expanded-resistor thermal power. */
  vbicTerminals?: string[];
  value?: number;
  waveform?: Partial<SourceWaveform> & { dc?: number };
  modelName?: string;
  /** Resolved junction card for the two branches of an RSW diode. */
  diodeModelParams?: Record<string, number>;
  /** RSW keeps the bottom RS explicit, including charge-free junctions. */
  diodeForcePrimeNode?: boolean;
  /** NS-absent RSW current is evaluated at the bottom prime node (ngspice-47). */
  diodeCurrentControlNode?: string;
  params?: Record<string, number>;
  controlSource?: string;
  /** Volts for capacitors, amps for inductors. */
  ic?: number;
  coupledA?: string;
  coupledB?: string;
  /** B-card `I=`/`V=` expression; node references are already circuit node names. */
  expression?: BehavioralExpression;
  /** B-card source form and ASRC instance parameters. */
  behavioral?: { kind: BehavioralSourceKind; params: BehavioralInstanceParams };
  /** XSPICE A-card; its nodes are known once the model's port table is applied at compile. */
  xspice?: XspiceInstanceCard;
  /** RF port of a V source (`portnum`/`z0`/`pwr`/`freq`). */
  port?: RFPort;
  /** I-source `m` multiplier (ngspice ISRCmValue); absent means 1. */
  multiplier?: number;
}

/** PULSE coefficients in ngspice `@vsrc[pulse]` order. */
const PULSE_FIELDS = ['v1', 'v2', 'delay', 'rise', 'fall', 'width', 'period'] as const;

type SourceDescriptorWaveform = Partial<SourceWaveform> & { dc?: number };

/** DC value of a source waveform as written on its card. */
function sourceDc(waveform: SourceDescriptorWaveform): number {
  return waveform.type === 'dc' ? (waveform as { value: number }).value : waveform.dc ?? 0;
}

/**
 * Apply ngspice `alter` to an independent source, producing the waveform the
 * parser builds for the edited card (`DC x AC y` is an `ac`-typed waveform).
 */
function alterSourceWaveform(
  descriptor: DeviceDescriptor,
  key: string | undefined,
  values: number[],
): string | undefined {
  const waveform: SourceDescriptorWaveform = descriptor.waveform ?? { type: 'dc', value: 0 };
  if (key === 'SIN') {
    // ngspice-47 frontend/device.c:1421-1486 forwards the real vector;
    // vsrc/vsrcpar.c:91-97 (also isrc) replaces, rather than patches, coefficients.
    if (values.length < 2) return 'sin needs at least 2 coefficients';
    const [offset, amplitude, frequency = 0, delay, damping, phase] = values;
    const dc = waveform.type === 'dc' ? waveform.value : waveform.dc;
    const ac = waveform.type === 'ac'
      ? { magnitude: waveform.magnitude ?? 1, phase: waveform.phase ?? 0 }
      : waveform.ac;
    descriptor.waveform = {
      type: 'sin', offset, amplitude, frequency, delay, damping, phase,
      ...(dc !== undefined ? { dc } : {}), ...(ac ? { ac } : {}),
    };
    return undefined;
  }
  if (key === 'PULSE') {
    if (waveform.type !== 'pulse' || values.length !== PULSE_FIELDS.length) {
      return `pulse of '${descriptor.name}' can be altered only on a PULSE source with ${PULSE_FIELDS.length} values`;
    }
    const pulse: Record<string, unknown> = { ...waveform };
    PULSE_FIELDS.forEach((field, index) => { pulse[field] = values[index]; });
    descriptor.waveform = pulse as SourceDescriptorWaveform;
    return undefined;
  }
  if (key === 'TRNOISE' || key === 'TRRANDOM') {
    // ngspice-47 vsrcpar.c/isrcpar.c: the new coefficients replace the source
    // function and re-initialise its noise state; DC and AC terms are kept.
    let noise: SourceDescriptorWaveform;
    try {
      noise = key === 'TRNOISE' ? transientNoiseWaveform(values) : transientRandomWaveform(values);
    } catch (error) {
      return (error as Error).message;
    }
    const dc = waveform.type === 'dc' ? waveform.value : waveform.dc;
    const ac = waveform.type === 'ac'
      ? { magnitude: waveform.magnitude ?? 1, phase: waveform.phase ?? 0 }
      : waveform.ac;
    descriptor.waveform = { ...noise, ...(dc !== undefined ? { dc } : {}), ...(ac ? { ac } : {}) };
    return undefined;
  }
  if (values.length !== 1) return `parameter needs one value, got ${values.length}`;
  const [value] = values;
  if (key === undefined || key === 'DC') {
    descriptor.waveform = waveform.type === 'dc'
      ? { ...waveform, value } as SourceDescriptorWaveform
      : { ...waveform, dc: value };
    return undefined;
  }
  if (key === 'AC' || key === 'ACMAG' || key === 'ACPHASE') {
    const field = key === 'ACPHASE' ? 'phase' : 'magnitude';
    if (waveform.type === 'dc') {
      descriptor.waveform = { type: 'ac', dc: sourceDc(waveform), magnitude: 0, phase: 0, [field]: value };
    } else if (waveform.type === 'ac') {
      descriptor.waveform = { ...waveform, [field]: value };
    } else {
      const ac = waveform.ac ?? { magnitude: 0, phase: 0 };
      descriptor.waveform = { ...waveform, ac: { ...ac, [field]: value } };
    }
    return undefined;
  }
  return `parameter '${key.toLowerCase()}' of source '${descriptor.name}' cannot be altered`;
}

/** ngspice `@vsrc[param]` readout of a source input parameter, when spice-ts holds it. */
function sourceParameter(waveform: SourceDescriptorWaveform | undefined, key: string): number[] | undefined {
  const source: SourceDescriptorWaveform = waveform ?? { type: 'dc', value: 0 };
  if (key === 'DC') return [sourceDc(source)];
  if (key === 'PULSE' && source.type === 'pulse') {
    return PULSE_FIELDS.map(field => (source as Record<string, number>)[field]);
  }
  if (key === 'SIN' && source.type === 'sin') {
    return [source.offset, source.amplitude, source.frequency, source.delay, source.damping, source.phase]
      .map(value => value ?? 0);
  }
  if (key === 'TRNOISE' && source.type === 'trnoise') {
    return [source.amplitude, source.ts, source.alpha, source.oneOverFAmplitude,
      source.rtsAmplitude, source.rtsCaptureTime, source.rtsEmissionTime].map(value => value ?? 0);
  }
  if (key === 'TRRANDOM' && source.type === 'trrandom') {
    return [source.distribution, source.ts, source.td, source.param1 ?? 1, source.param2].map(value => value ?? 0);
  }
  if (key === 'AC' || key === 'ACMAG') {
    return [source.type === 'ac' ? (source as { magnitude: number }).magnitude : source.ac?.magnitude ?? 0];
  }
  if (key === 'ACPHASE') return [source.type === 'ac' ? source.phase ?? 0 : source.ac?.phase ?? 0];
  return undefined;
}

function behavioralDescriptor(
  name: string,
  nPlus: string,
  nMinus: string,
  kind: BehavioralSourceKind,
  expression: BehavioralExpression,
  params: BehavioralInstanceParams = {},
): DeviceDescriptor {
  const controls = behavioralControlNodes(expression);
  return {
    type: 'B', name, nodes: [nPlus, nMinus, ...controls], expression, behavioral: { kind, params },
  };
}

/** Cards whose `m` instance parameter scales the device (M parallel copies). */
const MULTIPLIED_INSTANCE_TYPES = new Set<DeviceDescriptor['type']>(['R', 'C', 'L', 'D', 'Q', 'M']);

/**
 * Voltage-defined cards: m parallel copies of an ideal voltage constraint are
 * the same constraint. ngspice-47 inp_fix_subckt_multiplier (inpcom.c) skips
 * them (V, E, H, K and B v= cards), as it skips S, W, O, T, U, Y and P cards.
 */
const MULTIPLICITY_INVARIANT_TYPES = new Set<DeviceDescriptor['type']>(['V', 'E', 'H', 'K']);

/** Cards ngspice-47 leaves unscaled although m parallel copies would differ. */
const NGSPICE_UNSCALED_TYPES = new Set<DeviceDescriptor['type']>(['S', 'W', 'O', 'Y', 'P', 'U']);

/**
 * Apply a subcircuit instance multiplicity to one expanded card (#810). The
 * instance multiplicity multiplies the card's own `m`, as the ngspice manual
 * specifies (ngspice-47 replaces it instead: ngspice bug #693). Returns a
 * warning for cards ngspice-47 leaves unscaled; throws
 * {@link UnsupportedMultiplicityError} for cards ngspice scales but spice-ts
 * cannot.
 */
function applyInstanceMultiplicity(
  desc: DeviceDescriptor,
  multiplicity: number,
  instanceName: string,
): string | undefined {
  if (MULTIPLIED_INSTANCE_TYPES.has(desc.type)) {
    desc.params = { ...desc.params, M: (desc.params?.M ?? 1) * multiplicity };
    return undefined;
  }
  if (desc.type === 'I') {
    desc.multiplier = (desc.multiplier ?? 1) * multiplicity;
    return undefined;
  }
  if (MULTIPLICITY_INVARIANT_TYPES.has(desc.type)) return undefined;
  if (desc.type === 'B' && desc.behavioral?.kind === 'voltage') return undefined;
  if (NGSPICE_UNSCALED_TYPES.has(desc.type)) {
    return `${desc.type} device '${desc.name}' is not scaled by the multiplicity m=${multiplicity}`
      + ` of subcircuit instance '${instanceName}' (ngspice-47 does not scale ${desc.type} cards)`;
  }
  throw new UnsupportedMultiplicityError(desc.name, desc.type, instanceName, multiplicity);
}

/**
 * Bind every B-source `i(vsource)` to its source's MNA branch (ngspice
 * PT_CURRENT via CKTfndBranch). As in ngspice, only elements that own a
 * branch current (V, E, H, L and V= B-sources) can be referenced; names
 * match case-insensitively, as ngspice lower-cases the whole deck.
 */
function bindBehavioralControlBranches(
  sources: readonly BehavioralSource[],
  deviceMap: ReadonlyMap<string, DeviceModel>,
): void {
  if (sources.length === 0) return;
  const byLowerName = new Map<string, DeviceModel>();
  for (const [name, device] of deviceMap) {
    if (!byLowerName.has(name.toLowerCase())) byLowerName.set(name.toLowerCase(), device);
  }
  for (const device of sources) {
    device.bindControlBranches(device.expression.sources.map(source => {
      const control = deviceMap.get(source) ?? byLowerName.get(source.toLowerCase());
      if (!control) {
        throw new InvalidCircuitError(
          `B-source '${device.name}' references i(${source}), but '${source}' is not a source in the circuit`,
        );
      }
      const ownsBranch = control instanceof VoltageSource || control instanceof VCVS || control instanceof CCVS
        || control instanceof Inductor || control instanceof BehavioralVoltageSource;
      if (!ownsBranch) {
        throw new InvalidCircuitError(
          `B-source '${device.name}' references i(${source}), but '${source}' has no branch current `
          + '(only V, E, H, L and V= B elements can be referenced)',
        );
      }
      return control.branches[0];
    }));
  }
}

function formatBehavioralSource(desc: DeviceDescriptor): string {
  const { kind, params } = desc.behavioral!;
  const assignment = `${kind === 'voltage' ? 'V' : 'I'}=${formatBehavioralExpression(desc.expression!)}`;
  const instance = Object.entries(params)
    .map(([key, value]) => `${key}=${typeof value === 'boolean' ? Number(value) : formatNumber(value)}`);
  return [desc.name, desc.nodes[0], desc.nodes[1], assignment, ...instance].join(' ');
}

function formatParams(params?: ParameterScope): string {
  if (!params) return '';
  return Object.entries(params)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? JSON.stringify(value) : formatNumber(value)}`)
    .join(' ');
}

/** Subcircuit defaults; expression defaults are written as `{expr}`. */
function formatSubcircuitParams(params: Record<string, number | string>): string {
  return Object.entries(params)
    .map(([key, value]) => `${key}=${typeof value === 'number' ? formatNumber(value) : `{${value}}`}`)
    .join(' ');
}

function formatModel(model: ModelParams): string {
  if (model.type === 'CPL') return formatCplModelCard(model);
  const params = [formatParams(model.params), model.version === undefined ? '' : `VERSION=${model.version}`]
    .filter(Boolean).join(' ');
  return params
    ? `.model ${model.name} ${model.type} (${params})`
    : `.model ${model.name} ${model.type}`;
}

/**
 * A pwr/freq port uses its DC value only when one was given, so it must not
 * gain the `DC 0` that {@link formatWaveform} writes for an omitted value.
 */
function formatSourceValue(desc: DeviceDescriptor): string {
  const power = desc.port?.power;
  const wf = desc.waveform;
  if (!power) return formatWaveform(wf);
  const terms = power.dc === undefined ? [] : [`DC ${formatNumber(power.dc)}`];
  const ac = wf?.type === 'ac' ? { magnitude: wf.magnitude ?? 1, phase: wf.phase ?? 0 } : wf?.ac;
  if (ac) terms.push(`AC ${formatNumber(ac.magnitude)} ${formatNumber(ac.phase)}`);
  return terms.join(' ');
}

function formatRFPort(port?: RFPort): string {
  if (!port) return '';
  const power = port.power
    ? ` pwr ${formatNumber(port.power.watts)} freq ${formatNumber(port.power.frequency)}`
    : '';
  return ` portnum ${port.number} z0 ${formatNumber(port.z0)}${power}`;
}

/**
 * Give every RF port source its internal `<name>.res` node (ngspice vsrcset.c
 * `<name>#res`: z0 sits between the outer + node and it) and enforce ngspice
 * vsrctemp.c port numbering: the N ports are numbered 1..N, each once.
 */
function withRFPortNodes(descriptors: DeviceDescriptor[]): DeviceDescriptor[] {
  const ports = descriptors.filter(desc => desc.type === 'V' && desc.port);
  const seen = new Map<number, string>();
  for (const desc of ports) {
    const { number } = desc.port!;
    const previous = seen.get(number);
    if (previous !== undefined) {
      throw new InvalidCircuitError(`RF port sources '${previous}' and '${desc.name}' share port number ${number}`);
    }
    if (number > ports.length) {
      throw new InvalidCircuitError(
        `RF port '${desc.name}' has port number ${number}, but the ${ports.length} port(s) must use port numbers 1..${ports.length}`,
      );
    }
    seen.set(number, desc.name);
  }
  if (ports.length === 0) return descriptors;
  return descriptors.map(desc => (desc.type === 'V' && desc.port
    ? { ...desc, nodes: [desc.nodes[0], desc.nodes[1], internalNodeName(desc.name, 'res')] }
    : desc));
}

/**
 * Positional waveform coefficients up to the last given one. An omitted one
 * before it is written as the value ngspice reads the same as omitted; one
 * without such a value (a TSTOP-derived default) cannot be written.
 */
function positionalCoefficients(keyword: string, coefficients: Array<[number | undefined, number?]>): string {
  let last = coefficients.length - 1;
  while (last > 0 && coefficients[last][0] === undefined) last--;
  return coefficients.slice(0, last + 1).map(([value, omitted], index) => {
    if (value !== undefined) return formatNumber(value);
    if (omitted === undefined) {
      throw new InvalidCircuitError(
        `${keyword} coefficient ${index + 1} is omitted before a given one; its default cannot be written on a netlist card`,
      );
    }
    return formatNumber(omitted);
  }).join(' ');
}

function formatWaveform(wf?: Partial<SourceWaveform> & { dc?: number }): string {
  if (!wf) return 'DC 0';
  let base: string;
  if (!wf.type) {
    base = wf.dc !== undefined ? `DC ${formatNumber(wf.dc)}` : 'DC 0';
  } else {
    switch (wf.type) {
      case 'dc':
        base = `DC ${formatNumber(wf.value ?? 0)}`;
        break;
      case 'ac': {
        const ac = `AC ${formatNumber(wf.magnitude ?? 1)} ${formatNumber(wf.phase ?? 0)}`;
        base = wf.dc !== undefined ? `DC ${formatNumber(wf.dc)} ${ac}` : ac;
        break;
      }
      case 'pulse':
        base = `PULSE(${[
          wf.v1 ?? 0,
          wf.v2 ?? 0,
          wf.delay ?? 0,
          wf.rise ?? 1e-12,
          wf.fall ?? 1e-12,
          wf.width ?? Infinity,
          wf.period ?? Infinity,
          ...(wf.pulses !== undefined ? [wf.pulses] : []),
        ].map(formatNumber).join(' ')})`;
        break;
      case 'sin':
        base = `SIN(${[
          wf.offset ?? 0,
          wf.amplitude ?? 0,
          wf.frequency ?? 0,
          wf.delay,
          wf.damping,
          wf.phase,
        ].filter(v => v !== undefined).map(v => formatNumber(v as number)).join(' ')})`;
        break;
      case 'pwl':
        base = `PWL(${(wf.points ?? [])
          .flatMap(point => [point.time, point.value])
          .map(formatNumber)
          .join(' ')})`;
        if (wf.delay !== undefined) base += ` TD=${formatNumber(wf.delay)}`;
        if (wf.repeat !== undefined) base += ` R=${formatNumber(wf.repeat)}`;
        break;
      case 'exp':
        // ngspice reads a zero TD1/TAU1/TD2/TAU2 as omitted.
        base = `EXP(${positionalCoefficients('EXP', [
          [wf.v1 ?? 0], [wf.v2 ?? 0], [wf.td1, 0], [wf.tau1, 0], [wf.td2, 0], [wf.tau2, 0],
        ])})`;
        break;
      case 'sffm':
        // An omitted FC defaults from TSTOP, which no explicit value writes; a zero FM is omitted.
        base = `SFFM(${positionalCoefficients('SFFM', [
          [wf.offset ?? 0], [wf.amplitude ?? 0], [wf.carrierFrequency], [wf.modulationIndex, 90],
          [wf.signalFrequency, 0], [wf.delay, 0], [wf.signalPhase, 0], [wf.carrierPhase, 0],
        ])})`;
        break;
      case 'am':
        // Omitted FM and FC default from TSTOP, which no explicit value writes.
        base = `AM(${positionalCoefficients('AM', [
          [wf.offset ?? 0], [wf.carrierAmplitude ?? 0], [wf.modulationAmplitude, 1], [wf.modulationFrequency],
          [wf.carrierFrequency], [wf.delay, 0], [wf.modulationPhase, 0], [wf.carrierPhase, 0],
        ])})`;
        break;
      case 'trnoise':
        base = `TRNOISE(${[
          wf.amplitude ?? 0, wf.ts ?? 0, wf.alpha ?? 0, wf.oneOverFAmplitude ?? 0,
          wf.rtsAmplitude ?? 0, wf.rtsCaptureTime ?? 0, wf.rtsEmissionTime ?? 0,
        ].map(formatNumber).join(' ')})`;
        break;
      case 'trrandom':
        base = `TRRANDOM(${[
          wf.distribution ?? 0, wf.ts ?? 0, wf.td ?? 0, wf.param1 ?? 1, wf.param2 ?? 0,
        ].map(formatNumber).join(' ')})`;
        break;
      default:
        base = 'DC 0';
    }
  }
  if (wf.type !== 'dc' && wf.type !== 'ac') {
    const prefix = [
      wf.dc !== undefined ? `DC ${formatNumber(wf.dc)}` : '',
      wf.ac ? `AC ${formatNumber(wf.ac.magnitude)} ${formatNumber(wf.ac.phase)}` : '',
    ].filter(Boolean).join(' ');
    if (prefix) base = `${prefix} ${base}`;
  }
  const distortion = [
    wf.distortionF1
      ? `DISTOF1 ${formatNumber(wf.distortionF1.magnitude)} ${formatNumber(wf.distortionF1.phase)}`
      : '',
    wf.distortionF2
      ? `DISTOF2 ${formatNumber(wf.distortionF2.magnitude)} ${formatNumber(wf.distortionF2.phase)}`
      : '',
  ].filter(Boolean).join(' ');
  return distortion ? `${base} ${distortion}` : base;
}

function formatDevice(desc: DeviceDescriptor): string {
  const params = formatParams(desc.params);
  const tail = params ? ` ${params}` : '';

  switch (desc.type) {
    case 'R': {
      const valueAndModel = [
        desc.value !== undefined ? formatNumber(desc.value) : undefined,
        desc.modelName,
      ].filter(Boolean).join(' ');
      // A keyword-only card (no value, no model) round-trips as written: ngspice
      // resolves it to the 1 mOhm default (#574), not to the '0' placeholder.
      const resistance = valueAndModel || (tail ? '' : '0');
      return `${desc.name} ${desc.nodes[0]} ${desc.nodes[1]}${resistance ? ` ${resistance}` : ''}${tail}`;
    }
    case 'C':
    case 'L': {
      const value = desc.value !== undefined ? formatNumber(desc.value) : undefined;
      const valueAndModel = [value, desc.modelName].filter(Boolean).join(' ');
      const ic = desc.ic === undefined ? '' : ` IC=${formatNumber(desc.ic)}`;
      return `${desc.name} ${desc.nodes[0]} ${desc.nodes[1]} ${valueAndModel || '0'}${tail}${ic}`;
    }
    case 'K':
      return `${desc.name} ${desc.coupledA} ${desc.coupledB} ${formatNumber(desc.value ?? 0)}`;
    case 'T':
      return `${desc.name} ${desc.nodes.join(' ')} Z0=${formatNumber(desc.value ?? 0)} TD=${formatNumber(desc.params?.TD ?? 0)}`;
    case 'O':
      return `${desc.name} ${desc.nodes.join(' ')} ${desc.modelName ?? ''}`.trim();
    case 'U':
      return `${desc.name} ${desc.nodes.join(' ')} ${desc.modelName ?? ''}${tail.replace(/ LUMPS=/g, ' N=')}`;
    case 'Y':
    case 'P': {
      const lines = desc.nodes.length / 2;
      const length = desc.params?.LEN === undefined ? '' : ` len=${formatNumber(desc.params.LEN)}`;
      return `${desc.name} ${desc.nodes.slice(0, lines).join(' ')} 0 ${desc.nodes.slice(lines).join(' ')} 0 `
        + `${desc.modelName ?? ''}${length}`;
    }
    case 'V':
    case 'I': {
      const multiplier = desc.multiplier === undefined ? '' : ` m=${formatNumber(desc.multiplier)}`;
      return `${desc.name} ${desc.nodes[0]} ${desc.nodes[1]} ${formatSourceValue(desc)}${formatRFPort(desc.port)}${multiplier}`;
    }
    case 'D':
      return `${desc.name} ${desc.nodes.join(' ')} ${desc.modelName ?? ''}${tail.replace(/ THERMAL=1/g, ' thermal')}`.trim();
    case 'Q': {
      const { ICVBE, ICVCE, ...scaling } = desc.params ?? {};
      const instance = formatParams(scaling);
      const ic = ICVBE === undefined ? '' : ` IC=${formatNumber(ICVBE)}${ICVCE === undefined ? '' : `,${formatNumber(ICVCE)}`}`;
      return `${desc.name} ${desc.nodes.join(' ')} ${desc.modelName ?? ''}${instance ? ` ${instance}` : ''}${ic}`.trim();
    }
    case 'J': {
      const { OFF, ICVDS, ICVGS, ...scaling } = desc.params ?? {};
      const instance = formatParams(scaling);
      const ic = ICVDS === undefined ? '' : ` IC=${formatNumber(ICVDS)},${formatNumber(ICVGS ?? 0)}`;
      return `${desc.name} ${desc.nodes.join(' ')} ${desc.modelName ?? ''}${instance ? ` ${instance}` : ''}${OFF ? ' OFF' : ''}${ic}`.trim();
    }
    case 'Z':
      return `${desc.name} ${desc.nodes[0]} ${desc.nodes[1]} ${desc.nodes[2]} ${desc.modelName ?? ''}`.trim();
    case 'M':
      return `${desc.name} ${desc.nodes.join(' ')} ${desc.modelName ?? ''}${tail}`.trim();
    case 'E':
    case 'G':
      return `${desc.name} ${desc.nodes.join(' ')} ${formatNumber(desc.value ?? 0)}`;
    case 'F':
    case 'H':
      return `${desc.name} ${desc.nodes[0]} ${desc.nodes[1]} ${desc.controlSource ?? ''} ${formatNumber(desc.value ?? 0)}`.trim();
    case 'S':
      return `${desc.name} ${desc.nodes.join(' ')} ${desc.modelName ?? ''} ${desc.params?.ON ? 'ON' : 'OFF'}`;
    case 'W':
      return `${desc.name} ${desc.nodes.join(' ')} ${desc.controlSource ?? ''} ${desc.modelName ?? ''} ${desc.params?.ON ? 'ON' : 'OFF'}`;
    case 'B':
      return formatBehavioralSource(desc);
    case 'X':
      return `${desc.name} ${desc.nodes.join(' ')} ${desc.modelName ?? ''}${tail}`.trim();
    case 'A':
      return desc.xspice!.raw;
    default:
      return `${desc.name} ${desc.nodes.join(' ')}`;
  }
}

function formatAnalysis(analysis: AnalysisDirective | PoleZeroAnalysis): string {
  switch (analysis.type) {
    case 'op':
      return '.op';
    case 'dc':
      return `.dc ${analysis.source} ${formatNumber(analysis.start)} ${formatNumber(analysis.stop)} ${formatNumber(analysis.step)}${analysis.secondary === undefined ? '' : ` ${analysis.secondary.source} ${formatNumber(analysis.secondary.start)} ${formatNumber(analysis.secondary.stop)} ${formatNumber(analysis.secondary.step)}`}`;
    case 'tran': {
      const parts = ['.tran', formatNumber(analysis.timestep), formatNumber(analysis.stopTime)];
      if (analysis.startTime !== undefined) parts.push(formatNumber(analysis.startTime));
      if (analysis.maxTimestep !== undefined) parts.push(formatNumber(analysis.maxTimestep));
      if (analysis.useInitialConditions) parts.push('UIC');
      return parts.join(' ');
    }
    case 'ac':
      return `.ac ${analysis.variation} ${analysis.points} ${formatNumber(analysis.startFreq)} ${formatNumber(analysis.stopFreq)}`;
    case 'noise':
      return `.noise v(${analysis.outputNode}${analysis.outputReferenceNode === undefined ? '' : `,${analysis.outputReferenceNode}`}) ${analysis.inputSource} ${analysis.variation} ${analysis.points} ${formatNumber(analysis.startFreq)} ${formatNumber(analysis.stopFreq)}${analysis.pointsPerSummary === undefined ? '' : ` ${analysis.pointsPerSummary}`}`;
    case 'sp':
      return `.sp ${analysis.variation} ${analysis.points} ${formatNumber(analysis.startFreq)} ${formatNumber(analysis.stopFreq)} ${analysis.noise ? 1 : 0}`;
    case 'disto':
      return `.disto dec ${analysis.points} ${formatNumber(analysis.startFreq)} ${formatNumber(analysis.stopFreq)}${analysis.f2OverF1 === undefined ? '' : ` ${formatNumber(analysis.f2OverF1)}`}`;
    case 'tf':
      return 'outputNode' in analysis
        ? `.tf v(${analysis.outputNode}${analysis.outputReferenceNode === undefined ? '' : `,${analysis.outputReferenceNode}`}) ${analysis.inputSource}`
        : `.tf i(${analysis.outputSource}) ${analysis.inputSource}`;
    case 'pz':
      return `.pz ${analysis.inputPositive} ${analysis.inputNegative} ${analysis.outputPositive} ${analysis.outputNegative} ${analysis.inputType} ${analysis.mode}`;
    case 'sens':
      return analysis.mode === 'dc'
        ? `.sens v(${analysis.outputNode}${analysis.outputReferenceNode === undefined ? '' : `,${analysis.outputReferenceNode}`})`
        : `.sens v(${analysis.outputNode}${analysis.outputReferenceNode === undefined ? '' : `,${analysis.outputReferenceNode}`}) ac ${analysis.variation} ${analysis.points} ${formatNumber(analysis.startFreq)} ${formatNumber(analysis.stopFreq)}`;
  }
}

function formatStep(step: StepAnalysis): string {
  if (step.sweepMode === 'list') {
    return `.step ${step.param} LIST ${(step.values ?? []).map(formatNumber).join(' ')}`;
  }
  if (step.sweepMode === 'lin') {
    return `.step ${step.param} ${formatNumber(step.start ?? 0)} ${formatNumber(step.stop ?? 0)} ${formatNumber(step.increment ?? 0)}`;
  }
  return `.step ${step.sweepMode.toUpperCase()} ${step.param} ${formatNumber(step.start ?? 0)} ${formatNumber(step.stop ?? 0)} ${step.points ?? 0}`;
}

/** Descriptor params for a BJT instance; undefined when the card gave no scaling. */
function bjtInstanceDescriptorParams(
  instance: BJTInstanceParams | undefined,
): Record<string, number> | undefined {
  if (!instance) return undefined;
  const params: Record<string, number> = {};
  for (const name of ['AREA', 'AREAB', 'AREAC', 'M', 'ICVBE', 'ICVCE'] as const) {
    if (instance[name] !== undefined) params[name] = instance[name];
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

/** ngspice-47 BJT/VBIC instance scale: AREA * M (both default to 1). */
function bjtInstanceScale(params: Record<string, number> | undefined): number {
  return (params?.AREA ?? 1) * (params?.M ?? 1);
}

/** VDMOS instance parameters (vdmos.c): M, TEMP and DTEMP are supported. */
function vdmosInstanceParams(desc: DeviceDescriptor): { M?: number; TEMP?: number; DTEMP?: number } {
  const { M, TEMP, DTEMP, THERMAL: _thermal, ...rest } = desc.params ?? {};
  const unsupported = Object.keys(rest);
  if (unsupported.length > 0) {
    throw new InvalidCircuitError(
      `VDMOS '${desc.name}' has unsupported instance parameters: ${unsupported.join(', ')}`,
    );
  }
  if (M !== undefined && !(M > 0)) {
    throw new InvalidCircuitError(`VDMOS '${desc.name}' multiplier M must be positive`);
  }
  return { M, TEMP, DTEMP };
}

function isPositiveFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function hasCapacitorParasitics(model: ResolvedCapacitorModel): boolean {
  return isPositiveFinite(model.seriesResistance)
    || isPositiveFinite(model.seriesInductance)
    || isPositiveFinite(model.parallelResistance);
}

function hasInductorParasitics(model: ResolvedInductorModel): boolean {
  return isPositiveFinite(model.seriesResistance)
    || isPositiveFinite(model.parallelResistance)
    || isPositiveFinite(model.parallelCapacitance);
}

function internalNodeName(deviceName: string, suffix: string): string {
  return `${deviceName}.${suffix}`;
}

/**
 * MOS1 drain/source series resistances as ngspice-47 mos1set.c/mos1temp.c
 * resolve them: 0 when the terminal has no prime node (shorted), `Infinity`
 * when the prime node exists but its conductance is 0 (open terminal), else
 * the resistance.
 *
 * mos1set.c creates the drain prime node when RD != 0 || (RSH != 0 && NRD != 0)
 * (NRD = NRS = 1 square by default). mos1temp.c then sets the conductance to
 * M / RD when RD is given (0 when RD = 0), else M / (RSH * NRD) when RSH is
 * non-zero; the source likewise with RS and NRS. RD = 0 given with RSH != 0 and
 * NRD != 0 thus leaves the drain open (#757). With RD not given, RSH != 0 and
 * NRD = 0 ngspice divides by zero and its operating point fails; spice-ts keeps
 * that zero-square terminal shorted.
 */
function mos1SeriesResistances(
  card: Readonly<Record<string, number | undefined>>,
  instance: Readonly<Record<string, number | undefined>> | undefined,
): { drain: number; source: number } {
  const m = instance?.M ?? 1;
  const sheet = card.RSH ?? 0;
  const resistance = (given: number | undefined, squares: number): number => {
    if ((given ?? 0) === 0 && (sheet === 0 || squares === 0)) return 0;
    const conductance = given !== undefined ? (given !== 0 ? m / given : 0) : m / (sheet * squares);
    return conductance !== 0 ? 1 / conductance : Infinity;
  };
  return {
    drain: resistance(card.RD, instance?.NRD ?? 1),
    source: resistance(card.RS, instance?.NRS ?? 1),
  };
}

/**
 * `.model` registry keyed case-insensitively, as in ngspice: `M1 ... PMOS`
 * must resolve `.model pmos pmos ...`. A miss silently falls back to default
 * device parameters, so a case mismatch would otherwise change the circuit.
 */
class ModelTable extends Map<string, ModelParams> {
  override get(name: string): ModelParams | undefined {
    return super.get(name.toUpperCase());
  }

  override has(name: string): boolean {
    return super.has(name.toUpperCase());
  }

  override set(name: string, model: ModelParams): this {
    return super.set(name.toUpperCase(), model);
  }

  override delete(name: string): boolean {
    return super.delete(name.toUpperCase());
  }
}

/**
 * Programmatic circuit builder for constructing SPICE circuits without a netlist.
 *
 * Add devices, models, subcircuits, and analysis commands via the `add*` methods,
 * then call {@link Circuit.compile} to produce a {@link CompiledCircuit} for simulation.
 *
 * @example
 * ```ts
 * const ckt = new Circuit();
 * ckt.addVoltageSource('V1', 'in', '0', { dc: 5 });
 * ckt.addResistor('R1', 'in', 'out', 1000);
 * ckt.addResistor('R2', 'out', '0', 1000);
 * ckt.addAnalysis('op');
 * const result = await simulate(ckt);
 * ```
 */
export class Circuit {
  private descriptors: DeviceDescriptor[] = [];
  private _analyses: AnalysisDirective[] = [];
  private _poleZeroAnalyses: PoleZeroAnalysis[] = [];
  private _steps: StepAnalysis[] = [];
  private _models: Map<string, ModelParams> = new ModelTable();
  /**
   * Upper-case instance-scoped names (`X1:NAME`) of `.model` cards defined
   * inside a subcircuit body. ngspice-47 subckt.c gives every subcircuit
   * instance its own copy of such a model, visible only to that body (#854).
   */
  private readonly _subcircuitModelNames = new Set<string>();
  /** XSPICE code model cards, keyed by upper-case model name like {@link ModelTable}. */
  private _xspiceModels = new Map<string, XspiceModelCard>();
  private _xspiceFiles = new Map<string, string | undefined>();
  private _subcircuits = new Map<string, SubcktDefinition>();
  /** Parser-only X cards retained until formal definitions are resolved. */
  private readonly _subcircuitCallCards = new WeakMap<DeviceDescriptor, string>();
  /** `.global` node names, keyed upper-case, valued with their first spelling. */
  private _globalNodes = new Map<string, string>();
  /** Top-level `.param` values (upper-case names) visible inside subcircuits. */
  private _parameters = new Map<string, number | string>();
  private _parameterScope: ParameterScope | undefined;
  private _simulationOptions: SimulationOptions = {};
  private _temperature: number | undefined;
  private _nominalTemperature: number | undefined;
  /** @internal Parser-supplied evaluator for TEMPER-dependent parameter expressions. */
  recompileAtTemperature?: (celsius: number) => CompiledCircuit;
  /** @internal Re-evaluate TEMPER before applying runtime control alterations. */
  reparseAtTemperature?: (celsius: number) => Circuit;
  /** @internal Re-elaborate retained source after control-language parameter edits. */
  #reparseWithParameters?: (changes: readonly import('./parser/preprocessor.js').ParameterAlteration[], seed?: number) => Circuit;
  get reparseWithParameters(): ((changes: readonly import('./parser/preprocessor.js').ParameterAlteration[], seed?: number) => Circuit) | undefined {
    return this.#reparseWithParameters;
  }
  set reparseWithParameters(value: ((changes: readonly import('./parser/preprocessor.js').ParameterAlteration[], seed?: number) => Circuit) | undefined) {
    this.#reparseWithParameters = value;
  }
  private _xspiceTrtol: number | undefined;
  private _initialConditions: NodeInitialState[] = [];
  private _nodeSets: NodeInitialState[] = [];
  private nodeSet = new CaseFoldedNameSet();
  private _controlScript?: ControlScript;
  private _parseWarnings: string[] = [];
  private _parseWarningDetails = new Map<string, Pick<SimulationWarning, 'code' | 'line'>>();

  get analyses(): AnalysisDirective[] {
    return this._analyses;
  }

  get poleZeroAnalyses(): PoleZeroAnalysis[] {
    return this._poleZeroAnalyses;
  }

  get simulationOptions(): Readonly<SimulationOptions> {
    return { ...this._simulationOptions };
  }

  setSimulationOptions(options: SimulationOptions): void {
    this._simulationOptions = { ...this._simulationOptions, ...options };
  }

  /**
   * Circuit temperature in degrees Celsius set by `.options TEMP=`, or
   * `undefined` for ngspice's default of 27 C.
   */
  get temperature(): number | undefined {
    return this._temperature;
  }

  /** Circuit model nominal temperature; undefined retains ngspice's 27 C default. */
  get nominalTemperature(): number | undefined {
    return this._nominalTemperature;
  }

  /** Set the default model TNOM for supported semiconductor and R/C/L temperature models. */
  setNominalTemperature(celsius: number): void {
    if (!Number.isFinite(celsius) || celsius <= -CELSIUS_TO_KELVIN) {
      throw new InvalidCircuitError(`Invalid circuit nominal temperature: ${celsius} C`);
    }
    this._nominalTemperature = celsius;
  }

  /**
   * Set the circuit temperature in degrees Celsius (ngspice `.options TEMP=`).
   * Devices without an instance temperature are evaluated at it. A value other
   * than 27 C is rejected at compile time for devices whose temperature model
   * does not yet follow ngspice.
   */
  setTemperature(celsius: number): void {
    if (!Number.isFinite(celsius) || celsius <= -CELSIUS_TO_KELVIN) {
      throw new InvalidCircuitError(`Invalid circuit temperature: ${celsius} C`);
    }
    this._temperature = celsius;
  }

  /**
   * ngspice `.options XTRTOL=` (integer, at least 1), or `undefined` when not
   * set. ngspice-47 cktdojob.c uses it instead of 1 as the trtol of a circuit
   * with XSPICE 'A' devices whose trtol is above 1; otherwise it has no effect.
   */
  get xspiceTrtol(): number | undefined {
    return this._xspiceTrtol;
  }

  /**
   * Non-fatal netlist diagnostics recorded while parsing, such as ngspice's
   * "misplaced .endc card". {@link simulate} reports them as `parse` warnings.
   */
  get parseWarnings(): readonly string[] {
    return this._parseWarnings;
  }

  /** @internal Record a non-fatal parse diagnostic; see {@link parseWarnings}. */
  addParseWarning(message: string, details?: Pick<SimulationWarning, 'code' | 'line'>): void {
    this._parseWarnings.push(message);
    if (details) this._parseWarningDetails.set(message, { code: details.code, line: details.line });
  }

  /** Parser warnings with optional machine-readable source diagnostics. */
  get parseDiagnostics(): SimulationWarning[] {
    return this._parseWarnings.map(message => ({ type: 'parse', message, ...this._parseWarningDetails.get(message) }));
  }

  /** Set the ngspice `.options XTRTOL=` value; see {@link xspiceTrtol}. */
  setXspiceTrtol(trtol: number | undefined): void {
    if (trtol !== undefined && (!Number.isInteger(trtol) || trtol < 1)) {
      throw new InvalidCircuitError(`Invalid XSPICE trtol: ${trtol}`);
    }
    this._xspiceTrtol = trtol;
  }

  /**
   * @internal The deck's ngspice `.control` script when it needs the
   * control-language interpreter (set by the netlist parser).
   */
  get controlScript(): ControlScript | undefined {
    return this._controlScript;
  }

  /** @internal */
  setControlScript(script: ControlScript | undefined): void {
    this._controlScript = script;
  }

  /**
   * @internal Capture everything a `.control` script can change (`alter`,
   * `altermod`, `option`) and return a function that puts it back, so running
   * a script never leaves the caller's Circuit edited.
   *
   * `alterInstance`/`alterModel`/`setSimulationOptions` replace the affected
   * fields with new objects rather than mutating them, so saving the field
   * references is a complete snapshot.
   */
  snapshotControlState(): () => void {
    const subcircuitAlterations = new Map(this._subcircuitAlterations);
    const descriptors = this.descriptors.map(descriptor => ({
      descriptor, value: descriptor.value, waveform: descriptor.waveform, params: descriptor.params,
      multiplier: descriptor.multiplier,
    }));
    const models = Array.from(this._models.values(), model => ({ model, params: model.params }));
    const simulationOptions = this._simulationOptions;
    const temperature = this._temperature;
    const nominalTemperature = this._nominalTemperature;
    return () => {
      for (const { descriptor, value, waveform, params, multiplier } of descriptors) {
        descriptor.value = value;
        descriptor.waveform = waveform;
        descriptor.params = params;
        descriptor.multiplier = multiplier;
      }
      for (const { model, params } of models) model.params = params;
      this._subcircuitAlterations = subcircuitAlterations;
      this._simulationOptions = simulationOptions;
      this._temperature = temperature;
      this._nominalTemperature = nominalTemperature;
    };
  }

  /** Instance-local edits survive re-expansion without changing shared definitions. */
  private _subcircuitAlterations = new Map<string, DeviceDescriptor>();

  /** Resolve both internal X1.R1 and ngspice R.X1.R1 instance names. */
  private controlDevice(name: string): DeviceDescriptor | undefined {
    const upper = name.toUpperCase();
    const topLevel = this.descriptors.find(candidate => candidate.name.toUpperCase() === upper);
    if (topLevel || !name.includes('.')) return topLevel;
    // ngspice-47 subckt.c translate_inst_name prefixes the device type.
    return this.expandAllSubcircuits(this.collectGlobalNodes()).find(candidate =>
      candidate.name.includes('.') && (candidate.name.toUpperCase() === upper
        || `${candidate.type}.${candidate.name}`.toUpperCase() === upper));
  }

  /**
   * @internal ngspice `alter`: change an input parameter of a flattened
   * device, with the same effect as editing its card. `parameter` undefined
   * selects the primary value (resistance, capacitance, inductance, source DC).
   *
   * @returns undefined on success, or why the change is not supported
   */
  alterInstance(name: string, parameter: string | undefined, values: number[]): string | undefined {
    let descriptor = this.controlDevice(name);
    if (descriptor && !this.descriptors.includes(descriptor)) {
      // Copy on write so snapshotControlState also restores existing overrides.
      descriptor = { ...descriptor };
      this._subcircuitAlterations.set(descriptor.name.toUpperCase(), descriptor);
    }
    if (!descriptor) {
      return `no device named '${name}'`;
    }
    const key = parameter?.toUpperCase();
    const single = (): number | string => (values.length === 1 ? values[0] : `parameter needs one value, got ${values.length}`);
    const primary: Record<string, string[]> = {
      R: ['R', 'RESISTANCE'], C: ['C', 'CAPACITANCE'], L: ['L', 'INDUCTANCE'], K: ['K', 'COUPLING'],
    };
    if (descriptor.type in primary) {
      if (key !== undefined && !primary[descriptor.type].includes(key)) {
        return `parameter '${parameter}' of ${descriptor.type} device '${name}' cannot be altered`;
      }
      const value = single();
      if (typeof value === 'string') return value;
      descriptor.value = value;
      return undefined;
    }
    if (descriptor.type === 'I' && key === 'M') {
      // ngspice-47 isrcpar.c: ISRC_M is settable.
      const value = single();
      if (typeof value === 'string') return value;
      descriptor.multiplier = value;
      return undefined;
    }
    if (descriptor.type === 'V' || descriptor.type === 'I') {
      return alterSourceWaveform(descriptor, key, values);
    }
    if (['M', 'Q', 'D', 'J'].includes(descriptor.type) && key !== undefined) {
      const params = descriptor.params ?? {};
      if (!(key in params) && !(descriptor.type === 'M' && (key === 'W' || key === 'L'))) {
        return `parameter '${parameter}' of ${descriptor.type} device '${name}' cannot be altered`;
      }
      const value = single();
      if (typeof value === 'string') return value;
      descriptor.params = { ...params, [key]: value };
      return undefined;
    }
    return `${descriptor.type} device '${name}'${parameter ? ` parameter '${parameter}'` : ''} cannot be altered`;
  }

  /**
   * @internal ngspice `altermod`: set a `.model` parameter, with the same effect
   * as writing it on the model card.
   *
   * @returns undefined on success, or why the change is not supported
   */
  alterModel(name: string, parameter: string, value: number): string | undefined {
    // ngspice also accepts a device name as an alias for its shared model.
    // An X descriptor names a subcircuit, not a device model.
    const descriptor = this.descriptors.find(candidate => candidate.name.toUpperCase() === name.toUpperCase());
    const model = descriptor
      ? (descriptor.modelName && descriptor.type !== 'X' ? this._models.get(descriptor.modelName) : undefined)
      : this._models.get(name);
    if (!model) return `no top-level .model named '${name}'`;
    model.params = { ...model.params, [parameter.toUpperCase()]: value };
    return undefined;
  }

  /**
   * @internal ngspice `@name[parameter]` readout of an input parameter of a
   * device (including expanded subcircuit instances) or `.model`, or undefined
   * when spice-ts cannot report it (operating-point or internal parameters).
   */
  parameterVector(name: string, parameter: string): number[] | undefined {
    const key = parameter.toUpperCase();
    const descriptor = this.controlDevice(name);
    if (descriptor) {
      const primary: Record<string, string[]> = { R: ['R', 'RESISTANCE'], C: ['C', 'CAPACITANCE'], L: ['L', 'INDUCTANCE'] };
      if (primary[descriptor.type]?.includes(key)) return descriptor.value === undefined ? undefined : [descriptor.value];
      if (descriptor.type === 'I' && key === 'M') return [descriptor.multiplier ?? 1];
      if (descriptor.type === 'V' || descriptor.type === 'I') return sourceParameter(descriptor.waveform, key);
      const value = descriptor.params?.[key];
      return value === undefined ? undefined : [value];
    }
    const value = this._models.get(name)?.params[key];
    return value === undefined ? undefined : [value];
  }

  get initialConditions(): readonly NodeInitialState[] {
    return this._initialConditions;
  }

  get nodeSets(): readonly NodeInitialState[] {
    return this._nodeSets;
  }

  get nodeCount(): number {
    const nodes = new Set(this.nodeSet);
    nodes.delete(GROUND_NODE);
    return nodes.size;
  }

  get branchCount(): number {
    return this.descriptors.reduce((count, descriptor) =>
      count + (descriptor.type === 'T'
        ? 2
        : descriptor.type === 'Y' || descriptor.type === 'P'
          ? descriptor.nodes.length
          : descriptor.type === 'V' || descriptor.type === 'L'
            || descriptor.type === 'E' || descriptor.type === 'H' ? 1 : 0), 0);
  }

  getNodeIndex(name: string): number {
    if (name === GROUND_NODE) return -1;
    const nodes = [...this.nodeSet].filter(n => n !== GROUND_NODE).sort();
    return nodes.indexOf(this.nodeSet.canonical(name));
  }

  /**
   * Add a resistor to the circuit.
   *
   * @param name - Device name (e.g., `'R1'`)
   * @param nodePos - Positive terminal node
   * @param nodeNeg - Negative terminal node
   * @param resistance - Resistance value in ohms. Omit when using a `.model R` card value.
   * @param instanceParams - ngspice instance parameters (e.g. `{ TC1: 1e-3, AC: 4e3, M: 2, NOISY: 0 }`)
   * @param modelName - Optional name of a `.model R` card
   */
  addResistor(
    name: string,
    nodePos: string,
    nodeNeg: string,
    resistance?: number,
    instanceParams?: Record<string, number>,
    modelName?: string,
  ): void {
    this.nodeSet.add(nodePos);
    this.nodeSet.add(nodeNeg);
    this.descriptors.push({
      type: 'R', name, nodes: [nodePos, nodeNeg], value: resistance,
      params: instanceParams,
      modelName,
    });
  }

  /**
   * Add a capacitor to the circuit.
   *
   * @param name - Device name (e.g., `'C1'`)
   * @param nodePos - Positive terminal node
   * @param nodeNeg - Negative terminal node
   * @param capacitance - Capacitance value in farads. Omit when using a `.model C` card value.
   * @param modelName - Optional name of a `.model C` card
   * @param instanceParams - Per-instance model parameters (e.g., `{ L: 10e-6, W: 1e-6, M: 2 }`)
   */
  addCapacitor(
    name: string,
    nodePos: string,
    nodeNeg: string,
    capacitance?: number,
    modelName?: string,
    instanceParams?: Record<string, number>,
    ic?: number,
  ): void {
    this.nodeSet.add(nodePos);
    this.nodeSet.add(nodeNeg);
    this.descriptors.push({
      type: 'C',
      name,
      nodes: [nodePos, nodeNeg],
      value: capacitance,
      modelName,
      params: instanceParams,
      ic,
    });
  }

  /**
   * Add an inductor to the circuit.
   *
   * @param name - Device name (e.g., `'L1'`)
   * @param nodePos - Positive terminal node
   * @param nodeNeg - Negative terminal node
   * @param inductance - Inductance value in henries. Omit when using a `.model L` card value.
   * @param modelName - Optional name of a `.model L` card
   * @param instanceParams - Per-instance model parameters (e.g., `{ NT: 10, SCALE: 2 }`)
   */
  addInductor(
    name: string,
    nodePos: string,
    nodeNeg: string,
    inductance?: number,
    modelName?: string,
    instanceParams?: Record<string, number>,
    ic?: number,
  ): void {
    this.nodeSet.add(nodePos);
    this.nodeSet.add(nodeNeg);
    this.descriptors.push({
      type: 'L',
      name,
      nodes: [nodePos, nodeNeg],
      value: inductance,
      modelName,
      params: instanceParams,
      ic,
    });
  }

  /** Add a SPICE K-element coupling two previously declared inductors. */
  addInductorCoupling(name: string, indA: string, indB: string, coupling: number): void {
    this.descriptors.push({
      type: 'K', name, nodes: [], value: coupling,
      coupledA: indA, coupledB: indB,
    });
  }

  /** Add a bounded ideal lossless T-element using characteristic impedance and delay. */
  addTransmissionLine(
    name: string,
    port1Positive: string,
    port1Negative: string,
    port2Positive: string,
    port2Negative: string,
    impedance: number,
    delay: number,
    initialConditions?: TransmissionLineInitialConditions,
    relativeTolerance?: number,
    absoluteTolerance?: number,
  ): void {
    for (const node of [port1Positive, port1Negative, port2Positive, port2Negative]) {
      this.nodeSet.add(node);
    }
    this.descriptors.push({
      type: 'T',
      name,
      nodes: [port1Positive, port1Negative, port2Positive, port2Negative],
      value: impedance,
      params: {
        TD: delay,
        ...(relativeTolerance === undefined ? {} : { REL: relativeTolerance }),
        ...(absoluteTolerance === undefined ? {} : { ABS: absoluteTolerance }),
        ...(initialConditions ? {
          IC_V1: initialConditions[0], IC_I1: initialConditions[1],
          IC_V2: initialConditions[2], IC_I2: initialConditions[3],
        } : {}),
      },
    });
  }

  /** Add a uniform distributed RC line, expanded into ordinary passive devices at compile time. */
  addUrc(name: string, nodes: string[], modelName: string, params: Record<string, number>): void {
    if (nodes.length !== 3) throw new InvalidCircuitError('URC requires three nodes');
    const normalized = parseUrcParams(Object.entries(params).map(([key, value]) => `${key}=${value}`), 0);
    for (const node of nodes) this.nodeSet.add(node);
    this.descriptors.push({ type: 'U', name, nodes: [...nodes], modelName, params: normalized });
  }

  /** Add a benchmark-bounded common-reference O-element backed by an LTRA model. */
  addLossyTransmissionLine(
    name: string,
    port1Positive: string,
    port1Negative: string,
    port2Positive: string,
    port2Negative: string,
    modelName: string,
  ): void {
    for (const node of [port1Positive, port1Negative, port2Positive, port2Negative]) {
      this.nodeSet.add(node);
    }
    this.descriptors.push({
      type: 'O',
      name,
      nodes: [port1Positive, port1Negative, port2Positive, port2Negative],
      modelName,
    });
  }

  /**
   * Add an ngspice SWEC lossy line: a Y-element (TXL, one conductor) or a
   * P-element (CPL, `inputs.length` coupled conductors). All conductors are
   * referenced to ground, as in ngspice, which ignores the reference nodes.
   */
  addLossyLines(
    name: string,
    card: 'Y' | 'P',
    inputs: string[],
    outputs: string[],
    modelName: string,
    length?: number,
  ): void {
    for (const node of [...inputs, ...outputs]) this.nodeSet.add(node);
    this.descriptors.push({
      type: card,
      name,
      nodes: [...inputs, ...outputs],
      modelName,
      ...(length === undefined ? {} : { params: { LEN: length } }),
    });
  }

  /**
   * Add a voltage source to the circuit.
   *
   * @param name - Device name (e.g., `'V1'`)
   * @param nodePos - Positive terminal node
   * @param nodeNeg - Negative terminal node
   * @param waveform - Source waveform specification (DC, pulse, sine, or AC)
   * @param port - Optional ngspice RF port (`portnum`, `z0`, `pwr`, `freq`) for `.sp`
   */
  addVoltageSource(
    name: string, nodePos: string, nodeNeg: string,
    waveform: Partial<SourceWaveform> & { dc?: number },
    port?: RFPort,
  ): void {
    this.nodeSet.add(nodePos);
    this.nodeSet.add(nodeNeg);
    this.descriptors.push({ type: 'V', name, nodes: [nodePos, nodeNeg], waveform, ...(port ? { port } : {}) });
  }

  /**
   * Add a current source to the circuit.
   *
   * @param name - Device name (e.g., `'I1'`)
   * @param nodePos - Positive terminal node (current flows from pos to neg)
   * @param nodeNeg - Negative terminal node
   * @param waveform - Source waveform specification (DC, pulse, sine, or AC)
   * @param multiplier - ngspice `m` instance multiplier: the DC, transient and
   *   AC values are scaled by it (default 1); DISTOF terms are not.
   */
  addCurrentSource(
    name: string, nodePos: string, nodeNeg: string,
    waveform: Partial<SourceWaveform> & { dc?: number },
    multiplier?: number,
  ): void {
    this.nodeSet.add(nodePos);
    this.nodeSet.add(nodeNeg);
    this.descriptors.push({
      type: 'I', name, nodes: [nodePos, nodeNeg], waveform,
      ...(multiplier === undefined ? {} : { multiplier }),
    });
  }

  /**
   * Add a voltage-controlled voltage source (VCVS, E-element).
   *
   * @param name - Device name (e.g., `'E1'`)
   * @param nOutP - Positive output node
   * @param nOutN - Negative output node
   * @param nCtrlP - Positive control (sensing) node
   * @param nCtrlN - Negative control (sensing) node
   * @param gain - Voltage gain (V/V)
   */
  addVCVS(name: string, nOutP: string, nOutN: string, nCtrlP: string, nCtrlN: string, gain: number): void {
    this.nodeSet.add(nOutP);
    this.nodeSet.add(nOutN);
    this.nodeSet.add(nCtrlP);
    this.nodeSet.add(nCtrlN);
    this.descriptors.push({ type: 'E', name, nodes: [nOutP, nOutN, nCtrlP, nCtrlN], value: gain });
  }

  /**
   * Add a voltage-controlled current source (VCCS, G-element).
   *
   * @param name - Device name (e.g., `'G1'`)
   * @param nOutP - Positive output node
   * @param nOutN - Negative output node
   * @param nCtrlP - Positive control (sensing) node
   * @param nCtrlN - Negative control (sensing) node
   * @param gm - Transconductance (A/V)
   */
  addVCCS(name: string, nOutP: string, nOutN: string, nCtrlP: string, nCtrlN: string, gm: number): void {
    this.nodeSet.add(nOutP);
    this.nodeSet.add(nOutN);
    this.nodeSet.add(nCtrlP);
    this.nodeSet.add(nCtrlN);
    this.descriptors.push({ type: 'G', name, nodes: [nOutP, nOutN, nCtrlP, nCtrlN], value: gm });
  }

  /**
   * Add a current-controlled voltage source (CCVS, H-element).
   *
   * @param name - Device name (e.g., `'H1'`)
   * @param nOutP - Positive output node
   * @param nOutN - Negative output node
   * @param controlSource - Name of the voltage source whose current controls this device
   * @param gain - Transresistance (V/A)
   */
  addCCVS(name: string, nOutP: string, nOutN: string, controlSource: string, gain: number): void {
    this.nodeSet.add(nOutP);
    this.nodeSet.add(nOutN);
    this.descriptors.push({ type: 'H', name, nodes: [nOutP, nOutN], value: gain, controlSource });
  }

  /**
   * Add a current-controlled current source (CCCS, F-element).
   *
   * @param name - Device name (e.g., `'F1'`)
   * @param nOutP - Positive output node
   * @param nOutN - Negative output node
   * @param controlSource - Name of the voltage source whose current controls this device
   * @param gain - Current gain (A/A)
   */
  addCCCS(name: string, nOutP: string, nOutN: string, controlSource: string, gain: number): void {
    this.nodeSet.add(nOutP);
    this.nodeSet.add(nOutN);
    this.descriptors.push({ type: 'F', name, nodes: [nOutP, nOutN], value: gain, controlSource });
  }

  /**
   * Add an ngspice voltage-controlled switch (S-element, `.model SW`).
   *
   * @param name - Device name (e.g., `'S1'`)
   * @param nodePos - Positive switch node
   * @param nodeNeg - Negative switch node
   * @param nCtrlP - Positive control node
   * @param nCtrlN - Negative control node
   * @param modelName - Name of a `.model ... SW` card
   * @param initiallyOn - Instance `ON` flag (default `OFF`)
   */
  addVoltageSwitch(
    name: string, nodePos: string, nodeNeg: string, nCtrlP: string, nCtrlN: string,
    modelName: string, initiallyOn = false,
  ): void {
    for (const node of [nodePos, nodeNeg, nCtrlP, nCtrlN]) this.nodeSet.add(node);
    this.descriptors.push({
      type: 'S', name, nodes: [nodePos, nodeNeg, nCtrlP, nCtrlN], modelName,
      ...(initiallyOn ? { params: { ON: 1 } } : {}),
    });
  }

  /**
   * Add an ngspice current-controlled switch (W-element, `.model CSW`).
   *
   * @param name - Device name (e.g., `'W1'`)
   * @param nodePos - Positive switch node
   * @param nodeNeg - Negative switch node
   * @param controlSource - Voltage source whose current controls the switch
   * @param modelName - Name of a `.model ... CSW` card
   * @param initiallyOn - Instance `ON` flag (default `OFF`)
   */
  addCurrentSwitch(
    name: string, nodePos: string, nodeNeg: string, controlSource: string,
    modelName: string, initiallyOn = false,
  ): void {
    this.nodeSet.add(nodePos);
    this.nodeSet.add(nodeNeg);
    this.descriptors.push({
      type: 'W', name, nodes: [nodePos, nodeNeg], modelName, controlSource,
      ...(initiallyOn ? { params: { ON: 1 } } : {}),
    });
  }

  /**
   * Add an ngspice B-source with an `I=` expression (current flows from
   * `nPlus` through the source to `nMinus`).
   *
   * @param name - Device name (e.g., `'B1'`)
   * @param nPlus - Positive node
   * @param nMinus - Negative node
   * @param expression - Parsed behavioral current expression
   */
  addBehavioralCurrentSource(
    name: string,
    nPlus: string,
    nMinus: string,
    expression: BehavioralExpression,
    params: BehavioralInstanceParams = {},
  ): void {
    this.addBehavioralSource(behavioralDescriptor(name, nPlus, nMinus, 'current', expression, params));
  }

  /**
   * Add an ngspice B-source with a `V=` expression: V(nPlus) - V(nMinus)
   * follows the expression, with a branch current like a `V` source.
   *
   * @param name - Device name (e.g., `'B1'`)
   * @param nPlus - Positive node
   * @param nMinus - Negative node
   * @param expression - Parsed behavioral voltage expression
   * @param params - ASRC instance parameters (`tc1`, `tc2`, `temp`, `dtemp`, `reciproctc`)
   */
  addBehavioralVoltageSource(
    name: string,
    nPlus: string,
    nMinus: string,
    expression: BehavioralExpression,
    params: BehavioralInstanceParams = {},
  ): void {
    this.addBehavioralSource(behavioralDescriptor(name, nPlus, nMinus, 'voltage', expression, params));
  }

  private addBehavioralSource(descriptor: DeviceDescriptor): void {
    for (const node of descriptor.nodes) this.nodeSet.add(node);
    this.descriptors.push(descriptor);
  }

  /**
   * Add an XSPICE A-element. Its connections are read against the port table
   * of its code model when the circuit is compiled, as ngspice does.
   *
   * @param card - Parsed A-card (see `parseXspiceInstance`)
   */
  addXspiceInstance(card: XspiceInstanceCard): void {
    this.descriptors.push({ type: 'A', name: card.name, nodes: [], modelName: card.modelName, xspice: card });
  }

  /**
   * Add a `.model` card of an implemented XSPICE code model.
   *
   * @param model - Parsed card (see `parseXspiceModelCard`)
   */
  addXspiceModel(model: XspiceModelCard): void {
    this._xspiceModels.set(model.name.toUpperCase(), model);
  }

  /** Resolve XSPICE data files using the same host-provided loader as includes. */
  async resolveXspiceFiles(resolver?: IncludeResolver): Promise<void> {
    const files = new Map<string, string | undefined>();
    const load: IncludeResolver | undefined = resolver && (async path => {
      if (!files.has(path)) {
        try {
          files.set(path, await resolver(path));
        } catch {
          files.set(path, undefined);
        }
      }
      const text = files.get(path);
      if (text === undefined) throw new Error(`Cannot open XSPICE file ${path}`);
      return text;
    });
    // Local cards are parameterized and registered only when reachable X
    // instances expand, including definitions nested inside other subcircuits.
    if (resolver) this.expandAllSubcircuits(this.collectGlobalNodes());
    for (const [name, model] of this._xspiceModels) {
      this._xspiceModels.set(name, await resolveXspiceFile(model, load));
    }
    if (!files.size) return;

    // Reparse callbacks are synchronous: retain file bytes, not resolved model
    // parameters, so TEMPER/alterparam can still change format and column selection.
    const retain = (circuit: Circuit): Circuit => {
      circuit._xspiceFiles = files;
      for (const [name, model] of circuit._xspiceModels) {
        const file = xspiceFilePath(model);
        if (file !== undefined && files.has(String(file))) {
          circuit._xspiceModels.set(name, resolveXspiceData(model, files.get(String(file))));
        }
      }
      const atTemperature = circuit.reparseAtTemperature;
      if (atTemperature) circuit.reparseAtTemperature = celsius => retain(atTemperature(celsius));
      const withParameters = circuit.reparseWithParameters;
      if (withParameters) circuit.reparseWithParameters = changes => retain(withParameters(changes));
      return circuit;
    };
    retain(this);
  }

  /**
   * Add a Z-card device (NHFET level 5 or NMF level 2, chosen by its model).
   *
   * @param name - Device name (e.g., `'Z1'`)
   * @param nodeDrain - Drain node
   * @param nodeGate - Gate node
   * @param nodeSource - Source node
   * @param modelName - Name of an `NHFET` or `NMF` model
   * @param instanceParams - `L`/`W` instance parameters
   */
  addZDevice(
    name: string,
    nodeDrain: string,
    nodeGate: string,
    nodeSource: string,
    modelName: string,
    instanceParams: Record<string, number> = {},
  ): void {
    this.nodeSet.add(nodeDrain);
    this.nodeSet.add(nodeGate);
    this.nodeSet.add(nodeSource);
    this.descriptors.push({
      type: 'Z', name, nodes: [nodeDrain, nodeGate, nodeSource], modelName, params: instanceParams,
    });
  }

  /**
   * Add a diode to the circuit.
   *
   * @param name - Device name (e.g., `'D1'`)
   * @param nodeAnode - Anode node
   * @param nodeCathode - Cathode node
   * @param modelName - Name of a `.model D` card (optional; uses default diode model if omitted)
   * @param instanceParams - Per-instance geometry (`AREA`, `PJ`, and multiplier `M`)
   */
  addDiode(
    name: string,
    nodeAnode: string,
    nodeCathode: string,
    modelName?: string,
    instanceParams?: DiodeInstanceParams,
    nodeThermal?: string,
  ): void {
    this.nodeSet.add(nodeAnode);
    this.nodeSet.add(nodeCathode);
    if (nodeThermal !== undefined) this.nodeSet.add(nodeThermal);
    this.descriptors.push({
      type: 'D',
      name,
      nodes: nodeThermal === undefined ? [nodeAnode, nodeCathode] : [nodeAnode, nodeCathode, nodeThermal],
      modelName,
      params: instanceParams ? { ...instanceParams } : undefined,
    });
  }

  /**
   * Add a bipolar junction transistor (BJT) to the circuit.
   *
   * @param name - Device name (e.g., `'Q1'`)
   * @param nodeCollector - Collector node
   * @param nodeBase - Base node
   * @param nodeEmitter - Emitter node
   * @param modelName - Name of a `.model NPN` or `.model PNP` card
   * @param nodeSubstrate - Optional substrate node. VBIC (LEVEL=4) and the
   *   Gummel-Poon BJT stamp their substrate junction to it; omitted, it is
   *   ground as in ngspice.
   * @param nodeThermal - Optional thermal node. Self-heating is not
   *   implemented, so compilation rejects it with an InvalidCircuitError.
   * @param instanceParams - Optional instance scaling (`AREA`, base/collector
   *   areas `AREAB`/`AREAC`, multiplier `M`), as in ngspice-47.
   */
  addBJT(
    name: string,
    nodeCollector: string,
    nodeBase: string,
    nodeEmitter: string,
    modelName: string,
    nodeSubstrate?: string,
    nodeThermal?: string,
    instanceParams?: BJTInstanceParams,
  ): void {
    this.nodeSet.add(nodeCollector);
    this.nodeSet.add(nodeBase);
    this.nodeSet.add(nodeEmitter);
    // Substrate/thermal nodes join the node set during expansion, and only
    // when the resolved model stamps them.
    const nodes = [nodeCollector, nodeBase, nodeEmitter];
    if (nodeSubstrate !== undefined || nodeThermal !== undefined) nodes.push(nodeSubstrate ?? GROUND_NODE);
    if (nodeThermal !== undefined) nodes.push(nodeThermal);
    const params = bjtInstanceDescriptorParams(instanceParams);
    this.descriptors.push({ type: 'Q', name, nodes, modelName, ...(params ? { params } : {}) });
  }

  /**
   * Add a bounded level-1/level-2 junction field-effect transistor
   * (`.model NJF` or `.model PJF`). `instanceParams.TEMP` is the ngspice
   * instance temperature; only the nominal 27 C is supported.
   */
  addJFET(
    name: string,
    nodeDrain: string,
    nodeGate: string,
    nodeSource: string,
    modelName: string,
    instanceParams?: JFETInstanceParams,
  ): void {
    this.nodeSet.add(nodeDrain);
    this.nodeSet.add(nodeGate);
    this.nodeSet.add(nodeSource);
    this.descriptors.push({
      type: 'J', name, nodes: [nodeDrain, nodeGate, nodeSource], modelName,
      ...(instanceParams === undefined ? {} : { params: jfetInstanceDescriptorParams(instanceParams) }),
    });
  }

  /**
   * Add a MOSFET to the circuit.
   *
   * Supports Level 1 (Shichman-Hodges), Level 2 (Grove-Frohman), Level 6 (Sakurai-Newton) and
   * Level 49/8 (BSIM3v3) models.
   * Any other `LEVEL` raises {@link UnsupportedModelLevelError} at compile time.
   *
   * @param name - Device name (e.g., `'M1'`)
   * @param nodeDrain - Drain node
   * @param nodeGate - Gate node
   * @param nodeSource - Source node
   * @param modelName - Name of a `.model NMOS` or `.model PMOS` card
   * @param instanceParams - Per-instance parameters (e.g., `{ W: 1e-6, L: 0.18e-6 }`)
   * @param nodeBulk - Bulk/body node (optional; defaults to source if omitted)
   * @param nodeCase - VDMOS case thermal node (nodeBulk is Tj for VDMOS)
   */
  addMOSFET(
    name: string,
    nodeDrain: string, nodeGate: string, nodeSource: string,
    modelName: string,
    instanceParams?: Record<string, number>,
    nodeBulk?: string,
    nodeCase?: string,
  ): void {
    this.nodeSet.add(nodeDrain);
    this.nodeSet.add(nodeGate);
    this.nodeSet.add(nodeSource);
    if (nodeBulk) this.nodeSet.add(nodeBulk);
    if (nodeCase) this.nodeSet.add(nodeCase);
    this.descriptors.push({
      type: 'M', name,
      nodes: [nodeDrain, nodeGate, nodeSource, ...(nodeBulk ? [nodeBulk] : []), ...(nodeCase ? [nodeCase] : [])],
      modelName, params: instanceParams,
    });
  }

  /**
   * Register a subcircuit definition for later instantiation with {@link addSubcircuitInstance}.
   *
   * @param def - Subcircuit definition (name, ports, default parameters, and body lines)
   */
  addSubcircuit(def: SubcktDefinition): void {
    this._subcircuits.set(def.name.toUpperCase(), def);
  }

  /**
   * Declare `.global` nodes. Inside every subcircuit body these names bind to
   * the top-level net of the same name instead of an instance-local node, and
   * take precedence over a subcircuit port of the same name (ngspice
   * `gettrans`). Repeated declarations accumulate; ground (`0`) is always
   * global and is not recorded.
   */
  addGlobalNodes(names: readonly string[]): void {
    for (const name of names) {
      if (name === GROUND_NODE) continue;
      const key = name.toUpperCase();
      if (!this._globalNodes.has(key)) this._globalNodes.set(key, name);
    }
  }

  /** Declared `.global` node names, in declaration order. */
  get globalNodes(): string[] {
    return [...this._globalNodes.values()];
  }

  /**
   * Set top-level `.param` values. As in ngspice numparam, subcircuit
   * expressions (default parameter values, `{...}` values and B-source
   * expressions) see them unless a subcircuit parameter or a `.param` inside
   * the subcircuit shadows the name. {@link parseAsync} records the deck's
   * top-level parameters here. Names are case-insensitive; later values win.
   */
  setParameters(values: Readonly<ParameterScope>): void {
    bindParameterRandom(this, parameterRandom(values));
    for (const [name, value] of Object.entries(values)) this._parameters.set(name.toUpperCase(), value);
    this._parameterScope = undefined;
  }

  /** Top-level `.param` values visible inside subcircuits, keyed upper-case. */
  get parameters(): ParameterScope {
    return Object.fromEntries(this._parameters);
  }

  /**
   * Instantiate a subcircuit (X-element).
   *
   * The subcircuit must have been previously registered via {@link addSubcircuit}.
   * Internal nodes are automatically prefixed with the instance name.
   *
   * @param name - Instance name (e.g., `'X1'`)
   * @param ports - Actual node names to connect to the subcircuit's ports
   * @param subcktName - Name of the subcircuit definition to instantiate
   * @param params - Parameter overrides for this instance
   */
  addSubcircuitInstance(
    name: string,
    ports: string[],
    subcktName: string,
    params?: Record<string, number>,
    rawCard?: string,
  ): void {
    for (const p of ports) this.nodeSet.add(p);
    const descriptor: DeviceDescriptor = {
      type: 'X', name, nodes: ports, modelName: subcktName, params,
    };
    this.descriptors.push(descriptor);
    if (rawCard !== undefined) this._subcircuitCallCards.set(descriptor, rawCard);
  }

  /**
   * Register a device model parameter card (`.model`).
   *
   * @param params - Model parameters including name, type (e.g., `'NPN'`, `'NMOS'`), and parameter values
   * @throws UnsupportedCircuitModelTypeError if no spice-ts device implements the model type
   */
  addModel(params: ModelParams): void {
    this.registerModel(params);
  }

  /** Store a model with its type upper-cased, rejecting unsupported types (#544). */
  private registerModel(params: ModelParams): void {
    const type = normalizeModelType(params.name, params.type);
    this._models.set(params.name, type === params.type ? params : { ...params, type });
  }

  /**
   * Add a simulation analysis command to the circuit.
   *
   * @param type - Analysis type: `'op'` (DC operating point), `'dc'` (DC sweep),
   *   `'tran'` (transient), or `'ac'` (AC small-signal)
   * @param params - Analysis-specific parameters (not required for `'op'`)
   */
  addAnalysis(type: 'op'): void;
  addAnalysis(type: 'dc', params: { source: string; start: number; stop: number; step: number; secondary?: DCSweepDimension }): void;
  addAnalysis(type: 'tran', params: { timestep: number; stopTime: number; startTime?: number; maxTimestep?: number; useInitialConditions?: boolean }): void;
  addAnalysis(type: 'ac', params: { variation: 'dec' | 'oct' | 'lin'; points: number; startFreq: number; stopFreq: number }): void;
  addAnalysis(type: 'noise', params: { outputNode: string; outputReferenceNode?: string; inputSource: string; variation: 'dec' | 'oct' | 'lin'; points: number; startFreq: number; stopFreq: number; pointsPerSummary?: number }): void;
  addAnalysis(type: 'sp', params: { variation: 'dec' | 'oct' | 'lin'; points: number; startFreq: number; stopFreq: number; noise?: boolean }): void;
  addAnalysis(type: 'disto', params: { variation: 'dec'; points: number; startFreq: number; stopFreq: number; f2OverF1?: number }): void;
  addAnalysis(type: 'tf', params:
    | { outputNode: string; outputReferenceNode?: string; inputSource: string }
    | { outputSource: string; inputSource: string }): void;
  addAnalysis(type: 'pz', params: { inputPositive: string; inputNegative: string; outputPositive: string; outputNegative: string; inputType: 'cur' | 'vol'; mode: 'pol' | 'zer' | 'pz' }): void;
  addAnalysis(type: 'sens', params: { outputNode: string; outputReferenceNode?: string; mode: 'dc' }): void;
  addAnalysis(type: 'sens', params: { outputNode: string; outputReferenceNode?: string; mode: 'ac'; variation: 'dec' | 'oct' | 'lin'; points: number; startFreq: number; stopFreq: number }): void;
  addAnalysis(type: string, params?: Record<string, unknown>): void {
    switch (type) {
      case 'op':
        this._analyses.push({ type: 'op' });
        break;
      case 'dc':
        if (params!.secondary !== undefined) {
          const secondary = params!.secondary as DCSweepDimension;
          if ((params!.source as string).toUpperCase() === secondary.source.toUpperCase()) {
            throw new InvalidCircuitError(`DC sweep source '${secondary.source}' is repeated`);
          }
        }
        this._analyses.push({
          type: 'dc',
          source: params!.source as string,
          start: params!.start as number,
          stop: params!.stop as number,
          step: params!.step as number,
          ...(params!.secondary === undefined
            ? {}
            : { secondary: { ...(params!.secondary as DCSweepDimension) } }),
        });
        break;
      case 'tran': {
        const tranCmd: { type: 'tran'; timestep: number; stopTime: number; startTime?: number; maxTimestep?: number; useInitialConditions?: boolean } = {
          type: 'tran',
          timestep: params!.timestep as number,
          stopTime: params!.stopTime as number,
        };
        if (params?.startTime !== undefined) tranCmd.startTime = params.startTime as number;
        if (params?.maxTimestep !== undefined) tranCmd.maxTimestep = params.maxTimestep as number;
        if (params?.useInitialConditions) tranCmd.useInitialConditions = true;
        this._analyses.push(tranCmd);
        break;
      }
      case 'ac':
        this._analyses.push({
          type: 'ac',
          variation: params!.variation as 'dec' | 'oct' | 'lin',
          points: params!.points as number,
          startFreq: params!.startFreq as number,
          stopFreq: params!.stopFreq as number,
        });
        break;
      case 'noise':
        if (this._steps.length > 0) {
          throw new InvalidCircuitError('.step cannot be combined with .noise');
        }
        if (params!.pointsPerSummary !== undefined
            && (!Number.isInteger(params!.pointsPerSummary)
              || (params!.pointsPerSummary as number) < 1)) {
          throw new InvalidCircuitError(
            'Invalid .noise points_per_summary; expected a positive integer',
          );
        }
        this._analyses.push({
          type: 'noise',
          outputNode: params!.outputNode as string,
          ...(params!.outputReferenceNode === undefined
            ? {}
            : { outputReferenceNode: params!.outputReferenceNode as string }),
          inputSource: params!.inputSource as string,
          variation: params!.variation as 'dec' | 'oct' | 'lin',
          points: params!.points as number,
          startFreq: params!.startFreq as number,
          stopFreq: params!.stopFreq as number,
          ...(params!.pointsPerSummary === undefined
            ? {}
            : { pointsPerSummary: params!.pointsPerSummary as number }),
        });
        break;
      case 'sp':
        if (this._steps.length > 0) {
          throw new InvalidCircuitError('.step cannot be combined with .sp');
        }
        if (this._analyses.some(existing => existing.type === 'sp')) {
          throw new InvalidCircuitError('Multiple .sp analyses are not supported');
        }
        this._analyses.push({
          type: 'sp',
          variation: params!.variation as 'dec' | 'oct' | 'lin',
          points: params!.points as number,
          startFreq: params!.startFreq as number,
          stopFreq: params!.stopFreq as number,
          noise: params!.noise === true,
        });
        break;
      case 'disto':
        if (this._steps.length > 0) {
          throw new InvalidCircuitError('.step cannot be combined with .disto');
        }
        if (this._analyses.some(existing => existing.type === 'disto')) {
          throw new InvalidCircuitError('Multiple .disto analyses are not supported');
        }
        if (params!.variation !== 'dec'
            || !Number.isInteger(params!.points) || (params!.points as number) < 1
            || !Number.isFinite(params!.startFreq) || (params!.startFreq as number) <= 0
            || !Number.isFinite(params!.stopFreq)
            || (params!.stopFreq as number) < (params!.startFreq as number)
            || (params!.f2OverF1 !== undefined
              && (!Number.isFinite(params!.f2OverF1)
                || (params!.f2OverF1 as number) <= 0
                || (params!.f2OverF1 as number) >= 1))) {
          throw new InvalidCircuitError('Invalid .disto dec sweep');
        }
        this._analyses.push({
          type: 'disto',
          variation: 'dec',
          points: params!.points as number,
          startFreq: params!.startFreq as number,
          stopFreq: params!.stopFreq as number,
          ...(params!.f2OverF1 === undefined
            ? {}
            : { f2OverF1: params!.f2OverF1 as number }),
        });
        break;
      case 'tf':
        this._analyses.push('outputSource' in params!
          ? {
            type: 'tf',
            outputSource: params.outputSource as string,
            inputSource: params.inputSource as string,
          }
          : {
            type: 'tf',
            outputNode: params!.outputNode as string,
            ...(params!.outputReferenceNode === undefined ? {} : {
              outputReferenceNode: params!.outputReferenceNode as string,
            }),
            inputSource: params!.inputSource as string,
          });
        break;
      case 'pz':
        if (this._steps.length > 0) {
          throw new InvalidCircuitError('.step cannot be combined with .pz');
        }
        const analysis: PoleZeroAnalysis = {
          type: 'pz',
          inputPositive: params!.inputPositive as string,
          inputNegative: params!.inputNegative as string,
          outputPositive: params!.outputPositive as string,
          outputNegative: params!.outputNegative as string,
          inputType: params!.inputType as 'cur' | 'vol',
          mode: params!.mode as PoleZeroAnalysis['mode'],
        };
        assertSupportedPoleZero(analysis);
        this._poleZeroAnalyses.push(analysis);
        break;
      case 'sens': {
        if (this._steps.length > 0) {
          throw new InvalidCircuitError('.step cannot be combined with .sens');
        }
        if (this._analyses.some(existing => existing.type === 'sens')) {
          throw new InvalidCircuitError('Multiple .sens analyses are not supported');
        }
        const analysis = { type: 'sens', ...params } as SensitivityAnalysis;
        assertSupportedSensitivity(analysis);
        this._analyses.push(analysis);
        break;
      }
    }
  }

  /** Add a node voltage from `.ic` or `.nodeset`. */
  addInitialState(kind: 'ic' | 'nodeset', state: NodeInitialState): void {
    const target = kind === 'ic' ? this._initialConditions : this._nodeSets;
    const normalizedNode = state.node.toLowerCase();
    const existing = target.findIndex(entry => entry.node.toLowerCase() === normalizedNode);
    if (existing >= 0) target[existing] = state;
    else target.push(state);
  }

  /**
   * Add a .step parametric sweep directive.
   *
   * @param param - Device name to sweep (e.g., 'R1')
   * @param opts - Sweep configuration
   */
  addStep(param: string, opts: {
    mode?: 'lin' | 'dec' | 'oct';
    start?: number;
    stop?: number;
    step?: number;
    points?: number;
    values?: number[];
  }): void {
    if (this._steps.length > 0) {
      throw new InvalidCircuitError(
        'Multiple .step directives are not supported; nested or multi-dimensional stepping is unsupported',
      );
    }
    if (this._poleZeroAnalyses.length > 0) {
      throw new InvalidCircuitError('.step cannot be combined with .pz');
    }
    if (this._analyses.some(analysis => analysis.type === 'sens')) {
      throw new InvalidCircuitError('.step cannot be combined with .sens');
    }
    if (this._analyses.some(analysis => analysis.type === 'noise')) {
      throw new InvalidCircuitError('.step cannot be combined with .noise');
    }
    if (this._analyses.some(analysis => analysis.type === 'disto')) {
      throw new InvalidCircuitError('.step cannot be combined with .disto');
    }
    if (this._analyses.some(analysis => analysis.type === 'sp')) {
      throw new InvalidCircuitError('.step cannot be combined with .sp');
    }
    if (opts.values) {
      this._steps.push({ type: 'step', param, sweepMode: 'list', values: opts.values });
    } else {
      const sweepMode = opts.mode ?? 'lin';
      this._steps.push({
        type: 'step', param, sweepMode,
        start: opts.start, stop: opts.stop,
        increment: sweepMode === 'lin' ? opts.step : undefined,
        points: sweepMode !== 'lin' ? opts.points : undefined,
      });
    }
  }

  /**
   * Convert the circuit to an intermediate representation (IR).
   *
   * The IR is a flat, serialisable snapshot of every component with named ports,
   * typed parameters, and human-readable display values. It is suitable for
   * visualisation, export, or further transformation without running a simulation.
   *
   * @returns A {@link CircuitIR} with components and net names
   */
  toIR(): CircuitIR {
    return buildIR(this.descriptors, this._models);
  }

  /**
   * Serialize the programmatic circuit to a SPICE-like netlist.
   *
   * This is primarily used by external simulator backends that consume text
   * netlists. Raw subcircuit bodies are preserved exactly as registered.
   */
  toNetlist(): string {
    const lines: string[] = ['* spice-ts generated netlist'];

    const optionNames: Array<[keyof SimulationOptions, string, (value: unknown) => string]> = [
      ['scale', 'scale', String],
      ['bypass', 'bypass', String],
      ['rampTime', 'ramptime', String],
      ['abstol', 'abstol', String],
      ['vntol', 'vntol', String],
      ['reltol', 'reltol', String],
      ['deviceGmin', 'gmin', String],
      ['maxIterations', 'itl1', String],
      ['maxTransientIterations', 'itl4', String],
      ['integrationMethod', 'method', value => {
        // ngspice expresses backward Euler as trap with an order-one cap.
        if (value === 'euler') return this._simulationOptions.maxOrder === undefined ? 'trap maxord=1' : 'trap';
        return value === 'trapezoidal' ? 'trap' : value === 'gear2' ? 'gear' : String(value);
      }],
      ['maxOrder', 'maxord', value => this._simulationOptions.integrationMethod === 'euler' ? '1' : String(value)],
      ['trtol', 'trtol', String],
      ['xmu', 'xmu', String],
      ['chgtol', 'chgtol', String],
      ['rshunt', 'rshunt', String],
    ];
    const serializedOptions = optionNames.flatMap(([key, name, format]) => {
      const value = this._simulationOptions[key];
      return value === undefined ? [] : [`${name}=${format(value)}`];
    });
    if (this._simulationOptions.ngbehavior !== undefined) serializedOptions.push(`ngbehavior=${this._simulationOptions.ngbehavior.mode}`);
    for (const flag of ['savecurrents', 'autostop'] as const) {
      if (this._simulationOptions[flag]) serializedOptions.push(flag);
    }
    if (this._temperature !== undefined) serializedOptions.push(`temp=${this._temperature}`);
    if (this._nominalTemperature !== undefined) serializedOptions.push(`tnom=${this._nominalTemperature}`);
    if (this._xspiceTrtol !== undefined) serializedOptions.push(`xtrtol=${this._xspiceTrtol}`);
    if (serializedOptions.length > 0) lines.push(`.options ${serializedOptions.join(' ')}`);

    // Subcircuit-local models are written by their .subckt body, not here.
    for (const model of this._models.values()) {
      if (!this._subcircuitModelNames.has(model.name.toUpperCase())) lines.push(formatModel(model));
    }
    for (const model of this._xspiceModels.values()) {
      if (!this._subcircuitModelNames.has(model.name.toUpperCase())) lines.push(model.raw);
    }

    if (this._globalNodes.size > 0) lines.push(`.global ${this.globalNodes.join(' ')}`);
    // Top-level parameters only reach the output through subcircuit bodies.
    if (this._parameters.size > 0 && this._subcircuits.size > 0) lines.push(`.param ${formatParams(this.parameters)}`);
    for (const subckt of this._subcircuits.values()) {
      const params = formatSubcircuitParams(subckt.params);
      const header = `.subckt ${subckt.name} ${subckt.ports.join(' ')}${params ? ` ${params}` : ''}`;
      lines.push(header.trim());
      lines.push(...subckt.body);
      lines.push(`.ends ${subckt.name}`);
    }

    for (const desc of this.descriptors) {
      lines.push(formatDevice(desc));
    }

    if (this._initialConditions.length > 0) {
      lines.push(`.ic ${this._initialConditions.map(state => `V(${state.node})=${formatNumber(state.value)}`).join(' ')}`);
    }
    if (this._nodeSets.length > 0) {
      lines.push(`.nodeset ${this._nodeSets.map(state => `V(${state.node})=${formatNumber(state.value)}`).join(' ')}`);
    }

    for (const step of this._steps) {
      lines.push(formatStep(step));
    }

    for (const analysis of this._analyses) {
      lines.push(formatAnalysis(analysis));
    }
    for (const analysis of this._poleZeroAnalyses) {
      lines.push(formatAnalysis(analysis));
    }

    lines.push('.end');
    return lines.join('\n');
  }

  /**
   * Compile the circuit into a form ready for numerical simulation.
   *
   * Expands subcircuit instances, assigns node indices, instantiates device
   * models, and resolves model parameter cards.
   *
   * @returns A {@link CompiledCircuit} with device models and node/branch mappings
   * @throws Error if a referenced subcircuit or control source is undefined
   * @throws {@link CycleError} if subcircuit instances form a circular dependency
   */
  compile(guard?: ProtocolExecutionGuard): CompiledCircuit {
    // Pre-expand subcircuit instances into flat device descriptors
    const globalNodes = this.collectGlobalNodes(guard);
    const geometryScale = this._simulationOptions.scale ?? 1;
    // ngspice-47 mos*param/resparam/capparam: scale explicit instance
    // geometry only, before model defaults and parasitic expansion. Copy the
    // descriptors so recompilation and netlist serialization never scale twice.
    const flatDescriptors = this.expandAllSubcircuits(globalNodes, guard).map(desc => {
      if (geometryScale === 1 || !desc.params || !['M', 'R', 'C'].includes(desc.type)) return desc;
      const params = { ...desc.params };
      const lengths = desc.type === 'M' ? ['L', 'W', 'PD', 'PS'] : ['L', 'W'];
      for (const key of lengths) if (params[key] !== undefined) params[key] *= geometryScale;
      if (desc.type === 'M') {
        for (const key of ['AD', 'AS']) if (params[key] !== undefined) params[key] *= geometryScale * geometryScale;
      }
      return { ...desc, params };
    });
    this.assertDeviceModelTypes(flatDescriptors);
    // ngspice a80f6e3 cktsopt.c sets the default model TNOM; bounded BJT,
    // MOS1, JFET, diode and R/C/L construction consume it.
    if (this._nominalTemperature !== undefined && this._nominalTemperature !== NOMINAL_TEMPERATURE_C) {
      for (const desc of flatDescriptors) {
        const passiveParams = { ...this._models.get(desc.modelName ?? '')?.params, ...desc.params };
        const boundedBjt = desc.type === 'Q' && !isVBICLevel(passiveParams.LEVEL);
        const boundedMos1 = desc.type === 'M' && (passiveParams.LEVEL ?? 1) === 1
          && !isVdmosModelType(this._models.get(desc.modelName ?? '')?.type ?? '');
        if (!boundedBjt && !boundedMos1 && !['J', 'D', 'R', 'C', 'L', 'V', 'I', 'B'].includes(desc.type)) {
          throw new InvalidCircuitError(
            `.options TNOM=${this._nominalTemperature} is unsupported for ${desc.type} '${desc.name}': `
            + 'circuit TNOM currently supports only BJTs, MOS1, JFETs, diodes, R/C/L and independent or behavioral sources',
          );
        }
      }
    }
    const expandedDescriptors = withRFPortNodes(this.expandPassiveParasitics(
      this.expandLossyTransmissionLines(flatDescriptors.flatMap(desc => {
        if (desc.type !== 'U') return [desc];
        const model = this._models.get(desc.modelName!);
        if (!model) throw new InvalidCircuitError(`URC '${desc.name}' references unknown model '${desc.modelName}'`);
        parseUrcParams(Object.entries(model.params).map(([key, value]) => `${key}=${value}`), 0, true);
        const expanded = expandUrc(desc.name, desc.nodes, desc.params!, model);
        if (expanded.model) this._models.set(expanded.model.name, expanded.model);
        return expanded.devices;
      })),
    ));
    guard?.maximum('maxComponents', expandedDescriptors.length, 'compile');
    if (
      expandedDescriptors.some(desc => desc.type === 'Z')
      && this._steps.some(step => step.param.toUpperCase() === 'TEMP')
    ) {
      throw new InvalidCircuitError("Unsupported bounded HFET step: 'TEMP'");
    }
    const hasNMF = expandedDescriptors.some(desc =>
      desc.type === 'Z' && this._models.get(desc.modelName!)?.type === 'NMF');
    if (hasNMF) {
      const unsupported = this._poleZeroAnalyses.length > 0
        ? 'pz'
        : this._analyses.find(analysis =>
          analysis.type !== 'op' && analysis.type !== 'dc' && analysis.type !== 'tran'
          && analysis.type !== 'ac')?.type;
      if (unsupported) {
        throw new InvalidCircuitError(
          `NMF MESFET supports only .op, .dc, .tran and .ac analyses; '.${unsupported}' is unsupported`,
        );
      }
    }

    const hasSwecLines = expandedDescriptors.some(desc => desc.type === 'Y' || desc.type === 'P');
    if (hasSwecLines) {
      // ngspice-47 TXL/CPL only define DC (series-resistance) and transient
      // behaviour; their AC load reuses the transient load.
      const unsupported = this._poleZeroAnalyses.length > 0
        ? 'pz'
        : this._analyses.find(analysis =>
          analysis.type !== 'op' && analysis.type !== 'dc' && analysis.type !== 'tran')?.type;
      if (unsupported) {
        throw new InvalidCircuitError(
          `TXL/CPL lossy lines (Y and P elements) support only .op, .dc and .tran analyses; '.${unsupported}' is unsupported`,
        );
      }
    }

    const hasBoundedVBIC = expandedDescriptors.some(desc =>
      desc.type === 'Q' && isVBICLevel(this._models.get(desc.modelName!)?.params.LEVEL));
    const quasiBJT = expandedDescriptors.find(desc => desc.type === 'Q'
      && !isVBICLevel(this._models.get(desc.modelName!)?.params.LEVEL)
      && (this._models.get(desc.modelName!)?.params.RCO ?? 0) > 0);
    if (quasiBJT) {
      const unsupported = this._poleZeroAnalyses.length > 0 ? 'pz'
        : this._analyses.find(analysis =>
          analysis.type !== 'op' && analysis.type !== 'dc' && analysis.type !== 'ac')?.type;
      if (unsupported) {
        throw new UnsupportedModelParameterError(quasiBJT.name, 'RCO',
          `BJT quasi-saturation supports only static op/dc; ${unsupported} is unsupported`);
      }
    }
    if (hasBoundedVBIC) {
      const unsupportedStep = this._steps.find(step => step.param.toUpperCase() === 'TEMP');
      if (unsupportedStep) {
        throw new InvalidCircuitError("Unsupported bounded VBIC step: 'TEMP'");
      }
      // Bounded VBIC supports small-signal noise and transient charges, but
      // does not implement distortion terms.
      const unsupported = this._analyses.find(analysis =>
        analysis.type !== 'op' && analysis.type !== 'dc' && analysis.type !== 'ac' && analysis.type !== 'tran' && analysis.type !== 'noise');
      if (unsupported) {
        throw new InvalidCircuitError(`Unsupported bounded VBIC analysis: '${unsupported.type}'`);
      }
    }

    // XSPICE A instances: their nodes follow from the code model's port table.
    const xspiceInstances = new Map<DeviceDescriptor, PreparedXspiceInstance>();
    for (const desc of expandedDescriptors) {
      if (desc.type === 'S' || desc.type === 'W') {
        // A PSpice VSWITCH (ISWITCH) switch: ngspice-47 inpcompat.c rewrites the S (W)
        // card into a pswitch (aswitch) instance, see pspiceSwitchInstance.
        const switchModel = this._xspiceModels.get(desc.modelName!.toUpperCase());
        if (!switchModel?.pspiceSwitch) continue;
        if (switchModel.pspiceSwitch !== desc.type) {
          // ngspice rewrites only the matching letter and renames the model to
          // a<name>, so the other switch letter finds no model of that name.
          throw new InvalidCircuitError(
            `${desc.type === 'S' ? 'Switch' : 'Current switch'} '${desc.name}': model '${desc.modelName}' is a PSpice `
              + `${switchModel.pspiceSwitch === 'S' ? 'VSWITCH (S instances only)' : 'ISWITCH (W instances only)'}`,
          );
        }
        xspiceInstances.set(desc, prepareXspiceInstance(pspiceSwitchInstance(desc), switchModel, false, GROUND_NODE));
        continue;
      }
      if (desc.type !== 'A') continue;
      const model = this._xspiceModels.get(desc.modelName!.toUpperCase());
      const prepared = prepareXspiceInstance(
        desc.xspice!,
        model?.pspiceSwitch ? undefined : model,
        this._models.has(desc.modelName!) || model?.pspiceSwitch !== undefined,
        GROUND_NODE,
      );
      desc.nodes = [...prepared.nodes];
      xspiceInstances.set(desc, prepared);
    }
    assertXspiceAnalyses(
      [...xspiceInstances.values()],
      [
        ...this._analyses.map(analysis => analysis.type),
        ...(this._poleZeroAnalyses.length > 0 ? ['pz'] : []),
      ],
    );

    if ([...xspiceInstances.values()].some(instance => instance.digitalNodes.length > 0)) {
      const bridges = implicitXspiceBridges(
        [...xspiceInstances.values()],
        new Set(expandedDescriptors.flatMap(desc => desc.nodes.map(name => name.toUpperCase()))),
        new Set(expandedDescriptors.map(desc => desc.name.toUpperCase())),
        evaluateExpression('VCC', { VCC: 3.3, ...this.parameters }),
        GROUND_NODE,
      );
      for (const prepared of bridges) {
        const desc: DeviceDescriptor = { type: 'A', name: prepared.card.name, nodes: [...prepared.nodes], xspice: prepared.card };
        expandedDescriptors.push(desc);
        xspiceInstances.set(desc, prepared);
      }
    }

    // Only flattened device nodes belong in the matrix. In particular, a
    // .global name can override a formal port and leave its actual node unused.
    // Node names fold case as in ngspice (#728): the first spelling is kept.
    const globalNode = globalNodes.size === 0
      ? (name: string): string => name
      : (name: string): string => globalNodes.get(name.toUpperCase()) ?? name;
    this.nodeSet.clear();
    // Display spelling of every raw node reference, folded once per distinct
    // raw string rather than once per reference (#796).
    const canonicalByRaw = new Map<string, string>();
    for (const desc of expandedDescriptors) {
      for (const n of desc.nodes) {
        if (!canonicalByRaw.has(n)) canonicalByRaw.set(n, this.nodeSet.addCanonical(globalNode(n)));
      }
    }
    const canonicalNode = (name: string): string => this.nodeSet.canonical(globalNode(name));

    // Bridges connect the separate analog matrix and digital event network.
    const eventNetwork = buildXspiceEventNetwork([...xspiceInstances.values()]);

    const nodeNames = [...this.nodeSet].filter(n => n !== GROUND_NODE).sort();
    const nodeIndexMap = new Map<string, number>();
    nodeNames.forEach((name, i) => nodeIndexMap.set(name, i));
    nodeIndexMap.set(GROUND_NODE, -1);

    const nodeCount = nodeNames.length;
    let branchIndex = 0;
    const branchNames: string[] = [];

    // A name that is itself a display spelling resolves directly: the other
    // spellings fold onto it and `.global` keeps its fold (#796).
    const resolveNode = (name: string): number => {
      if (name === GROUND_NODE) return -1;
      return nodeIndexMap.get(name)
        ?? nodeIndexMap.get(canonicalByRaw.get(name) ?? canonicalNode(name))!;
    };

    const resolveWaveform = (wf?: Partial<SourceWaveform> & { dc?: number }): SourceWaveform => {
      if (!wf) return { type: 'dc', value: 0 };
      if (wf.type === 'ac') {
        return {
          type: 'ac',
          dc: wf.dc ?? 0,
          magnitude: wf.magnitude ?? 1,
          phase: wf.phase ?? 0,
          ...(wf.distortionF1 ? { distortionF1: { ...wf.distortionF1 } } : {}),
          ...(wf.distortionF2 ? { distortionF2: { ...wf.distortionF2 } } : {}),
        };
      }
      if (wf.type) return wf as SourceWaveform;
      const distortion = {
        ...(wf.distortionF1 ? { distortionF1: { ...wf.distortionF1 } } : {}),
        ...(wf.distortionF2 ? { distortionF2: { ...wf.distortionF2 } } : {}),
      };
      if (wf.dc !== undefined) return { type: 'dc', value: wf.dc, ...distortion };
      return { type: 'dc', value: 0, ...distortion };
    };

    const devices: DeviceModel[] = [];
    // Element names fold case as in ngspice: K, F/H, W and i() references (#754).
    const deviceMap = new CaseInsensitiveMap<DeviceModel>();
    // One random stream per compiled circuit for its TRNOISE/TRRANDOM sources (ngspice has one per process).
    const noiseContext = new TransientNoiseContext(this._simulationOptions.seed);
    const pendingCurrentSwitches: { device: CurrentSwitch; controlSource: string }[] = [];
    const pendingBehavioralSources: BehavioralSource[] = [];
    const pendingCurrentControlled: { device: CCCS | CCVS; kind: 'CCCS' | 'CCVS'; controlSource: string }[] = [];
    const ltraStates = new Map<string, LtraModelState>();
    // BSIM3 instances per ngspice model, in netlist order (b3v32temp.c pParam reuse, #700).
    const bsim3ModelInstances = new Map<string, BSIM3v3[]>();
    const pendingCouplings: DeviceDescriptor[] = [];

    for (const desc of expandedDescriptors) {
      guard?.checkpoint('compile:device');
      const nodeIndices = desc.nodes.map(resolveNode);
      const prevLength = devices.length;

      switch (desc.type) {
        case 'R': {
          const model = desc.modelName ? this.requireModel('Resistor', desc) : undefined;
          const resolved = resolveResistor(desc.name, desc.value, model, {
            TNOM: desc.params?.TNOM ?? model?.params.TNOM ?? this._nominalTemperature ?? NOMINAL_TEMPERATURE_C,
            ...desc.params,
          });
          // A zero-ohm resistor is an ideal voltage constraint, not infinite
          // conductance. Give it an MNA branch so its equation and current are
          // represented exactly. Stepped resistors also use branch form because
          // their value may cross zero without changing matrix topology.
          const usesBranch = resolved.resistance === 0 || this._steps.some(step =>
            step.param === desc.name || step.param.toUpperCase() === 'TEMP');
          const bi = usesBranch ? branchIndex++ : undefined;
          if (bi !== undefined) branchNames.push(desc.name);
          devices.push(new Resistor(desc.name, nodeIndices, resolved.resistance, bi, resolved.parameters));
          break;
        }
        case 'V': {
          const bi = branchIndex++;
          branchNames.push(desc.name);
          devices.push(new VoltageSource(
            desc.name, nodeIndices, bi, resolveWaveform(desc.waveform), desc.port, noiseContext,
          ));
          break;
        }
        case 'I':
          devices.push(new CurrentSource(
            desc.name, nodeIndices, resolveWaveform(desc.waveform), noiseContext, desc.multiplier,
          ));
          break;
        case 'C': {
          const model = desc.modelName ? this._models.get(desc.modelName) : undefined;
          if (desc.modelName && !model) {
            throw new InvalidCircuitError(`Capacitor '${desc.name}' references unknown model '${desc.modelName}'`);
          }
          const { value, unitValue, multiplier, scale } = resolveCapacitance(
            desc.value, model, desc.params, this._temperature, this._nominalTemperature,
          );
          devices.push(new Capacitor(desc.name, nodeIndices, value, desc.ic, unitValue, multiplier, scale));
          break;
        }
        case 'L': {
          const model = desc.modelName ? this._models.get(desc.modelName) : undefined;
          if (desc.modelName && !model) {
            throw new InvalidCircuitError(`Inductor '${desc.name}' references unknown model '${desc.modelName}'`);
          }
          const { value, unitValue, multiplier, scale } = resolveInductance(
            desc.value, model, desc.params, this._temperature, this._nominalTemperature,
          );
          const bi = branchIndex++;
          branchNames.push(desc.name);
          devices.push(new Inductor(desc.name, nodeIndices, bi, value, desc.ic, unitValue, multiplier, scale));
          break;
        }
        case 'K': {
          const indA = deviceMap.get(desc.coupledA!);
          const indB = deviceMap.get(desc.coupledB!);
          if (!(indA instanceof Inductor) || !(indB instanceof Inductor)) {
            // ngspice binds K after every instance exists (MUTsetup), so the
            // inductors may follow the K card; resolve those after the loop.
            pendingCouplings.push(desc);
            break;
          }
          devices.push(new MutualInductor(desc.name, indA, indB, desc.value!));
          break;
        }
        case 'T': {
          const firstBranch = branchIndex++;
          const secondBranch = branchIndex++;
          branchNames.push(`${desc.name}:1`, `${desc.name}:2`);
          devices.push(new TransmissionLine(
            desc.name,
            nodeIndices,
            firstBranch,
            secondBranch,
            desc.value!,
            desc.params!.TD,
            desc.params!.IC_V1 === undefined ? undefined : [
              desc.params!.IC_V1, desc.params!.IC_I1, desc.params!.IC_V2, desc.params!.IC_I2,
            ],
            desc.params!.REL,
            desc.params!.ABS,
          ));
          break;
        }
        case 'O': {
          const firstBranch = branchIndex++;
          const secondBranch = branchIndex++;
          branchNames.push(`${desc.name}:1`, `${desc.name}:2`);
          const modelName = desc.modelName!;
          let state = ltraStates.get(modelName);
          if (!state) {
            state = new LtraModelState(resolveLtraModel(this._models.get(modelName)!, {
              reltol: this._simulationOptions.reltol ?? 1e-3,
              abstol: this._simulationOptions.abstol ?? 1e-12,
            }));
            ltraStates.set(modelName, state);
          }
          devices.push(new LossyTransmissionLine(desc.name, nodeIndices, firstBranch, secondBranch, state));
          break;
        }
        case 'Y':
        case 'P': {
          const lines = desc.nodes.length / 2;
          const names = swecLineBranchNames(desc.name, desc.type, lines);
          const branches = names.map(() => branchIndex++);
          branchNames.push(...names);
          devices.push(createSwecLine(
            { name: desc.name, card: desc.type, nodes: nodeIndices, length: desc.params?.LEN },
            this._models.get(desc.modelName ?? ''),
            desc.modelName ?? '',
            branches,
          ));
          break;
        }
        case 'D': {
          const rawModelParams = desc.diodeModelParams
            ?? (desc.modelName ? this.requireModel('Diode', desc).params : {});
          const modelParams = this._nominalTemperature === undefined ? rawModelParams
            : { TNOM: rawModelParams.TREF ?? this._nominalTemperature, ...rawModelParams };
          if (desc.params?.THERMAL && nodeIndices.length === 3 && modelParams.RTH0 !== undefined) {
            if (!(modelParams.RTH0 > 0) || (modelParams.CTH0 ?? 1e-5) < 0) {
              throw new InvalidCircuitError('Diode RTH0 must be positive and CTH0 non-negative');
            }
            // ngspice-47 diosetup.c:277-278 defaults CTH0 to 1e-5 J/K.
            devices.push(new Capacitor(`${desc.name}.CTH`, [nodeIndices[2], -1], modelParams.CTH0 ?? 1e-5));
          }
          const { RS: seriesResistanceOverride, ...instanceParams } = desc.params ?? {};
          const hasExpandedSeriesResistance = isPositiveFinite(modelParams.RS)
            && seriesResistanceOverride === 0;
          devices.push(new Diode(
            desc.name,
            nodeIndices,
            seriesResistanceOverride === undefined
              ? modelParams
              : { ...modelParams, RS: seriesResistanceOverride },
            hasExpandedSeriesResistance,
            instanceParams,
            desc.diodeCurrentControlNode === undefined ? undefined : resolveNode(desc.diodeCurrentControlNode),
          ));
          break;
        }
        case 'Q': {
          const modelName = desc.modelName!;
          const model = this._models.get(modelName);
          if (!model && modelName !== '0') this.requireModel('BJT', desc);
          if (!model) {
            devices.push(new BJT(desc.name, nodeIndices, {
              polarity: 1, TNOM: this._nominalTemperature ?? NOMINAL_TEMPERATURE_C,
            }, desc.params));
            break;
          }
          if (model.type !== 'NPN' && model.type !== 'PNP') {
            throw new Error(`Unsupported BJT model type: '${model.type}'`);
          }
          const modelParams = model.params;
          const polarity = model.type === 'PNP' ? -1 : 1;
          if (isVBICLevel(modelParams.LEVEL)) {
            if (desc.params?.ICVBE !== undefined || desc.params?.ICVCE !== undefined) {
              throw new InvalidCircuitError(`VBIC '${desc.name}' does not support instance IC`);
            }
            // ngspice-47 vbic.c has no areab/areac instance parameters.
            const geometry = ['AREAB', 'AREAC'].filter(name => desc.params?.[name] !== undefined);
            if (geometry.length > 0) {
              throw new InvalidCircuitError(
                `VBIC '${desc.name}' does not accept instance parameters: ${geometry.join(', ')}`,
              );
            }
            devices.push(new VBIC(desc.name, nodeIndices, modelParams, polarity, bjtInstanceScale(desc.params), desc.params?.M ?? 1,
              desc.vbicTerminals?.map(resolveNode)));
          } else {
            devices.push(new BJT(desc.name, nodeIndices, {
              TNOM: this._nominalTemperature ?? NOMINAL_TEMPERATURE_C, ...modelParams, polarity,
            }, desc.params,
              desc.bjtICTerminals?.map(resolveNode)));
          }
          break;
        }
        case 'J': {
          const model = this.requireModel('JFET', desc);
          if (model.type !== 'NJF' && model.type !== 'PJF') {
            throw new Error(`Unsupported JFET model type: '${model.type}'`);
          }
          devices.push(new JFET(desc.name, nodeIndices, model.params, model.type === 'PJF' ? -1 : 1, {
            ...desc.params, OFF: desc.params?.OFF === undefined ? undefined : desc.params.OFF !== 0,
          }, { temperatureC: this._temperature, nominalTemperatureC: this._nominalTemperature }));
          break;
        }
        case 'Z': {
          const model = this.requireModel('Z-card', desc);
          devices.push(createZDevice(
            desc.name, nodeIndices, resolveZModel(model), desc.params, this._simulationOptions.deviceGmin,
          ));
          break;
        }
        case 'B': {
          const compiledExpression = compileBehavioralExpression(desc.expression!);
          const { kind, params } = desc.behavioral!;
          if (kind === 'voltage') {
            const bi = branchIndex++;
            branchNames.push(desc.name);
            devices.push(new BehavioralVoltageSource(desc.name, nodeIndices, bi, compiledExpression, params));
          } else {
            devices.push(new BehavioralCurrentSource(desc.name, nodeIndices, compiledExpression, params));
          }
          // i() sources may be declared after the B-source; bind their branches below.
          if (compiledExpression.sources.length > 0) {
            pendingBehavioralSources.push(devices[devices.length - 1] as BehavioralSource);
          }
          break;
        }
        case 'M': {
          const model = this.requireModel('MOSFET', desc);
          if (isVdmosModelType(model.type)) {
            // Nodes were expanded to [D, G, S, D', G', S', B'] by expandPassiveParasitics.
            const { model: vdmosModel, warnings } = resolveVdmosModel(model);
            devices.push(new VDMOS(
              desc.name, nodeIndices, vdmosModel, vdmosInstanceParams(desc), warnings,
            ));
            break;
          }
          const modelParams = model.params;
          const polarity = model.type === 'PMOS' ? -1 : 1;
          const level = modelParams.LEVEL ?? 1;

          if (level === 260) {
            if (model.version !== undefined) {
              throw new UnsupportedModelVersionError(desc.name, desc.modelName, level, model.version, []);
            }
            const bulkNode = desc.nodes[3] ?? desc.nodes[2];
            const ekv = new EKV26(desc.name,
              [desc.nodes[0], desc.nodes[1], desc.nodes[2], bulkNode].map(resolveNode),
              modelParams, desc.params ?? {}, polarity, desc.modelName);
            ekv.setTemperature(this._temperature ?? NOMINAL_TEMPERATURE_C);
            devices.push(ekv);
          } else if (level === 14 || level === 54) {
            // Only the pinned bsim4/ (4.8.x) equations are ported, not bsim4v7/.
            if (model.version !== undefined && !/^4\.8(?:[0-3]|\.[0-3])?$/.test(model.version)) {
              throw new UnsupportedModelVersionError(
                desc.name, model.name, level, model.version, ['4.8', '4.8.0', '4.8.1', '4.8.2', '4.8.3'],
              );
            }
            const bulkNode = desc.nodes[3] ?? desc.nodes[2];
            const bsim4 = new BSIM4(desc.name,
              [desc.nodes[0], desc.nodes[1], desc.nodes[2], bulkNode, ...desc.nodes.slice(4)].map(resolveNode),
              { ...modelParams, ...(model.version !== undefined ? { VERSION: model.version } : {}) },
              desc.params ?? {}, polarity);
            bsim4.assertAnalyses([
              ...this._analyses.map(analysis => analysis.type),
              ...(this._poleZeroAnalyses.length > 0 ? ['pz'] : []),
            ]);
            devices.push(bsim4);
          } else if (level === 49 || level === 8) {
            // #503/#594: VERSION=3.2.x runs the bsim3v32 revisions; 3.0/3.1 (BSIM3v0/v1) are not implemented.
            if (!isSupportedBsim3Version(model.version)) {
              throw new UnsupportedModelVersionError(
                desc.name, desc.modelName, level, model.version!, SUPPORTED_BSIM3_VERSIONS,
              );
            }
            // BSIM3v3 — 4-terminal
            const bulkNode = desc.nodes.length >= 4 ? desc.nodes[3] : desc.nodes[2]; // default bulk=source
            const nodeIdxs = [
              resolveNode(desc.nodes[0]),
              resolveNode(desc.nodes[1]),
              resolveNode(desc.nodes[2]),
              resolveNode(bulkNode),
            ];
            // Instance W/L/AD/AS/PD/PS/DELVTO/MULU0/M; b3set.c supplies the defaults.
            const bsim3 = new BSIM3v3(desc.name, nodeIdxs, modelParams, desc.params ?? {}, polarity, model.version);
            devices.push(bsim3);
            // A subcircuit-local card is already a separate model per instance (#854).
            const key = model.name.toUpperCase();
            const group = bsim3ModelInstances.get(key);
            if (group) group.push(bsim3); else bsim3ModelInstances.set(key, [bsim3]);
          } else if (level === 6) {
            // MOS6 (Sakurai-Newton n-th power law) — 4-terminal, bulk defaults to source.
            const bulkNode = desc.nodes.length >= 4 ? desc.nodes[3] : desc.nodes[2];
            const nodeIdxs = [
              resolveNode(desc.nodes[0]),
              resolveNode(desc.nodes[1]),
              resolveNode(desc.nodes[2]),
              resolveNode(bulkNode),
            ];
            devices.push(new MOS6(
              desc.name, nodeIdxs,
              resolveMOS6Model(desc.modelName!, modelParams, polarity),
              desc.params ?? {},
              this._temperature ?? NOMINAL_TEMPERATURE_C,
            ));
          } else if (level === 4 || level === 5) {
            // BSIM1 (LEVEL=4) / BSIM2 (LEVEL=5); expandPassiveParasitics gave [D', G, S', B].
            const nodeIdxs = desc.nodes.map(resolveNode);
            devices.push(level === 4
              ? createBSIM1(desc.name, nodeIdxs, resolveBSIM1Model(desc.modelName!, modelParams, polarity), desc.params)
              : createBSIM2(desc.name, nodeIdxs, resolveBSIM2Model(desc.modelName!, modelParams, polarity), desc.params));
          } else if (level === 2) {
            // MOS2 (Grove-Frohman, ngspice mos2) — 4-terminal, bulk defaults to source.
            const bulkNode = desc.nodes.length >= 4 ? desc.nodes[3] : desc.nodes[2];
            const nodeIdxs = [
              resolveNode(desc.nodes[0]),
              resolveNode(desc.nodes[1]),
              resolveNode(desc.nodes[2]),
              resolveNode(bulkNode),
            ];
            devices.push(new MOS2(
              desc.name, nodeIdxs,
              resolveMOS2Model(desc.modelName!, modelParams, polarity),
              desc.params ?? {},
            ));
          } else if (level === 3 || level === 9) {
            // MOS3 / MOS9 (ngspice mos3, mos9); expandPassiveParasitics gave [D', G, S', B].
            devices.push(new MOS3(
              desc.name, desc.nodes.map(resolveNode),
              resolveMOS3Model(desc.modelName!, modelParams, polarity, level),
              desc.params ?? {},
            ));
          } else if (level === 1) {
            // Level 1 (ngspice mos1); bulk defaults to source.
            const bulkNode = desc.nodes.length >= 4 ? desc.nodes[3] : desc.nodes[2];
            const nodeIdxs = [
              resolveNode(desc.nodes[0]),
              resolveNode(desc.nodes[1]),
              resolveNode(desc.nodes[2]),
              resolveNode(bulkNode),
            ];
            devices.push(new MOSFET(desc.name, nodeIdxs, {
              TNOM: this._nominalTemperature ?? NOMINAL_TEMPERATURE_C,
              ...modelParams, ...desc.params, polarity,
            }));
          } else {
            // #530: never evaluate an unimplemented level (MOS3, BSIM1/2, ...) with Level-1 equations.
            throw new UnsupportedModelLevelError(desc.name, desc.modelName, level, SUPPORTED_MOSFET_LEVELS);
          }
          break;
        }
        case 'G': {
          devices.push(new VCCS(desc.name, nodeIndices, desc.value!));
          break;
        }
        case 'E': {
          const bi = branchIndex++;
          branchNames.push(desc.name);
          devices.push(new VCVS(desc.name, nodeIndices, bi, desc.value!));
          break;
        }
        case 'F': {
          // The controlling source may follow this card (#860); bind its branch below.
          const device = new CCCS(desc.name, nodeIndices, -1, desc.value!);
          pendingCurrentControlled.push({ device, kind: 'CCCS', controlSource: desc.controlSource! });
          devices.push(device);
          break;
        }
        case 'H': {
          const bi = branchIndex++;
          branchNames.push(desc.name);
          const device = new CCVS(desc.name, nodeIndices, -1, bi, desc.value!);
          pendingCurrentControlled.push({ device, kind: 'CCVS', controlSource: desc.controlSource! });
          devices.push(device);
          break;
        }
        case 'S':
        case 'W': {
          const codeModelSwitch = xspiceInstances.get(desc);
          if (codeModelSwitch) {
            devices.push(createXspiceDevice(codeModelSwitch, resolveNode, () => {
              throw new Error(`switch '${desc.name}' has no branch`);
            })!);
            break;
          }
          const type = desc.type === 'S' ? 'SW' : 'CSW';
          const model = this.requireModel(desc.type === 'S' ? 'Switch' : 'Current switch', desc);
          const { model: switchModel, warnings } = resolveSwitchModel(
            type, model.params, this._simulationOptions.deviceGmin ?? DEVICE_GMIN,
          );
          const initiallyOn = desc.params?.ON === 1;
          if (desc.type === 'S') {
            devices.push(new VoltageSwitch(desc.name, nodeIndices, switchModel, initiallyOn, warnings));
          } else {
            // The controlling source may be declared after the switch; bind its branch below.
            const device = new CurrentSwitch(desc.name, nodeIndices, -1, switchModel, initiallyOn, warnings);
            pendingCurrentSwitches.push({ device, controlSource: desc.controlSource! });
            devices.push(device);
          }
          break;
        }
        case 'A': {
          const prepared = xspiceInstances.get(desc)!;
          const device = createXspiceDevice(prepared, resolveNode, branchName => {
            branchNames.push(branchName);
            return branchIndex++;
          }, eventNetwork?.analogHalves.get(prepared));
          if (device) devices.push(device);
          break;
        }
        default:
          throw new Error(`Device type '${desc.type}' not yet implemented`);
      }

      if (devices.length > prevLength) {
        deviceMap.set(desc.name, devices[devices.length - 1]);
      }
    }

    for (const desc of pendingCouplings) {
      const indA = deviceMap.get(desc.coupledA!);
      const indB = deviceMap.get(desc.coupledB!);
      if (!(indA instanceof Inductor) || !(indB instanceof Inductor)) {
        throw new Error(
          `K-element '${desc.name}' references unknown or non-inductor device(s): ${desc.coupledA}, ${desc.coupledB}`,
        );
      }
      devices.push(new MutualInductor(desc.name, indA, indB, desc.value!));
      deviceMap.set(desc.name, devices[devices.length - 1]);
    }

    if (eventNetwork) devices.push(eventNetwork.network);
    // ngspice-47 loads the RSHUNT conductances after every device (cktload.c).
    const rshunt = this._simulationOptions.rshunt;
    if (rshunt !== undefined) {
      if (!Number.isFinite(rshunt) || rshunt <= 1e-30) {
        throw new InvalidCircuitError(`Invalid rshunt: ${rshunt} (must be a finite resistance above 1e-30 ohm)`);
      }
      const line = expandedDescriptors.find(desc => desc.type === 'T' || desc.type === 'O');
      if (line) {
        // ngspice-47 trasetup.c (T: i1, i2, int1, int2) and ltraset.c (O: i1,
        // i2) make the line's internal rows with CKTmkVolt, so RSHUNT shunts
        // them too; spice-ts's line models have no such node rows.
        throw new InvalidCircuitError(
          `Unsupported .options rshunt with transmission line '${line.name}': `
          + 'ngspice-47 also shunts the internal rows of T and O (LTRA) lines, which the spice-ts line models do not have',
        );
      }
      devices.push(new NodeShunt(rshunt));
    }
    bindXspiceSources(devices, deviceMap);
    for (const instances of bsim3ModelInstances.values()) BSIM3v3.linkBsim3v32SizeRecordReuse(instances);
    for (const { device, controlSource } of pendingCurrentSwitches) {
      const control = deviceMap.get(controlSource);
      if (!control || !(control instanceof VoltageSource)) {
        throw new InvalidCircuitError(
          `W-element '${device.name}' references unknown or non-voltage-source control '${controlSource}'`,
        );
      }
      device.bindControlBranch(control.branches[0]);
    }
    // ngspice-47 CCCSsetup/CCVSsetup look the controlling source up after every
    // instance exists, so it may be declared after the F/H card (#860).
    for (const { device, kind, controlSource } of pendingCurrentControlled) {
      const control = deviceMap.get(controlSource);
      if (!control || control.branches.length === 0) {
        throw new InvalidCircuitError(
          `${kind} '${device.name}' references unknown or branchless source '${controlSource}'`,
        );
      }
      device.bindControlBranch(control.branches[0]);
    }
    bindBehavioralControlBranches(pendingBehavioralSources, deviceMap);

    if (this._temperature !== undefined && this._temperature !== NOMINAL_TEMPERATURE_C) {
      this.applyCircuitTemperature(this._temperature, devices);
    }

    validateCoupledInductors(devices);

    return {
      devices, nodeCount, branchCount: branchNames.length,
      recompileAtTemperature: this.recompileAtTemperature,
      nodeNames, nodeIndexMap, branchNames,
      analyses: this._analyses, poleZeroAnalyses: this._poleZeroAnalyses, models: this._models,
      subcircuits: this._subcircuits,
      steps: this._steps,
      simulationOptions: {
        ...this._simulationOptions,
        // ngspice cktdojob.c: with 'A' devices present, trtol above 1 becomes
        // the `xtrtol` variable (set by `.options XTRTOL=`) or else 1. POLY
        // sources are 'A' devices in ngspice-47 (enhtrans.c, #862).
        ...((xspiceInstances.size > 0 || expandedDescriptors.some(desc => desc.behavioral?.params.spice2poly))
          && (this._simulationOptions.trtol ?? DEFAULT_OPTIONS.trtol) > 1
          ? { trtol: this._xspiceTrtol ?? 1 }
          : {}),
      },
      initialConditions: this._initialConditions.map(state => ({ ...state })),
      nodeSets: this._nodeSets.map(state => ({ ...state })),
    };
  }

  /**
   * Evaluate the compiled devices at a non-nominal `.options TEMP` like ngspice.
   * Only devices whose temperature model follows ngspice-47 are accepted:
   * resistors (TC1/TC2 around TNOM), C/L (resolved during construction), the bounded VBIC (vbictemp.c mapping),
   * B sources (asrctemp.c tc1/tc2 and `temper`), diodes (diotemp.c), the
   * Gummel-Poon BJT (bjttemp.c), MOS levels 1/2/3/6 (mos*temp.c), BSIM1/2
   * (b1temp.c/b2temp.c ignore circuit temperature; junctions use CONSTvt0), and BSIM3 (b3temp.c,
   * b3v32temp.c). Every other temperature-dependent element is rejected instead of silently
   * running at 27 C.
   */
  private applyCircuitTemperature(
    temperature: number,
    devices: DeviceModel[],
  ): void {
    // Resistor.setTemperature preserves instance TEMP precedence and adds DTEMP
    // only when TEMP is absent (ngspice-47 restemp.c).
    // SW/CSW have no temperature routine in ngspice: their resistances and
    // thresholds are temperature-independent, despite nonlinear stamping.
    for (const device of devices) {
      if (device instanceof Resistor || device instanceof VBIC || device instanceof BehavioralSource
        || device instanceof Diode || device instanceof BJT || device instanceof MOSFET
        || device instanceof MOS2 || device instanceof MOS6 || device instanceof MOS3
        || device instanceof ClassicBsimMosfet
        || device instanceof BSIM3v3 || device instanceof BSIM4 || device instanceof EKV26) {
        device.setTemperature(temperature);
      } else if (device.isNonlinear && !(device instanceof JFET)
        && !(device instanceof VoltageSwitch) && !(device instanceof CurrentSwitch)) {
        throw new UnsupportedTemperatureError(device.name, temperature);
      }
    }
  }

  /** Top-level `.param` values as a prototype-free variable record for subcircuit scopes. */
  private parameterScope(): ParameterScope {
    this._parameterScope ??= Object.assign(Object.create(null) as ParameterScope, this.parameters);
    bindParameterRandom(this._parameterScope, parameterRandom(this));
    return this._parameterScope;
  }

  /** Collect top-level and reachable subcircuit `.global` declarations. */
  private collectGlobalNodes(guard?: ProtocolExecutionGuard): Map<string, string> {
    const globals = new Map(this._globalNodes);
    // ngspice removes unused definitions before collecting globals. Discover
    // the reachable definitions first, so declarations are independent of
    // instance order and take effect before any parent port is mapped.
    const pending = this.descriptors.filter(desc => desc.type === 'X').map(desc => desc.modelName!);
    const visited = new Set<string>();
    while (pending.length > 0) {
      guard?.checkpoint('compile:device');
      const name = pending.pop()!.toUpperCase();
      if (visited.has(name)) continue;
      visited.add(name);
      const def = this._subcircuits.get(name);
      if (!def) continue; // Expansion reports the undefined-subcircuit error.
      for (const { tokens, raw } of tokenizeNetlist(def.body.join('\n'))) {
        if (tokens[0]?.toUpperCase() === '.GLOBAL') {
          for (const node of tokens.slice(1)) {
            const key = node.toUpperCase();
            if (node !== GROUND_NODE && !globals.has(key)) globals.set(key, node);
          }
        } else if (tokens[0]?.[0].toUpperCase() === 'X') {
          pending.push(tokens[locateSubcircuitCall(tokens, raw).nameIndex]);
        }
      }
    }
    return globals;
  }

  /** Expand X instances; non-X descriptors pass through unchanged. */
  private expandAllSubcircuits(globalNodes: ReadonlyMap<string, string>, guard?: ProtocolExecutionGuard): DeviceDescriptor[] {
    const result: DeviceDescriptor[] = [];
    for (const desc of this.descriptors) {
      guard?.checkpoint('compile:device');
      if (desc.type === 'X') {
        const expanded = this.expandSubcircuit(
          desc.name,
          desc.nodes,
          desc.modelName!,
          desc.params ?? {},
          new Set<string>(),
          globalNodes,
          guard,
          1,
          [],
          1,
          this.parameterScope(),
          this._subcircuitCallCards.get(desc),
        );
        result.push(...expanded.map(device => this._subcircuitAlterations.get(device.name.toUpperCase()) ?? device));
      } else {
        result.push(desc);
      }
      guard?.maximum('maxComponents', result.length, 'compile');
    }
    return result;
  }

  /**
   * Validate O/LTRA instances after subcircuit expansion. Model lookup happens
   * here, not at parse time, because O cards in uncalled subcircuits may name
   * undefined models.
   */
  private expandLossyTransmissionLines(descriptors: DeviceDescriptor[]): DeviceDescriptor[] {
    let hasLossyLine = false;
    for (const desc of descriptors) {
      if (desc.type !== 'O') continue;
      hasLossyLine = true;
      const [, inputReference, , outputReference] = desc.nodes;
      if (inputReference.toUpperCase() !== outputReference.toUpperCase()) {
        throw new Error(`Unsupported LTRA '${desc.name}': both ports must use a common reference node`);
      }
      const model = this._models.get(desc.modelName!);
      if (!model) throw new InvalidCircuitError(`LTRA '${desc.name}' references unknown model '${desc.modelName}'`);
      const resolved = resolveLtraModel(model);
      if (resolved.specialCase === 'RC' && this._analyses.some(analysis => analysis.type === 'tran')) {
        throw new InvalidCircuitError('LTRA RC transient analysis is unsupported');
      }
    }
    if (hasLossyLine) {
      // AC uses the frequency-dependent wave stamp; noise and pole-zero
      // analyses do not support that stamp yet.
      const unsupported = this._poleZeroAnalyses.length > 0
        ? 'pz'
        : this._analyses.find(analysis => !['op', 'dc', 'tran', 'tf', 'ac'].includes(analysis.type))?.type;
      if (unsupported) {
        throw new InvalidCircuitError(`LTRA lossy lines support only .op, .dc, .tf, .tran and .ac analyses; '.${unsupported}' is unsupported`);
      }
    }
    return descriptors;
  }

  private expandPassiveParasitics(descriptors: DeviceDescriptor[]): DeviceDescriptor[] {
    const result: DeviceDescriptor[] = [];

    for (const desc of descriptors) {
      if (desc.type === 'C') {
        const model = desc.modelName ? this._models.get(desc.modelName) : undefined;
        if (desc.modelName && !model) {
          throw new InvalidCircuitError(`Capacitor '${desc.name}' references unknown model '${desc.modelName}'`);
        }
        const resolved = resolveCapacitorModel(
          desc.value, model, desc.params, this._temperature, this._nominalTemperature,
        );
        if (hasCapacitorParasitics(resolved)) {
          result.push(...this.expandCapacitorDescriptor(desc, resolved));
        } else {
          result.push(desc);
        }
        continue;
      }

      if (desc.type === 'L') {
        const model = desc.modelName ? this._models.get(desc.modelName) : undefined;
        if (desc.modelName && !model) {
          throw new InvalidCircuitError(`Inductor '${desc.name}' references unknown model '${desc.modelName}'`);
        }
        const resolved = resolveInductorModel(
          desc.value, model, desc.params, this._temperature, this._nominalTemperature,
        );
        if (hasInductorParasitics(resolved)) {
          result.push(...this.expandInductorDescriptor(desc, resolved));
        } else {
          result.push(desc);
        }
        continue;
      }

      if (desc.type === 'D') {
        const model = desc.modelName ? this._models.get(desc.modelName) : undefined;
        const modelParams = desc.diodeModelParams ?? model?.params;
        const seriesResistance = desc.params?.RS ?? modelParams?.RS;
        const junctionCapacitance = modelParams ? diodeZeroBiasCapacitance(desc.name, modelParams) : undefined;
        const sidewallCapacitance = modelParams?.CJSW ?? modelParams?.CJP;
        const effectiveArea = (desc.params?.AREA ?? 1) * (desc.params?.M ?? 1);
        const effectivePerimeter = (desc.params?.PJ ?? 0) * (desc.params?.M ?? 1);
        if (isPositiveFinite(modelParams?.RSW)) {
          if (desc.params?.THERMAL) {
            throw new InvalidCircuitError('Self-heating diode RSW is not implemented');
          }
          const card = canonicalDiodeModelParams(desc.name, modelParams!) as Record<string, number>;
          const { RSW, ...common } = card;
          const [anode, cathode] = desc.nodes;
          const junction = internalNodeName(desc.name, 'rsw');
          const bottom = {
            ...desc, diodeForcePrimeNode: true,
            diodeModelParams: { ...common, JSW: 0, CJSW: 0 },
          };
          // diosetup.c/diotemp.c: RSW/(PJ*M), with the same TRS law as RS.
          // The sidewall has no breakdown or diffusion charge (dioload.c).
          if (effectivePerimeter > 0) {
            result.push({
              type: 'R', name: `${desc.name}.RSW`, nodes: [anode, junction],
              value: RSW / effectivePerimeter,
              params: {
                TC1: card.TRS1 ?? 0, TC2: card.TRS2 ?? 0, TNOM: card.TNOM ?? NOMINAL_TEMPERATURE_C,
                ...(desc.params?.TEMP !== undefined ? { TEMP: desc.params.TEMP } : {}),
                ...(desc.params?.DTEMP !== undefined ? { DTEMP: desc.params.DTEMP } : {}),
              },
            });
            result.push({
              ...desc, name: `${desc.name}.SW`, nodes: [junction, cathode],
              params: { ...desc.params, RS: 0 },
              diodeCurrentControlNode: card.NS === undefined
                ? (isPositiveFinite(seriesResistance) ? internalNodeName(desc.name, 'rs') : anode)
                : undefined,
              diodeModelParams: {
                ...common, IS: 0, RS: 0, CJO: 0, TT: 0, BV: Infinity, IKF: 0, IKR: 0,
              },
            });
          }
          result.push(...this.expandPassiveParasitics([bottom]));
          continue;
        }
        const transitTime = desc.params?.TT ?? modelParams?.TT;
        const hasJunctionCharge = isPositiveFinite(junctionCapacitance)
          || (isPositiveFinite(sidewallCapacitance) && effectivePerimeter > 0)
          || isPositiveFinite(transitTime);
        // ngspice-47 diosetup.c gives every RS > 0 a prime node; spice-ts folds
        // it into a two-terminal diode unless the junction stores charge or
        // RSHUNT must shunt that node to ground too (#824).
        const needsPrimeNode = !desc.params?.THERMAL
          && (desc.diodeForcePrimeNode || hasJunctionCharge || this._simulationOptions.rshunt !== undefined);
        if (isPositiveFinite(seriesResistance) && needsPrimeNode) {
          const [anode, cathode] = desc.nodes;
          const junction = internalNodeName(desc.name, 'rs');
          // ngspice-47 diotemp.c:253-258 scales RS by 1 + TRS1*dT + TRS2*dT^2
          // around the diode TNOM: the resistor TC1/TC2 law with the same TNOM.
          const card = modelParams ? canonicalDiodeModelParams(desc.name, modelParams) : {};
          const trs1 = card.TRS1 ?? 0;
          const trs2 = card.TRS2 ?? 0;
          result.push({
            type: 'R',
            name: `${desc.name}.RS`,
            nodes: [anode, junction],
            value: seriesResistance / effectiveArea,
            params: {
              TC1: trs1, TC2: trs2, TNOM: card.TNOM ?? NOMINAL_TEMPERATURE_C,
              ...(desc.params?.TEMP !== undefined ? { TEMP: desc.params.TEMP } : {}),
              ...(desc.params?.DTEMP !== undefined ? { DTEMP: desc.params.DTEMP } : {}),
            },
          });
          result.push({
            ...desc,
            nodes: [junction, cathode],
            params: { ...desc.params, RS: 0 },
          });
        } else {
          result.push(desc);
        }
        continue;
      }

      if (desc.type === 'Q') {
        const model = this._models.get(desc.modelName!);
        const isVBIC = (model?.type === 'NPN' || model?.type === 'PNP') && isVBICLevel(model.params.LEVEL);
        if (desc.nodes.length > 4 && !isVBIC) {
          // ngspice-47 accepts a fifth (thermal) node only for VBIC/HICUM.
          throw new InvalidCircuitError(
            `BJT '${desc.name}' has a thermal node, but only VBIC (LEVEL=4/9) instances accept a fifth terminal`);
        }
        // VBIC and the Gummel-Poon BJT both stamp the substrate terminal
        // (ngspice bjtload.c substrate junction); omitted, it is ground.
        const terminals = isVBIC ? desc.nodes : desc.nodes.slice(0, 4);
        // ngspice-47 scales every series conductance by AREA*M (bjttemp.c
        // area, bjtload.c m; vbicload.c SCALE), i.e. divides the resistance.
        const instanceScale = bjtInstanceScale(desc.params);
        if (model?.type === 'NPN' || model?.type === 'PNP') {
          if (isVBICLevel(model.params.LEVEL)) {
            const polarity = model.type === 'PNP' ? -1 : 1;
            const params = resolveVBICParams(model.params, polarity);
            let [collector, base, emitter] = terminals;
            // Omitted substrate is ground, as in ngspice.
            const substrate = terminals[3] ?? GROUND_NODE;
            let collectorExternal = collector;
            let baseExternal = base;
            let emitterInternal = emitter;
            let substrateInternal = substrate;
            if (params.RCX > 0) {
              collectorExternal = internalNodeName(desc.name, 'cx');
              if (params.XRCX === 0) result.push({
                type: 'R', name: `${desc.name}.RCX`, nodes: [collector, collectorExternal],
                value: params.RCX / instanceScale,
              });
            }
            if (params.RBX > 0) {
              baseExternal = internalNodeName(desc.name, 'bx');
              if (params.XRBX === 0) result.push({
                type: 'R', name: `${desc.name}.RBX`, nodes: [base, baseExternal],
                value: params.RBX / instanceScale,
              });
            }
            if (params.RE > 0) {
              emitterInternal = internalNodeName(desc.name, 'ei');
              if (params.XRE === 0) result.push({
                type: 'R', name: `${desc.name}.RE`, nodes: [emitter, emitterInternal],
                value: params.RE / instanceScale,
              });
            }
            if (params.RS > 0) {
              substrateInternal = internalNodeName(desc.name, 'si');
              if (params.XRS === 0) result.push({
                type: 'R', name: `${desc.name}.RS`, nodes: [substrate, substrateInternal],
                value: params.RS / instanceScale,
              });
            }
            result.push({
              ...desc,
              nodes: [
                collectorExternal,
                internalNodeName(desc.name, 'ci'),
                baseExternal,
                internalNodeName(desc.name, 'bi'),
                emitterInternal,
                internalNodeName(desc.name, 'bp'),
                substrateInternal,
                ...(vbicNodeCount(params) > 7
                  ? [internalNodeName(desc.name, 'xf1'), internalNodeName(desc.name, 'xf2')]
                  : []),
                ...(terminals.length > 4 ? [terminals[4]] : []),
              ],
              vbicTerminals: [collector, base, emitter, substrate],
            });
            continue;
          }
          let [collector, base, emitter] = terminals;
          // ngspice-47 bjtload.c: with RBM != RB the base resistance depends on
          // the bias, so the device stamps it on a fifth (external base) node.
          const variableBaseResistance = hasBiasDependentBaseResistance(model.params);
          const externalBase = base;
          for (const [parameter, terminal] of [
            ['RC', collector], ['RB', base], ['RE', emitter],
          ] as const) {
            const resistance = model.params[parameter];
            if (!isPositiveFinite(resistance)) continue;
            const internal = internalNodeName(desc.name, parameter.toLowerCase());
            if (parameter === 'RB' && variableBaseResistance) {
              base = internal;
              continue;
            }
            result.push({
              type: 'R', name: `${desc.name}.${parameter}`, nodes: [terminal, internal],
              value: resistance / instanceScale,
              params: {
                TC1: model.params[`T${parameter}1`] ?? 0,
                TC2: model.params[`T${parameter}2`] ?? 0,
                TNOM: model.params.TNOM ?? model.params.TREF ?? NOMINAL_TEMPERATURE_C,
              },
            });
            if (parameter === 'RC') collector = internal;
            else if (parameter === 'RB') base = internal;
            else emitter = internal;
          }
          const collectorEpi = collector;
          const quasiSaturation = isPositiveFinite(model.params.RCO);
          if (quasiSaturation) collector = internalNodeName(desc.name, 'collector');
          result.push({
            ...desc,
            nodes: quasiSaturation
              ? [collector, base, emitter, terminals[3] ?? GROUND_NODE,
                variableBaseResistance ? externalBase : base, collectorEpi]
              : variableBaseResistance && base !== externalBase
              ? [collector, base, emitter, terminals[3] ?? GROUND_NODE, externalBase]
              : [collector, base, emitter, ...terminals.slice(3)],
            bjtICTerminals: terminals.slice(0, 3),
          });
        } else {
          result.push({ ...desc, nodes: terminals });
        }
        continue;
      }

      if (desc.type === 'J') {
        const modelName = desc.modelName!;
        const model = this._models.get(modelName);
        if (!model) throw new InvalidCircuitError(`JFET '${desc.name}' references unknown model '${modelName}'`);
        if (model.type !== 'NJF' && model.type !== 'PJF') {
          throw new Error(`Unsupported JFET model type: '${model.type}'`);
        }
        const params = resolveNJFETParams(model.params);
        const scale = (desc.params?.AREA ?? 1) * (desc.params?.M ?? 1);
        let [drain, gate, source] = desc.nodes;
        if (params.RD > 0) {
          const drainPrime = internalNodeName(desc.name, 'rd');
          result.push({
            type: 'R', name: `${desc.name}.RD`, nodes: [drain, drainPrime], value: params.RD / scale,
          });
          drain = drainPrime;
        }
        if (params.RS > 0) {
          const sourcePrime = internalNodeName(desc.name, 'rs');
          result.push({
            type: 'R', name: `${desc.name}.RS`, nodes: [source, sourcePrime], value: params.RS / scale,
          });
          source = sourcePrime;
        }
        result.push({ ...desc, nodes: [drain, gate, source] });
        continue;
      }

      if (desc.type === 'M') {
        const model = this._models.get(desc.modelName ?? '');
        if (model && isVdmosModelType(model.type)) {
          result.push(this.expandVdmosDescriptor(desc, model));
          continue;
        }
        const level = model?.params.LEVEL;
        if (model && (level === 4 || level === 5)) {
          // BSIM1/BSIM2 (b1set.c/b2set.c): RSH*NRD and RSH*NRS in front of prime nodes.
          const kind = level === 4 ? 'BSIM1' : 'BSIM2';
          const instance = resolveClassicBsimInstance(kind, desc.name, desc.params);
          const series = classicBsimSeriesResistances(model.params.RSH ?? 0, instance);
          let [drain, gate, source] = desc.nodes;
          const bulk = desc.nodes[3] ?? source;
          if (series.drain !== 0) {
            const prime = internalNodeName(desc.name, 'drain');
            result.push({ type: 'R', name: `${desc.name}.RD`, nodes: [drain, prime], value: series.drain });
            drain = prime;
          }
          if (series.source !== 0) {
            const prime = internalNodeName(desc.name, 'source');
            result.push({ type: 'R', name: `${desc.name}.RS`, nodes: [source, prime], value: series.source });
            source = prime;
          }
          result.push({ ...desc, nodes: [drain, gate, source, bulk] });
          continue;
        }
        if (model && (level === 14 || level === 54)) {
          // ngspice-47 b4set.c:2517-2533: gate electrode and intrinsic gate
          // are distinct even when RSHG=0 (b4temp supplies a 1e3 mho fallback).
          const nodes = [desc.nodes[0], desc.nodes[1], desc.nodes[2], desc.nodes[3] ?? desc.nodes[2]];
          const gateMode = desc.params?.RGATEMOD ?? model.params.RGATEMOD ?? 0;
          if ([1, 2, 3].includes(gateMode)) nodes.push(internalNodeName(desc.name, 'gate'));
          if (gateMode === 3) nodes.push(internalNodeName(desc.name, 'midgate'));
          // b4set.c:2534-2570: body junctions and intrinsic bulk are distinct.
          if ((desc.params?.RBODYMOD ?? model.params.RBODYMOD ?? 0) === 1) {
            nodes.push(...['dbody', 'body', 'sbody'].map(suffix => internalNodeName(desc.name, suffix)));
          }
          // b4set.c:2434-2515: omitted squares do not create prime nodes.
          // Append after gate/body nodes so their established offsets stay fixed.
          if ((model.params.RSH ?? 0) > 0) {
            if ((desc.params?.NRD ?? 0) > 0) nodes.push(internalNodeName(desc.name, 'drain'));
            if ((desc.params?.NRS ?? 0) > 0) nodes.push(internalNodeName(desc.name, 'source'));
          }
          result.push({ ...desc, nodes });
          continue;
        }
        if (model && (level === 8 || level === 49) && isSupportedBsim3Version(model.version)) {
          // BSIM3, every revision (b3set.c/b3v32set.c, acmMod = 0): RSH*NRD and RSH*NRS,
          // NRD = NRS = 1 square by default, in front of drain/source prime nodes (#691).
          const series = bsim3SeriesResistances(desc.name, model.params, desc.params);
          let [drain, gate, source] = desc.nodes;
          const bulk = desc.nodes[3] ?? source;
          if (series.drain !== 0) {
            const prime = internalNodeName(desc.name, 'drain');
            result.push({ type: 'R', name: `${desc.name}.RD`, nodes: [drain, prime], value: series.drain });
            drain = prime;
          }
          if (series.source !== 0) {
            const prime = internalNodeName(desc.name, 'source');
            result.push({ type: 'R', name: `${desc.name}.RS`, nodes: [source, prime], value: series.source });
            source = prime;
          }
          result.push({ ...desc, nodes: [drain, gate, source, bulk] });
          continue;
        }
        if (model && (level === 3 || level === 9)) {
          // mos3set.c/mos9set.c: RD/RS (or RSH*NRD, RSH*NRS) in front of prime nodes, conductance M/R.
          const series = mos3SeriesResistances(model.params, desc.params);
          let [drain, gate, source] = desc.nodes;
          const bulk = desc.nodes[3] ?? source;
          if (series.drain !== 0) {
            const prime = internalNodeName(desc.name, 'drain');
            result.push({ type: 'R', name: `${desc.name}.RD`, nodes: [drain, prime], value: series.drain });
            drain = prime;
          }
          if (series.source !== 0) {
            const prime = internalNodeName(desc.name, 'source');
            result.push({ type: 'R', name: `${desc.name}.RS`, nodes: [source, prime], value: series.source });
            source = prime;
          }
          result.push({ ...desc, nodes: [drain, gate, source, bulk] });
          continue;
        }
        if (model && (level === undefined || level === 1 || level === 2 || level === 6)) {
          // MOS1/MOS2/MOS6 (mos*set.c and temperature preprocessing): RD/RS in front of prime nodes, or
          // RSH*NRD / RSH*NRS when RD/RS are not given (#719). MOS6's resolver preserves
          // its different omitted-square setup semantics. An open
          // terminal (#757) keeps its prime node but gets no resistor.
          const series = level === 6
            ? mos6SeriesResistances(model.params, desc.params)
            : level === 2
              ? mos2SeriesResistances(model.params, desc.params)
              : mos1SeriesResistances(model.params, desc.params);
          let [drain, gate, source] = desc.nodes;
          const bulk = desc.nodes[3] ?? source;
          if (series.drain === 0 && series.source === 0) {
            result.push(desc);
            continue;
          }
          if (series.drain !== 0) {
            const prime = internalNodeName(desc.name, 'drain');
            if (Number.isFinite(series.drain)) {
              result.push({ type: 'R', name: `${desc.name}.RD`, nodes: [drain, prime], value: series.drain });
            }
            drain = prime;
          }
          if (series.source !== 0) {
            const prime = internalNodeName(desc.name, 'source');
            if (Number.isFinite(series.source)) {
              result.push({ type: 'R', name: `${desc.name}.RS`, nodes: [source, prime], value: series.source });
            }
            source = prime;
          }
          result.push({ ...desc, nodes: [drain, gate, source, bulk] });
          continue;
        }
      }

      if (desc.type === 'Z') {
        const modelName = desc.modelName!;
        const model = this._models.get(modelName);
        if (!model) throw new InvalidCircuitError(`Z-card '${desc.name}' references unknown model '${modelName}'`);
        const expansion = expandZDevice(
          desc.name, [desc.nodes[0], desc.nodes[1], desc.nodes[2]], resolveZModel(model), desc.params,
          suffix => internalNodeName(desc.name, suffix),
        );
        for (const resistor of expansion.resistors) result.push({ type: 'R', ...resistor });
        result.push({ ...desc, nodes: expansion.nodes });
        continue;
      }

      result.push(desc);
    }

    return result;
  }

  /**
   * Give a VDMOS instance its inner nodes (vdmosset.c): D'/G'/S' behind
   * RD/RG/RS and the body diode anode B' behind RB, each equal to the external
   * node when its resistance is zero. The resistors are stamped by the device,
   * because quasi saturation makes RD bias dependent.
   */
  private expandVdmosDescriptor(desc: DeviceDescriptor, model: ModelParams): DeviceDescriptor {
    const thermal = !!desc.params?.THERMAL && model.params.RTHJC !== undefined;
    if (desc.nodes.length < 3 || desc.nodes.length > 5) {
      throw new InvalidCircuitError(
        `VDMOS '${desc.name}' has ${desc.nodes.length} terminals; expected D G S [Tj [Tc]]`,
      );
    }
    // ngspice-47 inp2m.c binds terminal 4 as Tj (not MOS bulk).
    // vdmosset.c grounds Tj/Tcase unless THERMAL && RTHJC-given, so the
    // nonthermal fourth node has no effect on the channel or body diode.
    const { model: resolved } = resolveVdmosModel(model);
    const [drain, gate, source] = desc.nodes;
    const inner = (resistance: number, terminal: string, suffix: string) =>
      (resistance > 0 ? internalNodeName(desc.name, suffix) : terminal);
    return {
      ...desc,
      nodes: [
        drain, gate, source,
        inner(resolved.rd, drain, 'drain'),
        inner(resolved.rg, gate, 'gate'),
        inner(resolved.rs, source, 'source'),
        inner(resolved.diode.rb, source, 'body_diode'),
        ...(thermal ? [desc.nodes[3] ?? internalNodeName(desc.name, 'tj'),
          desc.nodes[4] ?? internalNodeName(desc.name, 'tc')] : []),
      ],
    };
  }

  private expandCapacitorDescriptor(
    desc: DeviceDescriptor,
    model: ResolvedCapacitorModel,
  ): DeviceDescriptor[] {
    const [p, n] = desc.nodes;
    const result: DeviceDescriptor[] = [];

    if (isPositiveFinite(model.parallelResistance)) {
      result.push({
        type: 'R',
        name: `${desc.name}.RLEAK`,
        nodes: [p, n],
        value: model.parallelResistance,
      });
    }

    let left = p;
    if (isPositiveFinite(model.seriesInductance)) {
      const right = internalNodeName(desc.name, 'esl');
      result.push({
        type: 'L',
        name: `${desc.name}.ESL`,
        nodes: [left, right],
        value: model.seriesInductance,
      });
      left = right;
    }

    if (isPositiveFinite(model.seriesResistance)) {
      const right = internalNodeName(desc.name, 'esr');
      result.push({
        type: 'R',
        name: `${desc.name}.ESR`,
        nodes: [left, right],
        value: model.seriesResistance,
      });
      left = right;
    }

    result.push({
      type: 'C',
      name: desc.name,
      nodes: [left, n],
      value: model.capacitance,
      ic: desc.ic,
    });

    return result;
  }

  private expandInductorDescriptor(
    desc: DeviceDescriptor,
    model: ResolvedInductorModel,
  ): DeviceDescriptor[] {
    const [p, n] = desc.nodes;
    const result: DeviceDescriptor[] = [];

    if (isPositiveFinite(model.parallelResistance)) {
      result.push({
        type: 'R',
        name: `${desc.name}.RPAR`,
        nodes: [p, n],
        value: model.parallelResistance,
      });
    }

    if (isPositiveFinite(model.parallelCapacitance)) {
      result.push({
        type: 'C',
        name: `${desc.name}.CPAR`,
        nodes: [p, n],
        value: model.parallelCapacitance,
      });
    }

    let left = p;
    if (isPositiveFinite(model.seriesResistance)) {
      const right = internalNodeName(desc.name, 'rser');
      result.push({
        type: 'R',
        name: `${desc.name}.RSER`,
        nodes: [left, right],
        value: model.seriesResistance,
      });
      left = right;
    }

    result.push({
      type: 'L',
      name: desc.name,
      nodes: [left, n],
      value: model.inductance,
      ic: desc.ic,
    });

    return result;
  }

  /**
   * Recursively expand a single subcircuit instance into flat device descriptors.
   *
   * @param instanceName  e.g. "X1" or "X0.X1" for nested
   * @param connectedPorts  actual node names connected to this instance's ports
   * @param subcktName  name of the subcircuit definition to instantiate
   * @param instanceParams  parameter overrides from the X line
   * @param visited  set of subcircuit names currently being expanded (cycle detection)
   */
  /**
   * Resolve a device's `.model` card, raising {@link InvalidCircuitError} when
   * it is undefined. ngspice refuses such instances ("Unable to find definition
   * of model"); falling back to defaults would silently simulate a different device.
   */
  /**
   * Reject instances whose model belongs to another device kind (e.g. an M
   * card naming an NPN model), before any device-specific expansion (#544).
   * Unknown model names are left to the per-device resolution paths.
   */
  private assertDeviceModelTypes(descriptors: readonly DeviceDescriptor[]): void {
    for (const desc of descriptors) {
      if (!desc.modelName) continue;
      const model = this._models.get(desc.modelName);
      if (model) assertDeviceModelType(desc.type, desc.name, desc.modelName, model.type);
    }
  }

  private requireModel(kind: string, desc: DeviceDescriptor): ModelParams {
    const model = this._models.get(desc.modelName ?? '');
    if (!model) {
      if (desc.type === 'M' && desc.modelName) {
        const prefix = `${desc.modelName.toLowerCase()}.`;
        let hasBins = false;
        // ngspice-47 inpmkmod.c prepends models: last declared match wins.
        // inpgmod.c:238-249 includes BOTH limits within an absolute 1nm
        // allowance, despite its comment describing a half-open interval.
        const inRange = (value: number, min: number, max: number): boolean =>
          Math.abs(value - min) < 1e-9 || Math.abs(value - max) < 1e-9 || (min < value && value < max);
        for (const candidate of [...this._models.values()].reverse()) {
          const suffix = candidate.name.toLowerCase().slice(prefix.length);
          if (candidate.name.toLowerCase().startsWith(prefix) && /^\d+$/.test(suffix)
            && (candidate.type === 'NMOS' || candidate.type === 'PMOS')
            && (candidate.params.LEVEL === 14 || candidate.params.LEVEL === 54)) {
            hasBins = true;
            // inpgmod.c requires explicit L/W and all four model limits.
            // Descriptor dimensions are SI, with .options scale applied by
            // the parser. Native default wnflag=0 uses drawn W, not W/NF.
            const { L, W } = desc.params ?? {};
            const { LMIN, LMAX, WMIN, WMAX } = candidate.params;
            if (L !== undefined && W !== undefined
              && LMIN !== undefined && LMAX !== undefined && WMIN !== undefined && WMAX !== undefined
              && inRange(L, LMIN, LMAX) && inRange(W, WMIN, WMAX)) return candidate;
          }
        }
        if (hasBins) {
          throw new InvalidCircuitError(
            `${kind} '${desc.name}' has no matching BSIM4 model bin for '${desc.modelName}' (L=${desc.params?.L}, W=${desc.params?.W})`,
          );
        }
      }
      throw new InvalidCircuitError(`${kind} '${desc.name}' references unknown model '${desc.modelName}'`);
    }
    return model;
  }

  /**
   * ngspice-47 inp2l.c / inp2c.c applied to an expanded subcircuit card: a
   * value-less L/C line is ignored with a warning. Returns true to drop it.
   * The warning is recorded once even when compile() runs repeatedly.
   */
  private dropInvalidPassiveInstance(
    devName: string,
    tokens: readonly string[],
    mapNode: (node: string) => string,
    kind: 'C' | 'L',
  ): boolean {
    const expanded = [devName, ...tokens.slice(1).map(node => mapNode(node))];
    const warning = invalidPassiveInstanceLine(expanded, kind);
    if (warning === undefined) return false;
    if (!this._parseWarnings.includes(warning)) this._parseWarnings.push(warning);
    return true;
  }

  /**
   * Register the `.model` cards of one subcircuit instance body under their
   * instance-scoped names, returning upper-case local name -> scoped name.
   */
  private registerSubcircuitModels(
    instanceName: string,
    lines: readonly { tokens: string[]; lineNumber: number; raw: string }[],
    params: ParameterScope,
  ): Map<string, string> {
    const local = new Map<string, string>();
    for (const { tokens, lineNumber, raw } of lines) {
      if (tokens[0]?.toUpperCase() !== '.MODEL') continue;
      // Substitute the complete card before tokenization/compatibility translation:
      // braces can occur in name=value, name value, parentheses and continuations.
      let evaluated: string;
      try {
        evaluated = substituteExpressions(substituteStringAssignments(raw, params), params);
      } catch (error) {
        throw new ParseError((error as Error).message, lineNumber, raw);
      }
      let modelTokens = tokenizeLine(evaluated);
      if (xspiceModelType(modelTokens) !== undefined) {
        const card = parseXspiceModelCard(evaluated, lineNumber);
        const scoped = `${instanceName}:${card.name}`;
        const file = xspiceFilePath(card);
        const resolved = file !== undefined && this._xspiceFiles.has(String(file))
          ? resolveXspiceData(card, this._xspiceFiles.get(String(file))) : card;
        this._xspiceModels.set(scoped.toUpperCase(), { ...resolved, name: scoped });
        this._subcircuitModelNames.add(scoped.toUpperCase());
        local.set(card.name.toUpperCase(), scoped);
        continue;
      }
      if (isPspiceSwitchModel(modelTokens)) {
        const translated = translatePspiceSwitchModel(evaluated, lineNumber);
        if (translated.kind === 'xspice') {
          const scoped = `${instanceName}:${translated.card.name}`;
          this._xspiceModels.set(scoped.toUpperCase(), { ...translated.card, name: scoped });
          this._subcircuitModelNames.add(scoped.toUpperCase());
          local.set(translated.card.name.toUpperCase(), scoped);
          continue;
        }
        modelTokens = tokenizeLine(translated.raw);
      }
      assertSupportedResistorModel(modelTokens, lineNumber, raw);
      const modelParams = parseTransmissionLineModelCard(modelTokens, lineNumber)
        ?? parseModelCard(modelTokens, lineNumber, message => this.addParseWarning(message));
      const scoped = `${instanceName}:${modelParams.name}`;
      // Validate under the name written on the card, so errors name it (#544).
      const type = normalizeModelType(modelParams.name, modelParams.type);
      this._models.set(scoped, { ...modelParams, name: scoped, type });
      this._subcircuitModelNames.add(scoped.toUpperCase());
      local.set(modelParams.name.toUpperCase(), scoped);
    }
    return local;
  }

  private expandSubcircuit(
    instanceName: string,
    connectedPorts: string[],
    subcktName: string,
    instanceParams: Record<string, number>,
    visited: Set<string>,
    globalNodes: ReadonlyMap<string, string>,
    guard?: ProtocolExecutionGuard,
    depth = 1,
    scopes: readonly SubcircuitScope[] = [],
    inheritedMultiplicity = 1,
    callerParams: ParameterScope = this.parameterScope(),
    rawCall?: string,
  ): DeviceDescriptor[] {
    guard?.maximum('maxSubcircuitDepth', depth, 'compile');
    const key = subcktName.toUpperCase();

    if (visited.has(key)) {
      throw new CycleError([...visited, key]);
    }

    // Resolve innermost-first through the definitions nested in the enclosing
    // subcircuits (#826), then the top level. A nested definition sees the
    // scopes it was defined in.
    const scopeIndex = scopes.findIndex(scope => scope.definitions.has(key));
    const def = scopeIndex >= 0 ? scopes[scopeIndex].definitions.get(key) : this._subcircuits.get(key);
    const definitionScopes = scopeIndex >= 0 ? scopes.slice(scopeIndex) : [];
    if (!def) {
      throw new Error(`Undefined subcircuit '${subcktName}'`);
    }
    if (rawCall !== undefined) validateSubcircuitCallCommas(rawCall, def.params);

    if (connectedPorts.length !== def.ports.length) {
      throw new Error(
        `Subcircuit '${subcktName}' expects ${def.ports.length} port(s) but ${connectedPorts.length} provided`,
      );
    }

    // Build port-to-node mapping
    const portMap = new Map<string, string>();
    for (let i = 0; i < def.ports.length; i++) {
      portMap.set(def.ports[i].toUpperCase(), connectedPorts[i]);
    }

    // ngspice-47 numparam searches the instance stack, not definition ancestry
    // (#888). Each call gets fresh bindings over its caller, then ancestors and
    // globals. Definition/model lookup remains lexical via definitionScopes.
    const localParams: ParameterScope = Object.create(callerParams) as ParameterScope;
    bindParameterRandom(localParams, parameterRandom(callerParams));
    const overrides = new Map<string, number | string>(Object.entries(instanceParams).map(([k, v]) => [k.toUpperCase(), v]));
    if (rawCall !== undefined) {
      const actuals = substituteExpressions(substituteStringAssignments(rawCall, callerParams), callerParams);
      for (const [name, value] of subcircuitStringActuals(actuals)) overrides.set(name, value);
    }
    // Defaults are evaluated in declaration order after the instance
    // overrides, so `p2={p1*2}` follows an overridden p1 (ngspice-47).
    for (const [k, value] of Object.entries(def.params)) {
      const name = k.toUpperCase();
      const override = overrides.get(name);
      if (override !== undefined) {
        localParams[name] = override;
      } else if (typeof value === 'number') {
        localParams[name] = value;
      } else {
        try {
          localParams[name] = stringParameter(value, localParams) ?? evaluateExpression(value, localParams);
        } catch (error) {
          throw new Error(
            `Subcircuit '${subcktName}' (instance '${instanceName}') parameter '${k}=${value}': ${(error as Error).message}`,
          );
        }
      }
    }
    const declared = new Set(Object.keys(def.params).map(k => k.toUpperCase()));
    for (const [name, value] of overrides) {
      if (!declared.has(name)) localParams[name] = value;
    }

    // #810: X-line `m=` makes the instance m parallel copies of the
    // subcircuit, scaling every card of the body (nested instances included)
    // on top of the card's own m and of any enclosing instance's m. When the
    // subcircuit declares a parameter named m, the X-line m is that ordinary
    // parameter instead (as in ngspice-47 inp_fix_inst_calls_for_numparam).
    const multiplicity = inheritedMultiplicity
      * (declared.has('M') ? 1 : evaluateExpression('M', { M: overrides.get('M') ?? 1 }));

    // Map a node name from the subcircuit body to the actual circuit node
    const mapNode = (bodyNode: string): string => {
      if (bodyNode === GROUND_NODE) return GROUND_NODE;
      const upper = bodyNode.toUpperCase();
      // A .global node is the top-level net, even when it names a port.
      const globalNode = globalNodes.get(upper);
      if (globalNode !== undefined) return globalNode;
      // If it's a port, map to the connected node
      if (portMap.has(upper)) return portMap.get(upper)!;
      // Otherwise it's an internal node — prefix with instance name
      return `${instanceName}.${bodyNode}`;
    };

    // Evaluate {expr} in a token using merged parameters
    // Handles both standalone {expr} and key={expr} patterns
    const evalToken = (token: string, formatter = formatNumparamNumber): string => {
      token = substituteStringAssignments(token, localParams);
      if (token.startsWith('{') && token.endsWith('}')) {
        const expr = token.slice(1, -1);
        const string = stringParameter(expr, localParams);
        return string === undefined ? formatter(evaluateExpression(expr, localParams)) : JSON.stringify(string);
      }
      const eqIdx = token.indexOf('=');
      if (eqIdx > 0) {
        const val = token.slice(eqIdx + 1);
        if (val.startsWith('{') && val.endsWith('}')) {
          const expr = val.slice(1, -1);
          const string = stringParameter(expr, localParams);
          return token.slice(0, eqIdx + 1) + (string === undefined ? formatter(evaluateExpression(expr, localParams)) : JSON.stringify(string));
        }
      }
      return token;
    };

    const result: DeviceDescriptor[] = [];

    // Tokenize body lines; nested .subckt blocks are definitions, not devices.
    // Body lines carry their deck line numbers when the parser recorded them.
    const bodyLines = tokenizeNetlist(def.body.join('\n')).map(line => ({
      ...line,
      lineNumber: def.bodyLines?.[line.lineNumber - 1] ?? line.lineNumber,
    }));
    const { lines: parsedLines, definitions } = splitNestedSubcircuits(bodyLines);

    // Model expressions read the same dependency-ordered instance scope as
    // element expressions, including .params written below the .model (#882).
    evaluateSubcircuitParams(
      parsedLines.filter(({ tokens }) => tokens[0]?.toUpperCase() === '.PARAM')
        .map(({ tokens, lineNumber, raw }) => ({ content: tokens.slice(1).join(' '), line: lineNumber, raw })),
      localParams,
      overrides,
    );

    // ngspice-47 subckt.c modtranslate: a .model card in the body becomes a
    // per-instance model `<instance>:<name>`, and the body's device cards (and
    // those of definitions nested in it) are rewritten to it. Lookup is
    // lexical: own body, then enclosing definition bodies, then top level (#854).
    const localModels = this.registerSubcircuitModels(instanceName, parsedLines, localParams);
    const modelScopes = [localModels, ...definitionScopes.map(scope => scope.models)];
    const scopeModel = (name: string): string => {
      const upper = name.toUpperCase();
      for (const models of modelScopes) {
        const scoped = models.get(upper);
        if (scoped !== undefined) return scoped;
      }
      return name;
    };
    const bodyScopes = definitions.size > 0
      ? [{ definitions, models: localModels, params: localParams }, ...definitionScopes]
      : definitionScopes;

    for (const { tokens, lineNumber, raw } of parsedLines) {
      guard?.checkpoint('compile:device');
      if (tokens.length === 0) continue;
      const first = tokens[0].toUpperCase();

      // .model cards were registered per instance and .param cards evaluated above.
      if (first === '.MODEL' || first === '.PARAM') continue;

      // Skip other dot commands (like .ends that leaked, etc.)
      if (first.startsWith('.')) continue;

      const devName = `${instanceName}.${tokens[0]}`;
      const devType = tokens[0][0].toUpperCase();
      const firstDescriptor = result.length;

      switch (devType) {
        case 'R': {
          const evaluatedTokens = tokens.map(t => evalToken(t));
          const parsed = parseResistorElement(evaluatedTokens, lineNumber, raw,
            warning => this.addParseWarning(warning.message, warning));
          if (!parsed) break;
          result.push({
            type: 'R', name: devName,
            nodes: [mapNode(tokens[1]), mapNode(tokens[2])],
            value: parsed.value,
            modelName: parsed.modelName,
            params: parsed.params,
          });
          break;
        }
        case 'C': {
          if (this.dropInvalidPassiveInstance(devName, tokens, mapNode, 'C')) break;
          const evaluatedTokens = tokens.map(t => evalToken(t));
          const parsed = parsePassiveElement(evaluatedTokens, 3, 'C');
          // IC= is the initial condition, as on a top-level card.
          const { IC: ic, ...params } = parsed.params;
          result.push({
            type: 'C', name: devName,
            nodes: [mapNode(tokens[1]), mapNode(tokens[2])],
            value: parsed.value,
            modelName: parsed.modelName,
            params,
            ...(ic === undefined ? {} : { ic }),
          });
          break;
        }
        case 'L': {
          if (this.dropInvalidPassiveInstance(devName, tokens, mapNode, 'L')) break;
          const evaluatedTokens = tokens.map(t => evalToken(t));
          const parsed = parsePassiveElement(evaluatedTokens, 3, 'L');
          // IC= is the initial condition, as on a top-level card.
          const { IC: ic, ...params } = parsed.params;
          result.push({
            type: 'L', name: devName,
            nodes: [mapNode(tokens[1]), mapNode(tokens[2])],
            value: parsed.value,
            modelName: parsed.modelName,
            params,
            ...(ic === undefined ? {} : { ic }),
          });
          break;
        }
        case 'V': {
          const mappedTokens = [devName, mapNode(tokens[1]), mapNode(tokens[2])];
          // Evaluate expressions in remaining tokens
          for (let i = 3; i < tokens.length; i++) {
            mappedTokens.push(evalToken(tokens[i]));
          }
          if (hasSourceMultiplier(mappedTokens, 3)) throw new Error(VOLTAGE_SOURCE_MULTIPLIER_ERROR);
          const { tokens: sourceTokens, port } = extractRFPort(mappedTokens, 3);
          const waveform = parseSourceWaveform(sourceTokens, 3);
          result.push({
            type: 'V', name: devName,
            nodes: [mapNode(tokens[1]), mapNode(tokens[2])],
            waveform,
            ...(port ? { port } : {}),
          });
          break;
        }
        case 'I': {
          const mappedTokens = [devName, mapNode(tokens[1]), mapNode(tokens[2])];
          for (let i = 3; i < tokens.length; i++) {
            mappedTokens.push(evalToken(tokens[i]));
          }
          const { tokens: sourceTokens, multiplier } = extractSourceMultiplier(mappedTokens, 3);
          const waveform = parseSourceWaveform(sourceTokens, 3);
          result.push({
            type: 'I', name: devName,
            nodes: [mapNode(tokens[1]), mapNode(tokens[2])],
            waveform,
            ...(multiplier === undefined ? {} : { multiplier }),
          });
          break;
        }
        case 'U': {
          if (tokens.length < 6) throw new ParseError('URC requires three nodes, a model and L', lineNumber, raw);
          result.push({ type: 'U', name: devName, nodes: tokens.slice(1, 4).map(mapNode),
            modelName: tokens[4], params: parseUrcParams(tokens.slice(5).map(token => evalToken(token)), lineNumber) });
          break;
        }
        case 'O': {
          if (tokens.length !== 6) {
            throw new Error(`Unsupported LTRA O-card '${tokens.join(' ')}'`);
          }
          if (tokens[2].toUpperCase() !== tokens[4].toUpperCase()) {
            throw new Error(`Unsupported LTRA '${devName}': both ports must use a common reference node`);
          }
          result.push({
            type: 'O',
            name: devName,
            nodes: [mapNode(tokens[1]), mapNode(tokens[2]), mapNode(tokens[3]), mapNode(tokens[4])],
            modelName: tokens[5],
          });
          break;
        }
        case 'Y':
        case 'P': {
          const parsed = devType === 'Y'
            ? (() => {
              const line = parseTxlLine(tokens, lineNumber);
              return { inputs: [line.input], outputs: [line.output], modelName: line.modelName, length: line.length };
            })()
            : parseCplLines(tokens, lineNumber);
          result.push({
            type: devType,
            name: devName,
            nodes: [...parsed.inputs.map(mapNode), ...parsed.outputs.map(mapNode)],
            modelName: parsed.modelName,
            ...(parsed.length === undefined ? {} : { params: { LEN: parsed.length } }),
          });
          break;
        }
        case 'D': {
          const evaluatedTokens = tokens.map(t => evalToken(t));
          // Positional AREA expressions must be numeric before distinguishing
          // a two-terminal diode from the optional thermal-node form.
          const modelIndex = diodeModelIndex(evaluatedTokens);
          const modelName = tokens[modelIndex];
          result.push({
            type: 'D', name: devName,
            nodes: tokens.slice(1, modelIndex).map(mapNode),
            modelName,
            params: { ...parseDiodeInstanceParams(evaluatedTokens, modelIndex + 1) },
          });
          break;
        }
        case 'Q': {
          // AREA/M may be {params}; node and model tokens are never braced.
          const instance = parseBJTInstance(tokens.map(t => evalToken(t)), lineNumber);
          const nodes = [instance.collector, instance.base, instance.emitter];
          if (instance.substrate !== undefined) nodes.push(instance.substrate);
          if (instance.thermal !== undefined) nodes.push(instance.thermal);
          const params = bjtInstanceDescriptorParams(instance.params);
          result.push({
            type: 'Q', name: devName,
            nodes: nodes.map(mapNode),
            modelName: instance.modelName,
            ...(params ? { params } : {}),
          });
          break;
        }
        case 'J': {
          // TEMP may be a {param}; node and model tokens are never braced.
          const instance = parseJFETInstance(tokens.map(t => evalToken(t)), lineNumber);
          result.push({
            type: 'J', name: devName,
            nodes: [instance.drain, instance.gate, instance.source].map(mapNode),
            modelName: instance.modelName,
            ...(instance.params ? { params: jfetInstanceDescriptorParams(instance.params) } : {}),
          });
          break;
        }
        case 'Z': {
          const evaluatedTokens = tokens.map(t => evalToken(t));
          const parsed = parseZInstance(evaluatedTokens, lineNumber, raw);
          result.push({
            type: 'Z',
            name: devName,
            nodes: parsed.nodes.map(mapNode),
            modelName: parsed.modelName,
            params: parsed.params,
          });
          break;
        }
        case 'M': {
          let modelName: string;
          let instanceParamStart: number;
          let bulkNode: string | undefined;
          let soiNode: string | undefined;
          // B3SOI has a fifth terminal before its model. Resolve through the
          // lexical model scope, including .model cards below the instance.
          if (tokens[6] && this._models.get(scopeModel(tokens[6]))?.params.LEVEL === 10) {
            bulkNode = mapNode(tokens[4]);
            soiNode = mapNode(tokens[5]);
            modelName = tokens[6];
            instanceParamStart = 7;
          } else if (tokens[5] && !tokens[5].includes('=')) {
            bulkNode = mapNode(tokens[4]);
            modelName = tokens[5];
            instanceParamStart = 6;
          } else {
            modelName = tokens[4];
            instanceParamStart = 5;
          }
          // Evaluate {expr} in instance params
          const evaluatedTokens = tokens.map(t => evalToken(t));
          const mParams = parseInstanceParams(evaluatedTokens, instanceParamStart);
          if (evaluatedTokens.slice(instanceParamStart).some(token => token.toUpperCase() === 'THERMAL')) {
            mParams.THERMAL = 1;
          }
          const nodes = bulkNode
            ? [mapNode(tokens[1]), mapNode(tokens[2]), mapNode(tokens[3]), bulkNode]
            : [mapNode(tokens[1]), mapNode(tokens[2]), mapNode(tokens[3])];
          if (soiNode !== undefined) nodes.push(soiNode);
          result.push({
            type: 'M', name: devName, nodes, modelName, params: mParams,
          });
          break;
        }
        case 'E': {
          const fields = withoutNodePairParentheses(tokens);
          assertControlledSourceCard(fields, lineNumber, raw);
          const valStr = evalToken(fields[5]);
          result.push({
            type: 'E', name: devName,
            nodes: [mapNode(fields[1]), mapNode(fields[2]), mapNode(fields[3]), mapNode(fields[4])],
            value: parseNumber(valStr),
          });
          break;
        }
        case 'G': {
          const fields = withoutNodePairParentheses(tokens);
          assertControlledSourceCard(fields, lineNumber, raw);
          const valStr = evalToken(fields[5]);
          result.push({
            type: 'G', name: devName,
            nodes: [mapNode(fields[1]), mapNode(fields[2]), mapNode(fields[3]), mapNode(fields[4])],
            value: parseNumber(valStr),
          });
          break;
        }
        case 'A': {
          const card = parseXspiceInstance(raw, lineNumber);
          const modelName = scopeModel(card.modelName);
          if (!this._xspiceModels.has(modelName.toUpperCase())) {
            throw new ParseError("Unsupported device card: 'A' (missing code model)", lineNumber, raw);
          }
          // All code models share node-token scoping; preserve vector,
          // inversion and type tokens. Model support is checked by the
          // code-model parser, just as it is for top-level A cards.
          const connectionTokens = card.connectionTokens.map((token, index) => token.kind === 'string'
            && card.connectionTokens[index - 1]?.kind !== 'percent'
            ? { ...token, text: mapNode(token.text) } : token);
          result.push({ type: 'A', name: devName, nodes: [], modelName,
            xspice: { ...card, name: devName, modelName, connectionTokens } });
          break;
        }
        case 'B': {
          // ngspice's numparam front end substitutes parameters into B expressions.
          const card = parseBehavioralSourceCard(substituteBehavioralParameters(raw, localParams), lineNumber);
          result.push(behavioralDescriptor(
            devName,
            mapNode(card.nodes[0]),
            mapNode(card.nodes[1]),
            card.kind,
            mapBehavioralNodes(card.expression, mapNode, source => `${instanceName}.${source}`),
            card.params,
          ));
          break;
        }
        case 'H': {
          const fields = withoutNodePairParentheses(tokens);
          assertControlledSourceCard(fields, lineNumber, raw);
          const valStr = evalToken(fields[4]);
          result.push({
            type: 'H', name: devName,
            nodes: [mapNode(fields[1]), mapNode(fields[2])],
            controlSource: `${instanceName}.${fields[3]}`,
            value: parseNumber(valStr),
          });
          break;
        }
        case 'F': {
          const fields = withoutNodePairParentheses(tokens);
          assertControlledSourceCard(fields, lineNumber, raw);
          const valStr = evalToken(fields[4]);
          result.push({
            type: 'F', name: devName,
            nodes: [mapNode(fields[1]), mapNode(fields[2])],
            controlSource: `${instanceName}.${fields[3]}`,
            value: parseNumber(valStr),
          });
          break;
        }
        case 'K': {
          // ngspice prefixes the coupled inductor names with the instance path,
          // so a K card only reaches inductors of its own instance (#739).
          if (tokens.length < 4) {
            throw new ParseError(`K-element '${tokens[0]}' needs two inductors and a coupling`, lineNumber, raw);
          }
          result.push({
            type: 'K', name: devName, nodes: [],
            value: parseNumber(evalToken(tokens[3])),
            coupledA: `${instanceName}.${tokens[1]}`,
            coupledB: `${instanceName}.${tokens[2]}`,
          });
          break;
        }
        case 'S':
        case 'W': {
          const instance = parseSwitchInstance(tokens, lineNumber);
          result.push({
            type: devType, name: devName,
            nodes: instance.nodes.map(mapNode),
            modelName: instance.modelName,
            ...(instance.controlSource === undefined
              ? {} : { controlSource: `${instanceName}.${instance.controlSource}` }),
            ...(instance.initiallyOn ? { params: { ON: 1 } } : {}),
          });
          break;
        }
        case 'X': {
          // Nested subcircuit instance — recursively expand
          const call = locateSubcircuitCall(tokens, raw);
          const nestedSubcktName = tokens[call.nameIndex];
          const nestedPorts = call.ports.map(mapNode);
          const nestedParams = parseSubcircuitCallParams(raw, token => evalToken(token, formatNumber));

          const newVisited = new Set(visited);
          newVisited.add(key);

          const nested = this.expandSubcircuit(
            devName,
            nestedPorts,
            nestedSubcktName,
            nestedParams,
            newVisited,
            globalNodes,
            guard,
            depth + 1,
            bodyScopes,
            multiplicity,
            localParams,
            raw,
          );
          result.push(...nested);
          break;
        }
        default:
          throw new ParseError(`Unsupported device card: '${devType}'`, lineNumber, raw);
      }
      // Nested X expansions resolved their own model scopes and multiplicity already.
      if (devType !== 'X') {
        for (let i = firstDescriptor; i < result.length; i++) {
          const desc = result[i];
          if (desc.modelName !== undefined) desc.modelName = scopeModel(desc.modelName);
          if (multiplicity === 1) continue;
          const warning = applyInstanceMultiplicity(desc, multiplicity, instanceName);
          if (warning !== undefined && !this._parseWarnings.includes(warning)) this._parseWarnings.push(warning);
        }
      }
      guard?.maximum('maxComponents', result.length, 'compile');
    }

    return result;
  }
}

/**
 * The A card ngspice-47 inpcompat.c writes for an S instance of a PSpice
 * VSWITCH model, `a<name> %gd(nc+ nc-) %gd(n+ n-) a<model>`, or for a W
 * instance of a PSpice ISWITCH model, `a<name> %vnam(<vcontrol>) %gd(n+ n-) a<model>`
 * (the instance keeps its S/W name here).
 */
function pspiceSwitchInstance(desc: DeviceDescriptor): XspiceInstanceCard {
  const [nodePos, nodeNeg, ctrlPos, ctrlNeg] = desc.nodes;
  const port = (type: string, ...names: string[]) => [
    { kind: 'percent', text: '%' }, { kind: 'string', text: type },
    ...names.map(text => ({ kind: 'string', text }) as const),
  ] as const;
  const control = desc.type === 'W'
    ? { tokens: port('vnam', desc.controlSource!), raw: `%vnam(${desc.controlSource})` }
    : { tokens: port('gd', ctrlPos, ctrlNeg), raw: `%gd(${ctrlPos} ${ctrlNeg})` };
  return {
    name: desc.name,
    connectionTokens: [...control.tokens, ...port('gd', nodePos, nodeNeg)],
    modelName: desc.modelName!,
    raw: `a${desc.name} ${control.raw} %gd(${nodePos} ${nodeNeg}) a${desc.modelName}`,
    line: 0,
  };
}
