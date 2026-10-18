import { describe, expect, it } from 'vitest';
import { simulate } from '../../index.js';
import { controlledOscillator } from './dosc-pwm-models.js';
import type { EventInstanceView, EventOutput } from './event-network.js';
import type { ResolvedXspiceParams } from './models.js';

async function edges(model: string, control: number, parameters: string) {
  const result = await simulate(`controlled digital oscillator
v1 in 0 ${control}
a1 in out clock
.model clock ${model} (${parameters})
.tran 1m 2.1 0 1m
.end`);
  return result.transient!.digital('out');
}

function expectEdges(actual: Awaited<ReturnType<typeof edges>>, expected: [number, string][]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((edge, i) => {
    expect(edge.time).toBeCloseTo(expected[i][0], 10);
    expect(edge.state).toBe(expected[i][1]);
    expect(edge.strength).toBe('s');
  });
}

describe('ngspice-47 controlled digital oscillators (#1221)', () => {
  it('interpolates frequency and uses low-first duty timing, ignoring legacy delays', async () => {
    // control 1 -> 2 Hz, period .5 s, low .375 s, high .125 s.
    expectEdges(await edges('d_osc', 1,
      'cntl_array=[0 2] freq_array=[1 3] duty_cycle=.25 rise_delay=.1 fall_delay=.2'),
    [[0, '0'], [.375, '1'], [.5, '0'], [.875, '1'], [1, '0'], [1.375, '1'], [1.5, '0'], [1.875, '1'], [2, '0']]);
  });

  it('extrapolates frequency outside the table and starts high for phase 270 degrees', async () => {
    // control 2 -> 2 Hz; phase .75 starts high, next fall at .125 s.
    expectEdges(await edges('d_osc', 2,
      'cntl_array=[0 1] freq_array=[1 1.5] init_phase=270'),
    [[0, '1'], [.125, '0'], [.375, '1'], [.625, '0'], [.875, '1'], [1.125, '0'], [1.375, '1'], [1.625, '0'], [1.875, '1']]);
  });

  it('interpolates PWM duty and normalizes negative phase', async () => {
    // duty .25, phase -90 -> .75; the zero-time rising edge is the initial value.
    expectEdges(await edges('d_pwm', 0,
      'cntl_array=[-1 1] dc_array=[.1 .4] frequency=1 init_phase=-90'),
    [[0, '1'], [.25, '0'], [1, '1'], [1.25, '0'], [2, '1']]);
  });

  it.each([[-2, .99], [2, .01]])('clamps extrapolated PWM control %s', async (control, firstRise) => {
    const history = await edges('d_pwm', control, 'frequency=1');
    expect(history[0].state).toBe('0');
    expect(history[1].time).toBeCloseTo(firstRise, 10);
    expect(history[2].time).toBeCloseTo(1, 10);
  });

  it.each([false, true])('resamples %s control and leaves pending edges alone', pwm => {
    const params: ResolvedXspiceParams = new Map([
      ['cntl_array', [0, 1]], ['freq_array', [1, 1.5]], ['dc_array', [.5, .6]],
      ['duty_cycle', [.5]], ['frequency', [1]], ['init_phase', [0]],
    ]);
    const model = controlledOscillator(pwm)(params, { connections: [], given: new Set() });
    const state = model.event.createState();
    let inputs = [0];
    const queued: number[] = [];
    const view: EventInstanceView<unknown> = {
      initialized: true, state, previous: state, inputState: () => 0, inputReal: () => 0,
      queue: time => queued.push(time), setBreakpoint: () => {},
      setAnalogInputs: values => { inputs = Array.from(values); },
      get analogInputs() { return inputs; },
    };
    model.analog!(view).load({
      analysis: 'dc', init: false, time: 0, delta: 0,
      inputs: new Float64Array([0]), outputs: new Float64Array(0),
      partials: new Float64Array(0), notConverged() {},
    });
    const call = (time: number) => {
      const out: EventOutput = { changed: true, state: 2, strength: 3, delay: 0, load: 0 };
      model.event.event({
        analysis: 'tran', init: false, time, state, previous: structuredClone(state),
        outputs: [out], inputState: () => 0, inputReal: () => 0, queue() {}, setBreakpoint() {}, scheduleOutput() {},
      });
      return out;
    };
    call(0);
    expect(queued.pop()).toBeCloseTo(.4, 12); // .8 of the initial low half-cycle
    // New frequency 1.25 Hz or duty .6: the next rising edge is .4 s.
    inputs = [pwm ? 1 : .5];
    const rising = call(.32); // beyond .75 of the newly calculated low interval
    expect(rising.changed).toBe(true);
    expect(rising.state).toBe(1);
    expect(rising.delay).toBeCloseTo(.08, 12);
    expect(queued.pop()).toBeCloseTo(pwm ? .88 : .72, 12);
    expect(call(.35).changed).toBe(false);
    expect(queued).toEqual([]);
  });
});
