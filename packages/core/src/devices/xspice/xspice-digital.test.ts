import { describe, expect, it } from 'vitest';
import { InvalidCircuitError } from '../../errors.js';
import { UnsupportedCodeModelError } from '../../parser/xspice-parser.js';
import { simulate } from '../../simulate.js';
import { createTransientSim } from '../../analysis/transient-driver.js';
import type { DigitalNodeEvent } from './event-network.js';

/*
 * Issue #553 slice 3: the XSPICE event-driven simulator with the digital
 * gates (d_buffer, d_inverter, d_and, d_nand, d_or, d_nor, d_xor, d_xnor)
 * and the adc_bridge/dac_bridge node bridges. Reference values come from
 * ngspice-47 (Homebrew build) running the same cards with
 * `.control / set numdgt=15 / tran|op / eprint <digital nodes> / wrdata|print`;
 * the decks are under benchmarks/xspice-553/fixtures/.
 */

/** Parse an ngspice `eprint` table into each node's value changes (consecutive repeats dropped). */
function eprintChanges(nodes: readonly string[], table: string): Map<string, [number, string][]> {
  const changes = new Map<string, [number, string][]>(nodes.map(node => [node, []]));
  for (const line of table.trim().split('\n')) {
    const [time, ...values] = line.trim().split(/\s+/);
    nodes.forEach((node, i) => {
      const list = changes.get(node)!;
      if (list.length === 0 || list[list.length - 1][1] !== values[i]) list.push([Number(time), values[i]]);
    });
  }
  return changes;
}

function expectHistory(actual: DigitalNodeEvent[], expected: [number, string][], node: string): void {
  const got = actual.map(event => `${event.state}${event.strength}`);
  expect(got, `states of ${node}`).toEqual(expected.map(([, value]) => value));
  actual.forEach((event, i) => {
    expect(Math.abs(event.time - expected[i][0]), `time of change ${i} on ${node}`)
      .toBeLessThanOrEqual(1e-12 * Math.max(1, expected[i][0]) + 1e-21);
  });
}

function interpolate(time: readonly number[], values: readonly number[], at: number): number {
  let index = 1;
  while (index < time.length - 1 && time[index] < at) index++;
  const fraction = (at - time[index - 1]) / (time[index] - time[index - 1]);
  return values[index - 1] + fraction * (values[index] - values[index - 1]);
}

const GATES_DECK = [
  'gates8',
  'v2 200 0 DC PWL( (0 0.0) (2 0.0) (2.0000000001 1.0) (3 1.0) )',
  'v1 100 0 DC PWL( (0 0.0) (1.0 0.0) (1.0000000001 1.0) (2 1.0) (2.0000000001 0.0) (3 0.0) (3.0000000001 1.0) (4 1.0) )',
  'aconverter [200 100] [2 1] adc_bridge1',
  '.model adc_bridge1 adc_bridge (in_low=0.1 in_high=0.9 rise_delay=1.0e-12 fall_delay=1.0e-12)',
  'a1 1 10 d_buffer1',
  '.model d_buffer1 d_buffer (rise_delay=1.0e-6 fall_delay=2.0e-6 input_load=1.0e-12)',
  'a2 1 20 d_inv1',
  '.model d_inv1 d_inverter (rise_delay=1.0e-6 fall_delay=2.0e-6 input_load=1.0e-12)',
  'a3 [1 2] 30 d_and1',
  '.model d_and1 d_and (rise_delay=1.0e-6 fall_delay=2.0e-6 input_load=1.0e-12)',
  'a4 [1 2] 40 d_nand1',
  '.model d_nand1 d_nand (rise_delay=1.0e-6 fall_delay=2.0e-6 input_load=1.0e-12)',
  'a5 [1 2] 50 d_or1',
  '.model d_or1 d_or (rise_delay=1.0e-6 fall_delay=2.0e-6 input_load=1.0e-12)',
  'a6 [1 2] 60 d_nor1',
  '.model d_nor1 d_nor (rise_delay=1.0e-6 fall_delay=2.0e-6 input_load=1.0e-12)',
  'a7 [1 2] 70 d_xor1',
  '.model d_xor1 d_xor (rise_delay=1.0e-6 fall_delay=2.0e-6 input_load=1.0e-12)',
  'a8 [1 2] 80 d_xnor1',
  '.model d_xnor1 d_xnor (rise_delay=1.0e-6 fall_delay=2.0e-6 input_load=1.0e-12)',
  'a9 [1 ~2] ~90 d_and1',
  'r1 100 0 1k', 'r2 200 0 1k',
  '.tran .01 4', '.end',
].join('\n');

