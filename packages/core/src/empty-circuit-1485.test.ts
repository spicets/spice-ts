import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate, simulateStream } from './simulate.js';
import { validateProtocolV1 } from './protocol/adapter.js';

const deck = readFileSync(new URL(
  '../../../benchmarks/corpus/corpus-f/fixtures/tests/regression/misc/empty-1.cir', import.meta.url,
), 'utf8');

// ngspice-47, identical empty-1.cir bytes, sourced by a wrapper aliasing quit
// to echo and exporting tran1/ac1 with `set filetype=ascii; write ... all`.
// op1 has no vectors. Values below are the complete 59-point tran1 scale in us.
const referenceTimeUs = [
  0, 0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4, 12.8, 25.6,
  45.6, 65.6, 85.6, 105.6, 125.6, 145.6, 165.6, 185.6, 205.6, 225.6,
  245.6, 265.6, 285.6, 305.6, 325.6, 345.6, 365.6, 385.6, 405.6, 425.6,
  445.6, 465.6, 485.6, 505.6, 525.6, 545.6, 565.6, 585.6, 605.6, 625.6,
  645.6, 665.6, 685.6, 705.6, 725.6, 745.6, 765.6, 785.6, 805.6, 825.6,
  845.6, 865.6, 885.6, 905.6, 925.6, 945.6, 965.6, 982.8, 1000,
];

function expectReferenceTime(time: readonly number[]): void {
  expect(time).toHaveLength(referenceTimeUs.length);
  time.forEach((value, index) => expect(value).toBeCloseTo(referenceTimeUs[index] * 1e-6, 16));
}

describe('node-less circuits (#1485)', () => {
  it('runs the unchanged ngspice emptiness regression with empty op and identical scales', async () => {
    const result = await simulate(deck);
    expect(result.dc!.voltages.size).toBe(0);
    expect(result.dc!.currents.size).toBe(0);
    expectReferenceTime(result.transient!.time);
    expect(result.transient!.voltages.size).toBe(0);
    expect(result.transient!.currents.size).toBe(0);
    expect(result.ac!.frequencies).toEqual([1000, 1500, 2000]);
    expect(result.ac!.voltages.size).toBe(0);
    expect(result.ac!.currents.size).toBe(0);
  });

  it.each(['.op', '.tran 0.1m 1m', '.ac lin 3 1kHz 2kHz', '.dc temp 25 27 1'])(
    'validates a node-less %s through the protocol', async analysis => {
      await expect(validateProtocolV1({
        apiVersion: '1', input: { format: 'spice', source: analysis },
      })).resolves.toMatchObject({ status: 'valid', nodeCount: 0, branchCount: 0, analysisCount: 1 });
    },
  );

  it('streams time-only and frequency-only points', async () => {
    const time: number[] = [];
    for await (const point of simulateStream('empty\n.op\n.tran 0.1m 1m\n')) {
      if ('time' in point) time.push(point.time);
      expect(point.voltages.size).toBe(0);
      expect(point.currents.size).toBe(0);
    }
    expectReferenceTime(time);
    const frequencies: number[] = [];
    for await (const point of simulateStream('empty\n.ac lin 3 1kHz 2kHz\n')) {
      if ('frequency' in point) frequencies.push(point.frequency);
    }
    expect(frequencies).toEqual([1000, 1500, 2000]);
  });

  it('runs a temperature-only dc sweep like ngspice-47', async () => {
    // ngspice -n -b -r dc.raw on these same bytes yields temp-sweep [25, 26, 27].
    const result = await simulate('empty sweep\n.dc temp 25 27 1\n.end\n');
    expect(Array.from(result.dcSweep!.sweepValues)).toEqual([25, 26, 27]);
    expect(result.dcSweep!.voltages.size).toBe(0);
    expect(result.dcSweep!.currents.size).toBe(0);
  });

  it('still rejects a missing analysis', async () => {
    await expect(simulate('empty\n.end\n')).rejects.toThrow('No analysis command specified');
    await expect(validateProtocolV1({
      apiVersion: '1', input: { format: 'spice', source: '.end\n' },
    })).rejects.toThrow('No analysis command specified');
  });
});
