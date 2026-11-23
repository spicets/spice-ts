import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { PoleZeroResult } from '@spice-ts/core';
import { pzMetrics } from './pz-metrics.js';
import { executeTool, MCP_TOOLS } from './server.js';

const pair = (real: number, imaginary: number) => [{ real, imaginary }, { real, imaginary: -imaginary }];
const roots = (poles: { real: number; imaginary: number }[], zeros: { real: number; imaginary: number }[] = []) => new PoleZeroResult('in', '0', 'out', '0', poles, zeros);
const request = { apiVersion: '1', input: { format: 'spice', source: readFileSync(new URL('../fixtures/pz-rlc.cir', import.meta.url), 'utf8') } };
const tool = MCP_TOOLS.find(t => t.name === 'spice_pz_metrics')!;
const validator = new AjvJsonSchemaValidator();

describe('damped pole oscillation', () => {
  it.each([-3, 3])('reports damped rather than natural frequency independent of stability (real=%s)', real => {
    const m = pzMetrics(roots(pair(real, 4)), false, true);
    const p = m.conjugatePairs[0];
    expect(Math.abs(p.dampedFrequencyHz! / (4 / (2 * Math.PI)) - 1)).toBeLessThan(1e-12);
    expect(Math.abs(p.oscillationPeriodS! / (2 * Math.PI / 4) - 1)).toBeLessThan(1e-12);
    expect(p.naturalFrequencyHz).toBeCloseTo(5 / (2 * Math.PI), 12);
    expect(m.stable).toBe(real < 0);
  });
  it('preserves the legacy shape and excludes zeros and real poles', () => {
    const input = roots([...pair(-3, 4), { real: -2, imaginary: 0 }], pair(-3, 4));
    const baseline = pzMetrics(input);
    expect(pzMetrics(input, false, false)).toEqual(baseline);
    const m = pzMetrics(input, false, true);
    expect(m.conjugatePairs).toHaveLength(2);
    expect(m.conjugatePairs[1]).toEqual(baseline.conjugatePairs[1]);
    expect(pzMetrics(roots([{ real: -2, imaginary: 0 }]), false, true).conjugatePairs).toEqual([]);
  });
  it('reports unrepresentable values explicitly without overflow or underflow', () => {
    const tiny = pzMetrics(roots(pair(-1, Number.MIN_VALUE)), false, true);
    expect(tiny.conjugatePairs[0]).toMatchObject({ dampedFrequencyHz: null, dampedFrequencyReason: 'unrepresentable', oscillationPeriodS: null, oscillationPeriodReason: 'unrepresentable' });
    const huge = pzMetrics(roots(pair(0, Number.MAX_VALUE)), false, true);
    expect(huge.conjugatePairs[0].dampedFrequencyHz).toBeGreaterThan(0);
    expect(huge.conjugatePairs[0].oscillationPeriodS).toBeGreaterThan(0);
    for (const m of [tiny, huge]) expect(validator.getValidator(tool.outputSchema!)(m).valid).toBe(true);
  });
  it('exercises an RLC .pz request and both advertised schemas', async () => {
    const args = { request, includeDampedOscillation: true };
    expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(true);
    const response = await executeTool('spice_pz_metrics', args);
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(validator.getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
    const data = response.structuredContent as unknown as { conjugatePairs: { dampedFrequencyHz: number; oscillationPeriodS: number }[] };
    expect(Math.abs(data.conjugatePairs[0].dampedFrequencyHz / (Math.sqrt(750000) / (2 * Math.PI)) - 1)).toBeLessThan(1e-6);
    expect(Math.abs(data.conjugatePairs[0].oscillationPeriodS / (2 * Math.PI / Math.sqrt(750000)) - 1)).toBeLessThan(1e-6);
    const baseline = await executeTool('spice_pz_metrics', { request });
    expect((await executeTool('spice_pz_metrics', { request, includeDampedOscillation: false })).structuredContent).toEqual(baseline.structuredContent);
    expect(validator.getValidator(tool.inputSchema)({ request, includeDampedOscillation: 'true' }).valid).toBe(false);
    expect(await executeTool('spice_pz_metrics', { request, includeDampedOscillation: 'true' })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });
});
