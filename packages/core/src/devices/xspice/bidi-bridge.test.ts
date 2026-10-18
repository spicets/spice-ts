import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { XSPICE_CODE_MODEL_SPECS } from './spec.js';
import { parseXspiceInstance, parseXspiceModelCard } from '../../parser/xspice-parser.js';
import { prepareXspiceInstance } from './compile.js';
import { bidiBridge } from './bidi-bridge.js';
import { HI_IMPEDANCE, ONE, RESISTIVE, STRONG, UNDETERMINED, UNKNOWN, ZERO,
  XspiceEventNetwork, type DigitalValue, type EventInstanceView, type EventOutput } from './event-network.js';
import type { CodeModelCall } from './models.js';

/** A hybrid call harness: only accept() may advance analog history. */
function analogHarness(parameters = '') {
  const prepared = prepareXspiceInstance(parseXspiceInstance('ab [a] [d] null bridge', 1),
    parseXspiceModelCard(`.model bridge bidi_bridge(${parameters})`, 2), false, '0');
  const model = bidiBridge(prepared.params, { connections: prepared.connections, given: new Set() });
  const state = model.event.createState();
  let input: DigitalValue = { state: ONE, strength: STRONG };
  const view: EventInstanceView<unknown> = {
    initialized: true, state, previous: state, inputState: () => input.state,
    inputValue: () => ({ ...input }), probeExternal: () => ({ ...input }),
    queue() {}, setBreakpoint() {}, setAnalogInputs() {}, analogInputs: [],
  };
  const analog = model.analog!(view);
  const event = (time: number, value: DigitalValue) => {
    input = value;
    const output: EventOutput = { changed: true, state: UNKNOWN, strength: HI_IMPEDANCE, delay: 0, load: 0 };
    model.event.event({ analysis: 'tran', init: time === 0, time, previousTime: time,
      state, previous: state, outputs: [output], inputState: view.inputState,
      inputValue: view.inputValue, probeExternal: view.probeExternal,
      setBreakpoint() {}, setTemporaryBreakpoint: () => false, scheduleOutput() {},
    });
    return output;
  };
  const load = (time: number, delta: number, voltage: number, accept = false) => {
    const call: CodeModelCall = { analysis: 'tran', init: false, time, delta,
      inputs: new Float64Array([voltage]), outputs: new Float64Array(1),
      partials: new Float64Array(1), notConverged() {},
    };
    analog.load(call);
    if (accept) analog.accept!(call);
    return call;
  };
  return { analog, event, load };
}

const CURRENT_DECK = `bidi current limiting
vhi hi 0 1
vlo lo 0 0
ar [hi lo] [dh dl] adc
.model adc adc_bridge
ab [source sink] [dh dl] null bridge
.model bridge bidi_bridge(direction=0)
rsource source 0 10
vsupply supply 0 3.3
rsink supply sink 10
.tran .05n 30n
.end`;

const RELEASE_DECK = `bidi tristate release and external analog drive
vhi hi 0 1
ven en 0 PWL(0 1 8n 1 8.1n 0)
vext ext 0 PWL(0 0 16n 0 16.1n 3.3 24n 3.3 24.1n 0)
adc [hi en] [data enable] adc
.model adc adc_bridge
atri data enable bus tri
.model tri d_tristate
ab [wire] [bus] null bridge
.model bridge bidi_bridge
rload wire ext 1k
abuf bus observed buf
.model buf d_buffer
.tran .05n 32n
.end`;

const SLEW_DECK = `bidi current slew
vhi hi 0 1
vlo lo 0 0
ar [hi lo] [dh dl] adc
.model adc adc_bridge
ab [source sink] [dh dl] null bridge
.model bridge bidi_bridge(direction=0 t_rise=10n t_fall=20n)
rsource source 0 10
vsupply supply 0 3.3
rsink supply sink 10
.tran .05n 30n
.end`;

const DIRECTION_DECK = `bidi direction ports and parameter override
vdir ctl 0 PWL(0 0 10n 0 10.1n 1)
adc [ctl] [dir] adc
.model adc adc_bridge
ap1 d1 up
ap2 d2 up
.model up d_pullup
ab1 [a1] [d1] [dir] bridge
ab2 [a2] [d2] [dir] forced
.model bridge bidi_bridge
.model forced bidi_bridge(direction=0)
r1 a1 0 1k
r2 a2 0 1k
.tran .05n 25n
.end`;

