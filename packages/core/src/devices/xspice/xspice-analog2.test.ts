import { describe, expect, it } from 'vitest';
import { parse } from '../../parser/index.js';
import { InvalidCircuitError } from '../../errors.js';
import { simulate } from '../../simulate.js';
import { smoothDiscontinuity } from './limiter-models.js';

/*
 * Issue #553 slice 2: climit, ilimit (%g ports), hyst, slew, sine and the
 * xtradev cmeter/lmeter. Reference values come from ngspice-47 (Homebrew
 * build) on the same cards with `.control / set numdgt=12 / op|dc|ac|tran /
 * print|meas`; the decks are under benchmarks/xspice-553/.
 */

const OP_DECK = [
  'xspice analog slice 2 op',
  'v1 1 0 DC 1.0', 'v2 2 0 DC 10.0', 'v3 3 0 DC -10.0', 'v4 4 0 DC 0.55', 'v5 5 0 DC 1.3',
  'a1 1 10 hyst1',
  '.model hyst1 hyst (in_low=0.0 in_high=1.0 hyst=0.1 out_lower_limit=0.0 out_upper_limit=1.0 input_domain=0.01 fraction=TRUE)',
  'a11 4 11 hyst2',
  '.model hyst2 hyst (in_low=-1 in_high=2 hyst=0.3 out_lower_limit=-2 out_upper_limit=3 input_domain=0.05 fraction=FALSE)',
  'a12 5 12 hyst2',
  'a3 1 2 3 30 ilimit1',
  '.model ilimit1 ilimit (in_offset=0.0 gain=1.0 r_out_source=1.0 r_out_sink=1.0 i_limit_source=1.0 i_limit_sink=1.0',
  '+ v_pwr_range=1.0e-3 i_source_range=1.0e-3 i_sink_range=1.0e-3 r_out_domain=1.0e-3)',
  'a31 5 2 3 31 ilimit2',
  '.model ilimit2 ilimit (gain=4.0 r_out_source=2.0 r_out_sink=2.0 i_limit_source=5.0e-3 i_limit_sink=2e-3',
  '+ v_pwr_range=1.0e-2 i_source_range=1.0e-4 i_sink_range=1.0e-4 r_out_domain=1.0e-2)',
  'a32 4 null 3 32 ilimit2',
  'a4 1 2 3 40 climit1',
  '.model climit1 climit (in_offset=0.0 gain=1.0 upper_delta=0.0 lower_delta=0.0 limit_range=1.0e-6 fraction=FALSE)',
  'a41 5 4 3 41 climit2',
  '.model climit2 climit (in_offset=0.1 gain=2.0 upper_delta=0.2 lower_delta=0.1 limit_range=0.5 fraction=FALSE)',
  'a42 4 1 3 42 climit3',
  '.model climit3 climit (gain=2.0 upper_delta=0.0 lower_delta=0.0 limit_range=0.1 fraction=TRUE)',
  'c5 51 0 1.0e-6', 'c52 51 53 2.5e-6', 'vz 51 54 0', 'c54 54 0 4e-7', 'r53 53 0 1k', 'r54 54 0 1k',
  'a5 51 50 cmeter1', '.model cmeter1 cmeter (gain=2.0)',
  'l6 61 0 1.0e-6', 'l62 61 62 3.0e-6', 'r62 62 0 1',
  'a6 61 60 lmeter1', '.model lmeter1 lmeter (gain=1.0)',
  'a7 5 70 slew1', '.model slew1 slew (rise_slope=1e3 fall_slope=1e3)',
  'r1 1 0 10k', 'r2 2 0 10k', 'r3 3 0 10k', 'r10 10 0 10k', 'r11 11 0 10k', 'r12 12 0 10k',
  'r30 30 0 10k', 'r31 31 0 1k', 'r32 32 0 1k', 'r40 40 0 10k', 'r41 41 0 10k', 'r42 42 0 10k',
  'r50 50 0 10k', 'r51 51 0 10k', 'r60 60 0 10k', 'r61 61 0 10k', 'r70 70 0 10k',
  '.op', '.end',
].join('\n');

