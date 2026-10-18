import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { microstrip, dispersion } from './mlin.js';

const deck = (load: number, params = '') => `microstrip
v1 in 0 dc 1 ac 1
r1 out 0 ${load}
a1 %hd(in 0) %hd(out 0) %vd(in 0) %vd(out 0) m
.model m mlin(w=1e-3 h=1e-3 er=9.8 l=.01 t=0 rho=0 tand=0 ${params})
`;

describe('XSPICE mlin', () => {
  it('matches Hammerstad-Jensen quasi-static values', () => {
    const { z0, epsilon } = microstrip(1e-3, 1e-3, 0, 9.8);
    expect(z0).toBeCloseTo(49.322921851615675, 11);
    expect(epsilon).toBeCloseTo(6.579026554066487, 12);
    expect(microstrip(1e-3, 1e-3, 35e-6, 9.8)).toEqual({ z0: 48.489978895053405, epsilon: 6.436312364522074 });
  });
  it('is an ideal DC short like ngspice-47, including finite rho', async () => {
    const result = await simulate(`${deck(50, 't=35u rho=22n')}.op\n.end`);
    expect(result.dc!.voltage('out')).toBeCloseTo(1, 10);
    expect(result.dc!.current('v1')).toBeCloseTo(-.02, 10);
  });
  const quasi = microstrip(.001, .001, 0, 9.8);
  const lossless = dispersion(1, 1, 9.8, quasi.z0, quasi.epsilon);
  for (const load of [lossless.z0, 1000]) {
    it(`matches hand-computed lossless input impedance, load=${load}`, async () => {
      const { z0, epsilon } = lossless;
      const result = await simulate(`${deck(load)}.ac lin 1 1g 1g\n.end`);
      const i = result.ac!.current('v1')[0];
      const phase = i.phase * Math.PI / 180;
      const actual = { re: -Math.cos(phase) / i.magnitude, im: Math.sin(phase) / i.magnitude };
      const q = Math.tan(2 * Math.PI * 1e9 / 299792458 * Math.sqrt(epsilon) * .01);
      const d = z0 * z0 + load * load * q * q;
      expect(actual.re).toBeCloseTo(z0 * z0 * load * (1 + q * q) / d, 7);
      expect(actual.im).toBeCloseTo(z0 * (z0 * z0 - load * load) * q / d, 7);
    });
  }
  it('rejects transient with a typed error', async () => {
    await expect(simulate(`${deck(50)}.tran 1p 10p\n.end`)).rejects.toMatchObject({ code: 'UNSUPPORTED_XSPICE_MLIN', message: expect.stringContaining('mlin transient') });
  });
  it('rejects unsupported dispersion', async () => {
    await expect(simulate(`${deck(50, 'disp=1')}.op\n.end`)).rejects.toThrow('disp=0');
  });
});
