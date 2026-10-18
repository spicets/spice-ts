import { describe, it, expect } from 'vitest';
import { evaluateExpression } from './expression.js';

describe('evaluateExpression', () => {
  describe('basic arithmetic', () => {
    it('evaluates integer addition', () => {
      expect(evaluateExpression('1+2', {})).toBe(3);
    });

    it('evaluates subtraction', () => {
      expect(evaluateExpression('5-3', {})).toBe(2);
    });

    it('evaluates multiplication', () => {
      expect(evaluateExpression('3*4', {})).toBe(12);
    });

    it('evaluates division', () => {
      expect(evaluateExpression('10/4', {})).toBe(2.5);
    });

    it('evaluates exponentiation', () => {
      expect(evaluateExpression('2**3', {})).toBe(8);
    });

    it('treats exponentiation as left-associative, like ngspice numparam', () => {
      // ngspice-47: v1 1 0 {2**3**2} -> 64, i.e. (2**3)**2, not 2**(3**2) = 512
      expect(evaluateExpression('2**3**2', {})).toBe(64);
    });

    it('respects operator precedence (mul before add)', () => {
      expect(evaluateExpression('2+3*4', {})).toBe(14);
    });

    it('respects operator precedence (div before sub)', () => {
      expect(evaluateExpression('10-6/3', {})).toBe(8);
    });

    it('handles parentheses overriding precedence', () => {
      expect(evaluateExpression('(2+3)*4', {})).toBe(20);
    });

    it('handles nested parentheses', () => {
      expect(evaluateExpression('((2+3)*(4-1))', {})).toBe(15);
    });

    it('handles unary minus', () => {
      expect(evaluateExpression('-5', {})).toBe(-5);
    });

    it('handles unary minus in expression', () => {
      expect(evaluateExpression('3*-2', {})).toBe(-6);
    });

    it('handles floating point numbers', () => {
      expect(evaluateExpression('1.5+2.5', {})).toBe(4);
    });

    it('handles scientific notation', () => {
      expect(evaluateExpression('1e-6*1e3', {})).toBeCloseTo(1e-3);
    });

    it('handles whitespace', () => {
      expect(evaluateExpression(' 2 + 3 ', {})).toBe(5);
    });
  });

  describe('variables', () => {
    it('resolves a variable', () => {
      expect(evaluateExpression('W', { W: 1e-6 })).toBe(1e-6);
    });

    it('resolves variable in expression', () => {
      expect(evaluateExpression('W*2', { W: 1e-6 })).toBeCloseTo(2e-6);
    });

    it('resolves multiple variables', () => {
      expect(evaluateExpression('W/L', { W: 10e-6, L: 1e-6 })).toBeCloseTo(10);
    });

    it('is case-insensitive for variable lookup', () => {
      expect(evaluateExpression('vdd', { VDD: 1.8 })).toBe(1.8);
    });

    it('throws on undefined variable', () => {
      expect(() => evaluateExpression('X', {})).toThrow("Undefined variable 'X'");
    });
  });

  describe('functions', () => {
    it.each([
      [-100, -98], [-10, -8], [0.5, 2.5], [2, 4], [6, 6],
      [12, 9], [22, 19], [100, 97],
    ])('evaluates pwl at %s with ngspice end-segment extrapolation', (x, value) => {
      expect(evaluateExpression('pwl(x,-10,-8,2,4,12,9,22,19)', { x })).toBe(value);
    });

    it('evaluates pwl arguments and resolves its name case-insensitively', () => {
      expect(evaluateExpression('PWL(x*2,0,1,2,1+4)', { x: 0.5 })).toBe(3);
    });

    it.each(['pwl(0)', 'pwl(0,0,1)', 'pwl(0,0,1,2)'])(
      'rejects an incomplete pwl table: %s', expression => {
        expect(() => evaluateExpression(expression, {})).toThrow('at least two pairs');
      },
    );

    it.each(['pwl(0,0,1,0,2)', 'pwl(0,1,1,0,2)'])(
      'rejects nonascending pwl points: %s', expression => {
        expect(() => evaluateExpression(expression, {})).toThrow('strictly ascending');
      },
    );

    it('evaluates sqrt', () => {
      expect(evaluateExpression('sqrt(4)', {})).toBe(2);
    });

    it('evaluates abs', () => {
      expect(evaluateExpression('abs(-3)', {})).toBe(3);
    });

    it('evaluates log as the natural log, like ngspice numparam', () => {
      // ngspice-47: v1 1 0 {log(100)} -> 4.605170185988093
      expect(evaluateExpression('log(100)', {})).toBe(Math.log(100));
    });

    it('evaluates ln (natural log)', () => {
      expect(evaluateExpression('ln(1)', {})).toBe(0);
    });

    it('evaluates exp', () => {
      expect(evaluateExpression('exp(0)', {})).toBe(1);
    });

    it('evaluates min with two args', () => {
      expect(evaluateExpression('min(3,7)', {})).toBe(3);
    });

    it('evaluates max with two args', () => {
      expect(evaluateExpression('max(3,7)', {})).toBe(7);
    });

    it('evaluates pow', () => {
      expect(evaluateExpression('pow(2,10)', {})).toBe(1024);
    });

    it('evaluates nested function calls', () => {
      expect(evaluateExpression('sqrt(abs(-9))', {})).toBe(3);
    });

    it('evaluates function with expression argument', () => {
      expect(evaluateExpression('sqrt(W*L)', { W: 4, L: 9 })).toBe(6);
    });

    it('throws on unknown function', () => {
      expect(() => evaluateExpression('foo(1)', {})).toThrow("Unknown function 'foo'");
    });
  });

  describe('SI suffixes in expressions', () => {
    it('evaluates 10k as 10000', () => {
      expect(evaluateExpression('10k', {})).toBe(10000);
    });

    it('evaluates 4.7k as 4700', () => {
      expect(evaluateExpression('4.7k', {})).toBe(4700);
    });

    it('evaluates 100n as 1e-7', () => {
      expect(evaluateExpression('100n', {})).toBe(100 * 1e-9);
    });

    it('evaluates 1u as 1e-6', () => {
      expect(evaluateExpression('1u', {})).toBe(1e-6);
    });

    it('evaluates 2.2meg as 2.2e6', () => {
      expect(evaluateExpression('2.2meg', {})).toBe(2.2e6);
    });

    it('evaluates SI suffix in arithmetic: 10k * 2', () => {
      expect(evaluateExpression('10k * 2', {})).toBe(20000);
    });

    it('evaluates mixed SI: 1k + 500', () => {
      expect(evaluateExpression('1k + 500', {})).toBe(1500);
    });

    it('is case-sensitive: m = milli, M = mega', () => {
      expect(evaluateExpression('1m', {})).toBe(0.001);
      expect(evaluateExpression('1M', {})).toBe(1e6);
      expect(evaluateExpression('10K', {})).toBe(10000);
      expect(evaluateExpression('1MEG', {})).toBe(1e6);
    });

    it('evaluates embedded suffix notation: 3k3 = 3300', () => {
      expect(evaluateExpression('3k3', {})).toBe(3300);
    });

    it('evaluates embedded suffix notation: 4M7 = 4700000', () => {
      expect(evaluateExpression('4M7', {})).toBe(4700000);
    });

    it('evaluates embedded suffix in arithmetic: 4k7 + 300', () => {
      expect(evaluateExpression('4k7 + 300', {})).toBe(5000);
    });
  });

  describe('ngspice numparam functions and operators (#493)', () => {
    // Expected values are ngspice-47 operating points of `vN n 0 {expr}` cards.
    it.each([
      ['log10(2.7)', Math.log10(2.7)],
      ['sin(1.0e-1)', Math.sin(0.1)],
      ['cos(7.0e-1)', Math.cos(0.7)],
      ['tan(1.0e-1)', Math.tan(0.1)],
      ['asin(7.0e-1)', Math.asin(0.7)],
      ['acos(1.0e-1)', Math.acos(0.1)],
      ['atan(7.0e-1)', Math.atan(0.7)],
      ['arctan(1)', 0.7853981633974483],
      ['sinh(1.0e-1)', Math.sinh(0.1)],
      ['cosh(1.0e-1)', Math.cosh(0.1)],
      ['tanh(7.0e-1)', Math.tanh(0.7)],
      ['asinh(1.0e-1)', Math.asinh(0.1)],
      ['acosh(1.2e+0)', 0.6223625037147786],
      ['atanh(7.0e-1)', Math.atanh(0.7)],
      ['sqr(3)', 9],
      ['pwr(-2,3)', 8],
      ['pwr(-4,0.5)', 2],
      ['int(-2.7)', -2],
      ['nint(2.5)', 2],
      ['nint(-2.5)', -2],
      ['nint(3.5)', 4],
      ['sgn(-3)', -1],
      ['floor(-2.5)', -3],
      ['ceil(2.1)', 3],
      ['ternary_fcn(0,1,2)', 2],
    ])('evaluates %s', (expression, expected) => {
      expect(evaluateExpression(expression, {})).toBe(expected);
    });

    it('evaluates a double minus as subtraction of a negation', () => {
      expect(evaluateExpression('2--3', {})).toBe(5);
    });

    it('evaluates comparisons, logical operators and the ternary operator', () => {
      expect(evaluateExpression('1 < 2 && 3 >= 3 ? 7 : 8', {})).toBe(7);
      expect(evaluateExpression('!0 + (2 == 2) + (2 != 2)', {})).toBe(2);
      expect(evaluateExpression('0 || 2 > 3 ? 1 : 0', {})).toBe(0);
      expect(evaluateExpression('1 ? 2 : 0 ? 3 : 4', {})).toBe(2);
    });

    it('evaluates % and ^', () => {
      expect(evaluateExpression('7%3', {})).toBe(1);
      expect(evaluateExpression('2^3', {})).toBe(8);
    });

    describe('power precedence and associativity (ngspice-47 xpressn.c)', () => {
      // Each expected value is the ngspice-47 operating point of a one-card deck
      // `.param x=2` / `V1 1 0 {expr}` (see the deck test in
      // numparam-quoted-expressions.test.ts). ngspice numparam evaluates `^`
      // and `**` left-associatively at the tightest binary level; a leading
      // sign is the binary `0 - ...`, so it applies after the power; a minus
      // directly after another operator negates the following number literal,
      // which then is the power base; and the power base is taken as |x|.
      it.each([
        ['2^3^2', 64],
        ['2**3**2', 64],
        ['2^3**2', 64],
        ['4^0.5^2', 4],
        ['2^-2^2', 0.0625],
        ['-2^2', -4],
        ['-2**2', -4],
        ['- 2 ^ 2', -4],
        ['-3^2+1', -8],
        ['-3**2+1', -8],
        ['-x^2', -4],
        ['-x**2+1', -3],
        ['-2^-2', -0.25],
        ['-2^2^3', -64],
        ['-2*3^2', -18],
        ['-sqrt(4)^2', -4],
        ['--2^2', -4],
        ['(-2^2)', -4],
        ['3*(-2^2)', -12],
        ['max(-2^2,-5)', -4],
        ['abs(-2^2)', 4],
        ['3*-2^2', 12],
        ['3*-2**2', 12],
        ['3 * - 2 ^ 2', 12],
        ['3/-2^2', 0.75],
        ['1+-2^2', 5],
        ['3- -2^2', -1],
        ['1<-2^2', 1],
        ['1?-2^2:0', 4],
        ['3*-2*2', -12],
        ['(-2)^2', 4],
        ['(-2)^3', 8],
        ['(-3)^-1', 1 / 3],
        ['1-(-2)^3', -7],
        ['2*-3^-1', 2 / 3],
        ['!0^2', 1],
        ['!2^0', 1],
        ['3*!0^2', 3],
        ['2^3*2', 16],
        ['2*3^2', 18],
        ['2-3^2', -7],
        ['x^-1', 0.5],
        ['2^ -1', 0.5],
      ])('evaluates %s', (expression, expected) => {
        expect(evaluateExpression(expression, { X: 2 })).toBeCloseTo(expected, 12);
      });
    });

    describe('minus after a binary operator negates the next number literal (#578, ngspice-47 xpressn.c formula())', () => {
      // ngspice-47 formula() does not negate the operand after `op -`: it sets
      // a `negate` flag that the next number literal *of the same (sub-)formula*
      // consumes (fetchnumber branch). Names, function calls and parenthesised
      // sub-formulas do not consume it, so the sign moves to a later literal, or
      // the formula fails with "wrongly determined negation" if none follows.
      // Expected values: ngspice-47 operating point of the one-card deck
      // `.param x=2` / `v1 1 0 {expr}` / `r1 1 0 1` (ngspice -b, .print op v(1)).
      it.each([
        ['3*-x^2', 0.75],
        ['3*-x**2', 0.75],
        ['1+-x^2', 1.25],
        ['2*-(x)^2', 0.5],
        ['3*-(2)^2', 0.75],
        ['3*-x*2', -12],
        ['3*-2*x', -12],
        ['x*-1', -2],
        ['-x^-2', -0.25],
        ['-(x)^2', -4],
        ['(-x)^2', 4],
        ['-(-x)^2', -4],
        ['x-(-x)^2', -2],
        ['-x**2', -4],
        ['-2**2', -4],
        ['-(2)**2', -4],
        ['3*-2**2', 12],
        ['2**3**2', 64],
        ['2**-1', 0.5],
        ['1--1', 2],
        ['5+2/-4', 4.5],
        ['3*--2', -6],
        ['+-2', -2],
        ['-!0', -1],
        ['3*-!0', 3],
        ['3*-x+1', 5],
        ['1?-x:0', 2],
        ['1?-x^2:3', 0.25],
        ['0?1:-x^2', 0.25],
        ['x>-1', 1],
        ['x<-x^2', 0],
        ['x*-1e3', -2000],
        ['x*-2k', -4000],
      ])('evaluates %s', (expression, expected) => {
        expect(evaluateExpression(expression, { X: 2 })).toBeCloseTo(expected, 12);
      });

      it.each([
        '3*-x',
        '2*-(3)',
        '2*-sqrt(4)',
        '1+-x',
        '2^-x',
        '2**-x',
        'x^-x',
        '1- -x',
        '-x*-x',
        '5*-pwr(2,2)',
        '2* -x',
        '3/-x',
        'max(3*-x,1)',
      ])('rejects %s like ngspice ("wrongly determined negation")', expression => {
        expect(() => evaluateExpression(expression, { X: 2 })).toThrow(/wrongly determined negation/);
      });

      it.each(['3*+x^2', '3*-+2', '-+2', '!-2'])('rejects %s like ngspice ("Misplaced operator")', expression => {
        expect(() => evaluateExpression(expression, { X: 2 })).toThrow(/Misplaced operator/);
      });
    });

    it('evaluates the corpus-f TEMPER ternary from todo-temper-3.cir', () => {
      const expression = 'temper >= 25 ? 1e-10 : (temper+1)*1e-11';
      expect(evaluateExpression(expression, { TEMPER: 27 })).toBe(1e-10);
      expect(evaluateExpression(expression, { TEMPER: 9 })).toBeCloseTo(1e-10, 22);
      expect(evaluateExpression(expression, { TEMPER: 0 })).toBeCloseTo(1e-11, 22);
    });
  });

  describe('edge cases', () => {
    it('handles empty string', () => {
      expect(() => evaluateExpression('', {})).toThrow();
    });

    it('handles complex nested expression', () => {
      expect(evaluateExpression('2*(W+L)/sqrt(4)', { W: 3, L: 5 })).toBe(8);
    });
  });
});
