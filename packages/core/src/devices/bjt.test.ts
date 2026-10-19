import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { simulate } from '../simulate.js';
import { parse } from '../parser/index.js';
import type { BJT } from './bjt.js';

describe('BJT Ebers-Moll', () => {
  it('NPN common-emitter amplifier has correct bias point', async () => {
    const result = await simulate(`
      VCC 1 0 DC 12
      .model QMOD NPN(BF=100 IS=1e-14)
      RB 1 2 100k
      RC 1 3 1k
      Q1 3 2 0 QMOD
      .op
      .end
    `);

    const vb = result.dc!.voltage('2');
    const vc = result.dc!.voltage('3');

    expect(vb).toBeGreaterThan(0.55);
    expect(vb).toBeLessThan(0.8);
    expect(vc).toBeGreaterThan(0);
    expect(vc).toBeLessThan(12);
  });

  it('NPN in cutoff has collector at VCC', async () => {
    const result = await simulate(`
      VCC 1 0 DC 5
      .model QMOD NPN(BF=100 IS=1e-14)
      RC 1 2 1k
      Q1 2 0 0 QMOD
      .op
      .end
    `);

    const vc = result.dc!.voltage('2');
    expect(vc).toBeCloseTo(5, 0);
  });

  it('stamps and converges the bounded forward-active Gummel-Poon parameters', async () => {
    const result = await simulate(`forward-active parameter probe
      VBE base 0 DC 0.72
      VCE collector 0 DC 1
      Q1 collector base 0 QGP
      .model QGP NPN(IS=1e-15 BF=100 VAF=50 IKF=1m ISE=2e-13 NE=1.5)
      .dc VCE 1 9 4
      .end
    `);

    const collectorSupply = result.dcSweep!.current('VCE');
    const baseSupply = result.dcSweep!.current('VBE');
    expect(collectorSupply).toHaveLength(3);
    // ngspice-47 `set numdgt=15; dc VCE 1 9 4; print i(vce) i(vbe)` on the
    // identical deck (VT = kT/q at 300.15 K, #525). i(vce) includes the
    // substrate junction gmin current gmin*Vcs (#539) and bjtload.c's
    // CKTgmin*vbc in cbcn; i(vbe) includes CKTgmin*vbe in cben (#551).
    const ngspiceCollector = [-7.20005777197881e-4, -7.77285480974884e-4, -8.34565184751882e-4];
    const ngspiceBase = [-3.52293523293051e-5, -3.52293483293032e-5, -3.52293443293015e-5];
    for (let index = 0; index < 3; index++) {
      expect(collectorSupply[index]).toBeCloseTo(ngspiceCollector[index], 16);
      expect(baseSupply[index]).toBeCloseTo(ngspiceBase[index], 16);
    }
    expect(result.convergence!.dc).toMatchObject({
      acceptedSolves: 3,
      rejectedSolves: 0,
      failure: null,
    });
  });

  it('preserves the level-1 Ebers-Moll defaults when GP parameters are absent', () => {
    const compiled = parse(`level-1 compatibility
      VCC c 0 5
      Q1 c b 0 QLEGACY
      .model QLEGACY NPN(IS=1e-14 BF=80 BR=2 NF=1.1 NR=1.2)
      .op
    `).compile();
    const bjt = compiled.devices.find(device => device.name === 'Q1');
    expect(bjt).toMatchObject({
      // NF/NR as ngspice-47 INPevaluate reads 1.1 and 1.2: 11 * 0.1 and 12 * 0.1 (#749).
      params: { LEVEL: 1, IS: 1e-14, BF: 80, BR: 2, NF: 11 * 0.1, NR: 12 * 0.1, VAF: Infinity, IKF: Infinity, ISE: 0, NE: 1.5 },
    });
  });

  // #519: ngspice-47 bjtsetup.c defaults IS to 1e-16 A.
  it('defaults IS to the ngspice-47 value of 1e-16 for a bare model card', () => {
    const compiled = parse(`bare npn
      VC c 0 1
      Q1 c b 0 QBARE
      .model QBARE NPN
      .op
    `).compile();
    const bjt = compiled.devices.find(device => device.name === 'Q1');
    expect(bjt).toMatchObject({ params: { IS: 1e-16 } });
  });

  // ngspice-47 `op; print i(vc) i(vb)` on the identical deck:
  // i(vc) = -2.70830e-03, i(vb) = -2.70830e-05.
  it('matches the ngspice-47 operating point of a default npn (#519)', async () => {
    const result = await simulate(`default npn op
      VB b 0 0.8
      VC c 0 1.0
      Q1 c b 0 m
      .model m npn
      .op
      .end
    `);
    expect(result.dc!.current('VC') / -2.70830e-3).toBeCloseTo(1, 4);
    expect(result.dc!.current('VB') / -2.70830e-5).toBeCloseTo(1, 4);
  });

  // ngspice-47 `op` on the identical deck (the probe-i-dev X1 pnp leg):
  // v(c1) = -8.03447e-02, v(b1) = -8.34046e-01, i(vee1) = -9.74973e-03.
  it('matches the ngspice-47 operating point of a default 4-terminal pnp (#519)', async () => {
    const result = await simulate(`default pnp op
      Vcc1 11 0 -1
      RC1 11 c1 100
      vbb1 12 0 -1
      RB1 12 b1 300
      vee1 e1 0 0
      vss1 s1 0 0
      Q1 c1 b1 e1 s1 pbipmod
      .model pbipmod pnp
      .op
      .end
    `);
    expect(result.dc!.voltage('c1') / -8.03447e-2).toBeCloseTo(1, 4);
    expect(result.dc!.voltage('b1') / -8.34046e-1).toBeCloseTo(1, 4);
    expect(result.dc!.current('vee1') / -9.74973e-3).toBeCloseTo(1, 4);
  });

  // #538/#539: corpus-f bip_subsmod (examples/osdi/hicuml0/bip_subsmod.sp)
  // with its `.control dc` lowered to `.dc vb 0.2 1.4 0.01` and the subckt
  // flattened. ngspice-47 `wrdata i(vc) i(vb) i(vs)` on the identical deck.
  const BIP_SUBSMOD = `bip_subsmod Gummel test
    VB B 0 0.5
    VC C 0 1.0
    VS S 0 0.0
    Q1 C B 0 S hic0_full
    .model hic0_full npn
    .dc vb 0.2 1.4 0.01
    .end
  `;
  const BIP_SUBSMOD_NGSPICE: readonly (readonly [number, number, number])[] = [
    // [vb, i(vc), i(vb)]
    [0.8, -2.708299613286e-3, -2.708299672076e-5],
    [0.9, -1.293551714657e-1, -1.293551715447e-3],
    [1.0, -6.178326914043e+0, -6.178326914144e-2],
    [1.4, -3.215283250829e+7, -3.215283250830e+5],
  ];

  it('evaluates the converged junction law above vcrit (bip_subsmod, #538)', async () => {
    const result = await simulate(BIP_SUBSMOD);
    const sweep = result.dcSweep!;
    const vb = Array.from(sweep.sweepValues);
    for (const [bias, collector, base] of BIP_SUBSMOD_NGSPICE) {
      const index = vb.findIndex(value => Math.abs(value - bias) < 1e-9);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(sweep.current('VC')[index] / collector).toBeCloseTo(1, 6);
      expect(sweep.current('VB')[index] / base).toBeCloseTo(1, 6);
    }
  });

  // #551: at low bias the base current is dominated by bjtload.c's
  // CKTgmin*vbe (cben) and CKTgmin*vbc (cbcn). ngspice-47
  // `set numdgt=15; dc vb 0.2 0.4 0.1; print i(vc) i(vb)` on the identical deck.
  it('carries the ngspice CKTgmin junction currents at low bias (bip_subsmod, #551)', async () => {
    const result = await simulate(BIP_SUBSMOD);
    const sweep = result.dcSweep!;
    const vb = Array.from(sweep.sweepValues);
    const ngspice: readonly (readonly [number, number, number])[] = [
      [0.2, -2.02822567119215e-12, 5.978197386542089e-13],
      [0.3, -1.25959537376908e-11, 2.911424557060440e-13],
      [0.4, -5.22013360002248e-10, -5.00403161100634e-12],
    ];
    for (const [bias, collector, base] of ngspice) {
      const index = vb.findIndex(value => Math.abs(value - bias) < 1e-9);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(sweep.current('VC')[index] / collector).toBeCloseTo(1, 6);
      expect(sweep.current('VB')[index] / base).toBeCloseTo(1, 6);
    }
  });

  // #551: ngspice-47 bjtload.c uses -csat*(1 + (3*vtn/(e*v))^3) below -3*vtn
  // for cbe, cbc, cben and cbcn. vbe = -0.2 V is below -3*NF*Vt and -3*NE*Vt.
  // ngspice-47 `set numdgt=15; op; print i(vb) i(vc)` on the identical decks.
  it.each<[string, string, number, number]>([
    ['Gummel-Poon', 'BF=50 BR=2 IS=1e-6 ISE=1e-6 NE=2 VAF=20', -2.23845703336357e-5, 7.090205111754373e-5],
    ['Ebers-Moll', 'BF=50 BR=2 IS=1e-6', -2.33613101260578e-5, 7.114084910066944e-5],
  ])('uses the ngspice reverse junction law below -3*N*Vt (%s, #551)', async (_, card, base, collector) => {
    const result = await simulate(`reverse law
      VB b 0 -0.2
      VC c 0 -0.3
      Q1 c b 0 QR
      .model QR NPN(${card})
      .op
      .end
    `);
    expect(result.dc!.current('VB') / base).toBeCloseTo(1, 9);
    expect(result.dc!.current('VC') / collector).toBeCloseTo(1, 9);
  });

  // #525: ngspice-47 `set numdgt=15; op; print v(2) v(3)` on the identical
  // deck: v(2) = 7.215942859257866e-01, v(3) = 4.215942830698228e+00.
  it('matches the ngspice-47 kT/q operating point within 1e-5 V (#525)', async () => {
    const result = await simulate(`issue 525
      VCC 1 0 5
      VB 4 0 0.8
      RB 4 2 1k
      RC 1 3 100
      Q1 3 2 0 QMOD
      .model QMOD NPN(BF=100 IS=6e-15)
      .op
      .end
    `);
    expect(Math.abs(result.dc!.voltage('2') - 7.215942859257866e-1)).toBeLessThan(1e-9);
    expect(Math.abs(result.dc!.voltage('3') - 4.215942830698228)).toBeLessThan(1e-7);
  });

  it('carries the substrate junction gmin current of a vertical npn (bip_subsmod, #539)', async () => {
    const result = await simulate(BIP_SUBSMOD);
    // ngspice-47: i(vs) = 1.000000e-12 A (CKTgmin * Vcs) at every sweep point.
    for (const value of result.dcSweep!.current('VS')) {
      expect(value / 1e-12).toBeCloseTo(1, 6);
    }
  });

  // corpus-f probe-i-dev (examples/probe/probe-i-dev.cir), the lateral pnp leg
  // `X1 c1 b1 e1 s1 pbip` flattened. ngspice-47 `op; print i(vss1)`:
  // i(vss1) = -8.34046068405e-13 A (CKTgmin * (v(s1) - v(b1))).
  it('carries the substrate junction gmin current of a lateral pnp (probe-i-dev, #539)', async () => {
    const result = await simulate(`probe-i-dev pnp leg
      Vcc1 11 0 -1
      RC1 11 c1 100
      vbb1 12 0 -1
      RB1 12 b1 300
      vee1 e1 0 0
      vss1 s1 0 0
      Q1 c1 b1 e1 s1 pbipmod
      .model pbipmod pnp
      .op
      .end
    `);
    expect(result.dc!.current('vss1') / -8.34046068405e-13).toBeCloseTo(1, 6);
    expect(result.dc!.voltage('b1') / -8.34046068405e-1).toBeCloseTo(1, 6);
    expect(result.dc!.current('vee1') / -9.74973288565e-3).toBeCloseTo(1, 6);
  });

  it('stamps the ISS/NS substrate diode between the substrate and the collector', async () => {
    // ngspice-47 `op; print i(vs)`: forward-biased substrate (VS = 0.6 V,
    // vertical npn, collector grounded), ISS = 1e-15, NS = 1.2.
    const result = await simulate(`substrate diode
      VB b 0 0
      VS s 0 0.6
      Q1 0 b 0 s qsub
      .model qsub npn ISS=1e-15 NS=1.2
      .op
      .end
    `);
    // ngspice-47 i(vs) = -2.48563003922e-07.
    expect(result.dc!.current('VS') / -2.48563003922e-7).toBeCloseTo(1, 6);
  });

  it('uses the ngspice reverse substrate law below -3*NS*Vt and scales ISS by AREA', async () => {
    const deck = (bias: number, area: string): string => `reverse substrate diode
      VB b 0 0
      VS s 0 ${bias}
      Q1 0 b 0 s qsub ${area}
      .model qsub npn ISS=1e-6
      .op
      .end
    `;
    // ngspice-47 `op; print i(vs)` on the identical decks: the reverse law
    // -ISS*(1 + (3*Vt/(e*vsub))^3) at -0.1 V, and the exponential at -0.05 V
    // with AREA = 2.
    const reverse = await simulate(deck(-0.1, ''));
    expect(reverse.dc!.current('VS') / 9.767398924221e-7).toBeCloseTo(1, 6);
    const scaled = await simulate(deck(-0.05, '2'));
    expect(scaled.dc!.current('VS') / 1.710608096510e-6).toBeCloseTo(1, 6);
  });

  it('rejects unsupported Gummel-Poon model parameters explicitly', () => {
    expect(() => parse(`unsupported BJT parameter
      Q1 c b 0 QGP
      .model QGP NPN(BF=100 IKF=1m IBE=1e-15)
      .op
    `).compile()).toThrow("Unsupported bounded BJT model parameter: 'IBE'");
  });

  // ngspice-47 `print vm(c) vp(c)` on the identical deck (vp in radians).
  const chargeStorageDeck = (extra: string) => `bjt charge storage ac
    vcc vcc 0 10
    vin in 0 dc 0 ac 1
    rs in b 1k
    rc vcc c 5k
    q1 c b e qn
    ie e 0 dc 1m
    ce e 0 1
    .model qn npn is=1e-16 bf=80 rb=100 ccs=2p tf=0.3n tr=6n cje=3p cjc=2p ${extra}
    .ac dec 1 1meg 1g
    .end
  `;

  const expectAcMatches = async (
    deck: string,
    reference: ReadonlyArray<readonly [number, number, number]>,
  ) => {
    const result = await simulate(deck);
    const ac = result.ac!;
    const output = ac.voltage('c');
    reference.forEach(([frequency, magnitude, phase], index) => {
      expect(ac.frequencies[index]).toBeCloseTo(frequency, 0);
      const value = output[index];
      expect(Math.abs(value.magnitude - magnitude) / magnitude).toBeLessThan(5e-3);
      expect(Math.abs(value.phase * Math.PI / 180 - phase)).toBeLessThan(5e-3);
    });
  };

  it('stamps junction, diffusion and substrate capacitances in AC', async () => {
    await expectAcMatches(chargeStorageDeck(''), [
      [1e6, 8.646100e+01, 2.325930e+00],
      [1e7, 1.187185e+01, 1.593796e+00],
      [1e8, 9.765313e-01, 9.485290e-01],
      [1e9, 1.698771e-02, -2.42167e-02],
    ]);
  });

  it('stamps bias-dependent TF, graded junctions and the Early cross-capacitance in AC', async () => {
    await expectAcMatches(chargeStorageDeck(
      'vaf=50 xtf=2 vtf=4 itf=5m mje=0.4 vje=0.8 mjc=0.3 vjc=0.6 fc=0.6 mjs=0.5 vjs=0.7',
    ), [
      [1e6, 8.533097e+01, 2.368643e+00],
      [1e7, 1.220148e+01, 1.628205e+00],
      [1e8, 1.123801e+00, 1.149537e+00],
      [1e9, 2.756776e-02, 5.819981e-02],
    ]);
  });

  it('linearises the Early factor at the true reverse B-C bias', async () => {
    // ngspice-47 on the identical deck: vm(c) = 1.186748e+02 at 10 Hz (vbc = -5.07 V).
    const result = await simulate(`bjt early small signal
      vcc vcc 0 10
      vin in 0 dc 0 ac 1
      rs in b 1k
      rc vcc c 5k
      q1 c b e qn
      ie e 0 dc 1m
      ce e 0 1
      .model qn npn is=1e-16 bf=80 rb=100 vaf=50
      .ac dec 1 1 10
      .end
    `);
    const gain = result.ac!.voltage('c')[1].magnitude;
    expect(Math.abs(gain - 118.6748) / 118.6748).toBeLessThan(2e-3);
  });

  it('reports the noise collector current with the true Early factor', () => {
    const compiled = parse(`early noise operating point
      VCE c 0 9
      VBE b 0 0.72
      Q1 c b 0 QGP
      .model QGP NPN(IS=1e-15 BF=100 VAF=50)
      .op
    `).compile();
    const bjt = compiled.devices.find(device => device.name === 'Q1') as BJT;
    const solution = new Float64Array(compiled.nodeCount + compiled.branchCount);
    solution[compiled.nodeNames.indexOf('c')] = 9;
    solution[compiled.nodeNames.indexOf('b')] = 0.72;
    const vt = 1.38064852e-23 / 1.6021766208e-19 * 300.15;
    const forward = 1e-15 * (Math.exp(0.72 / vt) - 1);
    // ngspice-47 bjtload.c cc includes -cbcn = -CKTgmin*vbc = +1e-12*8.28 A (#551).
    expect(bjt.noiseOperatingPoint(solution).collectorCurrent)
      .toBeCloseTo(forward * (1 + 8.28 / 50) + 1e-12 * 8.28, 12);
  });

  it.each(['.op', '.dc VCE 1 5 2'])('accepts inert PTF for %s', async analysis => {
    const deck = (ptf: number) => `inert excess phase
      VBE b 0 DC 0.7 AC 1
      VCE c 0 5
      Q1 c b 0 QGP
      .model QGP NPN(IS=1e-15 BF=100 TF=1n PTF=${ptf})
      ${analysis}
      .end`;
    const reference = await simulate(deck(0));
    const result = await simulate(deck(100.8));
    if (analysis === '.op') {
      expect(result.dc!.current('VCE')).toBe(reference.dc!.current('VCE'));
      expect(result.dc!.voltage('b')).toBeCloseTo(0.7, 12);
    } else {
      expect(Array.from(result.dcSweep!.current('VCE')))
        .toEqual(Array.from(reference.dcSweep!.current('VCE')));
      expect(result.dcSweep!.sweepValues).toHaveLength(3);
    }
  });

  it.each(['.ac dec 1 1k 10k', '.tran 1n 10n', '.tran 1n 10n uic'])(
    'accepts PTF dynamics for %s', async analysis => {
      await expect(simulate(`supported excess phase
        VBE b 0 DC 0.7 AC 1
        VCE c 0 5
        Q1 c b 0 QGP
        .model QGP NPN(IS=1e-15 BF=100 TF=1n PTF=30)
        ${analysis}
        .end`)).resolves.toBeDefined();
    },
  );

  it.each([
    ['XCJC=1.5', 'expected BJT XCJC in [0, 1]'],
    ['CJE=-1p', 'expected finite BJT CJE >= 0'],
    ['VJC=0', 'expected finite BJT VJC > 0'],
  ])('rejects unsupported or invalid charge-storage parameter %s explicitly', (parameter, message) => {
    expect(() => parse(`charge storage validation
      Q1 c b 0 QCAP
      .model QCAP NPN(BF=100 RB=10 CJC=1p ${parameter})
      .op
    `).compile()).toThrow(message);
  });

  it('rejects unsupported BJT model types explicitly', () => {
    // #509: unsupported model types are rejected when the .model card is parsed.
    expect(() => parse('title\nQ1 c b 0 QBAD\n.model QBAD VBIC BF=100\n.op'))
      .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_MODEL_TYPE', modelName: 'QBAD', modelType: 'VBIC' }));
  });

  it('runs the unchanged bounded VBIC forward-output DC fixture', async () => {
    const fixture = readFileSync(resolve(
      process.cwd(),
      '../../benchmarks/corpus/ngspice/fixtures/tests/vbic/FO.cir',
    ));
    expect(createHash('sha256').update(fixture).digest('hex'))
      .toBe('de57231ef8879e785b07068db662bfa5ecfde8734011b88b09f319b826242e92');

    const result = await simulate(fixture.toString('utf8'));

    expect(result.dcSweep?.sweepValues).toHaveLength(707);
    expect(Array.from(result.dcSweep!.current('VC'))).toHaveLength(707);
    expect(Array.from(result.dcSweep!.current('VB'))).toHaveLength(707);
    expect(Array.from(result.dcSweep!.current('VC')).every(Number.isFinite)).toBe(true);
    expect(Array.from(result.dcSweep!.current('VB')).every(Number.isFinite)).toBe(true);
    expect(result.convergence?.dc).toMatchObject({ rejectedSolves: 0, failure: null });
  });

  it('rejects parameters outside the bounded VBIC DC subset', () => {
    expect(() => parse(`unsupported VBIC parameter
      Q1 c b 0 QVBIC
      .model QVBIC NPN(LEVEL=4 BF=100)
      .op
    `).compile()).toThrow("Unsupported bounded VBIC DC model parameter: 'BF'");
  });

  it('rejects invalid bounded VBIC parameter values', () => {
    expect(() => parse(`invalid VBIC parameter
      Q1 c b 0 QVBIC
      .model QVBIC NPN(LEVEL=4 CJE=-1p)
      .op
    `).compile()).toThrow("Invalid bounded VBIC DC model parameter: 'CJE'");
  });

  it('accepts PNP polarity in the bounded VBIC DC subset', () => {
    expect(() => parse(`bounded VBIC PNP polarity
      Q1 c b 0 QVBIC
      .model QVBIC PNP(LEVEL=4)
      .op
    `).compile()).not.toThrow();
  });

  it('accepts AC analysis in the bounded VBIC small-signal subset', () => {
    expect(() => parse(`bounded VBIC AC analysis
      VBE b 0 DC 0.7 AC 1
      Q1 c b 0 QVBIC
      .model QVBIC NPN(LEVEL=4)
      .ac dec 10 1 1meg
    `).compile()).not.toThrow();
  });

  it('accepts transient analysis in the bounded VBIC subset', () => {
    expect(() => parse(`unsupported VBIC transient analysis
      VBE b 0 0.7
      Q1 c b 0 QVBIC
      .model QVBIC NPN(LEVEL=4)
      .tran 1n 10n
    `).compile()).not.toThrow();
  });

  it('accepts pole-zero analysis in the bounded VBIC small-signal subset', () => {
    expect(() => parse(`bounded VBIC pole-zero analysis
      VIN b 0 0.7
      Q1 c b 0 QVBIC
      .model QVBIC NPN(LEVEL=4)
      .pz b 0 c 0 cur pz
    `).compile()).not.toThrow();
  });

  it('rejects TEMP stepping outside the nominal-temperature bounded VBIC subset', async () => {
    await expect(simulate(`unsupported VBIC TEMP stepping
      VBE b 0 0.7
      VCE c 0 1
      Q1 c b 0 QVBIC
      .model QVBIC NPN(LEVEL=4)
      .op
      .step TEMP LIST -55 125
    `)).rejects.toThrow("Unsupported bounded VBIC step: 'TEMP'");
  });
});
