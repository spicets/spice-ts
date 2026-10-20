import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { stripControlComment } from './source.js';

const fixture = readFileSync(new URL('./fixtures/random-1597.cir', import.meta.url), 'utf8');
const deck = (script: string) => `random control\nV1 out 0 1\nR1 out 0 1k\n.control\n${script}\n.endc\n.end`;

describe('control comments and random vectors (#1597)', () => {
  it.each(['let x=unitvec(3)$ comment', 'let x=unitvec(3) $ comment', 'let x=unitvec(3)$'])('strips attached comments: %s', text => {
    expect(stripControlComment(text).trim()).toBe('let x=unitvec(3)');
  });
  it.each(['echo $curplot', 'echo $&run', 'echo {$curplot}.v(out)', 'echo "literal $ comment"'])('preserves substitution and quoted dollars: %s', text => {
    expect(stripControlComment(text)).toBe(text);
  });
  it('executes attached comments and both variable reference forms', async () => {
    const result = await simulate(deck('set n=2\nlet count=3\nlet x=unitvec($n)$ comment\nlet y=unitvec($&count)$ comment\necho $&x $&y'));
    expect(result.control!.output).toEqual(['1 1 1 1 1']);
  });
  it('matches ngspice-47 real sunif/sgauss and complex component draw order', async () => {
    // Same fixture: ngspice -b fixtures/random-1597.cir (macOS ngspice-47).
    const result = await simulate(fixture.replace('print u g cu cg', () => 'let cur=real(cu)\nlet cui=imag(cu)\nlet cgr=real(cg)\nlet cgi=imag(cg)\necho $&u\necho $&g\necho $&cur\necho $&cui\necho $&cgr\necho $&cgi'));
    const expected = [
      [0.3395234164781888, 0.5498459199443484, -0.499580343719571, 0.3159532621502896],
      [-0.439618879714485, 0.184432297871733, 0.7401096751136712, -1.48860252522624],
      [0.6780895162373808, -0.60073806066066, 0.2864485173486193],
      [0.06202567042783058, -0.747675997670739, 0.09791657328605829],
      [0.2643007803877501, -1.34649315947817, -0.643338414092418],
      [2.065366103960061, 0.6344611257967927, 0.2067000495620971],
    ];
    result.control!.output.forEach((line, i) => {
      const actual = line.trim().split(/\s+/).map(Number);
      expect(actual).toHaveLength(expected[i].length);
      actual.forEach((value, j) => expect(value).toBeCloseTo(expected[i][j], 12));
    });
    expect(result.control!.output).toHaveLength(6);
  });
  it('setseed is immediate, repeatable and isolated between simulations', async () => {
    const text = deck('setseed 55\nlet a=sunif(0)\nlet b=sgauss(0)\nsetseed 55\nlet c=sunif(99)\necho $&a $&c');
    const first = await simulate(text);
    expect(first.control!.output[0].split(' ')[0]).toBe(first.control!.output[0].split(' ')[1]);
    await simulate(deck('setseed 12\nlet x=sunif(0)'));
    expect((await simulate(text)).control!.output).toEqual(first.control!.output);
  });
  it('shares draws with numparam reloads rather than reseeding again on mc_source', async () => {
    const text = deck('set numdgt=15\nsetseed 55\nlet first=sunif(0)\nlet next=sunif(0)\nsetseed 55\nlet discarded=sunif(0)\nmc_source\nop\necho $&next');
    const result = await simulate(text.replace('V1 out 0 1', '.param value=aunif(0,1)\nV1 out 0 {value}'));
    expect(result.dc!.voltage('out')).toBeCloseTo(Number(result.control!.output[0]), 12);
  });
});
