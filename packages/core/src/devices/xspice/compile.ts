import { InvalidCircuitError } from '../../errors.js';
import { parseXspiceInstance, parseXspiceModelCard, type XspiceInstanceCard, type XspiceModelCard } from '../../parser/xspice-parser.js';
import { Capacitor } from '../capacitor.js';
import type { DeviceModel } from '../device.js';
import { Inductor } from '../inductor.js';
import { VoltageSource } from '../voltage-source.js';
import { resolveXspiceConnections, resolveXspiceParams, type XspiceConnection } from './connections.js';
import { astate } from './astate-model.js';
import { delay } from './delay-model.js';
import { LIMITER_BEHAVIORS } from './limiter-models.js';
import { DIGITAL_MODELS } from './digital-models.js';
import { REAL_MODELS } from './real-models.js';
import { XspiceEventNetwork, type EventPort } from './event-network.js';
import {
  XSPICE_BEHAVIORS, type BehaviorFactory, type CodeModelBehavior, type XspiceNetlistProbe,
} from './models.js';
import { OSCILLATOR_BEHAVIORS } from './oscillator-models.js';
import { OTA_BEHAVIORS, registerOtaNoise } from './ota-model.js';
import { registerGainNoise } from './gain-noise.js';
import { SWITCH_BEHAVIORS } from './switch-models.js';
import { MAGNETIC_BEHAVIORS } from './magnetic-models.js';
import { mlin } from './mlin.js';
import { cpmlin } from './cpmlin.js';
import { cpline } from './cpline.js';
import { REACTIVE_IC_BEHAVIORS } from './reactive-ic-models.js';
import { zener } from './zener.js';
import { sidiode } from './sidiode.js';
import { memristor } from './memristor.js';
import { seegen } from './seegen.js';
import { resolveSTransfer, STransferDevice } from './s-xfer.js';
import { xfer } from './xfer.js';
import { multiInputPwl } from './multi-input-pwl.js';
import { XSPICE_CODE_MODEL_SPECS, type XspiceParamValue } from './spec.js';
import { XspiceDevice, type XspiceInputPort, type XspiceOutputPort } from './xspice-device.js';

/** Every implemented code model behavior keyed by lower-case ngspice Spice_Model_Name. */
const BEHAVIORS: ReadonlyMap<string, BehaviorFactory> = new Map<string, BehaviorFactory>([
  ['astate', astate],
  ['xfer', xfer],
  ['multi_input_pwl', multiInputPwl],
  ['mlin', mlin],
  ['cpmlin', cpmlin],
  ['cpline', cpline],
  ['delay', delay],
  ...REACTIVE_IC_BEHAVIORS,
  ...XSPICE_BEHAVIORS, ...LIMITER_BEHAVIORS, ...OSCILLATOR_BEHAVIORS, ...SWITCH_BEHAVIORS, ...MAGNETIC_BEHAVIORS, ...OTA_BEHAVIORS,
  ['zener', zener],
  ['sidiode', sidiode],
  ['memristor', memristor],
  ['seegen', seegen],
]);

const EVENT_MODELS = new Map([...DIGITAL_MODELS, ...REAL_MODELS]);

/** An A instance whose connections and parameters were resolved against its code model. */
export interface PreparedXspiceInstance {
  readonly card: XspiceInstanceCard;
  readonly model: XspiceModelCard;
  readonly connections: readonly XspiceConnection[];
  readonly params: ReadonlyMap<string, readonly XspiceParamValue[]>;
  /** Analog circuit nodes the instance connects to, in connection order. */
  readonly nodes: readonly string[];
  /** Digital (`%d`) nodes the instance connects to, in connection order. */
  readonly digitalNodes: readonly string[];
}

/**
 * Default automatic bridges, ngspice-47 src/xspice/evt/evtcheck_nodes.c
 * lines 466-473 (direction), 515-519 (3.3 V fallback), 635-644 (ADC/DAC).
 * Analog and event nodes retain the same name but occupy separate networks.
 * Mixed-direction nodes use bidi_bridge (evtcheck_nodes.c:644-647), not an
 * ideal voltage DAC. Family/custom bridges remain unsupported.
 */
