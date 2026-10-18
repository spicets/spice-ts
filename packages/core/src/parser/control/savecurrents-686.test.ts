import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { UnsupportedControlCommandError } from './errors.js';

/**
 * #686: `set savecurrents` and `@dev[i]` / `@dev[current]` readouts in `.control`.
 *
 * ngspice-47 semantics (src/frontend/inp.c inp_savecurrents, frontend/variable.c
 * cp_vset, spicelib/devices/{res/resask.c,isrc/isrcask.c,isrc/isrcload.c,
 * asrc/asrcask.c,vsrc/vsrcask.c}):
 *
 * - `savecurrents` is not a circuit option (cktsopt.c has no such entry), and
 *   inp_savecurrents only reads the deck's `.option` cards before the
 *   circuit is loaded. In a `.control` section `set savecurrents` therefore
 *   only sets a front-end variable; no `@dev[i]` vectors are added to plots.
 * - An `@dev[param]` name not in the current plot is asked of the device in
 *   the circuit's present state (the last solution of the last analysis): a
 *   one-element vector. R `i` = (V+ - V-) * RESconduct, I `current` =
 *   ISRCcurrent (M * value at the last load), B `i` = ASRCprev_value * M for
 *   the I= form or the branch current for V=, V `i` = the branch current.
 *
 * Expected values were observed with `ngspice -b` 47 on the decks below.
 */

// corpus-f tests/regression/misc/convergence.cir (ngspice, BSD-3-Clause) with
// the `µ` scale suffix spelled `u`: µ parsing is #508 / PR #685.
const convergence = `* Branch currents should settle in this behavioural model of a diode

.options noacct
.options reltol=0.001 abstol=1e-12; defaults as of 2024

I2 0 N01 pulse 2u 20u 50n 50n 50n 1u 2u
R2 N01 0 50K
.param VT=26m
.param Isat=1e-14
B2 N01 0 I=Isat*(exp(v(N01)/VT)-1)

.control
set savecurrents
tran 10n 5u
let residual = @I2[current] - @B2[i] - @R2[i]

* error in current sum at a node should be
* less than RELTOL times the 20-uA currents,
* which is 20 nA, plus ABSTOL
if vecmax(abs(residual)) > 20.001e-9
  echo "ERROR: B-device convergence failed"
  quit 1
else
  echo "INFO: success"
  quit 0
end
.endc
.end`;

const readouts = `* op readout
V1 1 0 dc 2
R1 1 2 1k
R2 2 0 2k m=2
I1 0 2 dc 1m
B1 2 0 I=v(2)*v(2)*1m
.control
set savecurrents
op
let ir1 = @r1[i]
let ir2 = @r2[i]
let iv1 = @v1[i]
let ii1 = @i1[current]
let ib1 = @b1[i]
set numdgt=12
echo ir1 $&ir1
echo ir2 $&ir2
echo iv1 $&iv1
echo ii1 $&ii1
echo ib1 $&ib1
dc v1 0 3 1
let sr1 = @r1[i]
let sb1 = @b1[i]
let si1 = @i1[current]
echo sr1 $&sr1
echo sb1 $&sb1
echo si1 $&si1
quit 0
.endc
.end`;

function controlValue(output: string[], name: string): number {
  const line = output.find(entry => entry.startsWith(`${name} `));
  if (!line) throw new Error(`no echo for ${name} in ${JSON.stringify(output)}`);
  return Number(line.split(' ')[1]);
}

