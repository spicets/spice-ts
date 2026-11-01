import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { measureResult } from './measure.js';
import { executeTool } from './server.js';

const transient = {
  status: 'complete' as const,
  analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 1, 3], voltagesV: { out: [0, 2, 2] }, currentsA: { v1: [0, 2, 2] } }],
};
const selector = { kind: 'integ', signal: 'i(v1)', analysis: 0 };

describe('transient integral measurements', () => {
  it('integrates nonuniform stored samples with sign, interpolated bounds and zero width', () => {
    expect(measureResult(transient, [selector, { ...selector, from: 0.5, to: 2 }, { ...selector, from: 1, to: 1 }, { ...selector, signal: 'v(out)' }]).measurements)
      .toEqual([{ value: 5, unit: 'A*s' }, { value: 2.75, unit: 'A*s' }, { value: 0, unit: 'A*s' }, { value: 5, unit: 'V*s' }]);
    const reversed = { ...transient, analyses: [{ ...transient.analyses[0], currentsA: { v1: [0, -2, -2] } }] };
    expect(measureResult(reversed, [selector]).measurements).toEqual([{ value: -5, unit: 'A*s' }]);
  });

  it('isolates missing signals, windows, invalid fields and non-finite results', () => {
    expect(measureResult(transient, [selector, { ...selector, signal: 'i(missing)' }, { ...selector, from: -1 }, { ...selector, to: 4 }, { ...selector, from: 2, to: 1 }, { ...selector, from: Infinity }, { ...selector, bogus: 1 }]).measurements)
      .toMatchObject([{ value: 5 }, { error: { code: 'UNKNOWN_SIGNAL' } }, { error: { code: 'OUT_OF_RANGE' } }, { error: { code: 'OUT_OF_RANGE' } }, { error: { code: 'INVALID_MEASUREMENT' } }, { error: { code: 'INVALID_MEASUREMENT' } }, { error: { code: 'INVALID_MEASUREMENT' } }]);
    for (const values of [[0, NaN, 2], [0, Infinity, 2]]) {
      const bad = { ...transient, analyses: [{ ...transient.analyses[0], currentsA: { v1: values } }] };
      expect(measureResult(bad, [selector]).measurements).toMatchObject([{ error: { code: 'NON_FINITE_RESULT' } }]);
    }
  });

  it('selects steps and rejects ambiguous or unknown selections', () => {
    const a = transient.analyses[0];
    const stepped = { ...transient, analyses: [0, 1].map(index => ({ ...a, step: { index, parameter: 'r', value: index + 1 } })) };
    expect(measureResult(stepped, [selector, { ...selector, step: 1 }, { ...selector, step: 2 }, { ...selector, analysis: 1 }]).measurements)
      .toMatchObject([{ error: { code: 'AMBIGUOUS_ANALYSIS' } }, { value: 5, unit: 'A*s' }, { error: { code: 'UNKNOWN_STEP' } }, { error: { code: 'UNKNOWN_ANALYSIS' } }]);
  });

  it('rejects non-transient analyses independently', () => {
    const analyses = [
      { type: 'op' as const, analysisIndex: 0, voltagesV: { out: 1 }, currentsA: {} },
      { type: 'dc' as const, analysisIndex: 1, axis: { name: 'V1', unit: 'V' as const, values: [0, 1] }, voltagesV: { out: [0, 1] }, currentsA: {} },
      { type: 'ac' as const, analysisIndex: 2, frequencyHz: [1], voltagePhasors: { out: [{ real: 1, imaginary: 0, magnitude: 1, phaseDegrees: 0 }] }, currentPhasors: {} },
    ];
    const results = measureResult({ status: 'complete', analyses }, analyses.map(a => ({ kind: 'integ', signal: 'v(out)', analysis: a.analysisIndex })));
    expect(results.measurements).toMatchObject(analyses.map(() => ({ error: { code: 'INVALID_MEASUREMENT' } })));
  });

  it('returns only scalars from the public simulation path', async () => {
    const response = await executeTool('spice_measure', {
      request: { apiVersion: '1', input: { format: 'spice', source: '* Original constant current integral\nI1 0 sense 1m\nVmeas sense out 0\nR1 out 0 1k\n.tran 10u 1m\n.end' } },
      measurements: [{ ...selector, signal: 'i(Vmeas)' }, { ...selector, signal: 'v(out)' }],
    });
    expect(response.isError).not.toBe(true);
    const body = response.structuredContent as { measurements: { value: number; unit: string }[] };
    expect(Object.keys(body)).toEqual(['measurements']);
    expect(body.measurements.map(m => m.unit)).toEqual(['A*s', 'V*s']);
    expect(Math.abs(body.measurements[0].value - 1e-6)).toBeLessThan(1e-12);
    expect(Math.abs(body.measurements[1].value - 1e-3)).toBeLessThan(1e-12);
    expect(body.measurements.every(m => Object.keys(m).sort().join(',') === 'unit,value')).toBe(true);
  });

  it('advertises integ through tools/list', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/stdio.ts'], cwd: process.cwd(), stderr: 'pipe' });
    try {
      const client = new Client({ name: 'integral-test', version: '1.0.0' });
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.find(tool => tool.name === 'spice_measure')?.inputSchema).toMatchObject({ properties: { measurements: { items: { properties: { kind: { enum: expect.arrayContaining(['integ']) } } } } } });
    } finally {
      await transport.close();
    }
  }, 60_000);
});
