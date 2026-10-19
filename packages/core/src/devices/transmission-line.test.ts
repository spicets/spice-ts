import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from '../parser/index.js';
import { simulate } from '../simulate.js';
import type { StampContext } from './device.js';
import { TransmissionLine } from './transmission-line.js';

function valueAtOrAfter(time: number[], values: number[], target: number): number {
  const index = time.findIndex(point => point >= target);
  if (index < 0) throw new Error(`No transient sample at ${target}`);
  return values[index];
}

const fixture = (sourceResistance: number, loadResistance: number): string => `Lossless line step response
VSTEP source 0 PULSE(0 1 1n 100p 100p 100n 200n)
RS source input ${sourceResistance}
T1 input 0 output 0 Z0=50 TD=5n
RL output 0 ${loadResistance}
.tran 50p 20n 0 50p
.end
`;

/**
 * ngspice-47 `ngspice -b -r` points of the mismatched (25 ohm source, 100 ohm
 * load) fixture, which ngspice writes at 414 timepoints: the first load step,
 * the source return and the second load step (#791).
 */
const NGSPICE_MISMATCHED_POINTS = 414;
const NGSPICE_MISMATCHED: ReadonlyArray<{ time: number; node: string; value: number }> = [
  { time: 6.024999999999984e-9, node: 'output', value: 0.2222222222220827 },
  { time: 6.074999999999984e-9, node: 'output', value: 0.6666666666665237 },
  { time: 1.102500000000001e-8, node: 'input', value: 0.7037037037037044 },
  { time: 1.107500000000001e-8, node: 'input', value: 0.7777777777777789 },
  { time: 1.602500000000005e-8, node: 'output', value: 0.8641975308641655 },
  { time: 1.607500000000005e-8, node: 'output', value: 0.8148148148147826 },
];

