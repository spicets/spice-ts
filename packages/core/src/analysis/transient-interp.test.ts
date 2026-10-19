import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate, simulateStream } from '../simulate.js';
import type { TransientStep } from '../types.js';
import { TransientResult } from '../results.js';
import { interpolateTransientOutput } from './transient-output.js';
import { parse } from '../parser/index.js';

interface Oracle { name: string; deck: string; accepted: number[][]; interp: number[][] }
// Original resistor/PWL decks. ngspice-47: run; set filetype=binary; write <path> all.
// Binary doubles preserve accepted times at sharp edges, avoiding ASCII roundoff
// amplified by ngspice's extrapolation when TMAX exceeds TSTEP.
// Columns: time, v(in), i(v1), @r1[i]. Both accepted and INTERP plots captured
// from identical decks; INTERP changes only the .option card.
const oracles = JSON.parse(readFileSync(new URL('./__fixtures__/interp-ngspice-47.json', import.meta.url), 'utf8')) as Oracle[];
const withInterp = (deck: string): string => deck.replace('.tran', '.option INTERP\n.tran');

function expectRows(actual: number[][], expected: number[][]): void {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i++) {
    for (let j = 0; j < expected[i].length; j++) {
      expect(Math.abs(actual[i][j] - expected[i][j]), `row ${i}, column ${j}`).toBeLessThan(j === 0 ? 1e-18 : 1e-12 * Math.max(1, Math.abs(expected[i][j])));
    }
  }
}

describe('INTERP output grid (#1510)', () => {
  it.each(oracles)('$name transforms identical ngspice accepted points exactly', oracle => {
    const result = new TransientResult(oracle.accepted.map(row => row[0]),
      new Map([['in', oracle.accepted.map(row => row[1])]]),
      new Map([['V1', oracle.accepted.map(row => row[2])]]), undefined,
      new Map([['@r1[i]', Float64Array.from(oracle.accepted.map(row => row[3]))]]));
    const analysis = parse(oracle.deck).analyses[0];
    if (analysis.type !== 'tran') throw new Error('missing tran');
    const output = interpolateTransientOutput(result, analysis);
    expectRows(output.time.map((time, i) => [time, output.voltage('in')[i], output.current('V1')[i], output.deviceVectors.get('@r1[i]')![i]]), oracle.interp);
  });

  it.each(oracles)('$name matches ngspice-47 with and without INTERP', async oracle => {
    for (const interp of [false, true]) {
      // TSTART changes ngspice's default integration cap; accepted trajectories
      // there are not identical. INTERP must still produce the same saved grid.
      if (!interp && oracle.name === 'start') continue;
      const result = (await simulate(interp ? withInterp(oracle.deck) : oracle.deck)).transient!;
      expectRows(result.time.map((time, i) => [time, result.voltage('in')[i], result.current('v1')[i], result.deviceVectors.get('@r1[i]')![i]]), interp ? oracle.interp : oracle.accepted);
    }
  });

  it('streaming returns the same transformed time, voltage and branch current', async () => {
    const oracle = oracles[0];
    const points: number[][] = [];
    for await (const event of simulateStream(withInterp(oracle.deck))) {
      const point = event as TransientStep;
      points.push([point.time, point.voltages.get('in')!, point.currents.get('V1')!]);
    }
    expectRows(points, oracle.interp.map(row => row.slice(0, 3)));
  });

  it('measurements and control vectors see the interpolated plot', async () => {
    const oracle = oracles[0];
    const deck = withInterp(oracle.deck).replace('.end', () => '.meas tran sampled find v(in) at=3.5u\n.control\nrun\nlet count = length(time)\necho count $&count\n.endc\n.end');
    const result = await simulate(deck);
    expect(result.control!.output).toContain('count 14');
    expect(result.measurements![0]).toMatchObject({ status: 'ok', value: 5 });
  });

  it('autostop waits for a saved INTERP sample, not an unexposed accepted point', async () => {
    const deck = withInterp(oracles[0].deck).replace('.end', '.option autostop\n.meas tran sampled find v(in) at=3.5u\n.end');
    const result = await simulate(deck);
    expect(result.transient!.time.at(-1)).toBeCloseTo(4e-6, 18);
    expect(result.measurements![0]).toMatchObject({ status: 'ok', value: 5 });
  });
});
