import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';

/**
 * Issue #861: ngspice-47 bjtload.c splits the base-collector depletion
 * capacitance by XCJC. The fraction czbc = XCJC*CJC sits on the internal
 * (base-prime) node inside qbc. The rest, czbx = (1 - XCJC)*CJC, is a
 * separate charge qbx from the external base node to the collector-prime
 * node. bjtacld.c stamps capbx the same way, and BJTtrunc leaves qbx out.
 *
 * Two-stage amplifier (NPN common emitter, PNP follower), both with RB > 0
 * and XCJC < 1. ngspice-47 `ngspice -b` on these bytes printed the values
 * below (`set numdgt=12`; the transient is linearized on a 0.2 ns grid).
 * With XCJC = 1 ngspice gives |v(c1)| = 2.90 at 31.6 MHz instead of 3.70,
 * so a lumped B-C capacitance fails these checks.
 */
const DECK = readFileSync(
  new URL('../../../../benchmarks/results/issue-861/decks/xcjc-rb-amplifier.cir', import.meta.url),
  'utf8',
);

function expectRelative(actual: number, expected: number, tolerance: number, label: string): void {
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(tolerance * Math.abs(expected));
}

describe('BJT XCJC < 1 with RB > 0 splits the B-C capacitance like ngspice-47 bjtload.c (#861)', () => {
  it('operating point', async () => {
    const dc = (await simulate(DECK)).dc!;
    expectRelative(dc.voltage('c1'), 2.875193518349e+00, 1e-9, 'v(c1)');
    expectRelative(dc.voltage('e1'), 1.457746531836e-01, 1e-9, 'v(e1)');
    expectRelative(dc.voltage('e2'), 3.648515071354e+00, 1e-9, 'v(e2)');
    expectRelative(dc.current('vcc'), -1.70469917954e-03, 1e-9, 'i(vcc)');
  });

  it('ac: capbx between the external base and the collector', async () => {
    const ac = (await simulate(DECK)).ac!;
    // [frequency, vm(c1), vp(c1), vm(e2), vp(e2)] (phase in radians).
    const reference = [
      [1e5, 1.185021699703e+01, 3.133761964509e+00, 1.160901109544e+01, 3.133688770201e+00],
      [3.162277660168e+5, 1.184524711356e+01, 3.109755177632e+00, 1.160414435559e+01, 3.109523716766e+00],
      [1e6, 1.179556788438e+01, 3.038945572055e+00, 1.155549607191e+01, 3.038213624105e+00],
      [3.162277660168e+6, 1.133089974606e+01, 2.824431442107e+00, 1.110047495593e+01, 2.822116679578e+00],
      [1e7, 8.513477437796e+00, 2.309298095358e+00, 8.341773102020e+00, 2.301973750506e+00],
      [3.162277660168e+7, 3.697424223288e+00, 1.689699349535e+00, 3.629028161753e+00, 1.666397970706e+00],
      [1e8, 1.284368285365e+00, 1.076374307163e+00, 1.281514474023e+00, 9.983026566741e-01],
      [3.162277660168e+8, 4.850442448363e-01, 1.746748552230e-01, 5.366168819960e-01, -1.95475188173e-01],
      [1e9, 2.715721313548e-01, -9.51296785349e-02, 1.434246826514e-01, -1.45171210108e+00],
    ];
    expect(ac.frequencies.length).toBe(reference.length);
    const c1 = ac.voltage('c1');
    const e2 = ac.voltage('e2');
    reference.forEach(([frequency, c1Magnitude, c1Phase, e2Magnitude, e2Phase], index) => {
      expectRelative(ac.frequencies[index], frequency, 1e-9, `f[${index}]`);
      expectRelative(c1[index].magnitude, c1Magnitude, 1e-7, `vm(c1) @ ${frequency}`);
      expect(Math.abs(c1[index].phase * Math.PI / 180 - c1Phase), `vp(c1) @ ${frequency}`).toBeLessThan(1e-7);
      expectRelative(e2[index].magnitude, e2Magnitude, 1e-7, `vm(e2) @ ${frequency}`);
      expect(Math.abs(e2[index].phase * Math.PI / 180 - e2Phase), `vp(e2) @ ${frequency}`).toBeLessThan(1e-7);
    });
  });

  it('transient: qbx integrated from the external base', async () => {
    const tran = (await simulate(DECK)).transient!;
    const sample = (signal: number[], t: number): number => {
      const k = tran.time.findIndex(x => x >= t);
      if (tran.time[k] === t || k === 0) return signal[k];
      const f = (t - tran.time[k - 1]) / (tran.time[k] - tran.time[k - 1]);
      return signal[k - 1] + f * (signal[k] - signal[k - 1]);
    };
    const c1 = tran.voltage('c1');
    const e2 = tran.voltage('e2');
    // [grid index (0.2 ns), v(c1), v(e2)]. XCJC = 1 is off by 0.1-0.2 V here.
    for (const [index, vc1, ve2] of [
      [60, 2.844457476778e+00, 3.630554782705e+00],
      [75, 2.448655465547e+00, 3.241577422590e+00],
      [100, 1.932333461654e+00, 2.728553742366e+00],
      [150, 1.311939095800e+00, 2.111455049516e+00],
      [250, 7.871839420667e-01, 1.589202282897e+00],
      [280, 8.599707650535e-01, 1.651948502232e+00],
      [300, 1.194856122300e+00, 1.983972738750e+00],
      [400, 2.325797591583e+00, 3.105367145028e+00],
      [560, 2.772487037850e+00, 3.559280256485e+00],
      [575, 2.391490092053e+00, 3.184795316517e+00],
      [600, 1.892834899573e+00, 2.689277132131e+00],
    ]) {
      const t = index * 0.2e-9;
      expect(Math.abs(sample(c1, t) - vc1), `v(c1) @ ${t}`).toBeLessThan(2.5e-3);
      expect(Math.abs(sample(e2, t) - ve2), `v(e2) @ ${t}`).toBeLessThan(2.5e-3);
    }
  });

  it('.noise supports the self-stamped RB thermal noise (#1347)', async () => {
    await expect(simulate([
      'xcjc noise',
      'vcc vcc 0 5',
      'vin in 0 dc 0.8 ac 1',
      'rc vcc c 1k',
      'q1 c in 0 qn',
      '.model qn npn (rb=100 cjc=1p xcjc=0.5)',
      '.noise v(c) vin dec 1 1k 10k',
      '.end',
    ].join('\n'))).resolves.toHaveProperty('noise');
  });
});
