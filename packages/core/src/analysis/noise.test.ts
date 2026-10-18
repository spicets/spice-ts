import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InvalidCircuitError, ParseError } from '../errors.js';
import { parseTitleless as parse } from '../parser/index.js';
import { simulate } from '../simulate.js';
const bjtGxReference = JSON.parse(readFileSync(new URL('./bjt-gx-noise-reference.json', import.meta.url), 'utf8')) as {
  cases: Array<{ name: string; deck: string; frequencies: number[]; output: number[]; input: number[];
    onoise_total: number; inoise_total: number }>;
};
const mos239Reference = JSON.parse(readFileSync(new URL('./mos239-noise-reference.json', import.meta.url), 'utf8')) as {
  cases: Array<{ level: number; name: string; deck: string; frequencies: number[]; output: number[]; input: number[] }>;
};

describe('.noise analysis', () => {
  const fixture = `
    V1 in 0 AC 1
    Rsource in n1 1k
    Eamp out 0 n1 0 10
    Rload out 0 10k
    .noise v(out) V1 lin 5 100 500
  `;

  const mosfetFixture = `
    VDD vdd 0 DC 5
    Vgate gate 0 DC 2 AC 1
    Rload vdd out 2k
    M1 out gate 0 0 NMOD W=10u L=1u
    .model NMOD NMOS (LEVEL=1 VTO=0.7 KP=200u LAMBDA=0.02 KF=1e-25 AF=1)
    .noise v(out) Vgate dec 3 10 10k
  `;

  const bjtFixture = `
    VDD vdd 0 DC 5
    Vinput in 0 DC 1 AC 1
    Rbase in base 100k
    Rload vdd out 2k
    Q1 out base 0 QMOD
    .model QMOD NPN (LEVEL=1 IS=1e-14 BF=100 BR=1 NF=1 NR=1)
    .noise v(out) Vinput dec 3 10 10k
  `;

  const bjtInternalResistanceFixture = (parameter: string) => `
    VDD vdd 0 DC 5
    Vinput in 0 DC 1 AC 1
    Rbase in base 100k
    Rload vdd out 2k
    Q1 out base 0 QMOD
    .model QMOD NPN (LEVEL=1 IS=1e-14 BF=100 BR=1 NF=1 NR=1 ${parameter})
    .noise v(out) Vinput dec 3 10 10k
  `;

  const bjtFlickerFixture = bjtFixture.replace(
    'NR=1)',
    'NR=1 KF=1e-9 AF=1.2)',
  );

  const diodeFixture = (sweep: string, flicker = false) => `
    V1 in 0 DC 1 AC 1
    R1 in out 1k
    D1 out 0 DMOD
    .model DMOD D(IS=1e-14 N=1${flicker ? ' KF=1e-10 AF=1' : ''})
    .noise v(out) V1 ${sweep}
  `;

  it('parses the bounded ngspice-compatible linear form', () => {
    expect(parse(fixture).analyses).toEqual([{
      type: 'noise',
      outputNode: 'out',
      inputSource: 'V1',
      variation: 'lin',
      points: 5,
      startFreq: 100,
      stopFreq: 500,
    }]);
  });

  it('parses and returns deterministic differential resistor-noise output', async () => {
    const deck = `
      V1 in 0 AC 1
      R1 in outp 1k
      R2 outp 0 1k
      R3 in outn 2k
      R4 outn 0 1k
      .noise v(outp,outn) V1 dec 3 100 10k
    `;

    expect(parse(deck).analyses).toEqual([{
      type: 'noise',
      outputNode: 'outp',
      outputReferenceNode: 'outn',
      inputSource: 'V1',
      variation: 'dec',
      points: 3,
      startFreq: 100,
      stopFreq: 10_000,
    }]);

    const first = (await simulate(deck)).noise!;
    const repeated = (await simulate(deck)).noise!;
    expect(first).toEqual(repeated);
    expect(first.outputNode).toBe('outp');
    expect(first.outputReferenceNode).toBe('outn');
    expect(first.outputNoiseDensity).toHaveLength(7);
    expect(first.integratedOutputNoise).toBeGreaterThan(0);
  });

  it.each([
    ['diode', `
      V1 in 0 DC 1 AC 1
      R1 in outp 1k
      R2 outn 0 1k
      D1 outp outn DMOD
      .model DMOD D(IS=1e-14)
      .noise v(outp,outn) V1 dec 3 100 10k
    `],
    ['BJT', `
      V1 in 0 DC 1 AC 1
      R1 in outp 1k
      R2 outn 0 1k
      Q1 outp in outn QMOD
      .model QMOD NPN (LEVEL=1 IS=1e-14 BF=100)
      .noise v(outp,outn) V1 dec 3 100 10k
    `],
    ['MOS1', `
      V1 in 0 DC 1 AC 1
      R1 in outp 1k
      R2 outn 0 1k
      M1 outp in outn outn MMOD
      .model MMOD NMOS (LEVEL=1 VTO=0.7 KP=200u)
      .noise v(outp,outn) V1 dec 3 100 10k
    `],
    ['JFET', `
      VDD vdd 0 DC 5 AC 1
      Vg g 0 DC -1
      R1 vdd outp 1k
      R2 outn 0 1k
      J1 outp g outn MOD
      .model MOD NJF LEVEL=1 BETA=2.69e-5 VTO=-3.795 LAMBDA=0.0181 AF=1 KF=0.05
      .noise v(outp,outn) VDD dec 3 100 10k
    `],
    ['BSIM3', `
      V1 in 0 DC 1 AC 1
      R1 in outp 1k
      R2 outn 0 1k
      M1 outp in outn outn MMOD
      .model MMOD NMOS (LEVEL=49 VTH0=1 U0=400 TOX=4n)
      .noise v(outp,outn) V1 dec 3 100 10k
    `],
  ])('rejects differential %s noise outside the resistor-only slice', async (_kind, deck) => {
    await expect(simulate(deck)).rejects.toEqual(
      new InvalidCircuitError('.noise differential voltage output only supports resistor noise'),
    );
  });

  it('returns structured output- and input-referred resistor noise spectra', async () => {
    const result = await simulate(fixture);

    expect(result.noise).toBeDefined();
    expect(result.noise!.frequencies).toEqual([100, 200, 300, 400, 500]);
    expect(result.noise!.outputNode).toBe('out');
    expect(result.noise!.inputSource).toBe('V1');
    expect(result.noise!.outputNoiseDensity).toHaveLength(5);
    expect(result.noise!.inputNoiseDensity).toHaveLength(5);

    const ngspice47Output = 4.07137153e-8;
    const ngspice47Input = 4.07137153e-9;
    for (let i = 0; i < result.noise!.frequencies.length; i++) {
      expect(Math.abs(result.noise!.outputNoiseDensity[i] - ngspice47Output) / ngspice47Output)
        .toBeLessThan(2e-6);
      expect(Math.abs(result.noise!.inputNoiseDensity[i] - ngspice47Input) / ngspice47Input)
        .toBeLessThan(2e-6);
    }
  });

  it.each([
    ['dec', 3, 100, 10_000, [100, 215.44346900318834, 464.15888336127796, 1_000, 2_154.4346900318837, 4_641.588833612778, 10_000]],
    ['oct', 3, 100, 800, [100, 125.99210498948732, 158.74010519681994, 200, 251.98420997897463, 317.4802103936399, 400, 503.96841995794927, 634.9604207872798, 800]],
  ] as const)('matches the ngspice %s frequency grid', async (
    variation, points, startFreq, stopFreq, frequencies,
  ) => {
    const deck = fixture.replace('lin 5 100 500', `${variation} ${points} ${startFreq} ${stopFreq}`);

    expect(parse(deck).analyses[0]).toMatchObject({ variation, points, startFreq, stopFreq });
    const result = await simulate(deck);

    expect(result.noise!.frequencies).toHaveLength(frequencies.length);
    result.noise!.frequencies.forEach((frequency, index) => {
      expect(Math.abs(frequency - frequencies[index]) / frequencies[index]).toBeLessThan(1e-14);
    });
  });

  it('treats the logarithmic stop frequency as an upper bound without adding an off-grid endpoint', async () => {
    const result = await simulate(fixture.replace('lin 5 100 500', 'dec 3 100 500'));

    expect(result.noise!.frequencies).toHaveLength(3);
    expect(result.noise!.frequencies.at(-1)).toBeLessThanOrEqual(500);
  });

  it('matches ngspice stop-frequency tolerance at a logarithmic grid boundary', async () => {
    const result = await simulate(fixture.replace('lin 5 100 500', 'dec 1000 100 100.15'));

    expect(result.noise!.frequencies).toHaveLength(2);
    expect(result.noise!.frequencies[1]).toBeCloseTo(100.23052380778997, 12);
  });

  it.each([
    ['dec', 3, 100, 10_000, 4.050963523633458e-6, 4.050963523633458e-7],
    ['oct', 3, 100, 800, 1.077183656197215e-6, 1.077183656197215e-7],
  ] as const)('returns deterministic integrated totals for an ngspice %s sweep', async (
    variation, points, startFreq, stopFreq, outputTotal, inputTotal,
  ) => {
    const deck = fixture.replace('lin 5 100 500', `${variation} ${points} ${startFreq} ${stopFreq}`);

    const result = await simulate(deck);
    const repeated = await simulate(deck);

    expect(Math.abs(result.noise!.integratedOutputNoise! - outputTotal) / outputTotal)
      .toBeLessThan(2e-6);
    expect(Math.abs(result.noise!.integratedInputNoise! - inputTotal) / inputTotal)
      .toBeLessThan(2e-6);
    expect(repeated.noise!.integratedOutputNoise).toBe(result.noise!.integratedOutputNoise);
    expect(repeated.noise!.integratedInputNoise).toBe(result.noise!.integratedInputNoise);
  });

  it('matches ngspice log-log integration for frequency-dependent resistor noise', async () => {
    const result = await simulate(`
      V1 in 0 AC 1
      R1 in out 1k
      C1 out 0 1u
      .noise v(out) V1 dec 10 10 100k
    `);

    const ngspice47OutputTotal = 6.296943753110260e-8;
    const ngspice47InputTotal = 1.444117572560201e-6;
    expect(Math.abs(result.noise!.integratedOutputNoise! - ngspice47OutputTotal)
      / ngspice47OutputTotal).toBeLessThan(2e-6);
    expect(Math.abs(result.noise!.integratedInputNoise! - ngspice47InputTotal)
      / ngspice47InputTotal).toBeLessThan(2e-6);
  });

  it.each([
    ['lin', 5, 10, 10_000, 5, 2.703131156357947e-7, 5.386271250478095e-8, 7.099001808395031e-5, 1.41455028024496e-5],
    ['dec', 3, 10, 10_000, 10, 2.703131156357946e-7, 5.386271250478093e-8, 7.099001808395027e-5, 1.414550280244959e-5],
    ['oct', 3, 10, 10_000, 30, 2.997883785551307e-7, 5.973596659714284e-8, 6.991504265477001e-5, 1.393130271691006e-5],
  ] as const)('matches ngspice-47 MOS1 thermal plus KF/AF noise for %s', async (
    variation, points, start, stop, count, outputLast, inputLast, outputTotal, inputTotal,
  ) => {
    const deck = mosfetFixture.replace('dec 3 10 10k', `${variation} ${points} ${start} ${stop}`);
    expect(parse(deck).analyses[0]).toMatchObject({ variation, points, startFreq: start, stopFreq: stop });

    const result = await simulate(deck);
    const noise = result.noise!;
    expect(noise.frequencies).toHaveLength(count);
    expect(noise.outputNoiseDensity[0]).toBeCloseTo(8.540277088953039e-6, 11);
    expect(noise.inputNoiseDensity[0]).toBeCloseTo(1.701739438249188e-6, 11);
    expect(noise.outputNoiseDensity.at(-1)).toBeCloseTo(outputLast, 11);
    expect(noise.inputNoiseDensity.at(-1)).toBeCloseTo(inputLast, 11);
    expect(noise.integratedOutputNoise).toBeCloseTo(outputTotal, 10);
    expect(noise.integratedInputNoise).toBeCloseTo(inputTotal, 10);
  });

  it.each([
    ['unsupported model level', 'LEVEL=7', /unsupported model LEVEL=7/i],
    ['unsupported noisy parasitic resistance', 'LEVEL=1 RD=10', /does not support MOSFET model parameter 'RD'/i],
    ['unsupported noise selector', 'LEVEL=1 NLEV=1', /only supports MOSFET NLEV=2/i],
  ])('rejects %s explicitly', async (_name, modelParameters, expected) => {
    const deck = mosfetFixture.replace(
      'LEVEL=1 VTO=0.7 KP=200u LAMBDA=0.02 KF=1e-25 AF=1',
      `${modelParameters} VTO=0.7 KP=200u LAMBDA=0.02 KF=1e-25 AF=1`,
    );
    await expect(simulate(deck)).rejects.toThrow(expected);
  });

  it.each(mos239Reference.cases)('matches ngspice-47 MOS$level $name spectra', async reference => {
    const noise = (await simulate(reference.deck)).noise!;
    expect(noise.frequencies).toHaveLength(reference.frequencies.length);
    noise.frequencies.forEach((frequency, index) => {
      expect(Math.abs(frequency - reference.frequencies[index]) / frequency).toBeLessThan(1e-14);
    });
    for (const [actual, expected] of [
      [noise.outputNoiseDensity, reference.output],
      [noise.inputNoiseDensity, reference.input],
    ]) {
      expect(actual).toHaveLength(expected.length);
      actual.forEach((density, index) => {
        expect(Math.abs(density - expected[index]) / expected[index]).toBeLessThan(2e-5);
      });
    }
  });

  it.each([2, 3])('rejects unported MOS%i NLEV=3 explicitly', async level => {
    await expect(simulate(mosfetFixture.replace('LEVEL=1', `LEVEL=${level} NLEV=3`)))
      .rejects.toThrow(new InvalidCircuitError(".noise only supports MOS2/MOS3 NLEV=0, 1 or 2 for 'M1'"));
  });

  it.each([
    ['non-source bulk', 'bulk', ''],
    ['GAMMA body effect', '0', ' GAMMA=0.5'],
    ['PHI body effect', '0', ' PHI=0.6'],
    ['reviewer non-ground bulk plus GAMMA/PHI repro', 'bulk', ' GAMMA=0.5 PHI=0.6'],
  ])('rejects a MOS1 %s form instead of silently returning non-parity noise', async (
    _name, bulkNode, modelSuffix,
  ) => {
    const deck = mosfetFixture
      .replace('Vgate gate 0 DC 2 AC 1', 'Vgate gate 0 DC 2 AC 1\n    Vbody bulk 0 DC -1')
      .replace('M1 out gate 0 0 NMOD', `M1 out gate 0 ${bulkNode} NMOD`)
      .replace('KF=1e-25 AF=1', `KF=1e-25 AF=1${modelSuffix}`);

    await expect(simulate(deck)).rejects.toThrow(
      new InvalidCircuitError(".noise does not support MOSFET bulk/body-effect form for 'M1'"),
    );
  });

  it('matches ngspice-47 BJT level-1 collector/base shot and external resistance noise', async () => {
    const result = (await simulate(bjtFixture)).noise!;

    expect(result.frequencies).toHaveLength(10);
    for (const density of result.outputNoiseDensity) {
      expect(Math.abs(density - 2.186370381333404e-7) / 2.186370381333404e-7)
        .toBeLessThan(2e-3);
    }
    for (const density of result.inputNoiseDensity) {
      expect(Math.abs(density - 1.1694891259268678e-7) / 1.1694891259268678e-7)
        .toBeLessThan(2e-3);
    }
    expect(Math.abs(result.integratedOutputNoise! - 2.1852769227097065e-5)
      / 2.1852769227097065e-5).toBeLessThan(2e-3);
    expect(Math.abs(result.integratedInputNoise! - 1.168904235104625e-5)
      / 1.168904235104625e-5).toBeLessThan(2e-3);
  });

  it.each([
    ['RB=100', 2.185350567617382e-7, 1.1701075911061536e-7, 2.184257619028083e-5, 1.1695223909739744e-5],
    ['RC=10', 2.186370379188875e-7, 1.1694891259559532e-7, 2.18527692056625e-5, 1.168904235133696e-5],
    ['RE=10', 2.1559279357029466e-7, 1.1648030211946764e-7, 2.154849702109274e-5, 1.1642204740108559e-5],
  ] as const)(
    'matches ngspice-47 BJT level-1 %s thermal noise',
    async (parameter, outputDensity, inputDensity, integratedOutput, integratedInput) => {
      const result = (await simulate(bjtInternalResistanceFixture(parameter))).noise!;

      for (const density of result.outputNoiseDensity) {
        expect(Math.abs(density - outputDensity) / outputDensity).toBeLessThan(2e-3);
      }
      for (const density of result.inputNoiseDensity) {
        expect(Math.abs(density - inputDensity) / inputDensity).toBeLessThan(2e-3);
      }
      expect(Math.abs(result.integratedOutputNoise! - integratedOutput) / integratedOutput)
        .toBeLessThan(2e-3);
      expect(Math.abs(result.integratedInputNoise! - integratedInput) / integratedInput)
        .toBeLessThan(2e-3);
    },
  );

  it('matches ngspice-47 BJT level-1 KF/AF base-current flicker noise', async () => {
    const result = (await simulate(bjtFlickerFixture)).noise!;
    const ngspice47Output = [
      1.030487879071692e-3,
      7.020632375141064e-4,
      4.783101424714076e-4,
      3.258689459173833e-4,
      2.220119860926834e-4,
      1.512550900334955e-4,
      1.030490175269500e-4,
      7.020666078671442e-5,
      4.783150894591431e-5,
      3.258762070581348e-5,
    ];

    expect(result.outputNoiseDensity).toHaveLength(ngspice47Output.length);
    result.outputNoiseDensity.forEach((density, index) => {
      expect(Math.abs(density - ngspice47Output[index]) / ngspice47Output[index])
        .toBeLessThan(2e-3);
    });
    expect(Math.abs(result.integratedOutputNoise! - 8.564711992393035e-3)
      / 8.564711992393035e-3).toBeLessThan(2e-3);
    expect(Math.abs(result.integratedInputNoise! - 4.581262912869509e-3)
      / 4.581262912869509e-3).toBeLessThan(2e-3);
  });

  it.each([
    ['KF=-1', /finite BJT KF >= 0/i],
    ['AF=0', /finite BJT AF > 0/i],
  ])('rejects invalid BJT flicker parameter %s explicitly', async (parameter, expected) => {
    const deck = bjtFixture.replace('NR=1)', `NR=1 ${parameter})`);
    await expect(simulate(deck)).rejects.toThrow(expected);
  });

  // #736: capacitances, transit times, VAR and the reverse/leakage DC terms only
  // change the AC small-signal transfer (bjtacld.c) and the operating point,
  // not the bjtnoise.c sources.
  it('matches ngspice-47 BJT noise with CJE/CJC/TF/TR, VAF/VAR and reverse leakage', async () => {
    const result = (await simulate(`
      VDD vdd 0 DC 5
      Vinput in 0 DC 1 AC 1
      Rbase in base 100k
      Rload vdd out 2k
      Q1 out base 0 QMOD
      .model QMOD NPN (IS=1e-14 BF=100 BR=1 VAF=50 VAR=10 IKR=0.01 ISC=1e-13 NC=2
      + RB=100 RC=10 RE=1 CJE=2p CJC=1p TF=0.3n TR=5n KF=1e-12 AF=1)
      .noise v(out) Vinput dec 2 1k 10G
    `)).noise!;
    // ngspice-47 -b, set numdgt=12: onoise_spectrum / inoise_spectrum.
    const ngspice47Output = [
      1.126517404284e-05, 6.337371962875e-06, 3.568100381740e-06, 2.013577717058e-06,
      1.141412029445e-06, 6.391745031558e-07, 2.973087036438e-07, 9.060416350883e-08,
      2.577111776581e-08, 1.034454962080e-08, 7.569464947654e-09, 6.162997546321e-09,
      3.152138082943e-09, 1.158381404231e-09, 5.473902590134e-10,
    ];
    const ngspice47Input = [
      6.088895824538e-06, 3.425403388293e-06, 1.928672360568e-06, 1.088875883369e-06,
      6.199110411045e-07, 3.617712729320e-07, 2.252915701606e-07, 1.598578692181e-07,
      1.376082791711e-07, 1.742185962630e-07, 4.110451083694e-07, 1.246341548615e-06,
      3.811842721271e-06, 9.819772937571e-06, 1.913661396824e-05,
    ];
    const relativeError = (actual: number, expected: number) => Math.abs(actual - expected) / expected;
    expect(result.outputNoiseDensity).toHaveLength(ngspice47Output.length);
    result.outputNoiseDensity.forEach((density, index) => {
      expect(relativeError(density, ngspice47Output[index])).toBeLessThan(1e-4);
    });
    result.inputNoiseDensity.forEach((density, index) => {
      expect(relativeError(density, ngspice47Input[index])).toBeLessThan(1e-4);
    });
    expect(relativeError(result.integratedOutputNoise!, 9.871437469264e-04)).toBeLessThan(1e-4);
    expect(relativeError(result.integratedInputNoise!, 2.273517040781e+00)).toBeLessThan(1e-4);
  });

  it('accepts temperature-adjusted XTI/XTB/EG BJT noise', async () => {
    const deck = bjtFixture.replace('NR=1)', 'NR=1 XTI=3 XTB=1.5 EG=1.11)');
    expect((await simulate(`${deck}\n.options temp=50`)).noise).toBeDefined();
  });

  it.each(bjtGxReference.cases)('matches ngspice-47 BJT gx noise: $name', async reference => {
    const noise = (await simulate(reference.deck)).noise!;
    expect(noise.frequencies).toHaveLength(reference.frequencies.length);
    for (const [actual, expected] of [
      [noise.frequencies, reference.frequencies],
      [noise.outputNoiseDensity, reference.output],
      [noise.inputNoiseDensity, reference.input],
      [[noise.integratedOutputNoise!], [reference.onoise_total]],
      [[noise.integratedInputNoise!], [reference.inoise_total]],
    ]) {
      expect(actual).toHaveLength(expected.length);
      actual.forEach((value, index) => {
        expect(Math.abs(value - expected[index]) / expected[index]).toBeLessThan(2e-3);
      });
    }
  });

  it.each(['PTF', 'TRB1'])(
    'rejects unsupported BJT noise model parameter %s explicitly',
    async parameter => {
      const deck = bjtFixture.replace('NR=1)', `NR=1 ${parameter}=1)`);
      await expect(simulate(deck)).rejects.toThrow(new InvalidCircuitError(
        `.noise does not support BJT model parameter '${parameter}' for 'Q1'`,
      ));
    },
  );

  it('omits integrated totals when ngspice does not create an integrated-noise plot', async () => {
    const result = await simulate(fixture.replace('lin 5 100 500', 'dec 3 100 100'));

    expect(result.noise!.frequencies).toEqual([100]);
    expect(result.noise!.integratedOutputNoise).toBeUndefined();
    expect(result.noise!.integratedInputNoise).toBeUndefined();
  });

  it.each([
    ['lin 3 100 300', 'lin'],
    ['dec 3 100 10k', 'dec'],
    ['oct 3 100 800', 'oct'],
  ] as const)('returns deterministic typed diode shot-noise results for %s', async (
    sweep, variation,
  ) => {
    const deck = diodeFixture(sweep);
    expect(parse(deck).analyses[0]).toMatchObject({ type: 'noise', variation });

    const first = (await simulate(deck)).noise!;
    const repeated = (await simulate(deck)).noise!;

    expect(first).toEqual(repeated);
    expect(Math.abs(first.outputNoiseDensity[0] - 7.589715009730822e-10)
      / 7.589715009730822e-10).toBeLessThan(2e-3);
    expect(Math.abs(first.inputNoiseDensity[0] - 1.163256983612927e-8)
      / 1.163256983612927e-8).toBeLessThan(2e-3);
  });

  it('matches ngspice-47 diode flicker density and integrated totals', async () => {
    const result = (await simulate(diodeFixture('dec 3 100 10k', true))).noise!;

    const ngspice47Output = [
      1.255970194504204e-6,
      8.556827128505760e-7,
      5.829701106297475e-7,
      3.971733014469353e-7,
      2.705915906695873e-7,
      1.843527418367607e-7,
      1.255992896962048e-7,
    ];
    expect(result.outputNoiseDensity).toHaveLength(ngspice47Output.length);
    result.outputNoiseDensity.forEach((density, index) => {
      expect(Math.abs(density - ngspice47Output[index]) / ngspice47Output[index])
        .toBeLessThan(2e-3);
    });
    expect(Math.abs(result.integratedOutputNoise! - 2.695279454534208e-5)
      / 2.695279454534208e-5).toBeLessThan(2e-3);
    expect(Math.abs(result.integratedInputNoise! - 4.130988639567582e-4)
      / 4.130988639567582e-4).toBeLessThan(2e-3);
  });

  it('keeps unexpanded diode series-resistance noise explicitly unsupported', async () => {
    await expect(simulate(`
      V1 in 0 DC 1 AC 1
      R1 in out 1k
      D1 out 0 DMOD
      .model DMOD D(IS=1e-14 RS=10)
      .noise v(out) V1 dec 3 100 10k
    `)).rejects.toThrow(".noise does not support diode series-resistance noise for 'D1'");
  });

  it.each([
    ['MOSFET', 'M1', `
      Vbias drain 0 DC 1 AC 1
      Vgate gate 0 DC 2
      M1 drain gate 0 0 Mmod
      .model Mmod NMOS (LEVEL=49 VTH0=1 U0=400 TOX=4n)
      .noise v(drain) Vbias dec 3 100 10k
    `],
  ])('explicitly rejects unsupported %s noise for %s', async (kind, name, deck) => {
    try {
      await simulate(deck);
      expect.unreachable(`expected ${kind} noise to be rejected`);
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidCircuitError);
      expect((error as Error).message).toContain(
        `.noise does not support ${kind} noise for '${name}'`,
      );
    }
  });

  it.each([
    '.noise i(V1) V1 dec 10 1 1Meg',
    '.noise v(out) V1 log 10 1 1Meg',
  ])('rejects noise forms outside the first bounded slice: %s', netlist => {
    expect(() => parse(netlist)).toThrow(
      "Unsupported .noise form; expected '.noise v(node) source {lin|dec|oct} points start stop [points_per_summary]'",
    );
  });

  it('refers resistor noise to an independent current-source input', async () => {
    const result = (await simulate(`
      I1 in 0 AC 1
      R1 in out 1k
      R2 out 0 1k
      .noise v(out) I1 dec 3 100 10k
    `)).noise!;

    expect(result.frequencies).toHaveLength(7);
    expect(result.outputNoiseDensity).toHaveLength(7);
    expect(result.inputNoiseDensity).toHaveLength(7);
    const ngspice47Output = 4.071371529487329e-9;
    const ngspice47Input = 4.071371529487330e-12;
    expect(Math.abs(result.outputNoiseDensity[0] - ngspice47Output) / ngspice47Output)
      .toBeLessThan(2e-6);
    expect(Math.abs(result.inputNoiseDensity[0] - ngspice47Input) / ngspice47Input)
      .toBeLessThan(2e-6);
    expect(Math.abs(result.integratedOutputNoise! - 4.050963523633458e-7)
      / 4.050963523633458e-7).toBeLessThan(2e-6);
    expect(Math.abs(result.integratedInputNoise! - 4.050963523633458e-10)
      / 4.050963523633458e-10).toBeLessThan(2e-6);
  });

  it('accepts non-nominal BJT noise temperature via .temp', async () => {
    expect((await simulate(`${bjtFixture}\n.temp 50`)).noise).toBeDefined();
  });

  it('rejects .step combined with .noise instead of returning empty step results', () => {
    const deck = [
      'V1 in 0 AC 1',
      'Rsource in out 1k',
      '.noise v(out) V1 lin 5 100 500',
      '.step param Rsource list 1k 2k',
    ].join('\n');

    try {
      parse(deck);
      expect.unreachable('expected .step + .noise to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect(error).toMatchObject({
        line: 4,
        context: '.step param Rsource list 1k 2k',
      });
      expect((error as Error).message).toContain('.step cannot be combined with .noise');
    }
  });
});
