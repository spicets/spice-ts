import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';

const fixture = (name: string): string => readFileSync(
  new URL(`../../../../benchmarks/ltra/ac/${name}`, import.meta.url), 'utf8',
);

describe('LTRA AC ngspice-47 parity (#1604)', () => {
  it.each(['rlc', 'rc', 'lc'])('%s matches every magnitude and phase from 1 kHz to 1 GHz', async kind => {
    const reference = JSON.parse(fixture(`${kind}.json`)) as Array<[number, number, number]>;
    expect(reference).toHaveLength(61);
    const result = (await simulate(fixture(`${kind}.cir`))).ac!;
    const output = result.voltage('3');
    expect(output).toHaveLength(reference.length);
    let maxMagnitudeError = 0;
    let maxPhaseError = 0;
    for (const [index, [frequency, real, imaginary]] of reference.entries()) {
      expect(result.frequencies[index] / frequency).toBeCloseTo(1, 10);
      const magnitude = Math.hypot(real, imaginary);
      const phase = Math.atan2(imaginary, real) * 180 / Math.PI;
      maxMagnitudeError = Math.max(maxMagnitudeError, Math.abs(output[index].magnitude / magnitude - 1));
      const phaseDelta = (output[index].phase - phase) * Math.PI / 180;
      maxPhaseError = Math.max(maxPhaseError, Math.abs(Math.atan2(Math.sin(phaseDelta), Math.cos(phaseDelta))) * 180 / Math.PI);
    }
    console.info(`${kind}: ${reference.length} points, max relative magnitude error=${maxMagnitudeError}, max phase error=${maxPhaseError} deg`);
    expect(maxMagnitudeError).toBeLessThanOrEqual(1e-6);
    expect(maxPhaseError).toBeLessThanOrEqual(1e-4);
  });

  it('keeps RC transient unsupported', async () => {
    await expect(simulate(fixture('rc.cir').replace('.ac dec 10 1k 1g', '.tran 1n 10n')))
      .rejects.toThrow(/RC.*transient|transient.*RC/);
  });
});