// ngspice-47: eprint 1 2 10 20 30 40 50 60 70 80 90 (set numdgt=15)
const GATES_NODES = ['1', '2', '10', '20', '30', '40', '50', '60', '70', '80', '90'];
const GATES_EPRINT = `
0.000000000000000e+00    0s    0s    0s    1s    0s    1s    0s    1s    0s    1s    1s
1.000000000031000e+00    Us    0s    0s    1s    0s    1s    0s    1s    0s    1s    1s
1.000000000101000e+00    1s    0s    0s    1s    0s    1s    0s    1s    0s    1s    1s
1.000001000031000e+00    1s    0s    Us    1s    0s    1s    Us    1s    Us    1s    Us
1.000001000101000e+00    1s    0s    1s    1s    0s    1s    1s    1s    1s    1s    0s
1.000002000031000e+00    1s    0s    1s    Us    0s    1s    1s    Us    1s    Us    0s
1.000002000101000e+00    1s    0s    1s    0s    0s    1s    1s    0s    1s    0s    0s
2.000000000031000e+00    Us    Us    1s    0s    0s    1s    1s    0s    1s    0s    0s
2.000000000101000e+00    0s    1s    1s    0s    0s    1s    1s    0s    1s    0s    0s
2.000001000031000e+00    0s    1s    1s    Us    Us    1s    1s    Us    1s    Us    0s
2.000001000101000e+00    0s    1s    1s    1s    Us    1s    1s    Us    1s    Us    0s
2.000002000031000e+00    0s    1s    Us    1s    Us    1s    1s    Us    1s    Us    Us
2.000002000101000e+00    0s    1s    0s    1s    0s    1s    1s    0s    1s    0s    1s
3.000000000031000e+00    Us    1s    0s    1s    0s    1s    1s    0s    1s    0s    1s
3.000000000101000e+00    1s    1s    0s    1s    0s    1s    1s    0s    1s    0s    1s
3.000001000031000e+00    1s    1s    Us    1s    Us    1s    1s    0s    1s    Us    1s
3.000001000101000e+00    1s    1s    1s    1s    1s    1s    1s    0s    1s    1s    1s
3.000002000031000e+00    1s    1s    1s    Us    1s    Us    1s    0s    Us    1s    1s
3.000002000101000e+00    1s    1s    1s    0s    1s    0s    1s    0s    0s    1s    1s
`;

const TRAN_DECK = [
  'digital tran',
  'v1 1 0 DC 0 PWL(0 0 1u 0 1.001u 1 1.5u 1 1.501u 0 4u 0 4.001u 1 7u 1 7.001u 0)',
  'v2 2 0 DC 0 PWL(0 0 2u 0 2.001u 1 6u 1 6.001u 0)',
  'r1 1 0 1k', 'r2 2 0 1k',
  'a1 [1 2] [a b] adc',
  '.model adc adc_bridge (rise_delay=1n fall_delay=1n)',
  'a2 a pin buf_inertial',
  '.model buf_inertial d_buffer (rise_delay=1u fall_delay=1u inertial_delay=true)',
  'a3 a ptr buf_transport',
  '.model buf_transport d_buffer (rise_delay=1u fall_delay=1u)',
  'a4 a x drv', 'a5 b x drv',
  '.model drv d_buffer (rise_delay=10n fall_delay=10n)',
  'a6 [a b] y xo',
  '.model xo d_xor (rise_delay=20n fall_delay=30n inertial_delay=true)',
  'v3 3 0 DC 0 PWL(0 0 10u 1)',
  'a7 [3] [m0 m1] adcm',
  '.model adcm adc_bridge (in_low=0 in_high=1 rise_delay=5n fall_delay=5n)',
  'a8 [m0 m1] [20] dacm',
  '.model dacm dac_bridge (out_low=0 out_high=3 t_rise=200n t_fall=100n)',
  'r20 20 0 1k',
  'a9 [pin ptr x] [30 31 32] dac',
  '.model dac dac_bridge (t_rise=50n t_fall=50n)',
  'r30 30 0 1k', 'r31 31 0 1k', 'r32 32 0 1k',
  '.tran 10n 10u', '.end',
].join('\n');

