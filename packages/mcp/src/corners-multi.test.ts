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
  it('compares exact endpoints, one-sided, equal, negative and zero limits', async () => {
    const checks = [
      { min: -1, max: 1 }, { min: 0 }, { max: 0 }, { min: 0, max: 0 },
    ];
    const values = [-2, -1, 0, 1, 2];
    const list = checks.map((limits, i) => ({ id: String(i), measurement: measurements[0].measurement, limits }));
    let runs = 0;
    const result = await runCorners({ request, measurements: list, corners: values.map((_, i) => ({ name: String(i) })) }, request, 'spice', async () => {
      const value = values[runs++];
      return { content: [], structuredContent: { measurements: checks.map(() => ({ value, unit: 'V' })) } };
    }, () => {});
    const entries = (result as { corners: { measurements: { withinLimits: boolean }[] }[] }).corners;
    expect(runs).toBe(5);
    expect(entries.map(c => c.measurements.map(m => m.withinLimits))).toEqual([
      [false, false, true, false], [true, false, true, false], [true, true, true, true],
      [true, true, false, false], [false, true, false, false],
    ]);
  });

  it('rejects malformed limits before executing any corner', async () => {
    for (const limits of [{}, { min: 2, max: 1 }, { min: NaN }, { max: Infinity }, { min: -Infinity }, { min: 0, extra: 1 }, null, { min: '0' }]) {
      let runs = 0;
      const args = { request, corners, measurements: [{ ...measurements[0], limits }] };
      await expect(runCorners(args, request, 'spice', async () => { runs++; return { content: [] }; }, () => {})).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(runs).toBe(0);
      expect(await executeTool('spice_corners', args)).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
  });

  it('validates scalar success, scalar measurement errors and top-level errors against output schema', async () => {
    const validate = new AjvJsonSchemaValidator().getValidator(MCP_TOOLS.find(t => t.name === 'spice_corners')!.outputSchema!);
    for (const args of [
      { request, corners, measurement: measurements[0].measurement },
      { request, corners, measurement: { ...measurements[0].measurement, signal: 'v(missing)' } },
      { request, corners, measurements: [{ ...measurements[0], limits: {} }] },
    ]) {
      const response = await executeTool('spice_corners', args);
      const validation = validate(response.structuredContent);
      expect(validation.valid, JSON.stringify(validation)).toBe(true);
    }
  });

  it('checks native divider corners once each, preserving errors, summaries and schema', async () => {
    const document = { format: 'spice-ts', schemaVersion: '1.0', circuit: { nets: ['in', 'out'], components: [
      { type: 'V', id: 'V1', name: 'V1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { dc: 5 } },
      { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: 'out' }], params: { resistance: 1000 } },
      { type: 'R', id: 'R2', name: 'R2', ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { resistance: 1000 } },
    ] }, analyses: [{ type: 'op' }], models: [], subcircuits: [] };
    const native = { apiVersion: '1', input: { format: 'spice-ts', document } } as unknown as SimulationRequestV1;
    const selected = [{ name: 'low', sources: { V1: 4 } }, { name: 'mid' }, { name: 'high', sources: { V1: 6 } }, { name: 'failed', components: { missing: 1 } }];
    const list = [{ ...measurements[0], limits: { min: 2.25, max: 2.75 } }, measurements[1], { id: 'bad', measurement: { kind: 'max', signal: 'v(missing)', analysis: 0 }, limits: { min: 0 } }];
    const args = { request: native, corners: selected, measurements: list };
    const tool = MCP_TOOLS.find(t => t.name === 'spice_corners')!;
    expect(new AjvJsonSchemaValidator().getValidator(tool.inputSchema)(args).valid).toBe(true);
    const response = await executeTool('spice_corners', args);
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    const validation = new AjvJsonSchemaValidator().getValidator(tool.outputSchema!)(response.structuredContent);
    expect(validation.valid, JSON.stringify(validation)).toBe(true);
    const result = response.structuredContent as { corners: { name: string; status: string; measurements: { value?: number; withinLimits?: boolean; error?: unknown }[] }[]; summaries: unknown[] };
    expect(result.corners.map(c => c.name)).toEqual(['low', 'mid', 'high', 'failed']);
    for (const [i, value] of [2, 2.5, 3].entries()) {
      expect(result.corners[i].measurements[0].value).toBeCloseTo(value, 10);
      expect(result.corners[i].measurements[0].withinLimits).toBe([false, true, false][i]);
      expect(result.corners[i].measurements[1]).not.toHaveProperty('withinLimits');
      expect(result.corners[i].measurements[2]).toMatchObject({ error: { code: 'UNKNOWN_SIGNAL' } });
      expect(result.corners[i].measurements[2]).not.toHaveProperty('withinLimits');
    }
    expect(result.corners[3]).toMatchObject({ status: 'failed', error: expect.any(Object) });
    expect(result.summaries[0]).toMatchObject({ id: 'voltage', summary: { min: { name: 'low', value: 2 }, max: { name: 'high', value: 3 }, spread: 1, unit: 'V' } });
    let runs = 0;
    await runCorners(args, native, 'spice-ts', async (changed, selectedMeasurements) => {
      runs++;
      return executeTool('spice_measure', { request: changed, measurements: selectedMeasurements });
    }, () => {});
    expect(runs).toBe(3);
  });
  it('checks inclusive limits on successful named measurements', async () => {
    const list = [{ ...measurements[0], limits: { min: 0.5, max: 0.7 } }];
    const response = await executeTool('spice_corners', { request, corners, measurements: list });
    expect(response.isError).not.toBe(true);
    expect((response.structuredContent as { corners: { measurements: { withinLimits: boolean }[] }[] }).corners.map(c => c.measurements[0].withinLimits)).toEqual([true, true, false]);
  });
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
