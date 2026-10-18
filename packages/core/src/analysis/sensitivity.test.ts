import { describe, expect, it } from 'vitest';
import { Circuit } from '../circuit.js';
import { InvalidCircuitError, ParseError } from '../errors.js';
import { parse } from '../parser/index.js';
import { SensitivityResult } from '../results.js';
import { mapProtocolErrorV1, validateProtocolV1 } from '../protocol/adapter.js';
import { simulate } from '../simulate.js';

const dcDivider = `DC sensitivity divider
V1 in 0 1
R1 in out 1k
R2 out 0 2k
.sens V(out)
.end
`;

const acRlc = `AC sensitivity RLC
V1 in 0 DC 0 AC 1
R1 in mid 100
L1 mid out 10m
C1 out 0 1u
R2 out 0 1k
.sens V(out) AC DEC 2 10 1k
.end
`;

const acCurrentRc = `AC current-source sensitivity RC
I1 0 out DC 0 AC 1m
R1 out 0 2k
C1 out 0 1u
.sens V(out) AC DEC 2 10 1k
.end
`;

describe('.sens analysis', () => {
  it('parses the bounded single-node DC and AC forms', () => {
    expect(parse(dcDivider).analyses.at(-1)).toEqual({
      type: 'sens',
      outputNode: 'out',
      mode: 'dc',
    });
    expect(parse(acRlc).analyses.at(-1)).toEqual({
      type: 'sens',
      outputNode: 'out',
      mode: 'ac',
      variation: 'dec',
      points: 2,
      startFreq: 10,
      stopFreq: 1000,
    });
  });

  it('returns ngspice-compatible DC primary-value sensitivities in deterministic order', async () => {
    const first = await simulate(dcDivider);
    const second = await simulate(dcDivider);

    expect(first.sensitivity).toBeInstanceOf(SensitivityResult);
    expect(first.sensitivity).toEqual(second.sensitivity);
    // Each resistor also carries its instance m and scale sensitivity (#760).
    expect(first.sensitivity!.entries.map(entry => `${entry.device}.${entry.parameter}`)).toEqual([
      'R1.resistance', 'R1.multiplier', 'R1.scale',
      'R2.resistance', 'R2.multiplier', 'R2.scale',
      'V1.dc',
    ]);
    const dc = Object.fromEntries(first.sensitivity!.entries.map(entry =>
      [`${entry.device}.${entry.parameter}`, entry.dc!]));
    expect(dc['R1.resistance']).toBeCloseTo(-2.222222222e-4, 10);
    expect(dc['R2.resistance']).toBeCloseTo(1.111111111e-4, 10);
    expect(dc['V1.dc']).toBeCloseTo(2 / 3, 8);
    // R_eff = R * scale / m: d/dscale = R dV/dR, d/dm = -R dV/dR.
    expect(dc['R1.scale']).toBeCloseTo(1000 * -2.222222222e-4, 8);
    expect(dc['R1.multiplier']).toBeCloseTo(-1000 * -2.222222222e-4, 8);
  });

  it('returns deterministic complex AC sensitivities for RLC primary values', async () => {
    const result = await simulate(acRlc);

    expect(result.sensitivity).toMatchObject({
      outputNode: 'out',
      mode: 'ac',
      frequencies: [10, 31.622776601683796, 100, 316.2277660168379, 1000],
    });
    expect(result.sensitivity!.entries.map(entry => `${entry.device}.${entry.parameter}`)).toEqual([
      'C1.capacitance', 'C1.multiplier', 'C1.scale',
      'L1.inductance', 'L1.multiplier', 'L1.scale',
      'R1.resistance', 'R1.multiplier', 'R1.scale',
      'R2.resistance', 'R2.multiplier', 'R2.scale',
      'V1.acMagnitude',
    ]);
    for (const entry of result.sensitivity!.entries) {
      expect(entry.ac).toHaveLength(result.sensitivity!.frequencies.length);
      expect(entry.ac!.every(value => Number.isFinite(value.real) && Number.isFinite(value.imaginary)))
        .toBe(true);
    }
  });

  it('includes one AC-form current source magnitude in deterministic AC results', async () => {
    const first = await simulate(acCurrentRc);
    const second = await simulate(acCurrentRc);

    expect(first.sensitivity).toEqual(second.sensitivity);
    expect(first.sensitivity!.entries.map(entry => `${entry.device}.${entry.parameter}`)).toEqual([
      'C1.capacitance', 'C1.multiplier', 'C1.scale',
      'I1.acMagnitude', 'I1.multiplier',
      'R1.resistance', 'R1.multiplier', 'R1.scale',
    ]);
    const sourceSensitivity = first.sensitivity!.entries[3].ac!;
    expect(sourceSensitivity[0].real).toBeGreaterThan(1900);
    expect(sourceSensitivity.at(-1)!.imaginary).toBeLessThan(-100);
    expect(sourceSensitivity.every(value =>
      Number.isFinite(value.real) && Number.isFinite(value.imaginary))).toBe(true);
  });

  it('includes an active controlled-source gain in AC ordering', async () => {
    const result = await simulate(`active small-signal sensitivity
V1 in 0 DC 0 AC 1
G1 out 0 in 0 1m
R1 out 0 1k
.sens V(out) AC DEC 1 10 100
.end`);

    expect(result.sensitivity!.entries.map(entry => `${entry.device}.${entry.parameter}`)).toEqual([
      'G1.gain', 'R1.resistance', 'R1.multiplier', 'R1.scale', 'V1.acMagnitude',
    ]);
    for (const value of result.sensitivity!.entries[0].ac!) {
      expect(value.real).toBeCloseTo(-1000, 5);
      expect(value.imaginary).toBeCloseTo(0, 10);
    }
  });

  it('rejects multiple non-zero AC excitations instead of differentiating only the first', async () => {
    const failure = simulate(`multiple AC sensitivity excitations
V1 in 0 DC 0 AC 1
V2 out 0 DC 0 AC 2
R1 in out 1k
R2 out 0 1k
.sens V(out) AC DEC 1 1 10
.end`);
    await expect(failure).rejects.toBeInstanceOf(InvalidCircuitError);
    await expect(failure).rejects.toThrow(
      new InvalidCircuitError('.sens AC supports at most one non-zero AC excitation; found V1, V2'),
    );
  });

  it('rejects a zero AC source before the active source instead of using the zero source', async () => {
    const failure = simulate(`zero AC source before active sensitivity excitation
V1 in 0 DC 0 AC 0
V2 out 0 DC 0 AC 2
R1 in out 1k
R2 out 0 1k
.sens V(out) AC DEC 1 1 10
.end`);
    await expect(failure).rejects.toBeInstanceOf(InvalidCircuitError);
    await expect(failure).rejects.toThrow(
      new InvalidCircuitError('.sens AC supports only one AC-form voltage source; found V1, V2'),
    );
  });

  it('rejects mixed voltage/current AC-form sources in deterministic name order', async () => {
    const failure = simulate(`mixed AC sensitivity excitations
V2 in 0 DC 0 AC 1
I1 0 out DC 0 AC 1m
R1 in out 1k
R2 out 0 1k
.sens V(out) AC DEC 1 1 10
.end`);
    await expect(failure).rejects.toBeInstanceOf(InvalidCircuitError);
    await expect(failure).rejects.toThrow(
      new InvalidCircuitError('.sens AC supports at most one non-zero AC excitation; found I1, V2'),
    );
  });

  it('rejects zero-plus-active AC-form current sources as ambiguous', async () => {
    const failure = simulate(`ambiguous current-source sensitivity excitation
I2 0 in DC 0 AC 1m
I1 0 out DC 0 AC 0
R1 in out 1k
R2 out 0 1k
.sens V(out) AC DEC 1 1 10
.end`);
    await expect(failure).rejects.toBeInstanceOf(InvalidCircuitError);
    await expect(failure).rejects.toThrow(
      new InvalidCircuitError('.sens AC supports only one AC-form independent source; found I1, I2'),
    );
  });

  it('has parser/programmatic API parity', async () => {
    const circuit = new Circuit();
    circuit.addVoltageSource('V1', 'in', '0', { dc: 1 });
    circuit.addResistor('R1', 'in', 'out', 1000);
    circuit.addResistor('R2', 'out', '0', 2000);
    circuit.addAnalysis('sens', { outputNode: 'out', mode: 'dc' });

    expect((await simulate(circuit)).sensitivity).toEqual((await simulate(dcDivider)).sensitivity);
    expect(circuit.toNetlist()).toContain('.sens v(out)');

    const acCircuit = parse(acRlc);
    const programmatic = new Circuit();
    programmatic.addVoltageSource('V1', 'in', '0', { type: 'ac', dc: 0, magnitude: 1, phase: 0 });
    programmatic.addResistor('R1', 'in', 'mid', 100);
    programmatic.addInductor('L1', 'mid', 'out', 10e-3);
    programmatic.addCapacitor('C1', 'out', '0', 1e-6);
    programmatic.addResistor('R2', 'out', '0', 1000);
    programmatic.addAnalysis('sens', {
      outputNode: 'out', mode: 'ac', variation: 'dec', points: 2,
      startFreq: 10, stopFreq: 1000,
    });
    expect((await simulate(programmatic)).sensitivity).toEqual((await simulate(acCircuit)).sensitivity);

    const acCurrentCircuit = new Circuit();
    acCurrentCircuit.addCurrentSource(
      'I1', '0', 'out', { type: 'ac', dc: 0, magnitude: 1e-3, phase: 0 },
    );
    acCurrentCircuit.addResistor('R1', 'out', '0', 2000);
    acCurrentCircuit.addCapacitor('C1', 'out', '0', 1e-6);
    acCurrentCircuit.addAnalysis('sens', {
      outputNode: 'out', mode: 'ac', variation: 'dec', points: 2,
      startFreq: 10, stopFreq: 1000,
    });
    expect((await simulate(acCurrentCircuit)).sensitivity)
      .toEqual((await simulate(acCurrentRc)).sensitivity);
  });

  it.each([
    '.sens I(V1,V2)',
    '.sens V(out) AC LOG 3 1 10',
    '.sens V(out) DC 1',
    '.sens V(out) TRAN 1u 1m',
    '.sens V(out) AC DEC 0 1 10',
  ])('rejects forms outside the bounded slice: %s', directive => {
    expect(() => parse(`unsupported sensitivity\n${directive}`)).toThrow(ParseError);
  });

  it('rejects stepped sensitivity in either directive order', () => {
    expect(() => parse(`${dcDivider}\n.step R1 list 1k 2k`)).toThrow(/step.*sens/i);
    expect(() => parse('stepped sensitivity\n.step R1 list 1k 2k\n.sens V(out)'))
      .toThrow(/step.*sens/i);
  });

  it('rejects unsupported nonlinear devices explicitly', async () => {
    await expect(simulate(`unsupported nonlinear sensitivity
V1 in 0 1
D1 in out DTEST
R1 out 0 1k
.model DTEST D(IS=1e-14)
.sens V(out)
.end`)).rejects.toThrow(/\.sens does not support.*D1/i);
  });

  it('rejects invalid programmatic forms and stepped sensitivity', () => {
    const circuit = new Circuit();
    expect(() => circuit.addAnalysis('sens', {
      outputNode: 'out', mode: 'ac', variation: 'log', points: 2,
      startFreq: 1, stopFreq: 10,
    } as never)).toThrow(InvalidCircuitError);
    expect(() => circuit.addAnalysis('sens', {
      outputNode: 'out', mode: 'dc', variation: 'dec', points: 2,
      startFreq: 1, stopFreq: 10,
    } as never)).toThrow(InvalidCircuitError);

    circuit.addAnalysis('sens', { outputNode: 'out', mode: 'dc' });
    expect(() => circuit.addStep('R1', { values: [1000, 2000] }))
      .toThrow(/step.*sens/i);
  });

  it('rejects multiple sensitivity analyses rather than overwriting results', () => {
    expect(() => parse('multiple sensitivity\nR1 out 0 1k\n.sens V(out)\n.sens V(out)'))
      .toThrow(/multiple.*sens/i);
  });
});

