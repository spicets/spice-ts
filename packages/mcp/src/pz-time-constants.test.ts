import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { PoleZeroResult } from '@spice-ts/core';
import { pzMetrics } from './pz-metrics.js';
import { executeTool, MCP_TOOLS } from './server.js';

const request = { apiVersion: '1', input: { format: 'spice', source: 'R1 in 0 1k\nC1 in 0 1u\n.pz in 0 in 0 cur pz\n.end' } };
const tool = MCP_TOOLS.find(t => t.name === 'spice_pz_metrics')!;
const validate = new AjvJsonSchemaValidator();
const roots = (poles: { real: number; imaginary: number }[], zeros: { real: number; imaginary: number }[] = []) => new PoleZeroResult('in', '0', 'out', '0', poles, zeros);

describe('pole decay time constants', () => {
  it('returns analytic RC decay through the public tool and advertised schemas', async () => {
    const args = { request, includeTimeConstants: true };
    expect(validate.getValidator(tool.inputSchema)(args).valid).toBe(true);
    const response = await executeTool('spice_pz_metrics', args);
    expect(response.isError).not.toBe(true);
    const data = JSON.parse(JSON.stringify(response.structuredContent));
    expect(validate.getValidator(tool.outputSchema!)(data).valid).toBe(true);
    expect(Math.abs(data.poles[0].decayTimeConstantS / 0.001 - 1)).toBeLessThan(1e-6);
  });
  it('uses real part for conjugates and distinguishes non-decaying and unrepresentable poles', () => {
    const input = roots([{ real: -3, imaginary: 4 }, { real: -3, imaginary: -4 }, { real: -2, imaginary: 0 }, { real: 1, imaginary: 0 }, { real: 0, imaginary: 0 }, { real: -Number.MIN_VALUE, imaginary: 0 }, { real: -Number.MAX_VALUE, imaginary: 0 }], [{ real: -2, imaginary: 0 }]);
    const m = pzMetrics(input, true);
    expect(m.poles.map(p => 'decayTimeConstantS' in p ? p.decayTimeConstantS : undefined)).toEqual([1 / 3, 1 / 3, 0.5, null, null, null, 1 / Number.MAX_VALUE]);
    expect(m.poles[3]).toMatchObject({ decayTimeConstantReason: 'non-decaying' });
    expect(m.poles[4]).toMatchObject({ decayTimeConstantReason: 'non-decaying' });
    expect(m.poles[5]).toMatchObject({ decayTimeConstantReason: 'unrepresentable' });
    expect(m.zeros).toEqual(pzMetrics(input).zeros);
    expect(m.conjugatePairs).toEqual(pzMetrics(input).conjugatePairs);
    expect(m.dominantPole).toEqual(pzMetrics(input).dominantPole);
    expect(pzMetrics(roots([]), true).poles).toEqual([]);
    expect(validate.getValidator(tool.outputSchema!)(JSON.parse(JSON.stringify(m))).valid).toBe(true);
  });
  it('preserves default shape, rejects invalid flags and nonfinite roots', async () => {
    const baseline = await executeTool('spice_pz_metrics', { request });
    expect((await executeTool('spice_pz_metrics', { request, includeTimeConstants: false })).structuredContent).toEqual(baseline.structuredContent);
    expect(await executeTool('spice_pz_metrics', { request, includeTimeConstants: 'true' })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    expect(() => pzMetrics(roots([{ real: NaN, imaginary: 0 }]), true)).toThrow();
  });
});