describe('#686 set savecurrents and @dev[i]/@dev[current] readouts (ngspice-47)', () => {
  it('treats set savecurrents in .control as a front-end variable, not a circuit option', async () => {
    const result = await simulate(`savecurrents variable
V1 1 0 1
R1 1 0 1k
.control
set savecurrents
if $?savecurrents
  echo "set"
end
op
quit 0
.endc
.end`);
    expect(result.control!.output).toEqual(['set']);
    expect(result.control!.quit).toBe(true);
  });

  it('runs corpus-f misc/convergence.cir: KCL residual of @I2[current] - @B2[i] - @R2[i] is ~0 like ngspice-47', async () => {
    const deck = convergence.replace('let residual', 'let a = @I2[current]\nlet b = @B2[i]\nlet r = @R2[i]\nlet residual')
      // A replacer function: `$&` in a replacement string is the matched text.
      .replace('if vecmax', () => 'set numdgt=12\necho a $&a\necho b $&b\necho r $&r\nlet res = vecmax(abs(residual))\necho res $&res\nif vecmax');
    const result = await simulate(deck);
    const { output } = result.control!;
    expect(output.at(-1)).toBe('INFO: success');
    expect(result.control!.quit).toBe(true);
    // ngspice-47: tran1.a = 2.000000e-05, tran1.b = 9.263674e-06, @r2[i] = 1.073633e-05, residual 2.2e-20.
    expect(controlValue(output, 'a')).toBeCloseTo(2e-5, 12);
    expect(controlValue(output, 'b') / 9.263674e-6).toBeCloseTo(1, 5);
    expect(controlValue(output, 'r') / 1.073633e-5).toBeCloseTo(1, 5);
    expect(Math.abs(controlValue(output, 'res'))).toBeLessThan(1e-15);
  });

  it('runs the convergence deck unchanged apart from the u suffix and prints INFO: success', async () => {
    const result = await simulate(convergence);
    expect(result.control!.output).toEqual(['INFO: success']);
    expect(result.control!.quit).toBe(true);
  });

  it('reads R, V, I and B currents after op and after the last dc sweep point like ngspice-47', async () => {
    const { output } = (await simulate(readouts)).control!;
    // ngspice-47 op: 0.001 0.001 -0.001 0.001 0.001 (v(2) = 1).
    expect(controlValue(output, 'ir1')).toBeCloseTo(1e-3, 12);
    expect(controlValue(output, 'ir2')).toBeCloseTo(1e-3, 12);
    expect(controlValue(output, 'iv1')).toBeCloseTo(-1e-3, 12);
    expect(controlValue(output, 'ii1')).toBeCloseTo(1e-3, 12);
    expect(controlValue(output, 'ib1')).toBeCloseTo(1e-3, 9);
    // ngspice-47 after `dc v1 0 3 1` (state of the last point, v1 = 3): 0.00176389 0.00152797 0.001.
    // ngspice's own sweep solution there is v(2) = 1.236111 against the exact -1 + sqrt(5) = 1.236068
    // (Newton stops within RELTOL); spice-ts converges closer, so compare at 1e-4 and check exact KCL.
    const v2 = Math.sqrt(5) - 1;
    expect(controlValue(output, 'sr1') / 1.76389e-3).toBeCloseTo(1, 3);
    expect(controlValue(output, 'sb1') / 1.52797e-3).toBeCloseTo(1, 3);
    expect(controlValue(output, 'sr1') / ((3 - v2) / 1e3)).toBeCloseTo(1, 9);
    // @b1[i] is ASRCprev_value: the expression at the last Newton linearisation, not at the final solution.
    expect(controlValue(output, 'sb1') / (v2 * v2 * 1e-3)).toBeCloseTo(1, 3);
    expect(controlValue(output, 'si1')).toBeCloseTo(1e-3, 12);
  });

  it('keeps device currents spice-ts does not read out as a typed unsupported decision', async () => {
    const deck = (expression: string): string => `unsupported readout
V1 1 0 1
R1 1 2 1k
C1 2 0 1n
.control
op
let x = ${expression}
.endc
.end`;
    for (const expression of ['@c1[i]', '@i9[current]']) {
      const error = await simulate(deck(expression)).then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(UnsupportedControlCommandError);
    }
  });

  it('reports @dev[i] before any analysis as unsupported rather than inventing a state', async () => {
    const error = await simulate(`no analysis yet
V1 1 0 1
R1 1 0 1k
.control
let x = @r1[i]
.endc
.end`).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnsupportedControlCommandError);
  });
});
