/**
 * The ngspice-47 XSPICE event-driven simulator (src/xspice/evt) for the
 * digital node type (src/xspice/idn/idndig.c).
 *
 * Event-driven instances drive digital nodes through per-output event queues
 * (EVTqueue_output: a new event cancels every later queued one), are called
 * when a node they read changes (EVTiter), and can queue a call of their own
 * (cm_event_queue). Hybrids (adc_bridge, dac_bridge) also have analog ports:
 * their analog half is an {@link XspiceDevice} that reads and writes the
 * event state through {@link EventInstanceView}.
 *
 * Coordination with the analog solver follows dctran.c and evtop.c:
 * - Operating point (EVTop): alternate event iterations, in which outputs
 *   take effect immediately, with analog operating-point solves, then call
 *   the hybrids, until no event output changes.
 * - Transient: before each analog step, process every event due at or before
 *   the step's end (EVTdequeue + EVTiter); outputs are queued with their
 *   delays. After a step is accepted, call the hybrids (EVTcall_hybrids,
 *   skipped on the first step) and commit (EVTaccept). A rejected step backs
 *   the event state up to the new step end (EVTbackup); here the state is
 *   restored from the checkpoint taken after the last event time at or before
 *   it, which keeps exactly the events EVTbackup keeps.
 */
import { InvalidCircuitError } from '../../errors.js';
import type { DeviceModel, EventDrivenNetwork, StampContext } from '../device.js';

/** idndig.c Digital_State_t */
export const ZERO = 0;
export const ONE = 1;
export const UNKNOWN = 2;
/** idndig.c Digital_Strength_t */
export const STRONG = 0;
export const RESISTIVE = 1;
export const HI_IMPEDANCE = 2;
export const UNDETERMINED = 3;

/** A digital node or output value (ngspice Digital_t). */
export interface DigitalValue {
  state: number;
  strength: number;
}

/** One output port during a code model call: OUTPUT_CHANGED, OUTPUT_STATE, OUTPUT_STRENGTH, OUTPUT_DELAY. */
export interface EventOutput {
  changed: boolean;
  state: number;
  strength: number;
  delay: number;
  /** LOAD(out): reset each call, accumulated in the node total only at INIT. */
  load: number;
}

/** One EVENT call of a code model (ngspice cm_<model>(ARGS) with CALL_TYPE == EVENT). */
export interface EventCall<S> {
  /** ANALYSIS: MIF_DC during the operating point, MIF_TRAN afterwards. */
  readonly analysis: 'dc' | 'tran';
  /** INIT: first call of this instance in the run. */
  readonly init: boolean;
  /** TIME: the event time (g_mif_info.circuit.evt_step); 0 in DC. */
  readonly time: number;
  /** Last accepted analog time, T(1). */
  readonly previousTime: number;
  /** cm_event_get_ptr(tag, 0): the state of this call. */
  readonly state: S;
  /** cm_event_get_ptr(tag, 1): the state before it (the same object when there is none). */
  readonly previous: S;
  /** INPUT_STATE of digital input port `port` (flattened over the input connections). */
  inputState(port: number): number;
  /** Full resolved digital input, including drive strength. */
  inputValue(port: number): DigitalValue;
  /** cm_probe_node: resolve this input without this instance's output driver(s). */
  probeExternal(port: number): DigitalValue;
  /** Digital output ports, flattened; `changed` starts true as in EVTload. */
  readonly outputs: readonly EventOutput[];
  /** cm_analog_set_perm_bkpt(time). */
  setBreakpoint(time: number): void;
  /** cm_analog_set_temp_bkpt. True if accepted; false for the fixed past/too close. */
  setTemporaryBreakpoint(time: number): boolean;
  /** cm_schedule_output(out, port, delay, value): queue an extra output event (transient only). */
  scheduleOutput(port: number, delay: number, value: DigitalValue): void;
}

/** The event half of an XSPICE code model. */
export interface EventBehavior<S> {
  /** Storage allocated at INIT (cm_event_alloc); the INIT call fills it. */
  createState(): S;
  /** The EVENT call. Must keep all mutable data in `call.state`. */
  event(call: EventCall<S>): void;
}

