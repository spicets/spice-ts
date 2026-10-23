import { describe, expect, it } from 'vitest';
import { solveStep } from './analysis/step.js';
import type { BJT } from './devices/bjt.js';
import { InvalidCircuitError, UnsupportedTemperatureError } from './errors.js';
import { parse } from './parser/index.js';
import type { SimulationResult, StepResult } from './results.js';
import { simulate } from './simulate.js';

/**
 * #374: `.step TEMP` and `.options TEMP` must reach the diode (diotemp.c), the
 * Gummel-Poon BJT (bjttemp.c) and MOS level 1 (mos1temp.c) like ngspice-47.
 *
 * References: ngspice-47 `ngspice -b` on each deck plus `.temp T`, with
 * `set numdgt=13`, `op` (or `ac lin 1 10meg 10meg`) and `print` in a
 * `.control` block. ngspice runs `.temp T` as `.options TEMP=T` (inp.c).
 */
interface ParityDeck {
  deck: string;
  analysis: 'op' | 'ac';
  values: Record<number, Record<string, number>>;
  /** Relative tolerance; see NGSPICE_NEWTON_RESIDUAL. */
  tolerance?: number;
}

const TEMPERATURES = [0, 27, 100] as const;
const DEFAULT_TOLERANCE = 1e-6;
/**
 * ngspice stops Newton at its default reltol, so on these decks its node
 * voltages carry a residual of up to ~1.2e-5 (also at 27 C for the breakdown,
 * TNOM and PNP decks). Re-run with `.options reltol=1e-9 abstol=1e-20
 * vntol=1e-14`, ngspice-47 gives the spice-ts values to < 1e-8: bjt_ce v(b) at
 * 100 C = 5.4502984115310e-01, diode_fwd 5.1977504476593e-01, bjt_pnp v(b)
 * 4.3809359814532e+00, diode_tnom at 27 C 7.7710953162098e-01, diode_breakdown
 * at 100 C -4.906349462474e+00.
 */
const NGSPICE_NEWTON_RESIDUAL = 2e-5;

