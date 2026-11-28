import { describe, expect, it } from 'vitest';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { runCorners } from './corners.js';
import { executeTool, MCP_TOOLS, DEFAULT_MCP_LIMITS } from './server.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

const request: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice', source: '* divider\nV1 in 0 1\nR1 in out 1k\nR2 out 0 1k\n.op\n.end' } };
const measurements = [
  { id: 'voltage', measurement: { kind: 'max', signal: 'v(out)', analysis: 0 } },
  { id: 'current', measurement: { kind: 'max', signal: 'i(v1)', analysis: 0 } },
];
const corners = [{ name: 'low', components: { R2: 1000 } }, { name: 'mid', components: { R2: 2000 } }, { name: 'high', components: { R2: 3000 } }];

describe('multiple corner measurements', () => {
  it('runs each divider corner once and summarizes each measurement independently', async () => {
    let runs = 0;
    const result = await runCorners({ request, corners, measurements }, request, 'spice', async (changed, list) => {
      runs++;
      return executeTool('spice_measure', { request: changed, measurements: list });
    }, () => {});
    expect(runs).toBe(3);
    const data = result as unknown as { corners: { measurements: { id: string; value: number; unit: string }[] }[]; summaries: { id: string; summary: { min: { name: string; value: number }; max: { name: string; value: number }; unit: string } }[] };
    expect(data.corners.map(c => c.measurements.map(m => m.id))).toEqual(Array(3).fill(['voltage', 'current']));
    for (const [i, expected] of [0.5, 2 / 3, 0.75].entries()) expect(data.corners[i].measurements[0].value).toBeCloseTo(expected, 8);
    for (const [i, expected] of [-0.0005, -1 / 3000, -0.00025].entries()) expect(data.corners[i].measurements[1].value).toBeCloseTo(expected, 8);
    expect(data.summaries[0]).toMatchObject({ id: 'voltage', summary: { min: { name: 'low' }, max: { name: 'high' }, unit: 'V' } });
    expect(data.summaries[0].summary.max.value - data.summaries[0].summary.min.value).toBeCloseTo(0.25, 8);
    expect(data.summaries[1]).toMatchObject({ id: 'current', summary: { min: { name: 'low' }, max: { name: 'high' }, unit: 'A' } });
  });
  it('rejects invalid list forms before simulation and advertises both modes', async () => {
    const validate = new AjvJsonSchemaValidator().getValidator(MCP_TOOLS.find(t => t.name === 'spice_corners')!.inputSchema);
    const valid = { request, corners, measurements };
    expect(validate(valid).valid).toBe(true);
    expect(validate({ request, corners, measurement: measurements[0].measurement }).valid).toBe(true);
    const bad = [
      { request, corners }, { ...valid, measurement: measurements[0].measurement },
      { ...valid, measurements: [] }, { ...valid, measurements: Array(17).fill(measurements[0]) },
      { ...valid, measurements: [measurements[0], measurements[0]] },
      { ...valid, measurements: [{ ...measurements[0], extra: true }] },
      { ...valid, measurements: [{ ...measurements[0], measurement: { ...measurements[0].measurement, extra: true } }] },
      { ...valid, extra: true },
    ];
    for (const [i, args] of bad.entries()) {
      let runs = 0;
      await expect(runCorners(args, request, 'spice', async () => { runs++; return { content: [] }; }, () => {})).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(runs).toBe(0);
      if (i !== 4) expect(validate(args).valid).toBe(false);
    }
  });

  it('isolates failed measurements and corners, with null summary and first-corner ties', async () => {
    const list = [measurements[0], { id: 'missing', measurement: { kind: 'max', signal: 'v(missing)', analysis: 0 } }];
    const selected = [{ name: 'first' }, { name: 'bad', components: { missing: 1 } }, { name: 'last' }];
    const response = await executeTool('spice_corners', { request, corners: selected, measurements: list });
    expect(response).toMatchObject({ structuredContent: {
      corners: [
        { name: 'first', status: 'complete', measurements: [{ id: 'voltage', value: 0.5 }, { id: 'missing', error: { code: 'UNKNOWN_SIGNAL' } }] },
        { name: 'bad', status: 'failed' },
        { name: 'last', status: 'complete', measurements: [{ id: 'voltage', value: 0.5 }, { id: 'missing', error: { code: 'UNKNOWN_SIGNAL' } }] },
      ],
      summaries: [{ id: 'voltage', summary: { min: { name: 'first', value: 0.5 }, max: { name: 'first', value: 0.5 }, spread: 0, unit: 'V' } }, { id: 'missing', summary: null }],
    } });
  });

  it('enforces cancellation and the serialized result cap in list mode', async () => {
    const args = { request, corners, measurements };
    expect(await executeTool('spice_corners', args, { signal: AbortSignal.abort() })).toMatchObject({ isError: true, structuredContent: { error: { code: 'CANCELLED' } } });
    expect(await executeTool('spice_corners', args, { limits: { ...DEFAULT_MCP_LIMITS, maxSerializedResultBytes: 50 } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
  });

  it('propagates a cap reached while accumulating the combined response', async () => {
    const cap = { code: 'RESOURCE_LIMIT', details: { limit: 'maxSerializedResultBytes' } };
    let runs = 0;
    await expect(runCorners({ request, corners, measurements }, request, 'spice', async (changed, list) => {
      runs++;
      return executeTool('spice_measure', { request: changed, measurements: list });
    }, result => { if (result.corners.length === 2) throw cap; })).rejects.toBe(cap);
    expect(runs).toBe(2);
  });

});