export function implicitXspiceBridges(
  instances: readonly PreparedXspiceInstance[],
  analogNodes: ReadonlySet<string>,
  usedNames: Set<string>,
  vcc: number,
  ground: string,
): PreparedXspiceInstance[] {
  const nodes = new Map<string, { name: string; input: boolean; output: boolean; family: boolean }>();
  for (const instance of instances) {
    for (const connection of instance.connections) {
      for (const port of connection.ports) {
        if (port.type !== 'd') continue;
        const name = port.positive!;
        const key = name.toUpperCase();
        if (!analogNodes.has(key) && name !== ground) continue;
        let node = nodes.get(key);
        if (!node) nodes.set(key, node = { name, input: false, output: false, family: false });
        node.input ||= connection.direction !== 'out';
        node.output ||= connection.direction !== 'in';
        node.family ||= Boolean(instance.params.get('family')?.[0]);
      }
    }
  }
  const bridges: PreparedXspiceInstance[] = [];
  let serial = 0;
  for (const node of nodes.values()) {
    if (node.family) {
      throw new InvalidCircuitError(`XSPICE mixed node '${node.name}' requires an unsupported family-specific automatic bridge`);
    }
    let name: string;
    do { name = `auto_bridge${serial++}`; } while (usedNames.has(name.toUpperCase()));
    usedNames.add(name.toUpperCase());
    const bidi = node.input && node.output;
    const model = parseXspiceModelCard(bidi
      ? `.model ${name} bidi_bridge(out_high=${vcc} in_low=${vcc / 2} in_high=${vcc / 2})`
      : node.output
      ? `.model ${name} dac_bridge(out_low=0 out_high=${vcc})`
      : `.model ${name} adc_bridge(in_low=${vcc / 2} in_high=${vcc / 2})`, 0);
    const card = parseXspiceInstance(`${name} [${node.name}] [${node.name}] ${bidi ? 'null ' : ''}${name}`, 0);
    bridges.push(prepareXspiceInstance(card, model, false, ground));
  }
  return bridges;
}

/**
 * Resolve an A-card against its `.model` card.
 *
 * @throws {@link InvalidCircuitError} for an unknown or non-XSPICE model, malformed connections or parameters
 */
export function prepareXspiceInstance(
  card: XspiceInstanceCard,
  model: XspiceModelCard | undefined,
  isOtherModel: boolean,
  ground: string,
): PreparedXspiceInstance {
  if (!model) {
    throw new InvalidCircuitError(isOtherModel
      ? `XSPICE instance '${card.name}' references model '${card.modelName}', which is not an XSPICE code model`
      : `XSPICE instance '${card.name}' references unknown model '${card.modelName}'`);
  }
  const spec = XSPICE_CODE_MODEL_SPECS.get(model.codeModel)!;
  const connections = resolveXspiceConnections(card, spec, ground);
  const params = resolveXspiceParams(card.name, model, spec, connections);
  if (model.codeModel === 's_xfer') resolveSTransfer(params);
  if (model.codeModel === 'xfer') xfer(params);
  if (model.codeModel === 'multi_input_pwl') multiInputPwl(params);
  const nodes: string[] = [];
  const digitalNodes: string[] = [];
  for (const connection of connections) {
    for (const port of connection.ports) {
      if (port.type === 'd' || port.type === 'real') {
        digitalNodes.push(port.positive!);
        continue;
      }
      if (port.positive !== undefined) nodes.push(port.positive);
      if (port.negative !== undefined) nodes.push(port.negative);
    }
  }
  return { card, model, connections, params, nodes, digitalNodes };
}

/** The event-driven network of a circuit and the analog halves of its hybrid instances. */
export interface XspiceEventNetworkBuild {
  readonly network: XspiceEventNetwork;
  readonly analogHalves: ReadonlyMap<PreparedXspiceInstance, CodeModelBehavior>;
}

/**
 * Build the event-driven network from the digital instances (ngspice
 * EVTinit/EVTtermInsert, in instance order). Undefined when there are none.
 */
export function buildXspiceEventNetwork(
  instances: readonly PreparedXspiceInstance[],
): XspiceEventNetworkBuild | undefined {
  const digital = instances.filter(instance => EVENT_MODELS.has(instance.model.codeModel));
  if (digital.length === 0) return undefined;
  const network = new XspiceEventNetwork();
  const analogHalves = new Map<PreparedXspiceInstance, CodeModelBehavior>();
  for (const prepared of digital) {
    const { card, model, connections, params } = prepared;
    const digitalModel = EVENT_MODELS.get(model.codeModel)!(params, { connections, given: new Set(model.params.keys()) });
    const inputs: EventPort[] = [];
    const outputs: EventPort[] = [];
    let hybrid = false;
    for (const connection of connections) {
      for (const port of connection.ports) {
        if (port.type !== 'd' && port.type !== 'real') {
          hybrid = true;
          continue;
        }
        const eventPort = { node: port.positive!, type: port.type, invert: port.invert === true };
        if (connection.direction !== 'out') inputs.push(eventPort);
        if (connection.direction !== 'in') outputs.push(eventPort);
      }
    }
    const view = network.addInstance({ name: card.name, behavior: digitalModel.event, inputs, outputs, hybrid });
    if (digitalModel.analog) analogHalves.set(prepared, digitalModel.analog(view));
  }
  return { network, analogHalves };
}