/** What the analog half of a hybrid sees of its event half during an ANALOG call. */
export interface EventInstanceView<S> {
  /** True once the INIT event call allocated the state. */
  readonly initialized: boolean;
  readonly state: S;
  readonly previous: S;
  inputState(port: number): number;
  /** Full resolved digital input, including drive strength. */
  inputValue(port: number): DigitalValue;
  /** cm_probe_node: resolve this input without this instance's output driver(s). */
  probeExternal(port: number): DigitalValue;
  /** cm_event_queue(time) from an ANALOG call at `time` (the analog TIME). */
  queue(time: number): void;
  /** cm_analog_set_perm_bkpt(time) from an ANALOG call at TIME `now`. */
  setBreakpoint(time: number, now: number): void;
  /** Record the analog input values the next EVENT call reads (INPUT(in[i])). */
  setAnalogInputs(values: ArrayLike<number>): void;
  /** The analog input values of the last ANALOG call. */
  readonly analogInputs: readonly number[];
}

/** A digital port of an instance: the node it reads or drives, and a `~` inversion. */
export interface EventPort {
  readonly node: string;
  readonly invert: boolean;
}

/** An instance as the network sees it. */
export interface EventInstanceSpec<S = unknown> {
  readonly name: string;
  readonly behavior: EventBehavior<S>;
  readonly inputs: readonly EventPort[];
  readonly outputs: readonly EventPort[];
  /** True when the instance also has analog ports (ngspice `analog && event_driven`). */
  readonly hybrid: boolean;
}

/** One recorded digital node value: the time it took effect and its state/strength. */
export interface DigitalNodeEvent {
  readonly time: number;
  readonly state: '0' | '1' | 'U';
  readonly strength: 's' | 'r' | 'z' | 'u';
}

interface PortRef {
  readonly node: number;
  readonly invert: boolean;
}

interface OutputRef extends PortRef {
  /** Global output index (ngspice output_index). */
  readonly index: number;
  /** Driver slot on the node (ngspice output_subindex). */
  readonly sub: number;
}

interface InstanceInfo {
  readonly name: string;
  readonly behavior: EventBehavior<unknown>;
  readonly inputs: readonly PortRef[];
  readonly outputs: readonly OutputRef[];
  readonly hybrid: boolean;
}

interface NodeInfo {
  readonly name: string;
  invert: boolean;
  drivers: number;
  readonly instances: number[];
}

/** rhsold of a node: the resolved value, one value per driver, the inverted value. */
interface NodeData {
  value: DigitalValue;
  totalLoad: number;
  drivers: DigitalValue[];
  inverted: DigitalValue;
}

interface QueuedOutput {
  time: number;
  value: DigitalValue;
}

interface InstanceData {
  initialized: boolean;
  /** Event states since the last accepted point (EVTcreate_state chain); the last is current. */
  states: unknown[];
  /** OUTPUT_DELAY of each output port (ngspice port->delay persists between calls). */
  delays: number[];
}

/** Everything a backup restores. Plain data, so `structuredClone` checkpoints it. */
interface NetworkData {
  nodes: NodeData[];
  outputQueues: QueuedOutput[][];
  instQueues: number[][];
  insts: InstanceData[];
  /** Node values set since the last accepted point, for the result history. */
  log: { node: number; time: number; value: DigitalValue }[];
}

const STATE_NAMES = ['0', '1', 'U'] as const;
const STRENGTH_NAMES = ['s', 'r', 'z', 'u'] as const;