const LIMITERS = [
  'v2 2 0 DC 10.0', 'v3 3 0 DC -10.0',
  'a1 1 10 hyst1',
  '.model hyst1 hyst (in_low=0.0 in_high=1.0 hyst=0.1 out_lower_limit=0.0 out_upper_limit=1.0 input_domain=0.01 fraction=TRUE)',
  'a2 1 4 3 20 climit2',
  '.model climit2 climit (in_offset=0.1 gain=2.0 upper_delta=0.2 lower_delta=0.1 limit_range=0.2 fraction=FALSE)',
  'a4 1 40 slew1', '.model slew1 slew (rise_slope=1 fall_slope=1)',
  'r1 1 0 10k', 'r4 4 0 10k', 'r10 10 0 10k', 'r20 20 0 10k', 'r30 30 0 1k', 'r40 40 0 10k',
];

describe('XSPICE slice 2 code models against ngspice-47', () => {
  it('matches the operating point of hyst, ilimit (%g ports, null pos_pwr), climit, cmeter, lmeter and slew', async () => {
    const dc = (await simulate(OP_DECK)).dc!;
    const voltages: Record<string, number> = {
      10: 0.9, 11: 0.08333333333333, 12: 1.333333333333, 30: 0.999900009999, 31: 5.0, 32: 2.195608782435,
      40: 1.0, 41: 0.35, 42: 0.7727272727273, 50: 7.8e-6, 60: 7.5e-7, 70: 1.3,
    };
    for (const [node, value] of Object.entries(voltages)) {
      expect(dc.voltage(node)).toBeCloseTo(value, 10);
    }
    // ngspice: v2#branch = -6.00249950007e-03 (ilimit supply current), v3#branch = 1.0e-03
    expect(dc.current('v2')).toBeCloseTo(-6.00249950007e-3, 13);
    expect(dc.current('v3')).toBeCloseTo(1.0e-3, 13);
    expect(dc.current('a5#branch_1_0')).toBeCloseTo(-7.8e-10, 18);
  });

  it('carries the hyst leg across a downward DC sweep and limits through climit, ilimit and slew', async () => {
    const result = await simulate([
      'xspice dc down', 'v1 1 0 DC 2', 'v4 4 0 DC 0.5', ...LIMITERS,
      'a3 1 2 3 30 ilimit1',
      '.model ilimit1 ilimit (gain=3.0 r_out_source=1.0 r_out_sink=1.0 i_limit_source=1e-3 i_limit_sink=1.5e-3',
      '+ v_pwr_range=1e-3 i_source_range=1e-5 i_sink_range=1e-5 r_out_domain=1e-3)',
      '.dc v1 2 -1 -0.125', '.end',
    ].join('\n'));
    const sweep = result.dcSweep!;
    // ngspice-47 rows 0..24 (v1 = 2 .. -1 step -0.125)
    const hyst = [1, 1, 1, 1, 1, 1, 1, 1, 1, 0.975, 0.85, 0.725, 0.6, 0.475, 0.35, 0.225, 0.1, 0, 0, 0, 0, 0, 0, 0, 0];
    const climit = [...Array<number>(15).fill(0.3), 0.2968750000001, 0.1875, -0.05, -0.3, -0.55, -0.8, -1.05, -1.3, -1.55, -1.8];
    const ilimit = [
      ...Array<number>(14).fill(1), 0.7492507492507, 0.3746253746254, 0, -0.3746253746254, -0.7492507492507,
      -1.123876123876, -1.49849836114, -1.5, -1.5, -1.5, -1.5,
    ];
    expect(sweep.voltage('10')).toHaveLength(25);
    for (let i = 0; i < 25; i++) {
      expect(sweep.voltage('10')[i]).toBeCloseTo(hyst[i], 10);
      expect(sweep.voltage('20')[i]).toBeCloseTo(climit[i], 10);
      // Row 20 sits in the sink smoothing corner, where both engines stop Newton on reltol.
      expect(sweep.voltage('30')[i]).toBeCloseTo(ilimit[i], i === 20 ? 5 : 10);
      expect(sweep.voltage('40')[i]).toBeCloseTo(2 - 0.125 * i, 10);
    }
  });

  it('matches the AC gains: hyst slope, climit smoothing partials, ilimit supply current, slew 1, sine 0', async () => {
    const result = await simulate([
      'xspice ac', 'v1 1 0 DC 0.5 AC 1', 'v4 4 0 DC 1.25 AC 0.5', ...LIMITERS.map(line => line.replace(
        'out_upper_limit=1.0 input_domain', 'out_upper_limit=2.0 input_domain',
      )),
      'a3 1 2 3 30 ilimit1',
      '.model ilimit1 ilimit (gain=3.0 r_out_source=1.0 r_out_sink=1.0 i_limit_source=1e-2 i_limit_sink=1.5e-2',
      '+ v_pwr_range=1e-3 i_source_range=1e-5 i_sink_range=1e-5 r_out_domain=1e-3)',
      'a5 1 50 sine1', '.model sine1 sine (cntl_array=[0 1] freq_array=[1k 2k] out_low=-1 out_high=1)', 'r50 50 0 10k',
      '.ac dec 1 10 1k', '.end',
    ].join('\n'));
    const ac = result.ac!;
    const reference: Record<string, number> = { 10: 2, 20: 0.75, 30: 2.997002997003, 40: 1, 50: 0 };
    for (const [node, value] of Object.entries(reference)) {
      for (const point of ac.voltage(node)) {
        expect(point.magnitude).toBeCloseTo(value, 10);
        if (value !== 0) expect(Math.abs(Math.sin((point.phase * Math.PI) / 180))).toBeLessThan(1e-12);
      }
    }
    for (const point of ac.current('v2')) expect(point.magnitude).toBeCloseTo(2.997002997e-3, 12);
  });

  it('matches hyst, slew and a constant-control sine in a transient (ngspice meas at the same times)', async () => {
    const result = await simulate([
      'xspice tran',
      'v1 1 0 DC 0 SIN(0.5 1 1k)', 'v3 3 0 DC 0 PULSE(0 1 0.2m 1u 1u 0.3m 1m)', 'v4 4 0 DC 5',
      'a1 1 10 hyst1',
      '.model hyst1 hyst (in_low=0.0 in_high=1.0 hyst=0.2 out_lower_limit=-1.0 out_upper_limit=1.0 input_domain=0.05 fraction=TRUE)',
      'a2 3 20 slew1', '.model slew1 slew (rise_slope=5e3 fall_slope=2e3)',
      'a6 4 60 sine1',
      '.model sine1 sine (cntl_array=[-1.0 0.0 10.0 20.0] freq_array=[500 500 2000 2000] out_low=-1.0 out_high=1.0)',
      'r1 1 0 10k', 'r3 3 0 10k', 'r4 4 0 10k', 'r10 10 0 10k', 'r20 20 0 10k', 'r60 60 0 10k',
      '.tran 0.01ms 2ms', '.end',
    ].join('\n'));
    const tran = result.transient!;
    const at = (node: string, t: number): number => {
      const v = tran.voltage(node);
      const i = Math.max(1, tran.time.findIndex(x => x >= t));
      const f = (t - tran.time[i - 1]) / (tran.time[i] - tran.time[i - 1]);
      return v[i - 1] + f * (v[i] - v[i - 1]);
    };
    const reference: [string, number, number][] = [
      // hyst: ngspice samples at 0.44885/0.45885 ms are on the falling leg after the input peak
      // (the rising leg would give 0.23/0.11 there).
      ['10', 0.1e-3, 0.775109], ['10', 0.3e-3, 1], ['10', 4.4885e-4, 0.988358857644], ['10', 4.5885e-4, 0.9110411295711],
      ['10', 0.7e-3, -1], ['10', 1.3e-3, 1],
      ['20', 0.25e-3, 0.25], ['20', 0.35e-3, 0.75], ['20', 0.55e-3, 0.902], ['20', 0.8e-3, 0.402],
      ['60', 0.1e-3, 0.706672], ['60', 0.37e-3, 0.233378], ['60', 0.9e-3, 0.707074], ['60', 1.55e-3, -0.382667],
    ];
    for (const [node, t, value] of reference) {
      expect(Math.abs(at(node, t) - value)).toBeLessThan(2e-3 * Math.max(Math.abs(value), 0.1));
    }
  });
});

