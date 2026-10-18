import { describe, expect, it, vi } from 'vitest';
import { simulate } from '../simulate.js';
import { readFileSync } from 'node:fs';
import { VDMOS } from './vdmos.js';
import { resolveVdmosModel } from './vdmos-model.js';
import { MNAAssembler } from '../mna/assembler.js';

describe('VDMOS self heating (#559)', () => {
  it.each([1, -1])('stamps the analytic DC power Jacobian without voltage perturbations, polarity %s (#1358)', type => {
    const { model } = resolveVdmosModel({ name: 'power', type: type === 1 ? 'VDMOSN' : 'VDMOSP', params: { VTO: type, KP: 0.1, MU: 0, IS: 1e-100, N: 100, RTHJC: 2 } });
    for (const mode of [1, -1]) {
      const device = new VDMOS('M1', [0, 1, 4, 0, 1, 4, 4, 2, 3], model, {});
      const assembler = new MNAAssembler(5, 0);
      // A large common-mode voltage must not change intrinsic derivatives.
      const common = 1e6;
      assembler.solution.set([common + type * mode * 2, common + type * 3, 27, 27, common]);
      const evaluate = vi.spyOn(device, 'evaluateChannel');
      device.stamp(assembler.getStampContext());
      expect(evaluate.mock.calls.length).toBeLessThanOrEqual(5);
      evaluate.mockRestore();
      const { cdrain, gm, gds } = device.evaluateChannel(3, mode * 2);
      const vd = type * mode * 2;
      const current = type * mode * cdrain;
      const drain = current + vd * (gds + (mode === -1 ? gm : 0));
      const gate = vd * mode * gm;
      expect(assembler.G.get(2, 0)).toBeCloseTo(-drain, 11);
      expect(assembler.G.get(2, 1)).toBeCloseTo(-gate, 11);
      expect(assembler.G.get(2, 4)).toBeCloseTo(drain + gate, 11);
    }
  });
  it.each([1, -1])('differentiates series resistance and quasi-saturation power, polarity %s', type => {
    const { model } = resolveVdmosModel({ name: 'power', type: type === 1 ? 'VDMOSN' : 'VDMOSP', params: {
      VTO: type, KP: 0, MU: 0, RD: 0.2, RS: 0.1, RB: 0.3, RQ: 0.4, VQ: 2, IS: 1e-100, N: 100, RTHJC: 2,
    } });
    for (const mode of [1, -1]) {
      const v = [type * mode * 2.1, type * 3, type * 0.1, type * mode * 2, type * 3, 0, type * mode * 1.9, 27, 27];
      const device = new VDMOS('M1', [0, 1, 2, 3, 4, 5, 6, 7, 8], model, {});
      const assembler = new MNAAssembler(9, 0);
      assembler.solution.set(v);
      device.stamp(assembler.getStampContext());
      const power = (voltages: number[]) => {
        const external = type * (voltages[0] - voltages[2]);
        const rd = model.rd + (mode === 1 ? model.rq * external / (external + Math.abs(model.vq)) : 0);
        return (voltages[0] - voltages[3]) ** 2 / rd
          + (voltages[2] - voltages[5]) ** 2 / model.rs
          + (voltages[2] - voltages[6]) ** 2 / model.diode.rb;
      };
      for (let col = 0; col < 7; col++) {
        const plus = v.slice();
        const minus = v.slice();
        plus[col] += 1e-5;
        minus[col] -= 1e-5;
        expect(assembler.G.get(7, col)).toBeCloseTo(-(power(plus) - power(minus)) / 2e-5, 7);
      }
    }
  });
  it.each([1, -1])('uses vdmosacld thermal signs for polarity %s in both modes', type => {
    const { model } = resolveVdmosModel({ name: 'power', type: type === 1 ? 'VDMOSN' : 'VDMOSP', params: { VTO: type, KP: 0.1, MU: -1.5, RTHJC: 2, CTHJ: 0.001 } });
    for (const mode of [1, -1]) {
      // Keep intrinsic SP in the matrix: grounding it hides the inverse
      // thermal source-row sign in vdmosacld.c.
      const device = new VDMOS('M1', [0, 1, 4, 0, 1, 4, -1, 2, 3], model, {});
      const assembler = new MNAAssembler(5, 0);
      assembler.solution.set([type * mode * 2, type * 3, 27, 27, 0]);
      const ctx = assembler.getStampContext();
      device.stampSmallSignal(ctx);
      device.stampDynamic(ctx);
      const { gm, gds, cdrain } = device.evaluateChannel(3, mode * 2);
      const gate = mode * type * gm * 2;
      const drain = mode * type * (gds * 2 + cdrain);
      const gmT = -1.5 * cdrain / 300.15;
      expect(assembler.G.get(2, 1)).toBeCloseTo(gate, 12);
      expect(assembler.G.get(2, 0)).toBeCloseTo(drain, 12);
      expect(assembler.G.get(2, 4)).toBeCloseTo(-mode * (gate + drain), 12);
      expect(assembler.G.get(0, 2)).toBeCloseTo(type * mode * gmT, 12);
      expect(assembler.G.get(4, 2)).toBeCloseTo(-type * mode * gmT, 12);
      // Assert both complete thermal rows, including gtempT, the case
      // network, and the inverse CTHJ sign (vdmosacld.c:141-160).
      const thermalRows = [
        [drain, gate, mode * gmT * 2 + 1 / model.rthjc, -1 / model.rthjc, -mode * (gate + drain)],
        [0, 0, -1 / model.rthjc, 1 / model.rthjc + 1 / model.rthca, 0],
      ];
      for (const [i, row] of thermalRows.entries()) {
        for (const [col, expected] of row.entries()) {
          expect(assembler.G.get(2 + i, col)).toBeCloseTo(expected, 12);
          expect(assembler.C.get(2 + i, col)).toBeCloseTo(i === 0 && col === 2 ? mode * 0.001 : 0, 12);
        }
      }
      for (const row of [0, 1, 4]) expect(assembler.C.get(row, 2)).toBe(0);
    }
  });
  it('integrates CTHJ after a gate step with the expected thermal time constant', async () => {
    const result = await simulate(`thermal transient
m1 d g 0 tj tc power thermal
.model power vdmos vto=1 kp=2 mu=0 rthjc=2 cthj=1m cgs=0 cgdmin=0 cgdmax=0 cjo=0
vd d 0 2
vg g 0 pulse(0 3 1m 1n 1n 20m 40m)
vc tc 0 27
.tran 10u 5m
.end
`);
    const tran = result.transient!;
    const tj = tran.voltage('tj');
    const index = Array.from(tran.time).findIndex(t => t >= 0.003);
    const expected = 27 + 16 * (1 - Math.exp(-(tran.time[index] - 0.001) / 0.002));
    expect(Math.abs(tj[index] - expected)).toBeLessThan(0.02);
  });
  it('matches ngspice-47 on the unchanged corpus-f self-heating sweep', async () => {
    const deck = readFileSync(new URL('../../../../benchmarks/corpus/corpus-f/fixtures/examples/vdmos/self-heating.sp', import.meta.url), 'utf8');
    const result = await simulate(deck);
    const dc = result.dcSweep!;
    expect(dc.sweepValues.length).toBe(2495);
    // ngspice-47 ASCII raw export, same deck, only `write ... all` added.
    for (const [i, tj, tc, current] of [
      [0, 0.003618145727779173, 0.002970061661818526, -0.3240420429808509],
      [498, 8.329574578961502, 5.949996842160471, -2.384351420618038],
      [499, 0.006310054699010336, 0.004892826316060011, -0.7086142014751633],
      [1247, 81.43689687103901, 58.16876678264526, -46.53627282866886],
      [2494, 330.7067766285617, 236.2161373612961, -94.68004655461681],
    ]) {
      for (const [actual, expected] of [[dc.voltage('tj')[i], tj], [dc.voltage('tc')[i], tc], [dc.current('vd')[i], current]]) {
        expect(Math.abs(actual - expected)).toBeLessThan(0.01 * Math.abs(expected) + 1e-8);
      }
    }
  });
  it.each(['thermal', 'thermal=1'])('balances DC channel power through Tj/Tc (%s)', async flag => {
    const result = await simulate(`thermal balance
m1 d g 0 tj tc power ${flag}
.model power vdmos vto=1 kp=2 mu=0 rthjc=2 rthca=3 cthj=1m
vd d 0 2
vg g 0 3
.options reltol=1e-9
.op
.end
`);
    const op = result.dc!;
    const power = -2 * op.current('vd');
    expect(Math.abs(op.voltage('tj') - op.voltage('tc') - 2 * power)).toBeLessThan(1e-6 * power);
    expect(Math.abs(op.voltage('tc') - 27 - 3 * power)).toBeLessThan(1e-6 * power);
  });
});