const DECKS: Record<string, ParityDeck> = {
  diode_issue: {
    deck: 'v1 a 0 0.6\nd1 a 0 dm\n.model dm d is=1e-14',
    analysis: 'op',
    values: {
      0: { 'i(v1)': -1.274242432757e-05 },
      27: { 'i(v1)': -0.0001187196295587 },
      100: { 'i(v1)': -0.01079990936311 },
    },
  },
  bjt_issue: {
    deck: 'v1 a 0 0.6\nq1 a a 0 qm\n.model qm npn is=1e-15',
    analysis: 'op',
    values: {
      0: { 'i(v1)': -1.286985996485e-06 },
      27: { 'i(v1)': -1.199068372483e-05 },
      100: { 'i(v1)': -0.001090790846814 },
    },
  },
  mos1_issue: {
    deck: 'v1 a 0 0.6\nm1 a a 0 0 mm l=1u w=1u\n.model mm nmos level=1 vto=0.5 kp=1e-4',
    analysis: 'op',
    values: {
      0: { 'i(v1)': -3.111749600072e-07 },
      27: { 'i(v1)': -5.0000061e-07 },
      100: { 'i(v1)': -1.081366701572e-06 },
    },
  },
  diode_fwd: {
    deck: 'V1 in 0 5\nR1 in out 1k\nD1 out 0 DM\n.model DM D IS=2.52n N=1.752 EG=1.11 XTI=3',
    analysis: 'op',
    values: {
      0: { 'v(out)': 0.69829681221577 },
      27: { 'v(out)': 0.65078505243502 },
      100: { 'v(out)': 0.51977701574777 },
    },
    tolerance: NGSPICE_NEWTON_RESIDUAL,
  },
  diode_schottky: {
    deck: 'V1 in 0 2\nR1 in out 1k\nD1 out 0 DSCH area=2\n.model DSCH D IS=5u N=1.05 EG=0.69 XTI=2',
    analysis: 'op',
    values: {
      0: { 'v(out)': 0.19492996028595 },
      27: { 'v(out)': 0.14203769021313 },
      100: { 'v(out)': 0.021794445985142 },
    },
    // Since spice-ts follows the ngspice CKTop order (plain Newton first,
    // #622) it, like ngspice, stops on the default reltol test; the iterate
    // differs from ngspice's because the diode has no MODEINITJCT start yet.
    tolerance: NGSPICE_NEWTON_RESIDUAL,
  },
  diode_breakdown: {
    deck: 'V1 in 0 -10\nR1 in out 1k\nD1 out 0 DZ\n.model DZ D IS=1e-14 BV=5 IBV=1m TCV=2m',
    analysis: 'op',
    values: {
      0: { 'v(out)': -5.091473579108 },
      27: { 'v(out)': -5.041419880038 },
      100: { 'v(out)': -4.906409644627 },
    },
    tolerance: NGSPICE_NEWTON_RESIDUAL,
  },
  diode_tnom: {
    deck: 'V1 in 0 5\nR1 in out 1k\nD1 out 0 DT\n.model DT D IS=1e-14 TNOM=50',
    analysis: 'op',
    values: {
      0: { 'v(out)': 0.81350898243358 },
      27: { 'v(out)': 0.77711346366957 },
      100: { 'v(out)': 0.67590757196526 },
    },
    tolerance: NGSPICE_NEWTON_RESIDUAL,
  },
  diode_cap_ac: {
    deck: 'V1 in 0 DC -2 AC 1\nR1 in out 1k\nD1 out 0 DC1\n.model DC1 D IS=1e-14 CJO=10p VJ=0.7 M=0.33',
    analysis: 'ac',
    values: {
      0: { 'vr(out)': 0.86321915156342, 'vi(out)': -0.3436158422924 },
      27: { 'vr(out)': 0.86061023995607, 'vi(out)': -0.3463527883217 },
      100: { 'vr(out)': 0.85653720852559, 'vi(out)': -0.3505441742201 },
    },
  },
  bjt_ce: {
    deck: 'Vcc vcc 0 5\nRc vcc c 1k\nRb vcc b 470k\nQ1 c b 0 QN\n'
      + '.model QN NPN IS=1e-14 BF=200 BR=3 VAF=100 IKF=0.1 ISE=1e-13 NE=1.5 XTB=1.5 EG=1.11 XTI=3',
    analysis: 'op',
    values: {
      0: { 'v(c)': 3.8559214123161, 'v(b)': 0.70539079339334 },
      27: { 'v(c)': 3.6522245388693, 'v(b)': 0.66241172959203 },
      100: { 'v(c)': 3.0347387872798, 'v(b)': 0.54503375815092 },
    },
    tolerance: NGSPICE_NEWTON_RESIDUAL,
  },
  bjt_pnp: {
    deck: 'Vee e 0 5\nRb b 0 100k\nRc c 0 1k\nQ1 c b e QP\n.model QP PNP IS=2e-15 BF=80 XTB=1 XTI=3.5',
    analysis: 'op',
    values: {
      0: { 'v(c)': 3.0809115833127, 'v(b)': 4.2318117817521 },
      27: { 'v(c)': 3.4171634186957, 'v(b)': 4.2714538323772 },
      100: { 'v(c)': 4.3571280962725, 'v(b)': 4.380918000635 },
    },
    tolerance: NGSPICE_NEWTON_RESIDUAL,
  },
  bjt_cap_ac: {
    deck: 'V1 in 0 DC -1 AC 1\nR1 in b 10k\nQ1 0 b 0 QC\n'
      + '.model QC NPN IS=1e-15 CJE=2p VJE=0.8 MJE=0.4 CJC=1p VJC=0.6 MJC=0.3',
    analysis: 'ac',
    values: {
      0: { 'vr(b)': 0.35222173489625, 'vi(b)': -0.4776626187159 },
      27: { 'vr(b)': 0.34539374202333, 'vi(b)': -0.4754964753671 },
      100: { 'vr(b)': 0.33245315072253, 'vi(b)': -0.4710923971413 },
    },
  },
  mos1_body: {
    deck: 'VDD d 0 3\nVG g 0 1.5\nVB b 0 -1\nM1 d g 0 b MN L=2u W=10u\n'
      + '.model MN NMOS LEVEL=1 VTO=0.7 KP=110u GAMMA=0.4 PHI=0.65 LAMBDA=0.04',
    analysis: 'op',
    values: {
      0: { 'i(VDD)': -0.0001176524774253 },
      27: { 'i(VDD)': -0.0001141117149605 },
      100: { 'i(VDD)': -0.0001090307776698 },
    },
  },
  mos1_pmos: {
    deck: 'VDD s 0 3\nVG g 0 1\nRL d 0 10k\nM1 d g s s MP L=1u W=20u\n'
      + '.model MP PMOS LEVEL=1 VTO=-0.8 KP=40u GAMMA=0.5 PHI=0.7 LAMBDA=0.02',
    analysis: 'op',
    values: {
      0: { 'v(d)': 2.7108300986852 },
      27: { 'v(d)': 2.6799311192541 },
      100: { 'v(d)': 2.6035726292945 },
    },
  },
  mos1_tox: {
    deck: 'VDD d 0 3\nVG g 0 1.5\nM1 d g 0 0 MT L=2u W=10u\n.model MT NMOS LEVEL=1 TOX=20n NSUB=1e16 UO=500',
    analysis: 'op',
    values: {
      0: { 'i(VDD)': -0.0004867209187561 },
      27: { 'i(VDD)': -0.0004422806199952 },
      100: { 'i(VDD)': -0.0003614143244121 },
    },
  },
  mos1_junction: {
    deck: 'VS s 0 0\nVD d 0 -0.5\nM1 d 0 s s MJ L=2u W=10u AD=20p AS=20p\n'
      + '.model MJ NMOS LEVEL=1 VTO=0.7 KP=110u JS=1e-3 IS=1e-14',
    analysis: 'op',
    values: {
      0: { 'i(VD)': 3.5206913979907e-07 },
      27: { 'i(VD)': 4.9712485784324e-06 },
      100: { 'i(VD)': 0.0010038175126483 },
    },
  },
  mos1_cap_ac: {
    deck: 'VD in 0 DC 2 AC 1\nR1 in d 1k\nM1 d 0 0 0 MC L=2u W=10u AD=20p PD=24u\n'
      + '.model MC NMOS LEVEL=1 VTO=0.7 KP=110u CJ=2e-4 CJSW=1e-9 PB=0.8 MJ=0.5 MJSW=0.33',
    analysis: 'ac',
    values: {
      0: { 'vr(d)': 0.99999874291745, 'vi(d)': -0.001120750184022 },
      27: { 'vr(d)': 0.99999871827351, 'vi(d)': -0.001131691143447 },
      100: { 'vr(d)': 0.99999866809553, 'vi(d)': -0.001153647563935 },
    },
  },
};

