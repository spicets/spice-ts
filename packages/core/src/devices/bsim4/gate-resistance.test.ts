import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { parse } from '../../parser/index.js';
import { UnsupportedModelParameterError } from '../../errors.js';
import { BSIM4 } from './device.js';
import type { StampContext } from '../device.js';

interface Point { vg: number; vd: number; vb: number; gate: number; ig: number; id: number; ib: number; is: number }
interface ReferenceCase { deck: string; sha256: string; op: Point; points: Point[] }
const base = new URL('./__fixtures__/rgatemod1/', import.meta.url);
const reference = JSON.parse(readFileSync(new URL('ngspice-47.json', base), 'utf8')) as { cases: ReferenceCase[] };

describe('BSIM4 RGATEMOD=1 static gate resistance', () => {
  for (const rgatemod of [1, 2]) for (const polarity of [1, -1] as const) for (const vds of [0.7, -0.7]) {
    it(`conserves five-node currents/Jacobian: RGATEMOD=${rgatemod}, polarity=${polarity}, Vds=${vds}`, () => {
      const device = new BSIM4('M1', [0, 1, 2, 3, 4],
        { LEVEL: 54, RGATEMOD: rgatemod, RSHG: 1e6, XGW: 20e-9, XGL: 10e-9, NGCON: 2, IGCMOD: 1, TOXE: 1e-9 },
        { L: 1e-6, W: 10e-6, NF: 2, M: 3, MULT_I: 2 }, polarity);
      const voltage = [0.4 + polarity * vds, 0.4 + polarity * 1.5, 0.4, 0.2, 0.4 + polarity * 1.4];
      function stamp(v: number[]) {
        let G = new Float64Array(25), B = new Float64Array(5);
        const ctx: StampContext = {
          stampG: (r, c, x) => { G[r * 5 + c] += x; }, stampB: (r, x) => { B[r] += x; },
          stampC: () => { throw new Error('DC must not stamp C'); }, getVoltage: n => v[n], getCurrent: () => 0,
          time: 0, dt: 0, numNodes: 5, sourceScale: 1, useDcSourceValue: true,
        };
        for (let n = 0; n < 20; n++) { G = new Float64Array(25); B = new Float64Array(5); device.stamp(ctx); }
        expect(device.limitedLastStamp()).toBe(false);
        const current = v.map((_, r) => v.reduce((sum, x, c) => sum + G[r * 5 + c] * x, -B[r]));
        return { G, current };
      }
      const { G, current } = stamp(voltage);
      expect(current.reduce((sum, x) => sum + x, 0)).toBeCloseTo(0, 13);
      for (let c = 0; c < 5; c++) {
        const h = 1e-5, hi = [...voltage], lo = [...voltage]; hi[c] += h; lo[c] -= h;
        const high = stamp(hi).current, low = stamp(lo).current;
        for (let r = 0; r < 5; r++) {
          const fd = (high[r] - low[r]) / (2 * h);
          expect(Math.abs(fd - G[r * 5 + c]) / Math.max(Math.abs(fd), 1e-10)).toBeLessThan(2e-5);
        }
      }
    });
  }
  it('instance RGATEMOD=0 overrides the model without allocating a gate node', async () => {
    const deck = readFileSync(new URL('model.cir', base), 'utf8').replace('NF=2 M=3', 'NF=2 M=3 RGATEMOD=0');
    const device = parse(deck).compile().devices.find(d => d.name === 'M1')!;
    expect(device.nodes).toHaveLength(4);
    const actual = await simulate(deck);
    const baseline = await simulate(deck.replace('RGATEMOD=1', 'RGATEMOD=0'));
    expect(actual.dc!.current('Vg')).toBe(baseline.dc!.current('Vg'));
    expect(actual.dcSweep!.current('Vd')).toEqual(baseline.dcSweep!.current('Vd'));
  });
  for (const item of reference.cases) {
    it(`${item.deck}: ngspice-47 OP/DC internal gate and terminal currents`, async () => {
      const deck = readFileSync(new URL(item.deck, base), 'utf8');
      expect(createHash('sha256').update(deck).digest('hex')).toBe(item.sha256);
      const result = await simulate(deck);
      const errors = { abs: 0, rel: 0 };
      function check(actual: number, expected: number, label: string) {
        const abs = Math.abs(actual - expected);
        const rel = abs / Math.max(Math.abs(expected), Number.MIN_VALUE);
        errors.abs = Math.max(errors.abs, abs);
        errors.rel = Math.max(errors.rel, rel);
        expect(abs <= 1e-12 || rel <= 1e-6, `${item.deck} ${label}: abs=${abs}, rel=${rel}`).toBe(true);
      }
      const quantities = [['vg', 'g'], ['vd', 'd'], ['vb', 'b'], ['gate', 'M1.gate'],
        ['ig', 'Vg'], ['id', 'Vd'], ['ib', 'Vb'], ['is', 'Vs']] as const;
      for (const [key, node] of quantities) {
        const current = key.startsWith('i');
        check(current ? result.dc!.current(node) : result.dc!.voltage(node), item.op[key], `OP ${key}`);
        const actual = current ? result.dcSweep!.current(node) : result.dcSweep!.voltage(node);
        expect(actual).toHaveLength(item.points.length);
        item.points.forEach((point, n) => check(actual[n], point[key], `DC ${key} at ${point.vg}`));
      }
      if (item.deck === 'model.cir' || item.deck === 'instance.cir') {
        expect(Math.abs(result.dc!.voltage('g') - result.dc!.voltage('M1.gate'))).toBeGreaterThan(1e-3);
      }
      console.info(`${item.deck}: ${JSON.stringify(errors)}`);
    });
  }
  for (const [key, value] of [['RGATEMOD', 3], ['RBODYMOD', 2]] as const) {
    for (const location of ['model', 'instance']) {
      it(`rejects ${location} ${key}=${value} explicitly`, () => {
        const deck = `Unsupported BSIM4 selector
.model DUT NMOS LEVEL=54 ${location === 'model' ? `${key}=${value}` : ''}
M1 d g 0 0 DUT L=1u W=10u ${location === 'instance' ? `${key}=${value}` : ''}
Vd d 0 0.7
Vg g 0 1.4
.op
.end`;
        expect(() => parse(deck).compile()).toThrow(UnsupportedModelParameterError);
      });
    }
  }
});
