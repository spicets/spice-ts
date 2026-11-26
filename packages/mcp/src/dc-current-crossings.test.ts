import { describe, expect, it, vi } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';

const request = { apiVersion: '1', input: { format: 'spice', source: '* resistor\nV1 in 0 0\nR1 in 0 1k\n.dc V1 0 4 1\n.end' } };

describe('DC current crossings', () => {
  it('interpolates signed current levels on a voltage-source sweep', async () => {
    const response = await executeTool('spice_dc_metrics', { request, sweptSource: 'V1', output: 'v(in)', currentSignal: 'i(V1)', currentLevelsA: [-0.0015, -0.005] });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ currentLevelCrossings: [
      { currentLevelA: -0.0015, sweepPoint: 1.5 },
      { currentLevelA: -0.005, sweepPoint: null },
    ] });
  });
  it.each([false, true])('handles real text and native decks once (descending=%s)', async reverse => {
    const start = reverse ? 4 : 0; const stop = reverse ? 0 : 4; const step = reverse ? -1 : 1;
    const text = { apiVersion: '1', input: { format: 'spice', source: `* resistor\nV1 in 0 0\nR1 in 0 1k\n.dc V1 ${start} ${stop} ${step}\n.end` } };
    const native = { apiVersion: '1', input: { format: 'spice-ts', document: {
      format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [],
      circuit: { nets: ['in'], components: [
        { type: 'V', id: 'V1', name: 'V1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { dc: 0 } },
        { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { resistance: 1000 } },
      ] }, analyses: [{ type: 'dc', source: 'V1', start, stop, step }],
    } } };
    const tool = MCP_TOOLS.find(t => t.name === 'spice_dc_metrics')!;
    const validator = new AjvJsonSchemaValidator();
    for (const req of [text, native]) {
      const args = { request: req, sweptSource: 'V1', output: 'v(in)', currentSignal: 'i(V1)', currentLevelsA: [-0.0015, -0.004, -0.005, -0.0015] };
      expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(true);
      const simulate = vi.fn(simulateProtocolV1);
      const response = await executeTool(tool.name, args, { simulate });
      expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
      expect(simulate).toHaveBeenCalledTimes(1);
      expect(validator.getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
      const crossings = (response.structuredContent as { currentLevelCrossings: { sweepPoint: number | null }[] }).currentLevelCrossings;
      for (const [i, expected] of [1.5, 4, null, 1.5].entries()) {
        if (expected === null) expect(crossings[i].sweepPoint).toBeNull();
        else expect(Math.abs(crossings[i].sweepPoint! - expected)).toBeLessThanOrEqual(1e-12);
      }
    }
  });

  it('counts synthetic multiple crossings, directions, knots and plateaus in traversal order', async () => {
    const axis = [0, 1, 2, 3, 4, 5, 6], current = [-1, 0, 0, 1, 0, -1, 1];
    for (const reverse of [false, true]) {
      const a = reverse ? [...axis].reverse() : axis, c = reverse ? [...current].reverse() : current;
      const result = { status: 'complete' as const, analyses: [{ type: 'dc' as const, analysisIndex: 0, axis: { name: 'V1', unit: 'V' as const, values: a }, voltagesV: { in: a }, currentsA: { v1: c } }] };
      const expectations = reverse ? { either: [5.5, 4, 2], rising: [4, null], falling: [5.5, 2] } : { either: [1, 4, 5.5], rising: [1, 5.5], falling: [4, null] };
      for (const direction of ['either', 'rising', 'falling'] as const) {
        for (const [index, expected] of [...expectations[direction], null].entries()) {
          const response = await executeTool('spice_dc_metrics', { request, sweptSource: 'V1', output: 'v(in)', currentSignal: 'i(V1)', currentLevelsA: [0], crossingDirection: direction, crossingOccurrence: index + 1 }, { simulate: async () => result });
          expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
          expect(response.structuredContent).toMatchObject({ currentLevelCrossings: [{ currentLevelA: 0, sweepPoint: expected }] });
        }
      }
    }
  });

  it('rejects bad queries and incompatible traces with structured errors', async () => {
    const base = { request, sweptSource: 'V1', output: 'v(in)', currentSignal: 'i(V1)', currentLevelsA: [0] };
    const bad = [
      { currentLevelsA: [] }, { currentLevelsA: Array(129).fill(0) }, { currentLevelsA: [NaN] }, { currentLevelsA: [Infinity] },
      { currentSignal: undefined }, { currentSignal: 'v(V1)' }, { currentSignal: 'i(missing)' },
      { crossingOccurrence: 0 }, { crossingDirection: 'sideways' }, { includeSpotResistance: true, sweepPoints: [0] },
      { analysis: 99 }, { step: 99 },
      { request: { apiVersion: '1', input: { format: 'spice', source: '* current\nI1 in 0 0\nR1 in 0 1k\n.dc I1 0 1m 0.5m\n.end' } }, sweptSource: 'I1', currentSignal: 'i(I1)', input: 'v(in)' },
    ];
    for (const args of bad) expect(await executeTool('spice_dc_metrics', { ...base, ...args })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    const result = { status: 'complete' as const, analyses: [{ type: 'dc' as const, analysisIndex: 0, axis: { name: 'V1', unit: 'V' as const, values: [0, 0, 1] }, voltagesV: { in: [0, 0, 1] }, currentsA: { v1: [0, 1, 2] } }] };
    expect(await executeTool('spice_dc_metrics', base, { simulate: async () => result })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });

  it('advertises dependencies and leaves default and current-spot results unchanged', async () => {
    const tool = MCP_TOOLS.find(t => t.name === 'spice_dc_metrics')!;
    const validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
    const base = { request, sweptSource: 'V1', output: 'v(in)' };
    expect(validate({ ...base, currentLevelsA: [0] }).valid).toBe(false);
    expect(validate({ ...base, currentSignal: 'i(V1)' }).valid).toBe(false);
    expect(validate({ ...base, currentSignal: 'i(V1)', currentLevelsA: [0] }).valid).toBe(true);
    const legacy = await executeTool(tool.name, base);
    const levels = await executeTool(tool.name, { ...base, currentSignal: 'i(V1)', currentLevelsA: [0] });
    const { currentLevelCrossings: _, ...withoutLevels } = levels.structuredContent as Record<string, unknown>;
    expect(withoutLevels).toEqual(legacy.structuredContent);
    const spots = await executeTool(tool.name, { ...base, currentSignal: 'i(V1)', sweepPoints: [1] });
    const combined = await executeTool(tool.name, { ...base, currentSignal: 'i(V1)', sweepPoints: [1], currentLevelsA: [0] });
    const { currentLevelCrossings: __, ...withoutCombinedLevels } = combined.structuredContent as Record<string, unknown>;
    expect(withoutCombinedLevels).toEqual(spots.structuredContent);
  });

});