/** idndig.c idn_digital_resolve: 12 x 12 map over e(state, strength) = strength * 3 + state. */
const RESOLVE: readonly (readonly number[])[] = (() => {
  const e = (state: number, strength: number) => strength * 3 + state;
  const [L, H, U] = [ZERO, ONE, UNKNOWN];
  const [s, r, z, u] = [STRONG, RESISTIVE, HI_IMPEDANCE, UNDETERMINED];
  return [
    [e(L, s), e(U, s), e(U, s), e(L, s), e(L, s), e(L, s), e(L, s), e(L, s), e(L, s), e(L, s), e(U, s), e(U, s)],
    [e(U, s), e(H, s), e(U, s), e(H, s), e(H, s), e(H, s), e(H, s), e(H, s), e(H, s), e(U, s), e(H, s), e(U, s)],
    [e(U, s), e(U, s), e(U, s), e(U, s), e(U, s), e(U, s), e(U, s), e(U, s), e(U, s), e(U, s), e(U, s), e(U, s)],
    [e(L, s), e(H, s), e(U, s), e(L, r), e(U, r), e(U, r), e(L, r), e(L, r), e(L, r), e(L, u), e(U, u), e(U, u)],
    [e(L, s), e(H, s), e(U, s), e(U, r), e(H, r), e(U, r), e(H, r), e(H, r), e(H, r), e(U, u), e(H, u), e(U, u)],
    [e(L, s), e(H, s), e(U, s), e(U, r), e(U, r), e(U, r), e(U, r), e(U, r), e(U, r), e(U, u), e(U, u), e(U, u)],
    [e(L, s), e(H, s), e(U, s), e(L, r), e(H, r), e(U, r), e(L, z), e(U, z), e(U, z), e(L, u), e(U, u), e(U, u)],
    [e(L, s), e(H, s), e(U, s), e(L, r), e(H, r), e(U, r), e(U, z), e(H, z), e(U, z), e(U, u), e(H, u), e(U, u)],
    [e(L, s), e(H, s), e(U, s), e(L, r), e(H, r), e(U, r), e(U, z), e(U, z), e(U, z), e(U, u), e(U, u), e(U, u)],
    [e(L, s), e(U, s), e(U, s), e(L, u), e(U, u), e(U, u), e(L, u), e(U, u), e(U, u), e(L, u), e(U, u), e(U, u)],
    [e(U, s), e(H, s), e(U, s), e(U, u), e(H, u), e(U, u), e(U, u), e(H, u), e(U, u), e(U, u), e(H, u), e(U, u)],
    [e(U, s), e(U, s), e(U, s), e(U, u), e(U, u), e(U, u), e(U, u), e(U, u), e(U, u), e(U, u), e(U, u), e(U, u)],
  ];
})();

/** idn_digital_resolve over the driver values of a node with more than one output. */
export function resolveDigital(values: readonly DigitalValue[]): DigitalValue {
  let index = values[0].strength * 3 + values[0].state;
  for (let i = 1; i < values.length; i++) {
    index = RESOLVE[index][values[i].strength * 3 + values[i].state];
  }
  return { state: index % 3, strength: Math.floor(index / 3) };
}

/** idn_digital_invert: 0 and 1 swap; U stays. */
function inverted(value: DigitalValue): DigitalValue {
  const state = value.state === ZERO ? ONE : value.state === ONE ? ZERO : value.state;
  return { state, strength: value.strength };
}

function equal(a: DigitalValue, b: DigitalValue): boolean {
  return a.state === b.state && a.strength === b.strength;
}

/** idn_digital_initialize: state ZERO, strength UNDETERMINED. */
function initialValue(): DigitalValue {
  return { state: ZERO, strength: UNDETERMINED };
}

/**
 * The event-driven half of a circuit. It is compiled as a device without
 * nodes so every analysis sees it; the analog solvers drive it through
 * {@link EventDrivenNetwork}.
 */
export class XspiceEventNetwork implements DeviceModel, EventDrivenNetwork {
  readonly name = '#xspice-event-network';
  readonly nodes: number[] = [];
  readonly branches: number[] = [];
  readonly isNonlinear = false;
  readonly eventDriven = this;

  private readonly instances: InstanceInfo[] = [];
  private readonly nodeInfo: NodeInfo[] = [];
  private readonly nodeIndex = new Map<string, number>();
  private outputCount = 0;
  private hybridOutputCount = 0;

