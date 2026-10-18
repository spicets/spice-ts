// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { simulate } from '../index.js';
import { parse } from './index.js';
import { UnsupportedCodeModelError } from './xspice-parser.js';

describe('subcircuit-local XSPICE meters (#1434)', () => {
  // ngspice-47 xtradev/{cmeter,lmeter}/{cfunc.mod,ifspec.ifs}:
  // OUTPUT(out) = PARAM(gain) * cm_netlist_get_{c,l}().
  // cmmeters.c sums capacitances and combines inductances in parallel.
  it.each([false, true])('reads parallel C/L networks with scoped gain (expression=%s)', async expression => {
    const dc = (await simulate([
      'MIT scoped C/L meters',
      '.subckt meters input cout lout cg=1e12 lg=1e6',
      'Ac input cout cm', 'Al input lout lm',
      `.model cm cmeter(gain=${expression ? '{cg}' : '1e12'})`,
      `.model lm lmeter(gain=${expression ? '{lg}' : '1e6'})`,
      '.ends meters',
      'V1 input 0 0.3', 'C1 input 0 2p', 'C2 input 0 3p',
      'L1 input n1 3u', 'R1 n1 0 1k', 'L2 input n2 6u', 'R2 n2 0 1k',
      'Xone input cout lout meters', 'Rc cout 0 1k', 'Rl lout 0 1k',
      '.op', '.end',
    ].join('\n'))).dc!;
    expect(dc.voltage('cout')).toBeCloseTo(5, 10);
    expect(dc.voltage('lout')).toBeCloseTo(2, 10);
  });

  it('keeps unsupported scoped code models rejected after expression expansion', () => {
    expect(() => parse([
      'MIT unsupported scoped model', '.subckt bad a b g=1',
      'A1 a b m', '.model m filesource(amplscale=[{g}])', '.ends bad',
      'X1 in out bad', 'V1 in 0 0', 'R1 out 0 1k', '.op', '.end',
    ].join('\n')).compile()).toThrow(UnsupportedCodeModelError);
  });
});
