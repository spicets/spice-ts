import { describe, expect, it } from 'vitest';
import type { SimulationRequestV1, SimulationResultV1 } from '@spice-ts/core/protocol';
import { createToolExecutor, executeTool, MCP_TOOLS } from './server.js';

const source = '* Original RC divider fixture (MIT)\n.param rval=1k\nV1 in 0 4\nR1 in out {rval}\nR2 out 0 1k\nC1 out 0 1u\n.op\n.end';
const request: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice', source } };

async function result(tool: string, params?: unknown, input = request): Promise<SimulationResultV1> {
  const execute = createToolExecutor();
  const response = await execute(tool, { request: input, ...(params === undefined ? {} : { params }) });
  expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
  if (tool === 'spice_simulate') return response.structuredContent as unknown as SimulationResultV1;
  let { jobId, cursor } = response.structuredContent as { jobId: string; cursor: string };
  for (let i = 0; i < 200; i++) {
    const read = await execute('spice_simulation_read', { jobId, cursor });
    const data = read.structuredContent as { nextCursor: string; terminal?: { data: SimulationResultV1 } };
    if (data.terminal) return data.terminal.data;
    cursor = data.nextCursor;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Stream did not finish');
}

function voltage(result: SimulationResultV1): number {
  const op = result.analyses[0];
  if (op?.type !== 'op') throw new Error('Expected operating point');
  return op.voltagesV.out!;
}

describe.each(['spice_simulate', 'spice_simulation_start'])('%s parameter overrides', tool => {
  it('keeps the default and overrides the RC divider to the analytic voltage', async () => {
    expect(voltage(await result(tool))).toBeCloseTo(2, 8);
    expect(voltage(await result(tool, { rval: 3000 }))).toBeCloseTo(1, 8);
    expect(request.input).toEqual({ format: 'spice', source });
  });

  it('matches names case-insensitively and re-evaluates dependent parameters', async () => {
    const input = { ...request, input: { format: 'spice' as const, source: source.replace('.param rval=1k', '.param base=500\n.param rval={base*2}') } };
    expect(voltage(await result(tool, { BASE: 1500 }, input))).toBeCloseTo(1, 8);
  });

  it('lists only top-level names for an unknown parameter', async () => {
    const input = { ...request, input: { format: 'spice' as const, source: '.subckt cell a b params: hidden=1\n.param local=2\nR1 a b {local}\n.ends\n* .param comment=1\n' + source } };
    const response = await executeTool(tool, { request: input, params: { hidden: 3 } });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: {
      code: 'UNKNOWN_PARAMETER', phase: 'validation', details: { unknown: ['hidden'], available: ['rval'] },
    } } });
  });

  it.each([NaN, Infinity, -Infinity, '3000', null])('rejects non-finite/non-numeric values %s', async value => {
    expect(await executeTool(tool, { request, params: { rval: value } })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } },
    });
  });

  it.each([null, [], 3])('rejects malformed params %s', async params => {
    expect(await executeTool(tool, { request, params })).toMatchObject({ isError: true,
      structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });

  it('accepts an empty override and rejects duplicate case-insensitive names', async () => {
    expect(voltage(await result(tool, {}))).toBeCloseTo(2, 8);
    expect(await executeTool(tool, { request, params: { rval: 1, RVAL: 2 } })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } },
    });
  });

  it('applies the override before evaluating a broken default', async () => {
    const input = { ...request, input: { format: 'spice' as const, source: source.replace('rval=1k', 'rval={missing}') } };
    expect(voltage(await result(tool, { rval: 3000 }, input))).toBeCloseTo(1, 8);
  });

  it('rejects params on non-SPICE input', async () => {
    const response = await executeTool(tool, { request: { apiVersion: '1', input: {
      format: 'spice-ts', document: {},
    } }, params: { rval: 3000 } });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });

  it('uses overridden values when selecting conditional branches', async () => {
    const conditional = source.replace('R1 in out {rval}', '.if rval > 2000\nR1 in out {rval}\n.else\nR1 in out 500\n.endif');
    expect(voltage(await result(tool, { rval: 3000 }, { ...request, input: { format: 'spice', source: conditional } }))).toBeCloseTo(1, 8);
  });
});

it('documents the override schema and capability', async () => {
  for (const name of ['spice_simulate', 'spice_simulation_start', 'spice_noise_metrics']) {
    expect(MCP_TOOLS.find(tool => tool.name === name)?.inputSchema.properties).toHaveProperty('params');
  }
  expect((await executeTool('spice_capabilities', {})).structuredContent).toMatchObject({
    parameterOverrides: { tools: ['spice_simulate', 'spice_simulation_start', 'spice_noise_metrics'], caseSensitive: false, unknownParameterCode: 'UNKNOWN_PARAMETER' },
  });
});
