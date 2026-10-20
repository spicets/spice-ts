import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { evaluateExpression } from './expression.js';

/**
 * #870: `.param f(args) = expr` function definitions and the three-argument
 * `limit(x, lo, hi)` clamp (ngspice-bugs #871 and #505).
 *
 * ngspice-47 inpcom.c inp_fix_macro_param_func_paren_io rewrites a `.param`
 * card whose first token holds `(` into a `.func` card. Expected currents are
 * the ngspice-47 operating point of these identical decks:
 *   HOME=<tmp with .spiceinit "set filetype=ascii"> ngspice -b -r out.raw deck.cir
 */
const FUNCTIONS_DECK = `param function definitions (issue 870)
.param a = 100
.param f(a,b) = 'a*b+1'
.param g(x)={2*x}
.param h(y) = 'g(y)+f(y,1)'
.subckt s n rr=10
.param k(x) = 'x*rr'
R1 n 0 {k(3)}
.ends
V1 n1 0 1
R1 n1 0 {f(2,3)}
V2 n2 0 1
R2 n2 0 {g(4)}
V3 n3 0 1
R3 n3 0 {h(5)}
V4 n4 0 1
X4 n4 s rr=5
V5 n5 0 1
X5 n5 s
V6 n6 0 1
R6 n6 0 {a+f(1,1)}
.op
.end
`;

/**
 * Native ngspice-47 numparam `limit(nominal, variation)` is a two-argument
 * random function: a third argument is silently dropped and the result is
 * `x +/- hi` at random (ngspice-bugs #505). The clamp is ngspice-47's
 * PSpice-compatibility `.func limit(x, a, b) { ternary_fcn(a > b,
 * max(min(x, a), b), max(min(x, b), a)) }` (inpcompat.c), which applies to the
 * whole deck with `set ngbehavior=psa`. Expected currents are that run's
 * operating point (deterministic over repeated runs; default mode is not).
 */
const LIMIT_DECK = `three-argument limit clamp (issue 870)
.subckt clamp n x=0.5
.param w=limit(x, 0, 1)
R1 n 0 {1k*(w+1)}
.ends
V1 a 0 1
X1 a clamp x=0.01
V2 b 0 1
X2 b clamp x=2
V3 c 0 1
X3 c clamp x=-1
V4 d 0 1
R4 d 0 {1k*limit(0.5, 1, 0)}
V5 e 0 1
R5 e 0 {1k*limit(3, 1, 2)}
V6 f 0 1
R6 f 0 {1k*limit(-3, 2, 1)}
.op
.end
`;

function expectCurrents(result: Awaited<ReturnType<typeof simulate>>, expected: Record<string, number>): void {
  for (const [source, current] of Object.entries(expected)) {
    expect(result.dc!.current(source), source).toBeCloseTo(current, 12);
  }
}

describe('.param function definitions with arguments (#870, ngspice-bugs #871)', () => {
  it('evaluates top-level and subcircuit-local .param functions like ngspice-47', async () => {
    const result = await simulate(FUNCTIONS_DECK);
    expectCurrents(result, {
      V1: -1.428571428571428e-1, // f(2,3) = 7
      V2: -1.25e-1, // g(4) = 8
      V3: -6.25e-2, // h(5) = g(5) + f(5,1) = 16
      V4: -6.666666666666667e-2, // k(3) with rr=5: 15
      V5: -3.333333333333333e-2, // k(3) with rr=10: 30
      V6: -9.803921568627451e-3, // a + f(1,1) = 102: formal `a` shadows the global
    });
  });

  it('binds formal arguments lexically over a same-named global (ngspice-47 #871 is defective here)', async () => {
    // ngspice-47 rewrites `.param k = 'temper+1'` into `.func k()` and substitutes it into
    // the body of twice(k): -i(V1) = 1/56. A formal argument shadows the global: 1/6.
    const result = await simulate(`temper capture
.param k = 'temper + 1'
.param twice(k) = '2*k'
R1 a 0 {twice(3)}
V1 a 0 1
.op
.end
`);
    expectCurrents(result, { V1: -1 / 6 });
  });

  it('keeps the formal argument when the global of the same name is unused and random', async () => {
    const result = await simulate(`arg capture
.param r1 = agauss(0, 1, 1)
.param choose_res(par, r1) = 'par < r1 ? 1 : 2'
R1 a 0 {choose_res(1e-7, 2e-7)}
V1 a 0 1
.op
.end
`);
    expectCurrents(result, { V1: -1 });
  });
});

describe('three-argument limit(x, lo, hi) clamp (#870, ngspice-bugs #505)', () => {
  it('clamps x between the two bounds in either order', () => {
    expect(evaluateExpression('limit(0.01, 0, 1)', {})).toBe(0.01);
    expect(evaluateExpression('limit(2, 0, 1)', {})).toBe(1);
    expect(evaluateExpression('limit(-1, 0, 1)', {})).toBe(0);
    expect(evaluateExpression('limit(0.5, 1, 0)', {})).toBe(0.5);
    expect(evaluateExpression('limit(-3, 2, 1)', {})).toBe(1);
  });

  it('supports the native random two-argument form (#1594)', () => {
    expect([0.9, 1.1]).toContain(evaluateExpression('limit(1, 0.1)', {}));
  });

  it('matches the ngspice-47 compatibility clamp in .param cards and subcircuits', async () => {
    const result = await simulate(LIMIT_DECK);
    expectCurrents(result, {
      V1: -9.900990099009901e-4, // w = 0.01: 1010 ohm
      V2: -5e-4, // w = 1: 2000 ohm
      V3: -1e-3, // w = 0: 1000 ohm
      V4: -2e-3, // limit(0.5, 1, 0) = 0.5
      V5: -5e-4, // limit(3, 1, 2) = 2
      V6: -1e-3, // limit(-3, 2, 1) = 1
    });
  });
});
