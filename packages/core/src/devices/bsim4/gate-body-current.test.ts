import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { parse } from '../../parser/index.js';
import { BSIM4 } from './device.js';
import { InvalidCircuitError } from '../../errors.js';

interface ReferenceCase {
  deck: string; sha256: string;
  points: { vgs: number; ig: number; ib: number; igb: number }[];
}

const base = new URL('../../../../../benchmarks/bsim4-igb/', import.meta.url);

describe('BSIM4 IGBMOD=1 gate-body tunneling', () => {
  it('matches every native ngspice-47 gate/bulk/IGB sweep point', async () => {
    const reference = JSON.parse(readFileSync(new URL('ngspice-47.json', base), 'utf8')) as { cases: ReferenceCase[] };
    expect(reference.cases).toHaveLength(4);
    for (const item of reference.cases) {
      const deck = readFileSync(new URL(item.deck, base), 'utf8');
      expect(createHash('sha256').update(deck).digest('hex')).toBe(item.sha256);
      const result = (await simulate(deck)).dcSweep!;
      const device = parse(deck).compile().devices.find(d => d.name === 'M1') as BSIM4;
      const polarity = item.deck.startsWith('n') ? 1 : -1;
      expect(result.sweepValues).toHaveLength(item.points.length);
      const errors = { ig: { rel: 0, abs: 0 }, ib: { rel: 0, abs: 0 }, igb: { rel: 0, abs: 0 } };
      item.points.forEach((point, index) => {
        expect(result.sweepValues[index]).toBeCloseTo(point.vgs, 12);
        // b4ask.c:259-262 returns normalized IGB * M, without polarity.
        const igb = 2 * device.evaluate({ vgs: polarity * point.vgs, vds: 0.7, vbs: -0.2 }).igb;
        for (const [key, actual] of [['ig', result.current('Vg')[index]], ['ib', result.current('Vb')[index]], ['igb', igb]] as const) {
          const abs = Math.abs(actual - point[key]);
          const rel = abs / Math.max(Math.abs(point[key]), Number.MIN_VALUE);
          errors[key].abs = Math.max(errors[key].abs, abs);
          errors[key].rel = Math.max(errors[key].rel, rel);
          expect(abs <= 1e-15 || rel <= 1e-6, `${item.deck} ${key} at ${point.vgs}: ${abs} A, ${rel} relative`).toBe(true);
        }
      });
      console.info(`${item.deck} ${JSON.stringify(errors)}`);
    }
  });
  for (const key of ['NIGBACC', 'NIGBINV']) for (const value of [0, -1]) {
    it(`rejects enabled ${key}=${value}`, () => {
      expect(() => new BSIM4('M', [0, 1, -1, -1], { LEVEL: 54, IGBMOD: 1, [key]: value }, {}, 1))
        .toThrow(InvalidCircuitError);
    });
  }
  for (const polarity of [1, -1] as const) for (const vgs of [-2, 1.5]) {
    it(`converges a resistor-loaded gate, polarity=${polarity}, Vgs=${vgs}`, async () => {
      const deck = `BSIM4 loaded gate Newton check
.model DUT ${polarity === 1 ? 'NMOS' : 'PMOS'} LEVEL=54 IGBMOD=1 TOXE=1n
Vd d 0 ${polarity * 0.7}
Vg drive 0 ${polarity * vgs}
Rg drive g 1meg
Vb b 0 ${polarity * -0.2}
M1 d g 0 b DUT L=100n W=10u
.options reltol=1e-10 abstol=1e-18 vntol=1e-12
.op
.end`;
      const result = (await simulate(deck)).dc!;
      const device = parse(deck).compile().devices.find(d => d.name === 'M1') as BSIM4;
      const op = device.evaluate({ vgs: polarity * result.voltage('g'), vds: 0.7, vbs: -0.2 });
      expect(Math.abs(result.current('Vg') + polarity * op.igb)).toBeLessThan(1e-15);
      expect(Math.abs(result.voltage('g') - polarity * vgs)).toBeGreaterThan(1e-4);
    });
  }
  for (const deck of ['n-acc.cir', 'n-inv.cir', 'p-acc.cir', 'p-inv.cir']) {
    it(`${deck}: accepts IGBMOD=1 and stamps nonzero gate-body current`, async () => {
      const result = (await simulate(readFileSync(new URL(deck, base), 'utf8'))).dcSweep!;
      expect(Math.max(...result.current('Vg').map(Math.abs))).toBeGreaterThan(1e-9);
    });
  }
});