describe('.sens AC frequency grid (ngspice-47 parity)', () => {
  const body = (sweep: string) =>
    `V1 in 0 DC 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.sens v(out) ac ${sweep}\n.end`;
  const deck = (sweep: string) => `sens grid\n${body(sweep)}`;

  // ngspice-47 cktsens.c count_steps: DEC keeps plain 10^(1/N) stepping (unlike `.ac`, which
  // stretches multi-decade sweeps) with n = (int)(N * log10(stop/start) + 1.01) points, and a
  // stop <= start sweep spans one decade. Grids from `print n frequency[1] frequency[n-1]`
  // on these identical decks.
  it.each([
    ['dec 10 1 5k', 37, 1.258925, 3981.072],
    ['dec 10 1 99.99', 21, 1.258925, 100],
    ['dec 1 1 50', 2, 10, 10],
    ['dec 1 1 500', 3, 10, 100],
    ['dec 7 3 47k', 30, 4.168486, 41684.86],
    ['dec 10 1 9.98', 11, 1.258925, 10],
    ['dec 10 1 1k', 31, 1.258925, 1000],
    ['dec 10 100 100', 11, 125.8925, 1000],
    ['dec 2 5 5', 3, 15.81139, 50],
  ])('.sens ac %s gives %i points, second %d, ending at %d', async (sweep, count, second, last) => {
    const frequencies = (await simulate(deck(sweep))).sensitivity!.frequencies;
    expect(frequencies).toHaveLength(count);
    expect(frequencies[1] / second).toBeCloseTo(1, 6);
    expect(frequencies[count - 1] / last).toBeCloseTo(1, 6);
  });

  it('preflights maxResultPoints with the ngspice .sens point count', async () => {
    const request = (maxResultPoints: number) => ({
      apiVersion: '1' as const,
      input: { format: 'spice' as const, source: body('dec 10 1 9.98') },
      options: { limits: { maxResultPoints } },
    });
    await expect(validateProtocolV1(request(11))).resolves.toBeDefined();
    let failure: unknown;
    try {
      await validateProtocolV1(request(10));
    } catch (error) {
      failure = error;
    }
    expect(mapProtocolErrorV1(failure)).toMatchObject({
      code: 'RESOURCE_LIMIT',
      details: { limit: 'maxResultPoints', configured: 10, observed: 11 },
    });
  });
});
