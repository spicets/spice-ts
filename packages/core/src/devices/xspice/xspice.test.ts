import { describe, expect, it } from 'vitest';
import { parse } from '../../parser/index.js';
import { InvalidCircuitError, ParseError } from '../../errors.js';
import { simulate } from '../../simulate.js';
import {
  parseXspiceInstance,
  parseXspiceModelCard,
  tokenizeXspice,
  UnsupportedCodeModelError,
} from '../../parser/xspice-parser.js';
import { smoothCorner } from './models.js';

/*
 * Reference values come from ngspice-47 (Homebrew build, KLU) run on the same
 * cards with `.control / set numdgt=12 / op|dc|ac|tran / print|meas`.
 */

const opDeck = (body: string[]): string => ['xspice op', ...body, '.op', '.end'].join('\n');

describe('XSPICE A-card and .model parsing', () => {
  it('tokenizes like ngspice MIFget_token', () => {
    expect(tokenizeXspice('a1 [1 2] %vd(in 0) ~x null "q r"').map(t => `${t.kind}:${t.text}`)).toEqual([
      'string:a1', 'larray:[', 'string:1', 'string:2', 'rarray:]', 'percent:%', 'string:vd',
      'string:in', 'string:0', 'tilde:~', 'string:x', 'null:null', 'string:q r',
    ]);
  });

  it('keeps the connection tokens and the trailing model name of an A-card', () => {
    const card = parseXspiceInstance('a2 [1 2] 20 summer1', 4);
    expect(card.name).toBe('a2');
    expect(card.modelName).toBe('summer1');
    expect(card.connectionTokens.map(token => token.text)).toEqual(['[', '1', '2', ']', '20']);
  });

  it('parses vector, boolean and real values with the code model parameter table', () => {
    const model = parseXspiceModelCard(
      '.model pwl1 pwl (x_array=[-1.0 0.0 1.0] y_array=[0 1 4] input_domain=0.01 fraction=TRUE limit=f)',
      1,
    );
    expect(model.codeModel).toBe('pwl');
    expect(model.params.get('x_array')).toEqual([-1, 0, 1]);
    expect(model.params.get('y_array')).toEqual([0, 1, 4]);
    expect(model.params.get('fraction')).toEqual([true]);
    expect(model.params.get('limit')).toEqual([false]);
    expect(model.warnings).toEqual([]);
  });

  it('ignores unknown parameters with the ngspice MIF warning (bad_param.deck)', () => {
    const model = parseXspiceModelCard('.model gain_block gain (this_parameter_doesnt_exist=2 gain=10)', 1);
    expect(model.params.get('gain')).toEqual([10]);
    expect(model.warnings).toEqual([
      'MIF: unrecognized parameter (this_parameter_doesnt_exist) - ignored',
      'MIF: unrecognized parameter (2) - ignored',
    ]);
  });

  it('clamps values to the parameter limits with a warning', () => {
    const model = parseXspiceModelCard('.model p pwl (x_array=[0 1] y_array=[0 1] input_domain=0.9)', 1);
    expect(model.params.get('input_domain')).toEqual([0.5]);
    expect(model.warnings[0]).toContain("exceeds limit 0.5 for parameter 'input_domain'");
  });

  it('rejects a code model spice-ts does not implement with a typed error', () => {
    let error: unknown;
    try {
      parse(['digital', 'a1 1 2 osc1', '.model osc1 d_process', '.tran 1n 1u'].join('\n'));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UnsupportedCodeModelError);
    expect(error).toBeInstanceOf(ParseError);
    expect((error as UnsupportedCodeModelError).code).toBe('UNSUPPORTED_XSPICE_CODE_MODEL');
    expect((error as UnsupportedCodeModelError).codeModel).toBe('d_process');
  });

  it('rejects malformed values as ParseError', () => {
    expect(() => parseXspiceModelCard('.model s summer (in_gain=1)', 3))
      .toThrow('Array parameter expected - No array delimiter found');
    expect(() => parseXspiceModelCard('.model d divide (fraction=maybe)', 3)).toThrow('Bad boolean value');
  });

  it('round-trips A-cards and XSPICE models through toNetlist()', () => {
    const netlist = parse(opDeck([
      'v1 1 0 2', 'r1 1 0 1k', 'a1 1 10 g1', '.model g1 gain (gain=2.0)', 'r10 10 0 1k',
    ])).toNetlist();
    expect(netlist).toContain('a1 1 10 g1');
    expect(netlist).toContain('.model g1 gain (gain=2.0)');
  });
});