function probe(result: SimulationResult | StepResult, name: string): number {
  const [, kind, target] = /^(v|i|vr|vi)\((.+)\)$/.exec(name)!;
  if (kind === 'v') return result.dc!.voltage(target);
  if (kind === 'i') return result.dc!.current(target);
  const { magnitude, phase } = result.ac!.voltage(target)[0];
  const radians = phase * Math.PI / 180;
  return kind === 'vr' ? magnitude * Math.cos(radians) : magnitude * Math.sin(radians);
}

function expectParity(actual: number, expected: number, tolerance: number): void {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(tolerance);
}

const netlist = (entry: ParityDeck, directive: string) => [
  'temperature parity',
  entry.deck,
  entry.analysis === 'op' ? '.op' : '.ac lin 1 10meg 10meg',
  directive,
  '.end',
].join('\n');

describe('device temperature parity with ngspice-47 (#374)', () => {
  it.each(Object.entries(DECKS))('%s follows .step TEMP LIST 0 27 100', async (_name, entry) => {
    const result = await simulate(netlist(entry, `.step temp list ${TEMPERATURES.join(' ')}`), {
      stepWorkers: false,
    });
    expect(result.steps!.map(step => step.paramValue)).toEqual([...TEMPERATURES]);
    result.steps!.forEach((step, index) => {
      for (const [name, expected] of Object.entries(entry.values[TEMPERATURES[index]])) {
        expectParity(probe(step, name), expected, entry.tolerance ?? DEFAULT_TOLERANCE);
      }
    });
  });

  it.each(Object.entries(DECKS))('%s follows .options TEMP', async (_name, entry) => {
    for (const temperature of TEMPERATURES) {
      const result = await simulate(netlist(entry, `.options temp=${temperature}`));
      for (const [name, expected] of Object.entries(entry.values[temperature])) {
        expectParity(probe(result, name), expected, entry.tolerance ?? DEFAULT_TOLERANCE);
      }
    }
  });

  it('restores the nominal device parameters after a .step TEMP sweep', () => {
    const compiled = parse(netlist(DECKS.bjt_cap_ac, '.step temp list 100')).compile();
    const bjt = compiled.devices.find(device => device.name === 'Q1') as BJT;
    const nominal = { ...bjt.params };
    solveStep(compiled, compiled.steps[0], undefined, []);
    expect(bjt.getTemperature()).toBe(27);
    expect(bjt.params).toEqual(nominal);
  });
});