/**
 * Build the device, allocating a branch per voltage output and per current
 * input. `analogHalf` is the analog behavior of a hybrid digital instance;
 * an instance without analog ports gets no device.
 */
export function createXspiceDevice(
  prepared: PreparedXspiceInstance,
  resolveNode: (name: string) => number,
  allocateBranch: (name: string) => number,
  analogHalf?: CodeModelBehavior,
): XspiceDevice | undefined {
  const { card, model, connections, params } = prepared;
  if (EVENT_MODELS.has(model.codeModel) && analogHalf === undefined) return undefined;
  const inputs: XspiceInputPort[] = [];
  const outputs: XspiceOutputPort[] = [];
  connections.forEach((connection, c) => {
    connection.ports.forEach((port, p) => {
      if (port.type === 'd' || port.type === 'real') return;
      const positive = port.positive === undefined ? -1 : resolveNode(port.positive);
      const negative = port.negative === undefined ? -1 : resolveNode(port.negative);
      if (port.type === 'h' || port.type === 'hd') {
        const branch = allocateBranch(`${card.name}#branch_${c}_${p}`);
        inputs.push({ kind: 'current', positive, negative, branch });
        outputs.push({ kind: 'voltage', positive, negative, branch });
        return;
      }
      if (connection.direction !== 'out') {
        if (port.type === 'vnam') {
          inputs.push({ kind: 'current', positive: -1, negative: -1, source: port.source! });
        } else if (port.type === 'i' || port.type === 'id') {
          const branch = allocateBranch(`${card.name}#ibranch_${c}_${p}`);
          inputs.push({ kind: 'current', positive, negative, ownBranch: branch, branch });
        } else {
          inputs.push({ kind: 'voltage', positive, negative });
        }
      }
      if (connection.direction !== 'in') {
        if (port.type === 'v' || port.type === 'vd') {
          outputs.push({ kind: 'voltage', positive, negative, branch: allocateBranch(`${card.name}#branch_${c}_${p}`) });
        } else {
          outputs.push({ kind: 'current', positive, negative });
        }
      }
    });
  });
  if (model.codeModel === 's_xfer') {
    const transfer = resolveSTransfer(params);
    const states = transfer.initial.map((_, i) => allocateBranch(`${card.name}#s_xfer_state_${i}`));
    return new STransferDevice(card.name, inputs[0], outputs[0], transfer, states, model.warnings);
  }
  const firstPort = connections[0]?.ports[0];
  const metered = firstPort?.positive === undefined || firstPort.type === 'd' ? -1 : resolveNode(firstPort.positive);
  const netlist = new NetlistProbe(metered);
  // delay distinguishes PARAM_NULL from the ifspec defaults (buffer_size/delmax).
  const behavior = analogHalf ?? BEHAVIORS.get(model.codeModel)!(model.codeModel === 'delay' ? model.params : params, { connections, netlist });
  // astate, delay, mlin and cpline store samples, not integrated charge: node
  // LTE would change the history's time grid (the lines use a ceiling lookup).
  // Neither magnetic model calls cm_analog_integrate (lcouple's fake call is commented out).
  const untruncated = analogHalf !== undefined || model.codeModel === 'xfer' || model.codeModel === 'astate' || model.codeModel === 'delay' || model.codeModel === 'mlin' || model.codeModel === 'cpline' || model.codeModel === 'lcouple' || model.codeModel === 'core';
  const device = new XspiceDevice(
    card.name, model.codeModel, inputs, outputs, behavior,
    model.codeModel === 'xfer' ? [...model.warnings, 'XSPICE xfer: transient analysis uses only the first real table value, not a time-domain transfer function'] : model.warnings,
    untruncated,
  );
  netlistProbes.set(device, netlist);
  if (model.codeModel === 'ota') registerOtaNoise(device, params, inputs);
  if (model.codeModel === 'gain') registerGainNoise(device, params, inputs[0], outputs[0]);
  return device;
}

/**
 * ngspice cmmeters.c cm_netlist_get_c / cm_netlist_get_l over the compiled
 * devices: capacitors (inductors) with a terminal on the instance's first
 * positive node, plus those on the far node of a zero-valued DC voltage source
 * from it. Capacitances add; inductances combine in parallel from 1e12 H. Each
 * element counts once at CAPcapac / INDinduct: ngspice ignores the instance m.
 */
class NetlistProbe implements XspiceNetlistProbe {
  /** The compiled device list, bound by {@link bindXspiceSources} once every device exists. */
  devices: readonly DeviceModel[] = [];