describe('XSPICE compile-time checks', () => {
  const compile = (body: string[]) => parse(opDeck(body)).compile();

  it('rejects an A instance with an unknown or non-XSPICE model', () => {
    expect(() => compile(['v1 1 0 1', 'a1 1 2 nothere', 'r2 2 0 1k'])).toThrow(InvalidCircuitError);
    expect(() => compile(['v1 1 0 1', 'a1 1 2 dmod', 'r2 2 0 1k', '.model dmod d']))
      .toThrow("references model 'dmod', which is not an XSPICE code model");
  });

  it('applies the port table: invalid port types, sizes and missing defaults', () => {
    expect(() => compile(['v1 1 0 1', 'a1 %g 1 2 g1', '.model g1 gain', 'r2 2 0 1k']))
      .toThrow('Port type g is invalid');
    expect(() => compile(['v1 1 0 1', 'a1 [1 1 1] 2 s1', '.model s1 summer (in_gain=[1 2])', 'r2 2 0 1k']))
      .toThrow('does not match connection size');
    expect(() => compile(['v1 1 0 1', 'a1 1 2 l1', '.model l1 limit (gain=2)', 'r2 2 0 1k']))
      .toThrow("Parameter 'out_lower_limit' on model 'l1' has no default.");
    expect(() => compile(['v1 1 0 1', 'a1 1 2 3 g1', '.model g1 gain', 'r2 2 0 1k']))
      .toThrow('Too many connections');
  });

  it('reduces trtol to 1 when A devices are present (ngspice cktdojob.c)', () => {
    expect(compile(['v1 1 0 1', 'a1 1 2 g1', '.model g1 gain', 'r2 2 0 1k']).simulationOptions.trtol).toBe(1);
    expect(parse(opDeck(['v1 1 0 1', 'r2 1 0 1k'])).compile().simulationOptions.trtol).toBeUndefined();
  });

  it('rejects analyses the code models cannot honour', () => {
    expect(() => parse([
      'disto', 'v1 1 0 1 ac 1', 'a1 1 2 g1', '.model g1 gain', 'r2 2 0 1k', '.disto dec 2 1k 10k', '.end',
    ].join('\n')).compile()).toThrow('do not support .disto');
    expect(() => parse([
      'unsupported noise', 'v1 1 0 1 ac 1', 'a1 1 2 g1', '.model g1 s_xfer (num_coeff=[1] den_coeff=[1 1])', 'r2 2 0 1k',
      '.noise v(2) v1 dec 2 1k 10k', '.end',
    ].join('\n')).compile()).toThrow(InvalidCircuitError);
  });
});

