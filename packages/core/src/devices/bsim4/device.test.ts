import { describe, expect, it } from 'vitest';
import { parse } from '../../parser/index.js';
import { simulate } from '../../simulate.js';
import { UnsupportedModel } from './setup.js';
import { BSIM4 } from './device.js';
import type { StampContext } from '../device.js';

function deck(level = 54, type = 'NMOS', analysis = '.op') {
  const polarity = type === 'NMOS' ? 1 : -1;
  return `BSIM4 static integration
.model DUT ${type} LEVEL=${level}
Vd d 0 ${polarity * 0.7}
Vg g 0 ${polarity * 1.4} AC 1
Vb b 0 ${polarity * -0.2}
M1 d g 0 b DUT L=1u W=10u
${analysis}
.end`;
}
describe('BSIM4 DC device integration', () => {
  for (const level of [14, 54]) {
    it(`routes LEVEL=${level} without a MOS1 fallback`, () => {
      expect(parse(deck(level)).compile().devices.find(d => d.name === 'M1')).toBeInstanceOf(BSIM4);
    });
  }
  for (const type of ['NMOS', 'PMOS']) {
    it(`converges a ${type} operating point`, async () => {
      const result = await simulate(deck(54, type));
      const device = parse(deck(54, type)).compile().devices.find(d => d.name === 'M1') as BSIM4;
      const p = type === 'NMOS' ? 1 : -1;
      const op = device.evaluate({ vgs: 1.4, vds: 0.7, vbs: -0.2 });
      expect(op.gm).toBeGreaterThan(0);
      expect(result.dc!.voltage('d')).toBeCloseTo(p * 0.7, 12);
      expect(-p * result.dc!.current('Vd')).toBeGreaterThan(0);
      expect(result.dc!.current('Vd')).toBeCloseTo(-p * (op.ids + op.isub - op.cbd), 12);
    });
  }
  for (const analysis of ['.noise V(d) Vg dec 2 1 1meg']) {
    it(`rejects ${analysis} with UnsupportedModel`, () => {
      expect(() => parse(deck(54, 'NMOS', analysis)).compile()).toThrow(UnsupportedModel);
    });
  }
  it('direct device APIs reject unsupported charge/noise requests', () => {
    const device = parse(deck()).compile().devices.find(d => d.name === 'M1') as BSIM4;
    expect(() => device.capacitances()).toThrow(UnsupportedModel);
    expect(() => device.resetTransient()).not.toThrow();
    expect(() => device.noise()).toThrow(UnsupportedModel);
    expect(() => device.charges()).toThrow(UnsupportedModel);
  });
  for (const [parameter, value] of [
    ['IGCMOD', 2], ['IGBMOD', 2], ['RDSMOD', 1], ['RBODYMOD', 2], ['RGATEMOD', 4],
    ['TRNQSMOD', 1], ['ACNQSMOD', 1], ['MOBMOD', 1], ['TEMPMOD', 1], ['GEOMOD', 1],
    ['PERMOD', 0], ['WPEMOD', 1], ['KVTH0WE', 2e-6], ['AGIDL', 1e-9], ['AGISL', 1e-9],
    ['JTSS', 1e-9], ['A2', 0.001], ['PRWG', -0.1], ['RDSW', -1], ['RDSWMIN', -1],
  ] as const) {
    it(`fails closed for ${parameter}=${value}`, () => {
      expect(() => new BSIM4('M', [0, 1, -1, -1], { LEVEL: 54, [parameter]: value }, {}, 1)).toThrow(UnsupportedModel);
    });
  }
  for (const parameter of ['OFF', 'ICVGS', 'ICVDS', 'ICVBS', 'DTEMP', 'SCB', 'SCA']) {
    it(`fails closed for unported instance ${parameter}`, () => {
      expect(() => new BSIM4('M', [0, 1, -1, -1], { LEVEL: 54 }, { [parameter]: 1 }, 1)).toThrow(UnsupportedModel);
    });
  }
  it('applies nonnominal circuit temperature through the registry', () => {
    const device = parse(deck().replace('.op', '.temp 87\n.op')).compile().devices.find(d => d.name === 'M1') as BSIM4;
    expect(device.getTemperature()).toBe(87);
    expect(device.evaluate({ vgs: 1.4, vds: 0.7, vbs: -0.2 }).gm).toBeGreaterThan(0);
  });
  it('does not silently overwrite internal model TYPE or duplicate case keys', () => {
    expect(() => new BSIM4('M', [0, 1, -1, -1], { LEVEL: 54, TYPE: -1 }, {}, 1)).toThrow(UnsupportedModel);
    expect(() => new BSIM4('M', [0, 1, -1, -1], { LEVEL: 54, VTH0: 0.7, vth0: 0.8 }, {}, 1)).toThrow(UnsupportedModel);
  });
  for (const polarity of [1, -1] as const) {
    it(`solves an unknown resistor-loaded drain for polarity ${polarity}`, async () => {
      const netlist = `BSIM4 loaded OP
.model DUT ${polarity === 1 ? 'NMOS' : 'PMOS'} LEVEL=54
Vdd supply 0 ${polarity * 2}
Vg g 0 ${polarity * 1.4}
Rload supply d 2k
M1 d g 0 0 DUT L=1u W=10u
.op
.end`;
      const result = await simulate(netlist);
      const device = parse(netlist).compile().devices.find(d => d.name === 'M1') as BSIM4;
      const v = polarity * result.dc!.voltage('d');
      expect(v).toBeGreaterThan(0); expect(v).toBeLessThan(2);
      const op = device.evaluate({ vgs: 1.4, vds: v, vbs: 0 });
      expect(Math.abs((2 - v) / 2000 - (op.ids + op.isub - op.cbd))).toBeLessThan(1e-9);
    });
  }
  for (const polarity of [1, -1] as const) for (const vds of [0.7, -0.7]) for (const igcmod of [0, 1])
    for (const igbmod of [0, 1]) for (const vgs of (igbmod ? [-2, 1.4] : [1.4])) {
    it(`stamps conservative terminal currents/Jacobian, polarity=${polarity}, Vds=${vds}, Vgs=${vgs}, IGCMOD=${igcmod}, IGBMOD=${igbmod}`, () => {
      const device = new BSIM4('M', [0, 1, 2, 3], { LEVEL: 54, ALPHA0: 0.1, BETA0: 0.1,
        IGCMOD: igcmod, IGBMOD: igbmod, TOXE: 1e-9, DLCIG: 20e-9, DLCIGD: 30e-9 },
        { L: 1e-6, W: 10e-6, NF: 2, M: 3, MULT_I: 2, AD: 1e-12, AS: 2e-12 }, polarity);
      const bias = { vds, vgs, vbs: -0.9 };
      const voltage = [0.4 + polarity * vds, 0.4 + polarity * bias.vgs, 0.4, 0.4 + polarity * bias.vbs];
      function stamp(v: number[]) {
        let G = new Float64Array(16), B = new Float64Array(4);
        const ctx: StampContext = {
          stampG: (r, c, x) => { G[r * 4 + c] += x; }, stampB: (r, x) => { B[r] += x; },
          stampC: () => { throw new Error('DC must not stamp C'); }, getVoltage: n => v[n], getCurrent: () => 0,
          time: 0, dt: 0, numNodes: 4, sourceScale: 1, useDcSourceValue: true,
        };
        for (let n = 0; n < 20; n++) { G = new Float64Array(16); B = new Float64Array(4); device.stamp(ctx); }
        expect(device.limitedLastStamp()).toBe(false);
        const current = [0, 1, 2, 3].map(r => v.reduce((total, x, c) => total + G[r * 4 + c] * x, -B[r]));
        return { G, current };
      }
      const { G, current } = stamp(voltage);
      const op = device.evaluate(bias);
      expect(current[0]).toBeCloseTo(6 * polarity * (op.mode * op.ids + (op.mode > 0 ? op.isub : 0)
        - op.cbd - op.igd - (op.mode > 0 ? op.igcd : op.igcs)), 12);
      expect(current[1]).toBeCloseTo(6 * polarity * (op.igs + op.igd + op.igcs + op.igcd + op.igb), 12);
      expect(current.reduce((total, x) => total + x, 0)).toBeCloseTo(0, 13);
      // IGB uses ngspice's approximate bulk chain rule on (Vgs - Vbs).
      // verify-load.py checks those derivatives against C; loaded-gate tests
      // exercise Newton convergence rather than imposing a different Jacobian.
      if (igbmod) return;
      for (let column = 0; column < 4; column++) {
        const h = 1e-5, hi = [...voltage], lo = [...voltage]; hi[column] += h; lo[column] -= h;
        const high = stamp(hi).current, low = stamp(lo).current;
        for (let row = 0; row < 4; row++) {
          const fd = (high[row] - low[row]) / (2 * h);
          expect(Math.abs(fd - G[row * 4 + column]) / Math.max(Math.abs(fd), 1e-10)).toBeLessThan(2e-5);
        }
      }
    });
  }
});