  private data!: NetworkData;
  private analysis: 'dc' | 'tran' = 'dc';
  /** Snapshots after each processed event time since the last accepted point. */
  private checkpoints: { time: number; data: NetworkData }[] = [];
  /** The state after the operating point, restored when a transient run restarts. */
  private operatingPointData: NetworkData | undefined;
  private history = new Map<number, { time: number; value: DigitalValue }[]>();
  private breakpointSink: ((time: number) => void) | undefined;
  private minBreak = 0;
  /** CKTtime during an EVENT call: the last accepted analog time. */
  private analogTime = 0;
  private acceptedTime = 0;
  private temporaryBreakpoint = Infinity;

  private readonly changedOutputs = new Set<number>();
  private readonly toCall = new Set<number>();

  /** Add an instance; its digital ports join the network's nodes. Returns its view for the analog half. */
  addInstance<S>(spec: EventInstanceSpec<S>): EventInstanceView<S> {
    const instance = this.instances.length;
    const inputs = spec.inputs.map(port => {
      const node = this.node(port.node);
      const info = this.nodeInfo[node];
      if (port.invert) info.invert = true;
      if (!info.instances.includes(instance)) info.instances.push(instance);
      return { node, invert: port.invert };
    });
    const outputs = spec.outputs.map(port => {
      const node = this.node(port.node);
      const sub = this.nodeInfo[node].drivers++;
      return { node, invert: port.invert, index: this.outputCount++, sub };
    });
    if (spec.hybrid) this.hybridOutputCount += outputs.length;
    this.instances.push({
      name: spec.name, behavior: spec.behavior as EventBehavior<unknown>, inputs, outputs, hybrid: spec.hybrid,
    });
    return this.view<S>(instance);
  }

  /** Digital node names in index order. */
  get nodeNames(): readonly string[] {
    return this.nodeInfo.map(info => info.name);
  }

  /** EVTload's total_load, in farads; digital load is metadata, not an analog capacitor. */
  nodeLoads(): Map<string, number> {
    return new Map(this.nodeInfo.map((info, index) => [info.name, this.data.nodes[index].totalLoad]));
  }

  /** Accepted value changes of every digital node, starting with its operating-point value. */
  nodeHistories(): Map<string, DigitalNodeEvent[]> {
    const histories = new Map<string, DigitalNodeEvent[]>();
    this.nodeInfo.forEach((info, node) => {
      histories.set(info.name, (this.history.get(node) ?? []).map(({ time, value }) => ({
        time, state: STATE_NAMES[value.state], strength: STRENGTH_NAMES[value.strength],
      })));
    });
    return histories;
  }

  stamp(_ctx: StampContext): void {
    // No analog contribution: hybrids stamp through their analog XspiceDevice.
  }

  resetTransient(): void {
    // A transient restart begins from the operating point's event state.
    if (this.operatingPointData) {
      this.data = structuredClone(this.operatingPointData);
      this.analysis = 'dc';
      this.recordOperatingPoint();
    }
  }

  // ---------------------------------------------------------------- EVTop

  operatingPoint(solveAnalog: (first: boolean) => void): void {
    this.reset();
    this.analysis = 'dc';
    for (let i = 0; i < this.instances.length; i++) this.toCall.add(i);
    const maxAlternations = this.hybridOutputCount + 1;
    for (let alternations = 1; ; alternations++) {
      this.iterate(0);
      solveAnalog(alternations === 1);
      this.callHybrids(0);
      if (this.changedOutputs.size === 0) break;
      if (alternations >= maxAlternations) {
        throw new InvalidCircuitError('Too many analog/event-driven solution alternations');
      }
    }
    this.operatingPointData = structuredClone(this.data);
    this.recordOperatingPoint();
  }

  // ---------------------------------------------------------------- transient