describe('XSPICE slice 2 regressions found in review against ngspice-47', () => {
  it('keeps the hyst leg the operating point converged on into the transient', async () => {
    // INIT runs on the OP's first iteration (input 0 > x_rise_zero), so the leg is
    // X_FALLING; -1.5 V sits on the falling leg's linear part. ngspice-47: op and
    // every tran point v(2) = 0.6 (the rising leg would give 0.4).
    const result = await simulate([
      'hyst leg after OP when INIT leg is falling',
      'V1 1 0 -1.5', 'a1 1 2 hy', 'R2 2 0 1k',
      '.model hy hyst(in_low=-2 in_high=-1 hyst=0.1 out_lower_limit=0 out_upper_limit=1 input_domain=0.01 fraction=TRUE)',
      '.op', '.tran 1u 5u', '.end',
    ].join('\n'));
    expect(result.dc!.voltage('2')).toBeCloseTo(0.6, 10);
    const v2 = result.transient!.voltage('2');
    expect(v2.length).toBeGreaterThan(2);
    for (const value of v2) expect(value).toBeCloseTo(0.6, 10);
  });

  it('cmeter and lmeter read the instance value without m, as cmmeters.c reads CAPcapac/INDinduct', async () => {
    const dc = (await simulate([
      'meters ignore instance m',
      'V1 1 0 0.3', 'C1 1 0 2p m=3', 'C2 1 5 1p', 'R5 5 0 1k', 'Vz 1 4 0', 'C3 4 0 4p',
      'L1 1 6 1u m=2', 'R6 6 0 1k', 'L2 4 7 2u', 'R7 7 0 1k',
      'a1 1 10 cm', 'a2 1 11 lm', 'R10 10 0 1k', 'R11 11 0 1k',
      '.model cm cmeter(gain=1e12)', '.model lm lmeter(gain=1e6)',
      '.op', '.end',
    ].join('\n'))).dc!;
    // ngspice-47: v(10) = 7.0 (2p + 1p + 4p), v(11) = 0.666666666667 (1u || 2u)
    expect(dc.voltage('10')).toBeCloseTo(7.0, 9);
    expect(dc.voltage('11')).toBeCloseTo(0.666666666667, 11);
  });
});

