import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { SimulationRequestV1, SimulationResultV1 } from '@spice-ts/core/protocol';
import { DEFAULT_MCP_LIMITS, executeTool, MCP_TOOLS } from './server.js';
import { measureResult } from './measure.js';
import { runSweep } from './sweep.js';

const component = (type: string, name: string, p: string, n: string, params: Record<string, unknown>) =>
  ({ type, name, id: name, ports: [{ name: 'p', net: p }, { name: 'n', net: n }], params });
const divider = [component('V', 'V1', 'in', '0', { dc: 10 }), component('R', 'R1', 'in', 'out', { resistance: 1000 }), component('R', 'R2', 'out', '0', { resistance: 1000 })];
const current = [component('I', 'I1', '0', 'out', { waveform: 'dc', dc: 0.001 }), component('R', 'R2', 'out', '0', { resistance: 1000 })];
const request = (components: typeof divider) => ({ apiVersion: '1', input: { format: 'spice-ts', document: { format: 'spice-ts', schemaVersion: '1.0', circuit: { nets: ['in', 'out'], components }, analyses: [{ type: 'op' }], models: [], subcircuits: [] } } });
const measurements = [{ kind: 'max', signal: 'v(out)', analysis: 0 }];

describe('native DC source sweeps', () => {
  it.each([
    { components: divider, name: 'v1', values: [0, 8, -4, 8], expected: [0, 4, -2, 4] },
    { components: current, name: 'i1', values: [0, 0.003, -0.002, 0.003], expected: [0, 3, -2, 3] },
  ])('sweeps $name with independent scalar parity', async ({ components, name, values, expected }) => {
    const args = { request: request(components), parameter: { kind: 'source', name }, values, measurements };
    const before = structuredClone(args);
    expect(new AjvJsonSchemaValidator().getValidator(MCP_TOOLS.find(t => t.name === 'spice_sweep')!.inputSchema)(args).valid).toBe(true);
    const response = await executeTool('spice_sweep', args);
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    const points = response.structuredContent!.points as { value: number; status: string; measurements: { value: number }[] }[];
    expect(points).toHaveLength(values.length);
    for (const [i, value] of values.entries()) {
      const explicit = request(components.map((c, index) => index === 0 ? { ...c, params: { ...c.params, dc: value } } : c));
      const simulation = await executeTool('spice_simulate', { request: explicit });
      expect(simulation.isError).not.toBe(true);
      expect(points[i].measurements).toEqual(measureResult(simulation.structuredContent as unknown as SimulationResultV1, measurements).measurements);
      const measured = await executeTool('spice_measure', { request: explicit, measurements });
      expect(points[i]).toMatchObject({ value, status: 'complete', measurements: measured.structuredContent!.measurements });
      expect(points[i].measurements[0].value).toBeCloseTo(expected[i], 8);
    }
    expect(args).toEqual(before);
  });

  it('measures voltage-source current against Ohm’s law and independent simulation', async () => {
    const specs = [{ kind: 'max', signal: 'i(V1)', analysis: 0 }];
    const values = [0, 8, -4];
    const result = await executeTool('spice_sweep', { request: request(divider), parameter: { kind: 'source', name: 'V1' }, values, measurements: specs });
    const points = result.structuredContent!.points as { measurements: { value: number }[] }[];
    for (const [i, value] of values.entries()) {
      const explicit = request(divider.map((c, index) => index === 0 ? { ...c, params: { dc: value } } : c));
      const simulation = await executeTool('spice_simulate', { request: explicit });
      expect(points[i].measurements).toEqual(measureResult(simulation.structuredContent as unknown as SimulationResultV1, specs).measurements);
      expect(points[i].measurements[0].value).toBeCloseTo(-value / 2000, 10);
    }
  });

  it('rejects unsupported or ambiguous targets and nonfinite values', async () => {
    const cases = [
      { request: request(divider), name: 'missing', values: [1] },
      { request: request(divider), name: 'R1', values: [1] },
      { request: request([component('V', 'V1', 'in', '0', { dc: Infinity }), ...divider.slice(1)]), name: 'V1', values: [1] },
      { request: request([component('V', 'V1', 'in', '0', { dc: 1, distortionF1: 1 }), ...divider.slice(1)]), name: 'V1', values: [1] },
      { request: request([...divider, component('V', 'v1', 'x', '0', { dc: 1 })]), name: 'V1', values: [1] },
      ...['pulse', 'sin', 'ac', 'pwl'].map(waveform => ({ request: request([component('V', 'V1', 'in', '0', { dc: 1, waveform }), ...divider.slice(1)]), name: 'V1', values: [1] })),
      ...[NaN, Infinity, -Infinity].map(value => ({ request: request(divider), name: 'V1', values: [value] })),
      { request: { apiVersion: '1', input: { format: 'spice', source: 'V1 in 0 1\n.op\n.end' } }, name: 'V1', values: [1] },
      { request: { apiVersion: '1', input: { format: 'circuit-json', circuit: [], analyses: [{ type: 'op' }] } }, name: 'V1', values: [1] },
    ];
    for (const test of cases) {
      const before = structuredClone(test);
      const result = await executeTool('spice_sweep', { request: test.request, parameter: { kind: 'source', name: test.name }, values: test.values });
      expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } } });
      expect(test).toEqual(before);
    }
  });

  it('preserves range, limits and shared cancellation checks', async () => {
    const args = { request: request(divider), parameter: { kind: 'source', name: 'V1' }, range: { scale: 'lin', start: -2, stop: 2, points: 3 }, measurements };
    const result = await executeTool('spice_sweep', args);
    expect(result.structuredContent).toMatchObject({ points: [-2, 0, 2].map(value => ({ value, status: 'complete' })) });
    expect(await executeTool('spice_sweep', { request: args.request, parameter: args.parameter, values: Array(101).fill(0) })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxSweepPoints' } } } });
    expect(await executeTool('spice_sweep', args, { limits: { ...DEFAULT_MCP_LIMITS, maxSerializedResultBytes: 50 } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
    const deadline = { code: 'RESOURCE_LIMIT', details: { limit: 'maxWallTimeMs' } };
    let checks = 0;
    await expect(runSweep(args, args.request as SimulationRequestV1, async () => ({ content: [], structuredContent: {} }), () => { if (++checks === 2) throw deadline; })).rejects.toBe(deadline);
  });

  it('isolates an execution failure between successful source rows', async () => {
    const args = { parameter: { kind: 'source', name: 'V1' }, values: [1, 2, 3] };
    let calls = 0;
    const result = await runSweep(args, request(divider) as SimulationRequestV1, async () => ++calls === 2
      ? { content: [], isError: true, structuredContent: { error: { code: 'SIMULATION_FAILED' } } }
      : { content: [], structuredContent: {} }, () => {});
    expect(result.points).toEqual([{ value: 1, status: 'complete' }, { value: 2, status: 'failed', error: { code: 'SIMULATION_FAILED' } }, { value: 3, status: 'complete' }]);
  });
});