describe('XSPICE analog code models against ngspice-47', () => {
  it('matches the analog_models1_dc operating point (gain, summer, mult, divide, pwl)', async () => {
    const result = await simulate(opDeck([
      'v1 1 0 DC 2', 'v2 2 0 DC 2',
      'a1 1 10 gain1', '.model gain1 gain (in_offset=0.0 gain=2.0 out_offset=0.0)',
      'a2 [1 2] 20 summer1',
      '.model summer1 summer (in_offset=[0.0 0.0] in_gain=[1.0 1.0] out_gain=1.0 out_offset=0.0)',
      'a3 [1 1] 30 mult1',
      '.model mult1 mult (in_offset=[0.0 0.0] in_gain=[1.0 1.0] out_gain=0.1 out_offset=0.0)',
      'a4 2 1 40 divide1',
      '.model divide1 divide (num_offset=0.0 num_gain=1.0 den_offset=0.0 den_gain=1.0',
      '+ den_lower_limit=1.0e-10 den_domain=1.0e-16 fraction=false out_gain=1.0 out_offset=0.0)',
      'a5 1 50 pwl1',
      '.model pwl1 pwl (x_array=[-1.0 0.0 1.0 2.0 3.0 4.0 5.0]',
      '+ y_array=[ 0.0 0.0 1.0 4.0 4.5 5.0 5.0] input_domain=0.01 fraction=TRUE)',
      'r1 1 0 1k', 'r2 2 0 1k', 'r3 3 0 1k', 'r10 10 0 1k', 'r20 20 0 1k', 'r30 30 0 1k', 'r40 40 0 1k', 'r50 50 0 1k',
    ]));
    const dc = result.dc!;
    expect(dc.voltage('10')).toBeCloseTo(4.0, 12);
    expect(dc.voltage('20')).toBeCloseTo(4.0, 12);
    expect(dc.voltage('30')).toBeCloseTo(0.4, 12);
    expect(dc.voltage('40')).toBeCloseTo(1.0, 12);
    expect(dc.voltage('50')).toBeCloseTo(3.99375, 12);
    // ngspice: a5#branch_1_0 = -3.99375e-03, a4#branch_2_0 = -1.00000e-03
    expect(dc.current('a5#branch_1_0')).toBeCloseTo(-3.99375e-3, 14);
    expect(dc.current('a4#branch_2_0')).toBeCloseTo(-1e-3, 14);
  });

  it('matches limit regions and %i, %vd and %vnam ports at the operating point', async () => {
    const result = await simulate(opDeck([
      'v1 1 0 DC 0.7', 'v2 2 0 DC 1.9999995', 'v3 3 0 DC -3', 'r1 1 0 1k', 'r3 3 0 1k',
      'a1 1 11 lim1', 'a2 2 12 lim1', 'a3 3 13 lim1',
      '.model lim1 limit (in_offset=0.1 gain=2.0 out_lower_limit=-2 out_upper_limit=4 limit_range=0.5 fraction=false)',
      'r11 11 0 1k', 'r12 12 0 1k', 'r13 13 0 1k',
      'a4 2 14 lim2',
      '.model lim2 limit (gain=2.0 out_lower_limit=-2 out_upper_limit=4 limit_range=0.1 fraction=true)',
      'r14 14 0 1k',
      'rs 1 5 2k', 'a5 %i 5 %v 15 g10',
      '.model g10 gain (gain=10 in_offset=0.001 out_offset=0.5)', 'r15 15 0 1k',
      'a6 1 %i 16 g10', 'r16 16 0 1k',
      'a7 %vd (1 2) %vd (17 18) g10', 'r17 17 0 1k', 'r18 18 0 2k',
      'a8 %vnam v3 19 g10', 'r19 19 0 1k',
    ]));
    const dc = result.dc!;
    const ngspice: Record<string, number> = {
      11: 1.6, 12: 3.954999699999, 13: -2.0, 14: 3.8499995, 15: 0.5135,
      16: -7510, 17: -4.16333166667, 18: 8.326663333333, 19: 0.54, 5: 0,
    };
    for (const [node, value] of Object.entries(ngspice)) {
      expect(dc.voltage(node)).toBeCloseTo(value, 9);
    }
  });

  it('matches a swept DC of pwl (limit=true) and limit', async () => {
    const result = await simulate([
      'xspice dc sweep', 'v1 1 0 DC 0', 'r1 1 0 1k',
      'a1 1 11 pwl1',
      '.model pwl1 pwl (x_array=[0.0 1.0 2.0 4.0] y_array=[0.0 1.0 4.0 5.0] input_domain=0.05 fraction=true limit=true)',
      'r11 11 0 1k',
      'a2 1 12 lim1', '.model lim1 limit (gain=3 out_lower_limit=-1 out_upper_limit=2 limit_range=0.2)',
      'r12 12 0 1k',
      '.dc v1 -1 5 0.25', '.end',
    ].join('\n'));
    const sweep = result.dcSweep!;
    const pwl = sweep.voltage('11');
    const lim = sweep.voltage('12');
    // ngspice-47 rows 0..24 (v1 = -1 .. 5 step 0.25)
    const ngPwl = [0, 0, 0, 0, 0.0125, 0.25, 0.5, 0.75, 1.025, 1.75, 2.5, 3.25, 3.96875, 4.125, 4.25, 4.375,
      4.5, 4.625, 4.75, 4.875, 4.9875, 5, 5, 5, 5];
    const ngLim = [-1, -1, -1, -0.75, 0, 0.75, 1.5, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2];
    expect(pwl).toHaveLength(25);
    for (let i = 0; i < 25; i++) {
      expect(pwl[i]).toBeCloseTo(ngPwl[i], 9);
      expect(lim[i]).toBeCloseTo(ngLim[i], 9);
    }
  });

  it('matches the AC gains of int, d_dt, mult, divide and a differential int input', async () => {
    const result = await simulate([
      'xspice ac', 'v1 1 0 DC 0.5 AC 1', 'r1 1 0 1k', 'v3 3 0 DC 2',
      'a1 1 11 int1',
      '.model int1 int (gain=1000 out_lower_limit=-1e12 out_upper_limit=1e12 limit_range=1e-9 out_ic=0.3)',
      'r11 11 0 1k',
      'a2 1 12 dd1', '.model dd1 d_dt (gain=1e-3 out_lower_limit=-1e12 out_upper_limit=1e12)', 'r12 12 0 1k',
      'a3 [1 3] 13 mult1',
      '.model mult1 mult (in_offset=[0.1 0.0] in_gain=[2.0 1.5] out_gain=0.5 out_offset=0.2)', 'r13 13 0 1k',
      'a4 1 3 14 div1', '.model div1 divide (num_gain=3.0 den_offset=0.5 out_gain=2.0)', 'r14 14 0 1k',
      'a5 %vd (3 1) 15 int1', 'r15 15 0 1k',
      '.ac dec 2 10 10k', '.end',
    ].join('\n'));
    const ac = result.ac!;
    const complex = (node: string, index: number) => {
      const { magnitude, phase } = ac.voltage(node)[index];
      return [magnitude * Math.cos((phase * Math.PI) / 180), magnitude * Math.sin((phase * Math.PI) / 180)];
    };
    // ngspice-47 at 10 Hz (index 0) and 1 kHz (index 4)
    const reference: Record<string, [[number, number], [number, number]]> = {
      11: [[0, -15.91549431], [0, -0.1591549431]],
      12: [[0, 0.062831853072], [0, 6.2831853072]],
      13: [[3, 0], [3, 0]],
      14: [[2.4, 0], [2.4, 0]],
      15: [[0, 15.915494309], [0, 0.15915494309]],
    };
    for (const [node, [low, high]] of Object.entries(reference)) {
      for (const [index, [re, im]] of [[0, low], [4, high]] as const) {
        const [gotRe, gotIm] = complex(node, index);
        expect(gotRe).toBeCloseTo(re, 8);
        expect(gotIm).toBeCloseTo(im, 8);
      }
    }
  });

  it('matches int, d_dt and pwl transients within 0.1 % (ngspice meas at the same times)', async () => {
    const result = await simulate([
      'xspice tran',
      'v1 1 0 DC 0 SIN(0 1 1k)', 'r1 1 0 1k', 'v2 2 0 DC 0 PWL(0 0 1m 2)', 'r2 2 0 1k',
      'a1 1 11 int1',
      '.model int1 int (in_offset=0.1 gain=1000 out_lower_limit=-1e12 out_upper_limit=1e12 limit_range=1e-9 out_ic=0.5)',
      'r11 11 0 1k',
      'a2 1 12 int2', '.model int2 int (gain=2000 out_lower_limit=-0.2 out_upper_limit=0.25 limit_range=0.01)',
      'r12 12 0 1k',
      'a3 1 13 dd1',
      '.model dd1 d_dt (gain=1e-3 out_offset=0.01 out_lower_limit=-1e12 out_upper_limit=1e12 limit_range=1e-9)',
      'r13 13 0 1k',
      'a4 2 14 pwl1',
      '.model pwl1 pwl (x_array=[-1.0 0.0 1.0 2.0 3.0 4.0 5.0] y_array=[ 0.0 0.0 1.0 4.0 4.5 5.0 5.0] input_domain=0.01 fraction=TRUE)',
      'r14 14 0 1k',
      '.tran 1u 1m', '.end',
    ].join('\n'));
    const tran = result.transient!;
    const at = (node: string, t: number): number => {
      const v = tran.voltage(node);
      const i = Math.max(1, tran.time.findIndex(x => x >= t));
      const f = (t - tran.time[i - 1]) / (tran.time[i] - tran.time[i - 1]);
      return v[i - 1] + f * (v[i] - v[i - 1]);
    };
    const reference: [string, number, number][] = [
      ['11', 0.25e-3, 0.684652], ['11', 0.5e-3, 0.868313], ['11', 1e-3, 0.599995],
      ['12', 0.25e-3, 0.246944], ['12', 0.5e-3, 0.241812], ['12', 0.9e-3, -0.195724],
      ['13', 0.1e-3, 5.10477], ['13', 0.5e-3, -6.27314], ['13', 0.8e-3, 1.93282],
      ['14', 0.3e-3, 0.6], ['14', 0.6e-3, 1.6], ['14', 0.95e-3, 3.7],
    ];
    for (const [node, t, value] of reference) {
      expect(Math.abs(at(node, t) - value)).toBeLessThan(1e-3 * Math.max(Math.abs(value), 0.1));
    }
  });

  it('integrates with the BDF coefficients under .options method=gear', async () => {
    const result = await simulate([
      'xspice gear', 'v1 1 0 DC 0 SIN(0 1 1k)', 'r1 1 0 1k',
      'a1 1 11 int1',
      '.model int1 int (in_offset=0.1 gain=1000 out_lower_limit=-1e12 out_upper_limit=1e12 limit_range=1e-9 out_ic=0.5)',
      'r11 11 0 1k',
      'a2 1 12 int2', '.model int2 int (gain=2000 out_lower_limit=-0.2 out_upper_limit=0.25 limit_range=0.01)',
      'r12 12 0 1k',
      '.options method=gear', '.tran 1u 1m', '.end',
    ].join('\n'));
    const tran = result.transient!;
    const at = (node: string, t: number): number => {
      const v = tran.voltage(node);
      const i = Math.max(1, tran.time.findIndex(x => x >= t));
      const f = (t - tran.time[i - 1]) / (tran.time[i] - tran.time[i - 1]);
      return v[i - 1] + f * (v[i] - v[i - 1]);
    };
    // ngspice-47 with .options method=gear (meas find at=)
    const reference: [string, number, number][] = [
      ['11', 0.25e-3, 0.684153], ['11', 0.5e-3, 0.868310], ['11', 1e-3, 0.599999],
      ['12', 0.25e-3, 0.245970], ['12', 0.5e-3, 0.241418], ['12', 0.9e-3, -0.194849],
    ];
    for (const [node, t, value] of reference) {
      expect(Math.abs(at(node, t) - value)).toBeLessThan(1e-4 * Math.max(Math.abs(value), 0.1));
    }
  });
});

describe('cm_smooth_corner', () => {
  it('blends the two slopes continuously at the domain edges', () => {
    const lower = smoothCorner(0.9, 1, 1, 0.1, 1, 3);
    const upper = smoothCorner(1.1, 1, 1, 0.1, 1, 3);
    expect(lower.y).toBeCloseTo(0.9, 12);
    expect(lower.dydx).toBeCloseTo(1, 12);
    expect(upper.y).toBeCloseTo(1.3, 12);
    expect(upper.dydx).toBeCloseTo(3, 12);
  });
});