  beginTransient(breakpoint: (time: number) => void, minBreak: number): void {
    if (this.data === undefined) {
      throw new InvalidCircuitError('XSPICE event-driven instances need initialization before transient analysis');
    }
    this.analysis = 'tran';
    this.breakpointSink = breakpoint;
    this.minBreak = minBreak;
    this.acceptedTime = 0;
    this.collapseStates();
    this.checkpoints = [{ time: 0, data: structuredClone(this.data) }];
  }

  nextEventTime(): number {
    let next = Infinity;
    for (const queue of this.data.outputQueues) if (queue.length > 0 && queue[0].time < next) next = queue[0].time;
    for (const queue of this.data.instQueues) if (queue.length > 0 && queue[0] < next) next = queue[0];
    return next;
  }

  processEvents(time: number, now: number): void {
    this.analogTime = now;
    this.dequeue(time);
    this.iterate(time);
    this.checkpoints.push({ time, data: structuredClone(this.data) });
  }

  backup(time: number): void {
    let index = this.checkpoints.length - 1;
    while (index > 0 && this.checkpoints[index].time > time) index--;
    this.checkpoints.length = index + 1;
    this.data = structuredClone(this.checkpoints[index].data);
  }

  prepareStep(time: number, callHybrids: boolean): number | undefined {
    this.analogTime = time;
    this.temporaryBreakpoint = Infinity;
    const trial = structuredClone(this.data);
    if (callHybrids) this.callHybrids(time);
    if (this.temporaryBreakpoint < time) {
      const retry = this.temporaryBreakpoint;
      this.backup(this.acceptedTime);
      this.changedOutputs.clear();
      this.toCall.clear();
      return retry;
    }
    // Analog accept hooks read the pre-hybrid event state. Replay hybrids only
    // after those hooks commit, preserving EVTcall_hybrids/EVTaccept ordering.
    this.data = trial;
    return undefined;
  }

  acceptStep(time: number, callHybrids: boolean): void {
    this.analogTime = time;
    if (callHybrids) this.callHybrids(time);
    for (const entry of this.data.log) this.record(entry.node, entry.time, entry.value);
    this.data.log = [];
    this.collapseStates();
    this.checkpoints = [{ time, data: structuredClone(this.data) }];
    this.acceptedTime = time;
  }

  // ---------------------------------------------------------------- internals

  private node(name: string): number {
    const key = name.toLowerCase();
    let index = this.nodeIndex.get(key);
    if (index === undefined) {
      index = this.nodeInfo.length;
      this.nodeIndex.set(key, index);
      this.nodeInfo.push({ name, invert: false, drivers: 0, instances: [] });
    }
    return index;
  }

  /** EVTsetup: every node at its initial value, empty queues, uninitialized instances. */
  private reset(): void {
    this.data = {
      nodes: this.nodeInfo.map(info => ({
        value: initialValue(),
        totalLoad: 0,
        drivers: Array.from({ length: info.drivers }, initialValue),
        inverted: initialValue(),
      })),
      outputQueues: Array.from({ length: this.outputCount }, () => []),
      instQueues: this.instances.map(() => []),
      insts: this.instances.map(instance => ({
        initialized: false, states: [], delays: instance.outputs.map(() => 0),
      })),
      log: [],
    };
    this.changedOutputs.clear();
    this.toCall.clear();
    this.checkpoints = [];
    this.history = new Map();
  }

  /** EVTop_save: the operating point is the first history entry of every node. */
  private recordOperatingPoint(): void {
    this.history = new Map();
    this.data.nodes.forEach((node, index) => this.record(index, 0, node.value));
  }

  private record(node: number, time: number, value: DigitalValue): void {
    let entries = this.history.get(node);
    if (!entries) {
      entries = [];
      this.history.set(node, entries);
    }
    const last = entries[entries.length - 1];
    if (last && equal(last.value, value)) return;
    entries.push({ time, value: { ...value } });
  }

  /** EVTaccept: only the latest event state of each instance survives. */
  private collapseStates(): void {
    for (const inst of this.data.insts) {
      if (inst.states.length > 1) inst.states = [inst.states[inst.states.length - 1]];
    }
  }

  private callHybrids(time: number): void {
    this.instances.forEach((instance, index) => {
      if (instance.hybrid) this.load(index, time);
    });
  }

