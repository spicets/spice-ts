import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from '../index.js';
import { simulate } from '../../simulate.js';

const rc = `* RC transfer
V1 in 0 dc 0 ac 1
R1 in out 1k
R2 out 0 4k
C1 out 0 1n`;

describe('pz control command (#1445)', () => {
  for (const input of ['vol', 'cur']) {
    for (const mode of ['pol', 'zer', 'pz']) {
      it(`parses and executes ${input} ${mode} identically to .pz`, async () => {
        const card = `in 0 out 0 ${input} ${mode}`;
        const deck = `${rc}\n.control\npz ${card}\necho $curplot\n.endc\n.end`;
        expect(() => parse(deck)).not.toThrow();
        const result = await simulate(deck);
        const dot = await simulate(`${rc}\n.pz ${card}\n.end`);
        expect(result.poleZero).toEqual(dot.poleZero);
        expect(result.control!.runs.map(run => [run.plot, run.analysis])).toEqual([['pz1', 'pz']]);
        expect(result.control!.output).toEqual(['pz1']);
      });
    }
  }

  it('exposes complex pole/zero vectors with qualified plot names and repeated runs', async () => {
    const result = await simulate(`${rc}
.control
pz in 0 out 0 vol pol
let p = real(pole(1))
let q = imag(pz1.pole(1))
pz in 0 out 0 cur pz
let old = real(pz1.pole(1))
echo $curplot $&old
.endc
.end`);
    expect(result.control!.runs).toHaveLength(2);
    expect(result.control!.output).toEqual(['pz2 -1.25e+06']);
  });

  it('exposes non-real poles and zero vectors to follow-up expressions', async () => {
    const deck = readFileSync(new URL('../../../../../benchmarks/pole-zero/passive-rlc.cir', import.meta.url), 'utf8');
    const result = await simulate(deck.replace(/^\.pz (.*)$/im, (_, card: string) =>
      `.control\npz ${card}\nlet p = imag(pole(1))\nlet z = real(zero(1))\necho $&p $&z\n.endc`));
    expect(result.control!.output).toEqual(['5e+08 0']);
  });

  it('also exposes roots from a dot-card run', async () => {
    const result = await simulate(`${rc}\n.pz in 0 out 0 vol pol\n.control\nrun\nlet p = real(pole(1))\necho $curplot $&p\n.endc\n.end`);
    expect(result.control!.output).toEqual(['pz1 -1.25e+06']);
  });

  it.each(['in 0 out 0 vol', 'in 0 out 0 invalid pz', 'in 0 out 0 vol invalid'])(
    'rejects malformed arguments using the dot-card validation: %s', card => {
      expect(() => parse(`${rc}\n.control\npz ${card}\n.endc\n.end`)).toThrow();
    },
  );

  it('executes the unmodified corpus-f ac-resistance regression and its pole(1) assertion', async () => {
    const deck = readFileSync(new URL('../../../../../benchmarks/corpus/corpus-f/fixtures/tests/regression/pz/ac-resistance.cir', import.meta.url), 'utf8');
    const result = await simulate(deck);
    expect(result.control!.output.join('\n')).toContain('INFO: [pz], success');
    expect(result.control!.output.join('\n')).not.toContain('ERROR:');
    expect(result.poleZero!.poles[0].real).toBeCloseTo(-500000, 5);
  });
});
