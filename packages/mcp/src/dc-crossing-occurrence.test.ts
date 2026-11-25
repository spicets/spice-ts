import { describe, expect, it } from 'vitest';
import { executeTool } from './server.js';

const request = { apiVersion: '1', input: { format: 'spice', source: '* fixture\nV1 in 0 0\nR1 in 0 1k\n.dc V1 0 3 1\n.end' } };
const base = { request, sweptSource: 'V1', output: 'v(out)', outputLevelsV: [0] };

async function crossings(axis: number[], output: number[], options: Record<string, unknown> = {}) {
  const result = { status: 'complete' as const, analyses: [{ type: 'dc' as const, analysisIndex: 0, axis: { name: 'V1', unit: 'V' as const, values: axis }, voltagesV: { out: output }, currentsA: {} }] };
  const response = await executeTool('spice_dc_metrics', { ...base, ...options }, { simulate: async () => result });
  expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
  return (response.structuredContent as { levelCrossings: { sweepPoint: number | null }[] }).levelCrossings.map(c => c.sweepPoint);
}

describe('DC crossing occurrence', () => {
  it('selects each analytic crossing independently for each level', async () => {
    for (const [occurrence, expected] of [[1, [0.5, 0.75]], [2, [1.5, 1.25]], [3, [2.5, 2.75]], [4, [null, null]]] as const) {
      expect(await crossings([0, 1, 2, 3], [-1, 1, -1, 1], { outputLevelsV: [0, 0.5], crossingOccurrence: occurrence })).toEqual(expected);
    }
    expect(await crossings([0, 1, 2, 3], [-1, 1, -1, 1])).toEqual([0.5]);
  });

  it('filters rising and falling crossings in both traversal directions', async () => {
    const axis = [0, 1, 2, 3]; const output = [-1, 1, -1, 1];
    for (const [direction, occurrence, expected] of [['rising', 1, 0.5], ['rising', 2, 2.5], ['falling', 1, 1.5], ['falling', 2, null]] as const) {
      expect(await crossings(axis, output, { crossingDirection: direction, crossingOccurrence: occurrence })).toEqual([expected]);
    }
    for (const [direction, occurrence, expected] of [['falling', 1, 2.5], ['falling', 2, 0.5], ['rising', 1, 1.5], ['rising', 2, null], ['either', 2, 1.5]] as const) {
      expect(await crossings([...axis].reverse(), [...output].reverse(), { crossingDirection: direction, crossingOccurrence: occurrence })).toEqual([expected]);
    }
  });

  it('counts knots once and counts plateau entry, not its flat segments or departure', async () => {
    const axis = [0, 1, 2, 3, 4, 5, 6]; const output = [-1, 0, 0, 1, 0, -1, 1];
    for (const [occurrence, expected] of [[1, 1], [2, 4], [3, 5.5], [4, null]] as const) {
      expect(await crossings(axis, output, { crossingOccurrence: occurrence })).toEqual([expected]);
    }
    expect(await crossings(axis, output, { crossingDirection: 'rising', crossingOccurrence: 2 })).toEqual([5.5]);
    expect(await crossings(axis, output, { crossingDirection: 'falling', crossingOccurrence: 2 })).toEqual([null]);
    expect(await crossings([0, 1, 2, 3], [0, 0, 1, -1], { crossingOccurrence: 2 })).toEqual([2.5]);
    expect(await crossings([0, 1, 2], [0, 0, 0], { crossingDirection: 'rising' })).toEqual([null]);
  });

  it('rejects invalid occurrence values and incompatible requests', async () => {
    for (const crossingOccurrence of [0, -1, 1.5, 129, Infinity, -Infinity, NaN, '2', null, true]) {
      expect(await executeTool('spice_dc_metrics', { ...base, crossingOccurrence })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
    for (const args of [{ ...base, outputLevelsV: undefined, crossingOccurrence: 1 }, { ...base, sweepPoints: [1], includeSpotResistance: true, crossingOccurrence: 1 }]) {
      expect(await executeTool('spice_dc_metrics', args)).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
  });
});
