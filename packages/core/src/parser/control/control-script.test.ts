import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse, parseTitleless } from '../index.js';
import { simulate, simulateStream } from '../../simulate.js';
import { simulateProtocolV1, mapProtocolErrorV1 } from '../../protocol/adapter.js';
import { ControlScriptError, ControlScriptExitError, UnsupportedControlCommandError } from './errors.js';
import { evaluateVectorExpression, parseVectorExpression, type ExpressionEnvironment } from './vector-expression.js';
import { formatNumber, realVector, type ControlVector } from './vector.js';

/**
 * ngspice control-language scripting in `.control` blocks (#488).
 *
 * Control blocks marked "verbatim" are byte-identical excerpts of ngspice decks
 * from corpus-f batch 1 (ngspice `3ef069fb1f04177a153f342a32d941fc20ff047e`,
 * BSD-3-Clause; branch `wt/corpus-f-batch1-484`, `benchmarks/corpus/corpus-f/fixtures/<path>`).
 * Behaviour marked "ngspice-47" was observed with `ngspice -b` 47 on the stated
 * deck. Expected circuit values come from the same deck with its card edited,
 * never from constants tuned to spice-ts output.
 */

const divider = `R1 1 2 1k
R2 2 0 1k
VDD 1 0 DC 1`;

