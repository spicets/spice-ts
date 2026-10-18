import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { VDMOS } from '../devices/vdmos.js';
import { resolveVdmosModel } from '../devices/vdmos-model.js';
import { InvalidCircuitError } from '../errors.js';
import { simulate } from '../simulate.js';

const deck = readFileSync(new URL('../../../../benchmarks/vdmos-noise/unsupported.cir', import.meta.url), 'utf8');
const reference = JSON.parse(readFileSync(new URL('../../../../benchmarks/vdmos-noise/reference.json', import.meta.url), 'utf8')) as {
  cases: Array<{ name: string; vectors: Record<string, number[]>; ac?: Record<string, number[]> }>;
};

describe('VDMOS ngspice-47 noise parity (#1348)', () => {
  it.each(reference.cases)('matches identical-netlist $name spectra', async ({ name, vectors }) => {
    const input = readFileSync(new URL(`../../../../benchmarks/vdmos-noise/${name}.cir`, import.meta.url), 'utf8');
    const noise = (await simulate(input)).noise!;
    expect(noise.frequencies).toHaveLength(vectors.frequency.length);
    for (let i = 0; i < vectors.frequency.length; i++) {
      expect(Math.abs(noise.frequencies[i] / vectors.frequency[i] - 1)).toBeLessThan(1e-12);
      expect(Math.abs(noise.outputNoiseDensity[i] / vectors.onoise_spectrum[i] - 1)).toBeLessThan(1e-4);
      expect(Math.abs(noise.inputNoiseDensity[i] / vectors.inoise_spectrum[i] - 1)).toBeLessThan(1e-4);
    }
  });

  it.each(reference.cases.filter(c => c.ac))('matches $name complex AC transfer (#1354)', async ({ name, ac: expected }) => {
    const input = readFileSync(new URL(`../../../../benchmarks/vdmos-noise/${name}.cir`, import.meta.url), 'utf8');
    const ac = (await simulate(input.slice(0, input.indexOf('.noise')) + '.ac dec 1 1 1meg\n.end\n')).ac!;
    const actual = ac.voltage('out');
    expect(actual).toHaveLength(expected!.frequency.length);
    expect(ac.frequencies).toHaveLength(expected!.frequency.length);
    for (let i = 0; i < expected!.frequency.length; i++) {
      const re = actual[i].magnitude * Math.cos(actual[i].phase * Math.PI / 180);
      const im = actual[i].magnitude * Math.sin(actual[i].phase * Math.PI / 180);
      expect(Math.hypot(re - expected!['vr(out)'][i], im - expected!['vi(out)'][i])
        / Math.hypot(expected!['vr(out)'][i], expected!['vi(out)'][i])).toBeLessThan(1e-4);
    }
  });

  it.each(['flicker', 'pchan'])('matches each ngspice print-all source in %s', async name => {
    const input = readFileSync(new URL(`../../../../benchmarks/vdmos-noise/${name}.cir`, import.meta.url), 'utf8');
    const vectors = reference.cases.find(c => c.name === name)!.vectors;
    const original = VDMOS.prototype.noiseOperatingPoint;
    // Disable only the noise seam, never the DC/AC stamp, to isolate source powers.
    for (const [field, vector] of [
      ['drainConductance', 'onoise_m1_rd'], ['sourceConductance', 'onoise_m1_rs'],
      ['gm', 'onoise_m1_id'], ['kf', 'onoise_m1_1over'],
    ] as const) {
      const spy = vi.spyOn(VDMOS.prototype, 'noiseOperatingPoint').mockImplementation(function (this: VDMOS, solution) {
        const op = original.call(this, solution);
        return { ...op, drainConductance: 0, sourceConductance: 0, gm: 0, kf: 0, [field]: op[field] };
      });
      try {
        const noise = (await simulate(input.replace('Rload vdd out 10', 'Rload vdd out 10 noisy=0'))).noise!;
        for (let i = 0; i < noise.frequencies.length; i++) {
          const expected = vectors[vector][i];
          expect(Math.abs(noise.outputNoiseDensity[i] / expected - 1)).toBeLessThan(1e-4);
        }
      } finally { spy.mockRestore(); }
    }
  });

  it.each([false, true])('exposes temperature ratio without changing channel state (thermal=%s)', thermal => {
    const { model } = resolveVdmosModel({ name: 'power', type: 'VDMOSN', params: { VTO: 1, KP: 0.1, RD: 0.2, RS: 0.3 } });
    const device = new VDMOS('M1', thermal ? [0, 1, -1, 0, 1, -1, -1, 2, 3] : [0, 1, -1, 0, 1, -1, -1], model, { TEMP: 80 });
    const solution = new Float64Array([8, 3, 80, 27]);
    device.stamp({ getVoltage: n => n < 0 ? 0 : solution[n], getCurrent: () => 0,
      stampG: () => {}, stampB: () => {}, stampC: () => {},
      time: 0, dt: 0, numNodes: 4, sourceScale: 1, useDcSourceValue: true });
    const before = device.operatingPoint;
    const op = device.noiseOperatingPoint(solution);
    expect(op.temperatureRatio).toBeCloseTo(thermal ? 353.15 / 300.15 : 1, 12);
    expect(op.temperatureKelvin).toBeCloseTo(thermal ? 353.15 : 300.15, 12);
    expect(op.gm).toBeGreaterThan(0);
    expect(op.gds).toBeGreaterThanOrEqual(0);
    expect(op.id).toBeGreaterThan(0);
    expect(device.operatingPoint).toEqual(before);
  });

  it('rejects invalid flicker coefficients', async () => {
    await expect(simulate(deck.replace('LAMBDA=0.02', 'LAMBDA=0.02 KF=-1'))).rejects.toThrow(
      new InvalidCircuitError(".noise requires finite VDMOS KF >= 0 and AF for 'M1'"),
    );
  });

  it('rejects differential VDMOS noise output', async () => {
    await expect(simulate(deck.replace('.noise v(out)', '.noise v(out,vdd)')))
      .rejects.toThrow(new InvalidCircuitError('.noise differential voltage output only supports resistor noise'));
  });

  it('also supports noise invoked only from .control', async () => {
    const controlDeck = deck.slice(0, deck.indexOf('.noise'))
      + '.control\nnoise v(out) Vgate lin 3 100 300\n.endc\n.end\n';
    expect((await simulate(controlDeck)).noise!.outputNoiseDensity[0] / 6.237243e-10).toBeCloseTo(1, 6);
  });

  it('preserves non-noise VDMOS simulation', async () => {
    const opDeck = deck.slice(0, deck.indexOf('.noise')) + '.op\n.end\n';
    const result = await simulate(opDeck);
    expect(result.dc!.voltage('out')).toBeGreaterThan(0);
    expect(result.noise).toBeUndefined();
  });
});
