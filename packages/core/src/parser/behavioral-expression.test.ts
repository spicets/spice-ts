import { describe, expect, it } from 'vitest';
import { ParseError } from '../errors.js';
import {
  BehavioralRangeError,
  compileBehavioralExpression,
  formatBehavioralExpression,
  mapBehavioralNodes,
  parseBehavioralExpression,
  parseBehavioralSourceCard,
  substituteBehavioralParameters,
  type BehavioralEnvironment,
} from './behavioral-expression.js';

function evaluate(
  text: string,
  voltages: Record<string, number> = {},
  environment?: BehavioralEnvironment,
) {
  const expression = parseBehavioralExpression(text);
  const compiled = compileBehavioralExpression(expression);
  const values = compiled.nodes.map(node => voltages[node] ?? 0);
  const gradient = new Float64Array(compiled.nodes.length);
  const value = compiled.evaluate(values, gradient, environment);
  return {
    value,
    gradient: Object.fromEntries(compiled.nodes.map((node, index) => [node, gradient[index]])),
  };
}

describe('behavioral source expressions', () => {
  it.each([
    [-100, -98, 1], [-10, -8, 1], [0.5, 2.5, 1], [2, 4, 0.5],
    [6, 6, 0.5], [12, 9, 1], [22, 19, 1], [100, 97, 1],
  ])(
    'interpolates and extrapolates pwl at %s with the ngspice segment derivative', (x, value, slope) => {
      const result = evaluate('pwl(v(x),-10,-8,2,4,12,9,22,19)', { x });
      expect(result.value).toBe(value);
      expect(result.gradient.x).toBe(slope);
    },
  );

  it('applies the pwl segment slope to the argument gradient for Newton', () => {
    const result = evaluate('pwl(2*v(x),-10,-8,2,4,12,9,22,19)', { x: 3 });
    expect(result.value).toBe(6);
    expect(result.gradient.x).toBe(1);
  });

  it('uses the configured CKTgmin for PTdivide regularization (#1068)', () => {
    const environment = { time: 0, transient: false, temperature: 27, gmin: 1e-6 };
    expect(evaluate('1e-20/0', {}, environment).value).toBeCloseTo(1e6, 6);
    expect(evaluate('1e-20/0').value).toBeCloseTo(1e12, 0);
    // A separate compiled expression must not inherit another run's gmin.
    expect(evaluate('1e-20/0', {}, { ...environment, gmin: 1e-9 }).value).toBeCloseTo(1e9, 3);
  });
  it('evaluates the mesa-oscillator load current and its exact node derivatives', () => {
    const text = '0.00025*tanh(v(1,2)/0.00025/2240)*(1+v(1,2)*0.027)';
    const v12 = 0.37;
    const x = v12 / 0.00025 / 2240;
    const expected = 0.00025 * Math.tanh(x) * (1 + v12 * 0.027);
    const derivative = (1 - Math.tanh(x) ** 2) / 2240 * (1 + v12 * 0.027)
      + 0.00025 * Math.tanh(x) * 0.027;

    const result = evaluate(text, { 1: 1.2, 2: 1.2 - v12 });

    expect(result.value).toBeCloseTo(expected, 15);
    expect(result.gradient['1']).toBeCloseTo(derivative, 12);
    expect(result.gradient['2']).toBeCloseTo(-derivative, 12);
  });

  it('honours precedence, unary minus, SPICE scale factors and ground references', () => {
    const result = evaluate('-2k*v(a)+3m/v(b,0)-v(0,a)*4', { a: 0.5, b: 2 });
    expect(result.value).toBeCloseTo(-2000 * 0.5 + 3e-3 / 2 + 0.5 * 4, 12);
    expect(result.gradient.a).toBeCloseTo(-2000 + 4, 12);
    expect(result.gradient.b).toBeCloseTo(-3e-3 / 4, 12);
    expect(Object.keys(result.gradient)).toEqual(['a', 'b']);
  });

  it('supports the ngspice transcendental functions with their derivatives', () => {
    const v = 0.3;
    const cases: Array<[string, number, number]> = [
      ['exp(v(x))', Math.exp(v), Math.exp(v)],
      ['sinh(v(x))', Math.sinh(v), Math.cosh(v)],
      ['cosh(v(x))', Math.cosh(v), Math.sinh(v)],
      ['atan(v(x))', Math.atan(v), 1 / (1 + v * v)],
      ['sin(v(x))', Math.sin(v), Math.cos(v)],
      ['cos(v(x))', Math.cos(v), -Math.sin(v)],
      ['abs(-v(x))', v, 1],
      ['tan(v(x))', Math.tan(v), 1 + Math.tan(v) ** 2],
      ['tanh(v(x))', Math.tanh(v), 1 - Math.tanh(v) ** 2],
      ['asin(v(x))', Math.asin(v), 1 / Math.sqrt(1 - v * v)],
      ['acos(v(x))', Math.acos(v), -1 / Math.sqrt(1 - v * v)],
      ['asinh(v(x))', Math.asinh(v), 1 / Math.sqrt(v * v + 1)],
      ['atanh(v(x))', Math.atanh(v), 1 / (1 - v * v)],
      ['acosh(v(x)+1)', Math.acosh(v + 1), 1 / Math.sqrt((v + 1) ** 2 - 1)],
      ['sqrt(v(x))', Math.sqrt(v), 1 / (2 * Math.sqrt(v))],
      ['ln(v(x))', Math.log(v), 1 / v],
      ['log(v(x))', Math.log(v), 1 / v],
      ['log10(v(x))', Math.log10(v), Math.LOG10E / v],
    ];
    for (const [text, value, slope] of cases) {
      const result = evaluate(text, { x: v });
      expect(result.value, text).toBeCloseTo(value, 14);
      expect(result.gradient.x, text).toBeCloseTo(slope, 12);
    }
    expect(evaluate('exp(300)').value).toBe(1e99);
    expect(evaluate('log(0)').value).toBe(-1e99);
  });

  it('evaluates the piecewise ngspice functions with ngspice derivatives', () => {
    const cases: Array<[string, number, number, number]> = [
      // [expression, v(x), value, d/dv(x)]
      ['floor(v(x))', 2.7, 2, 0],
      ['floor(v(x))', -2.2, -3, 0],
      ['ceil(v(x))', 2.2, 3, 0],
      ['nint(v(x))', 2.5, 2, 0],
      ['nint(v(x))', 3.5, 4, 0],
      ['nint(v(x))', -1.6, -2, 0],
      ['sgn(v(x))', -0.1, -1, 0],
      ['sgn(v(x))', 0, 0, 0],
      ['u(v(x))', 0, 0.5, 0],
      ['u(v(x))', -1, 0, 0],
      ['u(v(x))', 1, 1, 0],
      ['uramp(v(x))', 0, 0, 0.5],
      ['uramp(v(x))', 2, 2, 1],
      ['uramp(v(x))', -2, 0, 0],
      ['u2(v(x))', -0.25, 0, 0],
      ['u2(v(x))', 0, 0, 0.5],
      ['u2(v(x))', 0.25, 0.25, 1],
      ['u2(v(x))', 2, 1, 0],
      ['u2(v(x))', 1, 1, 0.5],
    ];
    for (const [text, x, value, slope] of cases) {
      const result = evaluate(text, { x });
      expect(result.value, `${text} at ${x}`).toBe(value);
      expect(result.gradient.x, `${text}' at ${x}`).toBe(slope);
    }
  });

  it('evaluates min() and max() with the derivative of the selected argument', () => {
    expect(evaluate('min(v(a),2*v(b))', { a: 1, b: 3 })).toEqual({ value: 1, gradient: { a: 1, b: 0 } });
    expect(evaluate('min(v(a),2*v(b))', { a: 7, b: 3 })).toEqual({ value: 6, gradient: { a: 0, b: 2 } });
    expect(evaluate('max(v(a),2*v(b))', { a: 7, b: 3 })).toEqual({ value: 7, gradient: { a: 1, b: 0 } });
    // On a tie ngspice returns the first argument but differentiates the second.
    expect(evaluate('max(v(a),v(b))', { a: 2, b: 2 })).toEqual({ value: 2, gradient: { a: 0, b: 1 } });
    // The dcdc.sp error-amplifier clamp.
    const clamp = evaluate('max(0,min(5,v(ref,x)*10k))', { ref: 2.5, x: 2.4999 });
    expect(clamp.value).toBeCloseTo(1, 9);
    expect(clamp.gradient).toEqual({ ref: 10000, x: -10000 });
    expect(evaluate('max(0,min(5,v(ref,x)*10k))', { ref: 2.5, x: 2 }).value).toBe(5);
  });

  it('implements the ^ and ** operators like ngspice PTpowerH and its derivative', () => {
    const cube = evaluate('v(x)^3', { x: 2 });
    expect(cube).toEqual({ value: 8, gradient: { x: 12 } });
    expect(evaluate('v(x)**3', { x: 2 })).toEqual(cube);
    // ngspice-47 differentiates a^c as c*pwr(a,c-1)*da, so the sign of a
    // is kept even for an even c-1 (here 3*-(1^2) = -3).
    expect(evaluate('v(x)^3', { x: -1 })).toEqual({ value: -1, gradient: { x: -3 } });
    // A negative base with a non-integer exponent evaluates to 0.
    expect(evaluate('v(x)^0.5', { x: -4 }).value).toBe(0);
    expect(evaluate('v(x)^0.5', { x: 4 }).value).toBe(2);
    // Unary minus binds looser than ^, ^ is left-associative.
    expect(evaluate('-2^2').value).toBe(-4);
    expect(evaluate('2^3^2').value).toBe(64);
    expect(evaluate('2^-1').value).toBe(0.5);
    expect(evaluate('2*3^2').value).toBe(18);
    // Constant base: pow(a,b)*db*log|a|.
    const exponential = evaluate('2^v(x)', { x: 3 });
    expect(exponential.value).toBe(8);
    expect(exponential.gradient.x).toBeCloseTo(8 * Math.log(2), 14);
    // Both variable: pow(a,b)*(b*da/a + db*log|a|).
    const both = evaluate('v(a)^v(b)', { a: 2, b: 3 });
    expect(both.value).toBe(8);
    expect(both.gradient.a).toBeCloseTo(12, 12);
    expect(both.gradient.b).toBeCloseTo(8 * Math.log(2), 12);
  });

  it('implements pow() and pwr()', () => {
    // pow(a,c) differentiates through pwr: 2*pwr(-3,1) = -6.
    expect(evaluate('pow(v(x),2)', { x: -3 })).toEqual({ value: 9, gradient: { x: -6 } });
    expect(evaluate('pow(v(x),0.5)', { x: -3 }).value).toBe(0);
    expect(evaluate('pow(0,2)').value).toBe(0);
    // pwr(a,c) differentiates through pow: 2*pow(-3,1) = -6.
    expect(evaluate('pwr(v(x),2)', { x: -3 })).toEqual({ value: -9, gradient: { x: -6 } });
    expect(evaluate('pwr(v(x),2)', { x: 3 })).toEqual({ value: 9, gradient: { x: 6 } });
  });

  it('keeps the pow()/^ slope finite at a zero base with an exponent below 1 (#886)', () => {
    // c*pwr(0, c-1) is a pole; ngspice-47 PTpwr moves the zero base to
    // PTfudge_factor = gmin*1e-20 = 1e-32 (PSpice mode), so the slope is
    // c*1e-32^(c-1): 0.5*1e16 for c = 0.5.
    const fudge = 1e-12 * 1e-20;
    for (const text of ['pow(v(x),0.5)', 'v(x)^0.5', 'v(x)**0.5']) {
      const result = evaluate(text, { x: 0 });
      expect(result.value).toBe(0);
      expect(result.gradient.x).toBe(0.5 * Math.pow(fudge, -0.5));
    }
    // ngspice's parser never folds `-0.5` or `(1/2)` into one PT_CONSTANT, so
    // they take the general rule pow(a,b)*(b*da/a + db*log|a|), which is 0
    // at a zero base (#891). Instrumented ngspice-47 ASRC derivatives:
    // pow(V,-0.5) at 0 -> -0, at -1 -> 0; V^(1/2) at 0 -> 0.
    expect(evaluate('pow(v(x),-0.5)', { x: 0 })).toEqual({ value: 0, gradient: { x: -0 } });
    expect(evaluate('pow(v(x),-0.5)', { x: -1 })).toEqual({ value: 0, gradient: { x: 0 } });
    expect(evaluate('v(x)^(1/2)', { x: 0 })).toEqual({ value: 0, gradient: { x: 0 } });
    expect(evaluate('v(x)^-0.5', { x: 0 })).toEqual({ value: Infinity, gradient: { x: -0 } });
    // PSpice pwrs(x, a) = sgn(x)*pow(x, a): sgn(0) = 0 zeroes the finite slope.
    expect(evaluate('pwrs(v(x),0.5)', { x: 0 })).toEqual({ value: 0, gradient: { x: 0 } });
    // An exponent >= 1 has no pole and keeps ngspice's exact slope at 0.
    expect(evaluate('pow(v(x),1)', { x: 0 })).toEqual({ value: 0, gradient: { x: 1 } });
    expect(evaluate('pow(v(x),1.5)', { x: 0 })).toEqual({ value: 0, gradient: { x: 0 } });
    // pwr(a,c) already differentiates through PTpower (0 at a zero base).
    expect(evaluate('pwr(v(x),0.5)', { x: 0 })).toEqual({ value: 0, gradient: { x: 0 } });
  });

  it('implements comparisons, logic and the ternary operator with zero derivatives', () => {
    const at = (x: number) => ({ x });
    expect(evaluate('v(x) > 1', at(2)).value).toBe(1);
    expect(evaluate('v(x) > 1', at(1)).value).toBe(0);
    expect(evaluate('v(x) >= 1', at(1)).value).toBe(1);
    expect(evaluate('v(x) < 1', at(0)).value).toBe(1);
    expect(evaluate('v(x) <= 1', at(1)).value).toBe(1);
    expect(evaluate('v(x) == 1', at(1)).value).toBe(1);
    expect(evaluate('v(x) != 1', at(1)).value).toBe(0);
    expect(evaluate('v(x) <> 1', at(2)).value).toBe(1);
    expect(evaluate('v(x) > 1', at(2)).gradient).toEqual({ x: 0 });
    expect(evaluate('!v(x)', at(0)).value).toBe(1);
    expect(evaluate('!v(x)', at(3)).value).toBe(0);
    expect(evaluate('v(x) > 1 && v(x) < 3', at(2)).value).toBe(1);
    expect(evaluate('v(x) > 1 && v(x) < 3', at(4)).value).toBe(0);
    expect(evaluate('v(x) < 1 || v(x) > 3', at(4)).value).toBe(1);
    expect(evaluate('v(x) < 1 || v(x) > 3', at(2)).value).toBe(0);
    // Precedence: comparisons bind looser than arithmetic, && tighter than ||.
    expect(evaluate('1 + 1 > 1 == 1').value).toBe(1);
    expect(evaluate('0 && 0 || 1').value).toBe(1);

    // mc.cir zero-crossing detector; the ternary differentiates the taken branch only.
    const detector = '(v(live) > -2 && v(live) < 2) ? 5*v(live) : 0';
    expect(evaluate(detector, { live: 1 })).toEqual({ value: 5, gradient: { live: 5 } });
    expect(evaluate(detector, { live: 3 })).toEqual({ value: 0, gradient: { live: 0 } });
    expect(evaluate('ternary_fcn(v(a) < 1, 2*v(a), 3)', { a: 0.5 }))
      .toEqual({ value: 1, gradient: { a: 2 } });
    // Nested and right-associative.
    expect(evaluate('v(a) > 0 ? 1 : v(a) < 0 ? -1 : 0', { a: -2 }).value).toBe(-1);
  });

  it('reads time, temper and the constants pi and e', () => {
    const environment = { time: 2e-9, transient: true, temperature: 127 };
    expect(evaluate('time*2', {}, environment).value).toBe(4e-9);
    expect(evaluate('TEMPER - 27', {}, environment).value).toBe(100);
    expect(evaluate('time').value).toBe(0);
    expect(evaluate('temper').value).toBe(27);
    expect(evaluate('pi').value).toBe(Math.PI);
    expect(evaluate('2*e').value).toBe(2 * Math.E);
    // set1.cir's double-exponential pulse after numparam substitution.
    const pulse = 'ternary_fcn(TIME < 1e-9, 0, 2.5m * (exp(-(TIME-1e-9)/1e-10)-exp(-(TIME-1e-9)/5e-10)))';
    expect(evaluate(pulse, {}, { ...environment, time: 0.5e-9 }).value).toBe(0);
    const t = 1.3e-9;
    expect(evaluate(pulse, {}, { ...environment, time: t }).value)
      .toBeCloseTo(2.5e-3 * (Math.exp(-(t - 1e-9) / 1e-10) - Math.exp(-(t - 1e-9) / 5e-10)), 15);
  });

  it('reports values ngspice cannot evaluate as range errors', () => {
    expect(() => evaluate('sqrt(v(x))', { x: -1 })).toThrow(BehavioralRangeError);
    expect(() => evaluate('log(v(x))', { x: -1 })).toThrow(BehavioralRangeError);
    // An IEEE overflow is not ngspice's HUGE (FLT_MAX) sentinel: ngspice-47
    // evaluates 10^400 to inf without "out of range" (#891).
    expect(evaluate('10^v(x)', { x: 400 }).value).toBe(Infinity);
  });

  it('differentiates ddt() like ngspice PTddt: a lagged backward difference', () => {
    const compiled = compileBehavioralExpression(parseBehavioralExpression('ddt(v(a))'));
    const gradient = new Float64Array(1);
    const at = (time: number, value: number, transient = true) =>
      compiled.evaluate([value], gradient, { time, transient, temperature: 27 });

    // Operating point and the start of the transient: 0.
    expect(at(0, 1, false)).toBe(0);
    expect(at(0, 1)).toBe(0);
    // The first two new timepoints only record history.
    expect(at(1e-3, 1)).toBe(0);
    expect(at(2e-3, 3)).toBe(0);
    // From the third timepoint: (arg(t3) - arg(t2)) / (t2 - t1).
    expect(at(3e-3, 7)).toBeCloseTo((7 - 3) / (2e-3 - 1e-3), 9);
    // Later Newton iterations at the same time keep the value.
    expect(at(3e-3, 100)).toBeCloseTo(4000, 9);
    // A rejected, shorter retry keeps it too.
    expect(at(2.5e-3, 100)).toBeCloseTo(4000, 9);
    expect(at(4e-3, 8)).toBeCloseTo((8 - 7) / (3e-3 - 2e-3), 9);
    expect(gradient[0]).toBe(0);
    // Outside transient analysis ddt is 0.
    expect(at(5e-3, 9, false)).toBe(0);
  });

  it('maps subcircuit-local node names without touching ground', () => {
    const mapped = mapBehavioralNodes(
      parseBehavioralExpression('v(1,2)+v(0) > 1 ? max(v(3),1) : !v(4)'),
      node => `x1.${node}`,
    );
    expect(compileBehavioralExpression(mapped).nodes).toEqual(['x1.1', 'x1.2', 'x1.3', 'x1.4']);
  });

  it('reads i() branch currents after the node voltages, with a unit derivative on the branch', () => {
    const compiled = compileBehavioralExpression(
      parseBehavioralExpression('v(a)*i(vx) + 2*i(vy)^2 - i(vx)'),
    );
    expect(compiled.nodes).toEqual(['a']);
    expect(compiled.sources).toEqual(['vx', 'vy']);
    const gradient = new Float64Array(3);
    // controls: [v(a), i(vx), i(vy)]
    expect(compiled.evaluate([3, 0.5, -2], gradient)).toBeCloseTo(3 * 0.5 + 2 * 4 - 0.5, 14);
    expect([...gradient]).toEqual([0.5, 3 - 1, 2 * 2 * -2]);
    const mapped = mapBehavioralNodes(
      parseBehavioralExpression('i(vx)+v(a)'), node => `x1.${node}`, source => `x1.${source}`,
    );
    expect(formatBehavioralExpression(mapped)).toBe('(i(x1.vx)+v(x1.a))');
  });

  it('formats every node kind back to an equivalent expression', () => {
    const text = '-v(a)^2 + (v(a,b) >= 1 && !(v(b) < 0) ? min(time, 2) : ddt(v(a)) / 3) - (-1) || 0';
    const formatted = formatBehavioralExpression(parseBehavioralExpression(text));
    const environment = { time: 0.5, transient: false, temperature: 27 };
    for (const voltages of [{ a: 2, b: 0.5 }, { a: -1, b: -3 }, { a: 0.1, b: 0 }]) {
      expect(evaluate(formatted, voltages, environment)).toEqual(evaluate(text, voltages, environment));
    }
  });

  it('parses I= and V= behavioral source cards with ASRC instance parameters', () => {
    const current = parseBehavioralSourceCard(
      'bl1 1 2 i=0.00025*tanh(v(1,2)/0.00025/2240)*(1+v(1,2)*0.027)', 4,
    );
    expect(current.name).toBe('bl1');
    expect(current.kind).toBe('current');
    expect(current.nodes).toEqual(['1', '2']);
    expect(current.params).toEqual({});
    expect(compileBehavioralExpression(current.expression).nodes).toEqual(['1', '2']);

    const voltage = parseBehavioralSourceCard('B2 22 0 v = ddt(V(2))/1000', 7);
    expect(voltage.kind).toBe('voltage');
    expect(voltage.nodes).toEqual(['22', '0']);

    const tc = parseBehavioralSourceCard('b3 3 0 v=v(1) tc1=0.001 TC2=1e-6 dtemp=5 reciproctc=1', 9);
    expect(tc.params).toEqual({ tc1: 0.001, tc2: 1e-6, dtemp: 5, reciproctc: true });
    expect(parseBehavioralSourceCard('b2 2 0 i=v(1) temp=50', 9).params).toEqual({ temp: 50 });
  });

  it('substitutes .param names, {expr} and quoted expressions like the ngspice front end', () => {
    const params = { A: 0.2, DELTAT: 1e-9, ALPHA: 1e-10, NEG: -2 };
    expect(substituteBehavioralParameters('B2 y 0 i=-(V(x) + a * v(y))', params))
      .toBe('B2 y 0 i=-(V(x) + 0.2 * v(y))');
    expect(substituteBehavioralParameters(
      "Bset1 1 0 I = ternary_fcn(TIME < 'deltat', 0, exp(-(TIME-'deltat')/'alpha'))", params,
    )).toBe('Bset1 1 0 I = ternary_fcn(TIME < 1e-9, 0, exp(-(TIME-1e-9)/1e-10))');
    expect(substituteBehavioralParameters('b1 1 0 v=neg^2*{a*10}', params)).toBe('b1 1 0 v=(-2)^2*2');
    // Node names, function names, numbers with suffixes and instance keywords are untouched.
    expect(substituteBehavioralParameters('b1 a 0 v=v(a,neg)*2a+i(a)+a(1) tc1=1', params))
      .toBe('b1 a 0 v=v(a,neg)*2a+i(a)+a(1) tc1=1');
    // Other cards are returned unchanged.
    expect(substituteBehavioralParameters('r1 a 0 a', params)).toBe('r1 a 0 a');
  });

  it.each([
    ['b1 1 0 i=i(v1,v2)', 'i() takes one source name'],
    ['b1 1 0 i=i()', 'i() takes one source name'],
    ['b1 1 0 i=a*2', "Unsupported behavioral expression token 'a'"],
    ['b1 1 0 V=~(~v(9)&v(8)) + 0.5', "Unsupported behavioral expression operator '~'"],
    ['b1 1 0 V=v(9)&v(8)', "Unsupported behavioral expression operator '&'"],
    ['b1 1 0 V=v(9)|', 'Unexpected end of behavioral expression'],
    ['b1 1 0 i=pwl(v(1),0,0,0,1)', 'ascending'],
    ['b1 1 0 i=pwl(v(1),0,0,1)', 'pairs'],
    ['b1 1 0 i=pwl(v(1),0,0,1,v(2))', 'literal'],
    ['b1 1 0 i=min(v(1))', 'min() takes two arguments'],
    ['b1 1 0 i=sqrt(v(1),2)', 'sqrt() takes one argument'],
    ['b1 1 0 i=ternary_fcn(1,2)', 'ternary_fcn() takes three arguments'],
    ['b1 1 0 i=v(1) ? 1', "Expected ':'"],
    ['b1 1 0 i=v(2) m=2', "Unsupported behavioral source parameter 'm'"],
    ['b1 1 0 i=v(2) tc1=x', "Behavioral source parameter 'tc1' needs a number"],
    ['b1 1 0 i=v(1,2,3)', 'v() takes one or two node names'],
    ['b1 1 0 i=(v(2)', "Expected ')'"],
    ['b1 1 0 q=v(2)', "expected 'I=<expression>' or 'V=<expression>'"],
    ['b1 1', 'B-card requires two nodes and an I= or V= expression'],
  ])('rejects %s explicitly', (raw, message) => {
    let error: unknown;
    try {
      parseBehavioralSourceCard(raw, 7);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ParseError);
    expect((error as Error).message).toContain(message);
  });
});