// ngspice-47: eprint a b pin ptr x y m0 m1 (set numdgt=15)
const TRAN_NODES = ['a', 'b', 'pin', 'ptr', 'x', 'y', 'm0', 'm1'];
const TRAN_EPRINT = `
0.000000000000000e+00    0s    0s    0s    0s    0s    0s    0s    0s
1.001300000000000e-06    Us    0s    0s    0s    0s    0s    0s    0s
1.002000000000000e-06    1s    0s    0s    0s    0s    0s    0s    0s
1.011300000000000e-06    1s    0s    0s    0s    Us    0s    0s    0s
1.012000000000000e-06    1s    0s    0s    0s    Us    0s    0s    0s
1.022000000000000e-06    1s    0s    0s    0s    Us    1s    0s    0s
1.501100000000000e-06    Us    0s    0s    0s    Us    1s    0s    0s
1.502000000000000e-06    0s    0s    0s    0s    Us    1s    0s    0s
1.511100000000000e-06    0s    0s    0s    0s    Us    1s    0s    0s
1.512000000000000e-06    0s    0s    0s    0s    0s    1s    0s    0s
1.532000000000000e-06    0s    0s    0s    0s    0s    0s    0s    0s
2.001300000000000e-06    0s    Us    0s    Us    0s    0s    0s    0s
2.002000000000000e-06    0s    1s    0s    Us    0s    0s    0s    0s
2.002000000000000e-06    0s    1s    0s    1s    0s    0s    0s    0s
2.011300000000000e-06    0s    1s    0s    1s    Us    0s    0s    0s
2.012000000000000e-06    0s    1s    0s    1s    Us    0s    0s    0s
2.021999999999999e-06    0s    1s    0s    1s    Us    1s    0s    0s
2.501100000000000e-06    0s    1s    0s    Us    Us    1s    0s    0s
2.502000000000000e-06    0s    1s    0s    0s    Us    1s    0s    0s
2.505062559999992e-06    0s    1s    0s    0s    Us    1s    0s    1s
4.001100000000000e-06    Us    1s    0s    0s    Us    1s    0s    1s
4.002000000000000e-06    1s    1s    0s    0s    Us    1s    0s    1s
4.011100000000000e-06    1s    1s    0s    0s    Us    1s    0s    1s
4.012000000000000e-06    1s    1s    0s    0s    1s    1s    0s    1s
4.032000000000000e-06    1s    1s    0s    0s    1s    0s    0s    1s
5.001099999999999e-06    1s    1s    0s    Us    1s    0s    0s    1s
5.002000000000000e-06    1s    1s    1s    1s    1s    0s    0s    1s
5.006099999999999e-06    1s    1s    1s    1s    1s    0s    1s    0s
6.001100000000000e-06    1s    Us    1s    1s    1s    0s    1s    0s
6.002000000000000e-06    1s    0s    1s    1s    1s    0s    1s    0s
6.011100000000000e-06    1s    0s    1s    1s    Us    0s    1s    0s
6.012000000000000e-06    1s    0s    1s    1s    Us    0s    1s    0s
6.022000000000000e-06    1s    0s    1s    1s    Us    1s    1s    0s
7.001100000000000e-06    Us    0s    1s    1s    Us    1s    1s    0s
7.002000000000000e-06    0s    0s    1s    1s    Us    1s    1s    0s
7.011100000000000e-06    0s    0s    1s    1s    Us    1s    1s    0s
7.012000000000000e-06    0s    0s    1s    1s    0s    1s    1s    0s
7.032000000000000e-06    0s    0s    1s    1s    0s    0s    1s    0s
7.510439999999992e-06    0s    0s    1s    1s    0s    0s    1s    1s
8.001100000000000e-06    0s    0s    1s    Us    0s    0s    1s    1s
8.002000000000001e-06    0s    0s    0s    0s    0s    0s    1s    1s
`;

