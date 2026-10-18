import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from '../../parser/index.js';
import { simulate } from '../../simulate.js';
import { BSIM4 } from './device.js';
import { InvalidCircuitError, UnsupportedModelParameterError } from '../../errors.js';

interface ReferenceCase {
  deck: string; sha256: string;
  points: { vgs: number; ig: number; id: number }[];
}
const base = new URL('../../../../../benchmarks/bsim4-igc/', import.meta.url);
const reference = JSON.parse(readFileSync(new URL('ngspice-47.json', base), 'utf8')) as { cases: ReferenceCase[] };

describe('BSIM4 IGCMOD=1 gate tunneling', () => {
  for (const item of reference.cases) {
    it(`${item.deck}: ngspice-47 gate/drain DC sweep parity`, async () => {
      const deck = readFileSync(new URL(item.deck, base), 'utf8');
      expect(createHash('sha256').update(deck).digest('hex')).toBe(item.sha256);
      const result = (await simulate(deck)).dcSweep!;
      expect(result.sweepValues.length).toBe(item.points.length);
      const errors = { ig: 0, id: 0 };
      // Same shared bound and native-zero floor as BSIM4 parity.test.ts.
      for (const [quantity, source] of [['ig', 'Vg'], ['id', 'Vd']] as const) {
        const actual = result.current(source);
        item.points.forEach((point, index) => {
          expect(result.sweepValues[index]).toBeCloseTo(point.vgs, 12);
          const error = Math.abs(actual[index] - point[quantity]) / Math.max(Math.abs(point[quantity]), 1e-18);
          errors[quantity] = Math.max(errors[quantity], error);
          expect(error, `${item.deck} ${quantity} at Vgs=${point.vgs}`).toBeLessThan(1e-8);
        });
      }
      console.info(`${item.deck} max normalized error ${JSON.stringify(errors)}`);
    });
  }
  for (const key of ['NIGC', 'POXEDGE', 'PIGCD']) for (const value of [0, -1]) {
    it(`rejects enabled ${key}=${value} fatal domain`, () => {
      const device = () => new BSIM4('M', [0, 1, -1, -1], { LEVEL: 54, IGCMOD: 1, [key]: value }, {}, 1);
      expect(() => device().evaluate({ vgs: 1, vds: 0.7, vbs: 0 })).toThrow(InvalidCircuitError);
    });
  }
  for (const key of ['DLCIG', 'DLCIGD']) {
    it(`rejects ${key} reset rather than silently changing a gate-current card`, () => {
      expect(() => new BSIM4('M', [0, 1, -1, -1], { LEVEL: 54, IGCMOD: 1, [key]: -1e-9 }, {}, 1))
        .toThrow(UnsupportedModelParameterError);
    });
  }
  for (const polarity of [1, -1] as const) {
    it(`accepts a VERSION=4.8 ${polarity === 1 ? 'NMOS' : 'PMOS'} card and stamps nonzero gate current`, async () => {
      const netlist = `Self-authored thin oxide gate tunneling
.model DUT ${polarity === 1 ? 'NMOS' : 'PMOS'} LEVEL=54 VERSION=4.8 IGCMOD=1 TOXE=1n DLCIG=20n
Vd d 0 ${polarity * 0.7}
Vg g 0 ${polarity * 1.4}
Vb b 0 ${polarity * -0.2}
M1 d g 0 b DUT L=100n W=10u
.op
.end`;
      const device = parse(netlist).compile().devices.find(d => d.name === 'M1');
      expect(device).toBeInstanceOf(BSIM4);
      const result = await simulate(netlist);
      expect(Math.abs(result.dc!.current('Vg'))).toBeGreaterThan(1e-9);
    });
  }
});
