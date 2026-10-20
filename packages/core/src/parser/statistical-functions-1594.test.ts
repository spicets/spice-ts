import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { ParseError } from '../errors.js';

const fixture = readFileSync(new URL('../../../../benchmarks/corpus/corpus-f/fixtures/examples/Monte_Carlo/rand_numb_test.cir', import.meta.url), 'utf8');
const deck = (expression: string, seed = 55, script = 'op') => `random parameters
.option seed=${seed}
.param x=${expression}
V1 1 0 {x}
.control
${script}
.endc
.end`;
const voltage = async (text: string) => (await simulate(text)).dc!.voltage('1');

describe('ngspice numparam statistical functions (#1594)', () => {
  it('runs the unchanged rand_numb_test deck with the ngspice-47 printed voltage', async () => {
    // macOS ngspice-47: HOME=<scratch home with .spiceinit: set numdgt=15>
    // ngspice -b benchmarks/corpus/corpus-f/fixtures/examples/Monte_Carlo/rand_numb_test.cir
    // v(1) = 1.124431320988279e+00; the deck is byte-identical, no injected cards.
    const oracle = 1.124431320988279;
    expect(Math.abs((await voltage(fixture)) - oracle) / Math.abs(oracle)).toBeLessThan(1e-9);
  });

  it.each(['agauss(0,1,1)', 'gauss(2,1,1)', 'aunif(2,1)', 'unif(2,1)', 'limit(2,1)'])(
    '%s is reproducible with the same seed and isolated across simulations', async expression => {
      const first = await voltage(deck(expression));
      await voltage(deck(expression, 12));
      expect(await voltage(deck(expression))).toBe(first);
      expect(Number.isFinite(first)).toBe(true);
    },
  );

  it.each(['agauss(1,2)', 'gauss(1,2,3,4)', 'unif(1)', 'aunif(1,2,3)', 'limit(1)', 'agauss(1,1/0,1)'])(
    'reports structured argument errors for %s', async expression => {
      await expect(simulate(deck(expression))).rejects.toBeInstanceOf(ParseError);
    },
  );

  it('setseed controls reloads without a deck seed; deck seed overrides setseed on reload', async () => {
    const withoutSeed = deck('agauss(0,1,1)', 55, 'setseed 12\nmc_source\nop').replace('.option seed=55', '');
    expect(await voltage(withoutSeed)).toBe(await voltage(deck('agauss(0,1,1)', 12)));
    expect(await voltage(deck('agauss(0,1,1)', 55, 'setseed 12\nmc_source\nop'))).toBe(await voltage(deck('agauss(0,1,1)')));
  });

  it('mc_source advances the retained random stream when there is no seed card', async () => {
    const result = await simulate(deck('aunif(2,1)', 55, 'setseed 12\nmc_source\nop\nmc_source\nop').replace('.option seed=55', ''));
    expect(result.control!.runs[0].result.dc!.voltage('1')).not.toBe(result.control!.runs[1].result.dc!.voltage('1'));
  });

  it.each(['setseed', 'setseed random', 'setseed 1 2', 'setseed 0', 'setseed 1.5'])(
    'rejects unsupported seed syntax: %s', async command => {
      await expect(simulate(deck('1', 55, command))).rejects.toThrow(/setseed/);
    },
  );
});
