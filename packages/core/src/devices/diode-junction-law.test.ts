import { describe, it, expect } from 'vitest';
import { simulate } from '../simulate.js';

// Reference values come from ngspice-47 (`ngspice -b`, `set numdgt=13`) run on
// the identical decks (#643). dioload.c computes the bottom current cdb and
// the sidewall current cdsw separately: the IKF knee and IKR reverse knee act
// on cdb only, IKP on cdsw only, both use the reverse law
// -csat*(1 + (3*vte/(vd*e))^3) below -3*N*vt, and the junction current is
// cd = cdb + cdsw + CKTgmin*vd.

// ngspice stops Newton once its reltol/vntol test passes, so its printed
// operating points carry a few microvolts of residual.
const NGSPICE_NEWTON_RESIDUAL = 1e-5;
// ngspice ends its breakdown-knee iteration at reltol*IBV (diotemp.c).
const NGSPICE_BREAKDOWN_RESIDUAL = 3e-5;
// `.meas` prints seven significant digits, and ngspice's timesteps differ.
const TRANSIENT_TOLERANCE = 1e-3;

function expectNear(actual: number, expected: number, tolerance: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(tolerance);
}

function expectRelative(actual: number, expected: number, tolerance: number): void {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(tolerance);
}

async function operatingPoint(
  model: string,
  { source = 5, resistance = '1k', instance = 'pj=2' }: {
    source?: number; resistance?: string; instance?: string;
  } = {},
) {
  const result = await simulate(`diode junction law
    V1 in 0 ${source}
    R1 in out ${resistance}
    D1 out 0 DJ ${instance}
    .model DJ D ${model}
    .op
    .end
  `);
  return { out: result.dc!.voltage('out'), current: result.dc!.current('V1') };
}