// ngspice-47 wrdata v(20) v(30) v(31) v(32): dac_bridge outputs at ngspice timepoints on their ramps.
const TRAN_DAC_ROWS: readonly (readonly [number, number, number, number, number])[] = [
  [1.012196e-06, 0.0, 0.0, 0.0, 0.01792000000000338],
  [1.034740000000001e-06, 0.0, 0.0, 0.0, 0.4688000000000191],
  [1.525440000000001e-06, 0.0, 0.0, 0.0, 0.2311999999999789],
  [2.001496e-06, 0.0, 0.0, 0.003919999999998093, 0.0],
  [2.0021344e-06, 0.0, 0.0, 0.01668800000000664, 0.0],
  [2.004822399999999e-06, 0.0, 0.0, 0.07044799999999136, 0.0],
  [2.013020319999999e-06, 0.0, 0.0, 0.2344063999999883, 0.03440639999999023],
  [2.027217504e-06, 0.0, 0.0, 0.5183500800000002, 0.3183500800000021],
  [2.050062559999997e-06, 0.0, 0.0, 0.9752511999999406, 0.5],
  [2.5027e-06, 0.0, 0.0, 0.9680000000000061, 0.5],
  [2.505542559999993e-06, 0.007200000000001811, 0.0, 0.9111488000001583, 0.5],
  [2.515142559999992e-06, 0.1511999999999999, 0.0, 0.7191488000001608, 0.5],
  [2.529100000000001e-06, 0.3605616000001266, 0.0, 0.4399999999999918, 0.5],
  [4.012896e-06, 0.75, 0.0, 0.0, 0.5179200000000034],
  [4.035439999999996e-06, 0.75, 0.0, 0.0, 0.9687999999999302],
  [5.0027e-06, 0.75, 0.01399999999999682, 0.03200000000000241, 1.0],
  [5.00642e-06, 0.7548000000000055, 0.08840000000000071, 0.1064000000000063, 1.0],
  [5.01602e-06, 0.8988000000000036, 0.2803999999999982, 0.2984000000000038, 1.0],
  [5.029099999999999e-06, 1.095000000000007, 0.5420000000000026, 0.5600000000000083, 1.0],
  [6.011996e-06, 1.5, 1.0, 1.0, 0.9820799999999966],
  [6.034539999999996e-06, 1.5, 1.0, 1.0, 0.5312000000000698],
  [7.025439999999997e-06, 1.5, 1.0, 1.0, 0.2312000000000679],
  [7.517439999999992e-06, 1.605000000000001, 1.0, 1.0, 0.0],
  [7.555439999999991e-06, 2.174999999999994, 1.0, 1.0, 0.0],
];

