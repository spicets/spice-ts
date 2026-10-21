import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { BJT } from './bjt.js';
import type { StampContext } from './device.js';

const deck = readFileSync(new URL('./fixtures/bjt-ptf-1142.cir', import.meta.url), 'utf8');

function snapshot(result: Awaited<ReturnType<typeof simulate>>): string {
  return createHash('sha256').update(JSON.stringify({
    ac: result.ac!.voltage('c'), time: Array.from(result.transient!.time),
    c: Array.from(result.transient!.voltage('c')), vb: Array.from(result.transient!.current('vb')),
  })).digest('hex');
}

describe('ngspice-47 BJT excess phase (#1142)', () => {
  it('matches the AC complex collector voltage, including degrees-to-radians conversion', async () => {
    const result = await simulate(deck);
    // ngspice-47 -b -r on identical bytes, SHA pinned below.
    expect(createHash('sha256').update(deck).digest('hex'))
      .toBe('065857c9e9ba790e9555d77deaf88cf9c7f0575efb5cf7f43d6f44d503081406');
    const reference = [
      [-3.380193859442165, 0.02225179771983113],
      [-3.372949105045676, 0.2223590587910403],
      [-2.674239633222521, 2.068077003414285],
      [-3.232647696315098, 0.9882682250244067],
    ];
    result.ac!.voltage('c').forEach((p, i) => {
      const angle = p.phase * Math.PI / 180;
      expect(Math.abs(p.magnitude * Math.cos(angle) - reference[i][0])).toBeLessThan(1e-6);
      expect(Math.abs(p.magnitude * Math.sin(angle) - reference[i][1])).toBeLessThan(1e-6);
    });
  });

  it('matches the ngspice transient collector step response', async () => {
    const result = await simulate(deck);
    const time = result.transient!.time;
    const voltage = result.transient!.voltage('c');
    const reference = [
      [0, 4.911677953672221], [2e-9, 4.911677953672179],
      [2.1e-9, 4.911476427026984], [2.503308537735722e-9, 4.904083725361967],
      [3.00330853773573e-9, 4.890875166008371],
      [4.003308537735736e-9, 4.874889475695534], [8e-9, 4.870586282286506],
    ];
    for (const [t, expected] of reference) {
      const upper = time.findIndex(x => x >= t);
      const i = upper < 0 ? time.length - 1 : upper;
      const actual = i === 0 ? voltage[0] : voltage[i - 1]
        + (voltage[i] - voltage[i - 1]) * (t - time[i - 1]) / (time[i] - time[i - 1]);
      expect(Math.abs(actual - expected)).toBeLessThan(2e-5);
    }
  });

  it('keeps PTF=0 bit-identical to the omitted-PTF AC and transient result', async () => {
    const zero = await simulate(deck.replace('PTF=60', 'PTF=0'));
    // Smith division changes AC magnitude by <= 4.45e-16 from the old
    // modulus-squared baseline; transient samples and AC phases are unchanged.
    expect(snapshot(zero)).toBe('b33437938c49dd06172c28564292b7366f4a0b2dd584673a7a2b08d106c5df50');
    expect(snapshot(await simulate(deck.replace('PTF=60', '')))).toBe(snapshot(zero));
  });

  it('keeps nonzero PTF inert when TF is zero', async () => {
    const noTransit = deck.replace('TF=1n', 'TF=0');
    expect(snapshot(await simulate(noTransit)))
      .toBe(snapshot(await simulate(noTransit.replace('PTF=60', 'PTF=0'))));
  });

  it('mirrors the common-emitter AC and transient response for PNP', async () => {
    const npn = await simulate(deck);
    // Explicit vertical substrate, matching the NPN default (PNP defaults lateral).
    const pnp = await simulate(deck.replace('NPN(', 'PNP(SUBS=1 ').replace('supply 0 5', 'supply 0 -5')
      .replace('DC 0.65', 'DC -0.65').replace('PULSE(0.65 0.66', 'PULSE(-0.65 -0.66'));
    pnp.ac!.voltage('c').forEach((p, i) => {
      expect(p.magnitude).toBeCloseTo(npn.ac!.voltage('c')[i].magnitude, 10);
      expect(p.phase).toBeCloseTo(npn.ac!.voltage('c')[i].phase, 10);
    });
    expect(pnp.transient!.time).toEqual(npn.transient!.time);
    pnp.transient!.voltage('c').forEach((v, i) => {
      expect(v).toBeCloseTo(-npn.transient!.voltage('c')[i], 10);
    });
  });

  it('does not commit rejected delay trials, and reset restarts the history', () => {
    const run = (retry: boolean, device = new BJT('Q1', [0, 1, -1], { TF: 1e-9, PTF: 60 })) => {
      let base = 0.65;
      const stamps: number[] = [];
      const ctx: StampContext = {
        getVoltage: n => n === 0 ? 5 : n === 1 ? base : 0, getCurrent: () => 0,
        stampG: (r, c, v) => { stamps.push(r, c, v); },
        stampB: (r, v) => { stamps.push(r, v); }, stampC: () => {},
        time: 0, dt: 0, numNodes: 2, sourceScale: 1, useDcSourceValue: false,
      };
      device.resetTransient();
      device.acceptTransientStep(ctx);
      base = 0.66;
      for (const dt of [1e-10, 2e-10, 0.5e-10]) {
        if (retry) {
          ctx.dt = dt * 2;
          device.beginTransientNewton();
          device.stamp(ctx);
        }
        ctx.dt = dt;
        device.beginTransientNewton();
        stamps.length = 0;
        device.stamp(ctx);
        device.acceptTransientStep(ctx);
      }
      return { stamps: [...stamps], device };
    };
    const reference = run(false);
    expect(run(true).stamps).toEqual(reference.stamps);
    expect(run(false, reference.device).stamps).toEqual(reference.stamps);
  });

  it('runs the unchanged corpus-g gstep_cont3a fixture', async () => {
    const fixture = readFileSync(new URL(
      '../../../../benchmarks/corpus/corpus-g/fixtures/GMIN_STEPPING/gstep_cont3a.cir', import.meta.url,
    ), 'utf8');
    expect(createHash('sha256').update(fixture).digest('hex'))
      .toBe('3d1873a8b9fd3e791ee86f84b4875f8475e449478b5d3e49bd9b21bedd938179');
    const result = await simulate(fixture);
    expect(result.transient!.time).toHaveLength(10008);
    expect(result.transient!.current('VIC').every(Number.isFinite)).toBe(true);
  });
});