describe('diode bottom/sidewall junction law like ngspice-47 dioload.c (#643)', () => {
  it('applies the IKF knee to the bottom current only, not the merged sidewall (issue deck)', async () => {
    // ngspice-47: v(out) = 6.7498176336689e-01 (spice-ts put the knee on IS+JSW*PJ: 0.772375)
    const { out } = await operatingPoint('IS=1e-16 JSW=1e-14 IKF=1e-4');
    expectNear(out, 0.67498176336689, NGSPICE_NEWTON_RESIDUAL);
  });

  it('scales IKF with AREA*M and the sidewall with PJ*M', async () => {
    // ngspice-47: v(out) = 7.1625668366588e-01
    const { out } = await operatingPoint('IS=1e-16 JSW=1e-14 IKF=1e-4', {
      resistance: '100', instance: 'area=3 pj=2 m=2',
    });
    expectNear(out, 0.71625668366588, NGSPICE_NEWTON_RESIDUAL);
  });

  it('includes GMIN*vd in the junction current (issue deck, NS sidewall)', async () => {
    // ngspice-47: i(v1) = 9.9937109673420e-07 (spice-ts: 9.993700977e-07)
    const { current } = await operatingPoint('IS=1e-14 JSW=1e-6 NS=3', { source: -1, instance: 'pj=1' });
    expectRelative(current, 9.9937109673420e-07, 1e-7);
  });

  it('includes GMIN*vd in a reverse-biased plain junction', async () => {
    // ngspice-47: i(v1) = 5.0099949875474e-12 (GMIN*5 V dominates IS)
    const { current } = await operatingPoint('IS=1e-14', { source: -5, resistance: '1meg', instance: '' });
    expectRelative(current, 5.0099949875474e-12, 1e-6);
  });

  it('uses the reverse law below -3*N*vt for the bottom junction', async () => {
    // ngspice-47: v(out) = -1.990236040297e-01, i(v1) = 9.7639597032267e-07
    const { out, current } = await operatingPoint('IS=1e-6 N=2', { source: -0.2, instance: '' });
    expectNear(out, -0.1990236040297, 1e-9);
    expectRelative(current, 9.7639597032267e-07, 1e-7);
  });

  it('uses the reverse law for the merged sidewall too', async () => {
    // ngspice-47: i(v1) = 9.9997767887339e-07
    const { current } = await operatingPoint('IS=1e-14 JSW=1e-6', { source: -1, instance: 'pj=1' });
    expectRelative(current, 9.9997767887339e-07, 1e-7);
  });

  it('breaks down the bottom junction only when the merged sidewall shares N', async () => {
    // dioload.c evaluates the merged sidewall breakdown at vdsw, which is 0
    // without RSW, so only cdb carries the breakdown current.
    // ngspice-47: v(out) = -5.059279477959e+00 (spice-ts: -5.041422)
    const { out } = await operatingPoint('IS=1e-9 JSW=1e-9 BV=5 IBV=1e-3', { source: -10, instance: 'pj=1' });
    expectNear(out, -5.059279477959, NGSPICE_BREAKDOWN_RESIDUAL);
  });

  it('applies the IKP knee to the merged sidewall current', async () => {
    // ngspice-47: v(out) = 7.8730151065500e-01 (spice-ts ignored IKP: 0.674938)
    const { out } = await operatingPoint('IS=1e-16 JSW=1e-14 IKP=1e-5');
    expectNear(out, 0.787301510655, NGSPICE_NEWTON_RESIDUAL);
  });

  it('applies IKP to the NS sidewall and IKF to the bottom', async () => {
    // ngspice-47: v(out) = 9.0788849132085e-01
    const { out } = await operatingPoint('IS=1e-16 JSW=1e-14 NS=2 IKP=1e-5 IKF=1e-4');
    expectNear(out, 0.90788849132085, NGSPICE_NEWTON_RESIDUAL);
  });

  it('applies the IKR reverse knee to the bottom current, scaled by AREA', async () => {
    // ngspice-47: v(out) = -9.995194997948e-01 (spice-ts ignored IKR: -0.998)
    const { out } = await operatingPoint('IS=1e-6 IKR=1e-7', { source: -1, instance: 'area=2' });
    expectNear(out, -0.9995194997948, 1e-9);
  });

  it('matches the knee laws across a DC sweep', async () => {
    const result = await simulate(`diode junction law dc
      V1 in 0 0
      R1 in out 1k
      D1 out 0 DJ pj=2
      .model DJ D IS=1e-16 JSW=1e-14 IKF=1e-4 IKP=1e-5
      .options reltol=1e-6
      .dc V1 -2 5 1
      .end
    `);
    // ngspice-47 `.dc V1 -2 5 1`, v(out). RELTOL=1e-6 in both simulators: at
    // the default 1e-3 ngspice's sweep stops up to 4.7e-4 V short of its own
    // `.op` at the same bias, which spice-ts matches to 1e-7.
    const expected = [
      -1.99999999798, -0.9999999989799, 0, 0.67974062323549, 0.74585943986098,
      0.77434721207471, 0.79268343756679, 0.80622395889862,
    ];
    const out = result.dcSweep!.voltage('out');
    expected.forEach((value, index) => expectNear(out[index]!, value, 1e-6));
  });

  it('linearises the knee-limited bottom current in AC', async () => {
    const result = await simulate(`diode junction law ac
      V1 in 0 DC 3 AC 1
      R1 in out 1k
      D1 out 0 DJ pj=2
      .model DJ D IS=1e-16 JSW=1e-14 IKF=1e-4 CJO=10p TT=1n
      .ac lin 1 10meg 10meg
      .end
    `);
    // ngspice-47: vr(out) = 1.0874740481684e-02, vi(out) = -7.982668899258e-04
    const point = result.ac!.voltage('out')[0]!;
    const phase = point.phase * Math.PI / 180;
    expectRelative(point.magnitude * Math.cos(phase), 1.0874740481684e-02, 1e-4);
    expectRelative(point.magnitude * Math.sin(phase), -7.982668899258e-04, 1e-4);
  });

  it('matches a pulsed transient with IKF, IKP, CJO and TT', async () => {
    const result = await simulate(`diode junction law tran
      V1 in 0 PULSE(-2 4 1n 1n 1n 20n 50n)
      R1 in out 1k
      D1 out 0 DJ pj=2
      .model DJ D IS=1e-16 JSW=1e-14 IKF=1e-4 IKP=1e-5 CJO=2p TT=1n
      .tran 0.1n 60n
      .end
    `);
    const tran = result.transient!;
    const at = (time: number) => interpolate(tran.time, tran.voltage('out'), time);
    // ngspice-47 `.meas tran ... find v(out) at=`: 7.926831e-01, -1.979757, -2.0
    expectNear(at(15e-9), 0.7926831, TRANSIENT_TOLERANCE);
    expectNear(at(30e-9), -1.979757, TRANSIENT_TOLERANCE);
    expectNear(at(45e-9), -2, TRANSIENT_TOLERANCE);
  });

  it('supports RSW on a compiled junction instead of rejecting it', async () => {
    const result = await operatingPoint('IS=1e-16 JSW=1e-14 NS=1 RSW=10');
    expect(result.out).toBeGreaterThan(0);
  });
});

function interpolate(times: ArrayLike<number>, values: ArrayLike<number>, time: number): number {
  let index = 0;
  while (index < times.length - 2 && times[index + 1]! < time) index++;
  const fraction = (time - times[index]!) / (times[index + 1]! - times[index]!);
  return values[index]! + fraction * (values[index + 1]! - values[index]!);
}
