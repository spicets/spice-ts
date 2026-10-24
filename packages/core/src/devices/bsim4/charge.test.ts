import { beforeAll, describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { readFileSync } from 'node:fs';
import { evaluateBsim4Charges } from './charge.js';
import { setupBsim4Instance, setupBsim4Model } from './setup.js';
import { preprocessBsim4 } from './temp.js';

export const inverter = `BSIM4 inverter charge regression
.model N NMOS level=54
.model P PMOS level=54
Vdd vdd 0 1.8
Vin in 0 PULSE(0 1.8 100p 50p 50p 300p 800p)
Mn out in 0 0 N l=1u w=10u
Mp out in vdd vdd P l=1u w=20u
Cload out 0 10f
.tran 2p 1n
.end`;

describe('BSIM4 capMod=2 transient', () => {
  const voltageErrors: Record<string, number> = {};
  beforeAll(async () => {
    const reference = JSON.parse(readFileSync(new URL('./inverter-reference.json', import.meta.url), 'utf8')) as { grid: number[]; voltages: Record<string, number[]> };
    const actual = (await simulate(inverter)).transient!;
    for (const [signal, expected] of Object.entries(reference.voltages)) {
      const values = actual.voltage(signal.slice(2, -1));
      expect(values.length).toBe(actual.time.length);
      const peak = Math.max(...expected.map(Math.abs), 1e-4);
      let maxError = 0;
      let j = 0;
      for (let i = 0; i < reference.grid.length; i++) {
        const t = reference.grid[i];
        while (j + 1 < actual.time.length - 1 && actual.time[j + 1] < t) j++;
        const weight = (t - actual.time[j]) / (actual.time[j + 1] - actual.time[j]);
        const value = values[j] + weight * (values[j + 1] - values[j]);
        expect(Number.isFinite(value)).toBe(true);
        maxError = Math.max(maxError, Math.abs(value - expected[i]) / peak);
      }
      voltageErrors[signal] = maxError;
    }
  });
  // Same peak floor and 1% criterion as corpus-f/lib.ts, not a circuit-specific
  // tolerance. Native fringe preprocessing repairs the former #1367 loss.
  it.each(['v(in)', 'v(vdd)'])('matches ngspice-47 %s within the shared 1% peak bound', signal => {
    expect(voltageErrors[signal]).toBeLessThanOrEqual(0.01);
  });
  it('matches ngspice-47 v(out) within the shared 1% peak bound', () => {
    expect(voltageErrors['v(out)']).toBeLessThanOrEqual(0.01);
  });
  it('integrates intrinsic and overlap charges through 1ns', async () => {
    const result = await simulate(inverter);
    expect(result.transient).toBeDefined();
    expect(result.transient!.time.at(-1)).toBeCloseTo(1e-9, 20);
  });
  it('runs the unchanged corpus-g FD deck to 1ns', async () => {
    const deck = readFileSync(new URL('../../../../../benchmarks/corpus/corpus-g/fixtures/SENS/bsim4_issue694_FD.cir', import.meta.url), 'utf8');
    const result = await simulate(deck);
    expect(result.transient!.time.at(-1)).toBeCloseTo(1e-9, 20);
  });
  it.each([0, 1])('retains structured rejection for capMod=%s', async capmod => {
    await expect(simulate(inverter.replace('level=54', `level=54 capmod=${capmod}`))).rejects.toMatchObject({ code: 'UNSUPPORTED_MODEL_PARAMETER' });
  });
  for (const nf of [1, 2]) for (const vds of [-0.7, 0, 0.7]) for (const vgs of [-0.3, 0.8, 1.8]) {
    it(`conserves charge and matches finite differences: nf=${nf}, Vds=${vds}, Vgs=${vgs}`, () => {
      const model = setupBsim4Model({});
      const instance = setupBsim4Instance(model, { l: 1e-6, w: 10e-6, nf }, { d: 1, g: 2, s: 0, b: 3 });
      const p = preprocessBsim4(model, instance);
      const v = [vds, vgs, 0, -0.2];
      const evaluate = (v: number[]) => evaluateBsim4Charges(p, model.given, { vgs: v[1] - v[2], vds: v[0] - v[2], vbs: v[3] - v[2] });
      const tc = evaluate(v);
      expect(Math.abs(tc.q.reduce((a, b) => a + b, 0))).toBeLessThan(1e-27);
      for (let c = 0; c < 4; c++) {
        const plus = [...v], minus = [...v];
        plus[c] += 1e-6; minus[c] -= 1e-6;
        // At Vds=0 ngspice chooses the forward-mode Jacobian; do not average
        // the two orientation branches across that boundary.
        const oneSided = vds === 0 && (c === 0 || c === 2);
        const qp = oneSided && c === 2 ? tc.q : evaluate(plus).q;
        const qm = oneSided && c === 0 ? tc.q : evaluate(minus).q;
        for (let r = 0; r < 4; r++) {
          const numeric = (qp[r] - qm[r]) / (oneSided ? 1e-6 : 2e-6);
          expect(Math.abs(tc.jacobian[4 * r + c] - numeric)).toBeLessThan(1e-4 * Math.max(Math.abs(numeric), 1e-15));
        }
      }
    });
  }
});
