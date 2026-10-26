import { createHash } from 'node:crypto';
import { BSIM4 } from './device.js';
import type { StampContext } from '../device.js';
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
  for (const method of ['stampDynamic', 'stampAC'] as const) it(`rejects direct LOD ${method} before stamping`, () => {
    const device = new BSIM4('M', [0, 1, -1, -1], { LEVEL: 54 },
      { sa: 5e-7, sb: 5e-7, sd: 2e-7, nf: 2 }, 1);
    const stamps: number[] = [];
    const ctx: StampContext = {
      stampG: (_r, _c, value) => { stamps.push(value); },
      stampC: (_r, _c, value) => { stamps.push(value); },
      stampB: (_r, value) => { stamps.push(value); },
      getVoltage: node => node === 1 ? 1.4 : 0.7, getCurrent: () => 0,
      time: 0, dt: 0, numNodes: 2, sourceScale: 1, useDcSourceValue: true,
    };
    expect(() => device[method](ctx, 1e3)).toThrow(UnsupportedModelParameterError);
    expect(stamps).toEqual([]);
  });
  for (const nf of [10000.5, 9007199254740994, Number.MAX_VALUE]) it(`rejects excessive active LOD NF=${nf} during setup`, () => {
    const model = setupBsim4Model();
    // Do not enter preprocessing: the old loop can hang beyond JS integer precision.
    expect(() => setupBsim4Instance(model, { sa: 5e-7, sb: 5e-7, sd: 2e-7, nf },
      { d: 1, g: 2, s: 0, b: 0 })).toThrow(/nf.*10000/i);
  });
  it('retains native fractional NF summation rather than rounding the finger count', () => {
    const model = setupBsim4Model({ kvth0: 1e-8 });
    const instance = setupBsim4Instance(model, { l: 1e-6, sa: 5e-7, sb: 5e-7, sd: 2e-7, nf: 1.5 },
      { d: 1, g: 2, s: 0, b: 0 });
    const processed = preprocessBsim4(model, instance);
    // Native i < 1.5 visits i=0,1, with each term still divided by 1.5.
    const invOd = 2 * (1 / 1.5 / 1e-6 + 1 / 1.5 / 2.2e-6);
    const invRef = 1 / (model.values.saref + 0.5e-6) + 1 / (model.values.sbref + 0.5e-6);
    expect(processed.instance.vth0).toBeCloseTo(processed.size.vth0
      + 1e-8 / Math.sqrt(1 + 1e-9) * (invOd - invRef), 14);
    expect(instance.values.nf).toBe(1.5);
  });
  for (const nf of [9999.5, 10000]) it(`accepts active LOD NF=${nf} at the work limit`, () => {
    const device = new BSIM4('M', [0, 1, -1, -1], { LEVEL: 54 },
      { sa: 5e-7, sb: 5e-7, sd: 2e-7, nf }, 1);
    expect(Number.isFinite(device.evaluate({ vgs: 1.4, vds: 0.7, vbs: 0 }).ids)).toBe(true);
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