  /** EVTdequeue: output events and instance calls due at `time`. */
  private dequeue(time: number): void {
    this.instances.forEach(instance => {
      for (const output of instance.outputs) {
        const queue = this.data.outputQueues[output.index];
        if (queue.length > 0 && queue[0].time === time) this.applyOutput(output, queue.shift()!.value);
      }
    });
    this.data.instQueues.forEach((queue, index) => {
      if (queue.length > 0 && queue[0] === time) {
        queue.shift();
        this.toCall.add(index);
      }
    });
  }

  /** Set an output's value on its node (EVTprocess_output of evtdeque.c and of DC evtload.c). */
  private applyOutput(output: OutputRef, value: DigitalValue): void {
    const node = this.data.nodes[output.node];
    const target = this.nodeInfo[output.node].drivers > 1 ? node.drivers[output.sub] : node.value;
    if (equal(value, target)) return;
    target.state = value.state;
    target.strength = value.strength;
    this.changedOutputs.add(output.index);
  }

  /** EVTiter: propagate changed outputs to nodes and call the instances reading them until nothing changes. */
  private iterate(time: number): void {
    const maxPasses = this.outputCount + 1;
    const outputNode = new Map<number, number>();
    for (const instance of this.instances) for (const output of instance.outputs) outputNode.set(output.index, output.node);
    for (let pass = 0; pass < maxPasses; pass++) {
      const toEval = new Set<number>();
      for (const output of this.changedOutputs) toEval.add(outputNode.get(output)!);
      this.changedOutputs.clear();
      for (const index of toEval) {
        const info = this.nodeInfo[index];
        const node = this.data.nodes[index];
        let same = false;
        if (info.drivers > 1) {
          const resolved = resolveDigital(node.drivers);
          same = equal(resolved, node.value);
          if (!same) node.value = resolved;
        }
        if (!same) {
          if (info.invert) node.inverted = inverted(node.value);
          for (const instance of info.instances) this.toCall.add(instance);
        }
        if (this.analysis === 'tran') this.data.log.push({ node: index, time, value: { ...node.value } });
      }
      const calls = [...this.toCall];
      this.toCall.clear();
      for (const instance of calls) this.load(instance, time);
      if (this.changedOutputs.size === 0) return;
    }
    throw new InvalidCircuitError('Too many iteration passes in event-driven circuits');
  }

  /** EVTload: one EVENT call of an instance at event time `time`. */
  private load(index: number, time: number): void {
    const instance = this.instances[index];
    const data = this.data.insts[index];
    const init = !data.initialized;
    if (init) {
      data.states = [instance.behavior.createState()];
    } else if (this.analysis === 'tran') {
      // EVTcreate_state: a new state, initialised to the previous one.
      data.states.push(structuredClone(data.states[data.states.length - 1]));
    }
    const states = data.states;
    const outputs: EventOutput[] = instance.outputs.map((output, k) => {
      const node = this.data.nodes[output.node];
      const current = this.nodeInfo[output.node].drivers > 1 ? node.drivers[output.sub] : node.value;
      return { changed: true, state: current.state, strength: current.strength, delay: data.delays[k], load: 0 };
    });
    const tran = this.analysis === 'tran';
    instance.behavior.event({
      analysis: this.analysis,
      init,
      time: tran ? time : 0,
      previousTime: this.acceptedTime,
      state: states[states.length - 1],
      previous: states[Math.max(0, states.length - 2)],
      inputState: port => this.inputState(instance.inputs[port]),
      inputValue: port => this.inputValue(instance.inputs[port]),
      probeExternal: port => this.probeExternal(instance, port),
      outputs,
      setBreakpoint: breakpoint => { if (tran) this.setBreakpoint(breakpoint, this.analogTime); },
      setTemporaryBreakpoint: breakpoint => {
        if (!tran || !Number.isFinite(breakpoint)
          || breakpoint < this.acceptedTime + this.minBreak
          || Math.abs(breakpoint - this.analogTime) < this.minBreak) return false;
        this.temporaryBreakpoint = Math.min(this.temporaryBreakpoint, breakpoint);
        return true;
      },
      scheduleOutput: (port, delay, value) => {
        if (!tran || delay < 0) return;
        const output = instance.outputs[port];
        this.queueOutput(output.index, time + delay, output.invert ? inverted(value) : { ...value });
      },
    });
    outputs.forEach((result, k) => {
      if (init) this.data.nodes[instance.outputs[k].node].totalLoad += result.load;
      data.delays[k] = result.delay;
      if (!result.changed) return;
      const output = instance.outputs[k];
      let value: DigitalValue = { state: result.state, strength: result.strength };
      if (output.invert) value = inverted(value);
      if (!tran) {
        this.applyOutput(output, value);
      } else if (result.delay >= 0) {
        this.queueOutput(output.index, time + result.delay, value);
      }
    });
    data.initialized = true;
  }

