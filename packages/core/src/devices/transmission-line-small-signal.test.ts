import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';

const circuit = `parallel line small signal
V1 src 0 AC 1
R1 src in 50
T1 in 0 out 0 Z0=50 TD=1n
T2 in 0 out 0 Z0=50 TD=1n
R2 out 0 50
`;

describe('parallel transmission line small-signal regularization', () => {
  it('preserves the existing finite noise spectrum', async () => {
    const result = await simulate(`${circuit}.noise v(out) V1 lin 3 1meg 3meg\n.end`);
    const density = result.noise!.outputNoiseDensity;
    expect(density).toHaveLength(3);
    for (const value of density) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value / 6.437404735994158e-10).toBeCloseTo(1, 6);
    }
  });

  it('cancels the DC regularization in AC even with a large device gmin', async () => {
    const deck = `matched line AC
V1 src 0 AC 1
R1 src in 50
T1 in 0 out 0 Z0=50 TD=1n
R2 out 0 50
.ac lin 1 125meg 125meg
.end`;
    const output = (await simulate(deck, { deviceGmin: 0.1 })).ac!.voltage('out')[0];
    expect(output.magnitude).toBeCloseTo(0.5, 9);
    expect(output.phase).toBeCloseTo(-45, 7);
  });

  it('preserves pole-zero analysis with parallel lines', async () => {
    const result = await simulate(`${circuit}C1 out 0 1n\n.pz in 0 out 0 vol pz\n.end`);
    expect(result.poleZero).toBeDefined();
    expect(result.poleZero!.poles).toHaveLength(1);
    expect(result.poleZero!.poles[0].real).toBeLessThan(0);
    expect(Number.isFinite(result.poleZero!.poles[0].real)).toBe(true);
  });
});