describe('unsupported temperature dependence is rejected, not ignored (#374)', () => {
  const jfet = 'V1 d 0 1\nJ1 d 0 0 JMOD\n.model JMOD NJF\n.op';

  it('rejects .step TEMP off 27 C for a nonlinear device without a temperature model', async () => {
    const run = simulate(`jfet temp\n${jfet}\n.step temp list 27 100`, { stepWorkers: false });
    await expect(run).rejects.toBeInstanceOf(UnsupportedTemperatureError);
    await expect(run).rejects.toMatchObject({
      code: 'UNSUPPORTED_TEMPERATURE', deviceName: 'J1', temperature: 100, parameter: undefined,
    });
  });

  it('accepts .step TEMP at 27 C only for such a device', async () => {
    const result = await simulate(`jfet temp\n${jfet}\n.step temp list 27`, { stepWorkers: false });
    expect(result.steps).toHaveLength(1);
  });

  it('accepts JFET .options TEMP after implementing its temperature law (#1695)', () => {
    const circuit = parse(`jfet temp\n${jfet}\n.options temp=100`);
    expect(() => circuit.compile()).not.toThrow();
  });

  it.each([
    ['BJT', 'Q1 a a 0 QM\n.model QM NPN IS=1e-15 TBF1=1e-3', 'Q1', 'TBF1'],
  ])('rejects a %s temperature coefficient without an implemented law', async (_kind, cards, device, field) => {
    const deck = `coefficient temp\nV1 a 0 0.6\n${cards}\n.op`;
    await expect(simulate(`${deck}\n.step temp list 27 100`, { stepWorkers: false })).rejects.toMatchObject({
      code: 'UNSUPPORTED_TEMPERATURE', deviceName: device, temperature: 100, parameter: field,
    });
    await expect(simulate(`${deck}\n.options temp=100`)).rejects.toMatchObject({
      code: 'UNSUPPORTED_TEMPERATURE', deviceName: device, parameter: field,
    });
    // At TNOM the coefficient has no effect, as in ngspice.
    await expect(simulate(deck)).resolves.toBeDefined();
  });
});
