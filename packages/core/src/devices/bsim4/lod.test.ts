import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { parse } from '../../parser/index.js';
import { UnsupportedModelParameterError } from '../../errors.js';
import { setupBsim4Instance, setupBsim4Model } from './setup.js';
import { preprocessBsim4 } from './temp.js';

const base = new URL('./__fixtures__/lod/', import.meta.url);
const reference = JSON.parse(readFileSync(new URL('ngspice-47.json', base), 'utf8')) as {
  cases: { deck: string; sha256: string; op: number[]; points: number[][] }[];
};
// Measured ngspice-47, KLU. Reproduce from repository root:
// TMPDIR=<scratch> spice-heavy python3 packages/core/src/devices/bsim4/__fixtures__/lod/generate.py
// Generator runs SPICE_ASCIIRAWFILE=1 ngspice -b -r <raw> <deck>, unchanged deck bytes.
describe('BSIM4 static length-of-diffusion stress', () => {
  for (const item of reference.cases) it(`${item.deck}: identical-deck ngspice-47 OP/DC`, async () => {
    const deck = readFileSync(new URL(item.deck, base), 'utf8');
    expect(createHash('sha256').update(deck).digest('hex')).toBe(item.sha256);
    const result = await simulate(deck);
    let maxRelative = 0;
    const check = (actual: number, expected: number) => {
      if (expected === 0) expect(Math.abs(actual)).toBeLessThanOrEqual(1e-15);
      else {
        const relative = Math.abs((actual - expected) / expected);
        maxRelative = Math.max(maxRelative, relative);
        expect(relative).toBeLessThanOrEqual(1e-6);
      }
    };
    ['d', 'g', 's', 'b', 'Vd'].forEach((name, index) => {
      check(index === 4 ? result.dc!.current(name) : result.dc!.voltage(name), item.op[index]);
      const values = index === 4 ? result.dcSweep!.current(name) : result.dcSweep!.voltage(name);
      expect(values).toHaveLength(item.points.length);
      item.points.forEach((row, n) => check(values[n], row[index]));
    });
    console.info(`${item.deck}: maxRelative=${maxRelative}`);
  });
  it('preserves default SA=SB=0 preprocessing bit for bit', () => {
    const nodes = { d: 1, g: 2, s: 0, b: 0 };
    const model = setupBsim4Model();
    const process = (card: Record<string, number>) => preprocessBsim4(model, setupBsim4Instance(model, card, nodes));
    expect(process({ sa: 0, sb: 0 })).toEqual(process({}));
    // Captured on pre-LOD main, including all model/size/instance/junction doubles.
    expect(createHash('sha256').update(JSON.stringify(process({ sa: 0, sb: 0 }))).digest('hex'))
      .toBe('c37555f607098596d55dbf05e839cb749aeaa0645075ddf84daa683aac9f4324');
  });
  for (const analysis of ['.ac dec 1 1k 1meg', '.tran 1n 10n']) it(`rejects unvalidated LOD ${analysis}`, () => {
    const deck = readFileSync(new URL('nf2.cir', base), 'utf8').replace('.op\n', `${analysis}\n`);
    expect(() => parse(deck).compile()).toThrow(UnsupportedModelParameterError);
  });
});
