import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTitleless as parse } from '../parser/index.js';
import { parseLtraModelCard } from '../parser/transmission-line-parser.js';
import { simulate } from '../simulate.js';
import { LossyTransmissionLine, LtraModelState } from './lossy-transmission-line.js';
import { resolveLtraModel } from './ltra-model.js';

const classicFixture = readFileSync(new URL(
  '../../../../benchmarks/corpus/classic/fixtures/spice3f5/ltra_1.cir',
  import.meta.url,
));

const lineStep = `V1 source 0 PULSE(0 1 1n 100p 100p 100n 200n)
RS source input 50
O1 input 0 output 0 LMOD
RL output 0 50
.model LMOD LTRA(R=2 L=250n G=0 C=100p LEN=1 STEPLIMIT)
.tran 20p 12n 0 20p
`;

/** The classic 24-inch RLC line between a 10 ohm source and a 200 ohm || 1 pF load. */
const rlcLine = `VS 1 0 PULSE(0 4 1n 1n 1n 20n 40n)
RS 1 2 10
o2 2 0 3 0 lline
RL 3 0 200
CL 3 0 1p
.model lline ltra rel=1 r=0.2 g=0 l=9.13e-9 c=3.65e-12 len=24 steplimit compactrel=1.0e-3 compactabs=1.0e-14
.tran 0.1ns 60ns
`;

/** A lossless 16 cm LC line (the ltra_2 lless helpers' L and C) with slow edges. */
const lcLine = `VS 1 0 PULSE(0 5 1n 3n 3n 5n 30n)
RS 1 2 50
o1 2 0 3 0 lline
CL 3 0 0.1p
RL 3 0 1k
.model lline ltra nocontrol rel=10 r=0 g=0 l=8.972e-9 c=0.468e-12 len=16 steplimit quadinterp
.tran 0.2n 30n 0 0.1n
`;

/**
 * ngspice-47 references for the identical netlists above (`ngspice -b -r`,
 * linear interpolation of the raw transient at each time). The removed
 * 8-section ladder approximation missed them by up to 0.25 V (RLC) and
 * 0.07 V (LC).
 */
const RLC_REFERENCE: Array<[string, number, number]> = [
  ['2', 3e-9, 3.34251], ['2', 8e-9, 3.37122], ['2', 12e-9, 3.98509], ['2', 20e-9, 3.75076],
  ['2', 32e-9, -0.152739], ['2', 40e-9, -0.106731], ['2', 50e-9, 3.43898],
  ['3', 5e-9, 0], ['3', 8e-9, 5.08042], ['3', 12e-9, 5.07706], ['3', 16e-9, 3.23034],
  ['3', 20e-9, 3.23259], ['3', 26e-9, 3.90410], ['3', 32e-9, -1.17435], ['3', 40e-9, 0.428002],
  ['3', 50e-9, 4.91591],
];

const LC_REFERENCE: Array<[string, number, number]> = [
  ['2', 1.5e-9, 0.612242], ['2', 5e-9, 4.60677], ['2', 7e-9, 4.83477], ['2', 14e-9, -0.195454],
  ['3', 1.5e-9, 0], ['3', 5e-9, 5.68770], ['3', 7e-9, 4.47974], ['3', 14e-9, -0.269146],
  ['3', 20e-9, 0.0223430],
];

function sampleAt(time: Float64Array | number[], values: Float64Array | number[], t: number): number {
  let index = 1;
  while (index < time.length - 1 && time[index] < t) index++;
  const fraction = (t - time[index - 1]) / (time[index] - time[index - 1]);
  return values[index - 1] + fraction * (values[index] - values[index - 1]);
}