function sample(time: readonly number[], values: readonly number[], at: number): number {
  let i = 1;
  while (i < time.length - 1 && time[i] < at) i++;
  return values[i - 1] + (values[i] - values[i - 1]) * (at - time[i - 1]) / (time[i] - time[i - 1]);
}

describe('ngspice-47 bidi_bridge', () => {
  it('registers the complete ifspec defaults and electrical inout ports', () => {
    const spec = XSPICE_CODE_MODEL_SPECS.get('bidi_bridge')!;
    expect(spec.connections.map(c => [c.name, c.direction, c.defaultType, c.nullAllowed]))
      .toEqual([['a', 'inout', 'g', false], ['d', 'inout', 'd', false], ['dir', 'in', 'd', true]]);
    expect(Object.fromEntries(spec.params.map(p => [p.name, p.defaultValue![0]]))).toEqual({
      direction: 2, strength: 0, smooth: 0, input_load: 1e-12, in_low: .1, in_high: .9,
      out_low: 0, out_high: 3.3, drive_low: .02, drive_high: .02,
      r_stl: 20, r_sth: 20, r_low: 10000, r_high: 10000,
      t_rise: 1e-9, t_fall: 1e-9, rise_delay: 1e-9, fall_delay: 1e-9,
    });
  });

  it('limits both strong source and sink currents instead of imposing a voltage', async () => {
    // Actual ngspice-47 run: meas tran source/sink find v(...) at=20n:
    // .2 V / 3.1 V into 10 ohms, i.e. +/-20 mA, not the unloaded rails.
    const { transient: tr } = await simulate(CURRENT_DECK);
    expect(sample(tr!.time, tr!.voltage('source'), 20e-9)).toBeCloseTo(.2, 9);
    expect(sample(tr!.time, tr!.voltage('sink'), 20e-9)).toBeCloseTo(3.1, 9);
  });

  it('releases a tristate and follows external analog drive without self-feedback', async () => {
    const { transient: tr } = await simulate(RELEASE_DECK);
    for (const [at, expected] of [[6e-9, 3.235294117647059], [14e-9, 0], [22e-9, 3.3], [30e-9, 0]]) {
      expect(sample(tr!.time, tr!.voltage('wire'), at)).toBeCloseTo(expected, 8);
    }
    // ngspice-47 eprint: Us,1s,Us,0s,Us,1s,0s (including the initial
    // contention before the analog port has ramped and its ADC has caught up).
    expect(tr!.digital('observed').map(e => `${e.state}${e.strength}`))
      .toEqual(['Us', '1s', 'Us', '0s', 'Us', '1s', '0s']);
  });

  it('matches ngspice current-slew samples with unequal rise and fall times', async () => {
    const { transient: tr } = await simulate(SLEW_DECK);
    // ngspice-47 wrdata, the identical SLEW_DECK, 15 significant digits.
    for (const [at, source, sink] of [
      [2e-9, .04, 3.22], [4e-9, .08, 3.185714285714286],
      [8e-9, .16, 3.128571428571429], [20e-9, .2, 3.1],
    ]) {
      expect(sample(tr!.time, tr!.voltage('source'), at)).toBeCloseTo(source, 8);
      expect(sample(tr!.time, tr!.voltage('sink'), at)).toBeCloseTo(sink, 8);
    }
  });

  it('honors the explicit direction input and a forced direction overriding it', async () => {
    const { transient: tr } = await simulate(DIRECTION_DECK);
    expect(sample(tr!.time, tr!.voltage('a1'), 8e-9)).toBeCloseTo(.3, 9);
    expect(sample(tr!.time, tr!.voltage('a1'), 22e-9)).toBeCloseTo(0, 9);
    expect(sample(tr!.time, tr!.voltage('a2'), 22e-9)).toBeCloseTo(.3, 9);
  });

  it('slews current from accepted history, not from Newton or rejected trial loads', () => {
    const h = analogHarness('t_rise=10n t_fall=20n');
    h.event(0, { state: ONE, strength: STRONG });
    expect(h.load(30e-9, 30e-9, 0, true).outputs[0]).toBeCloseTo(-.02, 12);
    h.event(30e-9, { state: ZERO, strength: STRONG });
    expect(h.load(31e-9, 1e-9, 3.3).outputs[0]).toBeCloseTo(-.016, 12);
    expect(h.load(35e-9, 5e-9, 3.3).outputs[0]).toBeCloseTo(0, 12);
    // Back up to a smaller step after the rejected trial; no history leaked.
    expect(h.load(30.1e-9, .1e-9, 3.3).outputs[0]).toBeCloseTo(-.0196, 12);
    expect(h.load(31e-9, 1e-9, 3.3, true).outputs[0]).toBeCloseTo(-.016, 12);
    h.analog.beginTransient!();
    expect(h.load(32e-9, 1e-9, 3.3).outputs[0]).toBeCloseTo(-.012, 12);
    h.analog.reset!();
    expect(h.load(0, 0, 0).outputs[0]).toBe(0);
  });

  for (const strength of [RESISTIVE, UNDETERMINED]) {
    it(`uses one-sided resistive drive for strength ${strength}`, () => {
      const h = analogHarness();
      h.event(0, { state: ONE, strength });
      expect(h.load(20e-9, 20e-9, 0).outputs[0]).toBeCloseTo(-.00033, 12);
      expect(h.load(20e-9, 20e-9, 4).outputs[0]).toBe(0);
      h.event(0, { state: ZERO, strength });
      expect(h.load(20e-9, 20e-9, 1).outputs[0]).toBeCloseTo(.0001, 12);
      expect(h.load(20e-9, 20e-9, -1).outputs[0]).toBe(0);
    });
  }

  it('turns both drivers off for Z, and on for strong U', () => {
    const h = analogHarness();
    for (const state of [ZERO, ONE, UNKNOWN]) {
      h.event(0, { state, strength: HI_IMPEDANCE });
      expect(h.load(20e-9, 20e-9, 2).outputs[0]).toBe(0);
    }
    h.event(0, { state: UNKNOWN, strength: STRONG });
    expect(h.load(20e-9, 20e-9, 0).outputs[0]).toBeCloseTo(-.02 * .2 / .7, 12);
  });

  it('preserves ngspice strict ADC thresholds, hysteresis and requested output strength', () => {
    const h = analogHarness('direction=1 strength=1 in_low=7 in_high=3');
    h.load(0, 0, 10);
    const high = h.event(0, { state: UNKNOWN, strength: HI_IMPEDANCE });
    expect([high.state, high.strength, high.delay]).toEqual([ONE, RESISTIVE, 1e-9]);
    // Hysteresis retains ONE at the boundary and in the band, not UNKNOWN.
    h.load(1e-9, 1e-9, 3);
    expect(h.event(1e-9, { state: UNKNOWN, strength: HI_IMPEDANCE }).changed).toBe(false);
    h.load(2e-9, 1e-9, 2.9);
    expect(h.event(2e-9, { state: UNKNOWN, strength: HI_IMPEDANCE }).state).toBe(ZERO);
    const plain = analogHarness('direction=1');
    plain.load(0, 0, .9);
    expect(plain.event(0, { state: UNKNOWN, strength: HI_IMPEDANCE }).state).toBe(UNKNOWN);
  });

  it('preserves the source asymmetric strong-U comparison quirk', () => {
    const h = analogHarness('drive_high=.01 drive_low=.02');
    h.event(0, { state: UNKNOWN, strength: STRONG });
    // cfunc.mod:226-231 repeats > instead of testing <: the .5 target stays.
    expect(h.load(20e-9, 20e-9, 0).outputs[0]).toBeCloseTo(-.01 * .2 / .7, 12);
  });

  it('probes external drivers with strength and inversion, excluding itself even as sole driver', () => {
    const network = new XspiceEventNetwork();
    const port = { node: 'd', invert: false };
    network.addInstance({ name: 'external', inputs: [], outputs: [port], hybrid: false,
      behavior: { createState: () => null, event(call) {
        call.outputs[0].state = ONE; call.outputs[0].strength = RESISTIVE;
      } },
    });
    const view = network.addInstance({ name: 'bridge', inputs: [{ ...port, invert: true }], outputs: [port], hybrid: false,
      behavior: { createState: () => null, event(call) {
        call.outputs[0].state = ZERO; call.outputs[0].strength = STRONG;
      } },
    });
    const sole = network.addInstance({ name: 'sole', inputs: [{ node: 'alone', invert: false }], outputs: [{ node: 'alone', invert: false }], hybrid: false,
      behavior: { createState: () => null, event(call) {
        call.outputs[0].state = ONE; call.outputs[0].strength = STRONG;
      } },
    });
    network.operatingPoint(() => {});
    expect(view.inputValue(0)).toEqual({ state: ONE, strength: STRONG });
    expect(view.probeExternal(0)).toEqual({ state: ZERO, strength: RESISTIVE });
    expect(sole.probeExternal(0)).toEqual({ state: UNKNOWN, strength: HI_IMPEDANCE });
  });
});
