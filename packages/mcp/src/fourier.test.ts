import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { executeTool, MCP_TOOLS } from './server.js';

// Original analytic probe, MIT licensed with this package.
const deck = '* Fourier analytic probe\nV1 a 0 SIN(0 1 1k)\nV3 out a SIN(0 0.1 3k)\nR1 out 0 1k\n.tran 1u 5m 0 1u\n.four 1k v(out)\n.end';
const request = (source = deck) => ({ apiVersion: '1', input: { format: 'spice', source } });
const args = { request: request(), signal: 'v(out)', fundamentalHz: 1000 };
const validator = new AjvJsonSchemaValidator();
const schema = () => MCP_TOOLS.find(t => t.name === 'spice_fourier')!.outputSchema!;
function samples(duration = 0.005): SimulationResultV1 {
  const timeS = Array.from({ length: 5001 }, (_, i) => i * duration / 5000);
  const y = timeS.map(t => 2 + Math.sin(2 * Math.PI * 1000 * t) + 0.1 * Math.sin(2 * Math.PI * 3000 * t));
  return { status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0, timeS, voltagesV: { out: y }, currentsA: { V1: y.map(v => -v) } }] };
}

describe('spice_fourier', () => {
  it('matches analytic sine + third-harmonic THD within 1e-3 relative', async () => {
    const response = await executeTool('spice_fourier', args);
    expect(response.isError).not.toBe(true);
    expect(validator.getValidator(schema())(response.structuredContent).valid).toBe(true);
    const m = response.structuredContent as { thdPercent: number; dc: number; harmonics: { magnitude: number; phase: number; normalizedMagnitude: number }[] };
    expect(Math.abs(m.thdPercent / 10 - 1)).toBeLessThan(1e-3);
    expect(m.dc).toBeCloseTo(0, 5);
    expect(m.harmonics).toHaveLength(9);
    expect(m.harmonics[0].magnitude).toBeCloseTo(1, 4);
    expect(m.harmonics[0].phase).toBeCloseTo(0, 3);
    expect(m.harmonics[2].normalizedMagnitude).toBeCloseTo(0.1, 4);
  });

  it.each([
    ['UNKNOWN_SIGNAL', samples(), { signal: 'v(missing)' }],
    ['NO_TRANSIENT', { status: 'complete', analyses: [] }, {}],
    ['INSUFFICIENT_PERIOD', samples(0.0005), {}],
    ['INSUFFICIENT_PERIOD', samples(), { windowStartS: 0.0045 }],
    ['NO_TRANSIENT', samples(), { analysis: 1 }],
  ])('returns structured %s', async (code, result, extra) => {
    const response = await executeTool('spice_fourier', { ...args, ...extra }, { simulate: async () => result as SimulationResultV1 });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code } } });
    expect(validator.getValidator(schema())(response.structuredContent).valid).toBe(true);
  });

  it('resolves current/case selectors, DC, analysis and last-period lower bound', async () => {
    const response = await executeTool('spice_fourier', { ...args, signal: 'I(v1)', analysis: 0, harmonicCount: 3, windowStartS: 0.00123 }, { simulate: async () => samples() });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ unit: 'A', dc: expect.closeTo(-2, 5), thdPercent: expect.closeTo(10, 3) });
    expect((response.structuredContent as { harmonics: unknown[] }).harmonics).toHaveLength(3);
  });

  it.each([{ fundamentalHz: 0 }, { fundamentalHz: Infinity }, { harmonicCount: 65 }, { harmonicCount: 0 }, { harmonicCount: 1.5 }, { windowStartS: -1 }, { analysis: -1 }, { unknown: true }])('rejects invalid selectors %j before solving', async extra => {
    const response = await executeTool('spice_fourier', { ...args, ...extra }, { simulate: async () => { throw new Error('must not solve'); } });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });

  it('rejects invalid data and zero fundamental without serializing NaN', async () => {
    for (const mode of ['duplicate', 'zero', 'ambiguous']) {
      const result = samples();
      const a = result.analyses[0];
      if (a.type !== 'tran') throw new Error('fixture');
      if (mode === 'duplicate') a.timeS[1] = 0;
      if (mode === 'zero') a.voltagesV.out.fill(0);
      if (mode === 'ambiguous') result.analyses.push({ ...a });
      const response = await executeTool('spice_fourier', args, { simulate: async () => result });
      expect(response.isError).toBe(true);
      expect(validator.getValidator(schema())(response.structuredContent).valid).toBe(true);
    }
  });

  it('advertises schemas and capabilities and preserves resource bounds', async () => {
    expect((await executeTool('spice_capabilities', {})).structuredContent).toMatchObject({ tools: expect.arrayContaining(['spice_fourier']) });
    expect(validator.getValidator(MCP_TOOLS.find(t => t.name === 'spice_fourier')!.inputSchema)(args).valid).toBe(true);
    expect(await executeTool('spice_fourier', { ...args, request: { ...request(), options: { limits: { maxResultPoints: 0 } } } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
    expect(await executeTool('spice_fourier', { ...args, request: request('V1 out 0 1\nR1 out 0 1k\n.op') })).toMatchObject({ isError: true, structuredContent: { error: { code: 'NO_TRANSIENT' } } });
  });

  it('converts circuit-json before simulation with diagnostics intact', async () => {
    const response = await executeTool('spice_fourier', {
      ...args,
      request: { apiVersion: '1', input: { format: 'circuit-json', circuit: [
        { type: 'source_component', source_component_id: 'R1', name: 'R1', ftype: 'simple_resistor', resistance: 1000 },
        { type: 'pcb_component', pcb_component_id: 'pcb1' },
      ], analyses: [{ type: 'tran', step: 1e-6, stopTime: 0.005 }] } },
    }, { simulate: async request => {
      expect(request.input.format).toBe('spice-ts');
      return samples();
    } });
    expect(response, JSON.stringify(response)).not.toHaveProperty('isError', true);
    expect(response._meta).toMatchObject({ conversionDiagnostics: expect.arrayContaining([expect.objectContaining({ code: 'LAYOUT_ONLY' })]) });
  });
});
