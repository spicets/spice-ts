import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { compareSignals } from './compare.js';
import { executeTool, MCP_TOOLS } from './server.js';

const result = { status: 'complete', analyses: [1, 0].map(index => ({
  type: 'tran', analysisIndex: 0, step: { index, parameter: 'r', value: index + 1 },
  timeS: [0, 1, 2], voltagesV: { out: index === 0 ? [0, 1, 2] : [0, 2, 4] }, currentsA: {},
})) };

describe('spice_compare step selection', () => {
  it('compares independently selected embedded steps', async () => {
    const response = await executeTool('spice_compare', {
      reference: { result, analysis: 0, step: 0 }, actual: { result, analysis: 0, step: 1 }, signals: ['v(out)'],
    });
    expect(response).toMatchObject({ structuredContent: { pass: false, pointsCompared: 3, comparisons: [{
      maxAbsError: 2, maxRelError: 1, xAtWorstError: 2, firstExceededX: 1, pass: false,
    }] } });
  });

  it('selects independent steps in completed job lookups', () => {
    const ids: string[] = [];
    const resolve = (id: string) => { ids.push(id); return result as SimulationResultV1; };
    expect(compareSignals({ reference: { jobId: 'ref', analysis: 0, step: 1 }, actual: { jobId: 'actual', analysis: 0, step: 0 }, signals: ['v(out)'], absTolerance: 2 }, resolve, 100))
      .toMatchObject({ pass: true, comparisons: [{ maxAbsError: 2, maxRelError: 0.5, pass: true }] });
    expect(ids).toEqual(['ref', 'actual']);
  });

  it('reports ambiguous, missing analysis and missing step without fallback', async () => {
    const actual = { result, analysis: 0, step: 0 };
    for (const [reference, code] of [
      [{ result, analysis: 0 }, 'AMBIGUOUS_ANALYSIS'],
      [{ result, analysis: 2, step: 0 }, 'UNKNOWN_ANALYSIS'],
      [{ result, analysis: 0, step: 2 }, 'UNKNOWN_STEP'],
      [{ result: { ...result, analyses: [result.analyses[0]] }, analysis: 0, step: 0 }, 'UNKNOWN_STEP'],
    ] as const) {
      expect(await executeTool('spice_compare', { reference, actual, signals: ['v(out)'] })).toMatchObject({ isError: true, structuredContent: { error: { code } } });
    }
  });

  it('treats unstepped analyses as step zero only', async () => {
    const { step: _step, ...analysis } = result.analyses[0];
    const unstepped = { status: 'complete', analyses: [analysis] };
    const args = { reference: { result: unstepped, analysis: 0, step: 0 }, actual: { result: unstepped, analysis: 0 }, signals: ['v(out)'] };
    expect(await executeTool('spice_compare', args)).toMatchObject({ structuredContent: { pass: true, comparisons: [{ maxAbsError: 0, maxRelError: 0 }] } });
    expect(await executeTool('spice_compare', { ...args, reference: { ...args.reference, step: 1 } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'UNKNOWN_STEP' } } });
  });

  it('keeps schema and runtime aligned for step selectors', async () => {
    const validate = new AjvJsonSchemaValidator().getValidator(MCP_TOOLS.find(tool => tool.name === 'spice_compare')!.inputSchema);
    const actual = { x: [0, 1, 2], signals: { 'v(out)': [0, 1, 2] }, axisUnit: 's' };
    for (const source of [{ result, analysis: 0 }, { jobId: 'job', analysis: 0 }]) {
      const make = (step: unknown) => ({ reference: { ...source, step }, actual, signals: ['v(out)'] });
      expect(validate(make(0)).valid).toBe(true);
      for (const step of [-1, 0.5, '0', null]) {
        expect(validate(make(step)).valid).toBe(false);
        expect(compareSignals(make(step), () => result as SimulationResultV1, 100)).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
      }
    }
    const rawWithStep = { reference: { ...actual, step: 0 }, actual, signals: ['v(out)'] };
    expect(validate(rawWithStep).valid).toBe(false);
    expect(compareSignals(rawWithStep, () => result as SimulationResultV1, 100)).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });
});
