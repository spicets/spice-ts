import { describe, expect, it } from 'vitest';
import { InvalidCircuitError } from '../errors.js';
import { parse } from '../parser/index.js';
import { simulate } from '../simulate.js';
import { readFileSync } from 'node:fs';

const ngspice: {
  mode: string;
  netlist: string;
  frequencies: number[];
  vectors: Record<string, number[][]>;
}[] = JSON.parse(readFileSync(new URL('./sensitivity-current-output.ngspice.json', import.meta.url), 'utf8'));

const currentSensitivityDeck = (directive: string, source = 'dc 1') => `Current sensitivity RC
vin 1 0 ${source}
r1 1 2 1k
c1 2 0 1u
r2 2 0 2k
${directive}
.end`;

describe('.sens current output (#1390)', () => {
  // Captured with ngspice-47: SPICE_ASCIIRAWFILE=1 ngspice -b -r output.raw deck.cir.
  // Each fixture includes the exact input deck and supported per-parameter raw vectors.
  // Full AC resistor vectors are ngspice r1_ac/r2_ac, not first-point aliases r1/r2.
  // ngspice uses one-sided differences; compare complex magnitudes at 1e-5 relative.
  it.each(ngspice)('matches all supported $mode parameter vectors from identical ngspice-47 decks', async fixture => {
    const result = (await simulate(fixture.netlist)).sensitivity!;
    expect(result.frequencies).toHaveLength(fixture.frequencies.length);
    result.frequencies.forEach((frequency, index) => {
      expect(frequency).toBeCloseTo(fixture.frequencies[index], 10);
    });
    let maxAbs = 0;
    let maxRel = 0;
    let samples = 0;
    for (const entry of result.entries) {
      const suffix = entry.parameter === 'multiplier' ? '_m'
        : entry.parameter === 'scale' ? '_scale'
          : entry.parameter === 'acMagnitude' ? '_acmag' : '';
      const name = `${entry.device.toLowerCase()}${suffix}`;
      const expected = fixture.vectors[name];
      expect(expected, name).toBeDefined();
      const actual = entry.ac ?? [{ real: entry.dc!, imaginary: 0 }];
      expect(actual).toHaveLength(expected.length);
      actual.forEach((value, index) => {
        const [real, imaginary = 0] = expected[index];
        const error = Math.hypot(value.real - real, value.imaginary - imaginary);
        const magnitude = Math.hypot(real, imaginary);
        maxAbs = Math.max(maxAbs, error);
        if (magnitude > 1e-15) maxRel = Math.max(maxRel, error / magnitude);
        expect(error, `${name}[${index}]`).toBeLessThanOrEqual(1e-5 * magnitude + 1e-12);
        samples++;
      });
    }
    expect(result.entries).toHaveLength(Object.keys(fixture.vectors).length);
    console.info(`ngspice-47 ${fixture.mode}: ${samples} samples; max abs ${maxAbs}; max rel ${maxRel}`);
  });

  it('parses a case-insensitive current output and reads its DC MNA branch', async () => {
    const deck = currentSensitivityDeck('.sens I(VIN)');
    expect(parse(deck).analyses[0]).toMatchObject({ outputNode: 'VIN', outputType: 'current' });
    const result = (await simulate(deck)).sensitivity!;
    expect(result).toMatchObject({ outputNode: 'VIN', outputType: 'current', mode: 'dc' });
    const values = Object.fromEntries(result.entries.map(e => [`${e.device}.${e.parameter}`, e.dc]));
    expect(values['r1.resistance']).toBeCloseTo(1 / 9e6, 14);
    expect(values['r2.resistance']).toBeCloseTo(1 / 9e6, 14);
    expect(values['vin.dc']).toBeCloseTo(-1 / 3000, 12);
    expect(values['r1.multiplier']).toBeCloseTo(-1 / 9000, 12);
    expect(values['c1.multiplier']).toBe(0);
  });

  it('differentiates complex AC branch current on the sensitivity DEC grid', async () => {
    const result = (await simulate(currentSensitivityDeck('.sens i(vin) ac dec 2 10 1k', 'dc 1 ac 1'))).sensitivity!;
    expect(result.frequencies).toHaveLength(5);
    const source = result.entries.find(e => e.device === 'vin' && e.parameter === 'acMagnitude')!;
    result.frequencies.forEach((f, index) => {
      const wC = 2 * Math.PI * f * 1e-6;
      const denominator = 1.5 ** 2 + (1000 * wC) ** 2;
      expect(source.ac![index].real).toBeCloseTo(-(0.00075 + 1000 * wC ** 2) / denominator, 11);
      expect(source.ac![index].imaginary).toBeCloseTo(-wC / denominator, 11);
    });
  });

  it.each(['missing', 'r1', 'c1'])('rejects non-voltage-source output %s with a structured error', async name => {
    await expect(simulate(currentSensitivityDeck(`.sens i(${name})`))).rejects.toBeInstanceOf(InvalidCircuitError);
    await expect(simulate(currentSensitivityDeck(`.sens i(${name})`))).rejects.toThrow(/voltage source/i);
  });
});