describe('XSPICE slice 2 parsing and typed rejections', () => {
  it('reads %g/%gd ports and the ilimit null power ports', async () => {
    const dc = (await simulate([
      'gd ports', 'v1 1 0 DC 0.5', 'v2 2 0 DC 5', 'r1 1 0 1k',
      'a1 1 %gd (2 0) null %gd (30 0) ilim', '.model ilim ilimit (gain=2 i_limit_source=1 i_limit_sink=1)',
      'r30 30 0 1k', '.op', '.end',
    ].join('\n'))).dc!;
    expect(dc.voltage('30')).toBeCloseTo(1 * 1000 / 1001, 9);
  });

  it('recognizes filesource and requires a host file resolver', () => {
    expect(() => parse(['x', 'a1 [out] s1', '.model s1 filesource', '.op'].join('\n')).compile())
      .toThrow(/file requires host-resolved file data/);
  });

  it('rejects port types a model does not allow', () => {
    expect(() => parse([
      'x', 'v1 1 0 1', 'a1 %i 1 2 cm', '.model cm cmeter (gain=1)', 'r2 2 0 1k', '.op', '.end',
    ].join('\n')).compile()).toThrow(InvalidCircuitError);
  });
});

describe('cm_smooth_discontinuity', () => {
  it('steps smoothly from (x_lower, y_lower) to (x_upper, y_upper)', () => {
    expect(smoothDiscontinuity(-1, 0, 1, 2, 3)).toEqual({ y: 1, dydx: 0 });
    expect(smoothDiscontinuity(1, 0, 1, 2, 3).y).toBeCloseTo(2, 14);
    expect(smoothDiscontinuity(1, 0, 1, 2, 3).dydx).toBeCloseTo(2, 14);
    expect(smoothDiscontinuity(3, 0, 1, 2, 3)).toEqual({ y: 3, dydx: 0 });
  });
});
