import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';

const waveforms = [
  'sin(0 2 1k)',
  'pulse(0 2 1u 1n 1n 1m 2m)',
  'pwl(0 0 1m 2 2m 0)',
  'exp(0 2 1u 1m 2m 1m)',
];

function deck(source: string, mode: 'dc' | 'ac', waveform = ''): string {
  return `t
${source} ${waveform}
r1 1 2 1k
c1 2 0 1u
r2 2 0 2k
.sens v(2)${mode === 'ac' ? ' ac dec 2 10 1k' : ''}
.end`;
}

describe('.sens source DC/AC values alongside transient waveforms (#1389)', () => {
  it.each([
    ['vin 1 0 dc 1 ac 1', 'dc', 'sin(0 1 1k)'],
    ['vin 1 0 dc 1 ac 1', 'ac', 'sin(0 1 1k)'],
    ['iin 0 1 dc 1m', 'dc', waveforms[1]],
  ] as const)('reproduces issue deck: %s / %s', async (source, mode, waveform) => {
    const baseline = await simulate(deck(source, mode));
    const result = await simulate(deck(source, mode, waveform));
    expect(result.sensitivity).toEqual(baseline.sensitivity);
  });

  for (const source of ['vin 1 0 dc 1 ac 1 37', 'iin 0 1 dc 1m ac 1m 37']) {
    for (const mode of ['dc', 'ac'] as const) {
      it.each(waveforms)(`${source} / ${mode} ignores %s exactly`, async waveform => {
        const baseline = await simulate(deck(source, mode));
        const result = await simulate(deck(source, mode, waveform));
        expect(result.sensitivity).toEqual(baseline.sensitivity);
      });
    }
  }

  it('still rejects multiple AC excitations when one carries a waveform', async () => {
    await expect(simulate(`t
vin 1 0 dc 1 ac 1 sin(0 2 1k)
iin 0 2 dc 1m ac 1m pulse(0 2 1u 1n 1n 1m 2m)
r1 1 2 1k
r2 2 0 2k
.sens v(2) ac dec 2 10 1k
.end`)).rejects.toThrow('at most one non-zero AC excitation; found iin, vin');
  });
});
