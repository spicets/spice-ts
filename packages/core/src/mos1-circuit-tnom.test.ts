// Original project-authored MOS1 bias networks and tests, MIT.
import { describe, expect, it } from 'vitest';
import { simulate } from './simulate.js';

const deck = (polarity: string, options: string, model = '') => `MOS1 circuit TNOM
VDD supply 0 ${polarity === 'NMOS' ? 5 : -5}
VG gate 0 ${polarity === 'NMOS' ? 2.5 : -2.5}
R1 supply drain 1k
M1 drain gate 0 0 channel W=10u L=1u
.model channel ${polarity}(LEVEL=1 VTO=${polarity === 'NMOS' ? 0.7 : -0.7} KP=100u GAMMA=0.4 PHI=0.6 ${model})
${options}
.op`;

describe('MOS1 circuit TNOM', () => {
  it.each(['NMOS', 'PMOS'])('%s inherits circuit TNOM using the existing model law', async polarity => {
    const actual = await simulate(deck(polarity, '.options TEMP=75 TNOM=50'));
    const explicit = await simulate(deck(polarity, '.temp 75', 'TNOM=50'));
    const nominal = await simulate(deck(polarity, '.temp 75'));
    expect(actual.dc!.current('VDD')).toBe(explicit.dc!.current('VDD'));
    expect(actual.dc!.current('VDD')).not.toBe(nominal.dc!.current('VDD'));
  });

  it.each(['NMOS', 'PMOS'])('%s model TNOM overrides circuit TNOM', async polarity => {
    const actual = await simulate(deck(polarity, '.options TEMP=75 TNOM=50', 'TNOM=40'));
    const explicit = await simulate(deck(polarity, '.temp 75', 'TNOM=40'));
    expect(actual.dc!.current('VDD')).toBe(explicit.dc!.current('VDD'));
  });
});