  private inputState(port: PortRef): number {
    const node = this.data.nodes[port.node];
    return (port.invert ? node.inverted : node.value).state;
  }

  private inputValue(port: PortRef): DigitalValue {
    const node = this.data.nodes[port.node];
    return { ...(port.invert ? node.inverted : node.value) };
  }

  private probeExternal(instance: InstanceInfo, port: number): DigitalValue {
    const input = instance.inputs[port];
    const node = this.data.nodes[input.node];
    const own = new Set(instance.outputs.filter(output => output.node === input.node).map(output => output.sub));
    const drivers = this.nodeInfo[input.node].drivers === 1 ? [node.value] : node.drivers;
    const external = drivers.filter((_, sub) => !own.has(sub));
    const value = external.length ? resolveDigital(external) : { state: UNKNOWN, strength: HI_IMPEDANCE };
    return input.invert ? inverted(value) : { ...value };
  }

  /** EVTqueue_output: insert by time; every queued event at or after it is cancelled. */
  private queueOutput(index: number, time: number, value: DigitalValue): void {
    const queue = this.data.outputQueues[index];
    let at = 0;
    while (at < queue.length && time > queue[at].time) at++;
    queue.length = at;
    queue.push({ time, value });
  }

  /** EVTqueue_inst: one call per distinct time. */
  private queueInstance(index: number, time: number): void {
    const queue = this.data.instQueues[index];
    let at = 0;
    while (at < queue.length && queue[at] < time) at++;
    if (queue[at] === time) return;
    queue.splice(at, 0, time);
  }

  /**
   * cm_analog_set_perm_bkpt at TIME `now`: CKTsetBreak for a later time; a
   * time within CKTminBreak of `now` becomes a temporary breakpoint that
   * cm_analog_set_temp_bkpt discards as too close to the current time.
   */
  private setBreakpoint(time: number, now: number): void {
    if (time < now + this.minBreak) return;
    this.breakpointSink?.(time);
  }

  private view<S>(index: number): EventInstanceView<S> {
    const network = this;
    let analogInputs: number[] = [];
    return {
      get initialized() { return network.data?.insts[index].initialized ?? false; },
      get state() {
        const states = network.data.insts[index].states;
        return states[states.length - 1] as S;
      },
      get previous() {
        const states = network.data.insts[index].states;
        return states[Math.max(0, states.length - 2)] as S;
      },
      inputState: port => network.inputState(network.instances[index].inputs[port]),
      inputValue: port => network.inputValue(network.instances[index].inputs[port]),
      probeExternal: port => network.probeExternal(network.instances[index], port),
      queue: time => {
        // cm_event_queue rejects a time before the current event time; in
        // DC the call is queued at TIME = 0 for the first transient pass.
        network.queueInstance(index, network.analysis === 'tran' ? time : 0);
      },
      setBreakpoint: (time, now) => { if (network.analysis === 'tran') network.setBreakpoint(time, now); },
      setAnalogInputs: values => { analogInputs = Array.from(values); },
      get analogInputs() { return analogInputs; },
    };
  }
}