describe('bounded lossless transmission line transient execution', () => {
  it.each([
    ['REL=1 ABS=1', 414],
    ['REL=0.5', 432],
    ['REL=0.5 ABS=1g', 426],
  ])('runs a T-card with %s on the ngspice-47 point count', async (parameters, points) => {
    const transient = (await simulate(fixture(25, 100).replace('TD=5n', `TD=5n ${parameters}`))).transient!;
    expect(transient.time).toHaveLength(points);
    expect(valueAtOrAfter(transient.time, transient.voltage('output'), 8e-9)).toBeCloseTo(8 / 9, 9);
  });

  it('keeps the default time grid and port waves unchanged when REL/ABS are omitted', async () => {
    const omitted = (await simulate(fixture(25, 100))).transient!;
    const explicit = (await simulate(fixture(25, 100).replace('TD=5n', 'TD=5n REL=1 ABS=1'))).transient!;
    expect(explicit.time).toEqual(omitted.time);
    for (const node of ['input', 'output']) expect(explicit.voltage(node)).toEqual(omitted.voltage(node));
  });

  it.each([
    ['REL=1 ABS=1', false],
    ['REL=.5 ABS=1', true],
    ['REL=.25 ABS=2', true],
    ['REL=.25 ABS=2.01', false],
    ['REL=0 ABS=3', true],
  ])('uses the TRA slope threshold in accept and truncation: %s', (parameters, bends) => {
    for (const port of [0, 1]) {
      const line = parse(`Slope control\nT1 in 0 out 0 Z0=50 TD=5 ${parameters}\n.end`).compile().devices[0] as TransmissionLine;
      let wave = 0;
      const ctx: StampContext = {
        time: 0, dt: 1, numNodes: 2, sourceScale: 1, useDcSourceValue: false,
        stampG: () => {}, stampC: () => {}, stampB: () => {},
        getVoltage: node => node === port ? wave : 0, getCurrent: () => 0,
      };
      line.acceptTransientStep(ctx);
      ctx.time = 1;
      wave = 1;
      line.acceptTransientStep(ctx);
      ctx.time = 2;
      wave = 5; // slopes 4 and 1: |4-1| >= REL*4 + ABS, inclusive.
      expect(line.truncateTransientStep(ctx, { deltas: [1, 1, 1], reltol: 1e-3, abstol: 1e-12, chgtol: 1e-14, trtol: 7 }))
        .toBe(bends ? 4 : Infinity);
      const scheduled: number[] = [];
      line.acceptTransientStep(ctx, { schedule: time => { scheduled.push(time); } });
      expect(scheduled).toEqual(bends ? [6] : []);
    }
  });

  const icDeck = readFileSync(new URL('../../../../benchmarks/transmission-line-ic/step.cir', import.meta.url), 'utf8');

  it.each([
    { ic: '1,0.02,1,0.02', input: 1, output: 1 },
    { ic: '2,0.01,-0.5,0.03', input: 0.5, output: 1.25 },
  ])('uses IC=$ic for UIC prehistory (ngspice-47)', async ({ ic, input, output }) => {
    const deck = icDeck.replace('IC=1,0.02,1,0.02', `IC=${ic}`);
    const transient = (await simulate(deck)).transient!;
    expect(transient.time).toHaveLength(517);
    for (const [node, initial] of [['input', input], ['output', output]] as const) {
      // Native ngspice-47 oracle plateaus, including the delayed source edge.
      const values = transient.voltage(node);
      expect(valueAtOrAfter(transient.time, values, 0.5e-9)).toBeCloseTo(initial, 9);
      expect(valueAtOrAfter(transient.time, values, 1.5e-9)).toBeCloseTo(0, 9);
      expect(valueAtOrAfter(transient.time, values, 3.5e-9)).toBeCloseTo(0.5, 9);
    }
  });

  it('ignores IC without UIC and seeds the DC operating point (ngspice-47)', async () => {
    const deck = icDeck.replace(' UIC', '').replace('PULSE(0 1', 'PULSE(0.4 1');
    const withoutUIC = (await simulate(deck)).transient!;
    const withoutIC = (await simulate(deck.replace(' IC=1,0.02,1,0.02', ''))).transient!;
    expect(withoutUIC.time).toHaveLength(514);
    expect(withoutUIC.time).toEqual(withoutIC.time);
    for (const node of ['input', 'output']) {
      expect(withoutUIC.voltage(node)[0]).toBeCloseTo(0.2, 9);
      expect(withoutUIC.voltage(node)).toEqual(withoutIC.voltage(node));
    }
  });
  it('initializes parallel lossless lines without indeterminate DC branch currents', async () => {
    const deck = fixture(50, 50)
      .replace('PULSE(0 1 1n 100p 100p 100n 200n)', '1')
      .replace('RL output', 'T2 input 0 output 0 Z0=50 F=50meg\nRL output');
    const transient = (await simulate(deck)).transient!;
    for (const value of transient.voltage('output')) expect(value).toBeCloseTo(0.5, 9);
  });

  it.each(['F=50meg NL=.25', 'F=50meg', 'TD=5n F=1g NL=10'])
    ('produces the TD=5n waveform for %s', async parameters => {
      const reference = (await simulate(fixture(50, 50))).transient!;
      const actual = (await simulate(fixture(50, 50).replace('TD=5n', parameters))).transient!;
      expect(actual.time).toEqual(reference.time);
      expect(actual.voltage('output')).toEqual(reference.voltage('output'));
      expect(actual.voltage('input')).toEqual(reference.voltage('input'));
    });

  it.each([
    { acceptedTime: 25e-15, expectedWave: 1, reason: 'close later sample' },
    { acceptedTime: 15e-15, expectedWave: 1, reason: 'older sample' },
    { acceptedTime: 20e-15, expectedWave: 2, reason: 'exact repeated timepoint' },
  ])('preserves the retained timestamp for $reason', ({ acceptedTime, expectedWave }) => {
    const line = new TransmissionLine('T1', [0, -1, 1, -1], 0, 1, 50, 500e-15);
    const rhs = new Map<number, number>();
    let wave = 0;
    const ctx: StampContext = {
      time: 0, dt: 5e-15, numNodes: 2, sourceScale: 1, useDcSourceValue: false,
      stampG: () => {}, stampC: () => {},
      stampB: (row, value) => { rhs.set(row, value); },
      getVoltage: node => node === 0 ? wave : 0,
      getCurrent: () => 0,
    };
    line.acceptTransientStep(ctx);
    ctx.time = 20e-15;
    wave = 1;
    line.acceptTransientStep(ctx);
    ctx.time = acceptedTime;
    wave = 2;
    line.acceptTransientStep(ctx);
    ctx.time = 520e-15;
    line.stamp(ctx);
    expect(rhs.get(3)).toBeCloseTo(expectedWave, 12);
  });

  it('retains delayed history when distinct accepted steps are only 5 fs apart', async () => {
    const result = await simulate(parse(`Short-step matched lossless line
V1 source 0 PULSE(0 1 100f 10f 10f 10p 20p)
RS source input 50
T1 input 0 output 0 Z0=50 TD=500f
RL output 0 50
.tran 5f 2p 0 5f
.end
`));
    const transient = result.transient!;
    const output = transient.voltage('output');
    // Stay clear of the quadratic interpolation stencil at the arrival edge.
    const beforeArrival = output.filter((_value, index) => transient.time[index] < 580e-15);
    expect(beforeArrival.length).toBeGreaterThan(0);
    expect(Math.max(...beforeArrival.map(Math.abs))).toBe(0);
    const settled = output.filter((_value, index) => transient.time[index] >= 700e-15);
    expect(settled.length).toBeGreaterThan(0);
    for (const value of settled) expect(value).toBeCloseTo(0.5, 9);
    expect(output[output.length - 1]).toBeCloseTo(0.5, 9);
  });

  it('commits only accepted history and stays zero before source edge plus TD', async () => {
    // The input capacitor's charge truncation rejects a trial step on the
    // source edge; a rejected trial must not enter the line's history.
    const result = await simulate(parse(fixture(50, 50).replace('.tran', 'CI input 0 10p\n.tran')));
    const transient = result.transient!;
    const output = transient.voltage('output');
    const beforeArrival = output.filter((_value, index) => transient.time[index] < 6e-9);

    expect(result.convergence!.transient.rejectedSteps).toBeGreaterThan(0);
    expect(Math.max(...beforeArrival.map(Math.abs))).toBe(0);
    expect(valueAtOrAfter(transient.time, output, 10e-9)).toBeCloseTo(0.5, 3);
  });

  it('steps and interpolates like ngspice-47 TRA: no TD breakpoint, no node-voltage truncation (#791)', async () => {
    const result = await simulate(parse(fixture(25, 100)));
    const transient = result.transient!;

    expect(transient.time.length).toBe(NGSPICE_MISMATCHED_POINTS);
    expect(transient.time.some(time => Math.abs(time - 5e-9) < 1e-15)).toBe(false);
    for (const point of NGSPICE_MISMATCHED) {
      const index = transient.time.findIndex(time => Math.abs(time - point.time) < 1e-18);
      expect(index, `spice-ts has ngspice-47's point ${point.time}`).toBeGreaterThan(0);
      expect(Math.abs(transient.voltage(point.node)[index] - point.value)).toBeLessThan(1e-9);
    }
  });

  it('propagates a matched step by TD without a reflection', async () => {
    const result = await simulate(parse(fixture(50, 50)));
    const transient = result.transient!;
    const input = transient.voltage('input');
    const output = transient.voltage('output');

    expect(valueAtOrAfter(transient.time, input, 1.2e-9)).toBeCloseTo(0.5, 2);
    expect(valueAtOrAfter(transient.time, output, 5.9e-9)).toBeCloseTo(0, 2);
    expect(valueAtOrAfter(transient.time, output, 6.2e-9)).toBeCloseTo(0.5, 2);
    expect(valueAtOrAfter(transient.time, input, 11.2e-9)).toBeCloseTo(0.5, 2);
  });

  it('replays load and source reflections for a mismatched line', async () => {
    const result = await simulate(parse(fixture(25, 100)));
    const transient = result.transient!;
    const input = transient.voltage('input');
    const output = transient.voltage('output');

    // Initial wave: 50 / (25 + 50) = 2/3. Load reflection coefficient = 1/3.
    expect(valueAtOrAfter(transient.time, input, 1.2e-9)).toBeCloseTo(2 / 3, 2);
    expect(valueAtOrAfter(transient.time, output, 6.2e-9)).toBeCloseTo(8 / 9, 2);
    // The load reflection returns after 2*TD; source coefficient is -1/3.
    expect(valueAtOrAfter(transient.time, input, 11.2e-9)).toBeCloseTo(22 / 27, 2);
    expect(valueAtOrAfter(transient.time, output, 16.2e-9)).toBeCloseTo(64 / 81, 2);
  });
});
