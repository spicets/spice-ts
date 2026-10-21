import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';

const fixture = readFileSync(new URL('../../../../../benchmarks/xspice-msopen/terminated.cir', import.meta.url), 'utf8');
const reference: { cases: { name: string; netlist: string; op: { input: number; output: number; current: number };
  ac: { frequency: number; re: number; im: number }[] }[] } = JSON.parse(readFileSync(
  new URL('../../../../../benchmarks/xspice-msopen/ngspice-47.json', import.meta.url), 'utf8'));

describe('XSPICE msopen', () => {
  it.each(reference.cases)('matches archived ngspice-47 OP and every AC point for $name', async ref => {
    const result = await simulate(ref.netlist);
    expect(result.dc!.voltage('in')).toBe(ref.op.input);
    expect(result.dc!.voltage('out')).toBe(ref.op.output);
    expect(result.dc!.current('v1')).toBe(ref.op.current);
    expect(result.ac!.frequencies).toHaveLength(ref.ac.length);
    const actual = result.ac!.voltage('in');
    for (const [i, point] of ref.ac.entries()) {
      expect(Math.abs(result.ac!.frequencies[i] / point.frequency - 1)).toBeLessThan(1e-12);
      const magnitude = Math.hypot(point.re, point.im), phase = Math.atan2(point.im, point.re) * 180 / Math.PI;
      expect(Math.abs(actual[i].magnitude / magnitude - 1)).toBeLessThan(1e-4);
      const phaseError = Math.abs(((actual[i].phase - phase + 540) % 360) - 180);
      expect(phaseError / Math.abs(phase)).toBeLessThan(1e-4);
    }
  });

  it('runs an mlin terminated by msopen in OP and AC', async () => {
    const result = await simulate(fixture);
    expect(result.dc!.voltage('in')).toBe(1);
    expect(result.dc!.voltage('out')).toBe(1);
    expect(result.dc!.current('v1')).toBe(0);
    expect(result.ac!.voltage('in').every(p => Number.isFinite(p.magnitude))).toBe(true);
  });

  it('rejects transient rather than silently treating the end as open', async () => {
    await expect(simulate(fixture.replace('.ac dec 20 1e8 2e10', '.tran 1p 10p')))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_XSPICE_MSOPEN' });
  });

  it.each(['model=1', 'disp=1', 'msopen_model=3'])('rejects unsupported %s', async mode => {
    await expect(simulate(fixture.replace('msopen(w=', `msopen(${mode} w=`)))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_XSPICE_MSOPEN' });
  });

  it.each(['w=0', 'h=-1m', 'er=1', 't=-1u'])('rejects invalid geometry %s', async geometry => {
    await expect(simulate(fixture.replace('msopen(w=1m h=1m er=9.8 t=35u)',
      `msopen(w=1m h=1m er=9.8 t=35u ${geometry})`))).rejects.toThrow(/msopen requires/);
  });
});
