import { describe, expect, it } from 'vitest';
import { simulate } from '../index.js';
import { EKV26 } from './ekv.js';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const deck = (parameters = '') => `EKV dispatch
VD d 0 1
VG g 0 0.3
M1 d g 0 0 n L=1u W=1u
.model n NMOS LEVEL=260 TNOM=27 E0=0 Q0=0 LETA=0 WETA=0 ${parameters}
.op
.end`;

describe('EKV 2.6 static device', () => {
  it('keeps LEVEL=260 and conducts in weak inversion instead of MOS1 cutoff', async () => {
    const result = await simulate(deck());
    expect(-result.dc!.current('VD')).toBeGreaterThan(1e-12);
    expect(result.warnings.some(w => w.message.includes('level=1 assumed'))).toBe(false);
    expect(result.warnings.some(w => w.message.includes('EKV26'))).toBe(true);
  });
  it('rejects unknown parameters with a structured named error', async () => {
    await expect(simulate(deck('NOTEKV=1'))).rejects.toMatchObject({
      code: 'UNSUPPORTED_MODEL_PARAMETER', parameter: 'NOTEKV', model: 'EKV26',
    });
  });

  it.each(['test_ekv26_nmos', 'test_ekv26_pmos'])('matches the published Xyce 7.10 DC fixture %s', async name => {
    const root = new URL('../../../../benchmarks/reference/', import.meta.url);
    const report = JSON.parse(gunzipSync(readFileSync(new URL('ekv-static/after-identical.json.gz', root))).toString());
    const fixture = report.fixtures.find((row: { key: string }) => row.key === name);
    const input = readFileSync(new URL(`ekv/fixtures/${name}.cir`, root), 'utf8');
    expect(createHash('sha256').update(input).digest('hex')).toBe(fixture.sourceSha256);
    const result = await simulate(input.trimEnd() + '\n.end\n');
    const actual = result.dcSweep!.current('vdmon');
    const expected = fixture.xyce.series.signals['i(vdmon)'] as Array<{ re: number }>;
    expect(actual.length).toBe(expected.length);
    // Shared absolute tolerance for both decks, including zero-current points.
    // Relative residuals and zero exclusions are separately published in metrics.md.
    expected.forEach((value, i) => expect(Math.abs(actual[i] - value.re)).toBeLessThan(1e-9));
  });

  it.each([0, 1e8])('analytic terminal derivatives agree with central differences, E0=%s', e0 => {
    const model = new EKV26('n', [0, 1, 2, 3], { E0: e0, THETA: 0.2 });
    for (const gate of [-1, 0, 0.3, 0.5, 1, 3]) {
      for (const drain of [-0.2, 0.001, 0.1, 1, 3]) {
        const point: [number, number, number, number] = [drain, gate, 0, -0.2];
        const evaluated = model.evaluate(point);
        expect(Number.isFinite(evaluated.current)).toBe(true);
        for (let terminal = 0; terminal < 4; terminal++) {
          const plus: typeof point = [...point];
          const minus: typeof point = [...point];
          const h = 1e-6;
          plus[terminal] += h;
          minus[terminal] -= h;
          const fd = (model.evaluate(plus).current - model.evaluate(minus).current) / (2 * h);
          expect(Math.abs(fd - evaluated.derivatives[terminal]), `g=${gate}, d=${drain}, terminal=${terminal}`)
            .toBeLessThan(1e-12 + 2e-5 * Math.abs(fd));
        }
        expect(evaluated.derivatives.reduce((sum, x) => sum + x, 0)).toBeCloseTo(0, 14);
      }
    }
  });

  it('has continuous current and derivative through weak/moderate/strong inversion', () => {
    const model = new EKV26('n', [0, 1, 2, 3], { E0: 0, THETA: 0.2 });
    for (const gate of [-0.5, 0, 0.3, 0.5, 0.7, 1, 2]) {
      const left = model.evaluate([1, gate - 1e-7, 0, 0]);
      const right = model.evaluate([1, gate + 1e-7, 0, 0]);
      expect(Math.abs(left.current - right.current)).toBeLessThan(1e-9);
      expect(Math.abs(left.derivatives[1] - right.derivatives[1])).toBeLessThan(1e-9);
    }
    expect(model.evaluate([1, 0.3, 0, 0]).current).toBeGreaterThan(1e-12);
  });

  it('preserves NMOS/PMOS symmetry, drain reversal and common-mode invariance', () => {
    const params = { VTO: 0.5, E0: 0, THETA: 0.1 };
    const n = new EKV26('n', [0, 1, 2, 3], params);
    const p = new EKV26('p', [0, 1, 2, 3], { ...params, VTO: -0.5 }, {}, -1);
    for (const gate of [0, 0.3, 0.5, 1, 3]) {
      const nv = n.evaluate([1, gate, 0, -0.2]);
      const pv = p.evaluate([-1, -gate, 0, 0.2]);
      expect(pv.current).toBeCloseTo(-nv.current, 14);
      expect(pv.derivatives).toEqual(nv.derivatives);
      expect(n.evaluate([0, gate, 1, -0.2]).current).toBeCloseTo(-nv.current, 14);
      expect(n.evaluate([11, gate + 10, 10, 9.8]).current).toBeCloseTo(nv.current, 14);
      expect(n.evaluate([0, gate, 0, 0]).current).toBeCloseTo(0, 14);
    }
  });

  it('reduces current with body bias and THETA mobility degradation', () => {
    const plain = new EKV26('n', [0, 1, 2, 3], { E0: 0, THETA: 0 });
    const degraded = new EKV26('n', [0, 1, 2, 3], { E0: 0, THETA: 1 });
    const unbiased = plain.evaluate([1, 1, 0, 0]).current;
    expect(plain.evaluate([1, 1, 0, -0.5]).current).toBeLessThan(unbiased);
    expect(degraded.evaluate([1, 1, 0, 0]).current).toBeLessThan(unbiased);
  });

  it.each(['27 40 13', '40 27 -13'])('supports intrinsic DC TEMP sweeps (%s)', async grid => {
    const result = await simulate(deck().replace('.op', `.dc TEMP ${grid}`));
    const currents = result.dcSweep!.current('VD');
    expect(currents).toHaveLength(2);
    expect(currents[0]).not.toBe(currents[1]);
  });

  it('allows a nominal DC TEMP point with unchanged current', async () => {
    const nominal = await simulate(deck());
    const swept = await simulate(deck().replace('.op', '.dc TEMP 27 27 1'));
    expect(swept.dcSweep!.current('VD')[0]).toBeCloseTo(nominal.dc!.current('VD'), 14);
  });

  it('reports named deferred parameters and supports intrinsic nonnominal temperature', async () => {
    const result = await simulate(deck('TCV=0.001 KF=1e-20'));
    for (const parameter of ['KF']) {
      expect(result.warnings.some(w => w.message.includes(`parameter ${parameter}=`))).toBe(true);
    }
    const hot = await simulate(deck().replace('.op', '.options TEMP=40\n.op'));
    expect(-hot.dc!.current('VD')).toBeGreaterThan(1e-12);
    await expect(simulate(deck('TP_XTI=3').replace('.op', '.options TEMP=40\n.op'))).rejects.toMatchObject({
      code: 'UNSUPPORTED_TEMPERATURE', parameter: 'TP_XTI',
    });
    await expect(simulate(deck('RSH=1'))).rejects.toMatchObject({ code: 'UNSUPPORTED_MODEL_PARAMETER', parameter: 'RSH' });
    await expect(simulate(deck('TOX=1n'))).rejects.toMatchObject({ code: 'UNSUPPORTED_MODEL_PARAMETER', parameter: 'TOX' });
  });

  it.each<Record<string, number>>([{ L: 1e-9 }, { W: 1e-9 }, { COX: 0 }, { Q0: 1e-6, LK: 0 }])('rejects invalid geometry/parameters %j', params => {
    expect(() => new EKV26('n', [0, 1, 2, 3], params)).toThrow();
  });
});