function evaluate(text: string, vectors: Record<string, ControlVector> = {}, degrees = false): ControlVector {
  const env: ExpressionEnvironment = {
    lookup: name => {
      const vector = vectors[name.toLowerCase()];
      if (!vector) throw new Error(`no such vector '${name}'`);
      return vector;
    },
    userFunction: () => undefined,
    degrees: () => degrees,
  };
  return evaluateVectorExpression(parseVectorExpression(text), env);
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

describe('control-language vector expressions', () => {
  it('evaluates ngspice operators with SPICE number suffixes and last-element extension', () => {
    expect(Array.from(evaluate('1k + 42m * 2').re)).toEqual([1000.084]);
    expect(Array.from(evaluate('10 - vector(3)').re)).toEqual([10, 9, 8]);
    // A shorter operand is extended with its last element.
    expect(Array.from(evaluate('vector(3) + unitvec(1)').re)).toEqual([1, 2, 3]);
    expect(Array.from(evaluate('-2^2').re)).toEqual([-4]);
    expect(Array.from(evaluate('7 % 4').re)).toEqual([3]);
  });

  it('builds complex numbers with the comma operator and indexes ranges (ngspice-47: z[1,2] of 10 - vector(3) is 9 8)', () => {
    const value = evaluate('(0,2) * pi', { pi: realVector('pi', [Math.PI]) });
    expect(Array.from(value.re)).toEqual([0]);
    expect(Array.from(value.im!)).toEqual([2 * Math.PI]);
    expect(Array.from(evaluate('z[1,2]', { z: realVector('z', [10, 9, 8]) }).re)).toEqual([9, 8]);
    expect(Array.from(evaluate('z[2]', { z: realVector('z', [10, 9, 8]) }).re)).toEqual([8]);
    expect(() => evaluate('z[3]', { z: realVector('z', [10, 9, 8]) })).toThrow('out of range');
  });

  it('evaluates relational, logical and ternary operators in every ngspice spelling (examples/control_structs/new-check-4.sp)', () => {
    const vectors = { const0: realVector('const0', [0]), const5: realVector('const5', [5]), const6: realVector('const6', [6]) };
    for (const condition of [
      'const5 < const6', 'const6 > const5', 'const5 >= const5', 'const5 <= const5', 'const5 = const5',
      'const6 <> const5', 'const6 >< const5', 'const5 & const5', 'const0 | const5', '~ const0',
      'const5 lt const6', 'const6 gt const5', 'const5 eq const5', 'const6 ne const5', 'not const0',
    ]) {
      expect(Array.from(evaluate(condition, vectors).re), condition).toEqual([1]);
    }
    expect(Array.from(evaluate('const0 ? const5 : const6', vectors).re)).toEqual([6]);
    expect(Array.from(evaluate('(1 ? 1 : 1) eq 1').re)).toEqual([1]);
  });

  it('applies ngspice math functions: log10 is base 10, nint rounds half to even (ngspice-47: nint(2.5) is 2)', () => {
    expect(evaluate('log10(1000)').re[0]).toBeCloseTo(3, 15);
    expect(evaluate('ln(e)', { e: realVector('e', [Math.E]) }).re[0]).toBeCloseTo(1, 15);
    expect(Array.from(evaluate('nint(2.5)').re)).toEqual([2]);
    expect(Array.from(evaluate('nint(3.5)').re)).toEqual([4]);
    expect(evaluate('db(10)').re[0]).toBeCloseTo(20, 12);
    const root = evaluate('sqrt(-4)');
    expect([root.re[0], root.im![0]]).toEqual([0, 2]);
    expect(evaluate('ph((0,1))', {}, true).re[0]).toBeCloseTo(90, 12);
    expect(evaluate('ph((0,1))').re[0]).toBeCloseTo(Math.PI / 2, 12);
    expect(evaluate('atanh(0.5)').re[0]).toBeCloseTo(Math.atanh(0.5), 15);
    expect(Array.from(evaluate('vecmax(abs(z))', { z: realVector('z', [-3, 2]) }).re)).toEqual([3]);
    expect(Array.from(evaluate('length(z)', { z: realVector('z', [-3, 2]) }).re)).toEqual([2]);
  });

  /*
   * PR #584 review blockers. Every expected value below was printed by
   * `ngspice -b benchmarks/control-language-488/probes.cir` (ngspice-47) as
   * `echo <label> $&c` after `let c = <expression>`; see the README there.
   */
  it('log() is the natural logarithm (ngspice-47: log(100) prints 4.60517)', () => {
    expect(evaluate('log(100)').re[0]).toBeCloseTo(4.60517, 5);
    expect(evaluate('log(100)').re[0]).toBe(Math.log(100));
    expect(evaluate('log(e)', { e: realVector('e', [Math.E]) }).re[0]).toBeCloseTo(1, 15);
    expect(evaluate('log10(100)').re[0]).toBe(2);
    // ngspice-47: "argument out of range for log" / "for log10"; ln(-1) likewise.
    expect(() => evaluate('log(-1)')).toThrow('argument out of range for log');
    expect(() => evaluate('ln(-1)')).toThrow(/argument out of range for log$/);
    expect(() => evaluate('log10(-1)')).toThrow('argument out of range for log10');
  });

  /*
   * #606. ngspice-47 src/maths/cmaths/cmath1.c: cx_log/cx_log10 rcheck(x >= 0)
   * and return -log(HUGE) / -log10(HUGE) for a zero magnitude (HUGE is FLT_MAX
   * on the reference build); the complex branch's imaginary part is
   * atan2(im, re) for log10 too, not divided by ln 10. cx_db rcheck(x > 0), so
   * db(0) is an error. Values printed by `ngspice -b` 47 for
   * `let c = <expr>` / `print c` (deck in PR for #606).
   */
  it('clamps ln/log/log10 of zero like ngspice-47 cx_log/cx_log10 (#606)', () => {
    for (const text of ['ln(0)', 'log(0)']) {
      // ngspice-47: c = -8.87228e+01
      expect(evaluate(text).re[0], text).toBe(-Math.log(3.4028234663852886e38));
      expect(evaluate(text).re[0], text).toBeCloseTo(-88.7228, 4);
      expect(evaluate(text).im, text).toBeUndefined();
    }
    // ngspice-47: c = -3.85318e+01
    expect(evaluate('log10(0)').re[0]).toBe(-Math.log10(3.4028234663852886e38));
    expect(evaluate('log10(0)').re[0]).toBeCloseTo(-38.5318, 4);
    // ngspice-47: ln(vector(3)) prints -88.7228 0 0.693147; log10 -38.5318 0 0.30103.
    expect(Array.from(evaluate('ln(vector(3))').re)).toEqual([-Math.log(3.4028234663852886e38), 0, Math.log(2)]);
    expect(Array.from(evaluate('log10(vector(3))').re)).toEqual([-Math.log10(3.4028234663852886e38), 0, Math.log10(2)]);
    // ngspice-47: ln(0,0) -> -8.87228e+01,0.000000e+00; log10(0,0) -> -3.85318e+01,0.000000e+00.
    const lnZero = evaluate('ln(0,0)');
    expect([lnZero.re[0], lnZero.im![0]]).toEqual([-Math.log(3.4028234663852886e38), 0]);
    const log10Zero = evaluate('log10(0,0)');
    expect([log10Zero.re[0], log10Zero.im![0]]).toEqual([-Math.log10(3.4028234663852886e38), 0]);
    // ngspice-47: ln(1e-300) -> -6.90776e+02, log10(1e-300) -> -3.00000e+02 (no clamp above zero).
    expect(evaluate('ln(1e-300)').re[0]).toBe(Math.log(1e-300));
    expect(evaluate('log10(1e-300)').re[0]).toBe(Math.log10(1e-300));
  });

  it('log10 of a complex argument keeps atan2 as its imaginary part like ngspice-47 cx_log10 (#606)', () => {
    // ngspice-47: ln(-1,0) and log10(-1,0) both print 0.000000e+00,3.141593e+00.
    const ln = evaluate('ln(-1,0)');
    expect([ln.re[0], ln.im![0]]).toEqual([0, Math.PI]);
    const log10 = evaluate('log10(-1,0)');
    expect([log10.re[0], log10.im![0]]).toEqual([0, Math.PI]);
    const tenJ = evaluate('log10(0,10)');
    expect([tenJ.re[0], tenJ.im![0]]).toEqual([1, Math.PI / 2]);
  });

  it('rejects db() of a zero or negative real and of a zero magnitude like ngspice-47 cx_db (#606)', () => {
    // ngspice-47: "Error: argument out of range for db" for each of these.
    for (const text of ['db(0)', 'db(-2)', 'db(vector(3))', 'db(0,0)']) {
      expect(() => evaluate(text), text).toThrow(/argument out of range for db$/);
    }
    // ngspice-47: db(2) and db(-2,0) both print 6.0206 (complex uses the magnitude).
    expect(evaluate('db(2)').re[0]).toBe(20 * Math.log10(2));
    expect(evaluate('db(-2,0)').re[0]).toBe(20 * Math.log10(2));
  });

  it('% is the integer modulo of floor(|a|) and floor(|b|) (ngspice-47 cx_mod)', () => {
    // ngspice-47: -7%3 -> 1, 7.5%2 -> 1, 5.9%2.9 -> 1, 7%-3 -> 1, -7.5%-2 -> 1, 7%4 -> 3.
    for (const [text, expected] of [
      ['-7%3', 1], ['7.5%2', 1], ['5.9%2.9', 1], ['7%-3', 1], ['-7.5%-2', 1], ['7 % 4', 3],
    ] as const) {
      expect(Array.from(evaluate(text).re), text).toEqual([expected]);
    }
    // ngspice-47: 5 % 0.5 -> "argument out of range for mod" (floor(0.5) is 0).
    expect(() => evaluate('5 % 0.5')).toThrow('argument out of range for mod');
  });

  it('not/~ takes everything above the comparisons as its operand (ngspice-47 parse-bison.y precedence)', () => {
    // ngspice-47 values; `~` sits between the comparisons and `,` in the grammar.
    for (const [text, expected] of [
      ['not 0 + 1', 0], ['not 1 - 1', 1], ['~0 + 1', 0], ['not 0 * 5', 1], ['not 1 > 0', 0],
      ['not 0 & 0', 0], ['2 + not 0', 3], ['not 0 ^ 2', 1], ['- not 0 + 1', -0], ['not 0 < 2', 1],
      ['not 0 = 0', 0], ['not 5 = 0', 1], ['not 0 | 0', 1], ['not 0 ? 7 : 9', 7], ['not 0 * 0 + 1', 0],
      ['1 + not 0 * 0', 2], ['1 < not 0 + 1', 0], ['not not 0 + 1', 1], ['not 0 , 1', 0], ['(not 0) , 1', 1],
    ] as const) {
      expect(Array.from(evaluate(text).re), text).toEqual([expected]);
    }
  });

  it('the comma binds tighter than comparisons and looser than + (ngspice-47 parse-bison.y)', () => {
    const parts = (text: string): [number, number] => {
      const value = evaluate(text);
      return [value.re[0], value.im ? value.im[0] : 0];
    };
    // ngspice-47: `echo $&c $&d` with d = imag(c).
    expect(parts('1 + 2 , 3')).toEqual([3, 3]);
    expect(parts('2 , 3 + 1')).toEqual([2, 4]);
    expect(parts('- 2 , 3')).toEqual([-2, 3]);
    expect(parts('2 * 2 , 3')).toEqual([4, 3]);
    expect(parts('2 , 3 * 2')).toEqual([2, 6]);
    expect(evaluate('1 < 2 , 3').re[0]).toBe(1);
    // A built-in function applied to a comma expression sees one complex argument: mag(3,4) -> 5.
    expect(Array.from(evaluate('mag(3,4)').re)).toEqual([5]);
  });

  it('! is not a control-language operator (ngspice-47: RHS "!0 + 1" invalid)', () => {
    expect(() => evaluate('!0 + 1')).toThrow("unexpected character '!'");
  });

  it('names an unevaluated function instead of guessing (deriv)', () => {
    expect(() => evaluate('deriv(z)', { z: realVector('z', [1, 2]) })).toThrow("vector function 'deriv()'");
  });

  it('formats $&vector values like C %g with 6 digits (ngspice-47: 1/3 prints 0.333333)', () => {
    expect(formatNumber(1 / 3)).toBe('0.333333');
    expect(formatNumber(1000)).toBe('1000');
    expect(formatNumber(2.22044604925031e-16)).toBe('2.22045e-16');
    expect(formatNumber(1e6)).toBe('1e+06');
    expect(formatNumber(123456789, 15)).toBe('123456789');
  });
});

describe('.control script interpreter (#488)', () => {
  it('runs a while loop of alter + run and then the deck card once more (examples/various/param_sweep.cir, verbatim)', async () => {
    const control = `.control
let start_r = 1k
let stop_r = 10k
let delta_r = 1k
let r_act = start_r
* loop
while r_act le stop_r
  alter r1 r_act
  run
  write dc-sweep.out v(2)
  set appendwrite
  let r_act = r_act + delta_r
end
plot dc1.v(2) dc2.v(2) dc3.v(2) dc4.v(2) dc5.v(2)
+ dc6.v(2) dc7.v(2) dc8.v(2) dc9.v(2) dc10.v(2)
.endc`;
    const result = await simulate(`parameter sweep\n${divider}\n.dc VDD 0 1 .1\n${control}\n.end`);
    expect(result.control!.runs.map(run => run.plot)).toEqual(
      ['dc1', 'dc2', 'dc3', 'dc4', 'dc5', 'dc6', 'dc7', 'dc8', 'dc9', 'dc10'],
    );
    for (const [index, run] of result.control!.runs.entries()) {
      const edited = await simulate(`edited\n${divider.replace('R1 1 2 1k', `R1 1 2 ${index + 1}k`)}\n.dc VDD 0 1 .1`);
      expect(run.result.dcSweep!.voltage('2')).toEqual(edited.dcSweep!.voltage('2'));
    }
    // ngspice-47 runs the deck's .dc once more after the script, with R1 still altered to 10k.
    const last = await simulate(`edited\n${divider.replace('R1 1 2 1k', 'R1 1 2 10k')}\n.dc VDD 0 1 .1`);
    expect(result.dcSweep!.voltage('2')).toEqual(last.dcSweep!.voltage('2'));
  });

  it('names plots like ngspice-47 and resolves let vectors in the current plot then const', async () => {
    // ngspice-47 on this control block prints: const, op1, dc1, op2, unknown2, then 2, 2 and 7 for a.
    const result = await simulate(`plots
${divider.replace('DC 1', 'DC 1 ac 1')}
.control
echo start $curplot
let a = 1
op
echo $curplot
dc vdd 0 1 0.5
echo $curplot
destroy dc1
op
echo $curplot
let a = a + 1
setplot new
echo $curplot
setplot op1
echo $&a
let a[0] = 7
setplot const
echo $&a
noise v(2) vdd dec 1 1 10
echo $curplot
.endc`);
    expect(result.control!.output).toEqual(['start const', 'op1', 'dc1', 'op2', 'unknown2', '2', '7', 'noise3']);
    expect(result.control!.runs.map(run => run.plot)).toEqual(['op1', 'dc1', 'op2', 'noise2']);
  });

  it('does not see a let vector of another plot without qualification (ngspice-47: RHS "a" invalid)', async () => {
    const error = await rejection(simulate(`plots\n${divider}\n.control\nop\nsetplot new\nlet a = 2\nsetplot op1\nlet b = a\n.endc`));
    expect(error).toBeInstanceOf(ControlScriptError);
    expect(error.message).toContain("no such vector 'a'");
    expect((error as ControlScriptError).line).toBe(10);
  });

  it('substitutes $var, {$var}, $&vector, $?var and foreach lists, and reads node vectors (tests/regression/lib-processing/scope-1.cir, verbatim)', async () => {
    const control = `.control

define mismatch(a,b,err) abs(a-b)>err

op

let total_count = 0
let fail_count = 0

let tests = 1001 + vector(2)

foreach n $&tests
  set n_test = "n{$n}_t"
  set n_gold = "n{$n}_g"
  if mismatch(v($n_test), v($n_gold), 1e-9)
    let v_test = v($n_test)
    let v_gold = v($n_gold)
    echo "ERROR, test failure, v($n_test) = $&v_test but should be $&v_gold"
    let fail_count = fail_count + 1
  end
  let total_count = total_count + 1
end

if fail_count > 0
  echo "ERROR: $&fail_count of $&total_count tests failed"
  quit 1
else
  echo "INFO: $&fail_count of $&total_count tests failed"
  quit 0
end

.endc`;
    const circuit = (test: string) => `self check
.param gold = 2
v1001_t n1001_t 0 {gold}
v1001_g n1001_g 0 2
v1002_t n1002_t 0 ${test}
v1002_g n1002_g 0 3
${control}`;
    const passed = await simulate(circuit('3'));
    expect(passed.control!.quit).toBe(true);
    expect(passed.control!.output).toEqual(['INFO: 0 of 2 tests failed']);
    expect(passed.dc!.voltage('n1001_t')).toBe(2);

    const failed = await rejection(simulate(circuit('-3')));
    expect(failed).toBeInstanceOf(ControlScriptExitError);
    expect((failed as ControlScriptExitError).exitCode).toBe(1);
    expect((failed as ControlScriptExitError).output).toEqual([
      'ERROR, test failure, v(n1002_t) = -3 but should be 3',
      'ERROR: 1 of 2 tests failed',
    ]);
  });

  it('alters a PULSE source with a value list and reads it back (tests/regression/misc/alter-vec.cir, verbatim control)', async () => {
    const control = `.control

op

let vec1 = @v1[pulse]
compose gold1 values -1 2 3m 4u 5u 6m 7m
let err1 = vecmax(abs(vec1/gold1 - 1))

alter @v1[pulse] = [ 2 5 11n 12n 13n 54n 105n ]

let vec2 = @v1[pulse]
compose gold2 values 2 5 11n 12n 13n 54n 105n
let err2 = vecmax(abs(vec2/gold2 - 1))

echo "Note: err1 = " $&err1
echo "Note: err2 = " $&err2

let success = 0

if err1 > 1e-15
  echo "ERROR: test1 failed, excessive error"
else
  let success = success + 1
end

if err2 > 1e-15
  echo "ERROR: test2 failed, excessive error"
else
  let success = success + 1
end

if success eq 2
   echo "INFO: success"
   quit 0
else
   quit 1
end

.endc`;
    const result = await simulate(`alter vector\nv1 1 0 pulse(-1 2 3m 4u 5u 6m 7m)\nr1 1 0 1k\n${control}`);
    expect(result.control!.output.at(-1)).toBe('INFO: success');
  });

  it('gives alter and altermod the effect of editing the card', async () => {
    const mos = (vto: string, w: string) => `alter mos
M1 d g 0 0 nch W=${w} L=1u
VD d 0 2
VG g 0 1.5
.model nch nmos level=1 vto=${vto} kp=100u`;
    const altered = await simulate(`${mos('0.5', '10u')}\n.control\naltermod nch vto = 0.7\nalter @m1[w]=20u\nop\n.endc`);
    const edited = await simulate(`${mos('0.7', '20u')}\n.op`);
    expect(altered.dc!.current('VD')).toBe(edited.dc!.current('VD'));

    const source = await simulate(`alter source\nV1 1 0 DC 1\nR1 1 2 1k\nC1 2 0 1u\n.control\nalter v1 dc = 2\nalter v1 ac = 3\nop\nac dec 2 10 1k\n.endc`);
    const sourceEdited = await simulate(`edited\nV1 1 0 DC 2 AC 3\nR1 1 2 1k\nC1 2 0 1u\n.op\n.ac dec 2 10 1k`);
    expect(source.dc!.voltage('2')).toBe(sourceEdited.dc!.voltage('2'));
    expect(source.ac!.voltage('2')).toEqual(sourceEdited.ac!.voltage('2'));
  });

  it('leaves the caller\'s Circuit untouched: alter, altermod and option, parsed once, simulated twice', async () => {
    const circuit = parse(`idempotent
M1 d g 0 0 nch W=10u L=1u
VD d 0 2
VG g 0 1.5
R1 d 0 1k
V2 p 0 pulse(0 1 1n 1n 1n 5n 10n)
R2 p 0 1k
.model nch nmos level=1 vto=0.5 kp=100u
.control
op
let i1 = -i(vd)
let w = @m1[w]
let vto = @nch[vto]
let r = @r1[resistance]
let v2 = @v2[pulse]
let v2high = v2[1]
echo first $&i1 $&w $&vto $&r $&v2high
altermod nch vto = 0.7
alter @m1[w] = 20u
alter r1 2k
alter vd dc = 3
alter @v2[pulse] = [ 0 2 1n 1n 1n 5n 10n ]
option gmin=1e-10
op
let i2 = -i(vd)
echo second $&i2
.endc`);
    const snapshot = JSON.stringify([circuit.parameterVector('M1', 'W'), circuit.parameterVector('nch', 'VTO'),
      circuit.parameterVector('R1', 'R'), circuit.parameterVector('VD', 'DC'), circuit.parameterVector('V2', 'PULSE'),
      circuit.simulationOptions]);
    const first = await simulate(circuit);
    const second = await simulate(circuit);
    expect(second.control!.output).toEqual(first.control!.output);
    expect(second.dc!.current('VD')).toBe(first.dc!.current('VD'));
    expect(first.control!.output[0].split(' ').slice(2)).toEqual(['1e-05', '0.5', '1000', '1']);
    expect(JSON.stringify([circuit.parameterVector('M1', 'W'), circuit.parameterVector('nch', 'VTO'),
      circuit.parameterVector('R1', 'R'), circuit.parameterVector('VD', 'DC'), circuit.parameterVector('V2', 'PULSE'),
      circuit.simulationOptions])).toBe(snapshot);
    // A plain simulation of the same deck without its script still sees the original cards.
    const plain = await simulate(`plain
M1 d g 0 0 nch W=10u L=1u
VD d 0 2
VG g 0 1.5
R1 d 0 1k
.model nch nmos level=1 vto=0.5 kp=100u
.op`);
    const firstRun = first.control!.runs[0].result;
    expect(firstRun.dc!.current('VD')).toBe(plain.dc!.current('VD'));
  });

  it.each(['let bad = 1 / 0', 'quit 1'])('restores control edits after failure: %s', async ending => {
    const circuit = parse(`restore after error
V1 1 0 1
R1 1 0 1k
.control
alter r1 2k
option gmin=1e-10
${ending}
.endc`);
    const options = circuit.simulationOptions;
    await expect(simulate(circuit)).rejects.toThrow();
    expect(circuit.parameterVector('R1', 'R')).toEqual([1000]);
    expect(circuit.simulationOptions).toEqual(options);
  });

  it('keeps user function comma arguments and built-in complex operands distinct', async () => {
    const result = await simulate(`functions
V1 1 0 1
R1 1 0 1k
.control
define f(x,y) x+y
let a = f(1+2,3*4)
let b = mag(3,4)
let c = real(log(3,4))
let d = imag(log(3,4))
echo $&a $&b $&c $&d
quit
.endc`);
    expect(result.control!.output).toEqual(['15 5 1.60944 0.927295']);
  });

  it('runs each foreach value through alter and an analysis (examples/control_structs/foreach_bjt_ft.sp control shape)', async () => {
    const result = await simulate(`foreach\nIC 0 2 1m\nR1 2 0 1k\n.control\nforeach myic 0.5e-3 1e-3 5e-3\n alter ic = $myic\n op\nend\n.endc`);
    // IC 0 2 drives its current into node 2: V(2) = I * 1k.
    expect(result.control!.runs.map(run => run.result.dc!.voltage('2'))).toEqual([0.5, 1, 5].map(value =>
      expect.closeTo(value, 12)));
  });

  it('keeps vector arithmetic on analysis results, including complex AC vectors (examples/various/gain_stage.cir control shape)', async () => {
    const result = await simulate(`ac\nV1 1 0 DC 0 AC 1\nR1 1 2 1k\nC1 2 0 1u\n.control
ac dec 10 100 1000Meg
let flen = length(frequency) $ length of the vector
let loopcounter = 0
let worst = 0
while loopcounter lt flen
  let vout2 = v(2)[loopcounter]  $ generate a single point complex vector
  let gain = mag(vout2)
  let expected = 1/sqrt(1 + (2*pi*frequency[loopcounter]*1k*1u)^2)
  let err = vecmax(abs(gain - expected))
  if err > worst
    let worst = err
  end
  let loopcounter = loopcounter + 1
end
echo $&flen $&worst
.endc`);
    const [points, worst] = result.control!.output[0].split(' ').map(Number);
    expect(points).toBe(result.ac!.frequencies.length);
    expect(worst).toBeLessThan(1e-12);
  });

  it('labels noise plots and keeps the integrated plot current (examples/various/bjtnoise.cir control shape)', async () => {
    const result = await simulate(`noise\nV1 1 0 DC 0 AC 1\nR1 1 2 1k\nR2 2 0 1k\n.noise v(2) V1 dec 2 1 100\n.control
run
setplot
setplot noise1
let spectrum = length(onoise_spectrum)
setplot noise2
print all
echo $&noise1.spectrum $&onoise_total
.endc`);
    const reference = await simulate('ref\nV1 1 0 DC 0 AC 1\nR1 1 2 1k\nR2 2 0 1k\n.noise v(2) V1 dec 2 1 100');
    const [points, total] = result.control!.output[0].split(' ').map(Number);
    expect(points).toBe(reference.noise!.frequencies.length);
    expect(total).toBeCloseTo(reference.noise!.integratedOutputNoise!, 10);
  });

  it('keeps {$var} and "$var" control text away from the .param preprocessor and comment stripping', async () => {
    const result = await simulate(`braces\n.param r = 2k\nR1 1 2 {r}\nR2 2 0 1k\nVDD 1 0 DC 3\n.control
set nn = 2 ; a comment
op $ another comment
let x{$nn} = v($nn)
echo "{$nn}: $&x2" $?nn $?missing
.endc`);
    expect(result.control!.output).toEqual(['2: 1 1 0']);
  });

  it('honours if $?batchmode like ngspice -b (examples/control_structs/if-batchmode.cir, verbatim control)', async () => {
    const result = await simulate(`batch\n${divider}\n.op\n.control

if $?batchmode
  echo "Info: batchmode has been set by command line option -b"
  echo
else
  echo "Info: batchmode has not been set"
  echo
  unset ngdebug
  tran 100u 10m uic
  plot v(2)
end

.endc`);
    expect(result.control!.output[0]).toBe('Info: batchmode has been set by command line option -b');
    expect(result.control!.runs).toEqual([]);
    expect(result.dc!.voltage('2')).toBe(0.5);
  });

  it('rejects an unexecuted command anywhere in the script at parse time, with its line', () => {
    let error: unknown;
    try {
      parse(`deck\n${divider}\n.control\nop\nif 0\n  spec 10 1000 10 v(2)\nend\n.endc`);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UnsupportedControlCommandError);
    expect((error as UnsupportedControlCommandError).command).toBe('spec');
    expect((error as UnsupportedControlCommandError).line).toBe(8);
    expect(() => parseTitleless('.control\nif 1\nop\n.endc')).toThrow("block is missing its closing 'end'");
  });

  it.each([
    ['alter x1.r1 2k', 'alter', 'no device named'],
    ['op\nlet g = @r1[p]', 'let', "'@r1[p]' is not available"],
    ['op\nlet tmp = v(2) > file', 'let', 'redirection'],
    ['op\nlet d = deriv(v(2))', 'let', "'deriv()'"],
    ['op\nrun out.raw', 'run', 'raw file'],
    ['repeat\nop\nend', 'repeat', 'unbounded'],
  ])('rejects an unsupported form when it runs: %s', async (control, command, reason) => {
    const error = await rejection(simulate(`deck\n${divider}\n.control\n${control}\n.endc`));
    expect(error).toBeInstanceOf(UnsupportedControlCommandError);
    expect((error as UnsupportedControlCommandError).command).toBe(command);
    expect(error.message).toContain(reason);
  });

  it.each(['v1', 'i1'])('saves the swept %s DC parameter as a plot vector', async source => {
    const result = await simulate(`saves
${source} 1 0 0
r1 1 0 1k
.control
save @${source.toUpperCase()}[DC]
dc ${source} 0 1 250m
let foo = @${source}[dc]
let bar = foo[2]
let baz = @${source}[dc][2]
let two = 2
let argh = foo[two]
echo $&foo
echo $&bar $&baz $&argh
dc ${source} 1 0 -500m
echo $&@${source}[dc]
setplot dc1
let old = @${source}[dc][2]
echo $&old
.endc`);
    expect(result.control!.output).toEqual(['0 0.25 0.5 0.75 1', '0.5 0.5 0.5', '1 0.5 0', '0.5']);
  });

  it.each(['@v1[acmag]', '@r1[resistance]', '@v2[dc]'])('rejects unproduced saved vector %s', async vector => {
    const error = await rejection(simulate(`saves\nv1 1 0 0\nv2 2 0 2\nr1 1 0 1k\n.control\nsave ${vector}\ndc v1 0 1 250m\nlet foo = ${vector}\n.endc`));
    expect(error).toBeInstanceOf(UnsupportedControlCommandError);
    expect(error.message).toContain(`saved device-parameter vector '${vector}'`);
  });

  it('runs the unchanged bugs-2.cir parser regression with no failed checks', async () => {
    const deck = readFileSync(new URL(
      '../../../../../benchmarks/corpus/corpus-f/fixtures/tests/regression/misc/bugs-2.cir', import.meta.url,
    ), 'utf8');
    const result = await simulate(deck);
    expect(result.control!.output).toEqual(['INFO: 0 tests failed']);
  });

  it('saves both source parameters in a nested DC sweep', async () => {
    const result = await simulate(`nested saves
v1 1 0 0
i1 1 0 0
r1 1 0 1k
.control
save @v1[dc] @i1[dc]
dc v1 0 1 500m i1 0 1 1
let primary = @v1[dc]
let secondary = @i1[dc]
echo $&primary
echo $&secondary
.endc`);
    expect(result.control!.output).toEqual(['0 0.5 1 0 0.5 1', '0 0 0 1 1 1']);
  });

  it('keeps the protocol and streaming APIs bounded by rejecting interpreted scripts', async () => {
    const source = `${divider}\n.control\nlet x = 1\nop\n.endc`;
    const error = await rejection(simulateProtocolV1({ apiVersion: '1', input: { format: 'spice', source } }));
    expect(mapProtocolErrorV1(error).code).toBe('UNSUPPORTED_FEATURE');

    const stream = simulateStream(`deck\n${source}`);
    await expect(stream.next()).rejects.toThrow("does not support '.control' analysis");
  });
});