describe('ngspice LTRA lossy transmission line', () => {
  it.each([
    ['nosteplimit steplimit=0 lininterp mixedinterp quadinterp', true, 'quadratic'],
    ['steplimit nosteplimit=0 quadinterp mixedinterp lininterp', false, 'linear'],
    ['lininterp quadinterp mixedinterp=0', true, 'mixed'],
  ] as const)('uses the last ngspice selector, independent of flag value: %s', (controls, stepLimit, interpolation) => {
    const card = `.model LMOD LTRA R=2 L=250n C=100p LEN=1 ${controls}`;
    const model = resolveLtraModel(parseLtraModelCard(card.split(' '), 1));
    expect(model.stepLimit).toBe(stepLimit);
    expect(model.interpolation).toBe(interpolation);
  });

  it.each([
    'steplimit=1 compactrel=1e-3 compactabs=1e-14 nocontrol=1 noprint=1',
    'nosteplimit truncdontcut lininterp',
    'steplimit=0 quadinterp=0',
    'mixedinterp truncnr',
  ])('runs transient with ngspice model controls: %s', async controls => {
    const result = await simulate(parse(lineStep.replace('STEPLIMIT', controls)));
    expect(result.transient!.time.at(-1)).toBeCloseTo(12e-9, 15);
    expect(result.transient!.voltage('output').at(-1)).toBeGreaterThan(0.4);
    if (controls.includes('truncnr')) {
      expect(result.warnings.some(warning => warning.message.includes('TRUNCNR'))).toBe(true);
    }
  });

  it('executes the unchanged corpus-g LTRA/ltra1 fixture', async () => {
    const fixture = readFileSync(new URL(
      '../../../../benchmarks/corpus/corpus-g/fixtures/LTRA/ltra1.cir', import.meta.url,
    ));
    expect(createHash('sha256').update(fixture).digest('hex'))
      .toBe('9ecb2e652071bef1cfd099a369e2c03e7990f63c06ea729792cb526ad5c31c0f');
    const result = await simulate(fixture.toString('utf8'));
    expect(result.transient!.time.at(-1)).toBeCloseTo(60e-9, 15);
  }, 30_000);

  it('executes the unchanged classic 24-inch lossy-line fixture', async () => {
    expect(createHash('sha256').update(classicFixture).digest('hex'))
      .toBe('53e333e9629c3e3c4e839c4b72c9a512a220dec4baf0536e36626f290d240cd6');

    const result = await simulate(classicFixture.toString('utf8'));

    expect(result.transient?.time.length).toBeGreaterThan(1);
    expect(result.transient?.time.at(-1)).toBeCloseTo(60e-9, 15);
  }, 30_000);

  it('holds the far end at rest until the 5 ns flight time, then delivers an attenuated step', async () => {
    const result = await simulate(parse(lineStep));
    const transient = result.transient!;
    const output = transient.voltage('output');
    const beforeDelay = output.filter((_value, index) => transient.time[index] < 5.5e-9);

    // The convolution model has no precursor: nothing arrives before 1 ns + TD.
    expect(Math.max(...beforeDelay.map(Math.abs))).toBeLessThan(1e-12);
    expect(output.at(-1)).toBeGreaterThan(0.4);
    expect(output.at(-1)).toBeLessThan(0.55);
    expect(Math.max(...output)).toBeLessThan(0.7);
  });

  it.each([
    ['RLC', rlcLine, RLC_REFERENCE],
    ['LC', lcLine, LC_REFERENCE],
  ] as const)('matches ngspice-47 on a resistively terminated %s line within 5 mV', async (_case, netlist, reference) => {
    const transient = (await simulate(parse(netlist))).transient!;
    for (const [node, time, expected] of reference) {
      const actual = sampleAt(transient.time, transient.voltage(node), time);
      expect(Math.abs(actual - expected), `v(${node}) at ${time}`).toBeLessThan(5e-3);
    }
  });

  it('solves the DC operating point through the series line resistance R*LEN', async () => {
    const result = await simulate(parse(`V1 in 0 DC 1
O1 in 0 out 0 LMOD
RL out 0 100
.model LMOD LTRA(R=2 L=250n G=0 C=100p LEN=10)
.op
`));
    // R*LEN = 20 ohm in series with the 100 ohm load.
    expect(result.dc!.voltage('out')).toBeCloseTo(100 / 120, 12);
  });

  it('never steps past the line delay (STEPLIMIT, ngspice LTRAtrunc)', async () => {
    const model = resolveLtraModel({ name: 'LMOD', type: 'LTRA', params: { R: 2, L: 25e-9, C: 10e-12, LEN: 0.4, G: 0 } });
    const result = await simulate(parse(`V1 in 0 PULSE(0 1 1n 1n 1n 5n 20n)
RS in a 50
O1 a 0 b 0 LMOD
RL b 0 50
.model LMOD LTRA(R=2 L=25n G=0 C=10p LEN=0.4)
.tran 1n 20n
`));
    const time = result.transient!.time;
    const bound = Math.min(model.delay, model.maxSafeStep);
    expect(model.delay).toBeCloseTo(0.2e-9, 15);
    for (let index = 1; index < time.length; index++) {
      expect(time[index] - time[index - 1]).toBeLessThanOrEqual(bound * (1 + 1e-9));
    }
  });

  describe('LTRAaccept breakpoints (ngspice ltraacct.c)', () => {
    /** One port-1 driven line: v1 follows `wave`, everything else stays at 0. */
    function acceptSequence(rel: number | undefined, points: Array<[number, number]>): number[] {
      const params: Record<string, number> = { R: 2, L: 250e-9, C: 100e-12, LEN: 1, G: 0 };
      if (rel !== undefined) params.REL = rel;
      const model = resolveLtraModel({ name: 'LMOD', type: 'LTRA', params });
      const line = new LossyTransmissionLine('O1', [0, -1, 1, -1], 0, 1, new LtraModelState(model));
      const scheduled: number[] = [];
      const sink = { schedule: (time: number) => { scheduled.push(time); } };
      for (const [time, voltage] of points) {
        const ctx = {
          time, dt: time === 0 ? 0 : 1e-12, numNodes: 2, sourceScale: 1, useDcSourceValue: false,
          stampG: () => {}, stampB: () => {}, stampC: () => {},
          getVoltage: (node: number) => (node === 0 ? voltage : 0),
          getCurrent: () => 0,
        };
        line.acceptTransientStep(ctx, sink);
      }
      return scheduled;
    }

    const delay = Math.sqrt(250e-9 * 100e-12);

    it('schedules a breakpoint one delay after the previous point when an outgoing wave changes slope sign', () => {
      // Triangle peaking at 1 ns, then a second peak at 2 ns.
      const scheduled = acceptSequence(undefined, [[0, 0], [0.5e-9, 0], [1e-9, 1], [1.5e-9, 0], [2e-9, 1], [2.5e-9, 1]]);
      expect(scheduled).toHaveLength(2);
      expect(scheduled[0]).toBeCloseTo(1e-9 + delay, 20);
      expect(scheduled[1]).toBeCloseTo(1.5e-9 + delay, 20);
    });

    it('needs only a relative slope change of REL when REL < 1', () => {
      // Flat to ramp at 1 ns: REL=1 (the default) ignores a same-sign change.
      const points: Array<[number, number]> = [[0, 0], [0.5e-9, 0], [1e-9, 0], [1.5e-9, 0.5], [2e-9, 1]];
      expect(acceptSequence(undefined, points)).toEqual([]);
      const scheduled = acceptSequence(0.5, points);
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]).toBeCloseTo(1e-9 + delay, 20);
    });

    it('schedules nothing on a straight-line wave', () => {
      expect(acceptSequence(1, [[0, 0], [1e-9, 1], [2e-9, 2], [3e-9, 3]])).toEqual([]);
    });

    it('sets no breakpoints when REL exceeds 2', () => {
      expect(acceptSequence(10, [[0, 0], [0.5e-9, 0], [1e-9, 1], [1.5e-9, 0], [2e-9, 1], [2.5e-9, 1]])).toEqual([]);
    });

    it('lands accepted timepoints one delay after the source corners', async () => {
      // REL=0.5: the 1 ns and 1.1 ns PULSE corners reach port 1 and
      // reschedule one 5 ns delay later; REL=10 disables the rule.
      const timesFor = async (rel: number): Promise<Float64Array | number[]> =>
        (await simulate(parse(lineStep.replace('STEPLIMIT', `STEPLIMIT REL=${rel}`)))).transient!.time;
      const hits = (time: Float64Array | number[], target: number): boolean =>
        Array.from(time).some(t => Math.abs(t - target) < 1e-15);
      const withRule = await timesFor(0.5);
      expect(hits(withRule, 1e-9 + 5e-9)).toBe(true);
      expect(hits(withRule, 1.1e-9 + 5e-9)).toBe(true);
      const withoutRule = await timesFor(10);
      expect(hits(withoutRule, 1.1e-9 + 5e-9)).toBe(false);
    });
  });

  it('still rejects noise analysis', async () => {
    await expect(async () => simulate(parse(`V1 in 0 AC 1
O1 in 0 out 0 LMOD
RL out 0 50
.model LMOD LTRA(R=2 L=250n G=0 C=100p LEN=1)
.noise v(out) V1 dec 10 1meg 1g
`))).rejects.toThrow(/LTRA lossy lines support only .*'\.noise' is unsupported/);
  });
});