  constructor(private readonly node: number) {}

  capacitance(): number {
    let c = 0.0;
    for (const node of this.meteredNodes()) {
      for (const device of this.devices) {
        if (device instanceof Capacitor && device.nodes.includes(node)) c += device.unitCapacitance;
      }
    }
    return c;
  }

  inductance(): number {
    let l = 1.0e12;
    for (const node of this.meteredNodes()) {
      for (const device of this.devices) {
        if (device instanceof Inductor && device.nodes.includes(node)) l = 1.0 / (1.0 / l + 1.0 / device.unitInductance);
      }
    }
    return l;
  }

  /** The metered node, then the far node of each zero-valued DC voltage source on it. */
  private meteredNodes(): number[] {
    const nodes = [this.node];
    for (const device of this.devices) {
      if (!(device instanceof VoltageSource)) continue;
      const { waveform } = device;
      const zeroDc = (waveform.type === 'dc' && waveform.value === 0)
        || (waveform.type === 'ac' && (waveform.dc ?? 0) === 0);
      if (!zeroDc) continue;
      const [positive, negative] = device.nodes;
      if (positive === this.node) nodes.push(negative);
      else if (negative === this.node) nodes.push(positive);
    }
    return nodes;
  }
}

/** Netlist probes of created devices, bound to the compiled device list by {@link bindXspiceSources}. */
const netlistProbes = new WeakMap<XspiceDevice, NetlistProbe>();

/** Bind every `%vnam` input to the branch of its controlling voltage source, and the netlist probes to the devices. */
export function bindXspiceSources(devices: readonly DeviceModel[], deviceMap: ReadonlyMap<string, DeviceModel>): void {
  for (const device of devices) {
    if (!(device instanceof XspiceDevice)) continue;
    const probe = netlistProbes.get(device);
    if (probe) probe.devices = devices;
    for (const { port, source } of device.unresolvedSources) {
      const controlling = [...deviceMap.entries()].find(([name]) => name.toUpperCase() === source.toUpperCase())?.[1];
      // A subcircuit source is named `<instance path>.<name>`: test its own name.
      if (!controlling || controlling.branches.length === 0 || !/(^|\.)v[^.]*$/i.test(source)) {
        throw new InvalidCircuitError(`${device.name}: unknown controlling source ${source}`);
      }
      device.bindSourceBranch(port, controlling.branches[0]);
    }
  }
}

/**
 * Reject analyses whose results the implemented code models cannot honour,
 * instead of simulating them silently wrong.
 */
export function assertXspiceAnalyses(
  instances: readonly PreparedXspiceInstance[],
  analyses: readonly string[],
): void {
  if (instances.length === 0) return;
  if (analyses.includes('disto')) {
    throw new InvalidCircuitError('XSPICE A devices do not support .disto (no distortion terms)');
  }
  const digital = instances.find(instance => DIGITAL_MODELS.has(instance.model.codeModel));
  // .ac follows ngspice-47 acan.c: EVTop sets the digital state, the sweep
  // loads only analog instances (the analog halves of the bridges).
  const unsupportedEvent = digital && analyses.find(analysis => analysis !== 'op' && analysis !== 'tran' && analysis !== 'ac');
  if (digital && unsupportedEvent) {
    throw new InvalidCircuitError(
      `XSPICE event-driven instance '${digital.card.name}' (${digital.model.codeModel}) is supported in .op, .tran and .ac only, not .${unsupportedEvent}`,
    );
  }
  for (const instance of instances) {
    const { codeModel } = instance.model;
    if (codeModel === 's_xfer') {
      const unsupported = analyses.find(analysis => !['op', 'dc', 'ac', 'tran'].includes(analysis));
      if (unsupported) throw new InvalidCircuitError(`XSPICE s_xfer instance '${instance.card.name}' does not support .${unsupported}`);
    }
    if (codeModel === 'int') {
      const unsupported = analyses.find(analysis => analysis === 'tf' || analysis === 'pz' || analysis === 'sens');
      if (unsupported) {
        throw new InvalidCircuitError(`XSPICE int instance '${instance.card.name}' does not support .${unsupported}`);
      }
      const currentOutput = instance.connections.some(connection =>
        connection.direction === 'out' && connection.ports.some(port => port.type === 'i' || port.type === 'id'));
      if (currentOutput && (analyses.includes('ac') || analyses.includes('noise'))) {
        throw new InvalidCircuitError(
          `XSPICE int instance '${instance.card.name}' does not support a current output in .${analyses.includes('ac') ? 'ac' : 'noise'}`,
        );
      }
    }
  }
}