describe('XSPICE event-driven digital models against ngspice-47 (#553 slice 3)', () => {
  it('reproduces every gate output change of d_buffer, d_inverter, d_and, d_nand, d_or, d_nor, d_xor and d_xnor', async () => {
    const transient = (await simulate(GATES_DECK)).transient!;
    const expected = eprintChanges(GATES_NODES, GATES_EPRINT);
    for (const node of GATES_NODES) expectHistory(transient.digital(node), expected.get(node)!, node);
    // ngspice-47 takes 510 timepoints on this deck.
    expect(transient.time.length).toBe(510);
  });

  it('applies inertial delay, multi-driver resolution, multi-bit bridges and dac_bridge ramps', async () => {
    const transient = (await simulate(TRAN_DECK)).transient!;
    const expected = eprintChanges(TRAN_NODES, TRAN_EPRINT);
    for (const node of TRAN_NODES) expectHistory(transient.digital(node), expected.get(node)!, node);
    const nodes = ['20', '30', '31', '32'];
    for (const [time, ...values] of TRAN_DAC_ROWS) {
      nodes.forEach((node, i) => {
        expect(interpolate(transient.time, transient.voltage(node), time), `v(${node}) at ${time}`)
          .toBeCloseTo(values[i], 9);
      });
    }
  });

  it('solves the event/analog operating point with inverted ports, out_undef and multi-bit bridges', async () => {
    const { dc } = await simulate([
      'digital op',
      'v1 1 0 DC 0.8', 'v2 2 0 DC 0.05', 'v3 3 0 DC 0.5', 'r1 1 0 1k',
      'a1 [1 2 3] [d1 d2 d3] adc',
      '.model adc adc_bridge (in_low=0.1 in_high=0.7)',
      'a2 d1 ~d4 inv', '.model inv d_inverter',
      'a3 [d1 ~d2] d5 nand', '.model nand d_nand',
      'a4 [d1 d2 d3 d4 d5] [10 20 30 40 50] dac',
      '.model dac dac_bridge (out_low=-1 out_high=2)',
      'v4 4 0 DC 0.6',
      'a5 [4] [m0 m1 m2] adcm', '.model adcm adc_bridge (in_low=0 in_high=1)',
      'a6 [m0 m1 m2] [60] dacm', '.model dacm dac_bridge (out_low=0 out_high=8 out_undef=3)',
      'r10 10 0 1k', 'r20 20 0 1k', 'r30 30 0 1k', 'r40 40 0 1k', 'r50 50 0 1k', 'r60 60 0 1k',
      '.op', '.end',
    ].join('\n'));
    // ngspice-47: v(10)=2 v(20)=-1 v(30)=0.5 v(40)=2 v(50)=-1 v(60)=4
    // (eprint DCOP: d1=1s d2=0s d3=Us d4=1s d5=0s m0=1s m1=0s m2=0s).
    const expected: Record<string, number> = { 10: 2, 20: -1, 30: 0.5, 40: 2, 50: -1, 60: 4 };
    for (const [node, value] of Object.entries(expected)) expect(dc!.voltage(node)).toBeCloseTo(value, 12);
  });

  it('resolves digital() node names case-insensitively like ngspice eprint', async () => {
    const transient = (await simulate([
      'digital case', 'v1 1 0 PULSE(0 1 1n 1n 1n 5n 20n)', 'r1 1 0 1k',
      'a1 [1] [DIN] adc', '.model adc adc_bridge (in_low=0.3 in_high=0.7)',
      'a2 din DOUT inv', '.model inv d_inverter',
      '.tran 1n 10n', '.end',
    ].join('\n'))).transient!;
    expect([...transient.digitalNodes.keys()]).toEqual(['DIN', 'DOUT']);
    expect(transient.digital('Dout').length).toBeGreaterThan(1);
    expect(transient.digital('din')).toEqual(transient.digital('DIN'));
    expect(transient.digital('Dout')).toEqual(transient.digital('DOUT'));
    expect(() => transient.digital('nope')).toThrow(/Unknown digital node/);
  });

  it('keeps the other digital code models typed-unsupported', async () => {
    await expect(simulate([
      'dff', 'v1 1 0 1', 'a1 [1] [d] adc', '.model adc adc_bridge',
      'a2 d d d null q nq ff', '.model ff d_dlatch', '.tran 1n 10n', '.end',
    ].join('\n'))).rejects.toThrow(UnsupportedCodeModelError);
  });

  it('inserts default bridges for digital outputs and analog-driven digital inputs', async () => {
    const { transient } = await simulate([
      'implicit bridges', 'v1 hi 0 2', 'v2 low 0 1', 'v3 mid 0 1.65',
      'a1 HI dh sense', 'a3 low dl sense', 'a4 mid dm sense', '.model sense d_buffer',
      'a2 out pull', '.model pull d_pullup', 'r1 OUT 0 1k', '.tran 1n 5n', '.end',
    ].join('\n'));
    // ngspice-47 evtcheck_nodes.c defaults: VCC=3.3, ADC threshold=VCC/2.
    expect(transient!.voltage('OUT')[0]).toBeCloseTo(3.3, 12);
    expect(transient!.digital('dh')[0].state).toBe('1');
    expect(transient!.digital('dl')[0].state).toBe('0');
    expect(transient!.digital('dm')[0].state).toBe('1');
  });

  it('uses global VCC for thresholds and DAC rails, preserves transition defaults and avoids name collisions', async () => {
    const { transient } = await simulate([
      'implicit transient', '.param vcc=5',
      'v1 in 0 PULSE(0 5 2n 1n 1n 5n 20n)',
      'a1 in out buf', '.model buf d_buffer', 'r1 out 0 1k',
      'v2 threshold 0 2', 'a2 threshold below buf',
      'auto_bridge0 spare pull', '.model pull d_pulldown',
      '.tran .1n 18n 0 .1n', '.end',
    ].join('\n'));
    // ngspice-47: initial low; threshold crossing 2.5 ns + ADC delay 1 ns
    // + buffer delay 1 ns + default DAC rise 1 ns. Falling settles at 11.5 ns.
    expect(interpolate(transient!.time, transient!.voltage('out'), 1e-9)).toBeCloseTo(0, 10);
    expect(interpolate(transient!.time, transient!.voltage('out'), 8e-9)).toBeCloseTo(5, 10);
    expect(interpolate(transient!.time, transient!.voltage('out'), 16e-9)).toBeCloseTo(0, 10);
    expect(transient!.digital('out').map(event => event.state)).toEqual(['0', '1', '0']);
    expect(transient!.digital('below')[0].state).toBe('0');
  });

  it('loads a bidirectional mixed node electrically rather than applying an ideal DAC', async () => {
    const { transient } = await simulate([
      'bidi', 'a1 shared pull', '.model pull d_pullup',
      'a2 shared out buf', '.model buf d_buffer', 'r1 shared 0 1k', '.tran .1n 20n', '.end',
    ].join('\n'));
    // ngspice-47, identical deck: resistive pull-up through the bidi default
    // r_high=10k, loaded by 1k. v(shared)=0.3 V, shared/out both 0s.
    expect(interpolate(transient!.time, transient!.voltage('shared'), 20e-9)).toBeCloseTo(0.3, 9);
    expect(transient!.digital('shared').at(-1)?.state).toBe('0');
    expect(transient!.digital('out').at(-1)?.state).toBe('0');
  });

  it('keeps family-specific automatic bridges rejected', async () => {
    await expect(simulate([
      'custom family', 'v1 in 0 3.3', 'a1 in out buf',
      '.model buf d_buffer(family="custom")', '.op', '.end',
    ].join('\n'))).rejects.toThrow(/family-specific.*bridge/);
  });

  it('initializes UIC events from the zero analog seed, not a solved DC operating point', async () => {
    const { transient } = await simulate([
      'UIC event seed', 'v1 in 0 2', 'r1 in 0 1k',
      'a1 [in] [d] adc',
      '.model adc adc_bridge(in_low=0.3 in_high=0.7 rise_delay=1n fall_delay=1n)',
      'a2 d q inv', '.model inv d_inverter(rise_delay=2n fall_delay=2n)',
      'a3 [d q] [out invout] dac',
      '.model dac dac_bridge(out_low=0 out_high=1 t_rise=1n t_fall=1n)',
      'r2 out 0 1k', 'r3 invout 0 1k', '.ic v(in)=0',
      '.tran .1n 8n uic', '.end',
    ].join('\n'));
    // ngspice-47 EVTop runs with MODETRANOP|MODEUIC: NIiter loads the
    // analog seed without solving. eprint: d=0s/q=1s at zero, then d=1s
    // at 1.0008 ns and q=0s at 3.0008 ns (first analog step + delays).
    // UIC omits the unsolved analog t=0 row, but retains digital t=0 history.
    expect(transient!.time[0]).toBeGreaterThan(0);
    expect(transient!.voltage('in')[0]).toBeCloseTo(2, 12);
    expectHistory(transient!.digital('d'), [[0, '0s'], [1.0008e-9, '1s']], 'd');
    expectHistory(transient!.digital('q'), [[0, '1s'], [3.0008e-9, '0s']], 'q');
    expect(interpolate(transient!.time, transient!.voltage('out'), 6e-9)).toBeCloseTo(1, 10);
    expect(interpolate(transient!.time, transient!.voltage('invout'), 6e-9)).toBeCloseTo(0, 10);
  });

  it('reinitializes UIC hybrid event state on a transient driver reset', async () => {
    const sim = await createTransientSim([
      'UIC reset', 'v1 in 0 2', '.ic v(in)=0',
      'a1 [in] [d] adc', '.model adc adc_bridge(in_low=0.3 in_high=0.7)',
      'a2 [d] [out] dac', '.model dac dac_bridge(out_low=0 out_high=1)',
      'r1 out 0 1k', '.tran .1n 8n uic', '.end',
    ].join('\n'));
    try {
      const collect = () => sim.advanceUntil(8e-9).map(step => [step.time, step.voltages.get('out')]);
      const first = collect();
      expect(first.at(-1)![1]).toBeCloseTo(1, 10);
      sim.reset();
      expect(collect()).toEqual(first);
    } finally {
      sim.dispose();
    }
  });

  it('rejects analyses other than .op/.tran/.ac', async () => {
    const base = ['v1 1 0 1', 'r1 1 0 1k', 'a1 [1] [d] adc', '.model adc adc_bridge'];
    await expect(simulate(['noise', ...base, '.noise v(1) v1 dec 1 1 10', '.end'].join('\n')))
      .rejects.toThrow(/supported in \.op, \.tran and \.ac only, not \.noise/);
  });
});
