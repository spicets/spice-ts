import { describe, expect, it } from 'vitest';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { measureResult } from './measure.js';

const noise: SimulationResultV1 = { status: 'complete', analyses: [{
  type: 'noise', analysisIndex: 0, frequencyHz: [1, 10], outputNoiseDensity: [1, 1], inputNoiseDensity: [1, 1],
  outputNoiseDensityUnit: 'V/sqrt(Hz)', inputNoiseDensityUnit: 'V/sqrt(Hz)', integratedOutputNoiseUnit: 'V', integratedInputNoiseUnit: 'V',
}] };

describe('measurements on noise results', () => {
  it('returns an isolated unknown signal error rather than treating spectra as voltage traces', () => {
    expect(measureResult(noise, [{ kind: 'max', signal: 'v(out)', analysis: 0 }]).measurements)
      .toMatchObject([{ error: { code: 'UNKNOWN_SIGNAL' } }]);
  });
});
