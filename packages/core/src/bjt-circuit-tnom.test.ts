// Original project-authored fixtures and tests, MIT.
import { describe, expect, it } from 'vitest';
import { simulate } from './simulate.js';
import { parse } from './parser/index.js';

const deck = (polarity: string, options: string, model = '') => `BJT circuit nominal temperature
VCC c 0 ${polarity === 'NPN' ? 5 : -5}
VBE in 0 ${polarity === 'NPN' ? 1 : -1}
RB in b 100k
Q1 c b 0 transistor
.model transistor ${polarity}(IS=1e-14 BF=120 XTB=0.7 ${model})
${options}
.op`;

describe('BJT circuit TNOM', () => {
  it.each(['NPN', 'PNP'])('%s inherits circuit TNOM using the existing model law', async polarity => {
    const actual = await simulate(deck(polarity, '.options TEMP=75 TNOM=50'));
    const explicit = await simulate(deck(polarity, '.temp 75', 'TNOM=50'));
    const nominal = await simulate(deck(polarity, '.temp 75'));
    for (const source of ['VCC', 'VBE']) {
      expect(actual.dc!.current(source)).toBe(explicit.dc!.current(source));
      expect(actual.dc!.current(source)).not.toBe(nominal.dc!.current(source));
    }
  });

  it.each(['NPN', 'PNP'])('%s model TNOM overrides circuit TNOM', async polarity => {
    const actual = await simulate(deck(polarity, '.options TEMP=75 TNOM=50', 'TNOM=40'));
    const explicit = await simulate(deck(polarity, '.temp 75', 'TNOM=40'));
    expect(actual.dc!.current('VCC')).toBe(explicit.dc!.current('VCC'));
    expect(actual.dc!.current('VBE')).toBe(explicit.dc!.current('VBE'));
  });

  it('keeps circuit TNOM rejected for VBIC', () => {
    expect(() => parse(deck('NPN', '.options TNOM=50', 'LEVEL=4')).compile()).toThrow(/TNOM=50/);
  });
});
