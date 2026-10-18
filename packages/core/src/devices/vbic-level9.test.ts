import { describe, expect, it } from 'vitest';
import { InvalidCircuitError } from '../errors.js';
import { parse } from '../parser/index.js';
import { simulate } from '../simulate.js';
import { resolveVBICParams } from './vbic.js';

function deck(level: number, polarity = 'NPN'): string {
  const sign = polarity === 'NPN' ? 1 : -1;
  return `VBIC level alias
VCC cc 0 ${sign * 2}
VIN in 0 DC ${sign * 0.65} AC 1 PWL(0 ${sign * 0.65} 1n ${sign * 0.65} 1.1n ${sign * 0.66})
RB in b 100
RC cc c 1k
Q1 c b 0 0 QV
.model QV ${polarity}(LEVEL=${level} IS=1e-16 IBEI=1e-18 RCX=2 RBX=10 RE=1 CJE=1p CJC=0.5p TF=20p TD=100p)
.op
.ac lin 2 1meg 2meg
.tran 20p 2n
.end`;
}

describe('VBIC LEVEL=9 alias (#1398)', () => {
  for (const polarity of ['NPN', 'PNP']) {
    it(`has identical OP, AC and transient results to LEVEL=4 (${polarity})`, async () => {
      const level4 = await simulate(deck(4, polarity));
      const level9 = await simulate(deck(9, polarity));
      expect(level9.dc).toBeDefined();
      expect(level9.dc).toEqual(level4.dc);
      expect(level9.ac).toEqual(level4.ac);
      expect(level9.transient).toEqual(level4.transient);
    });
  }

  it('normalizes the model level without changing any VBIC parameters', () => {
    expect(resolveVBICParams({ LEVEL: 9, IS: 1e-16 }, 1))
      .toEqual(resolveVBICParams({ LEVEL: 4, IS: 1e-16 }, 1));
  });

  it('matches ngspice-47 LEVEL=9 OP on the identical NPN deck within 1e-6 relative', async () => {
    // ngspice-47 -b -r alias.raw alias.sp, SPICE_ASCIIRAWFILE=1.
    // The input is exactly deck(9), including its AC and transient cards.
    const result = (await simulate(deck(9))).dc!;
    for (const [actual, expected] of [
      [result.voltage('b'), 0.6499918012828944],
      [result.voltage('c'), 1.991801139828128],
      [result.current('VCC'), -8.198860171872102e-6],
      [result.current('VIN'), -8.198717105688605e-8],
    ]) {
      expect(Math.abs(actual / expected - 1)).toBeLessThan(1e-6);
    }
  });

  for (const level of [4, 9]) {
    it(`accepts the thermal terminal for LEVEL=${level}`, () => {
      const compile = () => parse(deck(level).replace('Q1 c b 0 0 QV', 'Q1 c b 0 0 t QV')).compile();
      expect(compile).not.toThrow();
    });
    it(`keeps bounded model validation for LEVEL=${level}`, () => {
      expect(() => parse(deck(level).replace('IS=1e-16', 'BF=100')).compile())
        .toThrow("Unsupported bounded VBIC DC model parameter: 'BF'");
    });
    it(`keeps TEMP stepping rejection for LEVEL=${level}`, async () => {
      await expect(simulate(deck(level).replace('.op', '.step TEMP 27 30 3\n.op')))
        .rejects.toThrow('TEMP');
    });
  }
});
