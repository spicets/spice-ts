import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { UnsupportedCodeModelError } from '../../parser/xspice-parser.js';

const params = 'ron=2 roff=1000 vfwd=1 vrev=3 rrev=4';
const deck = (v: number, extra = '') => `sidiode\nv1 d 0 dc ${v} ac 1\na1 (d 0) sd\n.model sd sidiode(${params} ${extra})\n.op\n.ac lin 1 1 1\n.end`;

// Expected currents and conductances follow ngspice-47 xtradev/sidiode/cfunc.mod:193-239.
// In the tanh regions ngspice deliberately supplies g*(1-tanh^2), not dI/dV.
describe('XSPICE sidiode (#1563)', () => {
  it.each([
    [-5, -0.503, 0.25], [-3, -0.003, 0.001],
    [-1, -0.001, 0.001], [0, 0, 0.001], [1, 0.001, 0.5], [2, 0.501, 0.5],
  ])('unlimited regions at %s V', async (v, current, conductance) => {
    const r = await simulate(deck(v));
    expect(r.dc!.current('v1')).toBeCloseTo(-current, 11);
    expect(r.ac!.current('v1')[0].magnitude).toBeCloseTo(conductance, 11);
  });

  it.each([
    [-3.4, -0.0532, 0.25], [-3.2, -0.01565, 0.1255], [-3, -0.003, 0.001],
    [1, 0.001, 0.001], [1.1, 0.013575, 0.2505], [1.2, 0.0511, 0.5],
  ])('quadratic smoothing at %s V', async (v, current, conductance) => {
    const r = await simulate(deck(v, 'epsilon=0.2 revepsilon=0.4 ilimit=0.5 revilimit=0.7'));
    expect(r.dc!.current('v1')).toBeCloseTo(-current, 11);
    expect(r.ac!.current('v1')[0].magnitude).toBeCloseTo(conductance, 11);
  });

  it.each([-8, -4, 2, 8])('tanh current limits and ngspice partial at %s V', async v => {
    const t = v < 0 ? Math.tanh(-0.25 / 0.7 * (v + 3.4)) : Math.tanh(v - 1.2);
    const current = v < 0 ? (-0.7 + 0.0532) * t - 0.0532 : (0.5 - 0.0511) * t + 0.0511;
    const conductance = (v < 0 ? 0.25 : 0.5) * (1 - t * t);
    const r = await simulate(deck(v, 'epsilon=0.2 revepsilon=0.4 ilimit=0.5 revilimit=0.7'));
    expect(r.dc!.current('v1')).toBeCloseTo(-current, 11);
    expect(r.ac!.current('v1')[0].magnitude).toBeCloseTo(conductance, 11);
  });

  it('preserves the unlimited-region discontinuity after smoothing', async () => {
    const r = await simulate(deck(1.2, 'epsilon=0.2 revepsilon=0.4'));
    expect(r.dc!.current('v1')).toBeCloseTo(-0.101, 11);
    const reverse = await simulate(deck(-3.5, 'epsilon=0.2 revepsilon=0.4'));
    expect(reverse.dc!.current('v1')).toBeCloseTo(0.128, 11);
  });

  it('defaults to a one-ohm resistor and rrev=0 inherits ron', async () => {
    const r = await simulate('defaults\nv1 d 0 2\na1 (d 0) sd\n.model sd sidiode\n.op\n.end');
    expect(r.dc!.current('v1')).toBeCloseTo(-2, 11);
    const reverse = await simulate(deck(-5, 'rrev=0'));
    expect(reverse.dc!.current('v1')).toBeCloseTo(1.003, 11);
  });

  it('still rejects unimplemented code models', async () => {
    await expect(simulate('unsupported\na1 (d 0) sd\n.model sd d_process\n.op\n.end'))
      .rejects.toBeInstanceOf(UnsupportedCodeModelError);
  });
});
